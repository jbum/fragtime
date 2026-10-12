// A static server for build/web (node build/serve.js [port] [root]); the Python one stalled Chrome.
const http = require("http"), fs = require("fs"), path = require("path");
const root = path.resolve(process.argv[3] || path.join(__dirname, "web")), port = parseInt(process.argv[2] || "8766", 10);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".can": "text/plain", ".glsl": "text/plain" };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const file = path.normalize(path.join(root, p));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end("not found"); }
    const type = types[path.extname(file)] || "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range) {   // media elements fetch by ranges
      let start = range[1] ? parseInt(range[1], 10) : 0, end = range[2] ? parseInt(range[2], 10) : st.size - 1;
      if (!range[1] && range[2]) { start = st.size - parseInt(range[2], 10); end = st.size - 1; }
      if (start > end || end >= st.size) { res.writeHead(416, { "Content-Range": "bytes */" + st.size }); return res.end(); }
      res.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" });
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}).listen(port, "127.0.0.1", () => console.log("http://127.0.0.1:" + port + "/"));
