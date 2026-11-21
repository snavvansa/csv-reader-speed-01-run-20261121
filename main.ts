// The driver the harness runs (`node /bot/main.ts`): it reads every case from /input/cases.json (a JSON array of
// {id, input}), answers each with run() from solve.js, and writes /output/answers.json, the answers in the cases'
// order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// The work itself (work.mjs) runs in a worker thread: V8 sizes a heap when it makes an isolate, so heap flags set
// here, before the worker is made, shape the worker's heap, where set on this thread's own heap they come too late.
// The answers keep every string they read, so a young generation big enough to hold a whole set means the scavenger
// never copies them, and an old generation sized for it from the start means no mark-compact while the answers are
// written. Incremental marking stays off, as the house driver has it.
//
// The JIT: the scanners are small and hot for well under a second, too short a run for TurboFan to pay for itself
// (its compiles of record() and quoted() took longer than the time they then saved), so they stay in Maglev, whose
// code is nearly as fast here and compiles in a few milliseconds. With one CPU nothing runs on background threads
// (single-threaded: compiles and GC on the thread that needs them), so no thread competes with the work.

import { setFlagsFromString } from 'node:v8';
import { Worker } from 'node:worker_threads';

const FLAGS: string[] = [
  '--no-incremental-marking',
  '--single-threaded',
  '--no-turbofan',
  '--min-semi-space-size=128',
  '--max-semi-space-size=128',
  '--initial-old-space-size=600',
];
for (const flag of FLAGS) setFlagsFromString(flag);

const worker = new Worker(new URL('./work.mjs', import.meta.url));
worker.on('error', (e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
worker.on('exit', (code: number) => {
  if (code !== 0) process.exitCode = code;
});
