// graph.js -- the Fragtime patch: a DAG of nodes wired into one Output, saved as JSON.
// Works in node (tests, the importer) and in the browser.
//
// A patch: { fragtime: 1, title, nodes: [{ id, type, x, y, inputs: {port: nodeId|null}, params: {...} }] }
//
// Every node is a picture: a function of x, y and t. Formula nodes (source, image, expr) are
// what a QTS <seq> leaf was: a colour expression over a field, pinned by min/max; their input
// ports are the $names their expressions read. Sequence paints its inputs (ports s1..sN, in
// order) while each is alive, with a blend mode per input; Blend is b over a; Time plays its
// input at another time; Output is the frame.
//
// Lifetime: any node may have `debut` (seconds, or "last": after the previous input of the
// Sequence it is painted in) and `duration` (seconds; else the caller's), relative to the
// lifetime of whatever pulls it. A node without them shares its caller's.

export const FORMULA_TYPES = ["source", "image", "expr"];
export const COLOR_KEYS = ["pix", "rgb", "hsv", "mono"];
export const BLEND_MODES = ["normal", "multiply", "screen", "overlay", "lighten", "darken", "difference",
  "exclusion", "softlight", "hardlight"];

// Formula parameters: key, default (as the expression text QTS used), kind
export const FORMULA_PARAMS = [
  { key: "left", def: "0", kind: "expr", group: "field" },
  { key: "top", def: "0", kind: "expr", group: "field" },
  { key: "width", def: "1", kind: "expr", group: "field" },
  { key: "height", def: "w*fh/fw", kind: "expr", group: "field" },
  { key: "center", def: false, kind: "bool", group: "field" },
  { key: "zoom", def: "1.0", kind: "expr", group: "zoom" },
  { key: "zoomfunc", def: "t", kind: "expr", group: "zoom" },
  { key: "endwidth", def: "", kind: "expr", group: "zoom" },
  { key: "min", def: "0", kind: "expr", group: "range" },
  { key: "max", def: "1", kind: "expr", group: "range" },
  { key: "wrap", def: false, kind: "bool", group: "range" },
  { key: "cycle", def: false, kind: "bool", group: "range" },
  { key: "image", def: "", kind: "text", group: "image" },
  { key: "tile", def: false, kind: "bool", group: "image" },
  { key: "recurse", def: "64", kind: "expr", group: "fractal" },
  { key: "p0", def: "0", kind: "expr", group: "fractal" },
  { key: "q0", def: "0", kind: "expr", group: "fractal" },
  { key: "oversample", def: null, kind: "bool", group: "render" },   // null: the Output's
];
export const LIFETIME_PARAMS = [
  { key: "debut", def: "", kind: "time" },
  { key: "duration", def: "", kind: "time" },
];

export const NODE_TYPES = {
  source: { label: "Source", formula: true, ports: "named" },
  image: { label: "Image", formula: true, ports: "named" },
  expr: { label: "Expression", formula: true, ports: "named" },
  sequence: { label: "Sequence", ports: "ordered" },
  blend: { label: "Blend", ports: ["a", "b"], params: [{ key: "mode", def: "screen", kind: "mode" }] },
  time: { label: "Time", ports: ["in"], params: [{ key: "time", def: "t*dur", kind: "expr" }, { key: "loop", def: "", kind: "time" }] },
  output: { label: "Output", ports: ["in"], params: [
    { key: "width", def: 320, kind: "int" }, { key: "height", def: 240, kind: "int" },
    { key: "fps", def: 24, kind: "number" }, { key: "duration", def: 4, kind: "number" },
    { key: "oversample", def: true, kind: "bool" }] },
};

export class GraphError extends Error {}

export const ID_RE = /^[A-Za-z][A-Za-z0-9_]*$/;     // what $name accepts

export function isFormula(node) { return FORMULA_TYPES.includes(node.type); }

// the colour parameter a formula node uses: [key, expression]
export function colorParam(node) {
  for (const k of COLOR_KEYS) if (node.params && typeof node.params[k] === "string") return [k, node.params[k]];
  return ["pix", "RGB(x,y,x+y)"];
}

// a formula parameter's value, or its default
export function formulaParam(node, key) {
  const v = node.params ? node.params[key] : undefined;
  if (v !== undefined && v !== null && v !== "") return v;
  const spec = FORMULA_PARAMS.find((p) => p.key === key);
  return spec ? spec.def : undefined;
}

// the ordered ports of a node (for a sequence: s1, s2, … by number)
export function portsOf(node) {
  const t = NODE_TYPES[node.type];
  if (!t) return [];
  if (Array.isArray(t.ports)) return t.ports;
  const keys = Object.keys(node.inputs || {});
  if (t.ports === "ordered") return keys.filter((k) => /^s\d+$/.test(k)).sort((a, b) => +a.slice(1) - +b.slice(1));
  return keys;
}

export function nodeById(patch) {
  const m = new Map();
  for (const n of patch.nodes) m.set(n.id, n);
  return m;
}

export function outputNode(patch) { return patch.nodes.find((n) => n.type === "output") || null; }

// a fresh id from a base name
export function newId(patch, base) {
  base = (base || "node").replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z]/, "n");
  const used = new Set(patch.nodes.map((n) => n.id));
  if (!used.has(base)) return base;
  for (let i = 2; ; ++i) if (!used.has(base + i)) return base + i;
}

// Checks a patch; returns a list of problems (empty when it is fine). Throws nothing.
export function validate(patch) {
  const errs = [];
  if (!patch || !Array.isArray(patch.nodes)) return ["not a Fragtime patch (no nodes)"];
  const byId = new Map();
  for (const n of patch.nodes) {
    if (!n || typeof n.id !== "string" || !ID_RE.test(n.id)) { errs.push(`bad node id ${JSON.stringify(n && n.id)}`); continue; }
    if (byId.has(n.id)) errs.push(`two nodes are called ${n.id}`);
    byId.set(n.id, n);
    if (!NODE_TYPES[n.type]) errs.push(`${n.id}: unknown type ${n.type}`);
  }
  const outs = patch.nodes.filter((n) => n.type === "output");
  if (outs.length !== 1) errs.push(outs.length ? "more than one Output" : "no Output node");
  for (const n of patch.nodes) {
    for (const [port, src] of Object.entries(n.inputs || {})) {
      if (!ID_RE.test(port)) errs.push(`${n.id}: bad port name ${port}`);
      if (src !== null && src !== undefined && !byId.has(src)) errs.push(`${n.id}.${port}: no node called ${src}`);
      if (src && byId.get(src) && byId.get(src).type === "output") errs.push(`${n.id}.${port}: the Output can't be an input`);
    }
  }
  const cyc = findCycle(patch);
  if (cyc) errs.push(`a cycle: ${cyc.join(" → ")} (a shader can't recurse)`);
  return errs;
}

// the first cycle found, as a list of ids, or null
export function findCycle(patch) {
  const byId = nodeById(patch), state = new Map();
  let found = null;
  const visit = (n, stack) => {
    if (found) return;
    const s = state.get(n.id);
    if (s === 2) return;
    if (s === 1) { found = stack.slice(stack.indexOf(n.id)).concat(n.id); return; }
    state.set(n.id, 1);
    for (const src of Object.values(n.inputs || {})) { const m = src && byId.get(src); if (m) visit(m, stack.concat(n.id)); }
    state.set(n.id, 2);
  };
  for (const n of patch.nodes) visit(n, []);
  return found;
}

// nodes in an order where every node comes after its inputs; only those reachable from the
// Output unless all is set
export function topoOrder(patch, all = false) {
  const byId = nodeById(patch), done = new Set(), order = [];
  const visit = (n) => {
    if (done.has(n.id)) return;
    done.add(n.id);
    for (const src of Object.values(n.inputs || {})) { const m = src && byId.get(src); if (m) visit(m); }
    order.push(n);
  };
  const out = outputNode(patch);
  if (out) visit(out);
  if (all) for (const n of patch.nodes) visit(n);
  return order;
}

// Renames a node, rewriting the wires that name it. (Ports keep their names: an expression
// reads $port, and the port is the consumer's to name.)
export function renameNode(patch, oldId, newIdText) {
  if (!ID_RE.test(newIdText)) throw new GraphError(`"${newIdText}" isn't a name (letters, digits, _)`);
  if (patch.nodes.some((n) => n.id === newIdText)) throw new GraphError(`there is already a ${newIdText}`);
  for (const n of patch.nodes) {
    if (n.id === oldId) n.id = newIdText;
    for (const k of Object.keys(n.inputs || {})) if (n.inputs[k] === oldId) n.inputs[k] = newIdText;
  }
}

// Renames a port of a formula node and the $references to it in the node's expressions.
export function renamePort(node, oldPort, newPort) {
  if (!ID_RE.test(newPort)) throw new GraphError(`"${newPort}" isn't a name`);
  if (node.inputs && newPort in node.inputs) throw new GraphError(`${node.id} already has a port ${newPort}`);
  const inputs = {};
  for (const [k, v] of Object.entries(node.inputs || {})) inputs[k === oldPort ? newPort : k] = v;
  node.inputs = inputs;
  const re = new RegExp("\\$" + oldPort + "(?![A-Za-z0-9_])", "g");
  for (const k of Object.keys(node.params || {})) if (typeof node.params[k] === "string") node.params[k] = node.params[k].replace(re, "$" + newPort);
}

// the $names an expression mentions (not inside strings; good enough for wiring hints)
export function refsIn(text) {
  const out = new Set();
  const re = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(text || ""))) out.add(m[1]);
  return [...out];
}

// The JSON text of a patch: one line per node, so files diff well.
export function serialize(patch) {
  const head = { fragtime: 1 };
  for (const [k, v] of Object.entries(patch)) if (k !== "nodes" && k !== "fragtime") head[k] = v;
  const lines = patch.nodes.map((n) => {
    const o = { id: n.id, type: n.type, x: Math.round(n.x || 0), y: Math.round(n.y || 0) };
    if (n.inputs && Object.keys(n.inputs).length) o.inputs = n.inputs;
    if (n.params && Object.keys(n.params).length) o.params = n.params;
    return "    " + JSON.stringify(o);
  });
  const h = JSON.stringify(head);
  return h.slice(0, -1) + `,\n  "nodes": [\n${lines.join(",\n")}\n  ]\n}\n`;
}

export function parse(text) {
  let p;
  try { p = JSON.parse(text); } catch (e) { throw new GraphError("not JSON: " + e.message); }
  if (!p || !Array.isArray(p.nodes)) throw new GraphError("not a Fragtime patch (no nodes)");
  for (const n of p.nodes) { n.inputs = n.inputs || {}; n.params = n.params || {}; n.x = +n.x || 0; n.y = +n.y || 0; }
  return p;
}

export function clone(patch) { return JSON.parse(JSON.stringify(patch)); }

// the info line the editor shows
export function patchInfo(patch) {
  const o = outputNode(patch), p = (o && o.params) || {};
  const num = (k) => { const v = p[k]; const d = NODE_TYPES.output.params.find((q) => q.key === k).def; return v === undefined || v === "" ? d : +v; };
  const fps = num("fps"), duration = num("duration");
  return { duration, frameRate: fps, frames: Math.trunc(duration * fps), width: num("width") | 0, height: num("height") | 0,
    oversample: p.oversample === undefined ? true : !!p.oversample };
}
