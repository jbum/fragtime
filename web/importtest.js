// importtest.js -- the import regression gate: every example as a QTS script (glsl.js) and as
// an imported Fragtime patch (import_can.js + graph_glsl.js), drawn on the GPU at frames 10%,
// 50% and 90% of the way through, compared byte for byte.
// ?run starts at once; ?k=regex filters; ?list=a.can,b.can names the scripts; ?base=/examples/;
// ?max=256 caps the longer side. Results as console "RESULT {json}" lines, title "ready" at the end.
import { Script } from "./engine/seq.js";
import { Image as QImage } from "./engine/image.js";
import { compileScriptToGLSL } from "./engine/glsl.js";
import { importCan } from "./engine/import_can.js";
import { compilePatchToGLSL } from "./engine/graph_glsl.js";
import * as G from "./engine/graph.js";
import { ShaderPlayer } from "./shader.js";

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const BASE = params.get("base") || "examples/";
const IMAGE_RE = /\b(?:image|source|bmp)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\/>]+))/gi;
const FRACS = [0.1, 0.5, 0.9];

async function fetchImage(name) {
  const base = name.replace(/\.[^.]*$/, "");
  for (const t of [name, name.toLowerCase(), base + ".png", base.toLowerCase() + ".png"]) {
    const r = await fetch(BASE + encodeURIComponent(t));
    if (r.ok && /image/.test(r.headers.get("content-type") || "")) return { name: t, data: await r.arrayBuffer() };
  }
  return null;
}

function draw(g, bitmaps, w, h, times) {
  const player = new ShaderPlayer(document.createElement("canvas"));
  try {
    player.setShader(g.source, g.images.map((im) => ({ name: "", source: bitmaps.get(im) })), g.duration);
    player.setSize(w, h);
    return times.map((t) => { player.draw(t); return player.pixels().slice(); });
  } finally {
    const ext = player.gl.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext();
  }
}

async function run() {
  $("#table tbody").innerHTML = "";
  let list;
  if (params.get("list")) list = params.get("list").split(",").map((f) => ({ file: f }));
  else list = await (await fetch(BASE + "index.json")).json();
  const k = params.get("k") ? new RegExp(params.get("k")) : null;
  let ok = 0, bad = 0, failed = 0;
  for (const ex of list) {
    if (k && !k.test(ex.file)) continue;
    $("#status").textContent = ex.file;
    const row = { file: ex.file };
    try {
      const text = new TextDecoder("latin1").decode(new Uint8Array(await (await fetch(BASE + ex.file)).arrayBuffer()));
      const names = new Set(); let m;
      while ((m = IMAGE_RE.exec(text))) names.add(m[1] ?? m[2] ?? m[3]);
      const images = new Map(), bitmaps = new Map();
      for (const nm of names) {
        const f = await fetchImage(nm);
        if (!f) continue;
        const img = await QImage.decode(f.data.slice(0));
        images.set(nm, img); images.set(nm.toLowerCase(), img);
        bitmaps.set(img, await createImageBitmap(new Blob([f.data])));
      }
      const script = new Script();
      if (!script.load(text, images)) throw new Error("script: " + script.errors[0]);
      const { patch, warnings } = importCan(text, ex.file);
      const p2 = G.parse(G.serialize(patch));      // what a saved file would give
      row.nodes = p2.nodes.length;
      let w = script.frameWidth, h = script.frameHeight;
      const maxSide = parseInt(params.get("max") || "0", 10);
      if (maxSide > 0 && Math.max(w, h) > maxSide) { const s = maxSide / Math.max(w, h); w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s)); }
      const n = Math.max(1, script.nbrFrames);
      const times = FRACS.map((fr) => n <= 1 ? fr * script.duration : Math.min(n - 1, Math.round(fr * (n - 1))) / n * script.duration);
      const gOld = compileScriptToGLSL(script), gNew = compilePatchToGLSL(p2, images);
      row.kb = `${Math.round(gOld.source.length / 1024)}/${Math.round(gNew.source.length / 1024)}`;
      if (gNew.duration !== gOld.duration || gNew.width !== gOld.width || gNew.height !== gOld.height || gNew.fps !== gOld.fps)
        throw new Error(`info differs: ${JSON.stringify([gOld.duration, gOld.width, gOld.height, gOld.fps])} vs ${JSON.stringify([gNew.duration, gNew.width, gNew.height, gNew.fps])}`);
      const a = draw(gOld, bitmaps, w, h, times), b = draw(gNew, bitmaps, w, h, times);
      let diff = 0, maxd = 0, big = 0, total = 0, worst = 0;
      for (let i = 0; i < a.length; ++i) {
        let fd = 0;
        for (let j = 0; j < a[i].length; j += 4) for (let c = 0; c < 3; ++c) {
          const d = Math.abs(a[i][j + c] - b[i][j + c]); total++;
          if (d) { diff++; fd++; if (d > maxd) maxd = d; if (d > 2) big++; }
        }
        if (fd > a[worst].length && false) worst = i;
      }
      row.pct = +(100 * diff / total).toFixed(3); row.max = maxd; row.big = big; row.bigPct = +(100 * big / total).toFixed(3);
      row.ok = row.bigPct < 0.01;
      row.note = [...warnings, ...gNew.warnings].join("; ");
      if (row.ok) ok++; else bad++;
      addRow(row, `${w}×${h}`);
      if (!row.ok || params.has("pics")) showPics(ex.file, a[1], b[1], w, h);
    } catch (e) {
      failed++; row.error = e.message;
      addRow(row, "");
    }
    console.log("RESULT " + JSON.stringify(row));
  }
  // hand-made patches (tests/patches): they must compile on this GPU and draw something
  for (const file of (params.get("patches") || "").split(",").filter(Boolean)) {
    const row = { file };
    try {
      const p = G.parse(await (await fetch(file)).text());
      const g = compilePatchToGLSL(p, new Map());
      const gp = compilePatchToGLSL(p, new Map(), { all: true, preview: true });
      const info = G.patchInfo(p);
      const frames = draw(g, new Map(), info.width, info.height, [0.5, 2.5, 4.5]);
      draw(gp, new Map(), 16, 16, [1]);
      row.nodes = p.nodes.length; row.kb = `-/${Math.round(g.source.length / 1024)}`;
      const lit = frames.map((px) => { let s = 0; for (let i = 0; i < px.length; i += 4) s += px[i] + px[i + 1] + px[i + 2]; return s; });
      row.pct = 0; row.max = 0; row.bigPct = 0; row.ok = lit.every((v) => v > 0);
      row.note = (row.ok ? "compiles and draws" : "draws black at some moment") + (g.warnings.length ? "; " + g.warnings.join("; ") : "");
      if (row.ok) ok++; else bad++;
      addRow(row, `${info.width}×${info.height}`);
    } catch (e) { failed++; row.error = e.message; addRow(row, ""); }
    console.log("RESULT " + JSON.stringify(row));
  }
  $("#status").textContent = "done";
  $("#summary").textContent = `${ok} match (under 0.01% of bytes more than 2 levels off), ${bad} differ, ${failed} failed. ${navigator.userAgent}`;
  document.title = "ready";
}

function addRow(r, size) {
  const tr = document.createElement("tr");
  tr.className = r.error ? "bad" : r.ok ? "ok" : "bad";
  tr.innerHTML = `<td>${r.file}</td><td>${size}</td><td class="num">${r.nodes ?? ""}</td><td class="num">${r.kb ?? ""}</td><td class="num">${r.pct ?? ""}</td><td class="num">${r.max ?? ""}</td><td class="num">${r.big ?? ""}</td><td>${r.error || r.note || ""}</td>`;
  $("#table tbody").appendChild(tr);
}
function showPics(name, a, b, w, h) {
  const div = document.createElement("div");
  div.innerHTML = `<p>${name} (middle frame): script, patch</p>`;
  for (const px of [a, b]) {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0);
    div.appendChild(c);
  }
  $("#pics").appendChild(div);
}
$("#go").onclick = run;
if (params.has("run")) run();
