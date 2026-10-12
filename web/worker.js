// QTS render worker: one qts.wasm instance holding one compiled script.
//
// in:  {type:"compile", id, text, title, files:[{name, data:ArrayBuffer}]}
//      {type:"render", id, frame, nbrFrames, snapshot, width, height, y0, y1}
//      {type:"cancel"}
// out: {type:"compiled", id, ok, messages, info}
//      {type:"progress", id, rows}            rows rendered so far of this request
//      {type:"frame", id, width, height, y0, y1, rgba:ArrayBuffer}   rows y0..y1-1 only
//      {type:"error", id, message}

importScripts("qts.js");

const BAND = 12;          // rows per band: progress and cancel are checked between bands
let qts = null, api = null, handle = 0, cancelled = false;

async function boot() {
  qts = await createQTS({ print: () => {}, printErr: () => {} });
  api = {
    new_: qts.cwrap("qts_new", "number", []),
    free: qts.cwrap("qts_free", null, ["number"]),
    compile: qts.cwrap("qts_compile", "number", ["number", "string", "string", "string"]),
    messages: qts.cwrap("qts_messages", "string", ["number"]),
    info: qts.cwrap("qts_info", "string", ["number"]),
    render: qts.cwrap("qts_render", "number", ["number", "number", "number", "number", "number", "number", "number", "number"]),
  };
  try { qts.FS.mkdir("/work"); } catch (_) {}
}
const ready = boot();

function clearWork() {
  for (const name of qts.FS.readdir("/work")) {
    if (name === "." || name === "..") continue;
    try { qts.FS.unlink("/work/" + name); } catch (_) {}
  }
}

onmessage = async (e) => {
  const m = e.data;
  if (m.type === "cancel") { cancelled = true; return; }
  await ready;
  try {
    if (m.type === "compile") {
      clearWork();
      for (const f of m.files || []) qts.FS.writeFile("/work/" + f.name, new Uint8Array(f.data));
      if (handle) api.free(handle);
      handle = api.new_();
      const ok = api.compile(handle, m.text, m.title || "script", "/work");
      postMessage({ type: "compiled", id: m.id, ok: !!ok, messages: api.messages(handle), info: JSON.parse(api.info(handle)) });
    }
    else if (m.type === "render") {
      if (!handle) throw new Error("no script compiled");
      cancelled = false;
      const { frame, nbrFrames, snapshot, width, height } = m;
      const y0 = m.y0 || 0, y1 = m.y1 == null ? height : m.y1;
      let ptr = 0;
      for (let y = y0; y < y1; y += BAND) {
        const yb = Math.min(y + BAND, y1);
        ptr = api.render(handle, frame, nbrFrames, snapshot, width, height, y, yb);
        if (!ptr) throw new Error("render failed");
        postMessage({ type: "progress", id: m.id, rows: yb - y0 });
        // let a cancel message in (a MessageChannel hop: setTimeout is throttled in workers)
        await new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
        if (cancelled) { postMessage({ type: "error", id: m.id, message: "cancelled" }); return; }
      }
      const start = ptr + y0 * width * 4, end = ptr + y1 * width * 4;
      const rgba = qts.HEAPU8.slice(start, end).buffer;
      postMessage({ type: "frame", id: m.id, width, height, y0, y1, rgba }, [rgba]);
    }
  } catch (err) {
    postMessage({ type: "error", id: m.id, message: String(err && err.message || err) });
  }
};
