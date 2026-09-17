import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { removeFixture } from './remove-fixture.js';

/** Pass to a node child as `--import <this>` to have it record its own elapsed time. */
export const CHILD_TIMING_IMPORT = new URL('./child-timing-preload.mjs', import.meta.url).href;

/** The variable naming the file the child writes its elapsed time to. */
export const CHILD_TIMING_ENV = 'RIG_TEST_CHILD_ELAPSED_FILE';

/** The elapsed milliseconds a child recorded; throws when it recorded nothing. */
export const readChildElapsedMs = async (file: string): Promise<number> => {
  const { elapsedMs } = JSON.parse(await readFile(file, 'utf8')) as { elapsedMs: unknown };
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) {
    throw new Error(`${file} does not hold a recorded elapsed time`);
  }
  return elapsedMs;
};

export interface TimedRunOptions {
  /** Written to the child's stdin, which is then closed. */
  input?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Kill the child after this many milliseconds; the run then reports `TIMEOUT`. */
  timeout?: number;
  maxBuffer?: number;
  /** Where the per-run timing directory is created (default: the OS temp dir). */
  timingRoot?: string;
}

export interface TimedRun {
  code: number | 'TIMEOUT';
  stdout: string;
  stderr: string;
  /** What the child measured itself; `NaN` when it recorded nothing (a killed child). */
  elapsedMs: number;
}

/**
 * Run `node --import CHILD_TIMING_IMPORT <script>` once and return what the
 * child measured, its exit code and its output. The timing directory it
 * creates is removed before it returns, whatever the child did.
 */
export const runNodeTimed = async (
  script: string,
  {
    input,
    env = process.env,
    cwd,
    timeout,
    maxBuffer,
    timingRoot = tmpdir(),
  }: TimedRunOptions = {},
): Promise<TimedRun> => {
  const dir = await mkdtemp(path.join(timingRoot, 'child-timing-'));
  const file = path.join(dir, 'elapsed.json');
  try {
    const run = await new Promise<Omit<TimedRun, 'elapsedMs'>>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        ['--import', CHILD_TIMING_IMPORT, script],
        { env: { ...env, [CHILD_TIMING_ENV]: file }, cwd, timeout, maxBuffer },
        (error, stdout, stderr) => {
          const failure = error as { killed?: boolean; code?: number } | null;
          const code = failure?.killed ? 'TIMEOUT' : failure ? (failure.code ?? 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
      if (!child.stdin) return reject(new Error('no stdin'));
      // A child that exits before reading everything closes the pipe; that is
      // its answer, not a failure of the run.
      child.stdin.on('error', () => {});
      child.stdin.end(input ?? '');
    });
    const elapsedMs = await readChildElapsedMs(file).catch(() => Number.NaN);
    return { ...run, elapsedMs };
  } finally {
    await removeFixture(dir);
  }
};
