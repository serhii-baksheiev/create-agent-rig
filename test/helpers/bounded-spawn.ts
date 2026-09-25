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
 * process tree it can reach and rejects — but the tree-kill's reach is not
 * total, and the timer settle is what covers the gap:
 * - on Windows, `taskkill /PID <pid> /T /F` walks the tree from `<pid>` by
 *   parent pid. If that parent has already exited — the wrapper spawned a
 *   grandchild and returned before the bound fired — `taskkill` can no
 *   longer find it, and the grandchild is not killed;
 * - on POSIX, the child is spawned in its own process group and killed by
 *   group, which reaches any grandchild it spawned without further
 *   detaching. A grandchild that itself escapes the group (spawned with its
 *   own `detached: true`) is not reached by that signal either.
 *
 * Either way, this call still settles on its own timer rather than waiting
 * for a pipe a tree-kill could not close — `test/template/bounded-spawn.test.ts`
 * › "rejects on its own timer even when an escaped, detached grandchild
 * still holds the pipes" pins exactly this on POSIX, where it can be
 * constructed deterministically.
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
  /** The signal that killed the child, or null on a normal exit. */
  signal: NodeJS.Signals | null;
}

/**
 * Best-effort: ask Windows to kill the process tree rooted at `pid`, and
 * resolve once that attempt is done — bounded by its own short timeout, so a
 * `taskkill` that itself hangs cannot hold the caller past
 * `TASKKILL_TIMEOUT_MS`. The caller's own overall wait is therefore never
 * more than its configured bound plus this one.
 */
const killTreeWindows = (pid: number): Promise<void> =>
  new Promise((resolveKill) => {
    let killer;
    try {
      killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      resolveKill();
      return;
    }
    const guard = setTimeout(() => {
      killer.kill();
    }, TASKKILL_TIMEOUT_MS);
    const done = (): void => {
      clearTimeout(guard);
      resolveKill();
    };
    killer.on('exit', done);
    killer.on('error', done);
  });

/**
 * Kill `pid`'s whole process tree, resolving once the attempt is done. On
 * POSIX the child is spawned detached (its own process group), so a negative
 * pid signals the group — the child and any grandchild it spawned without
 * further detaching; that send is synchronous, so this resolves at once. On
 * Windows, `taskkill /T` walks the tree by parent pid instead, and this
 * resolves only once that invocation exits or is itself force-killed.
 */
const killTree = (pid: number): Promise<void> => {
  if (WIN32) {
    return killTreeWindows(pid);
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
  return Promise.resolve();
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
      const treeKilled = pid !== undefined ? killTree(pid) : Promise.resolve();
      void treeKilled.finally(() => {
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
      });
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`child ${label} failed to start: ${error.message}`));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        // Node reports a signal-killed child with `code: null`; that must
        // never collapse to the same 0 a clean exit reports.
        code: signal !== null ? 1 : (code ?? 0),
        stdout,
        stderr,
        elapsedMs: Date.now() - start,
        signal,
      });
    });

    child.stdin?.end(input ?? '');
  });
}
