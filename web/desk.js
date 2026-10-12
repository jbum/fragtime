// desk.js -- the node desk: an endless canvas of nodes and wires that pans and zooms.
//
// Ported from the Syd editor (csyd_200/web/index.html): view {x, y} + zoom, toPatch() from that
// state, track() for drags held by the desk itself (an iPad touch dies if its element is drawn
// away), a second finger aborts a drag and pinches, Option/Space/middle-drag and the wheel pan,
// ⌘/Ctrl-wheel and trackpad pinches zoom. Nodes here are HTML (each keeps its thumbnail canvas
// across redraws) in a layer the view transforms; wires are SVG underneath.
//
// The desk only draws and reports gestures; the app owns the patch, undo and every change:
//   app.patch, app.remember(), app.changed(), app.select(), app.connect(srcId, dstId, port),
//   app.status(text, isError), app.focusInspector()

import * as G from "./engine/graph.js";

export const NODE_W = 120, HEAD = 20, THUMB_W = 120, THUMB_H = 90, PORT_DY = 16;
const SVGNS = "http://www.w3.org/2000/svg";

export function nodeHeight(n) {
  const k = G.portsOf(n).length;
  return Math.max(HEAD + THUMB_H, HEAD + 12 + k * PORT_DY);
}
const portY = (i) => HEAD + 12 + i * PORT_DY;
const OUT_Y = HEAD + THUMB_H / 2;

function svgEl(name, attrs, parent) {
  const e = document.createElementNS(SVGNS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

// the short label a port shows
function portLabel(node, port) {
  if (node.type !== "sequence") return port;
  const m = node.params && node.params.modes && node.params.modes[port];
  return port.slice(1) + (m && m !== "normal" ? " " + m : "");
}

export class Desk {
  constructor(wrap, app) {
    this.wrap = wrap;
    this.app = app;
    this.svg = svgEl("svg", { class: "wires" }, wrap);
    this.layer = document.createElement("div");
    this.layer.className = "nodes";
    wrap.appendChild(this.layer);
    this.zoom = 1;
    this.view = { x: 0, y: 0 };
    this.autoFit = true;
    this.selection = new Set();      // node ids
    this.selWire = null;             // {node, port}
    this.errors = new Map();         // node id -> message
    this.els = new Map();            // node id -> {root, title, kind, thumb, ports, sig}
    this.dragWire = null;            // {x1, y1, x2, y2}
    this.rubber = null;
    this.current = null;
    this.touches = new Map();
    this.pinch = null;
    this.spaceDown = false;
    this.drawPending = false;
    this.bind();
    new ResizeObserver(() => { if (this.app.patch) (this.autoFit ? this.fit() : this.draw()); }).observe(wrap);
  }

  // ---- geometry ------------------------------------------------------------------------

  toPatch(e) {
    const r = this.wrap.getBoundingClientRect();
    return { x: this.view.x + (e.clientX - r.left) / this.zoom, y: this.view.y + (e.clientY - r.top) / this.zoom };
  }
  bounds() {
    const nodes = this.app.patch.nodes;
    if (!nodes.length) return { x0: 0, y0: 0, x1: 400, y1: 300 };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      x0 = Math.min(x0, n.x - 70); y0 = Math.min(y0, n.y - 20);
      x1 = Math.max(x1, n.x + NODE_W + 20); y1 = Math.max(y1, n.y + nodeHeight(n) + 20);
    }
    return { x0, y0, x1, y1 };
  }
  // the whole patch in view; open: a patch too big to read whole opens on its Output instead
  fit(open) {
    this.autoFit = !open;
    const b = this.bounds(), W = this.wrap.clientWidth, H = this.wrap.clientHeight;
    if (!W || !H) return;
    const z = Math.min(1.5, (W - 30) / (b.x1 - b.x0), (H - 30) / (b.y1 - b.y0));
    if (open && z < 0.45) {
      this.zoom = 0.6;
      const out = G.outputNode(this.app.patch);
      if (out) {
        this.view.x = out.x + NODE_W + 40 - W / this.zoom;
        this.view.y = out.y + nodeHeight(out) / 2 - H / this.zoom / 2;
        this.draw();
        return;
      }
    }
    this.zoom = Math.max(0.1, z);
    this.view.x = (b.x0 + b.x1) / 2 - W / this.zoom / 2;
    this.view.y = (b.y0 + b.y1) / 2 - H / this.zoom / 2;
    this.draw();
  }
  // a free spot near the top left of the view, for a node added by a click
  freeSpot() {
    const r = this.wrap.getBoundingClientRect();
    const c = this.toPatch({ clientX: r.left + 90, clientY: r.top + 30 });
    const p = { x: Math.round(c.x), y: Math.round(c.y) };
    const nodes = this.app.patch.nodes;
    for (let i = 0; i < 200 && nodes.some((n) => Math.abs(n.x - p.x) < NODE_W + 20 && Math.abs(n.y - p.y) < 120); ++i) {
      p.y += 130;
      if (p.y > c.y + r.height / this.zoom - 100) { p.y = Math.round(c.y); p.x += NODE_W + 110; }
    }
    return p;
  }

  // ---- drawing -------------------------------------------------------------------------

  drawSoon() {
    if (this.drawPending) return;
    this.drawPending = true;
    requestAnimationFrame(() => { this.drawPending = false; this.draw(); });
  }

  draw() {
    const patch = this.app.patch;
    if (!patch) return;
    const W = Math.max(1, this.wrap.clientWidth), H = Math.max(1, this.wrap.clientHeight);
    const z = this.zoom, w = W / z, h = H / z;
    this.layer.style.transform = `scale(${z}) translate(${-this.view.x}px, ${-this.view.y}px)`;
    this.syncNodes();
    const svg = this.svg;
    svg.textContent = "";
    svg.setAttribute("viewBox", `${this.view.x} ${this.view.y} ${w} ${h}`);
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    const defs = svgEl("defs", {}, svg);
    const pat = svgEl("pattern", { id: "dots", width: 24, height: 24, patternUnits: "userSpaceOnUse" }, defs);
    svgEl("circle", { cx: 1, cy: 1, r: 1, fill: "var(--desk-dot)" }, pat);
    svgEl("rect", { x: this.view.x, y: this.view.y, width: w, height: h, fill: "url(#dots)", class: "backdrop" }, svg);
    const byId = G.nodeById(patch);
    for (const dst of patch.nodes) {
      G.portsOf(dst).forEach((port, i) => {
        const src = byId.get(dst.inputs[port]);
        if (!src) return;
        const x1 = src.x + NODE_W, y1 = src.y + OUT_Y, x2 = dst.x, y2 = dst.y + portY(i);
        const c = Math.max(40, Math.abs(x2 - x1) / 2);
        const d = `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`;
        const sel = this.selWire && this.selWire.node === dst.id && this.selWire.port === port;
        const lit = this.selection.has(src.id) || this.selection.has(dst.id);
        svgEl("path", { d, class: "wire" + (sel ? " sel" : lit ? " lit" : "") }, svg);
        const hit = svgEl("path", { d, class: "wire-hit" }, svg);
        svgEl("title", {}, hit).textContent = `${src.id} → ${dst.id}${dst.type === "output" ? "" : " ($" + port + ")"}`;
        hit.addEventListener("pointerdown", (e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          this.selection.clear();
          this.selWire = { node: dst.id, port };
          this.app.select();
          this.draw();
        });
      });
    }
    if (this.dragWire) {
      const { x1, y1, x2, y2 } = this.dragWire, c = Math.max(40, Math.abs(x2 - x1) / 2);
      svgEl("path", { d: `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`, class: "wire drag" }, svg);
    }
    if (this.rubber) {
      const r = this.rubber;
      svgEl("rect", { x: Math.min(r.x0, r.x1), y: Math.min(r.y0, r.y1), width: Math.abs(r.x1 - r.x0), height: Math.abs(r.y1 - r.y0), class: "rubber" }, svg);
    }
    if (this.app.drawn) this.app.drawn();
  }

  // the HTML nodes: kept across draws, updated in place
  syncNodes() {
    const patch = this.app.patch, seen = new Set();
    for (const n of patch.nodes) {
      seen.add(n.id);
      let e = this.els.get(n.id);
      if (!e) e = this.makeNode(n);
      const ports = G.portsOf(n);
      const sig = n.type + "|" + ports.map((p) => p + ":" + (n.inputs[p] ? 1 : 0) + ":" + portLabel(n, p)).join(",");
      if (e.sig !== sig) { this.buildPorts(e, n, ports); e.sig = sig; }
      e.root.style.left = n.x + "px";
      e.root.style.top = n.y + "px";
      e.root.style.height = nodeHeight(n) + "px";
      e.root.className = `node t-${n.type}${this.selection.has(n.id) ? " sel" : ""}${this.errors.has(n.id) ? " err" : ""}`;
      e.title.textContent = n.id;
      e.kind.textContent = G.NODE_TYPES[n.type] ? G.NODE_TYPES[n.type].label.toLowerCase() : n.type;
      e.root.title = this.errors.get(n.id) || "";
      e.node = n;
    }
    for (const [id, e] of this.els) if (!seen.has(id)) { e.root.remove(); this.els.delete(id); }
  }

  makeNode(n) {
    const root = document.createElement("div");
    const head = document.createElement("div");
    head.className = "head";
    const title = document.createElement("span");
    title.className = "name";
    const kind = document.createElement("span");
    kind.className = "kind";
    head.append(title, kind);
    const thumb = document.createElement("canvas");
    thumb.className = "thumb";
    thumb.width = 96; thumb.height = 72;
    const out = document.createElement("div");
    out.className = "port out";
    out.title = "drag to wire this node into another";
    root.append(head, thumb, out);
    this.layer.appendChild(root);
    const e = { root, title, kind, thumb, out, ports: [], sig: "", node: n };
    root.addEventListener("pointerdown", (ev) => this.startMove(ev, e.node));
    root.addEventListener("dblclick", () => this.app.focusInspector());
    out.addEventListener("pointerdown", (ev) => this.startWire(ev, e.node));
    this.els.set(n.id, e);
    return e;
  }

  buildPorts(e, n, ports) {
    for (const p of e.ports) p.remove();
    e.ports = [];
    e.out.hidden = n.type === "output";
    ports.forEach((port, i) => {
      const d = document.createElement("div");
      d.className = "port in" + (n.inputs[port] ? "" : " open");
      d.style.top = portY(i) + "px";
      d.dataset.port = port;
      const lab = document.createElement("span");
      lab.textContent = portLabel(n, port);
      d.appendChild(lab);
      d.title = n.inputs[port] ? `${port} ← ${n.inputs[port]}` : `${port}: drag to a node to wire it here`;
      d.addEventListener("pointerdown", (ev) => this.startWireBack(ev, e.node, port));
      e.root.appendChild(d);
      e.ports.push(d);
    });
  }

  thumbOf(id) { const e = this.els.get(id); return e ? e.thumb : null; }
  // the ids of the nodes in view (for thumbnails)
  visibleIds() {
    const W = this.wrap.clientWidth / this.zoom, H = this.wrap.clientHeight / this.zoom, v = this.view;
    return this.app.patch.nodes.filter((n) => n.x + NODE_W > v.x && n.x < v.x + W && n.y + nodeHeight(n) > v.y && n.y < v.y + H).map((n) => n.id);
  }

  // ---- gestures --------------------------------------------------------------------------

  // Follow a drag to its end; the desk holds the pointer (see the header).
  track(e, move, up, abort) {
    try { this.wrap.setPointerCapture(e.pointerId); } catch (_) {}
    const id = e.pointerId;
    const onMove = (ev) => { if (ev.pointerId === id) move(ev); };
    const onUp = (ev) => { if (ev.pointerId !== id) return; stop(); up(ev); };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (this.current && this.current.stop === stop) this.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    this.current = { stop, abort };
  }

  startMove(e, n) {
    if (e.button !== 0 || e.target.closest(".port")) return;
    e.stopPropagation();
    e.preventDefault();
    this.selWire = null;
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      this.selection.has(n.id) ? this.selection.delete(n.id) : this.selection.add(n.id);
      this.app.select();
      this.draw();
      return;
    }
    if (!this.selection.has(n.id)) { this.selection.clear(); this.selection.add(n.id); this.app.select(); }
    const patch = this.app.patch;
    const start = this.toPatch(e), moving = patch.nodes.filter((m) => this.selection.has(m.id)), orig = moving.map((m) => [m.x, m.y]);
    let moved = false;
    this.draw();
    this.track(e, (ev) => {
      const p = this.toPatch(ev), dx = Math.round(p.x - start.x), dy = Math.round(p.y - start.y);
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      if (!moved) { this.app.remember(); moved = true; }
      moving.forEach((m, i) => { m.x = orig[i][0] + dx; m.y = orig[i][1] + dy; });
      this.drawSoon();
    }, () => { if (moved) this.app.changed({ layoutOnly: true }); }, () => {
      moving.forEach((m, i) => { m.x = orig[i][0]; m.y = orig[i][1]; });
      if (moved) this.app.forgetLast();
      this.draw();
    });
  }

  // what is under the pointer: {node, port} (port null for the body)
  hitAt(ev) {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const nodeEl = el && el.closest(".node");
    if (!nodeEl) return null;
    const e = [...this.els.values()].find((x) => x.root === nodeEl);
    if (!e) return null;
    const portEl = el.closest(".port.in");
    return { node: e.node, port: portEl ? portEl.dataset.port : null };
  }

  // from an output: drop on a node (a new or the first free port) or on one of its ports
  startWire(e, src) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const p = this.toPatch(e);
    this.dragWire = { x1: src.x + NODE_W, y1: src.y + OUT_Y, x2: p.x, y2: p.y };
    this.draw();
    this.track(e, (ev) => {
      const q = this.toPatch(ev);
      this.dragWire.x2 = q.x; this.dragWire.y2 = q.y;
      this.drawSoon();
    }, (ev) => {
      this.dragWire = null;
      const hit = this.hitAt(ev);
      if (hit && hit.node !== src) this.app.connect(src.id, hit.node.id, hit.port);
      else this.draw();
    }, () => { this.dragWire = null; this.draw(); });
  }

  // from an input port: drop on the node that should feed it
  startWireBack(e, dst, port) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const i = G.portsOf(dst).indexOf(port), p = this.toPatch(e);
    this.dragWire = { x1: p.x, y1: p.y, x2: dst.x, y2: dst.y + portY(i) };
    this.draw();
    let moved = false;
    const sx = e.clientX, sy = e.clientY;
    this.track(e, (ev) => {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 4) moved = true;
      const q = this.toPatch(ev);
      this.dragWire.x1 = q.x; this.dragWire.y1 = q.y;
      this.drawSoon();
    }, (ev) => {
      this.dragWire = null;
      if (!moved) {           // a click on a port selects its wire
        if (dst.inputs[port]) { this.selection.clear(); this.selWire = { node: dst.id, port }; this.app.select(); }
        this.draw();
        return;
      }
      const hit = this.hitAt(ev);
      if (hit && hit.node !== dst) this.app.connect(hit.node.id, dst.id, port);
      else this.draw();
    }, () => { this.dragWire = null; this.draw(); });
  }

  beginRubber(p, additive) {
    this.rubberBefore = additive ? new Set(this.selection) : new Set();
    this.rubber = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    this.selWire = null;
    this.selection = new Set(this.rubberBefore);
    this.draw();
  }
  updateRubber(q) {
    const r = this.rubber;
    r.x1 = q.x; r.y1 = q.y;
    const [lx, hx] = [Math.min(r.x0, q.x), Math.max(r.x0, q.x)], [ly, hy] = [Math.min(r.y0, q.y), Math.max(r.y0, q.y)];
    this.selection = new Set(this.rubberBefore);
    for (const n of this.app.patch.nodes)
      if (n.x + NODE_W > lx && n.x < hx && n.y + nodeHeight(n) > ly && n.y < hy) this.selection.add(n.id);
    this.drawSoon();
  }
  endRubber(abort) {
    if (abort) this.selection = this.rubberBefore;
    this.rubber = null;
    this.draw();
    this.app.select();
  }

  panBy(dx, dy) {
    this.autoFit = false;
    this.view.x -= dx / this.zoom;
    this.view.y -= dy / this.zoom;
    this.drawSoon();
  }
  zoomAt(cx, cy, factor) {
    this.autoFit = false;
    const p = this.toPatch({ clientX: cx, clientY: cy }), r = this.wrap.getBoundingClientRect();
    this.zoom = Math.max(0.1, Math.min(4, this.zoom * factor));
    this.view.x = p.x - (cx - r.left) / this.zoom;
    this.view.y = p.y - (cy - r.top) / this.zoom;
    this.drawSoon();
  }
  zoomCentre(factor) {
    const r = this.wrap.getBoundingClientRect();
    this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  }
  // bring a node into view (centred) without changing the zoom
  reveal(id) {
    const n = this.app.patch.nodes.find((m) => m.id === id);
    if (!n) return;
    this.autoFit = false;
    this.view.x = n.x + NODE_W / 2 - this.wrap.clientWidth / this.zoom / 2;
    this.view.y = n.y + nodeHeight(n) / 2 - this.wrap.clientHeight / this.zoom / 2;
    this.draw();
  }

  bind() {
    const wrap = this.wrap;
    // empty desk: with a mouse, a selection rectangle; with a finger, pan, or press and hold
    // for a selection rectangle; a tap deselects
    wrap.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".node") || e.target.closest(".deskTools") || e.target.classList.contains("wire-hit")) return;
      const p = this.toPatch(e);
      if (e.pointerType !== "touch") {
        if (!(e.shiftKey || e.metaKey) && (this.selection.size || this.selWire)) { this.selection.clear(); this.selWire = null; this.app.select(); }
        this.beginRubber(p, e.shiftKey || e.metaKey);
        this.track(e, (ev) => this.updateRubber(this.toPatch(ev)), () => this.endRubber(), () => this.endRubber(true));
        return;
      }
      let mode = "pending", lx = e.clientX, ly = e.clientY;
      const sx = e.clientX, sy = e.clientY;
      const hold = setTimeout(() => {
        if (mode !== "pending") return;
        mode = "rubber";
        if (navigator.vibrate) navigator.vibrate(10);
        this.beginRubber(p, false);
      }, 450);
      this.track(e, (ev) => {
        if (mode === "pending" && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) { mode = "pan"; clearTimeout(hold); }
        if (mode === "pan") this.panBy(ev.clientX - lx, ev.clientY - ly);
        else if (mode === "rubber") this.updateRubber(this.toPatch(ev));
        lx = ev.clientX; ly = ev.clientY;
      }, () => {
        clearTimeout(hold);
        if (mode === "rubber") this.endRubber();
        else if (mode === "pending" && (this.selection.size || this.selWire)) {
          this.selection.clear(); this.selWire = null;
          this.draw(); this.app.select();
        }
      }, () => { clearTimeout(hold); if (mode === "rubber") this.endRubber(true); });
    });

    // capture phase: a pan or pinch wins over the node or wire under the pointer
    wrap.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".deskTools")) return;
      if (e.pointerType === "touch") {
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.touches.size >= 2) {
          e.stopPropagation();
          e.preventDefault();
          if (this.current) { const c = this.current; c.stop(); c.abort && c.abort(); }
          if (this.touches.size === 2) this.startPinch();
        }
        return;
      }
      if (e.button === 1 || (e.button === 0 && (e.altKey || this.spaceDown))) {
        e.stopPropagation();
        e.preventDefault();
        let lx = e.clientX, ly = e.clientY;
        wrap.classList.add("grabbing");
        this.track(e, (ev) => { this.panBy(ev.clientX - lx, ev.clientY - ly); lx = ev.clientX; ly = ev.clientY; },
          () => wrap.classList.remove("grabbing"), () => wrap.classList.remove("grabbing"));
      }
    }, true);

    window.addEventListener("pointermove", (e) => {
      if (!this.touches.has(e.pointerId)) return;
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!this.pinch || this.touches.size < 2) return;
      const [a, b] = [...this.touches.values()], r = wrap.getBoundingClientRect();
      this.zoom = Math.max(0.1, Math.min(4, this.pinch.z0 * Math.hypot(a.x - b.x, a.y - b.y) / this.pinch.d0));
      this.view.x = this.pinch.anchor.x - ((a.x + b.x) / 2 - r.left) / this.zoom;
      this.view.y = this.pinch.anchor.y - ((a.y + b.y) / 2 - r.top) / this.zoom;
      this.drawSoon();
    });
    const fingerUp = (e) => {
      if (!this.touches.delete(e.pointerId)) return;
      if (this.pinch && this.touches.size < 2) this.pinch = null;
    };
    window.addEventListener("pointerup", fingerUp);
    window.addEventListener("pointercancel", fingerUp);

    wrap.addEventListener("wheel", (e) => {
      if (e.target.closest(".deskTools")) return;
      e.preventDefault();
      let dx = e.deltaX, dy = e.deltaY;
      if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
      if (e.ctrlKey || e.metaKey) this.zoomAt(e.clientX, e.clientY, Math.exp(-Math.max(-50, Math.min(50, dy)) * 0.01));
      else { if (e.shiftKey && !dx) { dx = dy; dy = 0; } this.panBy(-dx, -dy); }
    }, { passive: false });

    let gestureZoom = 1;
    wrap.addEventListener("gesturestart", (e) => { e.preventDefault(); gestureZoom = 1; });
    wrap.addEventListener("gesturechange", (e) => {
      e.preventDefault();
      if (this.touches.size) return;
      this.zoomAt(e.clientX, e.clientY, e.scale / gestureZoom);
      gestureZoom = e.scale;
    });

    const typing = () => { const a = document.activeElement; return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable); };
    window.addEventListener("keydown", (e) => {
      if (e.key === " " && !typing()) { if (!this.spaceDown) { this.spaceDown = true; wrap.classList.add("grab"); } e.preventDefault(); }
    });
    window.addEventListener("keyup", (e) => { if (e.key === " ") { this.spaceDown = false; wrap.classList.remove("grab"); } });
  }

  startPinch() {
    const [a, b] = [...this.touches.values()];
    const mid = { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 };
    this.pinch = { d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), z0: this.zoom, anchor: this.toPatch(mid) };
    this.autoFit = false;
  }
}
