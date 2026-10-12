#!/usr/bin/env node
// Compiles every example to GLSL with web/engine/glsl.js and reports what fails.
// node tests/glsl_compile.js [-k word] [-o dir]   (-o writes each shader as dir/name.glsl)
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";
import { Script } from "../web/engine/seq.js";
import { decodePNGNode } from "../web/engine/image.js";
import { compileScriptToGLSL } from "../web/engine/glsl.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let filter = null, outDir = null;
for (let i = 2; i < process.argv.length; ++i) {
  if (process.argv[i] === "-k") filter = process.argv[++i];
  else if (process.argv[i] === "-o") outDir = process.argv[++i];
}
const exdir = path.join(root, "examples");
const lookup = new Map();
for (const f of fs.readdirSync(exdir)) if (f.endsWith(".png")) {
  const img = decodePNGNode(fs.readFileSync(path.join(exdir, f)), zlib);
  for (const k of [f, f.replace(/\.png$/, ".bmp")]) lookup.set(k.toLowerCase(), img);
}
const files = fs.readdirSync(exdir).filter((f) => f.endsWith(".can") && (!filter || f.includes(filter))).sort();
let ok = 0, bad = 0;
for (const f of files) {
  const script = new Script();
  if (!script.load(fs.readFileSync(path.join(exdir, f), "latin1"), new Map(lookup))) { console.log(`skip ${f}: ${script.errors[0]}`); continue; }
  try {
    const r = compileScriptToGLSL(script);
    ok++;
    console.log(`ok   ${f.padEnd(22)} ${(r.source.length / 1024).toFixed(0)} KB${r.images.length ? `, ${r.images.length} image(s)` : ""}${r.warnings.length ? "  " + r.warnings.join("; ") : ""}`);
    if (outDir) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, f.replace(/\.can$/, ".glsl")), r.source); }
  } catch (e) { bad++; console.log(`FAIL ${f.padEnd(22)} ${e.message}`); }
}
console.log(`\n${ok} compiled, ${bad} failed`);
