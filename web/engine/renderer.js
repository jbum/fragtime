// renderer.js -- renders a frame of a Script into RGBA (follows src/renderer.cpp:
// layers back to front, oversampling, pinning into min..max, blend modes).

import { Funcs, trunc, hsvToRgb } from "./funcs.js";
import { CM, CHOP } from "./seq.js";

function rowSeed(frame, row) {
  let h = 2166136261;
  h = Math.imul(h ^ (frame >>> 0), 16777619);
  h = Math.imul(h ^ (row >>> 0), 16777619);
  h = Math.imul(h ^ 0x9e3779b9, 16777619);
  const s = h & 0x7fffffff;
  return s === 0 ? 1 : s;
}

export class Renderer {
  constructor(script, width, height, relativeSampling = false) {
    this.script = script;
    this.width = width; this.height = height;
    this.F = new Funcs();
    this.relative = relativeSampling;
    this.globalTime = 0; this.globalScaledTime = 0; this.globalFrameNbr = 0;
    this.movieDuration = script.duration;
    this.list = [];
    this.temp = null;
    const self = this;
    // sequence sampling, called from compiled expressions
    this.S = {
      at(id, V) { return self.relative ? self.sampSeq(id, (V.x - V.leftVal) / V.widthVal, (V.y - V.topVal) / V.heightVal, V, false, 0)
                                       : self.sampSeq(id, V.x, V.y, V, false, 0); },
      atT(id, V, t) { return self.relative ? self.sampSeq(id, (V.x - V.leftVal) / V.widthVal, (V.y - V.topVal) / V.heightVal, V, true, t)
                                          : self.sampSeq(id, V.x, V.y, V, true, t); },
      atXY(id, V, x, y) { return self.sampSeq(id, x, y, V, false, 0); },
      atXYT(id, V, x, y, t) { return self.sampSeq(id, x, y, V, true, t); },
      atDA(id, V, d, a) { return self.sampSeq(id, .5 + Math.cos(a) * d, .5 - Math.sin(a) * d, V, false, 0); },
    };
  }

  sampSeq(id, v1, v2, V, hasTime, tval) {
    const seq = this.script.seqByID[id - 1];
    if (!seq) return [0, 0, 0];
    const p = seq.p, sv = seq.V;
    if (p.tile) {
      if (v2 < 0) { v2 = Math.abs(v2); v2 = 1 - (v2 - trunc(v2)); } else v2 -= trunc(v2);
      if (v1 < 0) { v1 = Math.abs(v1); v1 = 1 - (v1 - trunc(v1)); } else v1 -= trunc(v1);
    }
    sv.px = V.px; sv.py = V.py;
    sv.x = sv.leftVal + v1 * sv.widthVal;
    sv.y = sv.topVal + v2 * sv.heightVal;
    sv.localScaledTime = hasTime ? tval : (this.globalTime - p.globalDebut) / p.duration;
    sv.localFrameNbr = trunc(sv.localScaledTime * p.duration * p.frameRate);
    return this.subColor(seq);
  }

  pinF(v, V) {
    if (V.wrapMode) {
      v = (v - V.minVal) * V.tranFactor;
      if (v < 0) { v = -v; v = 1 - (v - trunc(v)); } else v -= trunc(v);
    } else {
      if (v < V.minVal) v = V.minVal; else if (v > V.maxVal) v = V.maxVal; else v = (v - V.minVal) * V.tranFactor;
    }
    if (V.cycleMode) { v = v + (1 / 256) * this.globalFrameNbr; v -= trunc(v); }
    return v;
  }
  pin(c, V) {
    if (typeof c === "number") { const v = this.pinF(c, V); return [v, v, v]; }
    return [this.pinF(c[0], V), this.pinF(c[1], V), this.pinF(c[2], V)];
  }
  // the value of the pix expression as EvalF saw it: a triple's first component
  evalF(seq) { const v = seq.p.fns.pix.fn(seq.V, this.F, this.S); return typeof v === "number" ? v : v[0]; }

  // a layer's colour at V.x,V.y as [r,g,b] 0..1 (grey as a triple)
  color(seq) {
    const p = seq.p, V = seq.V;
    if (p.colormode === CM.MONO) {
      if (p.oversample) {
        const x = V.x, y = V.y;
        const r1 = this.pinF(this.evalF(seq), V);
        V.y += V.yInc / 2; const r2 = this.pinF(this.evalF(seq), V);
        V.x += V.xInc / 2; const r3 = this.pinF(this.evalF(seq), V);
        V.y = y; const r4 = this.pinF(this.evalF(seq), V);
        V.x = x;
        const v = (r1 + r2 + r3 + r4) * 0.25;
        return [v, v, v];
      }
      const v = this.pinF(this.evalF(seq), V);
      return [v, v, v];
    }
    let c;
    if (p.oversample) {
      const x = V.x, y = V.y;
      const p1 = this.pin(p.fns.pix.fn(V, this.F, this.S), V);
      V.y += V.yInc / 2; const p2 = this.pin(p.fns.pix.fn(V, this.F, this.S), V);
      V.x += V.xInc / 2; const p3 = this.pin(p.fns.pix.fn(V, this.F, this.S), V);
      V.y = y; const p4 = this.pin(p.fns.pix.fn(V, this.F, this.S), V);
      V.x = x;
      c = [(p1[0] + p2[0] + p3[0] + p4[0]) * 0.25, (p1[1] + p2[1] + p3[1] + p4[1]) * 0.25, (p1[2] + p2[2] + p3[2] + p4[2]) * 0.25];
    } else c = this.pin(p.fns.pix.fn(V, this.F, this.S), V);
    if (p.colormode === CM.HSV) c = hsvToRgb(c);
    return c;
  }

  // a sampled sequence: never oversampled, cached by position
  subColor(seq) {
    const p = seq.p, V = seq.V;
    if (V.lastX === V.x && V.lastY === V.y) return V.lastResult;
    let c;
    if (p.colormode === CM.MONO) c = this.pinF(this.evalF(seq), V);
    else {
      c = this.pin(p.fns.pix.fn(V, this.F, this.S), V);
      if (p.colormode === CM.HSV) c = hsvToRgb(c);
    }
    V.lastX = V.x; V.lastY = V.y; V.lastResult = c;
    return c;
  }

  // rows y0..y1-1 of frame frameNbr of nbrFrames (nbrFrames 1: the snapshot) into rgba
  renderFrame(frameNbr, nbrFrames, snapshot, rgba, y0 = 0, y1 = -1) {
    const w = this.width, h = this.height;
    if (y1 < 0 || y1 > h) y1 = h;
    this.globalFrameNbr = frameNbr;
    this.globalScaledTime = nbrFrames > 1 ? frameNbr / nbrFrames : snapshot;
    this.globalTime = this.globalScaledTime * this.movieDuration;
    this.list = [];
    this.script.main.initPropsForFrame(this, this.list, this.globalTime);
    const list = this.list;
    let i = 0;
    while (i + 1 < list.length && list[i + 1].p.channelOp === CHOP.normal) ++i;
    if (i >= list.length) {
      for (let k = y0 * w * 4, e = y1 * w * 4; k < e; k += 4) { rgba[k] = rgba[k + 1] = rgba[k + 2] = 0; rgba[k + 3] = 255; }
      return;
    }
    for (; i < list.length; ++i) {
      const seq = list[i];
      if (seq.isMap) continue;
      const chop = seq.p.channelOp;
      let dst = rgba;
      if (chop !== CHOP.normal) { if (!this.temp || this.temp.length !== rgba.length) this.temp = new Uint8ClampedArray(rgba.length); dst = this.temp; }
      this.renderChannel(seq, dst, y0, y1);
      if (chop !== CHOP.normal) this.mixIn(rgba, dst, chop, y0, y1);
    }
  }

  renderChannel(seq, dst, y0, y1) {
    const V = seq.V, w = this.width;
    for (let py = y0; py < y1; ++py) {
      V.py = py;
      V.y = V.topVal + V.yInc * py;
      this.F.seedRandom(rowSeed(this.globalFrameNbr, py));
      let k = py * w * 4;
      for (let px = 0; px < w; ++px) {
        V.px = px;
        V.x = px * V.xInc + V.leftVal;
        const c = this.color(seq);
        dst[k] = trunc(c[0] * 255) & 255; dst[k + 1] = trunc(c[1] * 255) & 255; dst[k + 2] = trunc(c[2] * 255) & 255; dst[k + 3] = 255;
        k += 4;
      }
    }
  }

  mixIn(dst, src, chop, y0, y1) {
    const w = this.width;
    for (let k = y0 * w * 4, e = y1 * w * 4; k < e; k += 4) {
      for (let c = 0; c < 3; ++c) {
        const a = dst[k + c], b = src[k + c];
        let r;
        switch (chop) {
          case CHOP.darken: r = a < b ? a : b; break;
          case CHOP.lighten: r = a > b ? a : b; break;
          case CHOP.multiply: r = trunc(255 * (a / 255) * (b / 255)); break;
          case CHOP.screen: r = 255 - trunc(255 * ((255 - a) / 255) * ((255 - b) / 255)); break;
          case CHOP.overlay: r = trunc(255 * ((a / 255) * ((a / 255) * (b / 255)) + ((255 - a) / 255) * (1 - ((255 - a) / 255) * ((255 - b) / 255)))); break;
          case CHOP.difference: r = Math.abs(a - b); break;
          case CHOP.exclusion: r = trunc((b / 255) * a + ((255 - b) / 255) * (255 - a)); break;
          case CHOP.softlight: r = trunc((b / 255) * Math.min(a, b) + ((255 - b) / 255) * Math.max(a, b)); break;
          case CHOP.hardlight: r = trunc(255 * ((b / 255) * ((a / 255) * (b / 255)) + ((255 - b) / 255) * (1 - ((255 - a) / 255) * ((255 - b) / 255)))); break;
          default: return;
        }
        dst[k + c] = r;
      }
    }
  }
}
