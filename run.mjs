// The work main.ts runs: reads every case from /input/cases.json (a JSON array of {id, input}) and writes
// /output/answers.json, csv-reader 1.0.0's answer to each, in the cases' order. Outside a container MAKEFUN_INPUT_DIR
// and MAKEFUN_OUTPUT_DIR stand in for /input and /output. (Plain JavaScript: main.ts stays a few lines, so the type
// stripper has next to nothing to read.)
//
// The fast path: cases.json is read straight into the memory of csv.wasm (csv.c, built by build.sh), each case's
// answer is written there by answer() from the JSON-escaped bytes of its text, over the input it has read, and the
// whole answers file is written from that memory in one call: no string is ever made of the 11 MB. This file only
// walks the frame of cases.json as JSON.stringify writes it, [{"id":"…","input":{"text":"…","header":true|false}},…];
// text_end() finds where each text ends. Anything else (another layout, a \u escape, answers that outrun the input)
// is read the ordinary way: JSON.parse, run() from solve.js on each case, JSON.stringify.

import { closeSync, fstatSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// The module is compiled whole by the optimising tier before it runs (no baseline code that runs a slow first pass
// and tiers up halfway through the file).
setFlagsFromString('--no-wasm-lazy-compilation');
setFlagsFromString('--no-wasm-dynamic-tiering');

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const INPUT = join(INPUT_DIR, 'cases.json');
const OUTPUT = join(OUTPUT_DIR, 'answers.json');

function fast() {
  const x = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL('./csv.wasm', import.meta.url)))).exports;
  // First with the input just ahead of the answers (they run about a tenth longer than the texts); a file whose
  // answers outrun that (many errors, tiny fields) is read again with the input past any answers it can make.
  return attempt(x, (n) => (n >> 3) + (512 << 10)) || attempt(x, (n) => 8 * n + (1 << 20));
}

function attempt(x, leadOf) {
  const fd = openSync(INPUT, 'r');
  let len;
  try {
    len = fstatSync(fd).size;
    // The layout: the answers are written from outStart over the input, which starts `lead` bytes later (csv.c keeps
    // the output behind the input, or gives up), then 64 bytes of slack, then the errors of the case being read.
    var outStart = (Number(x.__heap_base.value) + 15) & ~15;
    var base = outStart + leadOf(len);
    var errStart = (base + len + 64 + 15) & ~15;
    var errLim = errStart + (len >> 2) + (1 << 20);
    if (errLim + 64 > 2 ** 31) return false;
    const have = x.memory.buffer.byteLength;
    if (errLim + 64 > have) x.memory.grow(Math.ceil((errLim + 64 - have) / 65536));
    var M = new Uint8Array(x.memory.buffer);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, M, base + got, len - got, got);
      if (n <= 0) break;
      got += n;
    }
    if (got !== len) return false;
  } finally {
    closeSync(fd);
  }
  M.fill(0x22, base + len, base + len + 64); // the slack reads as quotes: no scan runs past the input

  const lit = (k, s) => {
    if (k + s.length > len) return false;
    for (let q = 0; q < s.length; q++) if (M[base + k + q] !== s.charCodeAt(q)) return false;
    return true;
  };
  let o = outStart;
  if (!lit(0, '[')) return false;
  M[o++] = 0x5b;
  if (lit(1, ']')) {
    if (len !== 2) return false;
  } else {
    let j = 1;
    for (let first = true; ; first = false) {
      if (!lit(j, '{"id":"')) return false;
      j += 7;
      while (j < len && M[base + j] !== 0x22) {
        if (M[base + j] === 0x5c && M[base + j + 1] === 0x75) return false; // a \u escape
        j += M[base + j] === 0x5c ? 2 : 1;
      }
      if (!lit(j, '","input":{"text":"')) return false;
      const ts = j + 19;
      const te = x.text_end(base + ts) - base;
      if (te >= len || !lit(te, '","header":')) return false;
      j = te + 11;
      let header;
      if (lit(j, 'true}}')) {
        header = 1;
        j += 6;
      } else if (lit(j, 'false}}')) {
        header = 0;
        j += 7;
      } else {
        return false;
      }
      if (!first) M[o++] = 0x2c;
      const end = x.answer(base + ts, base + te, header, o, errStart, errLim);
      if (end === 0) return false;
      o = end;
      if (lit(j, ',')) {
        j += 1;
        continue;
      }
      if (lit(j, ']') && j === len - 1) break;
      return false;
    }
  }
  M[o++] = 0x5d;
  const out = openSync(OUTPUT, 'w');
  try {
    for (let w = outStart; w < o; ) w += writeSync(out, M, w, o - w);
  } finally {
    closeSync(out);
  }
  return true;
}

let done = false;
try {
  done = fast();
} catch {
  done = false; // whatever went wrong, the ordinary way answers
}
if (!done) {
  // The ordinary way (writeFileSync truncates anything the fast path wrote).
  const { run } = await import(new URL('./solve.js', import.meta.url).href);
  const cases = JSON.parse(readFileSync(INPUT, 'utf8'));
  const answers = [];
  for (const c of cases) answers.push(run(c.input));
  writeFileSync(OUTPUT, JSON.stringify(answers));
}
