// graph_glsl.js -- compiles a Fragtime patch (graph.js) to a GLSL ES 3.00 fragment shader in
// Shadertoy's dialect, like glsl.js does for a QTS script, and with the same library and
// expression generator, so an imported script renders the same pixels.
//
// Every node gets functions of a clock (Clk: the time, and the start and length of the node's
// own lifetime) and of the pixel:
//   formula nodes  ft_ctxK (its properties at that time), ft_pixK, ft_pinK, ft_layerK (painted,
//                  oversampled), ft_sampK (read through a wire: $name)
//   other nodes    ft_paintK (paints onto the canvas it is given), ft_sampK
// A caller works out the clock of what it pulls: its own clock shifted by the input's debut,
// with the input's duration (or its own). GLSL has no recursion, so nodes are emitted inputs
// first and a cycle is an error.

import { Parser, ExprError } from "./expr.js";
import { Gen, f, libraryText, sampleArgs, GLSLError } from "./glsl.js";
import { CHOP, CM } from "./seq.js";
import * as G from "./graph.js";

export class NodeError extends GLSLError {
  constructor(nodeId, key, message) { super(`${nodeId}${key ? "." + key : ""}: ${message}`); this.nodeId = nodeId; this.key = key; this.detail = message; }
}

// formula parameter -> the property glsl.js / seq.js call it
const PROPS = [["left", "left"], ["top", "top"], ["width", "width"], ["height", "height"], ["zoomFac", "zoom"],
  ["zoomFunc", "zoomfunc"], ["min", "min"], ["max", "max"], ["recurse", "recurse"], ["p0", "p0"], ["q0", "q0"],
  ["endWidth", "endwidth"]];

const PIXARGS = "float px, float py, float fw, float fh";

function timeNumber(v) {
  if (v === undefined || v === null || v === "" || v === "last") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return isFinite(n) ? n : null;
}

export class GraphCompiler {
  // images: Map name -> Image (engine/image.js); opts.all compiles every node, not only those
  // the Output reaches (thumbnails), opts.preview adds a uniform ft_node that picks the node shown
  constructor(patch, images, opts = {}) {
    this.patch = patch;
    this.imageMap = images || new Map();
    this.opts = opts;
    this.used = new Set();
    this.salt = 1;
    this.images = [];
    this.warnings = [];
    this.byId = G.nodeById(patch);
    this.index = new Map();      // node -> k
    this.output = G.outputNode(patch);
    this.info = G.patchInfo(patch);
  }
  use(name) {
    if (this.used.has(name)) return;
    this.used.add(name);
    for (const d of LIB_DEPS(name)) this.use(d);
  }
  warn(m) { if (!this.warnings.includes(m)) this.warnings.push(m); }
  imageUnit(img) {
    let i = this.images.indexOf(img);
    if (i < 0) {
      if (this.images.length >= 4) throw new GLSLError("a shader can use at most four images");
      i = this.images.length; this.images.push(img);
    }
    return "iChannel" + i;
  }
  findImage(name) {
    if (!name) return null;
    const base = name.replace(/\.[^.]*$/, "");
    for (const k of [name, name.toLowerCase(), base + ".png", base.toLowerCase() + ".png"]) {
      const im = this.imageMap.get(k);
      if (im) return im;
    }
    return null;
  }

  // a $port reference from a formula node's expression
  sampleCall(gen, node, a) {
    const target = gen.seq.targets[node.id - 1];
    if (!target) {
      const name = [...gen.seq.portMap.entries()].find(([, v]) => v === node.id);
      this.warn(`${gen.seq.node.id}: $${name ? name[0] : "?"} isn't wired (black)`);
      return gen.vec("vec3(0.0)");
    }
    const lt = this.lifetime(target, "c.start", "c.dur", null);
    return gen.vec(sampleArgs(`ft_samp${this.index.get(target)}(Clk(c.gtime,${lt.start},${lt.dur}),c,`, node.code, a));
  }

  // the start and length of node's lifetime, as GLSL, given its caller's (s, d) and, inside a
  // sequence, where the previous input ended (for debut="last")
  lifetime(node, s, d, lastEnd) {
    const p = node.params || {};
    let start = s;
    if (p.debut === "last") start = lastEnd || s;
    else { const v = timeNumber(p.debut); if (v) start = `${s}+${f(v)}`; }
    const dv = timeNumber(p.duration);
    return { start, dur: dv !== null && dv > 0 ? f(dv) : d };
  }

  parseExpr(gen, node, key, src) {
    let tree;
    try { tree = new Parser(src, gen.seq.portMap).parse(); }
    catch (e) { if (e instanceof ExprError) throw new NodeError(node.id, key, `${e.message} in "${src}"`); throw e; }
    gen.seq.targets = [...gen.seq.portMap.keys()].map((k) => { const src = (node.inputs || {})[k]; return src ? this.byId.get(src) || null : null; });
    return tree;
  }
  propCode(gen, node, key, src) {
    if (src === undefined || src === null || src === "") return null;
    const tree = this.parseExpr(gen, node, key, String(src));
    if (!tree) return "0.0";
    let r;
    try { r = gen.gen(tree); } catch (e) { if (e instanceof GLSLError && !(e instanceof NodeError)) throw new NodeError(node.id, key, e.message); throw e; }
    return r.v ? `(${r.c}).x` : r.c;
  }

  newGen(node, image, tile) {
    const portMap = new Map(Object.keys(node.inputs || {}).map((k, i) => [k, i + 1]));
    const pseudo = { p: { image, tile }, node, portMap, targets: [] };
    return new Gen(this, pseudo);
  }

  // the context function of a node: its properties at a clock (formula params, or the defaults)
  ctxFunction(k, node, gen, params) {
    const props = {};
    for (const [prop, key] of PROPS) props[prop] = this.propCode(gen, node, key, params(key));
    const pre = gen.pre.splice(0);
    const fd = this.fixedDuration(node), fps = this.fps;
    const nf = fd !== null ? Math.trunc(fd * fps) : null;
    let ctx = `Ctx ft_ctx${k}(Clk k, ${PIXARGS}) {
  Ctx c;
  c.gtime = k.gtime; c.start = k.start; c.px = px; c.py = py; c.pw = fw; c.ph = fh; c.fw = fw; c.fh = fh;
  c.gt = k.gtime / QTS_DURATION;
  c.gn = floor(k.gtime * QTS_FPS + 1e-4);
  c.t = (k.gtime - k.start) / ${fd !== null ? f(fd) : "k.dur"};
  c.n = floor(k.gtime * QTS_FPS + 1e-4) - ceil(k.start * QTS_FPS);
  c.dur = k.dur;
  c.x = 0.0; c.y = 0.0; c.w = 1.0; c.h = 1.0; c.cx = 0.0; c.cy = 0.0; c.left = 0.0; c.top = 0.0; c.zoom = 1.0;
  c.p0 = 0.0; c.q0 = 0.0; c.minv = 0.0; c.maxv = 1.0; c.recur = 64;
  float nf = ${nf !== null ? f(nf) : "floor(k.dur * QTS_FPS)"};
  ${pre.join("\n  ")}
  c.left = ${props.left}; c.top = ${props.top};
  c.w = ${props.width}; c.h = ${props.height};
  c.left = ${props.left}; c.top = ${props.top};
  c.zoom = ${props.zoomFac};
`;
    if (props.endWidth) ctx += `  if (nf > 1.0) { float ew = ${props.endWidth}; if (ew > 0.0 && c.zoom == 1.0 && c.w > 0.0) c.zoom = pow(ew / c.w, 1.0 / ${nf !== null ? f(nf - 1) : "(nf - 1.0)"}); }\n`;
    if (params("center") === true) ctx += `  c.left -= c.w / 2.0; c.top -= c.h / 2.0;\n`;
    ctx += `  if (c.zoom != 1.0) {
    float fz = pow(c.zoom, ${nf !== null ? f(nf - 1) : "(nf - 1.0)"} * (${props.zoomFunc}));
    float diff = c.w * fz - c.w; c.w += diff; c.left -= diff / 2.0;
    diff = c.h * fz - c.h; c.h += diff; c.top -= diff / 2.0;
  }
  c.cx = c.left + c.w / 2.0; c.cy = c.top + c.h / 2.0;
  c.recur = int(clamp(qts_trunc(${props.recurse}), 0.0, 4000.0));
  c.p0 = ${props.p0}; c.q0 = ${props.q0};
  c.x = c.left; c.y = c.top;
  c.minv = ${props.min}; c.maxv = ${props.max};
  if (c.maxv == c.minv) { c.minv -= 0.01; c.maxv += 0.01; }
  return c;
}
`;
    return ctx;
  }

  formulaFunctions(node, k) {
    const P = (key) => { const v = G.formulaParam(node, key); return typeof v === "number" ? String(v) : v; };
    const imgName = P("image");
    let image = null;
    if (imgName) { image = this.findImage(imgName); if (!image) this.warn(`${node.id}: can't find image ${imgName}`); }
    const tile = P("tile") === true;
    const gen = this.newGen(node, image, tile);
    const ctx = this.ctxFunction(k, node, gen, P);
    // colour
    const [ckey, csrc] = G.colorParam(node);
    const mode = ckey === "hsv" ? CM.HSV : ckey === "mono" ? CM.MONO : CM.RGB;
    const src = ckey === "rgb" || ckey === "hsv" ? `triple(${csrc})` : csrc;
    const tree = this.parseExpr(gen, node, ckey, src);
    let r;
    try { r = tree ? gen.gen(tree) : gen.num("0.0"); }
    catch (e) { if (e instanceof GLSLError && !(e instanceof NodeError)) throw new NodeError(node.id, ckey, e.message); throw e; }
    const pre = gen.pre.splice(0);
    const pix = `vec3 ft_pix${k}(Ctx c) {
  ${pre.join("\n  ")}
  return ${mode === CM.MONO ? `vec3(${r.v ? `(${r.c}).x` : r.c})` : gen.V(r)};
}
`;
    const pinOne = P("wrap") === true
      ? `v = qts_wrap((v - c.minv) * tran);`
      : `if (v < c.minv) v = c.minv; else if (v > c.maxv) v = c.maxv; else v = (v - c.minv) * tran;`;
    const cycle = P("cycle") === true ? `v = fract(v + c.gn / 256.0);` : ``;
    const pin = `float ft_pinf${k}(float v, Ctx c) {
  float tran = 1.0 / (c.maxv - c.minv);
  ${pinOne}
  ${cycle}
  return v;
}
vec3 ft_pin${k}(Ctx c) {
  vec3 v = ft_pix${k}(c);
  return vec3(ft_pinf${k}(v.x, c), ft_pinf${k}(v.y, c), ft_pinf${k}(v.z, c));
}
`;
    const toRGB = mode === CM.HSV ? "qts_hsv(v)" : "v";
    const samp = `vec3 ft_samp${k}(Clk k, Ctx caller, float v1, float v2, bool hasT, float tval) {
  ${tile ? "v1 = qts_wrap(v1); v2 = qts_wrap(v2);" : ""}
  Ctx c = ft_ctx${k}(k, caller.px, caller.py, caller.fw, caller.fh);
  c.x = c.left + v1 * c.w; c.y = c.top + v2 * c.h;
  if (hasT) c.t = tval;
  c.n = floor(c.t * ${this.fixedDuration(node) !== null ? f(this.fixedDuration(node) * this.fps) : "(k.dur * QTS_FPS)"});
  vec3 v = ft_pin${k}(c);
  return ${toRGB};
}
`;
    const ov = node.params && typeof node.params.oversample === "boolean" ? node.params.oversample : this.info.oversample;
    const layer = `vec3 ft_layer${k}(Clk k, ${PIXARGS}) {
  Ctx c = ft_ctx${k}(k, px, py, fw, fh);
  float xInc = c.w / fw, yInc = c.h / fh;
  c.x = c.left + px * xInc; c.y = c.top + py * yInc;
  vec3 v = ft_pin${k}(c);
#if QTS_OVERSAMPLE
  ${ov ? `c.y += yInc / 2.0; v += ft_pin${k}(c);
  c.x += xInc / 2.0; v += ft_pin${k}(c);
  c.y -= yInc / 2.0; v += ft_pin${k}(c);
  v *= 0.25;` : ""}
#endif
  return ${toRGB};
}
`;
    return `// ${node.id} (${node.type})\n` + ctx + pix + pin + samp + layer;
  }

  // mode name (or CHOP number) -> CHOP number, or -1 when the mode isn't implemented
  modeOf(node, m) {
    if (m === undefined || m === null || m === "") return CHOP.normal;
    const v = typeof m === "number" ? m : CHOP[String(m).toLowerCase()];
    if (v === undefined) { this.warn(`${node.id}: unknown blend mode ${m}`); return CHOP.normal; }
    if (v >= CHOP.dodge) { this.warn(`${node.id}: blend mode ${m} isn't implemented (the input is skipped), as in QTS`); return -1; }
    return v;
  }

  // The inputs a sequence-like node paints, in order: [{node, mode}]
  entriesOf(node) {
    const ins = node.inputs || {};
    if (node.type === "blend") {
      const m = this.modeOf(node, (node.params || {}).mode || "screen");
      return [{ node: ins.a ? this.byId.get(ins.a) : null, mode: CHOP.normal }, { node: ins.b ? this.byId.get(ins.b) : null, mode: m }];
    }
    const modes = (node.params || {}).modes || {};
    return G.portsOf(node).map((p) => ({ node: ins[p] ? this.byId.get(ins[p]) || null : null, mode: this.modeOf(node, modes[p]) }));
  }

  // statements painting `target` onto `col` with mode, at clock (g, start, dur)
  paintStmt(target, mode, clk) {
    const k = this.index.get(target);
    if (G.isFormula(target)) {
      const layer = `qts_q8(ft_layer${k}(${clk}, px, py, fw, fh))`;
      if (mode === CHOP.normal) return `col = ${layer};`;
      this.use("qts_blend");
      return `col = qts_q8(qts_blend(${mode}, col, ${layer}));`;
    }
    if (mode === CHOP.normal) return `col = ft_paint${k}(${clk}, col, px, py, fw, fh);`;
    this.use("qts_blend");
    return `col = qts_q8(qts_blend(${mode}, col, ft_paint${k}(${clk}, vec3(0.0), px, py, fw, fh)));`;
  }
  sampStmt(target, mode, clk) {
    const call = `ft_samp${this.index.get(target)}(${clk}, caller, v1, v2, hasT, tval)`;
    if (mode === CHOP.normal) return `col = ${call};`;
    this.use("qts_blend");
    return `col = qts_blend(${mode}, col, ${call});`;
  }

  // the body that walks a sequence's entries (paint or samp), at the caller clock k
  entriesBody(node, stmt) {
    const lines = [];
    let lastEnd = null, i = 0;
    for (const e of this.entriesOf(node)) {
      ++i;
      if (!e.node) continue;
      const lt = this.lifetime(e.node, "k.start", "k.dur", lastEnd);
      lines.push(`  { float s = ${lt.start}, d = ${lt.dur};`);
      if (e.mode >= 0) lines.push(`    if (k.gtime >= s && k.gtime <= s + d) ${stmt(e.node, e.mode, "Clk(k.gtime, s, d)")}`);
      lines.push(`    e${i} = s + d; }`);
      lastEnd = `e${i}`;
    }
    const decl = i ? `  float ${Array.from({ length: i }, (_, j) => `e${j + 1} = k.start`).join(", ")};\n` : "";
    return decl + lines.join("\n");
  }

  sequenceFunctions(node, k) {
    return `// ${node.id} (${node.type})
vec3 ft_paint${k}(Clk k, vec3 col, ${PIXARGS}) {
${this.entriesBody(node, (t, m, clk) => this.paintStmt(t, m, clk))}
  return col;
}
vec3 ft_samp${k}(Clk k, Ctx caller, float v1, float v2, bool hasT, float tval) {
  vec3 col = vec3(0.0);
  float px = caller.px, py = caller.py, fw = caller.fw, fh = caller.fh;
${this.entriesBody(node, (t, m, clk) => this.sampStmt(t, m, clk))}
  return col;
}
`;
  }

  timeFunctions(node, k) {
    const params = node.params || {};
    const gen = this.newGen({ id: node.id, inputs: {}, params: {} }, null, false);
    const ctx = this.ctxFunction(k, node, gen, (key) => { const s = G.FORMULA_PARAMS.find((p) => p.key === key); return s ? s.def : undefined; });
    const tsrc = params.time === undefined || params.time === "" ? "t*dur" : String(params.time);
    const tcode = this.propCode(gen, node, "time", tsrc);
    const pre = gen.pre.splice(0);
    const loop = timeNumber(params.loop);
    const input = node.inputs && node.inputs.in ? this.byId.get(node.inputs.in) : null;
    const local = `  Ctx c = ft_ctx${k}(k, px, py, fw, fh);
  ${pre.join("\n  ")}
  float lt = ${tcode};
  ${loop && loop > 0 ? `lt -= ${f(loop)} * floor(lt / ${f(loop)});` : ""}
  Clk k2 = Clk(k.start + lt, k.start, k.dur);`;
    let paint = "", samp = "";
    if (input) {
      const lt = this.lifetime(input, "k2.start", "k2.dur", null);
      const clk = `Clk(k2.gtime, ${lt.start}, ${lt.dur})`;
      paint = "  " + this.paintStmt(input, CHOP.normal, clk);
      samp = "  " + this.sampStmt(input, CHOP.normal, clk);
    }
    return `// ${node.id} (time)
${ctx}vec3 ft_paint${k}(Clk k, vec3 col, ${PIXARGS}) {
${local}
${paint}
  return col;
}
vec3 ft_samp${k}(Clk k, Ctx caller, float v1, float v2, bool hasT, float tval) {
  float px = caller.px, py = caller.py, fw = caller.fw, fh = caller.fh;
  vec3 col = vec3(0.0);
${local}
${samp}
  return col;
}
`;
  }

  // The lengths a node's lifetime can have: durations are numbers, never expressions, so
  // they are known here; a node pulled at one length gets it as a constant (as glsl.js wrote
  // it, which matters to the float maths of deep zooms).
  staticDurations(order) {
    const durs = new Map(), D = this.info.duration > 0 ? this.info.duration : 1;
    const add = (n, d) => { if (!durs.has(n)) durs.set(n, new Set()); durs.get(n).add(d); };
    const out = this.output, root = out.inputs && out.inputs.in ? this.byId.get(out.inputs.in) : null;
    const own = (n, d) => { const v = timeNumber((n.params || {}).duration); return v !== null && v > 0 ? v : d; };
    if (root) add(root, own(root, D));
    for (const n of [...order].reverse()) {
      for (const d of durs.get(n) || []) for (const src of Object.values(n.inputs || {})) {
        const m = src && this.byId.get(src);
        if (m && m.type !== "output") add(m, own(m, d));
      }
    }
    if (this.opts.preview) for (const n of order) if (!durs.has(n)) add(n, D);
    this.durs = durs;
  }
  // the one length a node's lifetime has, or null
  fixedDuration(node) { const s = this.durs && this.durs.get(node); return s && s.size === 1 ? [...s][0] : null; }

  compile() {
    const errs = G.validate(this.patch);
    if (errs.length) throw new GLSLError(errs[0]);
    const order = G.topoOrder(this.patch, !!this.opts.all).filter((n) => n.type !== "output");
    order.forEach((n, i) => this.index.set(n, i));
    this.fps = this.info.frameRate > 0 ? this.info.frameRate : 12;
    this.staticDurations(order);
    const bodies = [];
    for (const n of order) {
      if (G.isFormula(n)) bodies.push(this.formulaFunctions(n, this.index.get(n)));
      else if (n.type === "time") bodies.push(this.timeFunctions(n, this.index.get(n)));
      else bodies.push(this.sequenceFunctions(n, this.index.get(n)));
    }
    const info = this.info;
    const D = info.duration > 0 ? info.duration : 1, fps = info.frameRate > 0 ? info.frameRate : 12;
    const out = this.output;
    const root = out.inputs && out.inputs.in ? this.byId.get(out.inputs.in) : null;
    let paint = "";
    if (root) {
      const lt = this.lifetime(root, "0.0", "QTS_DURATION", null);
      paint = `  { float s = ${lt.start}, d = ${lt.dur};
    if (gtime >= s && gtime <= s + d) ${this.paintStmt(root, CHOP.normal, "Clk(gtime, s, d)")} }`;
    } else this.warn("the Output has no input (black)");
    let preview = "";
    if (this.opts.preview) {
      const cases = order.map((n) => `  if (ft_node == ${this.index.get(n)}) { ${this.paintStmt(n, CHOP.normal, "Clk(gtime, 0.0, QTS_DURATION)")} fragColor = vec4(col, 1.0); return; }`);
      preview = cases.join("\n") + "\n";
    }
    this.use("qts_trunc"); this.use("qts_wrap"); this.use("qts_hsv");
    const title = (this.patch.title || "fragtime").replace(/[^\w .-]/g, "_");
    const source = `// ${title}: a Fragtime patch compiled to GLSL by fragtime.jbum.com
// Loops every ${f(D)} seconds. Shadertoy-compatible: paste as is (set any iChannel textures to
// the patch's images, nearest filter, no vflip).
#define QTS_DURATION ${f(D)}
#define QTS_FPS ${f(fps)}
#define QTS_OVERSAMPLE 1      // 0 renders four times faster, without the 2x2 supersampling
${this.opts.preview ? "uniform int ft_node;      // the node shown (thumbnails); -1: the Output\n" : ""}
struct Ctx { float x, y, t, gt, w, h, n, gn, fw, fh, p0, q0, px, py, pw, ph, cx, cy, left, top, zoom, dur, minv, maxv, gtime, start; int recur; };
struct Clk { float gtime, start, dur; };

float qts_sq(float v) { return v * v; }
float qts_cube(float v) { return v * v * v; }
vec3 qts_q8(vec3 c) { return floor(c * 255.0 + 1e-4) / 255.0; }
${libraryText(this.used)}

${bodies.join("\n")}
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  float fw = iResolution.x, fh = iResolution.y;
  float px = floor(fragCoord.x), py = floor(fh - fragCoord.y);
  float gtime = mod(iTime, QTS_DURATION);
  vec3 col = vec3(0.0);
${preview}${paint}
  fragColor = vec4(col, 1.0);
}
`;
    const nodeIndex = new Map([...this.index].map(([n, k]) => [n.id, k]));
    return { source, images: this.images, warnings: this.warnings, duration: D, width: info.width, height: info.height, fps, nodeIndex };
  }
}

import { LIB } from "./glsl.js";
function LIB_DEPS(name) { if (!LIB[name]) throw new GLSLError("no library function " + name); return LIB[name][0]; }

// Compiles a patch. Returns {source, images, warnings, duration, width, height, fps, nodeIndex}.
export function compilePatchToGLSL(patch, images, opts) {
  return new GraphCompiler(patch, images, opts).compile();
}
