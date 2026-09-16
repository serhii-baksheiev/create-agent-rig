import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CHILD_TIMING_ENV,
  CHILD_TIMING_IMPORT,
  readChildElapsedMs,
} from '../helpers/child-timing.js';
import { removeFixture } from '../helpers/remove-fixture.js';

// RP-158: a load-sensitive assertion should test the OPERATION it claims to
// bound, not the parent's wall clock around spawning it — under contention the
// parent's Date.now() also counts scheduler queueing and process-exit
// bookkeeping that have nothing to do with the guard's own work. This helper
// lets a test measure what the CHILD itself saw, via `performance.now()`
// against the child's own time origin, written out on exit.

const BUSY_WAIT_MS = 200;
const busyWaitScript = `const start = Date.now(); while (Date.now() - start < ${BUSY_WAIT_MS}) { /* busy */ }`;

interface ChildRun {
  code: number;
  parentMs: number;
}

function runChild(script: string, env: NodeJS.ProcessEnv): Promise<ChildRun> {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(
      process.execPath,
      ['--import', CHILD_TIMING_IMPORT, '-e', script],
      { env: { ...process.env, ...env } },
      (error) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          parentMs: Date.now() - started,
        });
      },
    );
  });
}

describe('child-timing: a node child records its own elapsed time on exit', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'child-timing-'));
    file = path.join(dir, 'elapsed.json');
  });

  afterEach(async () => {
    await removeFixture(dir);
  });

  it('writes an elapsed time between the busy-wait floor and the parent-measured wall time', async () => {
    const run = await runChild(busyWaitScript, { [CHILD_TIMING_ENV]: file });
    expect(run.code).toBe(0);

    const elapsed = await readChildElapsedMs(file);
    expect(Number.isFinite(elapsed)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(BUSY_WAIT_MS - 50);
    expect(elapsed).toBeLessThanOrEqual(run.parentMs);
  });

  it('writes nothing when the env var is not set', async () => {
    const run = await runChild(busyWaitScript, {});
    expect(run.code).toBe(0);

    await expect(readChildElapsedMs(file)).rejects.toThrow();
  });

  it('still records the elapsed time when the child exits non-zero', async () => {
    const script = `${busyWaitScript}\nprocess.exit(1);`;
    const run = await runChild(script, { [CHILD_TIMING_ENV]: file });
    expect(run.code).toBe(1);

    const elapsed = await readChildElapsedMs(file);
    expect(Number.isFinite(elapsed)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(BUSY_WAIT_MS - 50);
  });
});
