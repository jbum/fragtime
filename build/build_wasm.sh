#!/bin/sh
# Build the QTS renderer for WebAssembly with Emscripten (source ~/emsdk/emsdk_env.sh first).
#   build/build_wasm.sh node   qts.js for Node, reading the host's files (tests)
#   build/build_wasm.sh web    qts.js + qts.wasm for the browser worker, files in memory
# Single-threaded; the page runs several workers instead, each with its own instance.
set -e
cd "$(dirname "$0")/.."
target=${1:-web}
out=build/wasm-$target
mkdir -p "$out/obj"
CFLAGS="-O2 -ffp-contract=off"
for f in src/smath/*.c; do
  emcc $CFLAGS -std=c99 -Isrc/smath -include smath_names.h -Wno-unused-but-set-variable \
       -c -o "$out/obj/$(basename "$f" .c).o" "$f"
done
srcs=$(ls src/*.cpp)
exports='_qts_new,_qts_free,_qts_compile,_qts_messages,_qts_info,_qts_render,_qts_rgb,_malloc,_free'
common="$CFLAGS -std=c++17 -Isrc -w
        -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=4MB
        -sEXPORTED_FUNCTIONS=$exports
        -sEXPORTED_RUNTIME_METHODS=FS,ccall,cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPU8
        -sMODULARIZE=1 -sEXPORT_NAME=createQTS -sINVOKE_RUN=0 -sFORCE_FILESYSTEM=1"
if [ "$target" = node ]; then
  em++ $common $srcs "$out"/obj/*.o -o "$out/qts.js" -sENVIRONMENT=node -sNODERAWFS=1
else
  em++ $common $srcs "$out"/obj/*.o -o "$out/qts.js" -sENVIRONMENT=web,worker
fi
ls -la "$out"/qts.*
