// glsl.js -- compiles a QTS script to a GLSL ES 3.00 fragment shader that renders the
// movie in real time and loops with its duration. Follows renderer.js / seq.js: every
// sequence becomes a set of functions (its properties at a time, its pix expression,
// the pinned colour, a sampler for $name), and mainImage composites the layers alive
// at the time in the renderer's order with its blend modes.
//
// The shader is written in Shadertoy's dialect (mainImage, iTime, iResolution,
// iChannelN) so it pastes there too; the player in ../shader.js supplies those.

import { Parser, ExprError } from "./expr.js";
import { CM, CHOP } from "./seq.js";
import { pi } from "./funcs.js";

export class GLSLError extends Error {}

// ---------------------------------------------------------------- the library

// name -> [dependencies, source]; only what a script uses is emitted
export const LIB = {
  qts_trunc: [[], `float qts_trunc(float v) { return v < 0.0 ? ceil(v) : floor(v); }`],
  qts_int: [["qts_trunc"], `int qts_int(float v) { return int(clamp(qts_trunc(v), -2147483000.0, 2147483000.0)); }`],
  qts_imod: [[], `int qts_imod(int a, int b) { return b == 0 ? 0 : a - b * (a / b); }`],
  qts_mod: [["qts_int", "qts_imod"], `float qts_mod(float a, float b) { return float(qts_imod(qts_int(a), qts_int(b))); }`],
  qts_div: [[], `float qts_div(float a, float b) { return b == 0.0 ? 1e30 : a / b; }`],
  qts_pow: [["qts_trunc", "qts_int", "qts_imod"], `float qts_pow(float x, float y) {
  if (x > 0.0) return pow(x, y);
  if (x == 0.0) return y == 0.0 ? 1.0 : (y > 0.0 ? 0.0 : 1e30);
  if (qts_trunc(y) != y) return 0.0;
  float p = pow(-x, y);
  return qts_imod(qts_int(y), 2) == 0 ? p : -p;
}`],
  qts_angle: [[], `float qts_angle(float xd, float yd) {
  float r = sqrt(xd * xd + yd * yd);
  if (r == 0.0) return 0.0;
  float c = acos(clamp(xd / r, -1.0, 1.0));
  return yd > 0.0 ? ${pi * 2} - c : c;
}`],
  qts_wrap: [["qts_trunc"], `float qts_wrap(float v) {
  if (v < 0.0) { v = -v; return 1.0 - (v - qts_trunc(v)); }
  return v - qts_trunc(v);
}`],
  qts_hsv: [["qts_trunc"], `vec3 qts_hsv(vec3 c) {
  float h = 360.0 * c.x, s = c.y, v = c.z;
  if (s == 0.0) return vec3(v);
  if (h >= 360.0) h = 0.0; else h /= 60.0;
  float i = qts_trunc(h), f = h - i, m = v * (1.0 - s), n = v * (1.0 - s * f), k = v * (1.0 - s * (1.0 - f));
  if (i == 0.0) return vec3(v, k, m);
  if (i == 1.0) return vec3(n, v, m);
  if (i == 2.0) return vec3(m, v, k);
  if (i == 3.0) return vec3(m, n, v);
  if (i == 4.0) return vec3(k, m, v);
  return vec3(v, m, n);
}`],
  qts_ease: [[], `float qts_ease(float x) { return x * x * (3.0 - 2.0 * x); }`],
  qts_bias: [["qts_pow"], `float qts_bias(float x, float p) { return qts_pow(x, log(p) / ${Math.log(0.5)}); }`],
  qts_gain: [["qts_bias"], `float qts_gain(float x, float p) { return x < 0.5 ? qts_bias(2.0 * x, 1.0 - p) / 2.0 : 1.0 - qts_bias(2.0 - 2.0 * x, 1.0 - p) / 2.0; }`],
  qts_pinch: [["qts_pow"], `float qts_pinch(float x, float p) { return 1.0 - qts_pow(1.0 - x, p); }`],
  qts_terp: [[], `vec3 qts_terp(vec3 a, vec3 b, float t) { t = clamp(t, 0.0, 1.0); return a * (1.0 - t) + b * t; }
float qts_terpf(float a, float b, float t) { t = clamp(t, 0.0, 1.0); return a * (1.0 - t) + b * t; }`],
  qts_limit: [[], `float qts_limit(float v, float lo, float hi) { if (hi < lo) return (hi - lo) / 2.0; return v < lo ? lo : (v > hi ? hi : v); }`],
  qts_linen: [[], `float qts_linen(float t, float atk, float dur, float dcy) {
  if (t < 0.0 || t > dur) return 0.0;
  if (dcy > dur) dcy = dur;
  if (atk > 0.0 && t < atk) return t / atk;
  float sdcy = max(dur - dcy, 0.0);
  if (dcy > 0.0 && t >= sdcy) return 1.0 - (t - sdcy) / dcy;
  return 1.0;
}`],
  qts_linenr: [["qts_pow"], `float qts_linenr(float t, float atk, float dcy, float atdec) {
  if (t < 0.0 || t > atk + dcy) return 0.0;
  if (atk > 0.0 && t < atk) return t / atk;
  return qts_pow(atdec, (t - atk) / dcy);
}`],
  qts_fib: [[], `float qts_fib(int x) { int n = 1, n1 = 0; x = min(x, 46); for (int i = 0; i < x; ++i) { int tmp = n1; n1 = n; n = n + tmp; } return float(n); }`],
  qts_prime: [["qts_imod"], `float qts_prime(int n) {
  if (n < 4) return 1.0;
  if (qts_imod(n, 2) == 0) return 0.0;
  int x = 3, l = n / x;
  for (int i = 0; i < 100000; ++i) { if (x >= l) break; if (x * l == n) return 0.0; x += 2; l = n / x; }
  return 1.0;
}`],
  qts_zebra: [["qts_int", "qts_imod"], `float qts_zebra(float n, float width, float step, float offset) {
  int lwidth = qts_int(width), lstep = qts_int(step);
  if (n == 0.0 || lwidth == 0) return 0.0;
  int ln = qts_int(n + offset);
  if (qts_imod(ln, 2) != 0) ln += lstep;
  if (qts_imod(ln / lwidth, 2) != 0) return float((lwidth - 1) - qts_imod(ln, lwidth));
  return float(qts_imod(ln, lwidth));
}`],
  qts_rand: [[], `float qts_rand(float px, float py, float fr, float salt) {
  uvec3 v = uvec3(uint(int(px)), uint(int(py)), uint(int(fr))) * uvec3(1597334673u, 3812015801u, 2798796415u) + uint(salt) * 2654435761u;
  uint h = v.x ^ v.y ^ v.z;
  h = h * 747796405u + 2891336453u; h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u; h = (h >> 22u) ^ h;
  return float(h) / 4294967296.0;
}`],
  qts_tables: [[], `const int QTS_PERM[256] = int[256](
  225,155,210,108,175,199,221,144,203,116, 70,213, 69,158, 33,252,  5, 82,173,133,222,139,174, 27,  9, 71, 90,246, 75,130, 91,191,
  169,138,  2,151,194,235, 81,  7, 25,113,228,159,205,253,134,142,248, 65,224,217, 22,121,229, 63, 89,103, 96,104,156, 17,201,129,
   36,  8,165,110,237,117,231, 56,132,211,152, 20,181,111,239,218,170,163, 51,172,157, 47, 80,212,176,250, 87, 49, 99,242,136,189,
  162,115, 44, 43,124, 94,150, 16,141,247, 32, 10,198,223,255, 72, 53,131, 84, 57,220,197, 58, 50,208, 11,241, 28,  3,192, 62,202,
   18,215,153, 24, 76, 41, 15,179, 39, 46, 55,  6,128,167, 23,188,106, 34,187,140,164, 73,112,182,244,195,227, 13, 35, 77,196,185,
   26,200,226,119, 31,123,168,125,249, 68,183,230,177,135,160,180, 12,  1,243,148,102,166, 38,238,251, 37,240,126, 64, 74,161, 40,
  184,149,171,178,101, 66, 29, 59,146, 61,254,107, 42, 86,154,  4,236,232,120, 21,233,209, 45, 98,193,114, 78, 19,206, 14,118,127,
   48, 79,147, 85, 30,207,219, 54, 88,234,190,122, 95, 67,143,109,137,214,145, 93, 92,100,245,  0,216,186, 60, 83,105, 97,204, 52);
const vec3 QTS_GRAD[256] = vec3[256](
__GRADIENTS__);`],
  qts_noise: [["qts_tables", "qts_ease"], `float qts_lattice(int ix, int iy, int iz, float fx, float fy, float fz) {
  int g = QTS_PERM[(ix + QTS_PERM[(iy + QTS_PERM[iz & 255]) & 255]) & 255];
  return dot(QTS_GRAD[g], vec3(fx, fy, fz));
}
float qts_noise3(float x, float y, float z) {
  float flx = floor(x), fly = floor(y), flz = floor(z);
  int ix = int(flx), iy = int(fly), iz = int(flz);
  float fx0 = x - flx, fx1 = fx0 - 1.0, wx = qts_ease(fx0);
  float fy0 = y - fly, fy1 = fy0 - 1.0, wy = qts_ease(fy0);
  float fz0 = z - flz, fz1 = fz0 - 1.0, wz = qts_ease(fz0);
  float vy0 = mix(qts_lattice(ix, iy, iz, fx0, fy0, fz0), qts_lattice(ix + 1, iy, iz, fx1, fy0, fz0), wx);
  float vy1 = mix(qts_lattice(ix, iy + 1, iz, fx0, fy1, fz0), qts_lattice(ix + 1, iy + 1, iz, fx1, fy1, fz0), wx);
  float vz0 = mix(vy0, vy1, wy);
  vy0 = mix(qts_lattice(ix, iy, iz + 1, fx0, fy0, fz1), qts_lattice(ix + 1, iy, iz + 1, fx1, fy0, fz1), wx);
  vy1 = mix(qts_lattice(ix, iy + 1, iz + 1, fx0, fy1, fz1), qts_lattice(ix + 1, iy + 1, iz + 1, fx1, fy1, fz1), wx);
  return mix(vz0, mix(vy0, vy1, wy), wz);
}
float qts_noise2(float x, float y) {
  float flx = floor(x), fly = floor(y);
  int ix = int(flx), iy = int(fly);
  float fx0 = x - flx, fx1 = fx0 - 1.0, wx = qts_ease(fx0);
  float fy0 = y - fly, fy1 = fy0 - 1.0, wy = qts_ease(fy0);
  float vy0 = mix(qts_lattice(ix, iy, 0, fx0, fy0, 0.0), qts_lattice(ix + 1, iy, 0, fx1, fy0, 0.0), wx);
  float vy1 = mix(qts_lattice(ix, iy + 1, 0, fx0, fy1, 0.0), qts_lattice(ix + 1, iy + 1, 0, fx1, fy1, 0.0), wx);
  return mix(vy0, vy1, wy);
}`],
  qts_noisetest: [["qts_tables", "qts_gain"], `float qts_noisetest(float x, float y, float z, float p) {
  float flx = floor(x), fly = floor(y), flz = floor(z);
  int ix = int(flx), iy = int(fly), iz = int(flz);
  float fx0 = x - flx, fx1 = fx0 - 1.0, wx = qts_gain(fx0, p);
  float fy0 = y - fly, fy1 = fy0 - 1.0, wy = qts_gain(fy0, p);
  float fz0 = z - flz, fz1 = fz0 - 1.0, wz = qts_gain(fz0, p);
  float vy0 = mix(qts_lattice(ix, iy, iz, fx0, fy0, fz0), qts_lattice(ix + 1, iy, iz, fx1, fy0, fz0), wx);
  float vy1 = mix(qts_lattice(ix, iy + 1, iz, fx0, fy1, fz0), qts_lattice(ix + 1, iy + 1, iz, fx1, fy1, fz0), wx);
  float vz0 = mix(vy0, vy1, wy);
  vy0 = mix(qts_lattice(ix, iy, iz + 1, fx0, fy0, fz1), qts_lattice(ix + 1, iy, iz + 1, fx1, fy0, fz1), wx);
  vy1 = mix(qts_lattice(ix, iy + 1, iz + 1, fx0, fy1, fz1), qts_lattice(ix + 1, iy + 1, iz + 1, fx1, fy1, fz1), wx);
  return mix(vz0, mix(vy0, vy1, wy), wz);
}`],
  qts_fnoise: [["qts_noise"], `float qts_fnoise2(float x, float y) {
  float t = qts_noise2(x, y), s = 1.0;
  for (int i = 0; i < 7; ++i) { s *= 2.0; t += qts_noise2(x * s, y * s) / s; }
  return t;
}
float qts_fnoise3(float x, float y, float z) {
  float t = qts_noise3(x, y, z), s = 1.0;
  for (int i = 0; i < 7; ++i) { s *= 2.0; t += qts_noise3(x * s, y * s, z * s) / s; }
  return t;
}`],
  qts_turb: [["qts_noise"], `float qts_turb2(float x, float y) {
  float t = abs(qts_noise2(x, y)), s = 1.0;
  for (int i = 0; i < 7; ++i) { s *= 2.0; t += abs(qts_noise2(x * s, y * s)) / s; }
  return t;
}
float qts_turb3(float x, float y, float z) {
  float t = abs(qts_noise3(x, y, z)), s = 1.0;
  for (int i = 0; i < 7; ++i) { s *= 2.0; t += abs(qts_noise3(x * s, y * s, z * s)) / s; }
  return t;
}`],
  qts_fbm: [["qts_noise", "qts_pow"], `float qts_fbm(float x, float y, float z, float H, float lac, float octaves, bool turb) {
  float result = turb ? abs(qts_noise3(x, y, z)) : qts_noise3(x, y, z), frequency = 1.0;
  int n = int(clamp(octaves, 0.0, 64.0));
  for (int k = 0; k < 64; ++k) {
    if (k >= n) break;
    float i = octaves - 1.0 - float(k);
    x *= lac; y *= lac; z *= lac; frequency *= lac;
    float amplitude = qts_pow(frequency, -H);
    if (i < 1.0) amplitude *= i;
    result += amplitude * (turb ? abs(qts_noise3(x, y, z)) : qts_noise3(x, y, z));
    if (amplitude < 0.00000000001) break;
  }
  return result;
}`],
  qts_worley: [["qts_noise"], `vec2 qts_worley(float x, float y) {
  float ss = floor(x) + 0.5, tt = floor(y) + 0.5, md = 1000.0, md2 = 1000.0;
  for (int i = -1; i <= 1; ++i) for (int j = -1; j <= 1; ++j) {
    float s = ss + float(i), t = tt + float(j);
    float sp = s + (qts_noise2(s, t) - 0.5), tp = t + (qts_noise2(s + 3.0, t + 5.0) - 0.5);
    float sd = sp - x, td = tp - y, d = sd * sd + td * td;
    if (d < md) { md2 = md; md = d; } else if (d < md2) md2 = d;
  }
  return vec2(sqrt(md), sqrt(md2));
}`],
  qts_mandel: [[], `float qts_mandel(float p0, float q0, int recur) {
  float x = 0.0, y = 0.0, x1 = 0.0, y1 = 0.0; int kol = 0;
  for (int i = 0; i < 4096; ++i) {
    x1 = x1 - y1 + p0; y1 = 2.0 * x * y + q0; ++kol; x = x1; y = y1; x1 *= x1; y1 *= y1;
    if (!(kol <= recur && x1 + y1 < 4.0)) break;
  }
  return kol > recur ? 0.0 : float(kol);
}`],
  qts_julia: [[], `float qts_julia(float x, float y, float p0, float q0, int recur) {
  float x1 = x * x, y1 = y * y; int kol = 0;
  for (int i = 0; i < 4096; ++i) {
    x1 = x1 - y1 + p0; y1 = 2.0 * x * y + q0; ++kol; x = x1; y = y1; x1 *= x1; y1 *= y1;
    if (!(kol <= recur && x1 + y1 < 4.0)) break;
  }
  return kol > recur ? 0.0 : float(kol);
}`],
  qts_mandelq: [[], `float qts_mandelq(float qw, float qx, float qy, float qz, int recur) {
  float rw = 0.0, rx = 0.0, ry = 0.0, rz = 0.0; int kol = 0;
  for (int i = 0; i < 4096; ++i) {
    float tmp = 2.0 * rw;
    float rx2 = tmp * rx, ry2 = tmp * ry, rz2 = tmp * rz, rw2 = rw * rw - (rx * rx + ry * ry + rz * rz);
    rw = rw2 + qw; rx = rx2 + qx; ry = ry2 + qy; rz = rz2 + qz; ++kol;
    if (!(kol <= recur && rw * rw + rx * rx < 4.0)) break;
  }
  return kol > recur ? 0.0 : float(kol);
}`],
  qts_mandelcpm: [[], `float qts_mandelcpm(float p0, float q0, int recur) {
  float x = 0.0, y = 0.0, x1 = 0.0, y1 = 0.0; int kol = 0;
  for (int i = 0; i < 4096; ++i) {
    x1 = x1 - y1 + p0; y = 2.0 * x * y + q0; x = x1; y1 = y; x1 *= x1; y1 *= y1; ++kol;
    if (!(kol <= recur && x1 + y1 < 10000.0)) break;
  }
  return kol > recur ? 0.0 : 0.5 * log(x1 + y1) / pow(2.0, float(kol));
}`],
  qts_mandel3: [[], `float qts_mandel3(float p0, float q0, int recur) {
  float x = 0.0, y = 0.0, x2 = 0.0, y2 = 0.0; int kol = 0;
  for (int i = 0; i < 4096; ++i) {
    float x1 = x2 * x - 3.0 * x * y2 + p0, y1 = 3.0 * x2 * y - y2 * y + q0;
    ++kol; x = x1; y = y1; x2 = x * x; y2 = y * y;
    if (!(kol <= recur && x2 + y2 < 4.0)) break;
  }
  return kol > recur ? 0.0 : float(kol);
}`],
  qts_dragon: [[], `float qts_dragon(float x0, float y0, float p0, float q0, int recur) {
  float x = p0, y = q0, x1, y1; int kol = 0;
  for (int i = 0; i < 4096; ++i) {
    x1 = x * x0 - y * y0; y1 = y * x0 + x * y0;
    x = x1 - x * x1 + y * y1; y = y1 - x * y1 + y * y1 - y * x1; ++kol;
    if (!(kol <= recur && x + y < 4.0)) break;
  }
  return kol > recur ? 0.0 : float(kol);
}`],
  qts_sphere: [[], `vec3 qts_sphere(float u, float v) { float c = cos(${pi} * (v - 0.5)); return vec3(c * sin(${2 * pi} * u), c * cos(${2 * pi} * u), sin(${pi} * (v - 0.5))); }`],
  qts_blend: [[], `vec3 qts_blend(int op, vec3 a, vec3 b) {
  if (op == 1) return a * b;
  if (op == 2) return 1.0 - (1.0 - a) * (1.0 - b);
  if (op == 3) return a * (a * b) + (1.0 - a) * (1.0 - (1.0 - a) * (1.0 - b));
  if (op == 4) return max(a, b);
  if (op == 5) return min(a, b);
  if (op == 6) return abs(a - b);
  if (op == 7) return b * a + (1.0 - b) * (1.0 - a);
  if (op == 8) return b * min(a, b) + (1.0 - b) * max(a, b);
  if (op == 9) return b * (a * b) + (1.0 - b) * (1.0 - (1.0 - a) * (1.0 - b));
  return a;
}`],
  qts_image: [[], `vec3 qts_texel(sampler2D s, int tx, int ty) {
  ivec2 sz = textureSize(s, 0);
  if (tx < 0 || ty < 0 || tx >= sz.x || ty >= sz.y) return vec3(0.0);
  return texelFetch(s, ivec2(tx, ty), 0).rgb;
}
vec3 qts_sample(sampler2D s, float tx, float ty, bool tile) {
  if (tile) { tx = qts_wrap(tx); ty = qts_wrap(ty); } else { tx = clamp(tx, 0.0, 1.0); ty = clamp(ty, 0.0, 1.0); }
  ivec2 sz = textureSize(s, 0);
  return qts_texel(s, int(qts_trunc(tx * float(sz.x))), int(qts_trunc(ty * float(sz.y))));
}
float qts_charvar(sampler2D s, int c, float px, float py, float pw, float ph) {
  ivec2 sz = textureSize(s, 0);
  vec3 p = qts_texel(s, int(floor(px * float(sz.x) / pw)), int(floor(py * float(sz.y) / ph))) * 255.0;
  if (c == 0) return p.r;
  if (c == 1) return p.g;
  if (c == 2) return p.b / 255.0;
  float value = max(p.r, max(p.g, p.b)), minv = min(p.r, min(p.g, p.b));
  if (c == 4) return value;
  if (c == 3) return value == 0.0 ? 0.0 : (value - minv) * 255.0 / value;
  if (value == 0.0 || value == minv) return 0.0;
  float dv = value - minv, cr = (value - p.r) / dv, cg = (value - p.g) / dv, cb = (value - p.b) / dv;
  float hue = p.r == value ? cb - cg : (p.g == value ? 2.0 + cr - cb : 4.0 + cg - cr);
  hue *= 60.0; if (hue < 0.0) hue += 360.0;
  return hue * 255.0 / 360.0;
}`],
};
LIB.qts_image[0].push("qts_wrap", "qts_trunc");

// the gradient table, exactly as funcs.js builds it
export function gradientText() {
  const R_A = 16807, R_M = 2147483647, R_Q = 127773, R_R = 2836;
  let seed = 665;
  const next = () => { const hi = Math.trunc(seed / R_Q), lo = seed % R_Q, test = R_A * lo - R_R * hi; seed = test > 0 ? test : test + R_M; return seed; };
  const out = [];
  for (let i = 0; i < 256; i++) {
    const z = 1 - 2 * (next() / R_M), r = Math.sqrt(1 - z * z), theta = 2 * pi * (next() / R_M);
    out.push(`vec3(${f(r * Math.cos(theta))},${f(r * Math.sin(theta))},${f(z)})`);
  }
  const lines = [];
  for (let i = 0; i < 256; i += 4) lines.push("  " + out.slice(i, i + 4).join(",") + (i + 4 < 256 ? "," : ""));
  return lines.join("\n");
}

// a GLSL float literal
export function f(v) {
  if (!isFinite(v)) return v > 0 ? "1e30" : v < 0 ? "(-1e30)" : "0.0";
  let s = String(v);
  if (/e/.test(s)) s = v.toFixed(20).replace(/0+$/, "");
  if (!/\./.test(s)) s += ".0";
  if (s.endsWith(".")) s += "0";
  return v < 0 ? `(${s})` : s;
}

// ---------------------------------------------------------------- expression codegen

export const VARMAP = {
  "V.localScaledTime": "c.t", "V.globalScaledTime": "c.gt", "V.x": "c.x", "V.y": "c.y", "V.widthVal": "c.w",
  "V.heightVal": "c.h", "V.recur": "float(c.recur)", "V.localFrameNbr": "c.n", "V.globalFrameNbr": "c.gn",
  "V.fw": "c.fw", "V.fh": "c.fh", "V.p0": "c.p0", "V.q0": "c.q0", "V.px": "c.px", "V.py": "c.py", "V.pw": "c.pw",
  "V.ph": "c.ph", "V.centerX": "c.cx", "V.centerY": "c.cy", "V.leftVal": "c.left", "V.topVal": "c.top",
  "V.zoomVal": "c.zoom", "V.duration": "c.dur", "V.maxVal": "c.maxv", "V.minVal": "c.minv",
  "F.angle(V.x-V.centerX,V.y-V.centerY)": "qts_angle(c.x-c.cx,c.y-c.cy)",
  "F.dist(V.x-V.centerX,V.y-V.centerY)": "length(vec2(c.x-c.cx,c.y-c.cy))",
  "F.sphereX(V.px/V.fw,V.py/V.fh)": "qts_sphere(c.px/c.fw,c.py/c.fh).x",
  "F.sphereY(V.px/V.fw,V.py/V.fh)": "qts_sphere(c.px/c.fw,c.py/c.fh).y",
  "F.sphereZ(V.px/V.fw,V.py/V.fh)": "qts_sphere(c.px/c.fw,c.py/c.fh).z",
};

export class Gen {
  constructor(compiler, seq) {
    this.cc = compiler; this.seq = seq;
    this.pre = [];          // statements computed once per pixel before the expression (fast fractal forms)
    this.preDone = new Set();
  }
  use(name) { this.cc.use(name); }
  img() {
    const im = this.seq.p.image;
    if (!im) return null;
    return this.cc.imageUnit(im);
  }
  // a value: {c: code, v: true if vec3}
  F(r) { return r.v ? `(${r.c}).z` : r.c; }          // the number of a value: a triple's last component
  V(r) { return r.v ? r.c : `vec3(${r.c})`; }
  num(c) { return { c, v: false }; }
  vec(c) { return { c, v: true }; }
  prepare(key, stmt) { if (!this.preDone.has(key)) { this.preDone.add(key); this.pre.push(stmt); } }

  gen(node) {
    switch (node.kind) {
      case "num": return this.num(f(node.val));
      case "var": {
        if (node.code === "(V.image?V.image.width:0)" || node.code === "(V.image?V.image.height:0)") {
          const u = this.img();
          return this.num(u === null ? "0.0" : `float(textureSize(${u},0).${/width/.test(node.code) ? "x" : "y"})`);
        }
        const g = VARMAP[node.code];
        if (g === undefined) throw new GLSLError("variable not available in a shader: " + node.code);
        if (/qts_angle/.test(g)) this.use("qts_angle");
        if (/qts_sphere/.test(g)) this.use("qts_sphere");
        return this.num(g);
      }
      case "rand": this.use("qts_rand"); return this.num(`qts_rand(c.px,c.py,c.gn,${f(this.cc.salt++)})`);
      case "charvar": {
        const u = this.img();
        if (u === null) return this.num("0.0");
        this.use("qts_image");
        return this.num(`qts_charvar(${u},${{ r: 0, g: 1, b: 2, s: 3, l: 4, c: 5 }[node.code]},c.px,c.py,c.pw,c.ph)`);
      }
      case "cond": {
        const t = this.gen(node.args[0]), a = this.gen(node.args[1]), b = this.gen(node.args[2]);
        if (a.v || b.v) return this.vec(`((${this.F(t)})!=0.0?${this.V(a)}:${this.V(b)})`);
        return this.num(`((${this.F(t)})!=0.0?${a.c}:${b.c})`);
      }
      case "seq": {
        const a = node.args.map((k) => this.F(this.gen(k)));
        return this.cc.sampleCall(this, node, a);
      }
      case "op": {
        const g = node.args.map((k) => this.gen(k));
        const a = g.map((r) => this.F(r));
        const n = this.num.bind(this);
        switch (node.code) {
          case "add": return n(`(${a[0]}+${a[1]})`);
          case "sub": return n(`(${a[0]}-${a[1]})`);
          case "mul": return n(`(${a[0]}*${a[1]})`);
          case "div": this.use("qts_div"); return n(`qts_div(${a[0]},${a[1]})`);
          case "neg": return n(`(-${a[0]})`);
          case "mod": this.use("qts_mod"); return n(`qts_mod(${a[0]},${a[1]})`);
          case "pow": this.use("qts_pow"); this.use("qts_int"); this.use("qts_imod"); return n(`qts_pow(${a[0]},${a[1]})`);
          case "pow2": return n(`exp2(${a[0]})`);
          case "int": this.use("qts_trunc"); return n(`qts_trunc(${a[0]})`);
          case "and": this.use("qts_int"); return n(`float(qts_int(${a[1]})&qts_int(${a[0]}))`);
          case "or": this.use("qts_int"); return n(`float(qts_int(${a[1]})|qts_int(${a[0]}))`);
          case "xor": this.use("qts_int"); return n(`float(qts_int(${a[1]})^qts_int(${a[0]}))`);
          case "inv": this.use("qts_int"); return n(`float(~qts_int(${a[0]}))`);
          case "cmp==": return n(`((${a[0]})==(${a[1]})?1.0:0.0)`);
          case "cmp!=": return n(`((${a[0]})==(${a[1]})?0.0:1.0)`);
          case "cmp>": return n(`((${a[0]})>(${a[1]})?1.0:0.0)`);
          case "cmp>=": return n(`((${a[0]})>=(${a[1]})?1.0:0.0)`);
          case "cmp<": return n(`((${a[0]})<(${a[1]})?1.0:0.0)`);
          case "cmp<=": return n(`((${a[0]})<=(${a[1]})?1.0:0.0)`);
          case "not": return n(`((${a[0]})==0.0?1.0:0.0)`);
          case "land": return n(`(((${a[0]})!=0.0&&(${a[1]})!=0.0)?1.0:0.0)`);
          case "lor": return n(`(((${a[0]})!=0.0||(${a[1]})!=0.0)?1.0:0.0)`);
          case "angle": this.use("qts_angle"); return n(`qts_angle(${a[0]},${a[1]})`);
          case "dist": return n(`length(vec2(${a[0]},${a[1]}))`);
          case "sqrt": return n(`sqrt(${a[0]})`);
          case "log": return n(`log(${a[0]})`);
          case "log10": return n(`(log(${a[0]})*${f(1 / Math.LN10)})`);
          case "abs": return n(`abs(${a[0]})`);
          case "sign": return n(`((${a[0]})<0.0?-1.0:1.0)`);
          case "exp": return n(`exp(${a[0]})`);
          case "cos": case "sin": case "tan": case "acos": case "asin": case "atan": case "cosh": case "sinh": case "tanh":
            return n(`${node.code}(${a[0]})`);
          case "sin2": return n(`qts_sq(sin(${a[0]}))`);
          case "cos2": return n(`qts_sq(cos(${a[0]}))`);
          case "sin3": return n(`qts_cube(sin(${a[0]}))`);
          case "cos3": return n(`qts_cube(cos(${a[0]}))`);
          case "mandel2": this.use("qts_mandel"); return n(`qts_mandel(${a[0]},${a[1]},c.recur)`);
          case "mandelFast": this.use("qts_mandel"); this.prepare("mandel", "float qts_mandelVal = qts_mandel(c.x,c.y,c.recur);"); return n("qts_mandelVal");
          case "mandelq2": this.use("qts_mandelq"); return n(`qts_mandelq(c.x,c.y,${a[0]},${a[1]},c.recur)`);
          case "mandelqFast": this.use("qts_mandelq"); this.prepare("mandelq", "float qts_mandelqVal = qts_mandelq(c.x,c.y,c.p0,c.q0,c.recur);"); return n("qts_mandelqVal");
          case "mandelcpm": this.use("qts_mandelcpm"); return n(`qts_mandelcpm(c.x,c.y,c.recur)`);
          case "mandel3": this.use("qts_mandel3"); return n(`qts_mandel3(c.x,c.y,c.recur)`);
          case "juliaFast": this.use("qts_julia"); this.prepare("julia", "float qts_juliaVal = qts_julia(c.x,c.y,c.p0,c.q0,c.recur);"); return n("qts_juliaVal");
          case "julia2": this.use("qts_julia"); return n(`qts_julia(c.x,c.y,${a[0]},${a[1]},c.recur)`);
          case "julia4": this.use("qts_julia"); return n(`qts_julia(${a[0]},${a[1]},${a[2]},${a[3]},c.recur)`);
          case "dragon": this.use("qts_dragon"); return n(`qts_dragon(c.x,c.y,c.p0,c.q0,c.recur)`);
          case "zebra": this.use("qts_zebra"); return n(`qts_zebra(${a.join(",")})`);
          case "fib": this.use("qts_fib"); this.use("qts_int"); return n(`qts_fib(qts_int(${a[0]}))`);
          case "prime": this.use("qts_prime"); this.use("qts_int"); return n(`qts_prime(qts_int(${a[0]}))`);
          case "fbm": this.use("qts_fbm"); return n(`qts_fbm(${a.join(",")},false)`);
          case "fbmt": this.use("qts_fbm"); return n(`qts_fbm(${a.join(",")},true)`);
          case "noiseFast": this.use("qts_noise"); return n(`qts_noise2(c.x,c.y)`);
          case "noise2d": this.use("qts_noise"); return n(`qts_noise2(${a[0]},${a[1]})`);
          case "noisetest": this.use("qts_noisetest"); return n(`qts_noisetest(${a[0]},${a[1]},0.0,${a[2]})`);
          case "noise3d": this.use("qts_noise"); return n(`qts_noise3(${a[0]},${a[1]},${a[2]})`);
          case "fnoiseFast": this.use("qts_fnoise"); return n(`qts_fnoise2(c.x,c.y)`);
          case "fnoise2d": this.use("qts_fnoise"); return n(`qts_fnoise2(${a[0]},${a[1]})`);
          case "fnoise3d": this.use("qts_fnoise"); return n(`qts_fnoise3(${a[0]},${a[1]},${a[2]})`);
          case "turbFast": this.use("qts_turb"); return n(`qts_turb2(c.x,c.y)`);
          case "turb2d": this.use("qts_turb"); return n(`qts_turb2(${a[0]},${a[1]})`);
          case "turb3d": this.use("qts_turb"); return n(`qts_turb3(${a[0]},${a[1]},${a[2]})`);
          case "wnoise1": this.use("qts_worley"); this.prepare("worley", "vec2 qts_wd = qts_worley(c.x,c.y);"); return n("qts_wd.x");
          case "wnoise2": this.use("qts_worley"); this.prepare("worley", "vec2 qts_wd = qts_worley(c.x,c.y);"); return n("qts_wd.y");
          case "terp": case "terpt": {
            this.use("qts_terp");
            const t = node.code === "terp" ? "c.t" : a[2];
            if (g[0].v || g[1].v) return this.vec(`qts_terp(${this.V(g[0])},${this.V(g[1])},${t})`);
            return n(`qts_terpf(${g[0].c},${g[1].c},${t})`);
          }
          case "ease": this.use("qts_ease"); return this.map3(g[0], (x) => `qts_ease(${x})`);
          case "bias": this.use("qts_bias"); return this.map3(g[0], (x) => `qts_bias(${x},${a[1]})`);
          case "gain": this.use("qts_gain"); return this.map3(g[0], (x) => `qts_gain(${x},${a[1]})`);
          case "pinch": this.use("qts_pinch"); return this.map3(g[0], (x) => `qts_pinch(${x},${a[1]})`);
          case "min": return n(`min(${a[0]},${a[1]})`);
          case "max": return n(`max(${a[0]},${a[1]})`);
          case "clamp": return n(`clamp(${a[0]},${a[1]},${a[2]})`);
          case "limit": this.use("qts_limit"); return n(`qts_limit(${a[0]},${a[1]},${a[2]})`);
          case "linen": this.use("qts_linen"); return n(`qts_linen(${a.join(",")})`);
          case "linenr": this.use("qts_linenr"); return n(`qts_linenr(${a.join(",")})`);
          case "red": case "green": case "blue": {
            const u = this.img();
            if (u === null) return n("0.0");
            this.use("qts_image");
            const ch = { red: "r", green: "g", blue: "b" }[node.code];
            return n(`(qts_texel(${u},int(qts_trunc((${a[0]})*float(textureSize(${u},0).x))),int(qts_trunc((${a[1]})*float(textureSize(${u},0).y)))).${ch}*255.0)`);
          }
          case "sampleN": case "sampleN2": case "sampleP": case "sampleP2": {
            const u = this.img();
            if (u === null) return this.vec("vec3(0.0)");
            this.use("qts_image");
            const tile = this.seq.p.tile ? "true" : "false";
            if (node.code === "sampleN") return this.vec(`qts_sample(${u},c.x,c.y,${tile})`);
            if (node.code === "sampleN2") return this.vec(`qts_sample(${u},${a[0]},${a[1]},${tile})`);
            const sz = `vec2(textureSize(${u},0))`;
            if (node.code === "sampleP") return this.vec(`qts_sample(${u},c.px/${sz}.x,c.py/${sz}.y,${tile})`);
            return this.vec(`qts_sample(${u},(${a[0]})/${sz}.x,(${a[1]})/${sz}.y,${tile})`);
          }
          case "rgb": return this.vec(`vec3(${a[0]},${a[1]},${a[2]})`);
          case "hsv": this.use("qts_hsv"); return this.vec(`qts_hsv(vec3(${a[0]},${a[1]},${a[2]}))`);
        }
        throw new GLSLError("not available in a shader: " + node.code);
      }
    }
    throw new GLSLError("bad node");
  }
  map3(r, fn) {
    if (!r.v) return this.num(fn(r.c));
    const tmp = `qts_m${this.cc.salt++}`;
    this.pre.push(`vec3 ${tmp} = ${r.c};`);
    return this.vec(`vec3(${fn(tmp + ".x")},${fn(tmp + ".y")},${fn(tmp + ".z")})`);
  }
}

// the argument list of a sampler call, after `prefix` (which ends in "("): v1, v2, hasT, tval
export function sampleArgs(prefix, code, a) {
  switch (code) {
    case "s": return `${prefix}c.x,c.y,false,0.0)`;
    case "st": return `${prefix}c.x,c.y,true,${a[0]})`;
    case "sxy": return `${prefix}${a[0]},${a[1]},false,0.0)`;
    case "sxyt": return `${prefix}${a[0]},${a[1]},true,${a[2]})`;
    case "sda": return `${prefix}0.5+cos(${a[1]})*(${a[0]}),0.5-sin(${a[1]})*(${a[0]}),false,0.0)`;
  }
  throw new GLSLError("bad sequence reference");
}

// the library functions a compiler asked for (its `used` set), dependencies first
export function libraryText(used) {
  const lib = [];
  const emitted = new Set();
  const emit = (name) => { if (emitted.has(name)) return; emitted.add(name); for (const d of LIB[name][0]) emit(d); lib.push(LIB[name][1].replace("__GRADIENTS__", name === "qts_tables" ? gradientText() : "")); };
  for (const name of Object.keys(LIB)) if (used.has(name)) emit(name);
  return lib.join("\n");
}

// ---------------------------------------------------------------- the script compiler

const PROPKEYS = ["left", "top", "width", "height", "zoomFac", "zoomFunc", "min", "max", "recurse", "p0", "q0", "endWidth"];

export class GLSLCompiler {
  // script: a loaded engine/seq.js Script
  constructor(script) {
    this.script = script;
    this.used = new Set();
    this.salt = 1;
    this.images = [];        // Image objects, in iChannel order
    this.deps = new Map();   // seq -> Set of seqs it samples
    this.warnings = [];
    this.seqs = [];
    const walk = (s) => { s.glslIndex = this.seqs.length; this.seqs.push(s); for (const c of s.children) walk(c); };
    walk(script.main);
  }
  use(name) {
    if (this.used.has(name)) return;
    this.used.add(name);
    for (const d of LIB[name][0]) this.use(d);
  }
  seqForID(id) { return this.script.seqByID[id - 1] || null; }
  depend(from, to) { if (!this.deps.has(from)) this.deps.set(from, new Set()); this.deps.get(from).add(to); }
  // the code for a $name reference (node.code: s, st, sxy, sxyt, sda) with its arguments a
  sampleCall(gen, node, a) {
    const target = this.seqForID(node.id);
    if (!target) return gen.vec("vec3(0.0)");
    this.depend(gen.seq, target);
    return gen.vec(sampleArgs(`qts_samp${target.glslIndex}(c,`, node.code, a));
  }
  imageUnit(img) {
    let i = this.images.indexOf(img);
    if (i < 0) {
      if (this.images.length >= 4) throw new GLSLError("a shader can use at most four images");
      i = this.images.length; this.images.push(img);
    }
    return "iChannel" + i;
  }
  tree(src) {
    const p = new Parser(src, this.script.seqNames);
    return { tree: p.parse(), flags: p.flags };
  }

  // the expression for a property, as a float, with c the context variable
  propCode(gen, seq, key) {
    const src = seq.p.exps[key];
    if (src === undefined || src === "") return null;
    let tree;
    try { tree = this.tree(src).tree; }
    catch (e) { if (e instanceof ExprError) throw new GLSLError(`${key}="${src}": ${e.message}`); throw e; }
    if (!tree) return "0.0";
    const r = gen.gen(tree);
    return r.v ? `(${r.c}).x` : r.c;        // a property takes a triple's first component (EvalF)
  }

  compile() {
    const S = this.script, main = S.main;
    const out = [];
    const fps = S.frameRate > 0 ? S.frameRate : 12;
    // per-sequence functions, in an order where sampled sequences come first
    const bodies = new Map();
    for (const seq of this.seqs) bodies.set(seq, this.seqFunctions(seq));
    const order = [], state = new Map();
    const visit = (s, stack) => {
      if (state.get(s) === 2) return;
      if (state.get(s) === 1) throw new GLSLError(`sequences sample each other in a cycle (${stack.map((q) => q.p.idName || "#" + q.glslIndex).join(" -> ")} -> ${s.p.idName}): a shader can't recurse`);
      state.set(s, 1);
      for (const d of this.deps.get(s) || []) visit(d, stack.concat(s));
      state.set(s, 2); order.push(s);
    };
    for (const s of this.seqs) visit(s, []);
    const mainText = this.mainImage(main, fps);
    // library (after everything that may ask for a function)
    this.use("qts_trunc"); this.use("qts_wrap"); this.use("qts_hsv");

    const title = (S.main.p.movieFilename || "qts").replace(/[^\w.-]/g, "_");
    out.push(`// ${title}: a QTS script compiled to GLSL by qts.jbum.com
// Loops every ${f(S.duration)} seconds. Shadertoy-compatible: paste as is (set any iChannel textures to
// the script's images, nearest filter, no vflip).
#define QTS_DURATION ${f(S.duration)}
#define QTS_FPS ${f(fps)}
#define QTS_OVERSAMPLE 1      // 0 renders four times faster, without the 2x2 supersampling the script asks for

struct Ctx { float x, y, t, gt, w, h, n, gn, fw, fh, p0, q0, px, py, pw, ph, cx, cy, left, top, zoom, dur, minv, maxv, gtime; int recur; };

float qts_sq(float v) { return v * v; }
float qts_cube(float v) { return v * v * v; }
${libraryText(this.used)}
`);
    for (const s of order) out.push(bodies.get(s));
    out.push(mainText);
    return { source: out.join("\n"), images: this.images, warnings: this.warnings,
      duration: S.duration, width: S.frameWidth, height: S.frameHeight, fps };
  }

  // Properties, pix, pin, colour and sampler functions of one sequence
  seqFunctions(seq) {
    const p = seq.p, k = seq.glslIndex, name = p.idName ? ` (${p.idName})` : "";
    const gen = new Gen(this, seq);
    const fps = p.frameRate > 0 ? p.frameRate : 12;
    // properties
    const props = {};
    for (const key of PROPKEYS) props[key] = this.propCode(gen, seq, key);
    const propPre = gen.pre.splice(0);
    const nbrFrames = Math.trunc(p.duration * fps);
    let ctx = `// sequence ${k}${name}: debut ${f(p.globalDebut)} s, duration ${f(p.duration)} s
Ctx qts_ctx${k}(float gtime, float px, float py, float fw, float fh) {
  Ctx c;
  c.gtime = gtime; c.px = px; c.py = py; c.pw = fw; c.ph = fh; c.fw = fw; c.fh = fh;
  c.gt = gtime / ${f(this.script.duration)};
  c.gn = floor(gtime * QTS_FPS + 1e-4);
  c.t = (gtime - ${f(p.globalDebut)}) / ${f(p.duration)};
  c.n = floor(gtime * ${f(fps)} + 1e-4) - ${f(Math.ceil(p.globalDebut * fps))};
  c.dur = ${f(p.duration)};
  c.x = 0.0; c.y = 0.0; c.w = 1.0; c.h = 1.0; c.cx = 0.0; c.cy = 0.0; c.left = 0.0; c.top = 0.0; c.zoom = 1.0;
  c.p0 = 0.0; c.q0 = 0.0; c.minv = 0.0; c.maxv = 1.0; c.recur = 64;
  ${propPre.join("\n  ")}
  c.left = ${props.left}; c.top = ${props.top};
  c.w = ${props.width}; c.h = ${props.height};
  c.left = ${props.left}; c.top = ${props.top};
  c.zoom = ${props.zoomFac};
`;
    if (props.endWidth && nbrFrames > 1) ctx += `  { float ew = ${props.endWidth}; if (ew > 0.0 && c.zoom == 1.0 && c.w > 0.0) c.zoom = pow(ew / c.w, 1.0 / ${f(nbrFrames - 1)}); }\n`;
    if (p.center) ctx += `  c.left -= c.w / 2.0; c.top -= c.h / 2.0;\n`;
    ctx += `  if (c.zoom != 1.0) {
    float fz = pow(c.zoom, ${f(nbrFrames - 1)} * (${props.zoomFunc}));
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
    // pix
    const pixSrc = p.exps.pix;
    let pixTree;
    try { pixTree = this.tree(pixSrc).tree; }
    catch (e) { if (e instanceof ExprError) throw new GLSLError(`pix="${pixSrc}": ${e.message}`); throw e; }
    const r = pixTree ? gen.gen(pixTree) : gen.num("0.0");
    const pixPre = gen.pre.splice(0);
    const pix = `vec3 qts_pix${k}(Ctx c) {
  ${pixPre.join("\n  ")}
  return ${p.colormode === CM.MONO ? `vec3(${r.v ? `(${r.c}).x` : r.c})` : gen.V(r)};
}
`;
    // pin: into 0..1 by min/max, wrap or clamp, cycle
    const pinOne = p.wrap
      ? `v = qts_wrap((v - c.minv) * tran);`
      : `if (v < c.minv) v = c.minv; else if (v > c.maxv) v = c.maxv; else v = (v - c.minv) * tran;`;
    const cycle = p.cycle ? `v = fract(v + c.gn / 256.0);` : ``;
    const pin = `float qts_pinf${k}(float v, Ctx c) {
  float tran = 1.0 / (c.maxv - c.minv);
  ${pinOne}
  ${cycle}
  return v;
}
vec3 qts_pin${k}(Ctx c) {
  vec3 v = qts_pix${k}(c);
  return vec3(qts_pinf${k}(v.x, c), qts_pinf${k}(v.y, c), qts_pinf${k}(v.z, c));
}
`;
    const toRGB = p.colormode === CM.HSV ? "qts_hsv(v)" : "v";
    // sampler for $name: the caller's pixel, this sequence's bounds, never oversampled
    const samp = `vec3 qts_samp${k}(Ctx caller, float v1, float v2, bool hasT, float tval) {
  ${p.tile ? "v1 = qts_wrap(v1); v2 = qts_wrap(v2);" : ""}
  Ctx c = qts_ctx${k}(caller.gtime, caller.px, caller.py, caller.fw, caller.fh);
  c.x = c.left + v1 * c.w; c.y = c.top + v2 * c.h;
  if (hasT) c.t = tval;
  c.n = floor(c.t * ${f(p.duration * fps)});
  vec3 v = qts_pin${k}(c);
  return ${toRGB};
}
`;
    // the layer at a pixel (with oversampling)
    const layer = `vec3 qts_layer${k}(float gtime, float px, float py, float fw, float fh) {
  Ctx c = qts_ctx${k}(gtime, px, py, fw, fh);
  float xInc = c.w / fw, yInc = c.h / fh;
  c.x = c.left + px * xInc; c.y = c.top + py * yInc;
  vec3 v = qts_pin${k}(c);
#if QTS_OVERSAMPLE
  ${p.oversample ? `c.y += yInc / 2.0; v += qts_pin${k}(c);
  c.x += xInc / 2.0; v += qts_pin${k}(c);
  c.y -= yInc / 2.0; v += qts_pin${k}(c);
  v *= 0.25;` : ""}
#endif
  return ${toRGB};
}
`;
    return ctx + pix + pin + samp + layer;
  }

  // Composite the leaves alive at the time, in order; normal layers replace, chop layers blend.
  mainImage(main, fps) {
    const lines = [];
    const walk = (s) => {
      const p = s.p;
      if (s.children.length) { for (const c of s.children) walk(c); return; }
      if (s.isMap) return;
      const alive = `(gtime >= ${f(p.globalDebut)} && gtime <= ${f(p.globalDebut + p.duration)})`;
      const chop = p.channelOp;
      if (chop === CHOP.normal) lines.push(`  if ${alive} col = qts_q8(qts_layer${s.glslIndex}(gtime, px, py, fw, fh));`);
      else if (chop >= CHOP.dodge) this.warnings.push(`blend mode ${Object.keys(CHOP)[chop]} isn't implemented (the layer is skipped), as in QTS`);
      else { this.use("qts_blend"); lines.push(`  if ${alive} col = qts_q8(qts_blend(${chop}, col, qts_q8(qts_layer${s.glslIndex}(gtime, px, py, fw, fh))));`); }
    };
    walk(main);
    return `vec3 qts_q8(vec3 c) { return floor(c * 255.0 + 1e-4) / 255.0; }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  float fw = iResolution.x, fh = iResolution.y;
  float px = floor(fragCoord.x), py = floor(fh - fragCoord.y);
  float gtime = mod(iTime, QTS_DURATION);
  vec3 col = vec3(0.0);
${lines.join("\n")}
  fragColor = vec4(col, 1.0);
}
`;
  }
}

// Compiles a loaded Script. Returns {source, images, warnings, duration, width, height, fps}.
export function compileScriptToGLSL(script) {
  if (!script.main) throw new GLSLError("no script");
  return new GLSLCompiler(script).compile();
}
