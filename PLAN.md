# Fragtime: the node editor — plan

Written 2026-10-12 for whoever builds it (read CLAUDE.md first; the QTS notes there still describe the
code this starts from). jbum has agreed to the recommendations below; the open questions at the end
have defaults, so no decision blocks the work.

## What Fragtime is

Pixel Magic's idea, pictures and movies from a formula per pixel plus time, with a **graph of
coarse nodes** instead of the `<seq>` tree, compiled to **one fragment shader** and edited in the
browser. The maths stays text: a node's parameters are expressions in the existing Pixel Magic
language (`web/engine/expr.js`). The graph is the data model; a node editor is the main view. A tree
cannot grow into a graph, a graph can always be shown as an outline later.

Not changing: the expression language and its functions (`noise`, `fnoise`, `turb`, `terp`, `ease`,
`bias`, `mand`, `julia`, `sample`…), the GLSL library in `web/engine/glsl.js`, the WebGL2 player
(`web/shader.js`), the GPU movie path (WebCodecs + mp4-muxer, PNG zip), the standalone HTML/GLSL
exports, the hosting (`build/deploy_web.sh`), the native `qts` and `src/` (they become the reference
for import fidelity). The repo `pixelmagic` and qts.jbum.com are frozen; never edit them from here.

## The model

A **patch** is a JSON document: one Output node and a DAG of nodes wired into it.

```json
{ "fragtime": 1, "title": "Fire",
  "nodes": [
    { "id": "b1", "type": "source", "x": 40, "y": 60,
      "params": { "mono": "turb(x,y+t*2,t,.4,2,7)", "left": "4", "top": "4", "width": "2", "min": "0", "max": "3" } },
    { "id": "b2", "type": "source", "x": 40, "y": 200, "params": { "mono": "turb(x,y+t*2-2,t-1,.4,2,7)", "left": "4", "top": "4", "width": "2", "min": "0", "max": "3" } },
    { "id": "b",  "type": "expr",   "x": 300, "y": 130, "inputs": { "b1": "b1", "b2": "b2" }, "params": { "mono": "terp($b1,$b2)" } },
    { "id": "flame", "type": "expr", "x": 560, "y": 130, "inputs": { "b": "b" },
      "params": { "hsv": "ease(y+$b-.4,.1)*2-1,1-(y+$b-.3)^3,ease(y+$b-.3,.9)", "height": "1" } },
    { "id": "out", "type": "output", "x": 820, "y": 130, "inputs": { "in": "flame" },
      "params": { "width": 320, "height": 240, "fps": 24, "duration": 4, "oversample": true } }
  ] }
```

Rules:
- **Wires are named variables.** A node's `inputs` map a port name to the id of the node feeding it.
  Inside that node's expressions the port is `$name`, with the full QTS reference syntax as
  `expr.js` parses `$seq` today: `$a` (the input at this pixel), `$a[t2]` (at another time),
  `$a[x2,y2]` (at other coordinates, 0..1 over the input's field), `$a[x2,y2,t2]`, and
  `$a{d,angle}` (polar about the centre). The parser's `seqNames` map (name → integer id)
  becomes the node's port map; nothing in the expression language changes.
- **Every node is a function of (x, y, t)** returning a vec3 in 0..1, as a QTS sequence's sampler
  is: pinned by `min`/`max` (clamp, or `wrap`), `mono` splats, `hsv` converts. Numbers from a
  triple take `.z` (the VM's rule, keep it for import fidelity). A node pulled from three places is
  computed three times; that is QTS's cost model too and GLSL inlines it. No per-node textures in
  phase 1 (see Feedback, later).
- **Coordinates and time flow downward** from Output: a Warp pulls its input at other x,y; a
  Time node pulls at another t. `x`, `y`, `t`, `d`, `a`, `cx`, `cy`, `w`, `h`, `n`, `gt`, `fw`,
  `fh`, `iw`, `ih`… keep their QTS meanings inside a node (see `VARMAP` in glsl.js and the
  language page).
- **Lifetime is optional on any node**: `debut`, `duration` (seconds, relative to the context that
  pulls it; `debut: "last"` inside a Sequence). Outside its window a node returns black, as QTS.
  A node without a lifetime inherits its caller's; `t` is 0..1 over the lifetime in force.
- **Field** (`left`, `top`, `width`, `height`, `center`, `endwidth`/`zoom`, `tile`) is also optional
  on any node and means what it does on a `<seq>`; it is how zooms and "the other sequence at the
  same relative position" work, so import keeps it.
- **One Output.** Size, fps, duration, oversample. Its single input is the picture; the old
  "layers painted in order with blend modes" is a Sequence or Blend node, not Output's job.
- Ids are user-visible names (`[A-Za-z_][A-Za-z0-9_]*`, unique); positions are desk coordinates
  and nothing else in the file depends on them.

### Node types (phase 1)

| type | inputs | params | meaning |
|---|---|---|---|
| `source` | none | `pix`/`rgb`/`hsv`/`mono`, pin, field, lifetime, `p0 q0 recurse` | a leaf `<seq>`: a formula |
| `image` | none | `image`, `tile`, `pix` (default `sample()`), field | an image source; at most 4 per patch (iChannel) |
| `expr` | any, user-named | one of `pix`/`rgb`/`hsv`/`mono` over `$ports`, pin, field, lifetime | the general combiner; Warp, Mask, Displace are this with templates |
| `blend` | `a`, `b` | `mode` (the CHOP list; dodge…luminosity stay unimplemented), `opacity` | b over a |
| `sequence` | `s1..sn`, ordered | per input: `debut` (`last` default), `duration` | time slices and layer order: paints the inputs alive at t in order, each with its own `blend` mode and opacity |
| `time` | `in` | `t` expression (new local t from the caller's), `speed`, `offset`, `loop` | time remap |
| `output` | `in` | `width height fps duration oversample` | the frame |

Warp (`$in[x+fx, y+fy]`), Mask (`terp($a,$b,$m)`), Displace (`$in[x+($d-.5)*k, …]`) are **palette
entries that create a pre-filled `expr` node**, not types; the inspector shows the template's fields
first. Add types only when a template cannot say it.

### Why this reproduces the old scripts

The `.can` importer (`web/engine/import_can.js`, also run by node) maps:
- a leaf `<seq>` → `source` (or `image` when it has `image=`), params copied verbatim;
- a `<seq>` with children → `sequence`, children in order with their `debut`/`duration`/`chop`;
  the root becomes `output` + a `sequence`;
- `$name` references → wires: the referenced seq's node becomes an input of the referencing node
  (port named `name`), so the leaf turns into an `expr` node with inputs. References across slices
  (mona2's dead sequence) stay wires; the compiler keeps today's semantics (sample outside the
  lifetime = black).
- `id` → node id; a leaf never referenced gets a generated id (`s12`), unlisted in the inspector.
- layout: rank by longest path to Output, columns 260 px apart, rows 150 px; good enough, the
  user can drag.

Importing every `examples/*.can` and compiling the graph must render **the same pixels as
`glsl.js` compiling the `.can`** (both are GPU, so compare at 0 tolerance, or ≤1 level where the
expression order changed). That is the regression gate for the whole compiler, and it is cheap:
`tests/shader_test.js` already renders in headless Chrome on the GPU.

## Code layout

```
web/engine/graph.js        model: load/validate/serialize a patch, ports, topological order,
                           cycle detection, lifetime/field defaults; works in node (tests)
web/engine/graph_glsl.js   patch → GLSL (Shadertoy dialect, same header/uniforms as today);
                           reuses Gen, LIB, VARMAP, f() from glsl.js: export them, don't copy
web/engine/import_can.js   .can text (via seq.js Script) → patch JSON + layout
web/desk.js                the node desk: SVG, pan/zoom, touch, selection, drag, wires, undo;
                           ported from csyd_200/web/index.html (track(), toPatch(), zoomAt(),
                           autoFit, gesture events, remember()/undo()) — read that file first
web/app.js                 rewritten around the patch: inspector, output player, gallery,
                           movie dialog, exports, storage (keep renderMovie, download,
                           ShaderPlayer, standaloneHTML, the tips dialog as they are)
web/index.html, style.css  desk left, inspector right, output + time slider + play above the
                           inspector, log below; phone: output on top, desk below, inspector a
                           sheet
web/language.html          gains a "Nodes" section; the expression reference stays
examples/*.fragtime        the listed presets, imported at build time (build_web.py runs
                           node build/import_examples.js); the .can files stay for the tests
tests/import_test.js       every .can → patch → GLSL vs glsl.js, pixel compare (headless GPU)
tests/graph_test.js        model round-trip, validation errors, cycles, port renames
tests/editor_test.js       updated: open a preset, add a node, wire it, see the picture change,
                           save frame, movie, reload from localStorage
```

Drop from the new editor: the Frame tab, `worker.js`/`qts.wasm` and the CPU movie engine. The
graph has no CPU renderer and should not get one; `qts` native + the `.can` importer are the exact
reference where one is needed. Keep `build/build_wasm.sh` and `tests/compare_wasm.js` in the repo
for the inherited tests, just not on the site.

## The editor

- **Desk**: nodes are rounded boxes with a title (id), a thumbnail, input ports on the left, one
  output port on the right; wires are cubic curves. Click selects, drag moves, drag from a port
  wires, drop a wire on a node's body to add a new named port on an `expr` node. Double-click a
  title to rename (renames the `$port` in dependants). Delete removes with its wires. Palette
  (toolbar or right-click/long-press): Source, Image, Expression, Warp, Mask, Displace, Blend,
  Sequence, Time. Same touch rules as Syd: one finger pans empty desk, two pinch, press-and-hold
  selects a box, a second finger aborts a drag.
- **Thumbnails**: one extra "preview" shader with `uniform int ft_preview;` and a `switch` over
  node functions, compiled once per patch change, drawn at 96×72 per visible node from one
  offscreen player, at the slider's time (paused) or every ~10 frames while playing. Never one
  compile per node.
- **Inspector**: the selected node's params as labelled fields; expression fields are single-line
  textareas with the compile error inline (line/column from `ExprError`); numbers for width/fps;
  a `mode` select for Blend; the Sequence node's inputs as a reorderable list with debut/duration.
  Edits apply on input with the 300 ms debounce the editor uses today, snapshot for undo on blur.
- **Output**: the player canvas, time slider, play/pause icon, size w×h with ↺, oversample
  toggle, fps readout; Save frame (PNG), Render movie… (GPU only), Save shader (HTML), Save GLSL.
- **Files**: New, Open… (`.fragtime`, and `.can` which imports), Save (`.fragtime` download),
  Examples (the gallery, thumbnails as now), Images… (as now). localStorage key `fragtime-editor`
  holds the patch JSON, name, time, view. A `?x=name` URL opens a preset.
- **Source tab**: the patch JSON in a textarea, editable, validated on blur. (Useful, cheap, and
  the outline view for later can grow from it.)
- **Log** as today: compiled line (`4 s at 24 fps = 96 frames, 320×240`), shader size, warnings,
  errors with the node id.

## Phases, each a commit with its test green

0. **Prep** (small, mechanical): export `Gen`, `LIB`, `VARMAP`, `f`, `gradientText` from glsl.js;
   let `Parser` take a port map in place of `seqNames` (same shape: name → integer id). Existing
   tests still pass (`tests/glsl_compile.js`, `tests/shader_test.js -g`).
1. **Model + importer + compiler**, no UI: `graph.js`, `import_can.js`, `graph_glsl.js`,
   `tests/import_test.js` green on every listed example (and the unlisted ones compile).
   `tests/shader_page.js` learns to take a `.fragtime` so a patch can be eyeballed as a standalone
   page before the editor exists.
2. **Desk + inspector + output**: `desk.js`, the new `app.js`/`index.html`; open presets, edit
   expressions, add/wire/delete nodes, thumbnails, undo, storage, gallery. `editor_test.js` updated.
   Publish to fragtime.jbum.com at the end of this phase; jbum tries it on the iPad.
3. **Outputs**: Save frame, movie dialog (GPU path only), HTML/GLSL exports, `?x=` links, About
   page keeps playing Noise Etude (now from its imported patch). Language page "Nodes" section.
4. **Polish**: keyboard (⌘Z/⇧⌘Z, Delete, ⌘Enter, Tab in fields), phone layout, port rename
   propagation, palette templates, import of a `.can` by drag-and-drop, a short tips update.
5. **Feedback (stretch)**: a `feedback` node that samples the previous frame. Needs a second
   pass: render the graph up to the feedback node into a ping-pong texture at the output size,
   then the rest. Design it only after 2 ships; the player grows `passes` then.

## Verification habits

Headless Chrome on the Metal GPU is the tool (`tests/editor_test.js -x fire.can`, an example
*name*): `--headless=new --use-angle=metal`, CDP over `DevToolsActivePort`, console `FILE`/`PNG`/
`RESULT` lines to get files out, `window.qtsDownloadHook` to catch downloads. Compare against
native `qts -f a-b` for imported presets and against the old glsl path for everything. Screenshot
the desk at 1400×900 and 390×844 before publishing (`scratchpad/shader/shot.js` in the pixelmagic
repo shows how; copy it, `scratchpad/` is gitignored). jbum tests the iPad himself.

## Decisions already made

- Graph, not tree; coarse nodes with text expressions; JSON file format; the `.can` scripts are
  imported, not edited.
- GPU only in the new editor. The wasm renderer leaves the site.
- Ports are `$names`; the expression language is untouched.
- Lifetime and field are per-node options, Sequence orders and slices time, Output is just the frame.
- Reuse the Syd desk code rather than a library (no dependencies, touch already solved,
  jbum knows it).
- Name and site: Fragtime, fragtime.jbum.com; commit per milestone, messages say why.

## Open questions, with the default to take

- File extension: `.fragtime` (default) vs `.ftg`. Take `.fragtime`.
- Should `expr` nodes allow several colour params at once (`pix` and `mono`)? No: exactly one.
- Thumbnail time: the slider's time (default) vs each node's own t=0.5. Slider.
- Where does oversample live: Output only (default), or per node as QTS had it? Output only; the
  importer drops per-seq `oversample` and sets Output's from the root.
- Blend inside Sequence (per input) vs separate Blend nodes: both exist; the importer uses the
  Sequence's per-input mode, the palette offers Blend for two-input cases.
- Max images: 4 (WebGL2 iChannel convention we already use). Raise later with a texture atlas if a
  patch needs more.
