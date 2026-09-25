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
 * fire until every stdio stream is closed. On timeout it kills the process
 * tree it can reach and rejects — but the tree-kill's reach is not total,
 * and the timer settle is what covers the gap:
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
 *
 * A kill is only ever sent for a pid this call still owns (RP-264 round 3,
 * security-scanner B1/A1/A2). Once Node reports the child's own exit
 * (`child.exitCode` or `child.signalCode` no longer `null`), that pid is
 * released back to the OS and may already name an unrelated process by the
 * time the timer fires — a `taskkill /PID <reused> /T /F` on Windows, or a
 * single-pid `SIGKILL` on POSIX, would then hit whatever now holds it, not
 * the child this call spawned. So every path that signals one specific pid —
 * Windows' `taskkill`, and the POSIX fallback used when the group signal
 * itself fails — checks `pid > 0` and that the child is still running first,
 * and sends nothing at all otherwise; this call still settles and rejects on
 * its own timer regardless. The one exception is POSIX's primary signal,
 * `process.kill(-pid, …)`: it targets the process *group*, not the single
 * pid, and the kernel keeps a group's id reserved for as long as any member
 * of it is still alive — which a plain grandchild (not itself further
 * detached) always is at this point, by construction. `test/template/
 * bounded-spawn.test.ts` › "kills a grandchild that holds inherited stdio
 * pipes open, on POSIX" pins that this group signal still lands even though
 * the direct child has already exited; › "boundedSpawn: never signals a pid
 * it no longer owns" pins the still-running gate through the `killTree` test
 * seam below, which only ever stands in for a single-pid send.
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
  /**
   * Test seam: stands in for a single-pid kill send (Windows' `taskkill`, or
   * the POSIX fallback) — never for the POSIX group signal, which has no
   * per-pid risk to seam around. Defaults to the real one. Called with the
   * child's own pid, and only while this call still owns it: `pid > 0` and
   * the child not yet reported exited (`child.exitCode === null &&
   * child.signalCode === null`) — see the header and the timeout handler.
   */
  killTree?: (pid: number) => void | Promise<void>;
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
 * more than its configured bound plus this one: the guard resolves the wait
 * itself the moment it fires, rather than waiting on the killed process's
 * own exit event.
 */
const killTreeWindows = (pid: number): Promise<void> =>
  new Promise((resolveKill) => {
    let settledKill = false;
    const finish = (): void => {
      if (settledKill) return;
      settledKill = true;
      clearTimeout(guard);
      resolveKill();
    };
    let killer;
    try {
      killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      finish();
      return;
    }
    const guard = setTimeout(() => {
      killer.kill();
      finish();
    }, TASKKILL_TIMEOUT_MS);
    killer.on('exit', finish);
    killer.on('error', finish);
  });

/**
 * The real tree-kill: on POSIX, `process.kill(-pid, 'SIGKILL')` signals the
 * whole process group the child was spawned into (its own, since it is
 * spawned `detached: true`), reaching any grandchild it spawned without
 * further detaching. That send is synchronous, so this resolves at once. If
 * it throws — the group itself is already gone — `single` (true only while
 * the child is still running, per the timeout handler) decides whether a
 * fallback single-pid signal is worth the reused-pid risk described in the
 * header; when it would not be, nothing further is sent. On Windows,
 * `taskkill /T` walks the tree by parent pid instead — a single-pid
 * operation throughout, so it runs only while `single` holds, and this
 * resolves only once that invocation exits, errors, or is force-killed by
 * its own guard.
 */
const defaultKillTree = (pid: number, single: boolean): void | Promise<void> => {
  if (WIN32) {
    return single ? killTreeWindows(pid) : undefined;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    if (single) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
};

export function boundedSpawn(
  label: string,
  file: string,
  args: string[],
  options: BoundedSpawnOptions,
): Promise<BoundedSpawnResult> {
  const { cwd, env, input, timeoutMs, killTree } = options;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;

    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Only meaningful on POSIX: gives the child its own process group so
      // the real tree-kill can signal it (and anything it spawned) as a unit.
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
      const owned = pid !== undefined && pid > 0;
      // Once Node has reported the child's own exit, its pid is released
      // back to the OS and may already name something else by the time this
      // fires — see the header. A single-pid send (the test seam, the
      // Windows path, and the POSIX fallback) must never run past that
      // point; the POSIX group signal may, and is sent unconditionally
      // below by `defaultKillTree` when no seam replaces it.
      const running = child.exitCode === null && child.signalCode === null;
      let treeKilled: Promise<void>;
      if (killTree) {
        treeKilled = owned && running ? Promise.resolve(killTree(pid)) : Promise.resolve();
      } else {
        treeKilled = owned ? Promise.resolve(defaultKillTree(pid, running)) : Promise.resolve();
      }
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
