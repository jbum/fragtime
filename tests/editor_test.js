#!/usr/bin/env node
// Drives the built editor (build/web) in headless Chrome on the real GPU (Metal) with real mouse
// and key input (the DevTools protocol), and checks what it does and saves:
//   node tests/editor_test.js [-p port] [-k keep_dir]
// The example is fire (an example name, not a path). Saved frames and movies are compared with
// the native qts rendering the same script (make first), as the shader always was.
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let port = 8781, keep = "";
for (let i = 2; i < process.argv.length; ++i) {
  if (process.argv[i] === "-p") port = parseInt(process.argv[++i], 10);
  else if (process.argv[i] === "-k") keep = process.argv[++i];
}
const web = path.join(root, "build/web");
if (!fs.existsSync(path.join(web, "examples/index.json"))) { console.error("build the site first (build/build_web.py)"); process.exit(1); }
const work = keep || fs.mkdtempSync(path.join(os.tmpdir(), "ft-editor-"));
fs.mkdirSync(work, { recursive: true });
const server = spawn("node", [path.join(root, "build/serve.js"), String(port), web], { stdio: "ignore" });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ft-editor-profile-"));
const chrome = spawn(CHROME, ["--headless=new", "--use-angle=metal", "--hide-scrollbars", "--remote-debugging-port=0",
  `--user-data-dir=${profile}`, "--window-size=1400,900", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const quit = (code) => { chrome.kill(); server.kill(); setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} process.exit(code); }, 300); };
setTimeout(() => { console.error("timed out"); quit(1); }, 600000).unref();
const check = (cond, msg) => { console.log((cond ? "ok   " : "FAIL ") + msg); if (!cond) failures++; };

function nativeFrames(f0, f1, w, h) {
  const dir = path.join(work, "native"); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(path.join(root, "qts"), ["-q", "-j", "8", "-w", String(w), "-h", String(h), "-f", `${f0}-${f1}`, "-o", path.join(dir, "f"), path.join(root, "examples", "fire.can")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("qts: " + r.stderr);
  return fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(dir, f));
}
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
  const pending = new Map(), waiters = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Runtime.consoleAPICalled") {
      const v = m.params.args[0] && m.params.args[0].value;
      if (typeof v === "string" && v.startsWith("FILE ")) {
        const [, name, data] = v.split(" ");
        fs.writeFileSync(path.join(work, name), Buffer.from(data, "base64"));
        for (const w of waiters.splice(0)) w(name);
      } else if (m.params.type === "error") console.error("page:", v);
    }
    if (m.method === "Runtime.exceptionThrown") console.error("page exception:", m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
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
    while (Date.now() - t0 < secs * 1000) { if (await evaluate(expr)) return true; await sleep(150); }
    check(false, `waited ${secs} s for ${what}`);
    return false;
  };
  // real input
  const mouse = async (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", Object.assign({ type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 }, extra));
  const click = async (x, y) => { await mouse("mouseMoved", x, y, { buttons: 0 }); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); await sleep(80); };
  const drag = async (x1, y1, x2, y2) => {
    await mouse("mouseMoved", x1, y1, { buttons: 0 }); await mouse("mousePressed", x1, y1);
    for (let i = 1; i <= 8; ++i) { await mouse("mouseMoved", x1 + (x2 - x1) * i / 8, y1 + (y2 - y1) * i / 8); await sleep(16); }
    await mouse("mouseReleased", x2, y2); await sleep(120);
  };
  const key = async (k, code, keyCode, modifiers = 0) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: keyCode, modifiers });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: keyCode, modifiers });
    await sleep(80);
  };
  const centre = (sel) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const nodeSel = (id) => `[data-node="${id}"]`;
  const nodeCentre = (id) => evaluate(`(() => { const e = [...document.querySelectorAll(".node")].find((n) => n.querySelector(".name").textContent === ${JSON.stringify(id)}); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height * 0.6]; })()`);
  const outPort = (id) => evaluate(`(() => { const e = [...document.querySelectorAll(".node")].find((n) => n.querySelector(".name").textContent === ${JSON.stringify(id)}); const r = e.querySelector(".port.out").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const patch = () => evaluate(`JSON.parse(JSON.stringify(fragtime.state.patch))`);
  const node = async (id) => (await patch()).nodes.find((n) => n.id === id);
  const picture = (t) => evaluate(`(() => { const p = fragtime.player; p.pause(); p.draw(${t}); const px = p.pixels(); let h = 0; for (let i = 0; i < px.length; i += 7) h = (h * 31 + px[i]) | 0; return h; })()`);
  const compiles = () => evaluate(`fragtime.state.compiled ? fragtime.state.compiled.key : ""`);
  const recompiled = async (before, what) => until(`(fragtime.state.compiled ? fragtime.state.compiled.key : "") !== ${JSON.stringify(before)}`, 20, what);

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/?x=fire` });
  await until(`!!(window.fragtime && fragtime.state.compiled && fragtime.state.preview)`, 60, "fire to compile");
  await evaluate(`window.qtsDownloadHook = (blob, name) => blob.arrayBuffer().then((b) => {
    let s = ""; const u = new Uint8Array(b); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    console.log("FILE " + name + " " + btoa(s)); }); true`);

  // the patch and the picture
  const ids = await evaluate(`[...document.querySelectorAll(".node .name")].map((e) => e.textContent).sort().join(",")`);
  check(ids === "b,b1,b2,layer1,out", `fire opens as its graph: ${ids}`);
  const t1 = await evaluate(`document.querySelector("#timeText").textContent`); await sleep(600);
  const t2 = await evaluate(`document.querySelector("#timeText").textContent`);
  check(t1 !== t2, `the picture plays (${t1} → ${t2})`);
  await until(`(() => { const c = [...document.querySelectorAll(".node")].find((n) => n.querySelector(".name").textContent === "b1").querySelector("canvas"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i]; return s > 0; })()`, 10, "thumbnails");
  check(true, "node thumbnails are drawn");

  // select by clicking, edit the expression, undo
  let [x, y] = await nodeCentre("b");
  await click(x, y);
  check(await evaluate(`[...fragtime.app.desk.selection].join()`) === "b", "a click selects the node");
  check(await evaluate(`document.querySelector("#inspector textarea.main").value`) === "terp($b1,$b2)", "the inspector shows its expression");
  const pic0 = await picture(2), key0 = await compiles();
  await evaluate(`(() => { const t = document.querySelector("#inspector textarea.main"); t.focus(); t.value = "$b1"; t.dispatchEvent(new Event("input")); return 1; })()`);
  await recompiled(key0, "the edit to compile");
  check(await picture(2) !== pic0, "editing the expression changes the picture");
  await evaluate(`document.activeElement.blur(), 1`);
  await click(...(await centre("#undo")));
  await until(`fragtime.state.patch.nodes.find((n) => n.id === "b").params.mono === "terp($b1,$b2)"`, 5, "undo");
  await until(`fragtime.state.compiled && fragtime.state.compiled.key === ${JSON.stringify(key0)}`, 20, "the undone patch to compile");
  check(await picture(2) === pic0, "undo restores the picture exactly");

  // an expression error shows on the node and in the inspector, and the last picture stays
  await evaluate(`(() => { const t = document.querySelector("#inspector textarea.main"); t.focus(); t.value = "terp($b1,"; t.dispatchEvent(new Event("input")); return 1; })()`);
  await until(`document.querySelector(".node.err") !== null`, 10, "the error to show");
  check(/expected|parse/.test(await evaluate(`document.querySelector("#inspector .colorErr").textContent`)), "the error is under the field: " + await evaluate(`document.querySelector("#inspector .colorErr").textContent`));
  await evaluate(`document.activeElement.blur(), 1`);
  await click(...(await centre("#undo")));
  await until(`document.querySelector(".node.err") === null`, 10, "the error to clear");

  // Warp with layer1 selected: inserted between layer1 and the output
  [x, y] = await nodeCentre("layer1");
  await click(x, y);
  const k1 = await compiles();
  await click(...(await evaluate(`(() => { const b = [...document.querySelectorAll("#palette button")].find((e) => e.textContent === "Warp"); const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`)));
  const warp = await node("warp"), out = await node("out");
  check(warp && warp.inputs.in === "layer1" && out.inputs.in === "warp", "Warp goes in after the selected node");
  await recompiled(k1, "the warp to compile");
  check(await picture(2) !== pic0, "and warps the picture");

  // drag a wire from b1 onto the warp node: a new port named b1
  await evaluate(`fragtime.app.desk.fit(), 1`); await sleep(200);
  const [ox, oy] = await outPort("b1"); [x, y] = await nodeCentre("warp");
  await drag(ox, oy, x, y);
  check((await node("warp")).inputs.b1 === "b1", "dragging a wire onto a node adds an input named after the source");
  // a wire that would loop is refused
  const [wx, wy] = await outPort("warp"); [x, y] = await nodeCentre("b1");
  const before = JSON.stringify(await patch());
  await drag(wx, wy, x, y);
  check(JSON.stringify(await patch()) === before, "a wire that would make a loop is refused");

  // Delete takes the warp out and heals the chain
  [x, y] = await nodeCentre("warp");
  await click(x, y);
  await key("Delete", "Delete", 46);
  check(!(await node("warp")) && (await node("out")).inputs.in === "layer1", "Delete removes the node and rewires its reader to its input");
  await until(`fragtime.state.compiled && fragtime.state.compiled.key === ${JSON.stringify(key0)}`, 20, "the healed patch to compile");
  check(await picture(2) === pic0, "the picture is back to fire's");

  // Save frame: paused at the middle, named by frame, against native qts
  await evaluate(`(() => { const s = document.querySelector("#time"); s.value = "0.5"; s.dispatchEvent(new Event("input")); return true; })()`);
  check(await evaluate(`document.querySelector("#shaderPlay").textContent`) === "▶", "moving the slider pauses");
  let got = nextFile();
  await evaluate(`document.querySelector("#savePng").click(), 1`);
  let name = await got;
  check(name === "fire_0049.png", `Save frame named by the frame: ${name}`);
  compare(rgb(path.join(work, name)), rgb(nativeFrames(48, 48, 320, 240)[0]), "saved frame 48 vs native");

  // movies
  const movie = async (format, range) => {
    await evaluate(`document.querySelector("#movie").click(), 1`);
    await until(`document.querySelector("#movieDialog").open`, 20, "the movie dialog");
    await evaluate(`(() => { document.querySelector("#movieFormat").value = "${format}";
      ${range ? `document.querySelector("#movieSome").checked = true; document.querySelector("#movieFirst").value = ${range[0]}; document.querySelector("#movieLast").value = ${range[1]};` : `document.querySelector("#movieAll").checked = true;`}
      document.querySelector("#movieGo").click(); return 1; })()`);
    return nextFile();
  };
  got = movie("png", [11, 13]);
  name = await got;
  const zdir = path.join(work, "zip"); fs.rmSync(zdir, { recursive: true, force: true }); fs.mkdirSync(zdir);
  spawnSync("unzip", ["-q", "-o", path.join(work, name), "-d", zdir]);
  const pngs = fs.readdirSync(zdir).filter((f) => f.endsWith(".png")).sort();
  check(pngs.join() === "fire_0011.png,fire_0012.png,fire_0013.png", `PNG movie frames ${pngs.join(" ")}`);
  const nat = nativeFrames(10, 12, 320, 240);
  pngs.forEach((f, i) => compare(rgb(path.join(zdir, f)), rgb(nat[i]), `PNG movie frame ${10 + i} vs native`));
  got = movie("mp4");
  name = await got;
  const probe = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,nb_read_frames", "-of", "csv=p=0", path.join(work, name)], { encoding: "utf8" }).stdout.trim();
  check(probe === "h264,320,240,96", `MP4 movie: ${probe}`);
  const f10 = path.join(work, "mp4_10.png");
  spawnSync("ffmpeg", ["-v", "error", "-y", "-i", path.join(work, name), "-vf", "select=eq(n\\,10)", "-frames:v", "1", f10]);
  compare(rgb(f10), rgb(nativeFrames(10, 10, 320, 240)[0]), "MP4 frame 10 vs native (H.264)", 12);

  // the Source tab
  await evaluate(`document.querySelector("#tabSource").click(), 1`);
  const src = await evaluate(`document.querySelector("#sourceText").value`);
  check(/"fragtime":1/.test(src) && /"id":"layer1"/.test(src), "the Source tab shows the patch as JSON");
  await evaluate(`(() => { const t = document.querySelector("#sourceText"); t.value = t.value.replace('"title":"fire"', '"title":"fire2"'); document.querySelector("#applySource").click(); return 1; })()`);
  check(await evaluate(`fragtime.state.patch.title`) === "fire2", "Apply takes the edited text");
  await evaluate(`document.querySelector("#tabPatch").click(), 1`);

  // the patch stays in the browser
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await until(`!!(window.fragtime && fragtime.state.compiled)`, 60, "the reload");
  check(await evaluate(`fragtime.state.patch.title`) === "fire2" && await evaluate(`fragtime.state.patch.nodes.length`) === 5, "a reload reopens the patch");

  // touch, as on an iPad: one finger pans the desk, two pinch, a tap selects, a drag moves a
  // node, press and hold starts a selection box
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  const touch = (type, pts) => send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })) });
  const view = () => evaluate(`(() => { const d = fragtime.app.desk; return { x: d.view.x, y: d.view.y, z: d.zoom }; })()`);
  await evaluate(`fragtime.app.desk.fit(), 1`); await sleep(150);
  const desk = await evaluate(`(() => { const r = document.querySelector("#deskWrap").getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
  const ex = desk[0] + 30, ey = desk[1] + desk[3] - 40;     // empty desk, bottom left
  let v0 = await view();
  await touch("touchStart", [[ex, ey]]);
  for (let i = 1; i <= 6; ++i) { await touch("touchMove", [[ex + i * 15, ey - i * 5]]); await sleep(16); }
  await touch("touchEnd", []); await sleep(100);
  let v1 = await view();
  check(Math.abs(v1.x - v0.x) > 20 && v1.z === v0.z, `one finger pans (view x ${v0.x.toFixed(0)} → ${v1.x.toFixed(0)})`);
  const cx = desk[0] + desk[2] / 2, cy = desk[1] + desk[3] / 2;
  await touch("touchStart", [[cx - 40, cy], [cx + 40, cy]]);
  for (let i = 1; i <= 6; ++i) { await touch("touchMove", [[cx - 40 - i * 15, cy], [cx + 40 + i * 15, cy]]); await sleep(16); }
  await touch("touchEnd", []); await sleep(100);
  const v2 = await view();
  check(v2.z > v1.z * 1.5, `two fingers pinch-zoom (${v1.z.toFixed(2)} → ${v2.z.toFixed(2)})`);
  await evaluate(`fragtime.app.desk.fit(), 1`); await sleep(150);
  [x, y] = await nodeCentre("b2");
  await touch("touchStart", [[x, y]]); await touch("touchEnd", []); await sleep(150);
  check(await evaluate(`[...fragtime.app.desk.selection].join()`) === "b2", "a tap selects a node");
  const b2 = await node("b2");
  await touch("touchStart", [[x, y]]);
  for (let i = 1; i <= 6; ++i) { await touch("touchMove", [[x + i * 8, y + i * 4]]); await sleep(16); }
  await touch("touchEnd", []); await sleep(100);
  const b2b = await node("b2");
  check(b2b.x > b2.x + 10 && b2b.y > b2.y + 5, `a finger drags a node (${b2.x},${b2.y} → ${b2b.x},${b2b.y})`);
  const [ax, ay] = await nodeCentre("b1"), [bx, by] = await nodeCentre("b2");
  const sx = Math.min(ax, bx) - 90, sy = Math.min(ay, by) - 80;
  await touch("touchStart", [[sx, sy]]); await sleep(600);
  for (let i = 1; i <= 6; ++i) { await touch("touchMove", [[sx + i * 30, sy + i * 40]]); await sleep(16); }
  await touch("touchMove", [[Math.max(ax, bx) + 20, Math.max(ay, by) + 20]]);
  await touch("touchEnd", []); await sleep(150);
  check(await evaluate(`[...fragtime.app.desk.selection].sort().join()`) === "b1,b2", "press and hold, then drag, selects a box: " + await evaluate(`[...fragtime.app.desk.selection].sort().join()`));
  await send("Emulation.setTouchEmulationEnabled", { enabled: false });

  // New, and opening a QTS script
  await evaluate(`document.querySelector("#new").click(), 1`);
  await until(`fragtime.state.patch.nodes.length === 2 && !!fragtime.state.compiled`, 20, "New");
  check(true, "New makes a two-node patch that compiles");
  const doc = await send("DOM.getDocument");
  const q = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#openFile" });
  await send("DOM.setFileInputFiles", { nodeId: q.result.nodeId, files: [path.join(root, "examples", "sun.can")] });
  await until(`fragtime.state.name === "sun.fragtime" && fragtime.state.patch.nodes.length > 10 && !!fragtime.state.compiled`, 30, "sun.can to import");
  check(true, `Open… imports a .can: ${await evaluate(`fragtime.state.patch.nodes.length`)} nodes`);

  console.log(failures ? `\n${failures} FAILED` : "\nall ok", keep ? `(files in ${work})` : "");
  ws.close();
  quit(failures ? 1 : 0);
})().catch((e) => { console.error(e); quit(1); });
