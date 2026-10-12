#!/usr/bin/env node
// Writes name.fragtime beside every name.can in a directory (the site's examples):
//   node build/import_examples.js build/web/examples
import fs from "fs";
import path from "path";
import { importCan } from "../web/engine/import_can.js";
import { serialize } from "../web/engine/graph.js";

const dir = process.argv[2];
let n = 0;
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".can")).sort()) {
  try {
    const { patch, warnings } = importCan(fs.readFileSync(path.join(dir, f), "latin1"), f);
    fs.writeFileSync(path.join(dir, f.replace(/\.can$/, ".fragtime")), serialize(patch));
    n++;
    for (const w of warnings) console.log(`${f}: ${w}`);
  } catch (e) { console.log(`${f}: not imported: ${e.message}`); }
}
console.log(`imported ${n} scripts`);
