// shader.js -- plays a shader compiled by engine/glsl.js in a WebGL2 canvas, and writes
// the standalone looping page. The player is kept as source text so the editor and the
// downloaded page run the very same code.

export const PLAYER_SRC = `
class QTSShaderPlayer {
  // canvas: a <canvas>; images: [{name, source}] with source anything texImage2D takes
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!this.gl) throw new Error("WebGL2 isn't available in this browser");
    this.program = null; this.textures = [];
    this.duration = 1; this.time = 0; this.playing = false; this.speed = 1;
    this.onFrame = null;
    this._raf = 0; this._last = 0; this._frames = 0; this._fpsTime = 0; this.fps = 0;
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, "#version 300 es\\nvoid main(){ vec2 p = vec2((gl_VertexID & 1) * 4 - 1, (gl_VertexID & 2) * 2 - 1); gl_Position = vec4(p, 0.0, 1.0); }");
    gl.compileShader(vs);
    this.vs = vs;
  }
  static header(nImages) {
    let s = "#version 300 es\\nprecision highp float;\\nprecision highp int;\\nuniform vec3 iResolution;\\nuniform float iTime;\\nuniform int iFrame;\\n";
    for (let i = 0; i < 4; ++i) s += "uniform sampler2D iChannel" + i + ";\\n";
    s += "out vec4 qts_fragColor;\\n#line 1\\n";
    return s;
  }
  // compiles; throws with the shader log on failure
  setShader(source, images, duration) {
    const gl = this.gl;
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, QTSShaderPlayer.header() + source + "\\nvoid main() { mainImage(qts_fragColor, gl_FragCoord.xy); }\\n");
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(fs); gl.deleteShader(fs); throw new Error("shader: " + log); }
    const prog = gl.createProgram();
    gl.attachShader(prog, this.vs); gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { const log = gl.getProgramInfoLog(prog); gl.deleteProgram(prog); throw new Error("shader link: " + log); }
    if (this.program) gl.deleteProgram(this.program);
    this.program = prog;
    this.u = { res: gl.getUniformLocation(prog, "iResolution"), time: gl.getUniformLocation(prog, "iTime"), frame: gl.getUniformLocation(prog, "iFrame") };
    for (const t of this.textures) gl.deleteTexture(t);
    this.textures = [];
    gl.useProgram(prog);
    (images || []).forEach((im, i) => {
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im.source);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(prog, "iChannel" + i), i);
      this.textures.push(tex);
    });
    if (duration > 0) this.duration = duration;
    this.frameNbr = 0;
  }
  setSize(w, h) { if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; } }
  draw(time) {
    const gl = this.gl, c = this.canvas;
    if (!this.program) return;
    if (time !== undefined) this.time = time;
    gl.viewport(0, 0, c.width, c.height);
    gl.useProgram(this.program);
    gl.uniform3f(this.u.res, c.width, c.height, 1);
    gl.uniform1f(this.u.time, this.time);
    gl.uniform1i(this.u.frame, this.frameNbr++);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  play() {
    if (this.playing) return;
    this.playing = true;
    this._last = performance.now(); this._fpsTime = this._last; this._frames = 0;
    const step = (now) => {
      if (!this.playing) return;
      // rAF's timestamp can precede the performance.now() taken when play() was called
      const d = this.duration;
      this.time = (((this.time + Math.max(0, now - this._last) / 1000 * this.speed) % d) + d) % d;
      this._last = now;
      this.draw();
      if (++this._frames >= 20) { this.fps = 1000 * this._frames / (now - this._fpsTime); this._fpsTime = now; this._frames = 0; }
      if (this.onFrame) this.onFrame(this.time);
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }
  pause() { this.playing = false; cancelAnimationFrame(this._raf); }
  seek(t) { this.time = ((t % this.duration) + this.duration) % this.duration; this.draw(); if (this.onFrame) this.onFrame(this.time); }
  // the current picture as RGBA bytes, row 0 at the top
  pixels() {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; ++y) out.set(buf.subarray(y * w * 4, (y + 1) * w * 4), (h - 1 - y) * w * 4);
    return out;
  }
}`;

export const ShaderPlayer = new Function(PLAYER_SRC + "\nreturn QTSShaderPlayer;")();

// A self-contained page: the shader, its images as data URLs, the player, fullscreen
// letterboxed canvas, keys to pause and save a frame.
export function standaloneHTML({ source, title, images, duration, width, height }) {
  const esc = (s) => s.replace(/<\/script/gi, "<\\/script");
  const name = (title || "qts shader").replace(/[<>&]/g, "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
  body { display: flex; align-items: center; justify-content: center; font: 13px -apple-system, Helvetica, Arial, sans-serif; color: #ccc; }
  canvas { display: block; image-rendering: auto; }
  #msg { position: fixed; left: 12px; bottom: 10px; opacity: .7; }
  #msg.hide { display: none; }
  #err { position: fixed; inset: 20px; color: #f88; white-space: pre-wrap; font-family: monospace; display: none; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<div id="msg">${name} · ${Number(duration)} s loop · space pauses, ← → step, s saves a frame, o toggles oversampling, h hides this</div>
<pre id="err"></pre>
<script id="shader" type="x-shader/x-fragment">
${esc(source)}
</script>
<script>
${esc(PLAYER_SRC)}
const IMAGES = ${JSON.stringify(images.map((im) => ({ name: im.name, url: im.dataURL })))};
const DURATION = ${Number(duration)}, ASPECT = ${Number(width)} / ${Number(height)};
const canvas = document.getElementById("c");
let player, oversample = true;
function fit() {
  const W = innerWidth, H = innerHeight, dpr = Math.min(devicePixelRatio || 1, 2);
  let w = W, h = W / ASPECT;
  if (h > H) { h = H; w = H * ASPECT; }
  canvas.style.width = w + "px"; canvas.style.height = h + "px";
  const pw = Math.min(2048, Math.round(w * dpr)), ph = Math.min(2048, Math.round(h * dpr));
  if (player) { player.setSize(pw, ph); if (!player.playing) player.draw(); }
}
function source() {
  const s = document.getElementById("shader").textContent;
  return oversample ? s : s.replace("#define QTS_OVERSAMPLE 1", "#define QTS_OVERSAMPLE 0");
}
function build() { player.setShader(source(), IMAGES.map((im, i) => ({ name: im.name, source: im.img })), DURATION); }
async function start() {
  try {
    player = new QTSShaderPlayer(canvas);
    await Promise.all(IMAGES.map((im) => new Promise((ok, bad) => { im.img = new Image(); im.img.onload = ok; im.img.onerror = () => bad(new Error("image " + im.name)); im.img.src = im.url; })));
    build();
    fit();
    player.play();
  } catch (e) { const el = document.getElementById("err"); el.style.display = "block"; el.textContent = String(e.message || e); }
}
addEventListener("resize", fit);
addEventListener("keydown", (e) => {
  if (!player) return;
  if (e.key === " ") { e.preventDefault(); player.playing ? player.pause() : player.play(); }
  else if (e.key === "ArrowRight") { player.pause(); player.seek(player.time + 1 / 24); }
  else if (e.key === "ArrowLeft") { player.pause(); player.seek(player.time - 1 / 24); }
  else if (e.key === "o") { oversample = !oversample; build(); if (!player.playing) player.draw(); }
  else if (e.key === "h") document.getElementById("msg").classList.toggle("hide");
  else if (e.key === "s") { player.draw(); const a = document.createElement("a"); a.download = "${name.replace(/"/g, "")}_" + player.time.toFixed(2) + "s.png"; a.href = canvas.toDataURL("image/png"); a.click(); }
});
canvas.addEventListener("click", () => { if (player) player.playing ? player.pause() : player.play(); });
start();
</script>
</body>
</html>
`;
}
