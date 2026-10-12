#!/usr/bin/env node
// Writes the standalone looping page for an example: node tests/shader_page.js examples/sun.can out.html
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { Script } from "../web/engine/seq.js";
import { decodePNGNode } from "../web/engine/image.js";
import { compileScriptToGLSL } from "../web/engine/glsl.js";
import { standaloneHTML } from "../web/shader.js";
const [src, out] = process.argv.slice(2);
const dir = path.dirname(src), lookup = new Map(), fileOf = new Map();
for (const f of fs.readdirSync(dir)) if (f.endsWith(".png")) {
  const img = decodePNGNode(fs.readFileSync(path.join(dir, f)), zlib);
  fileOf.set(img, path.join(dir, f));
  for (const k of [f, f.replace(/\.png$/, ".bmp")]) lookup.set(k.toLowerCase(), img);
}
const script = new Script();
if (!script.load(fs.readFileSync(src, "latin1"), lookup)) { console.error(script.errors.join("\n")); process.exit(1); }
const g = compileScriptToGLSL(script);
const images = g.images.map((im) => ({ name: path.basename(fileOf.get(im)), dataURL: "data:image/png;base64," + fs.readFileSync(fileOf.get(im)).toString("base64") }));
fs.writeFileSync(out, standaloneHTML({ source: g.source, title: path.basename(src, ".can"), images, duration: g.duration, width: g.width, height: g.height }));
console.log(`${out}: ${(fs.statSync(out).size / 1024).toFixed(0)} KB, ${images.length} image(s)`);
