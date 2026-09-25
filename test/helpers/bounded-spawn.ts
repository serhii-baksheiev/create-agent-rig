import { spawn } from 'node:child_process';

/**
 * RP-264: give one child process its own bound and name it on failure,
 * instead of letting a whole test CASE's timeout absorb whichever child
 * actually stalled. `test/template/bounded-spawn.test.ts` pins the contract.
 *
 * It settles on its own timer, never by waiting for the child's stdio
 * `'close'` event: a grandchild that inherits the child's piped stdio (a
 * PowerShell wrapper spawning a node helper, for instance) can hold those
 * pipes open long after the child itself has exited, and `'close'` does not
 * fire until every stdio stream is closed. On timeout it kills the whole
 * process tree rather than just the immediate child, so a held-open
 * grandchild does not keep leaking beyond the bound either.
 */

const WIN32 = process.platform === 'win32';

/** How long a `taskkill` invocation itself gets before it is force-killed. */
const TASKKILL_TIMEOUT_MS = 3_000;

export interface BoundedSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin and then closed, when given. */
  input?: string;
  timeoutMs: number;
}

export interface BoundedSpawnResult {
  code: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

/**
 * Best-effort: ask Windows to kill the process tree rooted at `pid`. Bounded
 * with its own short timeout so a `taskkill` that itself hangs cannot hold
 * the caller past its bound.
 */
const killTreeWindows = (pid: number): void => {
  let killer;
  try {
    killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    return;
  }
  const guard = setTimeout(() => {
    killer.kill();
  }, TASKKILL_TIMEOUT_MS);
  const clear = (): void => clearTimeout(guard);
  killer.on('exit', clear);
  killer.on('error', clear);
};

/**
 * Kill `pid`'s whole process tree. On POSIX the child is spawned detached
 * (its own process group), so a negative pid signals the group — the child
 * and any grandchild it spawned without further detaching. On Windows,
 * `taskkill /T` walks the tree by parent pid instead.
 */
const killTree = (pid: number): void => {
  if (WIN32) {
    killTreeWindows(pid);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
};

export function boundedSpawn(
  label: string,
  file: string,
  args: string[],
  options: BoundedSpawnOptions,
): Promise<BoundedSpawnResult> {
  const { cwd, env, input, timeoutMs } = options;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;

    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Only meaningful on POSIX: gives the child its own process group so
      // `killTree` can signal it (and anything it spawned) as a unit.
      detached: !WIN32,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    // A child that exits before reading everything closes the pipe; that is
    // its answer, not a failure of this call.
    child.stdin?.on('error', () => {});

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const pid = child.pid;
      if (pid !== undefined) killTree(pid);
      // A grandchild holding the inherited stdio open would otherwise keep
      // these streams (and the data they are still buffering) alive past
      // the point this call has already given up on them.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      const error = new Error(`child ${label} timed out after ${timeoutMs} ms`) as Error & {
        elapsedMs: number;
      };
      error.elapsedMs = Date.now() - start;
      reject(error);
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`child ${label} failed to start: ${error.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr, elapsedMs: Date.now() - start });
    });

    child.stdin?.end(input ?? '');
  });
}
