# QTS / Pixel Magic — working notes

Owner: Jim Bumgardner (jbum). Started 2026-10-10. Live at https://qts.jbum.com/.
See README.md for the layout; this file is what isn't obvious from the code.

## Where things came from
- `old_pc_src/QTS` (2001–03) is the source of the port; `old_pc_src/pixmagic` (2000, form + presets)
  and `old_mac_source/Pixel Magic` (1995–97) are its ancestors. jbum chose QTS ("QTS is the one we
  want"). Noise Etude = `examples/noiseetude.can` (360×270, 24 fps, 131 s, 3144 frames).
- The bison/flex grammars were replaced by a hand-written lexer/precedence parser that reproduces
  them (see the header comment of `src/expr_parse.cpp` for the deliberate differences).

## Build / test / publish
- Native: `make` → `./qts`. Wasm: `source ~/emsdk/emsdk_env.sh && build/build_wasm.sh web` (and
  `node` for tests). Site: `python3 build/build_web.py` (needs `./qts`, Pillow, ffmpeg; renders
  thumbnails; takes the movie from `build/out/noise_etude_720.mp4`), then `build/deploy_web.sh`
  (rsync --delete to `$DEPLOY_DEST` or the destination in `build/deploy.dest`;
  server details are in the uncommitted `CLAUDE.local.md`).
- `node tests/compare_wasm.js` after `build/build_wasm.sh node`: wasm and native must be
  byte-identical on every example (they are: 73/73).
- Local testing: `node build/serve.js 8766` serves build/web. Don't use `python3 -m http.server`:
  Chrome's fetches stalled against it and the workers never got their wasm.
- Build outputs (`build/web`, `build/wasm-*`, `build/out`, `qts`, `obj`) are gitignored.

## Things learned
- Chrome ran this wasm ~5× slower than Node (same binary; JS was ~2× slower too) in the automation
  tab on jbum's M1 — likely scheduling/throttling of that tab, not the build. Judge speed in a normal tab.
- `setTimeout(0)` in a worker cost ~130 ms per hop in Chrome; the worker yields through a
  MessageChannel between row bands instead.
- The workers each hold their own compiled script; a preview frame is split into row bands across
  them, a movie hands whole frames out and encodes in order (WebCodecs H.264 + vendored mp4-muxer,
  or PNGs in a stored zip).

## JS engine (web/engine/) — the back pocket
- A second renderer in plain JS: the same parser, expressions compiled to JS functions, same
  sequence/renderer logic. `node tests/compare_js.js` checks it against native: 66/73 examples
  bit-identical, 7 within one level (V8's Math agrees with musl's here). The site does **not** use
  it: in Chrome (2026-10-11, jbum's M1) wasm was faster on most scripts (star 2×, fire 3×,
  smokezoom 5×; JS won only on sun and spiral2), and JS is hopeless on deep-iteration fractals
  (julia2 35 s vs 0.7 s). `web/bench.html?run` reruns the comparison. jbum: "if JS continues to
  be slower, we don't need to waste time on it." Keep it for tests and as the parser for a
  node editor / GLSL emitter.

## Not done / ideas
- **Open: the Noise Etude movie starts grey on jbum's iPad** (Safari and Chrome, both WebKit; first
  ~4 s, mid-grey with the title dark, then right). Not the encode: x264 settings, keyframe spacing,
  no B-frames, weightp=0, HEVC, Apple's own encoder all do it; the same files play white through
  AVPlayer on the Mac over the same HTTPS path (probe: an AVPlayerItemVideoOutput script). jbum
  suspects iPad dark mode; test page https://qts.jbum.com/vtest.html (build/web/vtest.html, not in
  git) has synthetic white/black clips and a clip starting at 6 s to tell. `build/out/noise_etude_720_nw.mp4`
  is a full weightp=0 render, unused.
- **Backlog (jbum, 2026-10-11): a friendlier editor** — a node-based editor with a property panel,
  or a hierarchical list of the sequences, as a tab beside the XML text panel, and the default one.
- Sampling semantics: a bare `$name` uses the sampling layer's raw x,y as 0..1 coords (the
  surviving source; matches the June-2001 lavalamp.mov and 2003 explosion.mov renders). Noise
  Etude (Feb 2001) needed relative sampling and was converted to say it explicitly
  (`$name[(x-left)/w,(y-top)/h]`; the untouched script is orig/QTS/noiseetude_2001.can, and
  `qts --rel` renders it the relative way). The archive's .mov files are the ground truth for
  such questions: `Samples/*.mov` next to the scripts (ffmpeg decodes svq1/qtrle).
- **GLSL (done 2026-10-11)**: `web/engine/glsl.js` compiles a loaded JS-engine `Script` to a fragment
  shader: one `qts_ctx/pix/pin/samp/layer<k>` set per sequence (properties at a time, the pix
  expression typed float-or-vec3 with the VM's "last component" rule, pinning, `$name` sampling,
  2x2 oversampling), `mainImage` composites the leaves alive at `mod(iTime, duration)` in renderer
  order (normal replaces, chop blends in 8-bit steps). Sampled sequences are emitted first
  (topological order; a cycle is an error, GLSL can't recurse). Images are `iChannelN` read with
  texelFetch (row 0 = top, no flip). `web/shader.js` holds the player as *source text* so the
  editor and the standalone download run identical code. Harness: `tests/shader_test.js` runs
  `web/shadertest.html` in headless Chrome with SwiftShader (slow: minutes; `-k` to pick) and
  streams per-script results; threshold "under 1% of bytes more than 8 levels off".
  Known differences: float32 (the deep-zoom mandel/julia examples, widths ~1e-9..1e-11, are
  noise on the GPU: inherent, not a bug — mandel_classic matches), continuous time, a different
  `?` stream (turbcycle mixes 10% of `?` noise, so it "differs" by design). Last run: everything
  else matched (most within 1 level). SwiftShader loses the GL context after a few heavy scripts
  (the harness makes a fresh context per script; `-p` picks the port for parallel runs), renders
  sun.can black and never finishes noiseetude's 272 KB shader — on a real GPU (the test page
  `shadertest.html?run&k=regex` in Chrome) both match within 1 level, Noise Etude in 6 s.
  The Chrome *automation* tab doesn't run requestAnimationFrame reliably — judge animation with
  `tests/shoot.js` (headless screenshots) instead.
- **Shaders first (jbum, 2026-10-11: "I think I want to focus on shaders")**: the Live shader tab is
  the default view (remembered per browser in localStorage; falls back to Frame without WebGL2), and
  movies render from the shader unless the dialog says "the original renderer" (one draw per frame at
  the renderer's frame time f/n·duration, `VideoFrame(canvas)` into WebCodecs, or toBlob for PNGs; the
  frames show on the canvas as they go). `tests/editor_test.js` drives the built site in headless
  Chrome **on the real GPU** (`--use-angle=metal` works headless) and checks a saved frame, PNG and MP4
  movies from both engines against native qts. `tests/shader_test.js -g -s -f 0.95 -d dir` likewise
  (real GPU, timings, a late frame, picture dumps). Unlisted presets: `NOT_SHADER` and `SCAFFOLDING`
  in build_web.py (deep-zoom fractals + julia2; the LEC_ noise studies, clouds, title/credit tests that
  became Noise Etude). Known CPU/GPU differences besides float32: NaNs (bias/gain/2-arg ease outside
  0..1 — star's yellow ring on the CPU is one) and sampling a sequence outside its lifetime (mona2's
  last half second: black on the CPU, the tiled image on the GPU; the CPU result also depends on frame
  order). Not emulated: GPU NaN behaviour isn't portable.
- The Frame view / wasm path stays for exactness and for devices whose GPU can't take the shaders.
  jbum's iPad struggled with the shader tab while Frame was the default; with the shader as the
  default (no wasm workers rendering at the same time) "shaders work great on iPad now"
  (2026-10-11). Likely the CPU render competing, not the GPU — not proven.
- About page (2026-10-11, "Let's shader version in about"): `web/etude.js` fetches noiseetude.can, compiles
  it in the browser and plays it on a canvas after a click (poster + play button first; the MP4 stays as
  the fallback and behind "watch the movie instead"). Home page trimmed the same day (jbum: "Are there
  buttons that could be removed?"): no Examples dropdown (the gallery button is "Examples"), pause is an
  icon by the slider plus a click on the picture, no "render as the slider moves" checkbox, and a "?"
  tips dialog holds the explanations. `scratchpad/shader/about_test.js`-style checks: headless Chrome on
  Metal, click play, read `window.etude`.
- Ideas: a Shadertoy-style "share" link; GPU movie rendering at sizes above the canvas limit.
- The site has no social card yet beyond `assets/card.png` made by build_web.py (the sun example +
  title); jbum may want a nicer one.
- GitHub: https://github.com/jbum/pixelmagic (public, created 2026-10-11).
