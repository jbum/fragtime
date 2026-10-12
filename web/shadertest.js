// shadertest.js -- compares every example's compiled shader with the JS engine's frame.
// ?run starts at once; ?k=regex filters; ?list=a.can,b.can names the scripts (else examples/index.json);
// ?base=/examples/ serves them from elsewhere; ?max=128 caps the longer side (both engines scale alike);
// ?frac=0.95 picks the moment compared (default the middle); ?speed times 8 draws at the script's size.
// Results in window.results, title "ready" when done.
import { Script } from "./engine/seq.js";
import { Renderer } from "./engine/renderer.js";
import { Image as QImage } from "./engine/image.js";
import { compileScriptToGLSL } from "./engine/glsl.js";
import { ShaderPlayer } from "./shader.js";

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const BASE = params.get("base") || "examples/";
const IMAGE_RE = /\b(?:image|source|bmp)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\/>]+))/gi;

async function fetchImage(name) {
  const base = name.replace(/\.[^.]*$/, "");
  for (const t of [name, name.toLowerCase(), base + ".png", base.toLowerCase() + ".png"]) {
    const r = await fetch(BASE + encodeURIComponent(t));
    if (r.ok && /image/.test(r.headers.get("content-type") || "")) return { name: t, data: await r.arrayBuffer() };
  }
  return null;
}

async function run() {
  const tbody = $("#table tbody"), status = $("#status");
  tbody.innerHTML = "";
  let list;
  if (params.get("list")) list = params.get("list").split(",").map((f) => ({ file: f }));
  else list = await (await fetch(BASE + "index.json")).json();
  const k = params.get("k") ? new RegExp(params.get("k")) : null;
  const results = [];
  let player = null;
  let ok = 0, bad = 0, failed = 0;
  for (const ex of list) {
    if (k && !k.test(ex.file)) continue;
    status.textContent = ex.file;
    const row = { file: ex.file };
    results.push(row);
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
      if (!script.load(text, images)) throw new Error("JS: " + script.errors[0]);
      let w = script.frameWidth, h = script.frameHeight;
      const maxSide = parseInt(params.get("max") || "0", 10);
      if (maxSide > 0 && Math.max(w, h) > maxSide) { const k = maxSide / Math.max(w, h); w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k)); }
      const n = Math.max(1, script.nbrFrames);
      const frac = parseFloat(params.get("frac") || "0.5");
      const frame = n <= 1 ? 0 : Math.min(n - 1, Math.round(frac * (n - 1)));
      const time = n <= 1 ? frac * script.duration : frame / n * script.duration;
      // JS
      const jsOut = new Uint8ClampedArray(w * h * 4);
      new Renderer(script, w, h).renderFrame(frame, n, frac, jsOut);
      // GLSL
      const g = compileScriptToGLSL(script);
      row.glslKB = Math.round(g.source.length / 1024);
      const t0 = performance.now();
      // a fresh context per script: a lost context would fail every later compile
      if (player) { const ext = player.gl.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext(); }
      player = new ShaderPlayer(document.createElement("canvas"));
      player.setShader(g.source, g.images.map((im) => ({ name: "", source: bitmaps.get(im) })), g.duration);
      player.setSize(w, h);
      player.draw(time);
      const px = player.pixels();
      row.ms = Math.round(performance.now() - t0);
      let diff = 0, maxd = 0, big = 0;
      for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; ++c) { const d = Math.abs(px[i + c] - jsOut[i + c]); if (d) { diff++; if (d > maxd) maxd = d; if (d > 8) big++; } }
      row.pct = +(100 * diff / (w * h * 3)).toFixed(2); row.max = maxd; row.big = big; row.bigPct = +(100 * big / (w * h * 3)).toFixed(2);
      let sum = 0; for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
      row.mean = Math.round(sum / (w * h * 3)); row.lost = player.gl.isContextLost();
      row.ok = row.bigPct < 1;
      if (params.has("speed")) {
        // draws at the script's own size, pixels read back so the GPU has to finish each one
        player.setSize(script.frameWidth, script.frameHeight);
        player.draw(time); player.pixels();
        const t1 = performance.now();
        for (let i = 1; i <= 8; ++i) { player.draw(time + i * 0.01); player.pixels(); }
        row.fps = +(8000 / (performance.now() - t1)).toFixed(1);
      }
      if (row.ok) ok++; else bad++;
      addRow(row, `${w}×${h}`, (row.fps ? row.fps + " fps at " + script.frameWidth + "×" + script.frameHeight + " " : "") + g.warnings.join("; "));
      console.log("RESULT " + JSON.stringify(row));
      if (!row.ok || params.has("pics")) showPics(ex.file, jsOut, px, w, h);
      if (params.has("dump")) for (const [tag, pix] of [["js", jsOut], ["gl", px]]) {
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        c.getContext("2d").putImageData(new ImageData(pix, w, h), 0, 0);
        console.log("PNG " + ex.file.replace(/\.can$/, "") + "_" + tag + " " + c.toDataURL("image/png"));
      }
    } catch (e) {
      failed++; row.error = e.message;
      addRow(row, "", e.message);
      console.log("RESULT " + JSON.stringify(row));
    }
  }
  status.textContent = "done";
  $("#summary").textContent = `${ok} match (under 1% of bytes more than 8 levels off), ${bad} differ, ${failed} failed to compile. ${navigator.userAgent}`;
  window.results = results;
  document.title = "ready";
}

function addRow(r, size, note) {
  const tr = document.createElement("tr");
  tr.className = r.error ? "bad" : r.ok ? "ok" : "bad";
  tr.innerHTML = `<td>${r.file}</td><td>${size}</td><td class="num">${r.glslKB ?? ""}</td><td class="num">${r.pct ?? ""}</td><td class="num">${r.max ?? ""}</td><td class="num">${r.big ?? ""}</td><td class="num">${r.ms ?? ""}</td><td>${note || ""}</td>`;
  $("#table tbody").appendChild(tr);
}
function showPics(name, a, b, w, h) {
  const div = document.createElement("div");
  div.innerHTML = `<p>${name}: JS, shader</p>`;
  for (const px of [a, b]) {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").putImageData(new ImageData(px, w, h), 0, 0);
    div.appendChild(c);
  }
  $("#pics").appendChild(div);
}
$("#go").onclick = run;
if (params.has("run")) run();
