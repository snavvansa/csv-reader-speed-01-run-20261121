// The work main.ts runs: reads every case from /input/cases.json (a JSON array of {id, input}) and writes
// /output/answers.json, csv-reader 1.0.0's answer to each, in the cases' order. Outside a container MAKEFUN_INPUT_DIR
// and MAKEFUN_OUTPUT_DIR stand in for /input and /output. (CommonJS, required by a one-line main.ts: the quickest
// start node has for a .ts entry.)
//
// The fast path: cases.json is read a window at a time into the memory of csv.wasm (csv.c, built by build.sh), and
// each case's answer is written there by begin() / step() / finish() from the JSON-escaped bytes of its text, over the
// input already read; each time the window slides on, the answers written so far go to the file. So a few megabytes of
// memory serve the whole file and no string is ever made of it. This file walks the frame of cases.json as
// JSON.stringify writes it, [{"id":"…","input":{"text":"…","header":true|false}},…]. A case's header flag comes after
// its text, so it is taken to be the generator's (header on every case but the 3rd, 6th, …) and checked when the text
// has been read; a file where it is not, or that is laid out otherwise, or whose answers outrun the input, is read
// again whole (text_end() finding each text's end first), and anything that still does not fit (a \u escape, another
// layout) the ordinary way: JSON.parse, run() from solve.mjs on each case, JSON.stringify.

'use strict';
const { closeSync, fstatSync, openSync, readFileSync, readSync, writeFileSync, writeSync } = require('node:fs');
const { join } = require('node:path');
const { setFlagsFromString } = require('node:v8');

// The module is compiled whole by the optimising tier before it runs (no baseline code that runs a slow first pass
// and tiers up halfway through the file). (--single-threaded is not set here: given once V8 is running, it can leave
// the garbage collector in a state it aborts on.)
setFlagsFromString('--no-wasm-lazy-compilation');
setFlagsFromString('--no-wasm-dynamic-tiering');

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const INPUT = join(INPUT_DIR, 'cases.json');
const OUTPUT = join(OUTPUT_DIR, 'answers.json');

const WINDOW = 4 << 20; // input bytes a window holds (it grows when one record will not fit)
const LEAD = 1 << 20; // how far past the answers' start the window's input starts
const ERRORS = 4 << 20; // the error region a case's errors wait in

const BACKSLASH_N = Buffer.from('\\n', 'latin1');

function fast() {
  const x = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(__dirname, 'csv.wasm')))).exports;
  return attempt(x, false) || attempt(x, true);
}

/** One pass over the file: windowed (header flags assumed, checked), or whole (header flags read first). */
function attempt(x, whole) {
  const fd = openSync(INPUT, 'r');
  let out = -1;
  try {
    const len = fstatSync(fd).size;
    const errStart = (Number(x.__heap_base.value) + 15) & ~15;
    const errLim = errStart + (whole ? (len >> 2) + (1 << 20) : ERRORS);
    const outStart = errLim + 64;
    const base = outStart + (whole ? 8 * len + (1 << 20) : LEAD);
    let cap = whole ? len : Math.min(len, WINDOW);
    let M;
    const room = () => {
      const need = base + cap + 128;
      if (need > 2 ** 31) return false;
      const have = x.memory.buffer.byteLength;
      if (need > have) x.memory.grow(Math.ceil((need - have) / 65536));
      M = Buffer.from(x.memory.buffer);
      return true;
    };
    if (!room()) return false;

    out = openSync(OUTPUT, 'w');
    let o = outStart; // the next answer byte
    let dEnd = base; // just past the data in the window
    let filePos = 0; // the file offset of dEnd
    let eof = false;
    const flush = () => {
      for (let w = outStart; w < o; ) w += writeSync(out, M, w, o - w);
      o = outStart;
    };
    // Slides the window to start at `from` (what is before it is read), reads on, and returns how far it moved.
    // A window that is not the file's last ends just after a \n escape (an even run of backslashes before it).
    const fill = (from) => {
      flush();
      const keep = dEnd - from;
      M.copyWithin(base, from, dEnd);
      dEnd = base + keep;
      let got = 0;
      while (dEnd + got < base + cap && filePos + got < len) {
        const n = readSync(fd, M, dEnd + got, base + cap - dEnd - got, filePos + got);
        if (n <= 0) break;
        got += n;
      }
      if (filePos + got >= len) {
        if (filePos + got !== len) throw new Error('the file changed');
        eof = true;
        filePos = len;
        dEnd += got;
      } else {
        let cut = -1;
        for (let k = dEnd + got; k > dEnd; ) {
          const at = M.lastIndexOf(BACKSLASH_N, k - 2);
          if (at < dEnd) break;
          let b = at;
          while (b > base && M[b - 1] === 0x5c) b -= 1;
          if ((at - b) % 2 === 0) {
            cut = at + 2;
            break;
          }
          k = at;
        }
        if (cut < 0) cut = dEnd; // no line break read: the caller grows the window
        filePos += cut - dEnd;
        dEnd = cut;
      }
      M.fill(0x22, dEnd, dEnd + 64); // quotes past the data: every scan stops
      return from - base;
    };
    // Makes at least n bytes from k readable (or all that is left); returns how far the window moved.
    const ahead = (k, n) => (!eof && k + n > dEnd ? fill(k) : 0);
    const lit = (k, s) => {
      if (k + s.length > dEnd) return false;
      for (let q = 0; q < s.length; q++) if (M[k + q] !== s.charCodeAt(q)) return false;
      return true;
    };

    fill(base);
    let j = base;
    if (!lit(j, '[')) return false;
    M[o++] = 0x5b;
    j += 1;
    if (lit(j, ']')) {
      if (!(eof && j === dEnd - 1)) return false;
    } else {
      for (let index = 0; ; index++) {
        j -= ahead(j, 64 << 10);
        if (!lit(j, '{"id":"')) return false;
        j += 7;
        while (j < dEnd && M[j] !== 0x22) {
          if (M[j] === 0x5c && M[j + 1] === 0x75) return false; // a \u escape
          j += M[j] === 0x5c ? 2 : 1;
        }
        if (!lit(j, '","input":{"text":"')) return false;
        let i = j + 19;
        let header;
        if (whole) {
          const te = x.text_end(i);
          if (lit(te, '","header":true}}')) header = 1;
          else if (lit(te, '","header":false}}')) header = 0;
          else return false;
        } else {
          header = index % 3 === 2 ? 0 : 1;
        }
        if (index > 0) M[o++] = 0x2c;
        o = x.begin(header, o, errStart, errLim);
        for (;;) {
          const status = x.step(i, dEnd, o);
          if (status === 0) return false;
          o = x.res_o();
          i = x.res_i();
          if (status === 1) break;
          if (eof) return false;
          // The record at i needs more data: slide the window to it, growing it when the record alone fills it.
          const before = dEnd - i;
          i -= fill(i);
          o = outStart;
          if (dEnd - i <= before) {
            if (cap >= len) return false;
            cap = Math.min(len, cap * 2);
            if (!room()) return false;
            filePos -= dEnd - i; // read the kept bytes again into the bigger window
            dEnd = i;
            i -= fill(i);
          }
        }
        o = x.finish(o);
        if (o === 0) return false;
        const left = x.errors_left();
        if (left > 0) {
          // Errors too many to put behind the input: written from their own region, after the answer so far.
          flush();
          for (let w = errStart; w < errStart + left; ) w += writeSync(out, M, w, errStart + left - w);
          M[o++] = 0x5d;
          M[o++] = 0x7d;
        }
        j = i;
        j -= ahead(j, 64);
        if (lit(j, '","header":true}}')) {
          if (header !== 1) return false;
          j += 17;
        } else if (lit(j, '","header":false}}')) {
          if (header !== 0) return false;
          j += 18;
        } else {
          return false;
        }
        j -= ahead(j, 64);
        if (lit(j, ',')) {
          j += 1;
          continue;
        }
        if (lit(j, ']') && eof && j === dEnd - 1) break;
        return false;
      }
    }
    M[o++] = 0x5d;
    flush();
    return true;
  } finally {
    closeSync(fd);
    if (out >= 0) closeSync(out);
  }
}

let done = false;
try {
  done = fast();
} catch {
  done = false; // whatever went wrong, the ordinary way answers
}
if (!done) {
  // The ordinary way (writeFileSync truncates anything the fast path wrote).
  import(require('node:url').pathToFileURL(join(__dirname, 'solve.mjs')).href).then(({ run }) => {
    const cases = JSON.parse(readFileSync(INPUT, 'utf8'));
    const answers = [];
    for (const c of cases) answers.push(run(c.input));
    writeFileSync(OUTPUT, JSON.stringify(answers));
  });
}
