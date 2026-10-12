#!/usr/bin/env node
// Renders a frame of every example with the native qts and with qts.wasm (node build) and
// checks the bytes are identical. Run from the repo root after `make` and
// `build/build_wasm.sh node`:   node tests/compare_wasm.js [-T 0.5] [-k word]

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
let frac = 0.5, filter = null;
for (let i = 2; i < process.argv.length; ++i) {
  if (process.argv[i] === "-T") frac = parseFloat(process.argv[++i]);
  else if (process.argv[i] === "-k") filter = process.argv[++i];
}

async function main() {
  const createQTS = require(path.join(root, "build/wasm-node/qts.js"));
  const qts = await createQTS({ print: () => {}, printErr: () => {} });
  const api = {
    new_: qts.cwrap("qts_new", "number", []),
    free: qts.cwrap("qts_free", null, ["number"]),
    compile: qts.cwrap("qts_compile", "number", ["number", "string", "string", "string"]),
    messages: qts.cwrap("qts_messages", "string", ["number"]),
    info: qts.cwrap("qts_info", "string", ["number"]),
    render: qts.cwrap("qts_render", "number", ["number", "number", "number", "number", "number", "number", "number", "number"]),
    rgb: qts.cwrap("qts_rgb", "number", ["number"]),
  };
  const exdir = path.join(root, "examples");
  const files = fs.readdirSync(exdir).filter((f) => f.endsWith(".can") && (!filter || f.includes(filter))).sort();
  let same = 0, differ = 0, skipped = 0;
  for (const f of files) {
    const text = fs.readFileSync(path.join(exdir, f), "latin1");
    const h = api.new_();
    const ok = api.compile(h, text, f.replace(/\.can$/, ""), exdir);
    if (!ok) { console.log(`skip   ${f}: ${api.messages(h).trim()}`); skipped++; api.free(h); continue; }
    const info = JSON.parse(api.info(h));
    const w = info.width, hgt = info.height;
    // the same frame in two bands, to check banding is exact too
    const mid = Math.floor(hgt / 2);
    api.render(h, 0, 1, frac, w, hgt, 0, mid);
    const p = api.render(h, 0, 1, frac, w, hgt, mid, hgt);
    const rgbPtr = api.rgb(h);
    const wasmBytes = Buffer.from(qts.HEAPU8.subarray(rgbPtr, rgbPtr + w * hgt * 3));
    let native;
    try {
      native = execFileSync(path.join(root, "qts"), ["-q", "-raw", "-T", String(frac), path.join(exdir, f)],
        { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) { console.log(`skip   ${f}: native failed`); skipped++; api.free(h); continue; }
    if (native.length === wasmBytes.length && native.equals(wasmBytes)) { same++; console.log(`same   ${f} ${w}x${hgt}`); }
    else {
      let n = 0, maxd = 0;
      for (let i = 0; i < Math.min(native.length, wasmBytes.length); ++i) {
        const d = Math.abs(native[i] - wasmBytes[i]);
        if (d) { n++; if (d > maxd) maxd = d; }
      }
      differ++;
      console.log(`DIFFER ${f}: ${n} bytes differ (max ${maxd}), sizes ${native.length}/${wasmBytes.length}`);
    }
    api.free(h);
  }
  console.log(`\n${same} identical, ${differ} differ, ${skipped} skipped`);
  process.exit(differ ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
