# csv-reader-speed-01-run-20261121

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/snavvansa/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/snavvansa/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's csv-reader 1.0.0: `main.ts` turns `/input/cases.json` into `/output/answers.json`,
csv-reader's `{columns, rows, errors}` for every case, broken rows and all, byte for byte what csv-reader behind
`JSON.stringify` writes.

## How

`cases.json` is JSON: each case's CSV text is a JSON string, every quote in it written `\"`, every line break `\n` or
`\r`, every other byte (UTF-8 too) as itself. So csv-reader's whole reading can be done on the escaped bytes, and an
answer's field is, byte for byte, the escaped bytes it came from, but for csv-reader's few rewrites (a doubled quote
made one, a CR inside quotes made LF, a stray CR dropped), done on the escapes themselves.

- `csv.c` (built to `csv.wasm` by `build.sh`: clang for wasm32 with SIMD) reads a case's escaped text 16 bytes at a
  time: each block is stored to the output whole and the output moves past the bytes up to the first comma,
  backslash or quote in it; those are the only bytes that mean anything to the reader. Errors are written in a side
  region and put after the rows when the case ends.
- `run.mjs` reads `cases.json` straight into the module's memory, walks the frame JSON.stringify writes around the
  texts, calls `answer()` for each case, and writes the answers file from that memory with one call. The answers are
  written over the input already read (they are about a tenth longer than the texts, so the input starts a little
  ahead): no string is made of the file, and no page is touched twice.
- Anything it does not expect (another JSON layout, a `\u` escape, answers that would outrun the input) is answered
  the ordinary way: `solve.js`, a JavaScript reader of csv-reader's rules (`run(input)`), over `JSON.parse` and
  `JSON.stringify`.

The rules `solve.js` reads by (`run({text, header})` returns exactly csv-reader's `{columns, rows, errors}`):

The reading rules are csv-reader's: a leading U+FEFF is dropped; a record ends at LF or CRLF and an empty line is no
record; outside quotes a CR not followed by LF is dropped (`stray_cr`); a quoted field runs to the next undoubled
quote, `""` is one quote and CRLF or a lone CR inside it is one LF; text after a closing quote up to the next comma or
line break is kept (`quote_junk`); a quote that never closes is a plain character and the text after it is read again
unquoted (`unterminated_quote`); every row is padded (`short_row`, `fields`) or cut (`long_row`, `extra`) to the first
record's width; each error carries the line its record starts on and its row index (null for the header).

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts   # reads input/cases.json, writes output/answers.json
./build.sh   # rebuilds csv.wasm from csv.c (needs clang, wasm-ld and binaryen's wasm-opt)
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=7pb8t6nt&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
