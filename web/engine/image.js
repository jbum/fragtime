// image.js -- source images for the JS engine: RGB bytes, row 0 at the top, pixels read
// as 0xBBGGRR like the C++ (follows src/image.cpp).

import { trunc } from "./funcs.js";

export class Image {
  constructor(width, height, rgb) { this.width = width; this.height = height; this.rgb = rgb; }

  // black outside the image
  getPixel(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return 0;
    const i = (ty * this.width + tx) * 3;
    return this.rgb[i] | (this.rgb[i + 1] << 8) | (this.rgb[i + 2] << 16);
  }

  // nearest pixel at normalised coordinates; tile wraps, else clamps to 0..1 (where 1.0
  // reads just past the last pixel: black, as the original)
  sample(tx, ty, tile) {
    if (tile) {
      if (tx < 0) { tx = Math.abs(tx); tx = 1 - (tx - trunc(tx)); } else tx -= trunc(tx);
      if (ty < 0) { ty = Math.abs(ty); ty = 1 - (ty - trunc(ty)); } else ty -= trunc(ty);
    } else {
      if (tx < 0) tx = 0; else if (tx > 1) tx = 1;
      if (ty < 0) ty = 0; else if (ty > 1) ty = 1;
    }
    return this.getPixel(trunc(tx * this.width), trunc(ty * this.height));
  }

  // From RGBA bytes (ImageData / canvas)
  static fromRGBA(width, height, rgba) {
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0, n = width * height; i < n; ++i, j += 4) { rgb[i * 3] = rgba[j]; rgb[i * 3 + 1] = rgba[j + 1]; rgb[i * 3 + 2] = rgba[j + 2]; }
    return new Image(width, height, rgb);
  }

  // In a browser or worker: decode any image file the browser can
  static async decode(bytes, type) {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: type || "image/png" }));
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const d = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return Image.fromRGBA(d.width, d.height, d.data);
  }
}

// A small PNG decoder for Node (tests), 8-bit grey/RGB/RGBA/palette, non-interlaced.
export function decodePNGNode(bytes, zlib) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8, width = 0, height = 0, depth = 0, ctype = 0, palette = null;
  const idat = [];
  while (pos < bytes.length) {
    const len = dv.getUint32(pos), type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { width = dv.getUint32(pos + 8); height = dv.getUint32(pos + 12); depth = data[8]; ctype = data[9]; if (data[12]) throw new Error("interlaced PNG"); }
    else if (type === "PLTE") palette = data;
    else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error("PNG depth " + depth);
  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const raw = zlib.inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  const stride = width * chans, out = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; ++y) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; ++i) {
      const a = i >= chans ? cur[i - chans] : 0, b = prev[i], c = i >= chans ? prev[i - chans] : 0;
      let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, n = width * height; i < n; ++i) {
    let r, g, b;
    if (ctype === 2 || ctype === 6) { r = out[i * chans]; g = out[i * chans + 1]; b = out[i * chans + 2]; }
    else if (ctype === 3) { const p = out[i] * 3; r = palette[p]; g = palette[p + 1]; b = palette[p + 2]; }
    else { r = g = b = out[i * chans]; }
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
  }
  return new Image(width, height, rgb);
}
