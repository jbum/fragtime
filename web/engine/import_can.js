// import_can.js -- turns a QTS script (.can, the <seq> tree) into a Fragtime patch whose graph
// means the same: graph_glsl.js compiles the patch to a shader that draws what glsl.js draws
// for the script (tests/import_test.js checks every example).
//
// A leaf <seq> becomes a formula node with the properties it had after inheritance; a <seq>
// with children becomes a Sequence painting them in order; $name becomes a wire into a port
// called name. A leaf that a later sibling paints over completely, and that other leaves read,
// isn't painted (QTS painted it, then hid it): it appears once, wired to its readers. A
// sequence of one input is folded away. Lifetimes are written relative to whoever pulls the
// node, so a node read from two lifetimes that disagree is copied (rare).

import { Script } from "./seq.js";
import { Parser } from "./expr.js";
import { CHOP, CM } from "./seq.js";
import * as G from "./graph.js";

const EXP_PARAMS = [["left", "left", "0"], ["top", "top", "0"], ["width", "width", "1"], ["height", "height", "w*fh/fw"],
  ["zoomFac", "zoom", "1.0"], ["zoomFunc", "zoomfunc", "t"], ["endWidth", "endwidth", ""], ["min", "min", "0"],
  ["max", "max", "1"], ["recurse", "recurse", "64"], ["p0", "p0", "0"], ["q0", "q0", "0"]];
const CHOP_NAMES = Object.fromEntries(Object.entries(CHOP).map(([k, v]) => [v, k]));

// Script.load wants every image; the importer only needs the names
class AnyImages extends Map {
  get(k) { return super.get(k) || { width: 1, height: 1, placeholder: true, name: k }; }
}

const NUM_RE = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
// a number as short as it can be written without an exponent (the language has none)
function tidy(s) {
  s = String(s).trim();
  if (!NUM_RE.test(s)) return s;
  const t = String(parseFloat(s));
  return /e/i.test(t) ? s : t;
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

// the $names an expression reads, and whether it uses the image
function scan(src) {
  const names = new Map();
  let tree = null;
  try { tree = new Parser(src, names).parse(); } catch (_) { return { names: [], image: false }; }
  let image = false;
  const walk = (n) => {
    if (!n) return;
    if (n.kind === "charvar") image = true;
    if (n.kind === "var" && /V\.image/.test(n.code)) image = true;
    if (n.kind === "op" && /^(red|green|blue|sampleN|sampleN2|sampleP|sampleP2)$/.test(n.code)) image = true;
    for (const a of n.args || []) walk(a);
  };
  walk(tree);
  return { names: [...names.keys()], image };
}

function balanced(s) {
  let d = 0;
  for (const c of s) { if (c === "(") d++; else if (c === ")" && --d < 0) return false; }
  return d === 0;
}

// Imports .can text. Returns {patch, warnings}; throws Error with the script's first error.
export function importCan(text, name = "untitled.can") {
  const script = new Script();
  if (!script.load(text, new AnyImages())) throw new Error(script.errors[0] || "the script didn't load");
  const warnings = [...script.warnings];
  const root = script.main, rp = root.p;
  const fps = rp.frameRate;

  const all = [];
  const parentOf = new Map();
  const walk = (s) => { all.push(s); for (const c of s.children) { parentOf.set(c, s); walk(c); } };
  walk(root);
  const isLeaf = (s) => s.children.length === 0;
  const ownId = (s) => s.props.some((p) => p.id === "id") ? s.p.idName : "";
  const lastFlag = (s) => s.props.some((p) => p.id === "debut" && !p.isString && p.num === -1);
  const G0 = (s) => s.p.globalDebut, D = (s) => s.p.duration;

  // what each sequence reads (as a formula: a leaf, or a parent read through $name)
  const scans = new Map();
  const scanOf = (s) => {
    if (!scans.has(s)) {
      const names = new Set(); let image = false;
      for (const key of ["pix", ...EXP_PARAMS.map((e) => e[0])]) {
        const src = s.p.exps[key];
        if (!src) continue;
        const r = scan(src);
        r.names.forEach((n) => names.add(n));
        if (r.image) image = true;
      }
      scans.set(s, { names: [...names], image });
    }
    return scans.get(s);
  };
  const resolve = (nm) => { const id = script.seqNames.get(nm); return id ? script.seqByID[id - 1] || null : null; };
  const referenced = new Set();
  for (const s of all) if (isLeaf(s)) for (const nm of scanOf(s).names) { const t = resolve(nm); if (t) referenced.add(t); }

  // the inputs a parent paints
  const entriesOf = new Map();
  for (const s of all) {
    if (isLeaf(s)) continue;
    const kids = s.children, keep = [];
    kids.forEach((c, i) => {
      if (!isLeaf(c)) { keep.push(c); return; }
      if (c.isMap) return;
      const hidden = kids.slice(i + 1).some((o) => isLeaf(o) && !o.isMap && o.p.channelOp === CHOP.normal &&
        G0(o) <= G0(c) + 1e-9 && G0(o) + D(o) >= G0(c) + D(c) - 1e-9);
      if (hidden && referenced.has(c)) return;
      keep.push(c);
    });
    entriesOf.set(s, keep);
  }

  // instances: (kind, seq) -> contexts {rel, parentDur, last}
  const ctxs = new Map();     // key -> {kind, seq, list: []}
  const keyOf = (kind, s) => kind + ":" + all.indexOf(s);
  const addCtx = (kind, s, c) => {
    const k = keyOf(kind, s);
    if (!ctxs.has(k)) ctxs.set(k, { kind, seq: s, list: [] });
    const e = ctxs.get(k);
    if (!e.list.some((o) => near(o.rel, c.rel) && near(o.parentDur, c.parentDur) && o.last === c.last && o.via === c.via)) e.list.push(c);
  };
  const seen = new Set();
  const visit = (kind, s) => {
    const k = keyOf(kind, s);
    if (seen.has(k)) return;
    seen.add(k);
    if (kind === "seq") {
      const es = entriesOf.get(s);
      es.forEach((c, i) => {
        const prevRaw = s.children[s.children.indexOf(c) - 1];
        const last = lastFlag(c) && (i === 0 ? !prevRaw : prevRaw === es[i - 1]);
        const ck = isLeaf(c) ? "formula" : "seq";
        addCtx(ck, c, { rel: G0(c) - G0(s), parentDur: D(s), last, via: "entry" });
        visit(ck, c);
      });
    } else {
      for (const nm of scanOf(s).names) {
        const t = resolve(nm);
        if (!t) continue;
        addCtx("formula", t, { rel: G0(t) - G0(s), parentDur: D(s), last: false, via: "wire" });
        visit("formula", t);
      }
    }
  };
  const rootKind = isLeaf(root) ? "formula" : "seq";
  addCtx(rootKind, root, { rel: 0, parentDur: D(root), last: false, via: "entry" });
  visit(rootKind, root);

  // nodes: one per (kind, seq, rel)
  const patch = { fragtime: 1, title: name.replace(/\.can$/i, ""), nodes: [] };
  const notes = [];
  for (const line of text.split(/\r?\n/)) { const m = /^\s*\/\/\s?(.*)$/.exec(line); if (m) notes.push(m[1]); else if (line.trim()) break; }
  if (notes.length) patch.notes = notes.join("\n");
  const inst = new Map();          // key + "@" + rel -> node
  const instKey = (kind, s, rel) => keyOf(kind, s) + "@" + Math.round(rel * 1e9);
  const used = new Set(["out"]);
  const freshId = (base) => {
    base = base.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z]/, "n");
    if (!used.has(base)) { used.add(base); return base; }
    for (let i = 2; ; ++i) if (!used.has(base + "_" + i)) { used.add(base + "_" + i); return base + "_" + i; }
  };
  let layerN = 0, seqN = 0;
  const pending = [];
  for (const [, e] of ctxs) {
    const s = e.seq;
    const groups = [];
    for (const c of e.list) { let g = groups.find((q) => near(q.rel, c.rel)); if (!g) groups.push((g = { rel: c.rel, list: [] })); g.list.push(c); }
    for (const g of groups) {
      let base = ownId(s);
      if (e.kind === "seq") base = base ? (ctxs.has(keyOf("formula", s)) ? base + "_seq" : base) : (s === root ? "main" : "seq" + ++seqN);
      else if (!base) base = "layer" + ++layerN;
      const node = { id: freshId(base), type: e.kind === "seq" ? "sequence" : "source", x: 0, y: 0, inputs: {}, params: {} };
      if (g.list.every((c) => c.via === "entry" && c.last) ) node.params.debut = "last";
      else if (!near(g.rel, 0)) node.params.debut = +g.rel.toFixed(9);
      if (!g.list.every((c) => near(c.parentDur, D(s)))) node.params.duration = +D(s).toFixed(9);
      inst.set(instKey(e.kind, s, g.rel), node);
      patch.nodes.push(node);
      pending.push({ node, kind: e.kind, seq: s });
    }
  }
  const instFor = (kind, s, rel) => inst.get(instKey(kind, s, rel)) || null;

  // parameters and wires
  for (const { node, kind, seq: s } of pending) {
    const p = s.p;
    if (kind === "seq") {
      const es = entriesOf.get(s);
      const modes = {};
      es.forEach((c, i) => {
        const n = instFor(isLeaf(c) ? "formula" : "seq", c, G0(c) - G0(s));
        node.inputs["s" + (i + 1)] = n ? n.id : null;
        if (isLeaf(c) && c.p.channelOp !== CHOP.normal) modes["s" + (i + 1)] = CHOP_NAMES[c.p.channelOp];
      });
      if (Object.keys(modes).length) node.params.modes = modes;
      continue;
    }
    // colour
    const pix = p.exps.pix;
    if (p.colormode === CM.MONO) node.params.mono = pix;
    // hsv="…" and rgb="…" were compiled as triple(…): undo exactly that, balanced or not, so the
    // patch compiles the very same text
    else if (p.colormode === CM.HSV && /^triple\(/.test(pix) && pix.endsWith(")")) node.params.hsv = pix.slice(7, -1);
    else if (p.colormode === CM.RGB && /^triple\(/.test(pix) && pix.endsWith(")") && balanced(pix.slice(7, -1))) node.params.rgb = pix.slice(7, -1);
    else if (p.colormode === CM.HSV) { node.params.hsv = pix; warnings.push(`${node.id}: an hsv expression that isn't a triple`); }
    else node.params.pix = pix;
    for (const [key, param, def] of EXP_PARAMS) {
      const v = p.exps[key];
      if (v === undefined || v === null) continue;
      if (tidy(v) !== tidy(def)) node.params[param] = tidy(v);
    }
    for (const b of ["center", "tile", "wrap", "cycle"]) if (p[b]) node.params[b] = true;
    if (p.oversample !== rp.oversample) node.params.oversample = !!p.oversample;
    const sc = scanOf(s);
    if (sc.image && p.srcName) node.params.image = p.srcName;
    if (p.frameRate !== fps) warnings.push(`${node.id}: frame rate ${p.frameRate} differs from the script's ${fps}; the patch uses ${fps}`);
    for (const nm of sc.names) {
      const t = resolve(nm);
      const n = t ? instFor("formula", t, G0(t) - G0(s)) : null;
      node.inputs[nm] = n ? n.id : null;
    }
    node.type = Object.keys(node.inputs).length ? "expr" : node.params.image ? "image" : "source";
  }
  const rootNode = instFor(rootKind, root, 0);
  const out = { id: "out", type: "output", x: 0, y: 0, inputs: { in: rootNode ? rootNode.id : null },
    params: { width: script.frameWidth, height: script.frameHeight, fps, duration: +script.duration.toFixed(9), oversample: !!rp.oversample } };
  patch.nodes.push(out);

  foldSequences(patch);
  layout(patch);
  return { patch, warnings };
}

// A sequence that paints one input, normally, is that input: wires into it go to the input,
// which takes over the sequence's lifetime when it has none of its own and nothing else uses it.
function foldSequences(patch) {
  const lifeless = (n) => n.params.debut === undefined && n.params.duration === undefined;
  for (let changed = true; changed;) {
    changed = false;
    for (const s of patch.nodes) {
      if (s.type !== "sequence") continue;
      const ports = G.portsOf(s);
      if (ports.length !== 1 || (s.params.modes && s.params.modes[ports[0]])) continue;
      const eid = s.inputs[ports[0]];
      const e = patch.nodes.find((n) => n.id === eid);
      if (!e || !lifeless(e)) continue;
      const users = patch.nodes.filter((n) => Object.values(n.inputs).includes(eid));
      if (!lifeless(s) && users.length > 1) continue;
      for (const k of ["debut", "duration"]) if (s.params[k] !== undefined) e.params[k] = s.params[k];
      for (const n of patch.nodes) for (const k of Object.keys(n.inputs)) if (n.inputs[k] === s.id) n.inputs[k] = eid;
      patch.nodes.splice(patch.nodes.indexOf(s), 1);
      changed = true;
      break;
    }
  }
}

// Columns by distance from the Output (inputs to the left); rows as a tidy tree: the nodes
// reached first from the Output take the next free row, and a node sits beside the middle of
// its inputs, so each slice of a sequence keeps its inputs around it.
export function layout(patch, colW = 250, rowH = 130) {
  const byId = G.nodeById(patch), out = G.outputNode(patch);
  const rank = new Map();
  const ranked = (n, r, stack) => {
    if ((rank.get(n.id) ?? -1) >= r || stack.has(n.id)) return;
    rank.set(n.id, r);
    stack.add(n.id);
    for (const p of G.portsOf(n)) { const m = byId.get(n.inputs[p]); if (m) ranked(m, r + 1, stack); }
    stack.delete(n.id);
  };
  if (out) ranked(out, 0, new Set());
  for (const n of patch.nodes) if (!rank.has(n.id)) rank.set(n.id, 1);
  const maxRank = Math.max(...rank.values());
  const ys = new Map();
  let cursor = 0;
  const place = (n) => {
    if (ys.has(n.id)) return ys.get(n.id);
    ys.set(n.id, null);        // in progress
    const kids = [];
    for (const p of G.portsOf(n)) {
      const m = byId.get(n.inputs[p]);
      if (m && !ys.has(m.id)) { const y = place(m); if (y !== null) kids.push(y); }
    }
    let y;
    if (kids.length) y = (Math.min(...kids) + Math.max(...kids)) / 2;
    else { y = cursor; cursor += rowH; }
    ys.set(n.id, y);
    return y;
  };
  if (out) place(out);
  for (const n of patch.nodes) if (!ys.has(n.id) || ys.get(n.id) === null) { ys.set(n.id, cursor); cursor += rowH; }
  for (const n of patch.nodes) { n.x = (maxRank - rank.get(n.id)) * colW; n.y = Math.round(ys.get(n.id)); }
  // no overlaps within a column (tall sequence nodes push the rest down)
  const cols = new Map();
  for (const n of patch.nodes) { if (!cols.has(n.x)) cols.set(n.x, []); cols.get(n.x).push(n); }
  for (const list of cols.values()) {
    list.sort((a, b) => a.y - b.y);
    let bottom = -Infinity;
    for (const n of list) {
      if (n.y < bottom + 20) n.y = Math.round(bottom + 20);
      bottom = n.y + Math.max(110, 32 + G.portsOf(n).length * 16);
    }
  }
}
