#!/usr/bin/env node
// Screenshots a URL in headless Chrome (software GL) at given moments: node tests/shoot.js URL out_prefix ms1 ms2 ...
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
const [url, prefix, ...times] = process.argv.slice(2);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "qts-shoot-"));
const chrome = spawn(CHROME, ["--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=640,480", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quit = (code) => { chrome.kill(); setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} process.exit(code); }, 300); };
setTimeout(() => { console.error("timed out"); quit(1); }, 120000).unref();
(async () => {
  const portFile = path.join(profile, "DevToolsActivePort");
  while (!fs.existsSync(portFile) || !fs.readFileSync(portFile, "utf8").includes("\n")) await sleep(100);
  const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") console.error("page:", m.params.args[0]?.value); });
  const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send("Runtime.enable");
  await send("Page.navigate", { url });
  let t0 = Date.now();
  for (const t of times) {
    const wait = parseInt(t, 10) - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(`${prefix}_${t}.png`, Buffer.from(shot.result.data, "base64"));
    const r = await send("Runtime.evaluate", { expression: "document.getElementById('err').textContent + '|' + (typeof player !== 'undefined' && player ? player.time.toFixed(2) + ' fps ' + player.fps.toFixed(1) : 'no player')" });
    console.log(`${t} ms: ${r.result.result.value}`);
  }
  ws.close(); quit(0);
})().catch((e) => { console.error(e); quit(1); });
