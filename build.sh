#!/bin/sh
# Builds csv.wasm from csv.c: clang 19 for wasm32 with SIMD and bulk memory, no libc, then binaryen's wasm-opt.
# Run where clang, wasm-ld and wasm-opt are installed (Debian trixie: apt-get install clang lld binaryen).
set -e
cd "$(dirname "$0")"
clang --target=wasm32 -O3 -msimd128 -mbulk-memory -nostdlib -fno-builtin-memcpy \
  -Wl,--no-entry -Wl,--export=__heap_base -Wl,--export-memory -Wl,--max-memory=2147483648 -Wl,--strip-all \
  -o csv.wasm csv.c
wasm-opt -O3 --enable-simd --enable-bulk-memory csv.wasm -o csv.wasm
ls -l csv.wasm
