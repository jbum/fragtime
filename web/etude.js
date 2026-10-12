// etude.js -- plays Noise Etude on the About page as a shader: the script is fetched,
// compiled to GLSL in the browser and run on the GPU. The movie stays as the fallback.
import { Script } from "./engine/seq.js";
import { Image as QImage } from "./engine/image.js";
import { compileScriptToGLSL } from "./engine/glsl.js";
import { ShaderPlayer } from "./shader.js";

const $ = (s) => document.querySelector(s);
const SCRIPT = "examples/noiseetude.can";
const IMAGE_RE = /\b(?:image|source|bmp)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\/>]+))/gi;
const box = $("#etudeBox"), canvas = $("#etudeView"), video = $("#etudeMovie"), poster = $("#etudePoster");
const playBtn = $("#etudePlay"), status = $("#etudeStatus"), toggle = $("#etudeToggle"), movieLink = $("#etudeMovieLink");
let player = null, started = false;

function fmt(t) { return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`; }

function showMovie(why) {
  if (player) player.pause();
  canvas.hidden = true; poster.hidden = true; playBtn.hidden = true; toggle.hidden = true;
  video.hidden = false;
  status.textContent = why || "";
}

function fit() {
  if (!player) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.min(1440, Math.round(box.clientWidth * dpr)), h = Math.round(w * 3 / 4);
  player.setSize(w, h);
  if (!player.playing) player.draw();
}

async function start() {
  if (started) return;
  started = true;
  playBtn.hidden = true;
  try {
    player = new ShaderPlayer(canvas);   // throws without WebGL2
  } catch (e) { showMovie("No WebGL2 here, so the movie instead."); return; }
  try {
    status.textContent = "fetching the script…";
    const text = new TextDecoder("latin1").decode(new Uint8Array(await (await fetch(SCRIPT)).arrayBuffer()));
    const images = new Map(), bitmaps = new Map();
    let m;
    while ((m = IMAGE_RE.exec(text))) {
      const name = m[1] ?? m[2] ?? m[3];
      if (images.has(name)) continue;
      // the archive's .bmp files are served as .png
      const base = name.replace(/\.[^.]*$/, "");
      let data = null;
      for (const t of [name, name.toLowerCase(), base + ".png", base.toLowerCase() + ".png"]) {
        const r = await fetch("examples/" + encodeURIComponent(t));
        if (r.ok && /image/.test(r.headers.get("content-type") || "")) { data = await r.arrayBuffer(); break; }
      }
      if (!data) throw new Error("image " + name + " is missing");
      const img = await QImage.decode(data.slice(0));
      images.set(name, img); images.set(name.toLowerCase(), img);
      bitmaps.set(img, await createImageBitmap(new Blob([data])));
    }
    const script = new Script();
    if (!script.load(text, images)) throw new Error(script.errors[0]);
    const g = compileScriptToGLSL(script);
    status.textContent = `compiling ${(g.source.length / 1024).toFixed(0)} KB of shader on the GPU, a few seconds…`;
    await new Promise((r) => setTimeout(r, 30));   // let the status paint before the GPU compile blocks
    player.setShader(g.source, g.images.map((im) => ({ name: "", source: bitmaps.get(im) })), g.duration);
    poster.hidden = true; canvas.hidden = false;
    fit();
    player.onFrame = (t) => { status.textContent = `${fmt(t)} of ${fmt(g.duration)}${player.fps ? ` · ${player.fps.toFixed(0)} fps` : ""} · click to pause`; };
    player.play();
    toggle.hidden = false;
    window.etude = player;   // for the tests
  } catch (e) {
    showMovie("The shader didn't run here (" + e.message.split("\n")[0] + "), so the movie instead.");
  }
}

playBtn.onclick = start;
poster.onclick = start;
canvas.onclick = () => { if (!player) return; if (player.playing) { player.pause(); status.textContent += " (paused)"; } else player.play(); };
toggle.onclick = (e) => { e.preventDefault(); showMovie(""); };
movieLink.onclick = (e) => { e.preventDefault(); showMovie(""); };
addEventListener("resize", fit);
addEventListener("keydown", (e) => { if (e.key === " " && player && !canvas.hidden && document.activeElement === document.body) { e.preventDefault(); canvas.onclick(); } });
