// funcs.js -- noise, fractals, easing, colour and random for the JS engine (follows
// src/expr_funcs.cpp). One Funcs instance per renderer: it carries the per-pixel caches.

export const pi = 3.1415926535897932;
const INT_MIN = -2147483648;

// (int) of a double as 32-bit Windows did it: out of range and NaN give INT_MIN
export function trunc(d) {
  return d > -2147483649 && d < 2147483648 ? Math.trunc(d) : INT_MIN;
}

const R_A = 16807, R_M = 2147483647, R_Q = 127773, R_R = 2836;
function nextRandom(st) {
  const hi = Math.trunc(st.seed / R_Q), lo = st.seed % R_Q;
  const test = R_A * lo - R_R * hi;
  st.seed = test > 0 ? test : test + R_M;
  return st.seed;
}

const TABSIZE = 256, TABMASK = 255;
const perm = new Uint8Array([
  225,155,210,108,175,199,221,144,203,116, 70,213, 69,158, 33,252,
    5, 82,173,133,222,139,174, 27,  9, 71, 90,246, 75,130, 91,191,
  169,138,  2,151,194,235, 81,  7, 25,113,228,159,205,253,134,142,
  248, 65,224,217, 22,121,229, 63, 89,103, 96,104,156, 17,201,129,
   36,  8,165,110,237,117,231, 56,132,211,152, 20,181,111,239,218,
  170,163, 51,172,157, 47, 80,212,176,250, 87, 49, 99,242,136,189,
  162,115, 44, 43,124, 94,150, 16,141,247, 32, 10,198,223,255, 72,
   53,131, 84, 57,220,197, 58, 50,208, 11,241, 28,  3,192, 62,202,
   18,215,153, 24, 76, 41, 15,179, 39, 46, 55,  6,128,167, 23,188,
  106, 34,187,140,164, 73,112,182,244,195,227, 13, 35, 77,196,185,
   26,200,226,119, 31,123,168,125,249, 68,183,230,177,135,160,180,
   12,  1,243,148,102,166, 38,238,251, 37,240,126, 64, 74,161, 40,
  184,149,171,178,101, 66, 29, 59,146, 61,254,107, 42, 86,154,  4,
  236,232,120, 21,233,209, 45, 98,193,114, 78, 19,206, 14,118,127,
   48, 79,147, 85, 30,207,219, 54, 88,234,190,122, 95, 67,143,109,
  137,214,145, 93, 92,100,245,  0,216,186, 60, 83,105, 97,204, 52]);

const gradientTab = new Float64Array(TABSIZE * 3);
{
  const st = { seed: 665 };
  for (let i = 0; i < TABSIZE; i++) {
    const z = 1 - 2 * (nextRandom(st) / R_M);
    const r = Math.sqrt(1 - z * z);
    const theta = 2 * pi * (nextRandom(st) / R_M);
    gradientTab[i * 3] = r * Math.cos(theta);
    gradientTab[i * 3 + 1] = r * Math.sin(theta);
    gradientTab[i * 3 + 2] = z;
  }
}

const EASE = (x) => x * x * (3 - 2 * x);
const LERP = (t, a, b) => a + t * (b - a);
function qfloor(x) { const ix = trunc(x); return ix - (x < 0 && x !== ix ? 1 : 0); }
function glattice(ix, iy, iz, fx, fy, fz) {
  const g = (perm[(ix + perm[(iy + perm[iz & TABMASK]) & TABMASK]) & TABMASK]) * 3;
  return gradientTab[g] * fx + gradientTab[g + 1] * fy + gradientTab[g + 2] * fz;
}

export function gnoise3d(x, y, z) {
  const ix = qfloor(x), fx0 = x - ix, fx1 = fx0 - 1, wx = EASE(fx0);
  const iy = qfloor(y), fy0 = y - iy, fy1 = fy0 - 1, wy = EASE(fy0);
  const iz = qfloor(z), fz0 = z - iz, fz1 = fz0 - 1, wz = EASE(fz0);
  let vx0 = glattice(ix, iy, iz, fx0, fy0, fz0), vx1 = glattice(ix + 1, iy, iz, fx1, fy0, fz0);
  let vy0 = LERP(wx, vx0, vx1);
  vx0 = glattice(ix, iy + 1, iz, fx0, fy1, fz0); vx1 = glattice(ix + 1, iy + 1, iz, fx1, fy1, fz0);
  let vy1 = LERP(wx, vx0, vx1);
  const vz0 = LERP(wy, vy0, vy1);
  vx0 = glattice(ix, iy, iz + 1, fx0, fy0, fz1); vx1 = glattice(ix + 1, iy, iz + 1, fx1, fy0, fz1);
  vy0 = LERP(wx, vx0, vx1);
  vx0 = glattice(ix, iy + 1, iz + 1, fx0, fy1, fz1); vx1 = glattice(ix + 1, iy + 1, iz + 1, fx1, fy1, fz1);
  vy1 = LERP(wx, vx0, vx1);
  const vz1 = LERP(wy, vy0, vy1);
  return LERP(wz, vz0, vz1);
}

export function gnoise2d(x, y) {
  const ix = qfloor(x), fx0 = x - ix, fx1 = fx0 - 1, wx = EASE(fx0);
  const iy = qfloor(y), fy0 = y - iy, fy1 = fy0 - 1, wy = EASE(fy0);
  let vx0 = glattice(ix, iy, 0, fx0, fy0, 0), vx1 = glattice(ix + 1, iy, 0, fx1, fy0, 0);
  const vy0 = LERP(wx, vx0, vx1);
  vx0 = glattice(ix, iy + 1, 0, fx0, fy1, 0); vx1 = glattice(ix + 1, iy + 1, 0, fx1, fy1, 0);
  const vy1 = LERP(wx, vx0, vx1);
  return LERP(wy, vy0, vy1);
}

const log_half = Math.log(0.5);
const BIAS = (x, p) => Math.pow(x, Math.log(p) / log_half);
const GAIN = (x, p) => x < .5 ? BIAS(2 * x, 1 - p) / 2 : 1 - BIAS(2 - 2 * x, 1 - p) / 2;

export function gnoisetest(x, y, z, p) {
  const ix = qfloor(x), fx0 = x - ix, fx1 = fx0 - 1, wx = GAIN(fx0, p);
  const iy = qfloor(y), fy0 = y - iy, fy1 = fy0 - 1, wy = GAIN(fy0, p);
  const iz = qfloor(z), fz0 = z - iz, fz1 = fz0 - 1, wz = GAIN(fz0, p);
  let vx0 = glattice(ix, iy, iz, fx0, fy0, fz0), vx1 = glattice(ix + 1, iy, iz, fx1, fy0, fz0);
  let vy0 = LERP(wx, vx0, vx1);
  vx0 = glattice(ix, iy + 1, iz, fx0, fy1, fz0); vx1 = glattice(ix + 1, iy + 1, iz, fx1, fy1, fz0);
  let vy1 = LERP(wx, vx0, vx1);
  const vz0 = LERP(wy, vy0, vy1);
  vx0 = glattice(ix, iy, iz + 1, fx0, fy0, fz1); vx1 = glattice(ix + 1, iy, iz + 1, fx1, fy0, fz1);
  vy0 = LERP(wx, vx0, vx1);
  vx0 = glattice(ix, iy + 1, iz + 1, fx0, fy1, fz1); vx1 = glattice(ix + 1, iy + 1, iz + 1, fx1, fy1, fz1);
  vy1 = LERP(wx, vx0, vx1);
  const vz1 = LERP(wy, vy0, vy1);
  return LERP(wz, vz0, vz1);
}

export function fnoise3d(x, y, z) {
  let turb = gnoise3d(x, y, z), s = 1;
  for (let i = 7; i > 0; --i) { s *= 2; turb += 1 / s * gnoise3d(x * s, y * s, z * s); }
  return turb;
}
export function fnoise2d(x, y) {
  let turb = gnoise2d(x, y), s = 1;
  for (let i = 7; i > 0; --i) { s *= 2; turb += 1 / s * gnoise2d(x * s, y * s); }
  return turb;
}
export function turb3d(x, y, z) {
  let turb = Math.abs(gnoise3d(x, y, z)), s = 1;
  for (let i = 7; i > 0; --i) { s *= 2; turb += 1 / s * Math.abs(gnoise3d(x * s, y * s, z * s)); }
  return turb;
}
export function turb2d(x, y) {
  let turb = Math.abs(gnoise2d(x, y)), s = 1;
  for (let i = 7; i > 0; --i) { s *= 2; turb += 1 / s * Math.abs(gnoise2d(x * s, y * s)); }
  return turb;
}
export function fbm(x, y, z, H, lac, octaves) {
  let result = gnoise3d(x, y, z), frequency = 1;
  for (let i = octaves - 1; i >= 0; i--) {
    x *= lac; y *= lac; z *= lac; frequency *= lac;
    let amplitude = Math.pow(frequency, -H);
    if (i < 1) amplitude *= i;
    result += amplitude * gnoise3d(x, y, z);
    if (amplitude < 0.00000000001) break;
  }
  return result;
}
export function fbmt(x, y, z, H, lac, octaves) {
  let result = Math.abs(gnoise3d(x, y, z)), frequency = 1;
  for (let i = octaves - 1; i >= 0; i--) {
    x *= lac; y *= lac; z *= lac; frequency *= lac;
    let amplitude = Math.pow(frequency, -H);
    if (i < 1) amplitude *= i;
    result += amplitude * Math.abs(gnoise3d(x, y, z));
    if (amplitude < 0.00000000001) break;
  }
  return result;
}

export function angle(xd, yd) {
  const r = Math.sqrt(xd * xd + yd * yd);
  if (r === 0) return 0;
  return yd > 0 ? pi * 2 - Math.acos(xd / r) : Math.acos(xd / r);
}
export function dist(xd, yd) { return Math.sqrt(xd * xd + yd * yd); }

export function hsvToRgb(c) {
  if (typeof c === "number") c = [c, c, c];
  let h = 360 * c[0];
  const s = c[1], v = c[2];
  if (s === 0) return [v, v, v];
  if (h >= 360) h = 0; else h /= 60;
  const i = trunc(h), f = h - i, m = v * (1 - s), n = v * (1 - s * f), k = v * (1 - s * (1 - f));
  switch (i) {
    case 0: return [v, k, m];
    case 1: return [n, v, m];
    case 2: return [m, v, k];
    case 3: return [m, n, v];
    case 4: return [k, m, v];
    default: return [v, m, n];
  }
}

const map3 = (c, f) => typeof c === "number" ? f(c) : [f(c[0]), f(c[1]), f(c[2])];

export class Funcs {
  constructor() {
    this.rand = { seed: 1 };
    this.lastMandelX = -2; this.lastMandelY = -2; this.lastMandelVal = 0;
    this.lastMandelQX = -2; this.lastMandelQY = -2; this.lastMandelQVal = 0;
    this.lastMandelCPMX = -2; this.lastMandelCPMY = -2; this.lastMandelCPM = 0;
    this.lastMandel3X = -2; this.lastMandel3Y = -2; this.lastMandel3Val = 0;
    this.lastDragonX = -2; this.lastDragonY = -2; this.lastDragonVal = 0;
    this.lastJuliaX = -2; this.lastJuliaY = -2; this.lastJuliaVal = 0;
    this.wd1 = 0; this.wd2 = 0;
    // module functions, reachable as F.xxx from generated code
    this.gnoise2d = gnoise2d; this.gnoise3d = gnoise3d; this.gnoisetest = gnoisetest;
    this.fnoise2d = fnoise2d; this.fnoise3d = fnoise3d; this.turb2d = turb2d; this.turb3d = turb3d;
    this.fbm = fbm; this.fbmt = fbmt; this.angle = angle; this.dist = dist; this.trunc = trunc;
    this.hsvToRgb = hsvToRgb;
  }
  seedRandom(s) { this.rand.seed = s === 0 ? 1 : s; }
  random() { return nextRandom(this.rand) / R_M; }

  div(a, b) { return b === 0 ? Infinity : a / b; }
  mod(a, b) { const lb = trunc(b), la = trunc(a); return lb === 0 ? 0 : la % lb; }
  sin2(x) { const v = Math.sin(x); return v * v; }
  cos2(x) { const v = Math.cos(x); return v * v; }
  sin3(x) { const v = Math.sin(x); return v * v * v; }
  cos3(x) { const v = Math.cos(x); return v * v * v; }
  min(a, b) { return a <= b ? a : b; }
  max(a, b) { return a >= b ? a : b; }
  clamp(v, a, b) { return v <= a ? a : v >= b ? b : v; }
  limit(v, lo, hi) { if (hi < lo) return (hi - lo) / 2; return v < lo ? lo : v > hi ? hi : v; }
  sphereX(u, v) { return Math.cos(pi * (v - .5)) * Math.sin(2 * pi * u); }
  sphereY(u, v) { return Math.cos(pi * (v - .5)) * Math.cos(2 * pi * u); }
  sphereZ(u, v) { return Math.sin(pi * (v - .5)); }

  terp(a, b, t) {
    if (t < 0) t = 0; if (t > 1) t = 1;
    const it = 1 - t;
    if (typeof a === "number" && typeof b === "number") return a * it + b * t;
    const A = typeof a === "number" ? [a, a, a] : a, B = typeof b === "number" ? [b, b, b] : b;
    return [A[0] * it + B[0] * t, A[1] * it + B[1] * t, A[2] * it + B[2] * t];
  }
  ease(c) { return map3(c, EASE); }
  bias(c, p) { return map3(c, (x) => BIAS(x, p)); }
  gain(c, p) { return map3(c, (x) => GAIN(x, p)); }
  pinch(c, p) { return map3(c, (x) => 1 - Math.pow(1 - x, p)); }

  linen(t, atk, dur, dcy) {
    if (t < 0 || t > dur) return 0;
    if (dcy > dur) dcy = dur;
    if (atk > 0 && t < atk) return t / atk;
    let sdcy = dur - dcy; if (sdcy < 0) sdcy = 0;
    if (dcy > 0 && t >= sdcy) return 1 - (t - sdcy) / dcy;
    return 1;
  }
  linenr(t, atk, dcy, atdec) {
    if (t < 0 || t > atk + dcy) return 0;
    if (atk > 0 && t < atk) return t / atk;
    return Math.pow(atdec, (t - atk) / dcy);
  }
  fib(x) { let n = 1, n1 = 0; if (x > 46) x = 46; while (x-- > 0) { const tmp = n1; n1 = n; n = n + tmp; } return n; }
  prime(n) {
    if (n < 4) return 1;
    if (!(n & 1)) return 0;
    let x = 3, l = Math.trunc(n / x);
    while (x < l) { if (x * l === n) return 0; x += 2; l = Math.trunc(n / x); }
    return 1;
  }
  zebra(n, width, step, offset) {
    const lwidth = trunc(width), lstep = trunc(step);
    if (n === 0 || lwidth === 0) return 0;
    let ln = trunc(n + offset);
    if (ln & 1) ln += lstep;
    if (Math.trunc(ln / lwidth) & 1) return (lwidth - 1) - (ln % lwidth);
    return ln % lwidth;
  }

  // fractals
  mandel(p0, q0, recur) {
    if (p0 === this.lastMandelX && q0 === this.lastMandelY) return this.lastMandelVal;
    let x = 0, y = 0, x1 = 0, y1 = 0, kol = 0;
    do {
      x1 = x1 - y1 + p0; y1 = 2 * x * y + q0; ++kol; x = x1; y = y1; x1 *= x1; y1 *= y1;
    } while (kol <= recur && x1 + y1 < 4);
    if (kol > recur) kol = 0;
    this.lastMandelX = p0; this.lastMandelY = q0; this.lastMandelVal = kol;
    return kol;
  }
  mandelq(qw, qx, qy, qz, recur) {
    if (qw === this.lastMandelQX && qx === this.lastMandelQY) return this.lastMandelQVal;
    let rw = 0, rx = 0, ry = 0, rz = 0, kol = 0;
    do {
      const tmp = 2 * rw;
      const rx2 = tmp * rx, ry2 = tmp * ry, rz2 = tmp * rz, rw2 = rw * rw - (rx * rx + ry * ry + rz * rz);
      rw = rw2 + qw; rx = rx2 + qx; ry = ry2 + qy; rz = rz2 + qz;
      ++kol;
    } while (kol <= recur && rw * rw + rx * rx < 4);
    if (kol > recur) kol = 0;
    this.lastMandelQX = qw; this.lastMandelQY = qx; this.lastMandelQVal = kol;
    return kol;
  }
  mandelcpm(p0, q0, recur) {
    if (p0 === this.lastMandelCPMX && q0 === this.lastMandelCPMY) return this.lastMandelCPM;
    let x = 0, y = 0, x1 = 0, y1 = 0, kol = 0;
    do {
      x1 = x1 - y1 + p0; y = 2 * x * y + q0; x = x1; y1 = y; x1 *= x1; y1 *= y1; ++kol;
    } while (kol <= recur && x1 + y1 < 10000);
    const sumxy = x1 + y1;
    const r = kol > recur ? 0 : 0.5 * Math.log(sumxy) / Math.pow(2, kol);
    this.lastMandelCPMX = p0; this.lastMandelCPMY = q0; this.lastMandelCPM = r;
    return r;
  }
  dragon(x0, y0, p0, q0, recur) {
    if (p0 === this.lastDragonX && q0 === this.lastDragonY) return this.lastDragonVal;
    let x = p0, y = q0, x1, y1, kol = 0;
    do {
      x1 = x * x0 - y * y0; y1 = y * x0 + x * y0;
      x = x1 - x * x1 + y * y1; y = y1 - x * y1 + y * y1 - y * x1;
      ++kol;
    } while (kol <= recur && x + y < 4);
    if (kol > recur) kol = 0;
    this.lastDragonX = p0; this.lastDragonY = q0; this.lastDragonVal = kol;
    return kol;
  }
  mandel3(p0, q0, recur) {
    if (p0 === this.lastMandel3X && q0 === this.lastMandel3Y) return this.lastMandel3Val;
    let x = 0, y = 0, x2 = 0, y2 = 0, kol = 0;
    do {
      const x1 = x2 * x - 3 * x * y2 + p0, y1 = 3 * x2 * y - y2 * y + q0;
      ++kol; x = x1; y = y1; x2 = x * x; y2 = y * y;
    } while (kol <= recur && x2 + y2 < 4);
    if (kol > recur) kol = 0;
    this.lastMandel3X = p0; this.lastMandel3Y = q0; this.lastMandel3Val = kol;
    return kol;
  }
  julia(x, y, p0, q0, recur) {
    if (x === this.lastJuliaX && y === this.lastJuliaY) return this.lastJuliaVal;
    this.lastJuliaX = x; this.lastJuliaY = y;
    let x1 = x * x, y1 = y * y, kol = 0;
    do {
      x1 = x1 - y1 + p0; y1 = 2 * x * y + q0; ++kol; x = x1; y = y1; x1 *= x1; y1 *= y1;
    } while (kol <= recur && x1 + y1 < 4);
    if (kol > recur) kol = 0;
    this.lastJuliaVal = kol;
    return kol;
  }
  worley2(x, y) {
    const ss = Math.floor(x) + .5, tt = Math.floor(y) + .5;
    let md = 1000, md2 = 1000;
    for (let i = -1; i <= 1; ++i) {
      const s = ss + i;
      for (let j = -1; j <= 1; ++j) {
        const t = tt + j;
        const sp = s + (gnoise2d(s, t) - 0.5), tp = t + (gnoise2d(s + 3, t + 5) - 0.5);
        const sd = sp - x, td = tp - y, d = sd * sd + td * td;
        if (d < md) { md2 = md; md = d; } else if (d < md2) md2 = d;
      }
    }
    this.wd1 = Math.sqrt(md); this.wd2 = Math.sqrt(md2);
  }

  // images: packed 0xBBGGRR like the C++ (black outside)
  imageChannel(V, x, y, ch) {
    const img = V.image;
    if (!img) return 0;
    const p = img.getPixel(trunc(x * img.width), trunc(y * img.height));
    return (p >> (ch * 8)) & 255;
  }
  sample(V, x, y) {
    const img = V.image;
    const p = img ? img.sample(x, y, V.tileMode) : 0;
    return [(p & 255) / 255, ((p >> 8) & 255) / 255, ((p >> 16) & 255) / 255];
  }
  sampleP(V, x, y) {
    const img = V.image;
    const p = img ? img.sample(x / img.width, y / img.height, V.tileMode) : 0;
    return [(p & 255) / 255, ((p >> 8) & 255) / 255, ((p >> 16) & 255) / 255];
  }
  charvar(V, c) {
    const img = V.image;
    const p = img ? img.getPixel(Math.trunc((V.px * img.width) / V.pw), Math.trunc((V.py * img.height) / V.ph)) : 0;
    const red = p & 255, grn = (p >> 8) & 255, blu = (p >> 16) & 255;
    if (c === "r") return red;
    if (c === "g") return grn;
    if (c === "b") return blu / 255;
    const value = Math.max(red, grn, blu), minVal = Math.min(red, grn, blu);
    if (c === "l") return value;
    if (c === "s") return value === 0 ? 0 : (value - minVal) * 255 / value;
    if (value === 0 || value === minVal) return 0;
    const div = value - minVal, cr = (value - red) / div, cg = (value - grn) / div, cb = (value - blu) / div;
    let hue = red === value ? cb - cg : grn === value ? 2 + cr - cb : blu === value ? 4 + cg - cr : 0;
    hue *= 60; if (hue < 0) hue += 360;
    return hue * 255 / 360;
  }
}
