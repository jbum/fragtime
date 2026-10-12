// QTS in the browser: the script editor, the live shader, the frame preview and the
// movie renderer.
//
// The default view compiles the script to GLSL (engine/glsl.js) and plays it on the GPU
// (shader.js). The Frame view and the "exact" movie path render with the original engine:
// a pool of workers (worker.js), each with its own qts.wasm instance and copy of the
// compiled script; a preview frame is split into row bands across the pool, a movie hands
// whole frames to whichever worker is idle. Movies default to the shader: a frame is drawn
// at each frame's time and handed to the encoder (MP4 through WebCodecs + mp4-muxer, or
// PNG frames in a zip).

import { Muxer, ArrayBufferTarget } from "./vendor/mp4-muxer.mjs";
import { Script } from "./engine/seq.js";
import { Image as QImage } from "./engine/image.js";
import { compileScriptToGLSL, GLSLError } from "./engine/glsl.js";
import { ShaderPlayer, standaloneHTML } from "./shader.js";

const $ = (s) => document.querySelector(s);
const NWORKERS = Math.min(8, Math.max(1, navigator.hardwareConcurrency || 2));
const STORAGE = "qts-editor";
const FIRST_EXAMPLE = "sun.can";

// ------------------------------------------------------------------ worker pool

class Pool {
  constructor(n) {
    this.workers = [];
    this.nextId = 1;
    for (let i = 0; i < n; ++i) {
      const w = new Worker("worker.js");
      w.pending = new Map();
      w.busy = false;
      w.onmessage = (e) => {
        const m = e.data, p = w.pending.get(m.id);
        if (!p) return;
        if (m.type === "progress") { if (p.onProgress) p.onProgress(m.rows); return; }
        w.pending.delete(m.id);
        w.busy = false;
        if (m.type === "error") p.reject(new Error(m.message));
        else p.resolve(m);
      };
      w.onerror = (e) => { for (const p of w.pending.values()) p.reject(new Error(e.message)); w.pending.clear(); w.busy = false; };
      this.workers.push(w);
    }
  }
  call(w, msg, onProgress, transfer) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      w.pending.set(id, { resolve, reject, onProgress });
      w.busy = true;
      w.postMessage(Object.assign({ id }, msg), transfer || []);
    });
  }
  cancel() { for (const w of this.workers) w.postMessage({ type: "cancel" }); }

  async compile(text, title, files) {
    const results = await Promise.all(this.workers.map((w) =>
      this.call(w, { type: "compile", text, title, files: files.map((f) => ({ name: f.name, data: f.data.slice(0) })) })));
    return results[0];
  }

  // One frame, rows split across the workers. onRows(rowsDone, height).
  async renderFrame(frame, nbrFrames, snapshot, width, height, onRows) {
    const n = Math.min(this.workers.length, Math.max(1, Math.floor(height / 8)));
    const out = new Uint8ClampedArray(width * height * 4);
    const done = new Array(n).fill(0);
    const jobs = [];
    for (let i = 0; i < n; ++i) {
      const y0 = Math.floor(height * i / n), y1 = Math.floor(height * (i + 1) / n);
      jobs.push(this.call(this.workers[i], { type: "render", frame, nbrFrames, snapshot, width, height, y0, y1 },
        (rows) => { done[i] = rows; if (onRows) onRows(done.reduce((a, b) => a + b, 0), height); })
        .then((m) => { out.set(new Uint8ClampedArray(m.rgba), m.y0 * width * 4); }));
    }
    await Promise.all(jobs);
    return new ImageData(out, width, height);
  }

  idleWorker() { return this.workers.find((w) => !w.busy); }
}

const pool = new Pool(NWORKERS);

// ------------------------------------------------------------------ state

const state = {
  name: "untitled.can",
  info: null,          // {duration, frameRate, frames, width, height} of the compiled script
  compiledText: null,
  frac: 0,             // slider position 0..1
  userImages: new Map(),   // name (lower) -> {name, data}
  rendering: false,
  movie: null,         // {cancel: bool}
  examples: [],
  lastFrame: null,     // ImageData
  view: "shader",      // "shader" (the GLSL compile, live) or "frame" (the wasm renderer)
  shader: null,        // {g: compile result, files, bitmaps: Map(QImage -> ImageBitmap), text}
  noGPU: false,        // WebGL2 refused: the shader view and GPU movies are off
};

const ui = {
  editor: $("#editor"), canvas: $("#preview"), slider: $("#time"), timeText: $("#timeText"),
  log: $("#log"), name: $("#name"), status: $("#status"), progress: $("#progress"),
  width: $("#width"), height: $("#height"),
  glview: $("#glview"), shaderPlay: $("#shaderPlay"), shaderFps: $("#shaderFps"), shaderOversample: $("#shaderOversample"),
};

function log(msg, cls) {
  const line = document.createElement("div");
  line.textContent = msg;
  if (cls) line.className = cls;
  ui.log.appendChild(line);
  while (ui.log.childElementCount > 200) ui.log.removeChild(ui.log.firstChild);
  ui.log.scrollTop = ui.log.scrollHeight;
}

function setStatus(text, frac) {
  ui.status.textContent = text;
  if (frac == null) ui.progress.hidden = true;
  else { ui.progress.hidden = false; ui.progress.value = frac; }
}

function save() {
  try {
    localStorage.setItem(STORAGE, JSON.stringify({ text: ui.editor.value, name: state.name, frac: state.frac,
      width: ui.width.value, height: ui.height.value, view: state.view }));
  } catch (_) {}
}

// ------------------------------------------------------------------ images

const IMAGE_RE = /\b(?:image|source|bmp)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\/>]+))/gi;

function imageNames(text) {
  const names = new Set();
  let m;
  while ((m = IMAGE_RE.exec(text))) names.add(m[1] ?? m[2] ?? m[3]);
  return [...names];
}

const fetched = new Map();   // served name -> {name, data} or null

async function fetchExampleImage(name) {
  const base = name.replace(/\.[^.]*$/, "");
  const tries = [name, name.toLowerCase(), base + ".png", base.toLowerCase() + ".png"];
  for (const t of tries) {
    if (fetched.has(t)) { const f = fetched.get(t); if (f) return f; continue; }
    try {
      const r = await fetch("examples/" + encodeURIComponent(t));
      if (r.ok && /image/.test(r.headers.get("content-type") || "")) {
        const f = { name: t, data: await r.arrayBuffer() };
        fetched.set(t, f);
        return f;
      }
    } catch (_) {}
    fetched.set(t, null);
  }
  return null;
}

async function collectImages(text) {
  const files = [];
  for (const name of imageNames(text)) {
    const mine = state.userImages.get(name.toLowerCase());
    if (mine) { files.push(mine); continue; }
    const f = await fetchExampleImage(name);
    if (f) files.push(f);
    else log(`image ${name}: not found here; add it with Images…`, "warn");
  }
  return files;
}

// ------------------------------------------------------------------ compile & preview

async function compile() {
  const text = ui.editor.value;
  const files = await collectImages(text);
  const r = await pool.compile(text, state.name.replace(/\.can$/i, ""), files);
  ui.log.textContent = "";
  for (const line of r.messages.split("\n")) if (line.trim()) log(line, /^error/.test(line) ? "err" : "warn");
  if (!r.ok) { setStatus("compile failed"); state.info = null; return false; }
  state.info = r.info;
  state.compiledText = text;
  if (!ui.width.value || ui.width.dataset.auto !== "0") { ui.width.value = r.info.width; ui.width.dataset.auto = "1"; }
  if (!ui.height.value || ui.height.dataset.auto !== "0") { ui.height.value = r.info.height; ui.height.dataset.auto = "1"; }
  logInfo(r.info);
  updateTimeText();
  return true;
}

function logInfo(info) {
  log(`compiled: ${info.duration} s at ${info.frameRate} fps = ${info.frames} frame${info.frames === 1 ? "" : "s"}, ${info.width}×${info.height}`);
}

function outputSize() {
  let w = parseInt(ui.width.value, 10) || (state.info && state.info.width) || 256;
  let h = parseInt(ui.height.value, 10) || (state.info && state.info.height) || 256;
  w = Math.max(1, Math.min(4096, w)); h = Math.max(1, Math.min(4096, h));
  return { w, h };
}

// The slider picks a movie frame when there is more than one, so the preview is that
// frame exactly; frame 0 of 1 means "the snapshot at this fraction".
function frameAt(frac) {
  const n = state.info ? Math.max(1, state.info.frames) : 1;
  if (n <= 1) return { frame: 0, nbrFrames: 1, snapshot: frac };
  const f = Math.min(n - 1, Math.round(frac * (n - 1)));
  return { frame: f, nbrFrames: n, snapshot: 0 };
}

function updateTimeText() {
  const frac = state.frac;
  if (!state.info) { ui.timeText.textContent = ""; return; }
  const { frame, nbrFrames } = frameAt(frac);
  const secs = nbrFrames > 1 ? frame / state.info.frameRate : frac * state.info.duration;
  ui.timeText.textContent = nbrFrames > 1
    ? `${secs.toFixed(2)} s · frame ${frame + 1} of ${nbrFrames}`
    : `t = ${frac.toFixed(3)}`;
}

let previewSeq = 0;
async function renderPreview() {
  if (state.movie) return;
  const seq = ++previewSeq;
  if (ui.editor.value !== state.compiledText || !state.info) {
    if (!(await compile())) return;
  }
  if (seq !== previewSeq) return;
  const { w, h } = outputSize();
  const { frame, nbrFrames, snapshot } = frameAt(state.frac);
  state.rendering = true;
  const t0 = performance.now();
  setStatus("rendering…", 0);
  try {
    // a quick small pass first, so the picture moves with the slider
    if (w * h > 160 * 160) {
      const sw = Math.max(1, Math.round(w / 4)), sh = Math.max(1, Math.round(h / 4));
      const small = await pool.renderFrame(frame, nbrFrames, snapshot, sw, sh);
      if (seq !== previewSeq) return;
      drawFrame(small, w, h);
    }
    const img = await pool.renderFrame(frame, nbrFrames, snapshot, w, h, (rows, total) => {
      if (seq === previewSeq) setStatus("rendering…", rows / total);
    });
    if (seq !== previewSeq) return;
    state.lastFrame = img;
    drawFrame(img, w, h);
    setStatus(`${w}×${h} in ${((performance.now() - t0) / 1000).toFixed(2)} s`);
  } catch (e) {
    if (seq === previewSeq) { setStatus(""); log("render: " + e.message, "err"); }
  } finally {
    if (seq === previewSeq) state.rendering = false;
  }
}

function drawFrame(img, w, h) {
  const c = ui.canvas;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext("2d");
  if (img.width === w && img.height === h) ctx.putImageData(img, 0, 0);
  else {
    const tmp = new OffscreenCanvas(img.width, img.height);
    tmp.getContext("2d").putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, 0, 0, w, h);
  }
}

// shows the script in the current view: plays the shader, or renders a frame
function refresh() { return state.view === "shader" ? showShader() : renderPreview(); }

let sliderTimer = null;
function onSlider() {
  state.frac = parseFloat(ui.slider.value);
  if (state.view === "shader") {
    if (player && state.shader) { player.pause(); showPlayState(); player.seek(state.frac * player.duration); }
    save();
    return;
  }
  updateTimeText();
  save();
  clearTimeout(sliderTimer);
  sliderTimer = setTimeout(renderPreview, 120);
}

// ------------------------------------------------------------------ movies

function evenSize(n) { return n % 2 ? n - 1 : n; }

async function pickCodec(w, h) {
  if (typeof VideoEncoder === "undefined") return null;
  const level = w * h > 1920 * 1080 ? "33" : w * h > 1280 * 720 ? "2a" : "1f";
  for (const codec of [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.4200${level}`, "avc1.640028", "avc1.42001f"]) {
    try {
      const s = await VideoEncoder.isConfigSupported({ codec, width: w, height: h });
      if (s.supported) return codec;
    } catch (_) {}
  }
  return null;
}

function bitrateFor(w, h, fps) {
  // generous: these pictures are noisy textures, and the file is the point
  return Math.min(60e6, Math.round(w * h * fps * 0.25));
}

// opts: {engine: "gpu" | "cpu", format: "mp4" | "png", first, last} (frames, 0-based)
async function renderMovie(opts) {
  if (state.movie) return;
  const gpu = opts.engine === "gpu";
  if (gpu) {
    if (!(await ensureShader())) { log("the shader didn't compile: render with the original renderer instead", "err"); return; }
  } else if (ui.editor.value !== state.compiledText || !state.info) {
    if (!(await compile())) return;
  }
  const info = state.info;
  const nbrFrames = Math.max(1, info.frames);
  let { w, h } = outputSize();
  const first = Math.max(0, Math.min(nbrFrames - 1, opts.first)), last = Math.max(first, Math.min(nbrFrames - 1, opts.last));
  const total = last - first + 1;
  const fps = info.frameRate > 0 ? info.frameRate : 12;

  let encoder = null, muxer = null, codec = null, zip = null;
  if (opts.format === "mp4") {
    w = evenSize(w); h = evenSize(h);
    codec = await pickCodec(w, h);
    if (!codec) { log("This browser can't encode H.264 video (no WebCodecs). Choose PNG frames instead.", "err"); return; }
    muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: "avc", width: w, height: h }, fastStart: "in-memory" });
    encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => log("encoder: " + e.message, "err"),
    });
    encoder.configure({ codec, width: w, height: h, bitrate: bitrateFor(w, h, fps), framerate: fps, latencyMode: "quality" });
  } else {
    zip = new ZipWriter();
  }

  const base = state.name.replace(/\.can$/i, "") || "movie";
  state.movie = { cancel: false };
  $("#movieCancel").hidden = false;
  const t0 = performance.now();
  let done = 0, next = first;
  const results = new Map();
  let wantFrame = first, encoding = Promise.resolve();
  let failed = null;

  // rgba: an ArrayBuffer of pixels, or a canvas holding the frame
  const encodeFrame = async (f, rgba) => {
    const i = f - first;
    if (encoder) {
      while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
      const timing = { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) };
      const frame = rgba instanceof ArrayBuffer
        ? new VideoFrame(rgba, Object.assign({ format: "RGBA", codedWidth: w, codedHeight: h }, timing))
        : new VideoFrame(rgba, timing);
      encoder.encode(frame, { keyFrame: i % Math.round(fps * 2) === 0 });
      frame.close();
    } else {
      let blob;
      if (rgba instanceof ArrayBuffer) {
        const c = new OffscreenCanvas(w, h);
        c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
        blob = await c.convertToBlob({ type: "image/png" });
      } else blob = await new Promise((r) => rgba.toBlob(r, "image/png"));
      zip.add(`${base}_${String(f + 1).padStart(4, "0")}.png`, new Uint8Array(await blob.arrayBuffer()));
    }
  };

  const progress = () => {
    const secs = (performance.now() - t0) / 1000;
    setStatus(`frame ${done} of ${total} · ${(done / secs).toFixed(1)} fps · ${formatSecs(secs / done * (total - done))} left`, done / total);
  };

  // the GPU path: one draw per frame at the frame's exact time, on the (visible) shader canvas
  const drawFrames = async () => {
    const p = getPlayer();
    const wasPlaying = p.playing;
    p.pause(); showPlayState();
    p.setSize(w, h);
    try {
      for (let f = first; f <= last && !state.movie.cancel; ++f) {
        p.draw(nbrFrames > 1 ? f / nbrFrames * info.duration : 0);
        await encodeFrame(f, ui.glview);
        done++;
        progress();
        // let the page breathe (and a Cancel click in) between frames
        await new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
      }
    } catch (e) { failed = e; }
    const size = outputSize();
    p.setSize(size.w, size.h);
    if (wasPlaying && state.view === "shader") p.play(); else if (state.view === "shader") p.draw();
    showPlayState();
    finish();
  };

  const dispatch = () => {
    while (next <= last && !state.movie.cancel) {
      const wk = pool.idleWorker();
      if (!wk) break;
      const f = next++;
      pool.call(wk, { type: "render", frame: f, nbrFrames, snapshot: 0, width: w, height: h, y0: 0, y1: h })
        .then((m) => {
          results.set(f, m.rgba);
          done++;
          progress();
          // encode in order
          encoding = encoding.then(async () => {
            while (results.has(wantFrame)) {
              const rgba = results.get(wantFrame);
              results.delete(wantFrame);
              await encodeFrame(wantFrame, rgba);
              wantFrame++;
            }
          }).catch((e) => { failed = e; state.movie.cancel = true; });
          dispatch();
        })
        .catch((e) => { if (!state.movie.cancel) { failed = e; state.movie.cancel = true; } dispatch(); });
    }
    if ((next > last || state.movie.cancel) && pool.workers.every((x) => !x.busy)) finish();
  };

  const finish = async () => {
    if (!state.movie) return;
    const cancelled = state.movie.cancel;
    state.movie = null;
    $("#movieCancel").hidden = true;
    await encoding;
    try {
      if (failed) { log("movie: " + failed.message, "err"); setStatus(""); if (encoder) encoder.close(); return; }
      if (cancelled) { log("movie cancelled"); setStatus(""); if (encoder) encoder.close(); return; }
      let blob, filename;
      if (encoder) {
        await encoder.flush();
        encoder.close();
        muxer.finalize();
        blob = new Blob([muxer.target.buffer], { type: "video/mp4" });
        filename = base + ".mp4";
      } else {
        blob = new Blob([zip.finish()], { type: "application/zip" });
        filename = base + "_frames.zip";
      }
      const secs = (performance.now() - t0) / 1000;
      log(`${filename}: ${total} frames, ${w}×${h}, ${(blob.size / 1048576).toFixed(1)} MB in ${formatSecs(secs)} (${gpu ? "the shader" : NWORKERS + " worker" + (NWORKERS === 1 ? "" : "s")})`);
      setStatus(`done: ${filename}`);
      download(blob, filename);
    } catch (e) {
      log("movie: " + e.message, "err");
      setStatus("");
    }
  };

  log(`rendering ${total} frame${total === 1 ? "" : "s"} at ${w}×${h}, ${fps} fps with ${gpu ? "the shader" : "the original renderer"} → ${opts.format === "mp4" ? "MP4 (" + codec + ")" : "PNG frames"}…`);
  setStatus("rendering movie…", 0);
  if (gpu) drawFrames(); else dispatch();
}

function formatSecs(s) {
  if (!isFinite(s)) return "?";
  s = Math.round(s);
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}m`
       : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function download(blob, filename) {
  if (window.qtsDownloadHook) { window.qtsDownloadHook(blob, filename); return; }   // the test harness catches files here
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
}

// A zip of stored (uncompressed) files: PNGs don't compress further
class ZipWriter {
  constructor() { this.parts = []; this.central = []; this.offset = 0; this.crcTable = ZipWriter.table(); }
  static table() {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; ++n) { let c = n; for (let k = 0; k < 8; ++k) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  }
  crc(data) {
    let c = -1;
    for (let i = 0; i < data.length; ++i) c = this.crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }
  add(name, data) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = this.crc(data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true);
    head.setUint16(8, 0, true); head.setUint16(10, 0, true); head.setUint16(12, 0x21, true);
    head.setUint32(14, crc, true); head.setUint32(18, data.length, true); head.setUint32(22, data.length, true);
    head.setUint16(26, nameBytes.length, true); head.setUint16(28, 0, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, 0, true); c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, nameBytes.length, true); c.setUint16(30, 0, true); c.setUint16(32, 0, true);
    c.setUint16(34, 0, true); c.setUint16(36, 0, true); c.setUint32(38, 0, true); c.setUint32(42, this.offset, true);
    this.parts.push(head.buffer, nameBytes, data);
    this.central.push(c.buffer, nameBytes);
    this.offset += 30 + nameBytes.length + data.length;
  }
  finish() {
    const cdSize = this.central.reduce((a, b) => a + b.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, this.central.length / 2, true); end.setUint16(10, this.central.length / 2, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, end.buffer]);
  }
}

// ------------------------------------------------------------------ the live shader

let player = null;
function getPlayer() {
  if (player) return player;
  player = new ShaderPlayer(ui.glview);   // throws without WebGL2
  player.onFrame = (t) => {
    if (state.view !== "shader" || !state.shader) return;
    const d = state.shader.g.duration;
    state.frac = d > 0 ? t / d : 0;
    ui.slider.value = String(state.frac);
    ui.timeText.textContent = `${t.toFixed(2)} s of ${d} s · ${player.fps ? player.fps.toFixed(0) + " fps" : ""}`;
  };
  return player;
}

// true when the GPU can be used at all (a WebGL2 context); remembered once it has failed
function haveGPU() {
  if (state.noGPU) return false;
  try { getPlayer(); return true; }
  catch (e) { state.noGPU = true; log(e.message, "warn"); return false; }
}

// the shader for the editor's current text, compiled if need be
async function ensureShader() {
  if (!haveGPU()) return false;
  if (state.shader && state.shader.text === ui.editor.value) return true;
  return compileShader();
}

function shaderSource() {
  const src = state.shader.g.source;
  return ui.shaderOversample.checked ? src : src.replace("#define QTS_OVERSAMPLE 1", "#define QTS_OVERSAMPLE 0");
}

// Parses the script with the JS engine, compiles it to GLSL and loads it into the player.
async function compileShader() {
  const text = ui.editor.value;
  let p;
  try { p = getPlayer(); } catch (e) { log(e.message, "err"); return false; }
  const files = await collectImages(text);
  const images = new Map(), bitmaps = new Map(), fileOf = new Map();
  for (const f of files) {
    try {
      const img = await QImage.decode(f.data.slice(0));
      fileOf.set(img, f);
      images.set(f.name, img); images.set(f.name.toLowerCase(), img);
      for (const alias of imageNames(text)) if (alias.toLowerCase().replace(/\.[^.]*$/, "") === f.name.toLowerCase().replace(/\.[^.]*$/, "")) { images.set(alias, img); images.set(alias.toLowerCase(), img); }
      bitmaps.set(img, await createImageBitmap(new Blob([f.data])));
    } catch (e) { log(`image ${f.name}: ${e.message}`, "warn"); }
  }
  const script = new Script();
  ui.log.textContent = "";
  if (!script.load(text, images)) { for (const e of script.errors) log(e, "err"); setStatus("compile failed"); return false; }
  for (const w of script.warnings) log(w, "warn");
  let g;
  try { g = compileScriptToGLSL(script); }
  catch (e) { if (e instanceof GLSLError) { log("shader: " + e.message, "err"); setStatus("shader compile failed"); return false; } throw e; }
  for (const w of g.warnings) log("shader: " + w, "warn");
  state.shader = { g, files, bitmaps, fileOf, text };
  try {
    p.setShader(shaderSource(), g.images.map((im) => ({ name: "", source: bitmaps.get(im) })), g.duration);
  } catch (e) {
    log(e.message, "err");
    log("the GPU rejected the shader: the Frame tab renders it on the CPU instead", "warn");
    setStatus("the GPU rejected the shader");
    state.shader = null;
    return false;
  }
  state.info = script.info();
  logInfo(state.info);
  updateTimeText();
  if (!ui.width.value || ui.width.dataset.auto !== "0") { ui.width.value = g.width; ui.width.dataset.auto = "1"; }
  if (!ui.height.value || ui.height.dataset.auto !== "0") { ui.height.value = g.height; ui.height.dataset.auto = "1"; }
  log(`shader: ${(g.source.length / 1024).toFixed(0)} KB of GLSL, loops every ${g.duration} s${g.images.length ? `, ${g.images.length} image${g.images.length === 1 ? "" : "s"}` : ""}`);
  setStatus("");
  return true;
}

async function showShader() {
  if (state.movie) return;
  if (!haveGPU()) { log("no WebGL2 here: using the Frame view", "warn"); setView("frame"); return; }
  if (!(await ensureShader())) return;
  const { w, h } = outputSize();
  const p = getPlayer();
  p.setSize(w, h);
  p.seek(state.frac * p.duration);
  p.play();
  showPlayState();
}

function showPlayState() {
  const playing = !!(player && player.playing);
  ui.shaderPlay.textContent = playing ? "❚❚" : "▶";
  ui.shaderPlay.setAttribute("aria-label", playing ? "pause" : "play");
}

function togglePlay() {
  if (!player || !state.shader) { showShader(); return; }
  if (player.playing) player.pause(); else player.play();
  showPlayState();
}

let shaderTimer = null;
function shaderEdited() {
  if (state.view !== "shader") return;
  clearTimeout(shaderTimer);
  shaderTimer = setTimeout(async () => {
    if (!(await compileShader())) return;
    const p = getPlayer();
    if (!p.playing) p.draw();
  }, 400);
}

// the tabs, canvases and buttons for state.view
function showTabs() {
  const shader = state.view === "shader";
  $("#tabFrame").classList.toggle("on", !shader);
  $("#tabShader").classList.toggle("on", shader);
  ui.canvas.hidden = shader; ui.glview.hidden = !shader;
  $("#shaderButtons").hidden = !shader;
  ui.shaderPlay.hidden = !shader;
  $("#render").textContent = shader ? "Run shader" : "Render frame";
}

function setView(view) {
  state.view = view;
  showTabs();
  save();
  if (view === "shader") showShader();
  else {
    if (player) player.pause();
    updateTimeText();
    if (!state.lastFrame || ui.editor.value !== state.compiledText) renderPreview();
  }
}

// the current picture of the shader view as a PNG download
function saveShaderFrame() {
  if (!player || !state.shader) return;
  if (!player.playing) player.draw();
  const { frame } = frameAt(state.frac);
  ui.glview.toBlob((b) => download(b, `${shaderBaseName()}_${String(frame + 1).padStart(4, "0")}.png`), "image/png");
}

function shaderBaseName() { return state.name.replace(/\.can$/i, "") || "shader"; }

async function saveShaderHtml() {
  if (!state.shader) { if (!(await compileShader())) return; }
  const { g, fileOf } = state.shader;
  const images = [];
  for (const im of g.images) {
    const file = fileOf.get(im);
    if (!file) continue;
    const type = /\.jpe?g$/i.test(file.name) ? "image/jpeg" : "image/png";
    const dataURL = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob([file.data], { type })); });
    images.push({ name: file.name, dataURL });
  }
  const html = standaloneHTML({ source: shaderSource(), title: shaderBaseName(), images, duration: g.duration, width: g.width, height: g.height });
  download(new Blob([html], { type: "text/html" }), shaderBaseName() + "_shader.html");
}

async function saveShaderGlsl() {
  if (!state.shader) { if (!(await compileShader())) return; }
  download(new Blob([shaderSource()], { type: "text/plain" }), shaderBaseName() + ".glsl");
}

// ------------------------------------------------------------------ examples

async function loadExamples() {
  try {
    const r = await fetch("examples/index.json");
    state.examples = await r.json();
  } catch (_) { state.examples = []; }
  const grid = $("#gallery");
  if (grid) {
    grid.innerHTML = "";
    for (const ex of state.examples) {
      const a = document.createElement("a");
      a.href = "?x=" + encodeURIComponent(ex.file);
      a.className = "thumb";
      a.innerHTML = `<img loading="lazy" alt=""><span></span>`;
      a.querySelector("img").src = "examples/thumbs/" + ex.file.replace(/\.can$/, ".png");
      a.querySelector("span").textContent = ex.file.replace(/\.can$/, "");
      a.title = ex.description || ex.file;
      a.onclick = (e) => { e.preventDefault(); openExample(ex.file); };
      grid.appendChild(a);
    }
  }
}

async function openExample(file) {
  const r = await fetch("examples/" + encodeURIComponent(file));
  if (!r.ok) { log("can't load " + file, "err"); return; }
  const bytes = new Uint8Array(await r.arrayBuffer());
  setScript(new TextDecoder("latin1").decode(bytes), file);
  history.replaceState(null, "", "?x=" + encodeURIComponent(file));
  closeGallery();
  state.frac = state.view === "shader" ? 0 : 0.5;
  ui.slider.value = String(state.frac);
  await refresh();
}

function setScript(text, name) {
  ui.editor.value = text;
  state.name = name;
  ui.name.value = name;
  ui.width.dataset.auto = "1"; ui.height.dataset.auto = "1";
  ui.width.value = ""; ui.height.value = "";
  state.compiledText = null;
  state.info = null;
  save();
}

function openGallery() { $("#galleryPanel").hidden = false; }
function closeGallery() { $("#galleryPanel").hidden = true; }

// ------------------------------------------------------------------ wiring

function wire() {
  ui.slider.addEventListener("input", onSlider);
  ui.editor.addEventListener("input", () => { save(); shaderEdited(); });
  ui.editor.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); refresh(); }
    if (e.key === "Tab") {
      e.preventDefault();
      const s = ui.editor.selectionStart, t = ui.editor.selectionEnd;
      ui.editor.setRangeText("  ", s, t, "end");
    }
  });
  $("#render").onclick = refresh;
  $("#tabFrame").onclick = () => setView("frame");
  $("#tabShader").onclick = () => setView("shader");
  ui.shaderPlay.onclick = togglePlay;
  ui.glview.onclick = togglePlay;
  $("#tips").onclick = () => $("#tipsDialog").showModal();
  $("#tipsClose").onclick = () => $("#tipsDialog").close();
  ui.shaderOversample.onchange = () => { if (state.shader) { state.shader.text = null; showShader(); } };
  $("#saveShaderHtml").onclick = () => saveShaderHtml().catch((e) => log("save: " + e.message, "err"));
  $("#saveShaderGlsl").onclick = () => saveShaderGlsl().catch((e) => log("save: " + e.message, "err"));
  $("#savePng").onclick = () => {
    if (state.view === "shader") { saveShaderFrame(); return; }
    if (!state.lastFrame) return;
    const c = document.createElement("canvas");
    c.width = state.lastFrame.width; c.height = state.lastFrame.height;
    c.getContext("2d").putImageData(state.lastFrame, 0, 0);
    const { frame } = frameAt(state.frac);
    c.toBlob((b) => download(b, `${state.name.replace(/\.can$/i, "")}_${String(frame + 1).padStart(4, "0")}.png`), "image/png");
  };
  $("#movie").onclick = async () => {
    // the dialog needs the script's frame count for the current text: from the shader, else the wasm
    const ok = (haveGPU() && await ensureShader()) || (ui.editor.value === state.compiledText && state.info) || await compile();
    if (ok) showMovieDialog();
  };
  $("#movieCancel").onclick = () => { if (state.movie) { state.movie.cancel = true; pool.cancel(); } };
  $("#movieGo").onclick = () => {
    const d = $("#movieDialog");
    d.close();
    const format = $("#movieFormat").value, engine = $("#movieEngine").value;
    const all = $("#movieAll").checked;
    const n = state.info ? state.info.frames : 1;
    renderMovie({ engine, format, first: all ? 0 : parseInt($("#movieFirst").value, 10) - 1, last: all ? n - 1 : parseInt($("#movieLast").value, 10) - 1 });
  };
  $("#movieClose").onclick = () => $("#movieDialog").close();
  $("#movieEngine").onchange = movieHint;
  for (const el of [ui.width, ui.height]) el.addEventListener("input", () => { el.dataset.auto = "0"; save();
    if (state.view === "shader" && player) { const { w, h } = outputSize(); player.setSize(w, h); if (!player.playing) player.draw(); } });
  $("#sizeReset").onclick = () => { ui.width.dataset.auto = "1"; ui.height.dataset.auto = "1";
    if (state.info) { ui.width.value = state.info.width; ui.height.value = state.info.height; } save(); };
  $("#gallery-open").onclick = openGallery;
  $("#galleryClose").onclick = closeGallery;
  $("#new").onclick = () => {
    setScript(`// a new script: one sequence, one second, 256x256\n<seq fw=256 fh=256 duration=1 framerate=12 center oversample\n  hsv="a/pi2, 1, 1-d*2" />\n`, "untitled.can");
    refresh();
  };
  $("#open").onclick = () => $("#openFile").click();
  $("#openFile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    setScript(new TextDecoder("latin1").decode(new Uint8Array(await f.arrayBuffer())), f.name);
    e.target.value = "";
    refresh();
  };
  $("#save").onclick = () => download(new Blob([ui.editor.value], { type: "text/plain" }), state.name || "script.can");
  $("#images").onclick = () => $("#imageFiles").click();
  $("#imageFiles").onchange = async (e) => {
    for (const f of e.target.files) {
      state.userImages.set(f.name.toLowerCase(), { name: f.name, data: await f.arrayBuffer() });
      log(`image ${f.name} added: refer to it as image="${f.name}"`);
    }
    e.target.value = "";
    state.compiledText = null;
  };
  ui.name.addEventListener("change", () => { state.name = ui.name.value.trim() || "untitled.can"; if (!/\.can$/i.test(state.name)) state.name += ".can"; ui.name.value = state.name; save(); });
  $("#help").onclick = () => { window.open("language.html", "_blank"); };
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeGallery(); } });
}

function showMovieDialog() {
  const d = $("#movieDialog");
  const n = state.info ? state.info.frames : 1;
  const { w, h } = outputSize();
  $("#movieInfo").textContent = `${n} frame${n === 1 ? "" : "s"} at ${w}×${h}, ${state.info.frameRate} fps (${state.info.duration} s)`;
  $("#movieFirst").value = 1; $("#movieLast").value = n;
  $("#movieFirst").max = n; $("#movieLast").max = n;
  const canMp4 = typeof VideoEncoder !== "undefined";
  $("#movieFormat").querySelector('option[value="mp4"]').disabled = !canMp4;
  if (!canMp4) $("#movieFormat").value = "png";
  const canGPU = !!(state.shader && state.shader.text === ui.editor.value);
  $("#movieEngine").querySelector('option[value="gpu"]').disabled = !canGPU;
  $("#movieEngine").value = canGPU ? "gpu" : "cpu";
  movieHint();
  d.showModal();
}

function movieHint() {
  $("#movieHint").textContent = $("#movieEngine").value === "gpu"
    ? "The shader draws each frame on the GPU: quick, 32-bit float, and the frames show as they are made. The file downloads when it is done."
    : "The original renderer runs in this tab on every core: exact, but a formula per pixel per frame. The file downloads when it is done.";
}

async function start() {
  wire();
  await loadExamples();
  const params = new URLSearchParams(location.search);
  const want = params.get("x");
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORAGE) || "null"); } catch (_) {}
  // the view: the one used last time, else the shader where there is WebGL2
  state.view = saved && saved.view === "frame" ? "frame" : haveGPU() ? "shader" : "frame";
  showTabs();
  if (want) {
    await openExample(want);
    return;
  }
  if (saved && saved.text) {
    ui.editor.value = saved.text;
    state.name = saved.name || "untitled.can";
    ui.name.value = state.name;
    state.frac = saved.frac || 0;
    ui.slider.value = String(state.frac);
    if (saved.width) { ui.width.value = saved.width; ui.width.dataset.auto = "0"; }
    if (saved.height) { ui.height.value = saved.height; ui.height.dataset.auto = "0"; }
    await refresh();
  } else {
    await openExample(FIRST_EXAMPLE);
  }
}

start();
