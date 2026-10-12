#!/usr/bin/env node
// Drives the built editor (build/web) in headless Chrome on the real GPU and checks what it
// saves: a frame from the shader view, movies from the shader and from the original renderer,
// each against the native qts.   node tests/editor_test.js [-x script.can] [-p port] [-k keep_dir]
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let script = "fire.can", port = 8781, keep = "";
for (let i = 2; i < process.argv.length; ++i) {
  if (process.argv[i] === "-x") script = process.argv[++i];
  else if (process.argv[i] === "-p") port = parseInt(process.argv[++i], 10);
  else if (process.argv[i] === "-k") keep = process.argv[++i];
}
const web = path.join(root, "build/web");
if (!fs.existsSync(path.join(web, "qts.wasm"))) { console.error("build the site first (build/build_web.py)"); process.exit(1); }
const work = keep || fs.mkdtempSync(path.join(os.tmpdir(), "qts-editor-"));
fs.mkdirSync(work, { recursive: true });
const server = spawn("node", [path.join(root, "build/serve.js"), String(port), web], { stdio: "ignore" });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "qts-editor-profile-"));
const chrome = spawn(CHROME, ["--headless=new", "--use-angle=metal", "--hide-scrollbars", "--remote-debugging-port=0",
  `--user-data-dir=${profile}`, "--window-size=1400,1000", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const quit = (code) => { chrome.kill(); server.kill(); setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} process.exit(code); }, 300); };
setTimeout(() => { console.error("timed out"); quit(1); }, 600000).unref();
const check = (cond, msg) => { console.log((cond ? "ok   " : "FAIL ") + msg); if (!cond) failures++; };

// native frames f0..f1 of the script at w×h → [paths]
function nativeFrames(f0, f1, w, h) {
  const dir = path.join(work, "native"); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(path.join(root, "qts"), ["-q", "-j", "8", "-w", String(w), "-h", String(h), "-f", `${f0}-${f1}`, "-o", path.join(dir, "f"), path.join(root, "examples", script)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("qts: " + r.stderr);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(dir, f));
  return files;
}
// RGB bytes of a PNG via ffmpeg
function rgb(file) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error("ffmpeg: " + r.stderr);
  return r.stdout;
}
function compare(a, b, label, limitPct = 1) {
  if (a.length !== b.length) { check(false, `${label}: sizes differ (${a.length} vs ${b.length} bytes)`); return; }
  let big = 0, max = 0;
  for (let i = 0; i < a.length; ++i) { const d = Math.abs(a[i] - b[i]); if (d > max) max = d; if (d > 8) big++; }
  const pct = 100 * big / a.length;
  check(pct < limitPct, `${label}: ${pct.toFixed(2)}% of bytes more than 8 levels off, max ${max}`);
}

(async () => {
  const portFile = path.join(profile, "DevToolsActivePort");
  while (!fs.existsSync(portFile) || !fs.readFileSync(portFile, "utf8").includes("\n")) await sleep(100);
  const dport = fs.readFileSync(portFile, "utf8").split("\n")[0];
  const targets = await (await fetch(`http://127.0.0.1:${dport}/json`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const pending = new Map();
  const files = new Map();   // filename -> Buffer, caught from the page's download()
  const waiters = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Runtime.consoleAPICalled") {
      const v = m.params.args[0] && m.params.args[0].value;
      if (typeof v === "string" && v.startsWith("FILE ")) {
        const [, name, data] = v.split(" ");
        const buf = Buffer.from(data, "base64");
        files.set(name, buf);
        fs.writeFileSync(path.join(work, name), buf);
        for (const w of waiters.splice(0)) w(name);
      } else if (m.params.type === "error") console.error("page:", v);
    }
  });
  const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error("page: " + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
    return r.result.result.value;
  };
  const nextFile = () => new Promise((r) => waiters.push(r));
  const until = async (expr, secs, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < secs * 1000) { if (await evaluate(expr)) return true; await sleep(200); }
    check(false, `waited ${secs} s for ${what}`);
    return false;
  };
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/?x=${encodeURIComponent(script)}` });
  await until(`document.querySelector("#timeText").textContent.includes(" s of ")`, 60, "the shader to play");
  await evaluate(`window.qtsDownloadHook = (blob, name) => blob.arrayBuffer().then((b) => {
    let s = ""; const u = new Uint8Array(b); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    console.log("FILE " + name + " " + btoa(s)); }); true`);

  // the shader view is the default and plays
  check(await evaluate(`document.querySelector("#tabShader").classList.contains("on") && !document.querySelector("#glview").hidden && document.querySelector("#preview").hidden`), "shader tab is on by default, its canvas shown");
  check(await evaluate(`document.querySelector("#render").textContent`) === "Run shader", "the run button says Run shader");
  const t1 = await evaluate(`document.querySelector("#timeText").textContent`);
  await sleep(700);
  const t2 = await evaluate(`document.querySelector("#timeText").textContent`);
  check(t1 !== t2, `the shader animates (${t1} → ${t2})`);
  const info = await evaluate(`(() => { const m = document.querySelector("#log").textContent.match(/(\\d+) s at (\\d+) fps = (\\d+) frames?, (\\d+)×(\\d+)/); return m && { frames: +m[3], w: +m[4], h: +m[5] }; })()`);
  check(!!info, `script info ${JSON.stringify(info)}`);
  if (!info) return quit(1);
  const { frames, w, h } = info;

  // Save frame (PNG) in the shader view, paused at the middle: the renderer's frame round(.5*(n-1))
  await evaluate(`(() => { const s = document.querySelector("#time"); s.value = "0.5"; s.dispatchEvent(new Event("input")); return true; })()`);
  check(await evaluate(`document.querySelector("#shaderPlay").textContent`) === "▶", "moving the slider pauses the shader");
  const midFrame = Math.min(frames - 1, Math.round(0.5 * (frames - 1)));
  let got = nextFile();
  await evaluate(`document.querySelector("#savePng").click(); true`);
  let name = await got;
  check(name.endsWith(`_${String(midFrame + 1).padStart(4, "0")}.png`), `Save frame named by the frame: ${name}`);
  {
    // the shader draws at frac*duration, the renderer at frame/n*duration: the same when frac*(n-1) is a whole frame
    const [nat] = nativeFrames(midFrame, midFrame, w, h);
    compare(rgb(path.join(work, name)), rgb(nat), `shader frame ${midFrame} vs native`);
  }

  // movies through the dialog
  const movie = async (engine, format, first, last) => {
    await evaluate(`document.querySelector("#movie").click(); true`);
    await until(`document.querySelector("#movieDialog").open`, 30, "the movie dialog");
    const got = nextFile();
    await evaluate(`(() => {
      const d = document;
      d.querySelector("#movieEngine").value = "${engine}"; d.querySelector("#movieFormat").value = "${format}";
      d.querySelector("#movieSome").checked = true; d.querySelector("#movieFirst").value = "${first + 1}"; d.querySelector("#movieLast").value = "${last + 1}";
      d.querySelector("#movieGo").click(); return true; })()`);
    const name = await got;
    const line = await evaluate(`[...document.querySelectorAll("#log div")].map((d) => d.textContent).filter((t) => t.startsWith("${name}")).pop()`);
    console.log("     " + line);
    return name;
  };
  await evaluate(`document.querySelector("#movie").click(); true`);
  await until(`document.querySelector("#movieDialog").open`, 30, "the movie dialog");
  check(await evaluate(`document.querySelector("#movieEngine").value`) === "gpu", "the movie dialog defaults to the shader");
  await evaluate(`document.querySelector("#movieDialog").close(); true`);

  const f0 = Math.min(frames - 1, 10), f1 = Math.min(frames - 1, 12);
  const nat = nativeFrames(f0, f1, w, h);
  const unzip = (zipName, dir) => { fs.mkdirSync(dir, { recursive: true }); const r = spawnSync("unzip", ["-o", "-q", path.join(work, zipName), "-d", dir]); if (r.status !== 0) throw new Error("unzip failed"); return fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(dir, f)); };
  name = await movie("gpu", "png", f0, f1);
  let pngs = unzip(name, path.join(work, "gpu_png"));
  check(pngs.length === f1 - f0 + 1, `shader PNG movie has ${pngs.length} frames`);
  pngs.forEach((p, i) => compare(rgb(p), rgb(nat[i]), `shader PNG frame ${f0 + i} vs native`));
  name = await movie("cpu", "png", f0, f1);
  pngs = unzip(name, path.join(work, "cpu_png"));
  check(pngs.length === f1 - f0 + 1, `renderer PNG movie has ${pngs.length} frames`);
  pngs.forEach((p, i) => check(Buffer.compare(rgb(p), rgb(nat[i])) === 0, `renderer PNG frame ${f0 + i} identical to native`));

  // an MP4 from the shader, every frame: count, and a frame against native (lossy: a loose limit)
  name = await movie("gpu", "mp4", 0, frames - 1);
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v", "-count_frames", "-show_entries", "stream=nb_read_frames,width,height,codec_name", "-of", "csv=p=0", path.join(work, name)], { encoding: "utf8" }).stdout.trim();
  console.log("     ffprobe: " + probe);
  check(probe.split(",")[3] === String(frames), `shader MP4 has ${frames} frames`);
  const decoded = path.join(work, "mp4_frame.png");
  spawnSync("ffmpeg", ["-v", "error", "-y", "-i", path.join(work, name), "-vf", `select=eq(n\\,${f0})`, "-frames:v", "1", decoded]);
  compare(rgb(decoded), rgb(nat[0]), `shader MP4 frame ${f0} vs native (H.264)`, 12);

  // the Frame tab still renders with the wasm
  await evaluate(`document.querySelector("#tabFrame").click(); true`);
  await until(`/\\d+×\\d+ in [\\d.]+ s/.test(document.querySelector("#status").textContent)`, 120, "the Frame view to render");
  check(await evaluate(`document.querySelector("#tabFrame").classList.contains("on") && document.querySelector("#glview").hidden && !document.querySelector("#preview").hidden && document.querySelector("#render").textContent === "Render frame"`), "the Frame tab shows the wasm render");
  check(await evaluate(`JSON.parse(localStorage.getItem("qts-editor")).view`) === "frame", "the chosen view is remembered");

  console.log(failures ? `\n${failures} FAILED` : "\nall ok", keep ? `(files in ${work})` : "");
  ws.close();
  if (!keep) fs.rmSync(work, { recursive: true, force: true });
  quit(failures ? 1 : 0);
})().catch((e) => { console.error(e); quit(1); });
