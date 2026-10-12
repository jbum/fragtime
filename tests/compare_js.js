#!/usr/bin/env node
// Renders a frame of every example with the JS engine (web/engine) and with the native
// qts, and reports how close they are: JS uses the platform's Math, so expect a few
// pixels a level apart, not bit-identity.   node tests/compare_js.js [-T 0.5] [-k word]
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { Script } from "../web/engine/seq.js";
import { Renderer } from "../web/engine/renderer.js";
import { decodePNGNode } from "../web/engine/image.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let frac = 0.5, filter = null;
for (let i = 2; i < process.argv.length; ++i) {
  if (process.argv[i] === "-T") frac = parseFloat(process.argv[++i]);
  else if (process.argv[i] === "-k") filter = process.argv[++i];
}
const exdir = path.join(root, "examples");
const images = new Map();
for (const f of fs.readdirSync(exdir)) if (f.endsWith(".png")) {
  const img = decodePNGNode(fs.readFileSync(path.join(exdir, f)), zlib);
  images.set(f, img); images.set(f.replace(/\.png$/, ".bmp"), img);
  images.set(f.toLowerCase(), img);
}
// the scripts name .bmp files that the site carries as .png
const lookup = new Map();
for (const [k, v] of images) lookup.set(k.toLowerCase(), v);
const files = fs.readdirSync(exdir).filter((f) => f.endsWith(".can") && (!filter || f.includes(filter))).sort();
let exact = 0, close = 0, bad = 0, skipped = 0, totalJs = 0, totalNative = 0;
for (const f of files) {
  const text = fs.readFileSync(path.join(exdir, f), "latin1");
  const script = new Script();
  const imgs = new Map();
  for (const [k, v] of lookup) imgs.set(k, v);
  if (!script.load(text, imgs)) { console.log(`skip   ${f}: ${script.errors.join("; ")}`); skipped++; continue; }
  const w = script.frameWidth, h = script.frameHeight;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const r = new Renderer(script, w, h);
  let t0 = performance.now();
  r.renderFrame(0, 1, frac, rgba);
  const jsMs = performance.now() - t0;
  t0 = performance.now();
  let native;
  try {
    native = execFileSync(path.join(root, "qts"), ["-q", "-raw", "-T", String(frac), path.join(exdir, f)], { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) { console.log(`skip   ${f}: native failed`); skipped++; continue; }
  const nativeMs = performance.now() - t0;
  totalJs += jsMs; totalNative += nativeMs;
  let n = 0, maxd = 0, big = 0;
  for (let i = 0, j = 0; i < native.length; i += 3, j += 4)
    for (let c = 0; c < 3; ++c) {
      const d = Math.abs(native[i + c] - rgba[j + c]);
      if (d) { n++; if (d > maxd) maxd = d; if (d > 2) big++; }
    }
  const pct = (100 * n / native.length).toFixed(2);
  const tag = n === 0 ? "exact " : big === 0 ? "close " : "DIFFER";
  if (n === 0) exact++; else if (big === 0) close++; else bad++;
  console.log(`${tag} ${f.padEnd(22)} ${w}x${h}  ${pct}% bytes differ, max ${maxd}, ${big} > 2   js ${jsMs.toFixed(0)} ms, native ${nativeMs.toFixed(0)} ms`);
}
console.log(`\n${exact} exact, ${close} close (within 2 levels), ${bad} differ, ${skipped} skipped; js ${totalJs.toFixed(0)} ms vs native ${totalNative.toFixed(0)} ms (incl. process start)`);
