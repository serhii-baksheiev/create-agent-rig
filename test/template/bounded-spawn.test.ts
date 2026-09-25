import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { skipUnless } from '../helpers/env.js';
import { removeFixture } from '../helpers/remove-fixture.js';

/**
 * RP-264: `test/template/codex.test.ts` › "anchors a nested-cwd Windows Codex
 * rulebook edit to the canonical repository root" spawns four children (git
 * init, the PowerShell wrapper, git rev-parse, a probe re-run of the
 * wrapper), none of them bounded — the only timeout in the file is the
 * whole CASE's 60 s budget, which names the case, never the child that
 * actually stalled.
 *
 * `boundedSpawn` (`test/helpers/bounded-spawn.ts` — does not exist yet; this
 * file pins its contract before it does) gives each child its own bound and
 * NAMES it on failure. It settles on a timer rather than waiting for the
 * child's stdio streams to close, because a plain `execFile` timeout waits
 * for `'close'`, and a grandchild holding the inherited pipes (the second
 * test below) keeps that event from ever firing. On timeout it kills the
 * whole process tree and rejects with an Error whose message is exactly
 * `child <label> timed out after <timeoutMs> ms`.
 */

interface BoundedSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin and then closed, when given. */
  input?: string;
  timeoutMs: number;
}

interface BoundedSpawnResult {
  code: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

type BoundedSpawn = (
  label: string,
  file: string,
  args: string[],
  options: BoundedSpawnOptions,
) => Promise<BoundedSpawnResult>;

async function importBoundedSpawn(): Promise<BoundedSpawn> {
  const mod = (await import('../helpers/bounded-spawn.js')) as { boundedSpawn: BoundedSpawn };
  return mod.boundedSpawn;
}

async function waitForPid(file: string, timeoutMs = 1000): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(file, 'utf8')).trim());
      if (Number.isInteger(pid)) return pid;
    } catch {
      // not written yet
    }
    await delay(10);
  }
  return undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

describe('boundedSpawn: names a stalled child instead of letting the case timeout absorb it', () => {
  it('resolves quickly for a child that exits well inside its bound', async () => {
    const boundedSpawn = await importBoundedSpawn();

    const result = await boundedSpawn(
      'quick',
      process.execPath,
      ['-e', "process.stdout.write('ok')"],
      { timeoutMs: 5_000 },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('ok');
    expect(result.elapsedMs).toBeLessThan(5_000);
  });

  it('kills a child that outlives its bound and rejects naming its label and the bound', async () => {
    const boundedSpawn = await importBoundedSpawn();

    const start = Date.now();
    let rejected: Error | undefined;
    try {
      await boundedSpawn('sleeper', process.execPath, ['-e', 'setTimeout(() => {}, 5000);'], {
        timeoutMs: 300,
      });
    } catch (error) {
      rejected = error as Error;
    }
    const elapsed = Date.now() - start;

    expect(rejected).toBeDefined();
    // Exact, not a substring match: this is the string a case-timeout report
    // does NOT carry today, and the whole point of the helper is that it does.
    expect(rejected?.message).toBe('child sleeper timed out after 300 ms');
    expect(
      elapsed,
      `boundedSpawn took ${elapsed} ms for a 300 ms bound — it must return near its own bound, not wait for the child's 5 s sleep`,
    ).toBeLessThan(2_000);
  });

  it('kills a grandchild that holds inherited stdio pipes open, on POSIX', async (ctx) => {
    skipUnless(
      ctx,
      process.platform !== 'win32',
      'reproduces the POSIX inherited-stdio pipe-holding failure this ticket diagnoses; ' +
        'the Windows-only equivalent is exercised end to end by codex.test.ts, verified ' +
        'separately by a windows-e2e dispatch on the branch',
    );
    const boundedSpawn = await importBoundedSpawn();

    const scratch = await mkdtemp(path.join(tmpdir(), 'rp264-bounded-spawn-grandchild-'));
    const pidFile = path.join(scratch, 'grandchild.pid');
    // The root spawns a grandchild with `stdio: 'inherit'` — inheriting the
    // very pipes `boundedSpawn` opened for the root — then exits almost
    // immediately. The grandchild keeps those pipes open, which is exactly
    // what made a plain `execFile` timeout (waits for `'close'`) hang.
    const grandchildScript =
      "const fs = require('node:fs');" +
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
      'setInterval(() => {}, 1000);';
    const rootScript =
      "const { spawn } = require('node:child_process');" +
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'inherit' });` +
      'process.exit(0);';

    let grandchildPid: number | undefined;
    try {
      const start = Date.now();
      let rejected: Error | undefined;
      try {
        await boundedSpawn('holder', process.execPath, ['-e', rootScript], { timeoutMs: 300 });
      } catch (error) {
        rejected = error as Error;
      }
      const elapsed = Date.now() - start;

      expect(
        elapsed,
        `boundedSpawn took ${elapsed} ms for a 300 ms bound — it must settle on its own timer, ` +
          "not wait for the grandchild's held pipe to close",
      ).toBeLessThan(2_000);
      expect(rejected).toBeDefined();
      expect(rejected?.message).toBe('child holder timed out after 300 ms');

      grandchildPid = await waitForPid(pidFile);
      expect(grandchildPid, 'the grandchild never recorded its own pid').toBeDefined();
      // Give the tree-kill a moment to land, then assert it actually did —
      // the promise settling on time is not proof the grandchild died too.
      await delay(200);
      expect(isAlive(grandchildPid!)).toBe(false);
    } finally {
      if (grandchildPid !== undefined && isAlive(grandchildPid)) {
        process.kill(grandchildPid, 'SIGKILL');
      }
      await removeFixture(scratch);
    }
  });
});
