#!/usr/bin/env node
// The patch model and compiler without a GPU: every example imports, saves and loads back
// unchanged; validation catches bad patches; renames rewire; the node types the importer
// never makes (blend, time, sequences of groups) and the preview build compile.
//   node tests/graph_test.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as G from "../web/engine/graph.js";
import { importCan } from "../web/engine/import_can.js";
import { compilePatchToGLSL } from "../web/engine/graph_glsl.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.log("FAIL " + msg); } else console.log("ok   " + msg); };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

// every example: import, serialize, parse, serialize again (stable), validate, compile
const ex = path.join(root, "examples");
let imported = 0, skipped = 0;
for (const f of fs.readdirSync(ex).filter((f) => f.endsWith(".can")).sort()) {
  let r;
  try { r = importCan(fs.readFileSync(path.join(ex, f), "latin1"), f); } catch (e) { skipped++; continue; }
  const t1 = G.serialize(r.patch), p = G.parse(t1), t2 = G.serialize(p);
  if (t1 !== t2) check(false, `${f}: saving twice gives the same text`);
  const v = G.validate(p);
  if (v.length) check(false, `${f}: valid (${v[0]})`);
  const e = throws(() => compilePatchToGLSL(p, new Map()));
  if (e) check(false, `${f}: compiles (${e.message})`);
  const e2 = throws(() => compilePatchToGLSL(p, new Map(), { all: true, preview: true }));
  if (e2) check(false, `${f}: compiles for previews (${e2.message})`);
  imported++;
}
check(imported >= 73, `${imported} examples import, round-trip and compile (${skipped} the old engine can't load either)`);

// a patch built by hand
const base = () => ({ fragtime: 1, title: "t", nodes: [
  { id: "n1", type: "source", x: 0, y: 0, inputs: {}, params: { mono: "noise(x*8,y*8,t)" } },
  { id: "n2", type: "source", x: 0, y: 0, inputs: {}, params: { rgb: "x,y,t" } },
  { id: "mix", type: "expr", x: 0, y: 0, inputs: { a: "n1", b: "n2" }, params: { pix: "terp($a,$b,x)" } },
  { id: "bl", type: "blend", x: 0, y: 0, inputs: { a: "mix", b: "n1" }, params: { mode: "screen" } },
  { id: "slow", type: "time", x: 0, y: 0, inputs: { in: "bl" }, params: { time: "t*dur/2", loop: 1 } },
  { id: "seq", type: "sequence", x: 0, y: 0, inputs: { s1: "n2", s2: "slow", s3: "mix" }, params: { modes: { s3: "multiply" } } },
  { id: "out", type: "output", x: 0, y: 0, inputs: { in: "seq" }, params: { width: 64, height: 48, fps: 24, duration: 6 } },
] });
let p = base();
p.nodes[0].params.duration = 2;
p.nodes[1].params.duration = 2;
p.nodes[4].params.debut = "last"; p.nodes[4].params.duration = 2;
p.nodes[2].params.debut = "last";
check(G.validate(p).length === 0, "a hand-made patch with every node type is valid");
let g = throws(() => compilePatchToGLSL(p, new Map()));
check(!g, "it compiles" + (g ? ": " + g.message : ""));
const src = compilePatchToGLSL(p, new Map()).source;
check(/qts_blend\(2,/.test(src) && /qts_blend\(1,/.test(src), "screen and multiply blends are emitted");
check(/e1 = s \+ d/.test(src) && /float s = e2/.test(src), "debut=last starts after the previous input");
check(/lt -= 1\.0 \* floor\(lt \/ 1\.0\)/.test(src), "the time node loops");

// validation
p = base(); p.nodes[0].inputs = { z: "seq" };
check(G.validate(p).some((e) => /cycle/.test(e)), "a cycle is reported");
check(/cycle/.test(throws(() => compilePatchToGLSL(p, new Map())).message), "and the compiler refuses it");
p = base(); p.nodes.push({ id: "n1", type: "source", inputs: {}, params: {} });
check(G.validate(p).some((e) => /two nodes/.test(e)), "duplicate ids are reported");
p = base(); p.nodes[2].inputs.a = "nobody";
check(G.validate(p).some((e) => /no node called nobody/.test(e)), "a wire to a missing node is reported");
p = base(); p.nodes = p.nodes.filter((n) => n.type !== "output");
check(G.validate(p).some((e) => /no Output/.test(e)), "a patch without an Output is reported");
p = base(); p.nodes[2].params.pix = "terp($a,$b,x";
const err = throws(() => compilePatchToGLSL(p, new Map()));
check(err && err.nodeId === "mix" && err.key === "pix", `an expression error names the node and field (${err && err.message})`);
p = base(); p.nodes[2].params.pix = "terp($a,$c,x)";
check(compilePatchToGLSL(p, new Map()).warnings.some((w) => /\$c isn't wired/.test(w)), "an unwired $name warns and reads black");

// renames
p = base();
G.renameNode(p, "n1", "noise1");
check(p.nodes[2].inputs.a === "noise1" && p.nodes[3].inputs.b === "noise1", "renaming a node rewires its readers");
check(!!throws(() => G.renameNode(p, "noise1", "n2")), "renaming onto an existing name is refused");
check(!!throws(() => G.renameNode(p, "noise1", "9x")), "a name must start with a letter");
G.renamePort(p.nodes[2], "a", "grain");
check(p.nodes[2].inputs.grain === "noise1" && p.nodes[2].params.pix === "terp($grain,$b,x)", "renaming a port rewrites its $references");
G.renamePort(p.nodes[2], "b", "bb");
check(p.nodes[2].params.pix === "terp($grain,$bb,x)", "a port rename leaves longer names alone");
check(G.newId(p, "mix") === "mix2" && G.newId(p, "3d") === "nd", "fresh ids");

// patchInfo
const info = G.patchInfo(base());
check(info.duration === 6 && info.width === 64 && info.frames === 144 && info.oversample === true, "patch info from the Output");

console.log(failures ? `\n${failures} FAILED` : "\nall ok");
process.exit(failures ? 1 : 0);
