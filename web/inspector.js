// inspector.js -- the panel beside the desk: what is selected, and its fields.
//
// Fields edit the patch as you type (the app recompiles a moment later); one undo step per
// field visit. The panel is rebuilt when the selection or the patch's shape changes, never
// while a field has the focus; compile errors are written into it in place (showErrors).

import * as G from "./engine/graph.js";

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const k in props || {}) {
    const v = props[k];
    if (v === undefined || v === null) continue;
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "text") e.textContent = v;
    else if (k === "className") e.className = v;
    else if (k in e && k !== "list") e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return e;
}

const FIELD_HELP = {
  left: "x at the left edge", top: "y at the top edge", width: "the field's width (x runs left … left+width)",
  height: "the field's height; w*fh/fw keeps pixels square", center: "left/top give the centre, not the corner",
  zoom: "zoom factor per frame", zoomfunc: "how far the zoom has gone, 0..1 (t: steadily)", endwidth: "zoom so the width ends here",
  min: "the value shown black", max: "the value shown full", wrap: "wrap values outside min..max instead of clamping",
  cycle: "rotate the values a little every frame", image: "the image sample() and friends read", tile: "repeat the image (and $reads) outside 0..1",
  recurse: "iterations for fractals (i)", p0: "a parameter (jx), for julia", q0: "a parameter (jy), for julia",
  debut: "seconds after its caller starts; last: after the previous input of its sequence", duration: "seconds; empty: its caller's",
};

const COLOR_HELP = {
  pix: "an expression for the colour (a number is grey; rgb(r,g,b) a colour)",
  rgb: "three expressions: red, green, blue", hsv: "three expressions: hue, saturation, value", mono: "one expression: grey",
};

export class Inspector {
  constructor(box, app) {
    this.box = box;
    this.app = app;
    this.armed = new WeakSet();
  }

  // a text field bound to node.params[key] (or a setter)
  textField(node, key, opts = {}) {
    const value = opts.value !== undefined ? opts.value : node.params[key] ?? "";
    const long = opts.area || String(value).length > 40;
    const t = h(long ? "textarea" : "input", { className: "exp" + (opts.mono === false ? "" : " mono"), value: String(value), spellcheck: false,
      placeholder: opts.placeholder ?? "", autocapitalize: "off", autocomplete: "off" });
    if (!long) t.type = "text"; else t.rows = Math.min(8, Math.max(2, Math.ceil(String(value).length / 38)));
    t.dataset.key = key;
    const commit = () => {
      if (!this.armed.has(t)) { this.app.remember(); this.armed.add(t); }
      const v = t.value.replace(/[\r\n]+/g, " ");
      if (opts.set) opts.set(v); else this.app.setParam(node, key, v);
    };
    t.addEventListener("input", commit);
    t.addEventListener("blur", () => { this.armed.delete(t); this.app.fieldDone(); });
    t.addEventListener("keydown", (e) => { if (e.key === "Enter" && t.tagName === "INPUT") t.blur(); });
    return t;
  }

  row(label, field, key, help) {
    return h("div", { className: "field" },
      h("label", { text: label, title: help || FIELD_HELP[key] || "" }), field,
      h("div", { className: "err", "data-err": key || "" }));
  }

  check(node, key, label) {
    const c = h("input", { type: "checkbox", checked: node.params[key] === true });
    c.addEventListener("change", () => { this.app.remember(); this.app.setParam(node, key, c.checked ? true : undefined); this.app.fieldDone(); });
    return h("label", { className: "check", title: FIELD_HELP[key] || "" }, c, label);
  }

  sourceSelect(node, port) {
    const s = h("select", {});
    s.appendChild(h("option", { value: "", text: "—" }));
    for (const n of this.app.patch.nodes) if (n.id !== node.id && n.type !== "output")
      s.appendChild(h("option", { value: n.id, text: n.id, selected: node.inputs[port] === n.id }));
    s.addEventListener("change", () => this.app.setInput(node, port, s.value || null));
    return s;
  }

  render() {
    const box = this.box, app = this.app, desk = app.desk;
    if (box.contains(document.activeElement) && document.activeElement.matches("input[type=text], textarea")) return;
    box.textContent = "";
    const patch = app.patch;
    if (desk.selWire) {
      const dst = patch.nodes.find((n) => n.id === desk.selWire.node);
      const port = desk.selWire.port;
      if (!dst || !dst.inputs[port]) { desk.selWire = null; return this.render(); }
      box.append(h("h2", { text: "Wire" }),
        h("p", { className: "kind", text: `${dst.inputs[port]} → ${dst.id}${dst.type === "output" ? "" : ", read as $" + port}` }),
        h("div", { className: "actions" }, h("button", { text: "Delete wire", onclick: () => app.deleteSelection() })));
      return;
    }
    const sel = patch.nodes.filter((n) => desk.selection.has(n.id));
    if (sel.length > 1) {
      box.append(h("h2", { text: `${sel.length} nodes` }),
        h("div", { className: "actions" }, h("button", { text: "Delete them", onclick: () => app.deleteSelection() })));
      return;
    }
    if (sel.length === 1) { this.renderNode(sel[0]); this.showErrors(); return; }
    this.renderPatch();
    this.showErrors();
  }

  renderPatch() {
    const app = this.app, patch = app.patch, out = G.outputNode(patch);
    const box = this.box;
    box.append(h("h2", { text: patch.title || "untitled" }),
      h("p", { className: "kind", text: `${patch.nodes.length} nodes` }));
    if (patch.notes) box.append(h("pre", { className: "notes", text: patch.notes }));
    if (out) {
      box.append(h("h3", { text: "Output" }));
      this.outputFields(out);
    }
    box.append(h("div", { className: "hint" },
      h("p", { text: "Click a node to edit it. Drag from a node's right edge onto another to wire it in: the receiving node reads it as $name in its expressions." }),
      h("p", { text: "Add nodes from the bar above the desk; with a node selected, Warp, Mask and the others take it as their input." })));
  }

  outputFields(out) {
    const app = this.app;
    const num = (key, label, int) => {
      const spec = G.NODE_TYPES.output.params.find((p) => p.key === key);
      const t = h("input", { type: "number", value: out.params[key] ?? spec.def, step: int ? 1 : "any", min: int ? 1 : 0 });
      t.dataset.key = key;
      t.addEventListener("change", () => {
        const v = int ? parseInt(t.value, 10) : parseFloat(t.value);
        if (!(v > 0)) { t.value = out.params[key] ?? spec.def; return; }
        app.remember(); app.setParam(out, key, v); app.fieldDone();
      });
      return t;
    };
    this.box.append(h("div", { className: "grid2" },
      this.row("width", num("width", "width", true), "width"), this.row("height", num("height", "height", true), "height"),
      this.row("fps", num("fps", "fps"), "fps"), this.row("seconds", num("duration", "duration"), "duration")));
    const c = h("input", { type: "checkbox", checked: out.params.oversample !== false });
    c.addEventListener("change", () => { app.remember(); app.setParam(out, "oversample", c.checked); app.fieldDone(); });
    this.box.append(h("label", { className: "check", title: "2×2 samples per pixel" }, c, "oversample"));
  }

  nameField(node) {
    const app = this.app;
    const name = h("input", { type: "text", className: "mono", value: node.id, spellcheck: false, autocapitalize: "off" });
    const err = h("div", { className: "err" });
    name.addEventListener("change", () => {
      const v = name.value.trim();
      if (v === node.id) return;
      const m = app.renameNode(node, v);
      if (m) { err.textContent = m; name.value = node.id; } else err.textContent = "";
    });
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") name.blur(); });
    return [name, err];
  }

  renderNode(node) {
    const app = this.app, box = this.box, type = G.NODE_TYPES[node.type];
    const [name, nameErr] = this.nameField(node);
    box.append(h("div", { className: "titleRow" }, name, h("span", { className: "kind", text: type ? type.label : node.type })), nameErr);
    if (G.isFormula(node)) this.formulaFields(node);
    else if (node.type === "sequence") this.sequenceFields(node);
    else if (node.type === "blend") this.blendFields(node);
    else if (node.type === "time") this.timeFields(node);
    else if (node.type === "output") { this.portRow(node, "in", "picture"); this.outputFields(node); }
    if (node.type !== "output") {
      this.lifetimeFields(node);
      box.append(h("div", { className: "actions" },
        h("button", { text: "Duplicate", onclick: () => app.duplicateSelection() }),
        h("button", { text: "Delete", onclick: () => app.deleteSelection() })));
    }
  }

  portRow(node, port, label) {
    this.box.append(h("div", { className: "inrow" }, h("span", { className: "mono", text: label || port }), this.sourceSelect(node, port)));
  }

  formulaFields(node) {
    const app = this.app, box = this.box;
    // the colour expression
    const [ckey, csrc] = G.colorParam(node);
    const mode = h("select", { className: "mode" });
    for (const k of G.COLOR_KEYS) mode.appendChild(h("option", { value: k, text: k, selected: k === ckey }));
    const expr = this.textField(node, ckey, { area: true, value: csrc, set: (v) => app.setColor(node, mode.value, v) });
    expr.classList.add("main");
    mode.addEventListener("change", () => { app.remember(); app.setColor(node, mode.value, expr.value); expr.dataset.key = mode.value; box.querySelector(".colorErr").dataset.err = mode.value; app.fieldDone(); });
    box.append(h("div", { className: "field" },
      h("label", { className: "colorLabel", title: COLOR_HELP[ckey] }, "colour ", mode), expr,
      h("div", { className: "err colorErr", "data-err": ckey })));
    // ports
    const ports = Object.keys(node.inputs);
    const used = new Set(G.COLOR_KEYS.concat(G.FORMULA_PARAMS.map((p) => p.key)).flatMap((k) => G.refsIn(node.params[k])));
    box.append(h("h3", { text: "Inputs", title: "each input is read as $name in the expressions" }));
    for (const port of ports) {
      const pn = h("input", { type: "text", className: "mono portName", value: port, spellcheck: false, autocapitalize: "off", title: "the name the expressions read it by ($name)" });
      pn.addEventListener("change", () => { const m = app.renamePort(node, port, pn.value.trim()); if (m) { pn.value = port; app.status(m, true); } });
      pn.addEventListener("keydown", (e) => { if (e.key === "Enter") pn.blur(); });
      box.append(h("div", { className: "inrow" + (used.has(port) ? "" : " unused"), title: used.has(port) ? "" : "no expression reads $" + port + " yet" },
        h("span", { className: "dollar", text: "$" }), pn, this.sourceSelect(node, port),
        h("button", { text: "×", title: "remove this input", onclick: () => app.removePort(node, port) })));
    }
    const missing = [...used].filter((r) => !ports.includes(r));
    for (const r of missing) box.append(h("div", { className: "warnline", text: `$${r} isn't an input: it reads black.` },
      h("button", { text: "add it", onclick: () => app.addPort(node, r) })));
    box.append(h("div", { className: "actions small" }, h("button", { text: "+ input", onclick: () => app.addPort(node) })));
    // image
    const groups = [
      ["Field", ["left", "top", "width", "height"], ["center"]],
      ["Range", ["min", "max"], ["wrap", "cycle"]],
      ["Image", ["image"], ["tile"]],
      ["Zoom", ["zoom", "zoomfunc", "endwidth"], []],
      ["Fractal", ["recurse", "p0", "q0"], []],
    ];
    for (const [title, keys, bools] of groups) {
      const set = keys.some((k) => node.params[k] !== undefined && node.params[k] !== "") || bools.some((k) => node.params[k] === true);
      const d = h("details", { open: set || (title === "Image" && node.type === "image") });
      d.appendChild(h("summary", { text: title }));
      const grid = h("div", { className: "grid2" });
      for (const k of keys) {
        const spec = G.FORMULA_PARAMS.find((p) => p.key === k);
        let field;
        if (k === "image") {
          field = h("select", {});
          const names = app.imageNames();
          field.appendChild(h("option", { value: "", text: "—" }));
          for (const n of names) field.appendChild(h("option", { value: n, text: n, selected: node.params.image === n }));
          if (node.params.image && !names.includes(node.params.image)) field.appendChild(h("option", { value: node.params.image, text: node.params.image + " (missing)", selected: true }));
          field.addEventListener("change", () => { app.remember(); app.setParam(node, "image", field.value || undefined); app.fieldDone(); });
          d.appendChild(this.row("image", field, "image"));
          continue;
        }
        field = this.textField(node, k, { placeholder: String(spec.def) });
        grid.appendChild(this.row(k, field, k));
      }
      if (grid.childElementCount) d.appendChild(grid);
      for (const b of bools) d.appendChild(this.check(node, b, b));
      box.append(d);
    }
    // oversample override
    const ov = h("select", {});
    for (const [v, t] of [["", "as the Output"], ["true", "on"], ["false", "off"]])
      ov.appendChild(h("option", { value: v, text: t, selected: String(node.params.oversample ?? "") === v }));
    ov.addEventListener("change", () => { app.remember(); app.setParam(node, "oversample", ov.value === "" ? undefined : ov.value === "true"); app.fieldDone(); });
    box.append(h("div", { className: "inrow" }, h("span", { text: "oversample" }), ov));
  }

  modeSelect(value, onchange) {
    const s = h("select", {});
    for (const m of G.BLEND_MODES) s.appendChild(h("option", { value: m, text: m, selected: (value || "normal") === m }));
    s.addEventListener("change", () => onchange(s.value));
    return s;
  }

  sequenceFields(node) {
    const app = this.app, box = this.box;
    box.append(h("p", { className: "hint", text: "Paints its inputs in order, each while it is alive (see its debut and duration), blended onto what is below." }));
    const ports = G.portsOf(node);
    ports.forEach((port, i) => {
      const modes = node.params.modes || {};
      box.append(h("div", { className: "inrow" },
        h("span", { className: "mono num", text: String(i + 1) }), this.sourceSelect(node, port),
        this.modeSelect(modes[port], (m) => app.setSequenceMode(node, port, m)),
        h("button", { text: "↑", title: "paint earlier", disabled: i === 0, onclick: () => app.moveEntry(node, i, -1) }),
        h("button", { text: "↓", title: "paint later", disabled: i === ports.length - 1, onclick: () => app.moveEntry(node, i, 1) }),
        h("button", { text: "×", title: "remove", onclick: () => app.removePort(node, port) })));
    });
    box.append(h("div", { className: "actions small" }, h("button", { text: "+ input", onclick: () => app.addPort(node) })));
  }

  blendFields(node) {
    const app = this.app;
    this.portRow(node, "a", "a (below)");
    this.portRow(node, "b", "b (over)");
    this.box.append(h("div", { className: "inrow" }, h("span", { text: "mode" }),
      this.modeSelect(node.params.mode || "screen", (m) => { app.remember(); app.setParam(node, "mode", m); app.fieldDone(); })));
  }

  timeFields(node) {
    this.portRow(node, "in", "in");
    this.box.append(this.row("time (seconds)", this.textField(node, "time", { placeholder: "t*dur" }), "time",
      "where in its lifetime the input is played, in seconds; t runs 0..1 over this node's lifetime, dur is its length"));
    this.box.append(this.row("loop (seconds)", this.textField(node, "loop", { placeholder: "none" }), "loop", "wrap the time to this length"));
  }

  lifetimeFields(node) {
    const set = node.params.debut !== undefined || node.params.duration !== undefined;
    const d = h("details", { open: set });
    d.appendChild(h("summary", { text: "Lifetime" }));
    const grid = h("div", { className: "grid2" });
    const timeSet = (key) => (v) => {
      v = v.trim();
      const val = v === "" ? undefined : v === "last" ? "last" : isFinite(parseFloat(v)) ? parseFloat(v) : v;
      this.app.setParam(node, key, val);
    };
    grid.append(this.row("debut", this.textField(node, "debut", { placeholder: "0", set: timeSet("debut") }), "debut"),
      this.row("duration", this.textField(node, "duration", { placeholder: "its caller's", set: timeSet("duration") }), "duration"));
    d.appendChild(grid);
    this.box.append(d);
  }

  // writes the compile errors next to their fields
  showErrors() {
    const errs = this.app.errors;
    for (const e of this.box.querySelectorAll("[data-err]")) e.textContent = "";
    const sel = [...this.app.desk.selection];
    if (sel.length !== 1) return;
    const e = errs.get(sel[0]);
    if (!e) return;
    const slot = this.box.querySelector(`[data-err="${e.key}"]`) || this.box.querySelector(".colorErr");
    if (slot) slot.textContent = e.message;
  }
}
