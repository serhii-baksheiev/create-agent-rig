import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CHILD_TIMING_ENV,
  CHILD_TIMING_IMPORT,
  readChildElapsedMs,
  runNodeTimed,
} from '../helpers/child-timing.js';
import { removeFixture } from '../helpers/remove-fixture.js';

// RP-158: a load-sensitive assertion should test the OPERATION it claims to
// bound, not the parent's wall clock around spawning it — under contention the
// parent's Date.now() also counts scheduler queueing and process-exit
// bookkeeping that have nothing to do with the guard's own work. This helper
// lets a test measure what the CHILD itself saw, via `performance.now()`
// against the child's own time origin, written out on exit.

const BUSY_WAIT_MS = 200;
const busyWaitScript = `const start = performance.now(); while (performance.now() - start < ${BUSY_WAIT_MS}) { /* busy */ }`;

interface ChildRun {
  code: number;
  parentMs: number;
}

function runChild(script: string, env: NodeJS.ProcessEnv): Promise<ChildRun> {
  return new Promise((resolve) => {
    const started = performance.now();
    execFile(
      process.execPath,
      ['--import', CHILD_TIMING_IMPORT, '-e', script],
      { env: { ...process.env, ...env } },
      (error) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          parentMs: performance.now() - started,
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

describe('runNodeTimed: one timed node child, its output, and no directory left behind', () => {
  let root: string;
  let script: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'run-node-timed-'));
    script = path.join(root, 'child.mjs');
    await writeFile(
      script,
      [
        "let input = '';",
        "process.stdin.on('data', (chunk) => (input += chunk));",
        "process.stdin.on('end', () => {",
        `  const start = performance.now(); while (performance.now() - start < ${BUSY_WAIT_MS}) {}`,
        "  process.stdout.write(`${input}|${process.env.RUN_NODE_TIMED_PROBE ?? ''}`);",
        "  process.stderr.write('to stderr');",
        '  process.exit(3);',
        '});',
      ].join('\n'),
    );
  });

  afterEach(async () => {
    await removeFixture(root);
  });

  it('returns the exit code, both streams and the child-measured elapsed time, passing stdin and env through', async () => {
    const timingRoot = path.join(root, 'timing');
    await mkdir(timingRoot);
    const run = await runNodeTimed(script, {
      input: 'payload',
      env: { ...process.env, RUN_NODE_TIMED_PROBE: 'probe' },
      timingRoot,
    });
    expect(run.code).toBe(3);
    expect(run.stdout).toBe('payload|probe');
    expect(run.stderr).toBe('to stderr');
    expect(run.elapsedMs).toBeGreaterThanOrEqual(BUSY_WAIT_MS - 50);
    // the timing directory it created under timingRoot is gone again
    expect(await readdir(timingRoot)).toEqual([]);
  });

  it('reports TIMEOUT for a child it had to kill, and still removes its directory', async () => {
    const timingRoot = path.join(root, 'timing');
    await mkdir(timingRoot);
    const run = await runNodeTimed(script, { timeout: 50, timingRoot });
    expect(run.code).toBe('TIMEOUT');
    expect(await readdir(timingRoot)).toEqual([]);
  });
});
