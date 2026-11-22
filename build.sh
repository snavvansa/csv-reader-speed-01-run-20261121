#!/bin/sh
# Builds csv.wasm from csv.c: clang 19 for wasm32 with SIMD and bulk memory, no libc, then binaryen's wasm-opt.
# Run where clang, wasm-ld and wasm-opt are installed (Debian trixie: apt-get install clang lld binaryen).
# -Oz: the module is compiled by V8's optimising tier as the program starts, on the one CPU the run is timed on,
# and the smaller code compiles faster while running as fast as -O3's (timed under gVisor).
set -e
cd "$(dirname "$0")"
clang --target=wasm32 -Oz -msimd128 -mbulk-memory -nostdlib -fno-builtin-memcpy \
  -Wl,--no-entry -Wl,--export=__heap_base -Wl,--export-memory -Wl,--max-memory=2147483648 -Wl,--strip-all \
  -o csv.wasm csv.c
wasm-opt -Oz --enable-simd --enable-bulk-memory csv.wasm -o csv.wasm
ls -l csv.wasm
