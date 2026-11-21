// The work main.ts hands to a fresh V8 isolate: read /input/cases.json, answer each case with run() from solve.js,
// write /output/answers.json.
//
// The file is read as latin1, one byte one character, and the answers are written back the same way. csv-reader's
// reading only looks at ASCII characters (comma, quote, CR, LF), and no byte of a multi-byte UTF-8 sequence is ASCII,
// so every field read from the byte-string is the byte-string of the field csv-reader reads from the decoded text;
// JSON.stringify leaves bytes 0x80-0xFF as they stand, so the answers file holds the very UTF-8 bytes the decoded
// path would write. What it buys: one-byte strings end to end (half the memory, no UTF-8 decode or encode). Two
// things the byte view would change, and how they are kept: the BOM is the three bytes EF BB BF (dropped here, before
// run(), which drops a U+FEFF the same way), and a \u escape in the JSON could make a character past 0xFF (then the
// whole file is read the ordinary way, as UTF-8).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './solve.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const bytes = readFileSync(join(INPUT_DIR, 'cases.json'));
const byteView = bytes.indexOf('\\u') < 0;
const cases = JSON.parse(bytes.toString(byteView ? 'latin1' : 'utf8'));

const answers = [];
for (const c of cases) {
  let input = c.input;
  if (byteView && input !== null && typeof input === 'object' && typeof input.text === 'string') {
    const t = input.text;
    if (t.charCodeAt(0) === 0xef && t.charCodeAt(1) === 0xbb && t.charCodeAt(2) === 0xbf) {
      input = { text: t.slice(3), header: input.header };
    }
  }
  answers.push(run(input));
}
const out = JSON.stringify(answers);
writeFileSync(join(OUTPUT_DIR, 'answers.json'), out, byteView ? 'latin1' : 'utf8');
