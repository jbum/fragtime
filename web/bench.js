// bench.js -- times the JS engine against qts.wasm on every example, in this browser.

import { Script } from "./engine/seq.js";
import { Renderer } from "./engine/renderer.js";
import { Image } from "./engine/image.js";

const $ = (s) => document.querySelector(s);
const IMAGE_RE = /\b(?:image|source|bmp)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\/>]+))/gi;

async function fetchImage(name) {
  const base = name.replace(/\.[^.]*$/, "");
  for (const t of [name, name.toLowerCase(), base + ".png", base.toLowerCase() + ".png"]) {
    const r = await fetch("examples/" + encodeURIComponent(t));
    if (r.ok && /image/.test(r.headers.get("content-type") || "")) return { name: t, data: await r.arrayBuffer() };
  }
  return null;
}

class WasmWorker {
  constructor() { this.w = new Worker("worker.js"); this.id = 1; this.pending = new Map();
    this.w.onmessage = (e) => { const m = e.data, p = this.pending.get(m.id); if (!p || m.type === "progress") return; this.pending.delete(m.id); m.type === "error" ? p.reject(new Error(m.message)) : p.resolve(m); }; }
  call(msg) { return new Promise((resolve, reject) => { const id = this.id++; this.pending.set(id, { resolve, reject }); this.w.postMessage(Object.assign({ id }, msg)); }); }
}

async function run() {
  const tbody = $("#table tbody"), status = $("#status");
  tbody.innerHTML = "";
  const list = await (await fetch("examples/index.json")).json();
  const wasm = new WasmWorker();
  let sumJs = 0, sumWasm = 0, jsWins = 0, n = 0;
  for (const ex of list) {
    if (ex.file === "noiseetude.can") continue;
    status.textContent = ex.file;
    const text = new TextDecoder("latin1").decode(new Uint8Array(await (await fetch("examples/" + ex.file)).arrayBuffer()));
    const names = new Set();
    let m;
    while ((m = IMAGE_RE.exec(text))) names.add(m[1] ?? m[2] ?? m[3]);
    const files = [], images = new Map();
    for (const nm of names) {
      const f = await fetchImage(nm);
      if (!f) continue;
      files.push(f);
      const img = await Image.decode(f.data.slice(0));
      images.set(nm, img); images.set(nm.toLowerCase(), img);
    }
    // JS
    const script = new Script();
    if (!script.load(text, images)) { addRow(ex.file, "", "", "", "", "JS: " + script.errors[0]); continue; }
    const w = script.frameWidth, h = script.frameHeight;
    const jsOut = new Uint8ClampedArray(w * h * 4);
    const r = new Renderer(script, w, h);
    let best = Infinity;
    for (let i = 0; i < 2; ++i) { const t0 = performance.now(); r.renderFrame(0, 1, 0.5, jsOut); best = Math.min(best, performance.now() - t0); }
    // wasm
    const c = await wasm.call({ type: "compile", text, title: ex.file, files: files.map((f) => ({ name: f.name, data: f.data })) });
    if (!c.ok) { addRow(ex.file, `${w}×${h}`, best.toFixed(0), "", "", "wasm: " + c.messages); continue; }
    let bestW = Infinity, wasmOut = null;
    for (let i = 0; i < 2; ++i) {
      const t0 = performance.now();
      const fr = await wasm.call({ type: "render", frame: 0, nbrFrames: 1, snapshot: 0.5, width: w, height: h, y0: 0, y1: h });
      bestW = Math.min(bestW, performance.now() - t0);
      wasmOut = new Uint8ClampedArray(fr.rgba);
    }
    let diff = 0, maxd = 0;
    for (let i = 0; i < jsOut.length; i += 4) for (let k = 0; k < 3; ++k) { const d = Math.abs(jsOut[i + k] - wasmOut[i + k]); if (d) { diff++; if (d > maxd) maxd = d; } }
    sumJs += best; sumWasm += bestW; n++; if (best < bestW) jsWins++;
    addRow(ex.file, `${w}×${h}`, best.toFixed(0), bestW.toFixed(0), (bestW / best).toFixed(2), diff ? `${diff} differ (max ${maxd})` : "identical", best < bestW ? "faster-js" : "faster-wasm");
  }
  status.textContent = "done";
  $("#summary").textContent = `${n} scripts: JS ${sumJs.toFixed(0)} ms total, wasm ${sumWasm.toFixed(0)} ms total (wasm/JS = ${(sumWasm / sumJs).toFixed(2)}); JS faster on ${jsWins}. ${navigator.userAgent}`;
}

function addRow(name, size, js, wasm, ratio, pixels, cls) {
  const tr = document.createElement("tr");
  if (cls) tr.className = cls;
  tr.innerHTML = `<td>${name}</td><td>${size}</td><td class="num">${js}</td><td class="num">${wasm}</td><td class="num">${ratio}</td><td>${pixels}</td>`;
  $("#table tbody").appendChild(tr);
}

$("#go").onclick = run;
if (location.search.includes("run")) run();
