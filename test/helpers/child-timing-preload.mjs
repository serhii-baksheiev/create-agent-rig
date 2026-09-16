// Loaded with `node --import` by tests that bound how long a child process
// works (RP-158). When RIG_TEST_CHILD_ELAPSED_FILE is set, the child writes its
// own `performance.now()` — milliseconds since its own time origin — to that
// file as it exits, so the bound measures the child rather than the parent's
// wall clock around spawning and reaping it.
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const out = process.env.RIG_TEST_CHILD_ELAPSED_FILE;
if (out) {
  process.on('exit', () => {
    writeFileSync(out, JSON.stringify({ elapsedMs: performance.now() }));
  });
}
