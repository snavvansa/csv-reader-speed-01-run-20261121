// The driver the harness runs (`node /bot/main.ts`): it reads every case from /input/cases.json (a JSON array of
// {id, input}) and writes /output/answers.json, csv-reader 1.0.0's answer to each, in the cases' order. Outside a
// container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// The answers are written by transcode.mjs straight from the file's bytes: csv-reader's own reading, done on the
// JSON-escaped text, each field's JSON string copied from the bytes it came from. A file it does not take (a \u
// escape, a shape it does not know) is read the ordinary way: JSON.parse, run() from solve.js on each case, and
// JSON.stringify, as the house driver does.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Incremental marking off, as the house driver has it; with one CPU nothing runs on background threads.
setFlagsFromString('--no-incremental-marking');
setFlagsFromString('--single-threaded');

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const { transcode } = (await import(new URL('./transcode.mjs', import.meta.url).href)) as {
  transcode: (bytes: Buffer) => Buffer | null;
};

const bytes = readFileSync(join(INPUT_DIR, 'cases.json'));
const fast = transcode(bytes);
if (fast !== null) {
  writeFileSync(join(OUTPUT_DIR, 'answers.json'), fast);
} else {
  const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };
  const cases = JSON.parse(bytes.toString('utf8')) as { id: string; input: unknown }[];
  const answers: unknown[] = [];
  for (const c of cases) answers.push(run(c.input));
  writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
}
