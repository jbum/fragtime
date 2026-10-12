#!/usr/bin/env node
// Writes the standalone looping page for a script or a patch:
//   node tests/shader_page.js examples/sun.can out.html
//   node tests/shader_page.js examples/sun.fragtime out.html   (images looked up beside it, then in examples/)
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { Script } from "../web/engine/seq.js";
import { decodePNGNode } from "../web/engine/image.js";
import { compileScriptToGLSL } from "../web/engine/glsl.js";
import { standaloneHTML } from "../web/shader.js";
import { parse } from "../web/engine/graph.js";
import { compilePatchToGLSL } from "../web/engine/graph_glsl.js";
const [src, out] = process.argv.slice(2);
const dir = path.dirname(src), lookup = new Map(), fileOf = new Map();
const exdir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "examples");
for (const d of [...new Set([exdir, dir])]) for (const f0 of fs.readdirSync(d)) if (f0.endsWith(".png")) {
  const f = path.join(d, f0).slice(d.length + 1);
  const img = decodePNGNode(fs.readFileSync(path.join(d, f)), zlib);
  fileOf.set(img, path.join(d, f));
  for (const k of [f, f.replace(/\.png$/, ".bmp")]) lookup.set(k.toLowerCase(), img);
}
let g;
if (/\.fragtime$/.test(src)) g = compilePatchToGLSL(parse(fs.readFileSync(src, "utf8")), lookup);
else {
  const script = new Script();
  if (!script.load(fs.readFileSync(src, "latin1"), lookup)) { console.error(script.errors.join("\n")); process.exit(1); }
  g = compileScriptToGLSL(script);
}
const images = g.images.map((im) => ({ name: path.basename(fileOf.get(im)), dataURL: "data:image/png;base64," + fs.readFileSync(fileOf.get(im)).toString("base64") }));
fs.writeFileSync(out, standaloneHTML({ source: g.source, title: path.basename(src).replace(/\.(can|fragtime)$/, ""), images, duration: g.duration, width: g.width, height: g.height }));
console.log(`${out}: ${(fs.statSync(out).size / 1024).toFixed(0)} KB, ${images.length} image(s)`);
