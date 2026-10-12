# Fragtime

The successor of **QTS / Pixel Magic** (https://qts.jbum.com/, repo jbum/pixelmagic, kept as it was):
Fragtime starts from an exact copy of that code and moves on to a shader-first editor. Live at
**https://fragtime.jbum.com/**. The rest of this file still describes the code as ported.

## QTS / Pixel Magic

The renderer of **QTS** ("QuickTime Synthesizer", 2001–2003), the last form of Jim Bumgardner's
*Pixel Magic* (1995–), ported from its Windows/MFC C++ sources to a portable library, a native
command-line tool and WebAssembly. A script gives a formula for every pixel, plus time; QTS turns it
into stills and movies. (Its original home: https://qts.jbum.com/.)

- `src/` — the library: `expr_*` (the Pixel Magic expression language: compiler and stack VM, noise,
  fractals), `seq.*` (the `<seq>` script parser and sequence/time logic), `renderer.*` (layers,
  oversampling, blend modes), `image.*` (source images via stb_image), `wasm_api.cpp` (the C API the
  web worker calls), `smath/` (musl's libm, compiled in, so every platform renders the same bits).
- `cli/main.cpp` — `qts`: `make`, then `./qts script.can` (PNG frames), `-t SECS`/`-T FRAC` for one
  frame, `-raw | ffmpeg` for a movie, `-j N` threads, `-i` to print the script's parameters.
- `web/` — the site: editor (`index.html`/`app.js`), the live shader view (`shader.js`: a WebGL2 player,
  also embedded in the downloadable standalone page; the editor's default view, and what renders movies
  unless the original renderer is asked for), the wasm render worker (`worker.js`), reference and About
  pages. `build/build_wasm.sh web` builds `qts.wasm`; `build/build_web.py` assembles `build/web/`
  (examples, thumbnails, the Noise Etude movie from `build/out/`); `build/deploy_web.sh` publishes it.
- `examples/` — the sample scripts (`.can`) and images from the QTS archive. `orig/QTS/` — the
  original sources the port was made from, for reference.
- `tests/compare_wasm.js` — renders every example natively and with `build/wasm-node/qts.js` and
  requires identical bytes. `tests/compare_js.js` does the same for `web/engine/`, a second,
  pure-JavaScript renderer (kept for tests and tooling; the site renders with the wasm, which
  benchmarked faster — `web/bench.html`).
- `web/engine/glsl.js` — compiles a script to a GLSL ES 3.00 fragment shader (Shadertoy dialect) that
  plays the movie in real time and loops with its duration. `tests/glsl_compile.js` compiles every
  example; `tests/shader_test.js` renders each one in headless Chrome and compares with the JS engine;
  `tests/shader_page.js` writes the standalone page for a script; `tests/editor_test.js` drives the built
  editor in headless Chrome on the GPU and checks the frames and movies it saves against the native `qts`.
  `build/build_web.py` lists only the shader-friendly examples (the deep Mandelbrot zooms need doubles)
  and leaves out the studies that were scaffolding for Noise Etude; the files are still served.

## Rendering Noise Etude

    make
    ./qts -raw -j 8 -q -w 720 -h 540 examples/noiseetude.can | \
      ffmpeg -f rawvideo -pix_fmt rgb24 -s 720x540 -r 24 -i - -c:v libx264 -crf 18 -pix_fmt yuv420p \
             -movflags +faststart build/out/noise_etude_720.mp4

(360×270 is the script's own size; 3144 frames take about three minutes on eight cores.)

## Fidelity

The port keeps the originals' behaviour where it shows in a picture, including some bugs of the day
(values below `min` in clamp mode become `min`, not 0; a sampled sequence is cached by position only;
HSV layers are oversampled in HSV space). Changes made on purpose: constant folding respects `?:`
branches, function arity is checked, `lighten` lightens (it fell through to multiply), each fractal
function has its own cache, and the `?` random variable is seeded per row so threads and row bands
render identically. `dodge`, `burn`, `hue`, `saturation`, `color` and `luminosity` blend modes were
never implemented and still aren't (the layer is skipped).
