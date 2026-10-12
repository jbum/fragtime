// expr.js -- the Pixel Magic expression language in JavaScript: lexer, parser, and a
// compiler that turns each expression into a JS function (a straight-line formula V8 can
// JIT), following src/expr_parse.cpp and the VM in src/expr_eval.cpp.
//
// Values are numbers, or triples [r,g,b]. Where the VM popped a number off a triple it
// got the *last* pushed component (v3): n() does the same.

import { pi } from "./funcs.js";

// ---------------------------------------------------------------- tokens

const T = {
  END: 0, NUMBER: 1, STRING: 2, SEQNAME: 3, VARIABLE: 4, FUNCTION: 5, NEWVAR: 6, CHARVAR: 7,
  NOISE: 8, NOISE2: 9, FNOISE: 10, TURB: 11, TERP: 12, PINCH: 13, EASE: 14, BIAS: 15, GAIN: 16,
  MANDEL: 17, MANDELQ: 18, JULIA: 19, SAMPLE: 20, SAMPLEP: 21, WNOISE1: 22, WNOISE2: 23,
  LOGICAND: 24, LOGICOR: 25, MOD: 26, POW: 27, AND: 28, OR: 29, XOR: 30, COMPARISON: 31, CHAR: 32,
};

// name -> [generated-code op, argument count]
const FUNCTIONS = {
  int: ["int", 1], sqrt: ["sqrt", 1], log: ["log", 1], log10: ["log10", 1], abs: ["abs", 1], fabs: ["abs", 1],
  sign: ["sign", 1], exp: ["exp", 1], cos: ["cos", 1], sin: ["sin", 1], tan: ["tan", 1], acos: ["acos", 1],
  asin: ["asin", 1], atan: ["atan", 1], cosh: ["cosh", 1], sinh: ["sinh", 1], tanh: ["tanh", 1],
  sin2: ["sin2", 1], cos2: ["cos2", 1], sin3: ["sin3", 1], cos3: ["cos3", 1],
  mand3: ["mandel3", 0], mandel3: ["mandel3", 0], mandc: ["mandelcpm", 0], mandcpm: ["mandelcpm", 0],
  mandelcpm: ["mandelcpm", 0], zebra: ["zebra", 4], dragon: ["dragon", 0], fbm: ["fbm", 6], fbmt: ["fbmt", 6],
  fib: ["fib", 1], prime: ["prime", 1], angle: ["angle", 2], linen: ["linen", 4], linenr: ["linenr", 4],
  limit: ["limit", 3], mod: ["mod", 2], xor: ["xor", 2], and: ["and", 2], or: ["or", 2], not: ["not", 1],
  pow2: ["pow2", 1], pow: ["pow", 2], red: ["red", 2], green: ["green", 2], grn: ["green", 2],
  blue: ["blue", 2], blu: ["blue", 2], distance: ["dist", 2], dist: ["dist", 2], rgb: ["rgb", 3],
  hsv: ["hsv", 3], triple: ["rgb", 3], min: ["min", 2], max: ["max", 2], clamp: ["clamp", 3],
};

const VARIABLES = {
  t: "V.localScaledTime", gt: "V.globalScaledTime", x: "V.x", y: "V.y", w: "V.widthVal", h: "V.heightVal",
  a: "F.angle(V.x-V.centerX,V.y-V.centerY)", d: "F.dist(V.x-V.centerX,V.y-V.centerY)", i: "V.recur",
  n: "V.localFrameNbr", gn: "V.globalFrameNbr", fw: "V.fw", fh: "V.fh", jx: "V.p0", jy: "V.q0", p0: "V.p0",
  q0: "V.q0", px: "V.px", py: "V.py", pw: "V.pw", ph: "V.ph", cx: "V.centerX", cy: "V.centerY",
  sx: "F.sphereX(V.px/V.fw,V.py/V.fh)", sy: "F.sphereY(V.px/V.fw,V.py/V.fh)", sz: "F.sphereZ(V.px/V.fw,V.py/V.fh)",
  iw: "(V.image?V.image.width:0)", ih: "(V.image?V.image.height:0)",
  left: "V.leftVal", top: "V.topVal", zoom: "V.zoomVal", z: "V.zoomVal", recur: "V.recur", recurse: "V.recur",
  dur: "V.duration", duration: "V.duration", maxval: "V.maxVal", maxv: "V.maxVal", minval: "V.minVal", minv: "V.minVal",
};

const WORDS = {
  noise: T.NOISE, gnoise: T.NOISE, noise3d: T.NOISE, gnoise3d: T.NOISE,
  turb: T.TURB, gturb: T.TURB, turbulence: T.TURB, gturbulence: T.TURB, turb3d: T.TURB, gturb3d: T.TURB,
  turbulence3d: T.TURB, gturbulence3d: T.TURB,
  noise2: T.NOISE2, gnoise2: T.NOISE2, fnoise: T.FNOISE, fnoise3d: T.FNOISE,
  sampp: T.SAMPLEP, samplep: T.SAMPLEP, samp: T.SAMPLE, sample: T.SAMPLE, samptile: T.SAMPLE, sampletile: T.SAMPLE,
  terp: T.TERP, terpt: T.TERP, interpolate: T.TERP, pinch: T.PINCH, ease: T.EASE, bias: T.BIAS, gain: T.GAIN,
  mandq: T.MANDELQ, mandelq: T.MANDELQ, mand: T.MANDEL, mandel: T.MANDEL, mandelbrot: T.MANDEL, julia: T.JULIA,
  wnoise1: T.WNOISE1, wnoise2: T.WNOISE2,
};

export class ExprError extends Error {}

class Lexer {
  constructor(src) { this.src = src; this.pos = 0; this.tok = null; }
  fail(m) { throw new ExprError(m); }
  next() {
    const s = this.src;
    while (this.pos < s.length && " \t\n\r".includes(s[this.pos])) this.pos++;
    if (this.pos >= s.length) return (this.tok = { type: T.END });
    const c = s[this.pos];
    const isDigit = (ch) => ch >= "0" && ch <= "9";
    if (isDigit(c) || (c === "." && isDigit(s[this.pos + 1] || ""))) {
      const st = this.pos;
      while (isDigit(s[this.pos] || "")) this.pos++;
      if (s[this.pos] === "." && isDigit(s[this.pos + 1] || "")) { this.pos++; while (isDigit(s[this.pos] || "")) this.pos++; }
      return (this.tok = { type: T.NUMBER, val: parseFloat(s.slice(st, this.pos)) });
    }
    if (c === '"') {
      const e = s.indexOf('"', this.pos + 1);
      if (e < 0) this.fail("Unterminated string");
      const text = s.slice(this.pos, e + 1);
      this.pos = e + 1;
      return (this.tok = { type: T.STRING, text });
    }
    if (c === "$") {
      const m = /^\$([A-Za-z][A-Za-z0-9_]*)/.exec(s.slice(this.pos));
      if (!m) this.fail("Bad sequence reference");
      this.pos += m[0].length;
      return (this.tok = { type: T.SEQNAME, text: m[1] });
    }
    if (/[A-Za-z]/.test(c)) {
      const m = /^[A-Za-z][A-Za-z0-9_]*/.exec(s.slice(this.pos));
      const w = m[0], lw = w.toLowerCase();
      this.pos += w.length;
      if (lw === "pi") return (this.tok = { type: T.NUMBER, val: pi });
      if (lw === "pi2") return (this.tok = { type: T.NUMBER, val: pi * 2 });
      if (lw === "e") return (this.tok = { type: T.NUMBER, val: Math.exp(1) });
      if (WORDS[lw] !== undefined) return (this.tok = { type: WORDS[lw], text: w });
      if (lw.length === 1 && "rgbcsl".includes(lw)) return (this.tok = { type: T.CHARVAR, code: lw });
      if (lw === "and") return (this.tok = { type: T.LOGICAND });
      if (lw === "or") return (this.tok = { type: T.LOGICOR });
      if (lw === "mod") return (this.tok = { type: T.MOD });
      if (lw === "xor") return (this.tok = { type: T.XOR });
      if (VARIABLES[lw]) return (this.tok = { type: T.VARIABLE, code: VARIABLES[lw], text: w });
      if (FUNCTIONS[lw]) return (this.tok = { type: T.FUNCTION, op: FUNCTIONS[lw][0], argc: FUNCTIONS[lw][1], text: w });
      return (this.tok = { type: T.NEWVAR, text: w });
    }
    const two = s.substr(this.pos, 2);
    const ops2 = { "&&": [T.LOGICAND], "||": [T.LOGICOR], "**": [T.POW], "==": [T.COMPARISON, "=="],
      "!=": [T.COMPARISON, "!="], "<>": [T.COMPARISON, "!="], "<=": [T.COMPARISON, "<="], ">=": [T.COMPARISON, ">="] };
    if (ops2[two]) { this.pos += 2; return (this.tok = { type: ops2[two][0], code: ops2[two][1] }); }
    this.pos++;
    switch (c) {
      case "%": return (this.tok = { type: T.MOD });
      case "^": return (this.tok = { type: T.POW });
      case "&": return (this.tok = { type: T.AND });
      case "|": return (this.tok = { type: T.OR });
      case "=": return (this.tok = { type: T.COMPARISON, code: "==" });
      case "<": return (this.tok = { type: T.COMPARISON, code: "<" });
      case ">": return (this.tok = { type: T.COMPARISON, code: ">" });
    }
    if ("(),+-*/![]~?:{}".includes(c)) return (this.tok = { type: T.CHAR, code: c });
    this.fail("Unexpected character: " + c);
  }
}

// ---------------------------------------------------------------- parser -> syntax tree

// node kinds: num, var, rand, op (code, args), seq (code, id, args), cond, charvar
export class Parser {
  constructor(src, seqNames) {
    this.lx = new Lexer(src);
    this.seqNames = seqNames;      // Map name -> id, shared by the script
    this.flags = { hasMandel: false, hasMandelQ: false, hasJulia: false, hasWorley2: false };
  }
  fail(m) { throw new ExprError(m); }
  get tok() { return this.lx.tok; }
  lex() { return this.lx.next(); }
  isChar(c) { return this.tok.type === T.CHAR && this.tok.code === c; }
  expect(c) { if (!this.isChar(c)) this.fail(`parse error: expected '${c}'`); this.lex(); }

  parse() {
    this.lex();
    if (this.tok.type === T.END) return null;
    const root = this.parseStatement();
    while (this.isChar(")")) this.lex();         // a stray ')' at the end, as QTS allowed
    if (this.tok.type !== T.END) this.fail("parse error");
    return root;
  }
  parseStatement() {
    let e = this.parseLogic();
    while (this.isChar("?")) {
      this.lex();
      const a = this.parseStatement();
      this.expect(":");
      const b = this.parseLogic();
      e = { kind: "cond", args: [e, a, b] };
    }
    return e;
  }
  bin(code, a, b) { return { kind: "op", code, args: [a, b] }; }
  parseLogic() {
    let e = this.parseCompare();
    for (;;) {
      if (this.tok.type === T.LOGICAND) { this.lex(); e = this.bin("land", e, this.parseCompare()); }
      else if (this.tok.type === T.LOGICOR) { this.lex(); e = this.bin("lor", e, this.parseCompare()); }
      else return e;
    }
  }
  parseCompare() {
    let e = this.parseBitwise();
    while (this.tok.type === T.COMPARISON) { const c = this.tok.code; this.lex(); e = this.bin("cmp" + c, e, this.parseBitwise()); }
    return e;
  }
  parseBitwise() {
    let e = this.parseAdd();
    for (;;) {
      if (this.tok.type === T.AND) { this.lex(); e = this.bin("and", e, this.parseAdd()); }
      else if (this.tok.type === T.OR) { this.lex(); e = this.bin("or", e, this.parseAdd()); }
      else if (this.tok.type === T.XOR) { this.lex(); e = this.bin("xor", e, this.parseAdd()); }
      else return e;
    }
  }
  parseAdd() {
    let e = this.parseMul();
    for (;;) {
      if (this.isChar("+")) { this.lex(); e = this.bin("add", e, this.parseMul()); }
      else if (this.isChar("-")) { this.lex(); e = this.bin("sub", e, this.parseMul()); }
      else return e;
    }
  }
  parseMul() {
    let e = this.parseUnary();
    for (;;) {
      if (this.isChar("*")) { this.lex(); e = this.bin("mul", e, this.parseUnary()); }
      else if (this.isChar("/")) { this.lex(); e = this.bin("div", e, this.parseUnary()); }
      else if (this.tok.type === T.MOD) { this.lex(); e = this.bin("mod", e, this.parseUnary()); }
      else return e;
    }
  }
  parseUnary() {
    if (this.isChar("-")) { this.lex(); return { kind: "op", code: "neg", args: [this.parseUnary()] }; }
    if (this.isChar("~")) { this.lex(); return { kind: "op", code: "inv", args: [this.parseUnary()] }; }
    return this.parsePow();
  }
  parsePow() {
    const e = this.parsePrimary();
    if (this.tok.type === T.POW) { this.lex(); return this.bin("pow", e, this.parseUnary()); }
    return e;
  }
  parseArgs() {
    const args = [];
    this.expect("(");
    if (this.isChar(")")) { this.lex(); return args; }
    args.push(this.parseStatement());
    while (this.isChar(",")) { this.lex(); args.push(this.parseStatement()); }
    this.expect(")");
    return args;
  }
  op(code, args) { return { kind: "op", code, args }; }
  num(v) { return { kind: "num", val: v }; }
  badArgs(name) { this.fail("Wrong number of arguments: " + name); }

  parsePrimary() {
    const t = this.tok;
    switch (t.type) {
      case T.NUMBER: this.lex(); return this.num(t.val);
      case T.STRING: this.fail("Unexpected string: " + t.text);
      case T.NEWVAR: this.fail("Unexpected symbol: " + t.text);
      case T.SEQNAME: {
        this.lex();
        let id = this.seqNames.get(t.text);
        if (id === undefined) { id = this.seqNames.size + 1; this.seqNames.set(t.text, id); }
        const n = { kind: "seq", id, args: [], code: "s" };
        if (this.isChar("[")) {
          this.lex();
          n.args.push(this.parseStatement());
          while (this.isChar(",")) { this.lex(); n.args.push(this.parseStatement()); }
          this.expect("]");
          n.code = n.args.length === 1 ? "st" : n.args.length === 2 ? "sxy" : n.args.length === 3 ? "sxyt" : this.fail("Bad sequence reference: $" + t.text);
        } else if (this.isChar("{")) {
          this.lex();
          const d = this.parseStatement(); this.expect(","); const a = this.parseStatement(); this.expect("}");
          n.args = [d, a]; n.code = "sda";
        }
        return n;
      }
      case T.SAMPLE: { this.lex(); const a = this.parseArgs(); if (!a.length) return this.op("sampleN", []); if (a.length === 2) return this.op("sampleN2", a); this.badArgs("sample"); }
      case T.SAMPLEP: { this.lex(); const a = this.parseArgs(); if (!a.length) return this.op("sampleP", []); if (a.length === 2) return this.op("sampleP2", a); this.badArgs("samplep"); }
      case T.NOISE: { this.lex(); const a = this.parseArgs();
        if (!a.length) return this.op("noiseFast", []); if (a.length === 2) return this.op("noise2d", a);
        if (a.length === 3) return this.op("noise3d", a); if (a.length === 6) return this.op("fbm", a); this.badArgs("noise"); }
      case T.NOISE2: { this.lex(); const a = this.parseArgs();
        if (a.length === 2) { a.push(this.num(2)); return this.op("noisetest", a); } if (a.length === 3) return this.op("noisetest", a); this.badArgs("noise2"); }
      case T.WNOISE1: case T.WNOISE2: { this.lex(); const a = this.parseArgs(); if (a.length) this.badArgs("wnoise");
        this.flags.hasWorley2 = true; return this.op(t.type === T.WNOISE1 ? "wnoise1" : "wnoise2", []); }
      case T.FNOISE: { this.lex(); const a = this.parseArgs();
        if (!a.length) return this.op("fnoiseFast", []); if (a.length === 2) return this.op("fnoise2d", a);
        if (a.length === 3) return this.op("fnoise3d", a); if (a.length === 6) return this.op("fbm", a); this.badArgs("fnoise"); }
      case T.TURB: { this.lex(); const a = this.parseArgs();
        if (!a.length) return this.op("turbFast", []); if (a.length === 2) return this.op("turb2d", a);
        if (a.length === 3) return this.op("turb3d", a); if (a.length === 6) return this.op("fbmt", a); this.badArgs("turb"); }
      case T.TERP: { this.lex(); const a = this.parseArgs(); if (a.length === 2) return this.op("terp", a); if (a.length === 3) return this.op("terpt", a); this.badArgs("terp"); }
      case T.PINCH: { this.lex(); const a = this.parseArgs(); if (a.length === 1) { a.push(this.num(2)); return this.op("pinch", a); } if (a.length === 2) return this.op("pinch", a); this.badArgs("pinch"); }
      case T.EASE: { this.lex(); const a = this.parseArgs();
        if (!a.length) return this.op("ease", [{ kind: "var", code: "V.localScaledTime" }]); if (a.length === 1) return this.op("ease", a);
        if (a.length === 2) return this.op("gain", a); this.badArgs("ease"); }
      case T.BIAS: { this.lex(); const a = this.parseArgs();
        if (a.length === 1) return this.op("bias", [{ kind: "var", code: "V.localScaledTime" }, a[0]]); if (a.length === 2) return this.op("bias", a); this.badArgs("bias"); }
      case T.GAIN: { this.lex(); const a = this.parseArgs();
        if (a.length === 1) return this.op("gain", [{ kind: "var", code: "V.localScaledTime" }, a[0]]); if (a.length === 2) return this.op("gain", a); this.badArgs("gain"); }
      case T.MANDEL: { this.lex(); const a = this.parseArgs(); if (!a.length) { this.flags.hasMandel = true; return this.op("mandelFast", []); } if (a.length === 2) return this.op("mandel2", a); this.badArgs("mandel"); }
      case T.MANDELQ: { this.lex(); const a = this.parseArgs(); if (!a.length) { this.flags.hasMandelQ = true; return this.op("mandelqFast", []); } if (a.length === 2) return this.op("mandelq2", a); this.badArgs("mandelq"); }
      case T.JULIA: { this.lex(); const a = this.parseArgs(); if (!a.length) { this.flags.hasJulia = true; return this.op("juliaFast", []); } if (a.length === 2) return this.op("julia2", a); if (a.length === 4) return this.op("julia4", a); this.badArgs("julia"); }
      case T.VARIABLE: { this.lex(); if (this.isChar("(")) this.fail("Unknown function: " + t.text); return { kind: "var", code: t.code }; }
      case T.FUNCTION: { this.lex(); const a = this.parseArgs(); if (t.argc >= 0 && a.length !== t.argc) this.badArgs(t.text); return this.op(t.op, a); }
      case T.CHARVAR: {
        this.lex();
        const c = t.code;
        if (this.isChar("[")) {
          this.lex(); const x = this.parseStatement(); this.expect(","); const y = this.parseStatement(); this.expect("]");
          if (!"rgb".includes(c)) this.fail(`Not implemented: ${c}[x,y]`);
          return this.op(c === "r" ? "red" : c === "g" ? "green" : "blue", [x, y]);
        }
        return { kind: "charvar", code: c };
      }
      case T.CHAR:
        if (t.code === "?") { this.lex(); return { kind: "rand" }; }
        if (t.code === "(") { this.lex(); if (this.isChar(")")) this.fail("parse error: empty parentheses"); const e = this.parseStatement(); this.expect(")"); return e; }
        break;
    }
    this.fail("parse error");
  }
}

// ---------------------------------------------------------------- code generation

// n(x): the number of a value (a triple's last component, as the VM's PopF)
const PRELUDE = `
const n = (v) => typeof v === "number" ? v : v[2];
const t3 = (v) => typeof v === "number" ? [v, v, v] : v;
`;

function gen(node, ctx) {
  switch (node.kind) {
    case "num": return numLit(node.val);
    case "var": return node.code;
    case "rand": return "F.random()";
    case "charvar": return `F.charvar(V,"${node.code}")`;
    case "cond": return `(n(${gen(node.args[0], ctx)})!==0?${gen(node.args[1], ctx)}:${gen(node.args[2], ctx)})`;
    case "seq": {
      const a = node.args.map((k) => `n(${gen(k, ctx)})`);
      switch (node.code) {
        case "s": return `S.at(${node.id},V)`;
        case "st": return `S.atT(${node.id},V,${a[0]})`;
        case "sxy": return `S.atXY(${node.id},V,${a[0]},${a[1]})`;
        case "sxyt": return `S.atXYT(${node.id},V,${a[0]},${a[1]},${a[2]})`;
        case "sda": return `S.atDA(${node.id},V,${a[0]},${a[1]})`;
      }
      break;
    }
    case "op": {
      const g = node.args.map((k) => gen(k, ctx));
      const a = g.map((s) => `n(${s})`);
      switch (node.code) {
        case "add": return `(${a[0]}+${a[1]})`;
        case "sub": return `(${a[0]}-${a[1]})`;
        case "mul": return `(${a[0]}*${a[1]})`;
        case "div": return `F.div(${a[0]},${a[1]})`;
        case "neg": return `(-${a[0]})`;
        case "mod": return `F.mod(${a[0]},${a[1]})`;
        case "pow": return `Math.pow(${a[0]},${a[1]})`;
        case "pow2": return `Math.pow(2,${a[0]})`;
        case "int": return `F.trunc(${a[0]})`;
        case "and": return `(F.trunc(${a[1]})&F.trunc(${a[0]}))`;
        case "or": return `(F.trunc(${a[1]})|F.trunc(${a[0]}))`;
        case "xor": return `(F.trunc(${a[1]})^F.trunc(${a[0]}))`;
        case "inv": return `(~F.trunc(${a[0]}))`;
        case "cmp==": return `(${a[0]}===${a[1]}?1:0)`;
        case "cmp!=": return `(${a[0]}===${a[1]}?0:1)`;
        case "cmp>": return `(${a[0]}>${a[1]}?1:0)`;
        case "cmp>=": return `(${a[0]}>=${a[1]}?1:0)`;
        case "cmp<": return `(${a[0]}<${a[1]}?1:0)`;
        case "cmp<=": return `(${a[0]}<=${a[1]}?1:0)`;
        case "not": return `(${a[0]}===0?1:0)`;
        case "land": return `((${a[0]}!==0&&${a[1]}!==0)?1:0)`;
        case "lor": return `((${a[0]}!==0||${a[1]}!==0)?1:0)`;
        case "angle": return `F.angle(${a[0]},${a[1]})`;
        case "dist": return `F.dist(${a[0]},${a[1]})`;
        case "sqrt": return `Math.sqrt(${a[0]})`;
        case "log": return `Math.log(${a[0]})`;
        case "log10": return `Math.log10(${a[0]})`;
        case "abs": return `Math.abs(${a[0]})`;
        case "sign": return `(${a[0]}<0?-1:1)`;
        case "exp": return `Math.exp(${a[0]})`;
        case "cos": return `Math.cos(${a[0]})`;
        case "sin": return `Math.sin(${a[0]})`;
        case "tan": return `Math.tan(${a[0]})`;
        case "acos": return `Math.acos(${a[0]})`;
        case "asin": return `Math.asin(${a[0]})`;
        case "atan": return `Math.atan(${a[0]})`;
        case "cosh": return `Math.cosh(${a[0]})`;
        case "sinh": return `Math.sinh(${a[0]})`;
        case "tanh": return `Math.tanh(${a[0]})`;
        case "sin2": return `F.sin2(${a[0]})`;
        case "cos2": return `F.cos2(${a[0]})`;
        case "sin3": return `F.sin3(${a[0]})`;
        case "cos3": return `F.cos3(${a[0]})`;
        case "mandel2": return `F.mandel(${a[0]},${a[1]},V.recur)`;
        case "mandelFast": return `F.lastMandelVal`;
        case "mandelq2": return `F.mandelq(V.x,V.y,${a[0]},${a[1]},V.recur)`;
        case "mandelqFast": return `F.lastMandelQVal`;
        case "mandelcpm": return `F.mandelcpm(V.x,V.y,V.recur)`;
        case "mandel3": return `F.mandel3(V.x,V.y,V.recur)`;
        case "juliaFast": return `F.lastJuliaVal`;
        case "julia2": return `F.julia(V.x,V.y,${a[0]},${a[1]},V.recur)`;
        case "julia4": return `F.julia(${a[0]},${a[1]},${a[2]},${a[3]},V.recur)`;
        case "dragon": return `F.dragon(V.x,V.y,V.p0,V.q0,V.recur)`;
        case "zebra": return `F.zebra(${a[0]},${a[1]},${a[2]},${a[3]})`;
        case "fib": return `F.fib(F.trunc(${a[0]}))`;
        case "prime": return `F.prime(F.trunc(${a[0]}))`;
        case "fbm": return `F.fbm(${a.join(",")})`;
        case "fbmt": return `F.fbmt(${a.join(",")})`;
        case "noiseFast": return `F.gnoise2d(V.x,V.y)`;
        case "noise2d": return `F.gnoise2d(${a[0]},${a[1]})`;
        case "noisetest": return `F.gnoisetest(${a[0]},${a[1]},0,${a[2]})`;
        case "noise3d": return `F.gnoise3d(${a[0]},${a[1]},${a[2]})`;
        case "fnoiseFast": return `F.fnoise2d(V.x,V.y)`;
        case "fnoise2d": return `F.fnoise2d(${a[0]},${a[1]})`;
        case "fnoise3d": return `F.fnoise3d(${a[0]},${a[1]},${a[2]})`;
        case "turbFast": return `F.turb2d(V.x,V.y)`;
        case "turb2d": return `F.turb2d(${a[0]},${a[1]})`;
        case "turb3d": return `F.turb3d(${a[0]},${a[1]},${a[2]})`;
        case "wnoise1": return `F.wd1`;
        case "wnoise2": return `F.wd2`;
        case "terp": return `F.terp(${g[0]},${g[1]},V.localScaledTime)`;
        case "terpt": return `F.terp(${g[0]},${g[1]},${a[2]})`;
        case "pinch": return `F.pinch(${g[0]},${a[1]})`;
        case "ease": return `F.ease(${g[0]})`;
        case "bias": return `F.bias(${g[0]},${a[1]})`;
        case "gain": return `F.gain(${g[0]},${a[1]})`;
        case "min": return `F.min(${a[0]},${a[1]})`;
        case "max": return `F.max(${a[0]},${a[1]})`;
        case "clamp": return `F.clamp(${a[0]},${a[1]},${a[2]})`;
        case "limit": return `F.limit(${a[0]},${a[1]},${a[2]})`;
        case "linen": return `F.linen(${a.join(",")})`;
        case "linenr": return `F.linenr(${a.join(",")})`;
        case "red": return `F.imageChannel(V,${a[0]},${a[1]},0)`;
        case "green": return `F.imageChannel(V,${a[0]},${a[1]},1)`;
        case "blue": return `F.imageChannel(V,${a[0]},${a[1]},2)`;
        case "sampleN": return `F.sample(V,V.x,V.y)`;
        case "sampleN2": return `F.sample(V,${a[0]},${a[1]})`;
        case "sampleP": return `F.sampleP(V,V.px,V.py)`;
        case "sampleP2": return `F.sampleP(V,${a[0]},${a[1]})`;
        case "rgb": return `[${a[0]},${a[1]},${a[2]}]`;
        case "hsv": return `F.hsvToRgb([${a[0]},${a[1]},${a[2]}])`;
      }
      throw new ExprError("unknown op " + node.code);
    }
  }
  throw new ExprError("bad node");
}

function numLit(v) {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "(-Infinity)";
  const s = String(v);
  return v < 0 ? `(${s})` : s;
}

// Compiles source to {fn: (V, F, S) => value, flags, src}. An empty expression gives 0.
export function compileExpr(source, seqNames) {
  const p = new Parser(source, seqNames);
  const tree = p.parse();
  const body = tree ? gen(tree, {}) : "0";
  // mand(), julia(), mandq(), wnoise1/2() with no arguments: computed once per pixel
  // before the expression runs (one of them, in the VM's order of precedence)
  const f = p.flags;
  const pre = f.hasMandel ? "F.mandel(V.x,V.y,V.recur);" : f.hasMandelQ ? "F.mandelq(V.x,V.y,V.p0,V.q0,V.recur);"
            : f.hasJulia ? "F.julia(V.x,V.y,V.p0,V.q0,V.recur);" : f.hasWorley2 ? "F.worley2(V.x,V.y);" : "";
  const code = `${PRELUDE}return function(V,F,S){ ${pre} return ${body}; }`;
  let fn;
  try { fn = new Function(code)(); }
  catch (e) { throw new ExprError("internal: " + e.message + " in " + body); }
  return { fn, flags: p.flags, src: source, body };
}
