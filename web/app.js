// Fragtime: the node editor.
//
// The patch (engine/graph.js) is the document. Every change recompiles it a moment later to one
// fragment shader (engine/graph_glsl.js) that the player (shader.js) plays on the GPU; a second,
// "preview" build of the same patch draws each node's thumbnail on the desk (a uniform picks
// the node). The desk (desk.js) and the inspector (inspector.js) report gestures and edits here;
// this file owns the patch, undo, storage, files, examples and movies (WebCodecs + mp4-muxer, or
// PNG frames in a zip, drawn by the shader frame by frame).

import { Muxer, ArrayBufferTarget } from "./vendor/mp4-muxer.mjs";
import { Image as QImage } from "./engine/image.js";
import { GLSLError } from "./engine/glsl.js";
import { compilePatchToGLSL, NodeError, FT_MAXTILES } from "./engine/graph_glsl.js";
import { importCan } from "./engine/import_can.js";
import * as G from "./engine/graph.js";
import { ShaderPlayer, standaloneHTML } from "./shader.js";
import { Desk } from "./desk.js";
import { Inspector } from "./inspector.js";

const $ = (s) => document.querySelector(s);
const STORAGE = "fragtime-editor";
const FIRST_EXAMPLE = "spiral2";
const THUMB_W = 96, THUMB_H = 72;

const NEW_PATCH = () => ({ fragtime: 1, title: "untitled", nodes: [
  { id: "rings", type: "source", x: 0, y: 0, inputs: {}, params: { hsv: "a/pi2, 1, .5+.5*sin(d*40-t*pi2*2)", center: true } },
  { id: "out", type: "output", x: 250, y: 0, inputs: { in: "rings" }, params: { width: 320, height: 240, fps: 24, duration: 4, oversample: true } },
] });

// the palette: node templates (with a node selected, the ones with inputs take it as the first)
const TEMPLATES = [
  { label: "Source", type: "source", id: "source", ports: [], params: { hsv: "a/pi2, 1, .5+.5*sin(d*40-t*pi2*2)", center: true }, tip: "a formula of x, y and t" },
  { label: "Image", type: "image", id: "image", ports: [], params: { pix: "sample(x,y)", height: "1" }, image: true, tip: "an image file (add your own with Images…)" },
  { label: "Expression", type: "expr", id: "expr", ports: ["a"], params: { pix: "$a", height: "1" }, tip: "a formula that reads its inputs as $a, $b…" },
  { label: "Warp", type: "expr", id: "warp", ports: ["in"], params: { pix: "$in[x+.03*sin(y*pi2*3+t*pi2), y+.03*sin(x*pi2*3+t*pi2)]", height: "1" }, tip: "reads its input at moved coordinates" },
  { label: "Mask", type: "expr", id: "mask", ports: ["a", "b", "m"], params: { pix: "terp($a,$b,$m)", height: "1" }, tip: "a where m is dark, b where it is bright" },
  { label: "Displace", type: "expr", id: "displace", ports: ["in", "by"], params: { pix: "$in[x+($by-.5)*.1, y+($by-.5)*.1]", height: "1" }, tip: "moves its input by another picture's brightness" },
  { label: "Blend", type: "blend", id: "blend", ports: ["a", "b"], params: { mode: "screen" }, tip: "b over a, with a blend mode" },
  { label: "Sequence", type: "sequence", id: "seq", ports: ["s1"], params: {}, tip: "paints its inputs in order, each while it is alive" },
  { label: "Time", type: "time", id: "time", ports: ["in"], params: { time: "t*dur*2" }, tip: "plays its input at another time" },
];
const TEMPLATE_COLOR = { source: "--t-source", image: "--t-image", expr: "--t-expr", blend: "--t-group", sequence: "--t-group", time: "--t-group" };

// ------------------------------------------------------------------ state

const state = {
  patch: null,
  name: "untitled.fragtime",
  frac: 0,
  undo: [], redo: [],
  errors: new Map(),         // node id -> {key, message}: the compile error, shown on the node and its field
  compiled: null,            // {g, bitmaps, fileOf, key}
  preview: null,             // {g, key}
  movie: null,
  examples: [],
  exampleImages: [],
  userImages: new Map(),     // lower name -> {name, data}
  noGPU: false,
};

const ui = {
  glview: $("#glview"), slider: $("#time"), timeText: $("#timeText"), log: $("#log"), status: $("#status"),
  progress: $("#progress"), play: $("#shaderPlay"), oversample: $("#shaderOversample"),
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
  try { localStorage.setItem(STORAGE, JSON.stringify({ patch: G.serialize(state.patch), name: state.name, frac: state.frac })); } catch (_) {}
}
const baseName = () => state.name.replace(/\.(fragtime|can|json)$/i, "") || "fragtime";

// ------------------------------------------------------------------ the app, as the desk and inspector see it

const app = {
  get patch() { return state.patch; },
  get errors() { return state.errors; },
  desk: null,
  inspector: null,

  remember() {
    state.undo.push(G.serialize(state.patch));
    if (state.undo.length > 300) state.undo.shift();
    state.redo = [];
    showUndo();
  },
  forgetLast() { state.undo.pop(); showUndo(); },

  // after a change to the patch's shape: redraw, re-inspect, recompile (not for moves)
  changed(opts = {}) {
    app.desk.draw();
    if (!opts.keepInspector) app.inspector.render();
    if (!opts.layoutOnly) compileSoon();
    save();
    showUndo();
  },
  select() { app.inspector.render(); app.desk.draw(); },
  focusInspector() { const f = $("#inspector textarea, #inspector input[type=text]"); if (f) f.focus(); },
  status(text, isError) { log(text, isError ? "err" : ""); },
  fieldDone() { setTimeout(() => app.inspector.render(), 0); },

  setParam(node, key, value) {
    if (value === undefined || value === "") delete node.params[key]; else node.params[key] = value;
    app.desk.draw();
    compileSoon();
    save();
  },
  setColor(node, key, value) {
    for (const k of G.COLOR_KEYS) delete node.params[k];
    node.params[key] = value;
    compileSoon();
    save();
  },
  setInput(node, port, src) {
    if (src && wouldCycle(src, node.id)) { app.status(`${src} already reads ${node.id}: wiring it in would make a loop`, true); app.inspector.render(); return; }
    app.remember();
    node.inputs[port] = src;
    app.changed();
  },
  connect(srcId, dstId, port) {
    const dst = state.patch.nodes.find((n) => n.id === dstId);
    if (!dst || srcId === dstId) return;
    if (wouldCycle(srcId, dstId)) { app.status(`${srcId} already reads ${dstId}: wiring it in would make a loop`, true); app.desk.draw(); return; }
    app.remember();
    if (!port) port = freePort(dst, srcId);
    if (!port) { app.forgetLast(); app.desk.draw(); return; }
    dst.inputs[port] = srcId;
    if (G.isFormula(dst) && !G.refsIn(G.colorParam(dst)[1]).length && Object.keys(dst.inputs).length === 1 && dst.type !== "image")
      app.status(`${dstId} reads ${srcId} as $${port}: use it in ${dstId}'s expression`);
    app.desk.selWire = null;
    app.changed();
  },
  addPort(node, name) {
    app.remember();
    if (node.type === "sequence") node.inputs["s" + (G.portsOf(node).length + 1)] = null;
    else {
      let p = name || "in";
      if (!name) for (let i = 2; p in node.inputs; ++i) p = "in" + i;
      node.inputs[p] = null;
    }
    app.changed();
  },
  removePort(node, port) {
    app.remember();
    removePort(node, port);
    app.changed();
  },
  moveEntry(node, i, dir) {
    const ports = G.portsOf(node), j = i + dir;
    if (j < 0 || j >= ports.length) return;
    app.remember();
    const entries = ports.map((p) => [node.inputs[p], (node.params.modes || {})[p]]);
    [entries[i], entries[j]] = [entries[j], entries[i]];
    setEntries(node, entries);
    app.changed();
  },
  setSequenceMode(node, port, mode) {
    app.remember();
    const modes = Object.assign({}, node.params.modes || {});
    if (mode === "normal") delete modes[port]; else modes[port] = mode;
    if (Object.keys(modes).length) node.params.modes = modes; else delete node.params.modes;
    app.changed();
  },
  renameNode(node, newId) {
    const old = node.id;
    app.remember();
    try { G.renameNode(state.patch, old, newId); }
    catch (e) { app.forgetLast(); return e.message; }
    if (app.desk.selection.delete(old)) app.desk.selection.add(newId);
    if (state.errors.has(old)) { state.errors.set(newId, state.errors.get(old)); state.errors.delete(old); }
    app.changed();
    return null;
  },
  renamePort(node, old, name) {
    if (old === name) return null;
    app.remember();
    try { G.renamePort(node, old, name); }
    catch (e) { app.forgetLast(); return e.message; }
    app.changed();
    return null;
  },
  deleteSelection() {
    const desk = app.desk, patch = state.patch;
    if (desk.selWire) {
      const dst = patch.nodes.find((n) => n.id === desk.selWire.node);
      if (dst) { app.remember(); unwire(dst, desk.selWire.port); }
      desk.selWire = null;
      app.changed();
      return;
    }
    const gone = new Set([...desk.selection].filter((id) => { const n = patch.nodes.find((m) => m.id === id); return n && n.type !== "output"; }));
    if (!gone.size) { if (desk.selection.size) app.status("The Output stays: every patch has one.", true); return; }
    app.remember();
    // what read a deleted node reads what fed it (its first input), so taking a node out of a
    // chain keeps the chain; otherwise the wire goes
    const byId = G.nodeById(patch);
    const feed = (id, seen = new Set()) => {
      const n = byId.get(id);
      if (!n || seen.has(id)) return null;
      seen.add(id);
      const first = G.portsOf(n).map((p) => n.inputs[p]).find(Boolean);
      return first && gone.has(first) ? feed(first, seen) : first || null;
    };
    patch.nodes = patch.nodes.filter((n) => !gone.has(n.id));
    for (const n of patch.nodes) for (const p of G.portsOf(n).slice().reverse()) if (gone.has(n.inputs[p])) {
      const f = feed(n.inputs[p]);
      if (f && f !== n.id && !wouldCycle(f, n.id)) n.inputs[p] = f; else unwire(n, p);
    }
    desk.selection.clear();
    for (const id of gone) state.errors.delete(id);
    app.changed();
  },
  duplicateSelection() {
    const patch = state.patch, desk = app.desk;
    const src = patch.nodes.filter((n) => desk.selection.has(n.id) && n.type !== "output");
    if (!src.length) return;
    app.remember();
    const map = new Map();
    for (const n of src) map.set(n.id, G.newId({ nodes: patch.nodes.concat([...map.values()].map((id) => ({ id }))) }, n.id));
    const copies = src.map((n) => {
      const c = JSON.parse(JSON.stringify(n));
      c.id = map.get(n.id); c.x += 40; c.y += 40;
      for (const k of Object.keys(c.inputs)) if (map.has(c.inputs[k])) c.inputs[k] = map.get(c.inputs[k]);
      return c;
    });
    patch.nodes.push(...copies);
    desk.selection = new Set(copies.map((c) => c.id));
    app.changed();
  },
  addTemplate(t, at) {
    const patch = state.patch, desk = app.desk;
    const selId = desk.selection.size === 1 ? [...desk.selection][0] : null;
    const sel = selId ? patch.nodes.find((n) => n.id === selId) : null;
    app.remember();
    const node = { id: G.newId(patch, t.id), type: t.type, x: 0, y: 0, inputs: {}, params: JSON.parse(JSON.stringify(t.params)) };
    for (const p of t.ports) node.inputs[p] = null;
    if (t.image) { const im = imageList()[0]; if (im) node.params.image = im; }
    const takes = sel && sel.type !== "output" && t.ports.length && !at;
    if (takes) {
      // insert it after the selected node: what read the selection reads the new node
      for (const n of patch.nodes) for (const p of G.portsOf(n)) if (n.inputs[p] === sel.id) n.inputs[p] = node.id;
      node.inputs[t.ports[0]] = sel.id;
      node.x = sel.x + 70; node.y = sel.y + 140;
    } else {
      const p = at || desk.freeSpot();
      node.x = Math.round(p.x); node.y = Math.round(p.y);
    }
    patch.nodes.push(node);
    desk.selection = new Set([node.id]);
    desk.selWire = null;
    app.changed();
  },
  imageNames() { return imageList(); },
  drawn() { thumbsSoon(); },
};

function showUndo() { $("#undo").disabled = !state.undo.length; $("#redo").disabled = !state.redo.length; }

function restoreSnapshot(text) {
  state.patch = G.parse(text);
  const ids = new Set(state.patch.nodes.map((n) => n.id));
  app.desk.selection = new Set([...app.desk.selection].filter((id) => ids.has(id)));
  app.desk.selWire = null;
}
function undo() {
  if (!state.undo.length) return;
  state.redo.push(G.serialize(state.patch));
  restoreSnapshot(state.undo.pop());
  app.changed();
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(G.serialize(state.patch));
  restoreSnapshot(state.redo.pop());
  app.changed();
}

// would wiring src into dst make a loop (does src already read dst)?
function wouldCycle(srcId, dstId) {
  const byId = G.nodeById(state.patch), seen = new Set();
  const walk = (id) => {
    if (id === dstId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const n = byId.get(id);
    return !!n && Object.values(n.inputs || {}).some((s) => s && walk(s));
  };
  return walk(srcId);
}

// the port a wire dropped on a node's body goes to
function freePort(dst, srcId) {
  const ports = G.portsOf(dst);
  if (dst.type === "sequence") {
    const open = ports.find((p) => !dst.inputs[p]);
    return open || "s" + (ports.length + 1);
  }
  if (G.isFormula(dst)) {
    const open = ports.find((p) => !dst.inputs[p]);
    if (open) return open;
    let p = srcId;
    for (let i = 2; p in dst.inputs; ++i) p = srcId + i;
    return p;
  }
  return ports.find((p) => !dst.inputs[p]) || ports[ports.length - 1];
}

function setEntries(node, entries) {
  const inputs = {}, modes = {};
  entries.forEach(([src, mode], i) => { inputs["s" + (i + 1)] = src ?? null; if (mode && mode !== "normal") modes["s" + (i + 1)] = mode; });
  node.inputs = inputs;
  if (Object.keys(modes).length) node.params.modes = modes; else delete node.params.modes;
}
function removePort(node, port) {
  if (node.type === "sequence") {
    setEntries(node, G.portsOf(node).filter((p) => p !== port).map((p) => [node.inputs[p], (node.params.modes || {})[p]]));
  } else if (G.isFormula(node)) delete node.inputs[port];
  else node.inputs[port] = null;
}
// takes a wire out: a sequence loses the input, a formula keeps the port its expression reads
function unwire(node, port) {
  if (node.type === "sequence") return removePort(node, port);
  if (G.isFormula(node)) {
    const read = [...G.COLOR_KEYS, ...G.FORMULA_PARAMS.map((p) => p.key)].some((k) => G.refsIn(node.params[k]).includes(port));
    if (read) node.inputs[port] = null; else delete node.inputs[port];
    return;
  }
  node.inputs[port] = null;
}

// ------------------------------------------------------------------ images

const fetched = new Map();
async function fetchExampleImage(name) {
  const base = name.replace(/\.[^.]*$/, "");
  for (const t of [name, name.toLowerCase(), base + ".png", base.toLowerCase() + ".png"]) {
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
function imageList() {
  const names = new Set([...[...state.userImages.values()].map((f) => f.name), ...state.exampleImages]);
  // a patch's own names that resolve (imported scripts say mona_lisa.bmp; the file is mona_lisa.png)
  const bases = new Set([...names].map((n) => n.toLowerCase().replace(/\.[^.]*$/, "")));
  for (const n of state.patch ? state.patch.nodes : []) {
    const im = n.params && n.params.image;
    if (im && bases.has(im.toLowerCase().replace(/\.[^.]*$/, ""))) names.add(im);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
// the decoded images a patch uses: {images: Map name -> QImage, bitmaps: Map QImage -> ImageBitmap, fileOf}
const decoded = new Map();     // file name -> {img, bitmap, file}
async function loadImages(patch) {
  const images = new Map(), bitmaps = new Map(), fileOf = new Map();
  for (const n of patch.nodes) {
    const name = n.params && n.params.image;
    if (!name || images.has(name)) continue;
    const f = state.userImages.get(name.toLowerCase()) || await fetchExampleImage(name);
    if (!f) { log(`image ${name}: not here; add it with Images…`, "warn"); continue; }
    let d = decoded.get(f.name);
    if (!d || d.file !== f) {
      try { d = { img: await QImage.decode(f.data.slice(0)), bitmap: await createImageBitmap(new Blob([f.data])), file: f }; }
      catch (e) { log(`image ${f.name}: ${e.message}`, "warn"); continue; }
      decoded.set(f.name, d);
    }
    images.set(name, d.img); images.set(name.toLowerCase(), d.img);
    bitmaps.set(d.img, d.bitmap); fileOf.set(d.img, f);
  }
  return { images, bitmaps, fileOf };
}

// ------------------------------------------------------------------ compiling and playing

let player = null, thumbs = null;
function getPlayer() {
  if (player) return player;
  player = new ShaderPlayer(ui.glview);
  player.onFrame = (t) => {
    const d = player.duration;
    state.frac = d > 0 ? t / d : 0;
    ui.slider.value = String(state.frac);
    ui.timeText.textContent = `${t.toFixed(2)} s of ${+d.toFixed(3)} s${player.playing && player.fps ? " · " + player.fps.toFixed(0) + " fps" : ""}`;
    if (player.playing) thumbTick();
  };
  return player;
}
function haveGPU() {
  if (state.noGPU) return false;
  try { getPlayer(); return true; }
  catch (e) { state.noGPU = true; log(e.message + ": Fragtime needs WebGL2", "err"); return false; }
}
const shaderText = (g) => ui.oversample.checked ? g.source : g.source.replace("#define QTS_OVERSAMPLE 1", "#define QTS_OVERSAMPLE 0");
const shapeKey = (patch) => JSON.stringify(patch.nodes.map((n) => [n.id, n.type, n.inputs, n.params])) + "|" + state.userImages.size;

let compileTimer = null, compileSeq = 0;
function compileSoon(delay = 250) { clearTimeout(compileTimer); compileTimer = setTimeout(() => compileNow(), delay); }

async function compileNow(force) {
  clearTimeout(compileTimer);
  if (!haveGPU()) return false;
  const seq = ++compileSeq, patch = state.patch, key = shapeKey(patch);
  if (!force && state.compiled && state.compiled.key === key) {
    // back to what is playing (an undo after an error): only the error goes
    if (state.errors.size || /^not compiled/.test(ui.status.textContent)) { state.errors.clear(); showErrors(); logCompiled(state.compiled.g); setStatus(""); }
    return true;
  }
  const { images, bitmaps, fileOf } = await loadImages(patch);
  if (seq !== compileSeq) return false;
  const hadErrors = state.errors.size;
  state.errors.clear();
  let g;
  try { g = compilePatchToGLSL(patch, images); }
  catch (e) {
    if (!(e instanceof GLSLError)) throw e;
    if (e instanceof NodeError) state.errors.set(e.nodeId, { key: e.key, message: e.detail });
    showErrors();
    ui.log.textContent = "";
    log(e.message, "err");
    setStatus("not compiled: " + e.message);
    return false;
  }
  const p = getPlayer();
  try { p.setShader(shaderText(g), g.images.map((im) => ({ name: "", source: bitmaps.get(im) })), g.duration); }
  catch (e) {
    ui.log.textContent = "";
    log(e.message, "err");
    log("the GPU rejected the shader", "err");
    setStatus("the GPU rejected the shader");
    return false;
  }
  state.compiled = { g, bitmaps, fileOf, key };
  if (hadErrors) showErrors();
  logCompiled(g);
  setStatus("");
  p.setSize(g.width, g.height);
  p.seek(state.frac * g.duration);
  if (!p.playing && wantPlay) p.play();
  showPlayState();
  setTimeout(() => compilePreview(seq), 30);
  return true;
}

function logCompiled(g) {
  ui.log.textContent = "";
  log(`${g.duration} s at ${g.fps} fps = ${Math.trunc(g.duration * g.fps)} frames, ${g.width}×${g.height} · ${(g.source.length / 1024).toFixed(0)} KB of GLSL${g.images.length ? ` · ${g.images.length} image${g.images.length === 1 ? "" : "s"}` : ""}`);
  for (const w of g.warnings) log(w, "warn");
}

function showErrors() {
  app.desk.errors = new Map([...state.errors].map(([id, e]) => [id, e.message]));
  app.desk.draw();
  app.inspector.showErrors();
}

// the thumbnails' shader: every node, a uniform picks which one
let lastThumbs = 0, thumbTimer = null;
async function compilePreview(seq) {
  if (seq !== compileSeq || !state.compiled) return;
  if (!thumbs) {
    try { thumbs = new ShaderPlayer(document.createElement("canvas")); }
    catch (_) { return; }
  }
  let g;
  try { g = compilePatchToGLSL(state.patch, (await loadImages(state.patch)).images, { all: true, preview: true }); }
  catch (_) { return; }
  if (seq !== compileSeq) return;
  const { bitmaps } = state.compiled;
  try { thumbs.setShader(g.source.replace("#define QTS_OVERSAMPLE 1", "#define QTS_OVERSAMPLE 0"), g.images.map((im) => ({ name: "", source: bitmaps.get(im) })), g.duration); }
  catch (e) { console.warn("thumbnails:", e.message); state.preview = null; return; }
  state.preview = { g, ar: g.width / g.height, tw: 0, th: 0 };
  drawThumbs(true);
}

// Thumbnails: one draw of the preview shader fills an atlas, a tile per node (the shader picks
// the node from the tile), which is copied out once and handed to the nodes. A draw costs about
// as long as one pixel's program runs, whatever its size, so one draw per node, or one copy out
// of WebGL per node, made a big patch crawl. Tiles are the size the nodes show on screen.
const atlas2d = document.createElement("canvas");
function thumbSize() {
  const pv = state.preview;
  const box = Math.max(24, Math.min(THUMB_W, Math.round(THUMB_W * app.desk.zoom * (devicePixelRatio || 1))));
  const bh = box * THUMB_H / THUMB_W;
  pv.tw = pv.ar >= THUMB_W / THUMB_H ? box : Math.max(1, Math.round(bh * pv.ar));
  pv.th = pv.ar >= THUMB_W / THUMB_H ? Math.max(1, Math.round(box / pv.ar)) : Math.round(bh);
}
function drawThumbs(all) {
  lastThumbs = performance.now();
  const pv = state.preview;
  if (!pv || !thumbs) return;
  thumbSize();
  const ids = (all ? state.patch.nodes.map((n) => n.id) : app.desk.visibleIds()).filter((id) => app.desk.thumbOf(id));
  if (!ids.length) return;
  ids.length = Math.min(ids.length, FT_MAXTILES);
  const { tw, th } = pv, cols = Math.max(1, Math.min(ids.length, Math.floor(4096 / tw), Math.ceil(Math.sqrt(ids.length * th / tw))));
  const rows = Math.ceil(ids.length / cols), W = cols * tw, H = rows * th;
  thumbs.setSize(W, H);
  // tile i counts from the bottom left in GL; the copies below count rows from the top
  const nodes = new Int32Array(FT_MAXTILES).fill(-2);
  ids.forEach((id, i) => {
    const n = state.patch.nodes.find((m) => m.id === id);
    const k = n && n.type === "output" ? -1 : pv.g.nodeIndex.get(id);
    nodes[(rows - 1 - Math.floor(i / cols)) * cols + (i % cols)] = k === undefined ? -2 : k;
  });
  thumbs.setInts("ft_nodes", nodes);
  thumbs.setVec2("ft_tile", tw, th);
  thumbs.setInt("ft_cols", cols);
  thumbs.draw(player ? player.time : 0);
  if (atlas2d.width !== W || atlas2d.height !== H) { atlas2d.width = W; atlas2d.height = H; }
  const a = atlas2d.getContext("2d");
  a.drawImage(thumbs.canvas, 0, 0);
  const dw = pv.ar >= THUMB_W / THUMB_H ? THUMB_W : THUMB_H * pv.ar, dh = pv.ar >= THUMB_W / THUMB_H ? THUMB_W / pv.ar : THUMB_H;
  ids.forEach((id, i) => {
    const ctx = app.desk.thumbOf(id).getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, THUMB_W, THUMB_H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(atlas2d, (i % cols) * tw, Math.floor(i / cols) * th, tw, th, (THUMB_W - dw) / 2, (THUMB_H - dh) / 2, dw, dh);
  });
}
// while playing: once a second (a big patch's atlas is a few frames of GPU time)
function thumbTick() {
  if (state.preview && performance.now() - lastThumbs > 1000) drawThumbs();
}
function thumbsSoon() {
  if (player && player.playing) return;
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => drawThumbs(), 120);
}

let wantPlay = true;
function showPlayState() {
  const playing = !!(player && player.playing);
  ui.play.textContent = playing ? "❚❚" : "▶";
  ui.play.setAttribute("aria-label", playing ? "pause" : "play");
}
function togglePlay() {
  if (!player || !state.compiled) return;
  if (player.playing) player.pause(); else player.play();
  wantPlay = player.playing;
  showPlayState();
  if (!player.playing) drawThumbs();
}
function onSlider() {
  state.frac = parseFloat(ui.slider.value);
  if (player && state.compiled) {
    player.pause(); wantPlay = false; showPlayState();
    player.seek(state.frac * player.duration);
    thumbsSoon();
  }
  save();
}

// ------------------------------------------------------------------ opening and saving

function load(patch, name, opts = {}) {
  const v = G.validate(patch);
  if (v.length) throw new Error(v[0]);
  state.patch = patch;
  state.name = name;
  state.undo = []; state.redo = [];
  state.errors.clear();
  state.compiled = null;
  state.preview = null;
  app.desk.selection.clear();
  app.desk.selWire = null;
  app.desk.errors = new Map();
  if (opts.frac !== undefined) { state.frac = opts.frac; ui.slider.value = String(opts.frac); }
  app.desk.fit();
  app.inspector.render();
  if (sourceShown) showSource(true);
  save();
  showUndo();
  document.title = `${baseName()} – Fragtime`;
  return compileNow(true);
}

function findExample(want) {
  const base = want.replace(/\.(can|fragtime)$/i, "");
  return state.examples.find((e) => e.file.replace(/\.can$/, "") === base);
}

async function openExample(want) {
  const base = want.replace(/\.(can|fragtime)$/i, "");
  closeGallery();
  try {
    let patch = null, r = await fetch("examples/" + encodeURIComponent(base + ".fragtime"));
    if (r.ok) patch = G.parse(await r.text());
    else {
      r = await fetch("examples/" + encodeURIComponent(base + ".can"));
      if (!r.ok) throw new Error("no example called " + base);
      patch = importCan(new TextDecoder("latin1").decode(new Uint8Array(await r.arrayBuffer())), base + ".can").patch;
    }
    history.replaceState(null, "", "?x=" + encodeURIComponent(base));
    wantPlay = true;
    await load(patch, base + ".fragtime", { frac: 0 });
    const ex = findExample(base);
    if (ex && ex.description) log(ex.description);
  } catch (e) { log(e.message, "err"); }
}

async function openFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    if (/\.can$|\.txt$/i.test(file.name) || /^\s*(\/\/|<seq|<map)/.test(new TextDecoder("latin1").decode(bytes.slice(0, 200)))) {
      const { patch, warnings } = importCan(new TextDecoder("latin1").decode(bytes), file.name);
      await load(patch, file.name.replace(/\.(can|txt)$/i, "") + ".fragtime", { frac: 0 });
      log(`imported ${file.name} (a QTS script): ${patch.nodes.length} nodes`);
      for (const w of warnings) log(w, "warn");
    } else {
      await load(G.parse(new TextDecoder().decode(bytes)), file.name, { frac: 0 });
    }
    history.replaceState(null, "", location.pathname);
  } catch (e) { log(`${file.name}: ${e.message}`, "err"); }
}

// ------------------------------------------------------------------ the source tab

let sourceShown = false;
function showSource(on) {
  sourceShown = on;
  $("#tabPatch").classList.toggle("on", !on);
  $("#tabSource").classList.toggle("on", on);
  $("#deskWrap").hidden = on;
  $("#sourcePane").hidden = !on;
  $("#palette").style.visibility = on ? "hidden" : "";
  if (on) { $("#sourceText").value = G.serialize(state.patch); $("#sourceErr").textContent = ""; }
  else app.desk.fit();
}
function applySource() {
  try {
    const p = G.parse($("#sourceText").value);
    const v = G.validate(p);
    if (v.length) throw new Error(v[0]);
    app.remember();
    state.patch = p;
    app.desk.selection.clear(); app.desk.selWire = null;
    app.changed();
    $("#sourceErr").textContent = "applied";
  } catch (e) { $("#sourceErr").textContent = e.message; }
}

// ------------------------------------------------------------------ outputs

function download(blob, filename) {
  if (window.qtsDownloadHook) { window.qtsDownloadHook(blob, filename); return; }   // the test harness catches files here
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
}

function frameNow() {
  const g = state.compiled.g, n = Math.max(1, Math.trunc(g.duration * g.fps));
  return Math.min(n - 1, Math.round(state.frac * (n - 1)));
}
function saveFrame() {
  if (!player || !state.compiled) return;
  if (!player.playing) player.draw();
  ui.glview.toBlob((b) => download(b, `${baseName()}_${String(frameNow() + 1).padStart(4, "0")}.png`), "image/png");
}
async function saveShaderHtml() {
  if (!(await compileNow())) return;
  const { g, fileOf } = state.compiled;
  const images = [];
  for (const im of g.images) {
    const file = fileOf.get(im);
    if (!file) continue;
    const type = /\.jpe?g$/i.test(file.name) ? "image/jpeg" : "image/png";
    const dataURL = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob([file.data], { type })); });
    images.push({ name: file.name, dataURL });
  }
  const html = standaloneHTML({ source: shaderText(g), title: baseName(), images, duration: g.duration, width: g.width, height: g.height });
  download(new Blob([html], { type: "text/html" }), baseName() + "_shader.html");
}
async function saveShaderGlsl() {
  if (!(await compileNow())) return;
  download(new Blob([shaderText(state.compiled.g)], { type: "text/plain" }), baseName() + ".glsl");
}

// ---- movies: one draw per frame at the frame's time, into WebCodecs or a zip of PNGs

const evenSize = (n) => n % 2 ? n - 1 : n;
async function pickCodec(w, h) {
  if (typeof VideoEncoder === "undefined") return null;
  const level = w * h > 1920 * 1080 ? "33" : w * h > 1280 * 720 ? "2a" : "1f";
  for (const codec of [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.4200${level}`, "avc1.640028", "avc1.42001f"]) {
    try { const s = await VideoEncoder.isConfigSupported({ codec, width: w, height: h }); if (s.supported) return codec; } catch (_) {}
  }
  return null;
}
const bitrateFor = (w, h, fps) => Math.min(60e6, Math.round(w * h * fps * 0.25));
function formatSecs(s) {
  if (!isFinite(s)) return "?";
  s = Math.round(s);
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}m`
       : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

// opts: {format: "mp4" | "png", first, last (0-based frames), w, h}
async function renderMovie(opts) {
  if (state.movie || !(await compileNow())) return;
  const g = state.compiled.g;
  const fps = g.fps > 0 ? g.fps : 12, nbrFrames = Math.max(1, Math.trunc(g.duration * fps));
  let w = Math.max(2, Math.min(4096, opts.w | 0)), h = Math.max(2, Math.min(4096, opts.h | 0));
  const first = Math.max(0, Math.min(nbrFrames - 1, opts.first)), last = Math.max(first, Math.min(nbrFrames - 1, opts.last));
  const total = last - first + 1;
  let encoder = null, muxer = null, codec = null, zip = null, failed = null;
  if (opts.format === "mp4") {
    w = evenSize(w); h = evenSize(h);
    codec = await pickCodec(w, h);
    if (!codec) { log("This browser can't encode H.264 video (no WebCodecs). Choose PNG frames instead.", "err"); return; }
    muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: "avc", width: w, height: h }, fastStart: "in-memory" });
    encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failed = e; } });
    encoder.configure({ codec, width: w, height: h, bitrate: bitrateFor(w, h, fps), framerate: fps, latencyMode: "quality" });
  } else zip = new ZipWriter();
  const base = baseName();
  state.movie = { cancel: false };
  $("#movieCancel").hidden = false;
  const t0 = performance.now();
  log(`rendering ${total} frame${total === 1 ? "" : "s"} at ${w}×${h}, ${fps} fps → ${opts.format === "mp4" ? "MP4 (" + codec + ")" : "PNG frames"}…`);
  const p = getPlayer(), wasPlaying = p.playing;
  p.pause(); showPlayState();
  p.setSize(w, h);
  let done = 0;
  try {
    for (let f = first; f <= last && !state.movie.cancel && !failed; ++f) {
      p.draw(nbrFrames > 1 ? f / nbrFrames * g.duration : 0);
      const i = f - first;
      if (encoder) {
        while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
        const frame = new VideoFrame(ui.glview, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
        encoder.encode(frame, { keyFrame: i % Math.round(fps * 2) === 0 });
        frame.close();
      } else {
        const blob = await new Promise((r) => ui.glview.toBlob(r, "image/png"));
        zip.add(`${base}_${String(f + 1).padStart(4, "0")}.png`, new Uint8Array(await blob.arrayBuffer()));
      }
      done++;
      const secs = (performance.now() - t0) / 1000;
      setStatus(`frame ${done} of ${total} · ${(done / secs).toFixed(1)} fps · ${formatSecs(secs / done * (total - done))} left`, done / total);
      await new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
    }
  } catch (e) { failed = e; }
  const cancelled = state.movie.cancel;
  state.movie = null;
  $("#movieCancel").hidden = true;
  p.setSize(g.width, g.height);
  p.seek(state.frac * g.duration);
  if (wasPlaying) p.play();
  showPlayState();
  try {
    if (failed) { log("movie: " + failed.message, "err"); setStatus(""); if (encoder) encoder.close(); return; }
    if (cancelled) { log("movie cancelled"); setStatus(""); if (encoder) encoder.close(); return; }
    let blob, filename;
    if (encoder) {
      await encoder.flush(); encoder.close(); muxer.finalize();
      blob = new Blob([muxer.target.buffer], { type: "video/mp4" }); filename = base + ".mp4";
    } else { blob = new Blob([zip.finish()], { type: "application/zip" }); filename = base + "_frames.zip"; }
    log(`${filename}: ${total} frames, ${w}×${h}, ${(blob.size / 1048576).toFixed(1)} MB in ${formatSecs((performance.now() - t0) / 1000)} (the shader)`);
    setStatus(`done: ${filename}`);
    download(blob, filename);
  } catch (e) { log("movie: " + e.message, "err"); setStatus(""); }
}

// A zip of stored (uncompressed) files: PNGs don't compress further
class ZipWriter {
  constructor() { this.parts = []; this.central = []; this.offset = 0; this.crcTable = ZipWriter.table(); }
  static table() {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; ++n) { let c = n; for (let k = 0; k < 8; ++k) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  }
  crc(data) { let c = -1; for (let i = 0; i < data.length; ++i) c = this.crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
  add(name, data) {
    const nameBytes = new TextEncoder().encode(name), crc = this.crc(data);
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

function showMovieDialog() {
  const g = state.compiled.g, n = Math.max(1, Math.trunc(g.duration * g.fps));
  $("#movieInfo").textContent = `${n} frame${n === 1 ? "" : "s"}, ${g.fps} fps (${g.duration} s)`;
  $("#movieW").value = g.width; $("#movieH").value = g.height;
  $("#movieFirst").value = 1; $("#movieLast").value = n;
  $("#movieFirst").max = n; $("#movieLast").max = n;
  const canMp4 = typeof VideoEncoder !== "undefined";
  $("#movieFormat").querySelector('option[value="mp4"]').disabled = !canMp4;
  if (!canMp4) $("#movieFormat").value = "png";
  $("#movieDialog").showModal();
}

// ------------------------------------------------------------------ examples

async function loadExamples() {
  try { state.examples = await (await fetch("examples/index.json")).json(); } catch (_) { state.examples = []; }
  try { state.exampleImages = await (await fetch("examples/images.json")).json(); } catch (_) { state.exampleImages = []; }
  const grid = $("#gallery");
  grid.innerHTML = "";
  for (const ex of state.examples) {
    const base = ex.file.replace(/\.can$/, "");
    const a = document.createElement("a");
    a.href = "?x=" + encodeURIComponent(base);
    a.className = "thumb";
    a.innerHTML = `<img loading="lazy" alt=""><span></span>`;
    a.querySelector("img").src = "examples/thumbs/" + base + ".png";
    a.querySelector("span").textContent = base;
    a.title = ex.description || base;
    a.onclick = (e) => { e.preventDefault(); openExample(base); };
    grid.appendChild(a);
  }
}
function openGallery() { $("#galleryPanel").hidden = false; }
function closeGallery() { $("#galleryPanel").hidden = true; }

// ------------------------------------------------------------------ wiring

function buildPalette() {
  const pal = $("#palette");
  for (const t of TEMPLATES) {
    const b = document.createElement("button");
    b.textContent = t.label;
    b.title = t.tip + (t.ports.length ? " (takes the selected node as its input)" : "");
    b.style.setProperty("--c", `var(${TEMPLATE_COLOR[t.type]})`);
    // a click adds it (after the selection); a drag places it
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      let ghost = null;
      const move = (ev) => {
        if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) {
          ghost = document.createElement("div");
          ghost.className = "ghost";
          ghost.textContent = t.label;
          document.body.appendChild(ghost);
        }
        if (ghost) { ghost.style.left = ev.clientX - 40 + "px"; ghost.style.top = ev.clientY - 12 + "px"; }
      };
      const up = (ev) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (!ghost) { app.addTemplate(t); return; }
        ghost.remove();
        const r = $("#deskWrap").getBoundingClientRect();
        if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
        const p = app.desk.toPatch(ev);
        app.addTemplate(t, { x: p.x - 60, y: p.y - 20 });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    pal.appendChild(b);
  }
}

function wire() {
  ui.slider.addEventListener("input", onSlider);
  ui.play.onclick = togglePlay;
  ui.glview.onclick = togglePlay;
  ui.oversample.onchange = () => compileNow(true);
  $("#undo").onclick = undo;
  $("#redo").onclick = redo;
  $("#zoomIn").onclick = () => app.desk.zoomCentre(1.25);
  $("#zoomOut").onclick = () => app.desk.zoomCentre(1 / 1.25);
  $("#zoomFit").onclick = () => app.desk.fit();
  $("#tabPatch").onclick = () => showSource(false);
  $("#tabSource").onclick = () => showSource(true);
  $("#applySource").onclick = applySource;
  $("#tips").onclick = () => $("#tipsDialog").showModal();
  $("#tipsClose").onclick = () => $("#tipsDialog").close();
  $("#help").onclick = () => window.open("language.html", "_blank");
  $("#savePng").onclick = saveFrame;
  $("#saveShaderHtml").onclick = () => saveShaderHtml().catch((e) => log("save: " + e.message, "err"));
  $("#saveShaderGlsl").onclick = () => saveShaderGlsl().catch((e) => log("save: " + e.message, "err"));
  $("#movie").onclick = async () => { if (await compileNow()) showMovieDialog(); };
  $("#movieCancel").onclick = () => { if (state.movie) state.movie.cancel = true; };
  $("#movieClose").onclick = () => $("#movieDialog").close();
  $("#movieGo").onclick = () => {
    $("#movieDialog").close();
    const g = state.compiled.g, n = Math.max(1, Math.trunc(g.duration * g.fps)), all = $("#movieAll").checked;
    renderMovie({ format: $("#movieFormat").value, w: parseInt($("#movieW").value, 10) || g.width, h: parseInt($("#movieH").value, 10) || g.height,
      first: all ? 0 : parseInt($("#movieFirst").value, 10) - 1, last: all ? n - 1 : parseInt($("#movieLast").value, 10) - 1 });
  };
  $("#gallery-open").onclick = openGallery;
  $("#galleryClose").onclick = closeGallery;
  $("#new").onclick = () => { wantPlay = true; load(NEW_PATCH(), "untitled.fragtime", { frac: 0 }); history.replaceState(null, "", location.pathname); };
  $("#open").onclick = () => $("#openFile").click();
  $("#openFile").onchange = async (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) await openFile(f); };
  $("#save").onclick = () => download(new Blob([G.serialize(state.patch)], { type: "application/json" }), baseName() + ".fragtime");
  $("#images").onclick = () => $("#imageFiles").click();
  $("#imageFiles").onchange = async (e) => {
    for (const f of e.target.files) {
      state.userImages.set(f.name.toLowerCase(), { name: f.name, data: await f.arrayBuffer() });
      log(`image ${f.name} added: pick it in an Image node`);
    }
    e.target.value = "";
    app.inspector.render();
    compileNow(true);
  };
  // files dropped on the page: a patch or a QTS script opens, images are added
  window.addEventListener("dragover", (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
  window.addEventListener("drop", async (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    for (const f of e.dataTransfer.files) {
      if (/^image\//.test(f.type) || /\.(png|jpe?g|gif|bmp|webp)$/i.test(f.name)) {
        state.userImages.set(f.name.toLowerCase(), { name: f.name, data: await f.arrayBuffer() });
        log(`image ${f.name} added: pick it in an Image node`);
        app.inspector.render();
        compileNow(true);
      } else await openFile(f);
    }
  });
  const typing = () => { const a = document.activeElement; return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT"); };
  window.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "Enter") { e.preventDefault(); compileNow(true); return; }
    if (e.key === "Escape") { closeGallery(); if (!typing() && (app.desk.selection.size || app.desk.selWire)) { app.desk.selection.clear(); app.desk.selWire = null; app.select(); } return; }
    if (typing() || sourceShown) return;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); app.duplicateSelection(); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); app.deleteSelection(); }
  });
}

async function start() {
  app.desk = new Desk($("#deskWrap"), app);
  app.inspector = new Inspector($("#inspector"), app);
  buildPalette();
  wire();
  showUndo();
  if (!haveGPU()) setStatus("this browser has no WebGL2: Fragtime needs it");
  await loadExamples();
  const want = new URLSearchParams(location.search).get("x");
  if (want) return openExample(want);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORAGE) || "null"); } catch (_) {}
  if (saved && saved.patch) {
    try { await load(G.parse(saved.patch), saved.name || "untitled.fragtime", { frac: saved.frac || 0 }); return; }
    catch (e) { log("the saved patch didn't load: " + e.message, "warn"); }
  }
  await openExample(FIRST_EXAMPLE);
}

window.fragtime = { app, state, compileNow, drawThumbs, get player() { return player; }, get thumbs() { return thumbs; } };   // for the tests and the console
start();
