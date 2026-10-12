#!/usr/bin/env node
// The import regression gate: runs web/importtest.html in headless Chrome on the real GPU
// (Metal) over every example in examples/: each script drawn by its own shader (glsl.js) and
// by the shader of its imported patch (import_can.js + graph_glsl.js), at three moments; and
// the hand-made patches in tests/patches must compile there and draw.
//   node tests/import_test.js [-k regex] [-m maxside] [-p port] [-t secs]
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let filter = "", timeout = 1200, maxSide = 256, port = 8773;
for (let i = 2; i < process.argv.length; ++i) {
  if (process.argv[i] === "-k") filter = process.argv[++i];
  else if (process.argv[i] === "-m") maxSide = parseInt(process.argv[++i], 10);
  else if (process.argv[i] === "-p") port = parseInt(process.argv[++i], 10);
  else if (process.argv[i] === "-t") timeout = parseFloat(process.argv[++i]);
}
const server = spawn("node", [path.join(root, "build/serve.js"), String(port), root], { stdio: "ignore" });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ft-import-"));
const list = fs.readdirSync(path.join(root, "examples")).filter((f) => f.endsWith(".can")).sort().join(",");
const patches = fs.readdirSync(path.join(root, "tests/patches")).filter((f) => f.endsWith(".fragtime")).map((f) => "/tests/patches/" + f).join(",");
const url = `http://127.0.0.1:${port}/web/importtest.html?run&base=/examples/&list=${list}&patches=${patches}${filter ? "&k=" + encodeURIComponent(filter) : ""}${maxSide ? "&max=" + maxSide : ""}`;
const chrome = spawn(CHROME, ["--headless=new", "--use-angle=metal", "--hide-scrollbars", "--remote-debugging-port=0",
  `--user-data-dir=${profile}`, "--window-size=1200,900", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quit = (code) => { chrome.kill(); server.kill(); setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} process.exit(code); }, 300); };
setTimeout(() => { console.error("timed out"); summary(); quit(1); }, timeout * 1000).unref();
let ok = 0, bad = 0, failed = 0;
let skipped = 0;
function report(x) {
  if (x.skip) { skipped++; console.log(`skip   ${x.file.padEnd(22)} ${x.skip}`); return; }
  if (x.error) { failed++; console.log(`FAIL   ${x.file.padEnd(22)} ${x.error.split("\n")[0]}`); return; }
  if (x.ok) ok++; else bad++;
  console.log(`${x.ok ? "match " : "DIFFER"} ${x.file.padEnd(22)} ${String(x.nodes).padStart(3)} nodes  ${String(x.pct).padStart(7)}% differ, max ${String(x.max).padStart(3)}, ${String(x.bigPct).padStart(7)}% > 2   ${x.kb} KB${x.note ? "  " + x.note.slice(0, 120) : ""}`);
}
function summary() { console.log(`\n${ok} match, ${bad} differ, ${failed} failed, ${skipped} skipped`); }

(async () => {
  const portFile = path.join(profile, "DevToolsActivePort");
  while (!fs.existsSync(portFile) || !fs.readFileSync(portFile, "utf8").includes("\n")) await sleep(100);
  const dport = fs.readFileSync(portFile, "utf8").split("\n")[0];
  const targets = await (await fetch(`http://127.0.0.1:${dport}/json`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Runtime.consoleAPICalled") {
      const v = m.params.args[0] && m.params.args[0].value;
      if (typeof v === "string" && v.startsWith("RESULT ")) report(JSON.parse(v.slice(7)));
      else if (m.params.type === "error") console.error("page:", v);
    }
    if (m.method === "Runtime.exceptionThrown") console.error("page exception:", m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send("Runtime.enable");
  await send("Page.navigate", { url });
  let last = "";
  for (;;) {
    const r = await send("Runtime.evaluate", { expression: "document.title + '|' + (document.querySelector('#status')||{}).textContent" });
    const v = r.result && r.result.result && r.result.result.value || "";
    if (v.startsWith("ready|")) break;
    if (v !== last) { last = v; process.stderr.write("\r" + v.padEnd(60)); }
    await sleep(300);
  }
  process.stderr.write("\r" + " ".repeat(60) + "\r");
  summary();
  ws.close();
  quit(bad || failed ? 1 : 0);
})().catch((e) => { console.error(e); quit(1); });
