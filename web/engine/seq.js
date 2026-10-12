// seq.js -- the .can script parser and the sequence tree for the JS engine (follows
// src/seq.cpp).

import { compileExpr, ExprError } from "./expr.js";
import { trunc } from "./funcs.js";

export const CHOP = { normal: 0, multiply: 1, screen: 2, overlay: 3, lighten: 4, darken: 5, difference: 6,
  exclusion: 7, softlight: 8, hardlight: 9, dodge: 10, burn: 11, hue: 12, saturation: 13, color: 14, luminosity: 15 };
export const CM = { RGB: 0, HSV: 1, MONO: 2 };

const PROPS = {
  id: "id", debut: "debut", duration: "duration", rgb: "rgb", triple: "pix", pix: "pix", hsv: "hsv", mono: "mono",
  framerate: "frameRate", keyframes: "x", keyframerate: "x", datarate: "x", maxdatarate: "x", endwidth: "endWidth",
  depth: "x", moviedepth: "x", priority: "x", moviepriority: "x", codec: "x", moviecodec: "x", file: "movieFilename",
  filename: "movieFilename", moviefile: "movieFilename", moviefilename: "movieFilename", movietype: "x",
  framewidth: "frameWidth", fw: "frameWidth", frameheight: "frameHeight", fh: "frameHeight", min: "min", max: "max",
  left: "left", top: "top", width: "width", startwidth: "width", height: "height", zoomfunc: "zoomFunc",
  zoom: "zoomFac", zoomfactor: "zoomFac", recurse: "recurse", p0: "p0", jx: "p0", q0: "q0", jy: "q0",
  chop: "channelOp", opacity: "opacity", opaque: "opacity", source: "image", image: "image", bmp: "image",
  author: "x", gamma: "gamma",
};
const BOOLS = { dither: "x", moviedither: "x", seamless: "x", movieseamless: "x", center: "center",
  oversample: "oversample", cycle: "cycle", wrap: "wrap", tile: "tile" };
const NUMWORDS = { yes: 1, true: 1, on: 1, no: 0, false: 0, off: 0, next: -1, last: -1, quicktime: 0, pngframes: 1,
  bmpframes: 2, normal: 0, multiply: 1, screen: 2, overlay: 3, lighten: 4, darken: 5, difference: 6, exclusion: 7,
  softlight: 8, hardlight: 9, dodge: 10, colordodge: 10, colourdodge: 10, burn: 11, colorburn: 11, colourburn: 11,
  hue: 12, sat: 13, saturation: 13, col: 14, color: 14, colour: 14, lum: 15, luminosity: 15 };

export class ScriptError extends Error {}

// ---------------------------------------------------------------- parser

class ScriptParser {
  constructor(src, script) { this.src = src; this.pos = 0; this.line = 1; this.script = script; this.tok = null; }
  error(m) { this.script.errors.push(`Line ${this.tok ? this.tok.line : this.line}: ${m}`); throw new ScriptError(m); }
  lex() {
    const s = this.src;
    for (;;) {
      while (this.pos < s.length && " \t\r".includes(s[this.pos])) this.pos++;
      if (s[this.pos] === "\n") { this.line++; this.pos++; continue; }
      if (s[this.pos] === "/" && s[this.pos + 1] === "/") { while (this.pos < s.length && s[this.pos] !== "\n") this.pos++; continue; }
      break;
    }
    const line = this.line;
    if (this.pos >= s.length) return (this.tok = { type: "end", line });
    const c = s[this.pos];
    const isDigit = (ch) => ch >= "0" && ch <= "9";
    if (isDigit(c) || (c === "-" && (isDigit(s[this.pos + 1] || "") || s[this.pos + 1] === ".")) || (c === "." && isDigit(s[this.pos + 1] || ""))) {
      const st = this.pos;
      if (c === "-") this.pos++;
      while (this.pos < s.length && (isDigit(s[this.pos]) || s[this.pos] === "." || s[this.pos] === ":")) this.pos++;
      const w = s.slice(st, this.pos), parts = w.split(":");
      let num;
      if (parts.length === 3) num = parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
      else if (parts.length === 2) num = parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
      else num = parseFloat(w);
      return (this.tok = { type: "number", num, line });
    }
    if (c === '"' || c === "'") {
      const e = s.indexOf(c, this.pos + 1), nl = s.indexOf("\n", this.pos);
      if (e < 0 || (nl >= 0 && nl < e)) { this.tok = { type: "string", text: "", line }; this.error("Unterminated string"); }
      const text = s.slice(this.pos + 1, e);
      this.pos = e + 1;
      return (this.tok = { type: "string", text, line });
    }
    if (/[A-Za-z]/.test(c)) {
      const m = /^[A-Za-z][A-Za-z0-9_]*/.exec(s.slice(this.pos));
      const w = m[0], lw = w.toLowerCase();
      this.pos += w.length;
      if (lw === "seq") return (this.tok = { type: "seqtag", map: false, line });
      if (lw === "map") return (this.tok = { type: "seqtag", map: true, line });
      if (NUMWORDS[lw] !== undefined) return (this.tok = { type: "number", num: NUMWORDS[lw], line });
      if (PROPS[lw]) return (this.tok = { type: "sym", id: PROPS[lw], text: w, line });
      if (BOOLS[lw]) return (this.tok = { type: "boolsym", id: BOOLS[lw], text: w, line });
      return (this.tok = { type: "string", text: w, line });
    }
    this.pos++;
    if ("<>=/".includes(c)) return (this.tok = { type: "char", code: c, line });
    this.tok = { type: "char", code: "?", line };
    this.error("Unexpected character: " + c);
  }
  isChar(c) { return this.tok.type === "char" && this.tok.code === c; }
  parse() {
    this.lex();
    const list = [];
    while (this.tok.type !== "end") list.push(this.parseSeq());
    if (!list.length) this.error("Empty script");
    if (list.length === 1) return list[0];
    const root = new Seq(false, 0);
    root.children = list;
    return root;
  }
  parseSeq() {
    if (!this.isChar("<")) this.error("parse error: expected <seq");
    this.lex();
    if (this.tok.type !== "seqtag") this.error("parse error: expected seq or map");
    const seq = new Seq(this.tok.map, this.tok.line);
    this.lex();
    while (this.tok.type === "sym" || this.tok.type === "boolsym" || this.tok.type === "string") {
      const name = this.tok;
      this.lex();
      const p = { id: name.type === "string" ? null : name.id, isString: false, str: "", num: 0, line: name.line };
      if (this.isChar("=")) {
        this.lex();
        if (this.tok.type === "string") { p.isString = true; p.str = this.tok.text; }
        else if (this.tok.type === "number") p.num = this.tok.num;
        else this.error("parse error: bad property value");
        this.lex();
        if (name.type === "boolsym" && p.isString) { this.script.errors.push(`Line ${p.line}: Improper use of boolean`); p.isString = false; p.num = 1; }
      } else if (name.type === "boolsym") p.num = 1;
      else this.error("parse error: expected = after " + name.text);
      if (name.type === "string") this.script.errors.push(`Line ${p.line}: Unknown Tag: ${name.text}`);
      seq.props.push(p);
    }
    if (this.isChar("/")) { this.lex(); if (!this.isChar(">")) this.error("parse error: expected >"); this.lex(); return seq; }
    if (!this.isChar(">")) this.error("parse error: expected > or />");
    this.lex();
    while (!(this.isChar("<") && this.src[this.pos] === "/")) {
      if (this.tok.type === "end") this.error("parse error: missing </seq>");
      seq.children.push(this.parseSeq());
    }
    this.lex(); this.lex();
    if (this.tok.type !== "seqtag") this.error("parse error: expected </seq>");
    this.lex();
    if (!this.isChar(">")) this.error("parse error: expected >");
    this.lex();
    return seq;
  }
}

function propString(p) {
  if (p.isString) return p.str;
  let s = p.num.toFixed(30).replace(/0+$/, "").replace(/\.$/, "");
  return s;
}
const propFloat = (p) => p.isString ? parseFloat(p.str) || 0 : p.num;
const propInt = (p) => p.isString ? parseInt(p.str, 10) || 0 : trunc(p.num);
const propBool = (p) => p.isString ? /^(yes|true|on)$/i.test(p.str) || (parseInt(p.str, 10) || 0) !== 0 : p.num !== 0;

// ---------------------------------------------------------------- sequences

const EXPS = ["pix", "left", "top", "width", "height", "zoomFac", "zoomFunc", "min", "max", "recurse", "p0", "q0", "endWidth", "opacity", "gamma"];

function defaultProps() {
  return {
    center: false, oversample: false, cycle: false, wrap: false, tile: false,
    exps: { pix: "RGB(x,y,x+y)", left: "0", top: "0", width: "1", height: "w*fh/fw", zoomFac: "1.0", zoomFunc: "t",
      min: "0", max: "1", recurse: "64", p0: "0", q0: "0", endWidth: "", opacity: "1", gamma: "0.454550" },
    fns: {}, colormode: CM.RGB, channelOp: CHOP.normal, flags: 0,
    idName: "", srcName: "", image: null, debut: 0, duration: 1, globalDebut: 0, frameRate: 12, firstGlobalFrame: 0,
    movieFilename: "", frameWidth: 256, frameHeight: 256,
  };
}

function newVars() {
  return { px: 0, py: 0, pw: 0, ph: 0, fw: 0, fh: 0, recur: 0, leftVal: 0, topVal: 0, widthVal: 0, heightVal: 0,
    endWidthVal: 0, zoomVal: 1, centerX: 0, centerY: 0, minVal: 0, maxVal: 1, p0: 0, q0: 0, x: 0, y: 0, xInc: 0, yInc: 0,
    localScaledTime: 0, globalScaledTime: 0, tranFactor: 1, duration: 1, wrapMode: false, cycleMode: false, tileMode: false,
    globalFrameNbr: 0, localFrameNbr: 0, opacity: 1, gamma: 1, image: null, lastResult: 0, lastX: 0, lastY: 0 };
}

export class Seq {
  constructor(isMap, line) { this.isMap = isMap; this.line = line; this.props = []; this.children = []; this.p = null; this.V = newVars(); }

  assignProps(script, parent) {
    const par = parent ? parent.p : script.defaultProps;
    const p = Object.assign({}, par, { exps: Object.assign({}, par.exps), fns: Object.assign({}, par.fns) });
    p.debut = 0;
    p.flags = this.isMap ? 1 : 0;
    this.p = p;
    this.V.image = p.image;
    const comp = (key, src, line) => { p.exps[key] = src; p.fns[key] = script.compile(src, line); };
    for (const pr of this.props) {
      switch (pr.id) {
        case "pix": comp("pix", propString(pr), pr.line); p.colormode = CM.RGB; break;
        case "rgb": comp("pix", "triple(" + propString(pr) + ")", pr.line); p.colormode = CM.RGB; break;
        case "hsv": comp("pix", "triple(" + propString(pr) + ")", pr.line); p.colormode = CM.HSV; break;
        case "mono": comp("pix", propString(pr), pr.line); p.colormode = CM.MONO; break;
        case "id": p.idName = propString(pr); script.registerSeq(this); break;
        case "image": {
          p.srcName = propString(pr);
          p.image = script.images.get(p.srcName) || script.images.get(p.srcName.toLowerCase()) || null;
          if (!p.image) script.errors.push(`Line ${pr.line}: Can't find image ${p.srcName}`);
          this.V.image = p.image;
          break;
        }
        case "debut": p.debut = propFloat(pr); break;
        case "duration": p.duration = propFloat(pr); break;
        case "frameRate": p.frameRate = propFloat(pr); break;
        case "movieFilename": p.movieFilename = propString(pr); break;
        case "frameWidth": p.frameWidth = propInt(pr); break;
        case "frameHeight": p.frameHeight = propInt(pr); break;
        case "channelOp": p.channelOp = propInt(pr); break;
        case "center": p.center = propBool(pr); break;
        case "oversample": p.oversample = propBool(pr); break;
        case "cycle": p.cycle = propBool(pr); break;
        case "wrap": p.wrap = propBool(pr); break;
        case "tile": p.tile = propBool(pr); break;
        case "x": case null: break;
        default:
          if (EXPS.includes(pr.id)) comp(pr.id, propString(pr), pr.line);
      }
    }
    for (const c of this.children) c.assignProps(script, this);
  }

  assignDurations() {
    let prev = null;
    for (const c of this.children) {
      const cp = c.p;
      if (cp.debut === -1 && prev) {
        cp.globalDebut = prev.p.globalDebut + prev.p.duration;
        cp.debut = cp.globalDebut - this.p.globalDebut;
      } else {
        if (cp.debut === -1) cp.debut = 0;
        cp.globalDebut = cp.debut + this.p.globalDebut;
      }
      cp.firstGlobalFrame = Math.ceil(cp.globalDebut * cp.frameRate);
      c.assignDurations();
      const temp = cp.debut + cp.duration;
      if (this.p.duration < temp) this.p.duration = temp;
      prev = c;
    }
  }

  // collect the leaves alive at timeVal (layer order) and set up their variables
  initPropsForFrame(r, list, timeVal) {
    const p = this.p;
    if (timeVal < p.debut || timeVal > p.debut + p.duration) return;
    for (const c of this.children) c.initPropsForFrame(r, list, timeVal - p.debut);
    if (!this.children.length) list.push(this);
    const V = this.V, F = r.F, S = r.S, fns = p.fns;
    // a property's value: the VM's EvalF, which takes a triple's first component
    const ev = (k) => { const f = fns[k]; if (!f) return 0; const v = f.fn(V, F, S); return typeof v === "number" ? v : v[0]; };
    V.globalScaledTime = r.globalScaledTime;
    V.globalFrameNbr = r.globalFrameNbr;
    V.localScaledTime = (r.globalTime - p.globalDebut) / p.duration;
    V.localFrameNbr = r.globalFrameNbr - p.firstGlobalFrame;
    V.duration = p.duration;
    V.px = V.py = 0;
    V.pw = V.fw = r.width; V.ph = V.fh = r.height;
    V.leftVal = ev("left"); V.topVal = ev("top");
    V.widthVal = ev("width"); V.heightVal = ev("height");
    V.leftVal = ev("left"); V.topVal = ev("top");
    V.zoomVal = ev("zoomFac");
    V.endWidthVal = fns.endWidth ? ev("endWidth") : 0;
    if (V.endWidthVal > 0 && V.zoomVal === 1 && V.widthVal > 0) {
      const nbrFrames = trunc(p.duration * p.frameRate);
      if (nbrFrames > 1) V.zoomVal = Math.pow(V.endWidthVal / V.widthVal, 1 / (nbrFrames - 1));
    }
    if (p.center) { V.leftVal -= V.widthVal / 2; V.topVal -= V.heightVal / 2; }
    V.lastX = V.leftVal + V.widthVal; V.lastY = V.topVal + V.heightVal;
    if (V.zoomVal !== 1) {
      const nbrFrames = trunc(p.duration * p.frameRate);
      const tranFrameNbr = (nbrFrames - 1) * ev("zoomFunc");
      const fz = Math.pow(V.zoomVal, tranFrameNbr);
      let diff = V.widthVal * fz - V.widthVal; V.widthVal += diff; V.leftVal -= diff / 2;
      diff = V.heightVal * fz - V.heightVal; V.heightVal += diff; V.topVal -= diff / 2;
    }
    V.centerX = V.leftVal + V.widthVal / 2; V.centerY = V.topVal + V.heightVal / 2;
    V.recur = trunc(ev("recurse"));
    V.p0 = ev("p0"); V.q0 = ev("q0");
    V.xInc = V.widthVal / V.fw; V.yInc = V.heightVal / V.fh;
    V.x = V.leftVal; V.y = V.topVal;
    V.minVal = ev("min"); V.maxVal = ev("max");
    if (V.maxVal === V.minVal) { V.minVal -= 0.01; V.maxVal += 0.01; }
    V.tranFactor = 1 / (V.maxVal - V.minVal);
    V.wrapMode = p.wrap; V.cycleMode = p.cycle; V.tileMode = p.tile;
    V.opacity = ev("opacity"); V.gamma = ev("gamma");
  }
}

// ---------------------------------------------------------------- script

export class Script {
  constructor() { this.errors = []; this.warnings = []; this.seqNames = new Map(); this.seqByID = []; this.images = new Map(); this.main = null; }

  compile(src, line) {
    try { return compileExpr(src, this.seqNames); }
    catch (e) {
      if (e instanceof ExprError) { this.errors.push(`Line ${line}: ${e.message} in "${src}"`); return { fn: () => 0, flags: {} }; }
      throw e;
    }
  }
  registerSeq(seq) {
    let id = this.seqNames.get(seq.p.idName);
    if (id === undefined) { id = this.seqNames.size + 1; this.seqNames.set(seq.p.idName, id); }
    this.seqByID[id - 1] = seq;
  }

  // images: Map name -> Image (see image.js). Returns true on success.
  load(text, images) {
    this.errors = []; this.warnings = []; this.seqNames = new Map(); this.seqByID = []; this.main = null;
    this.images = images || new Map();
    let root;
    try { root = new ScriptParser(text, this).parse(); }
    catch (e) { if (e instanceof ScriptError) return false; throw e; }
    if (this.errors.length) return false;
    this.defaultProps = defaultProps();
    for (const k of EXPS) if (this.defaultProps.exps[k] !== "") this.defaultProps.fns[k] = this.compile(this.defaultProps.exps[k], 0);
    this.defaultProps.fns.pix = this.compile(this.defaultProps.exps.pix, 0);
    this.main = root;
    root.assignProps(this, null);
    const rp = root.p;
    if (rp.debut === -1) rp.debut = 0;
    rp.globalDebut = rp.debut;
    rp.firstGlobalFrame = Math.ceil(rp.globalDebut * rp.frameRate);
    root.assignDurations();
    for (const [name, id] of this.seqNames) if (!this.seqByID[id - 1]) this.warnings.push(`Unknown sequence: $${name} (renders black)`);
    return this.errors.length === 0;
  }
  get duration() { return this.main ? this.main.p.duration : 0; }
  get frameRate() { return this.main ? this.main.p.frameRate : 12; }
  get frameWidth() { return this.main ? this.main.p.frameWidth : 256; }
  get frameHeight() { return this.main ? this.main.p.frameHeight : 256; }
  get nbrFrames() { return this.main ? trunc(this.main.p.duration * this.main.p.frameRate) : 0; }
  info() { return { duration: this.duration, frameRate: this.frameRate, frames: this.nbrFrames, width: this.frameWidth, height: this.frameHeight }; }
}
