import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { boundedSpawn } from '../helpers/bounded-spawn.js';
import {
  posixProcessGroupsAvailable,
  posixSignalDeathAvailable,
  skipUnless,
} from '../helpers/env.js';
import { removeFixture } from '../helpers/remove-fixture.js';

/**
 * RP-264: `test/template/codex.test.ts` › "anchors a nested-cwd Windows Codex
 * rulebook edit to the canonical repository root" spawns four children (git
 * init, the PowerShell wrapper, git rev-parse, a probe re-run of the
 * wrapper), none of them bounded — the only timeout in the file is the
 * whole CASE's 60 s budget, which names the case, never the child that
 * actually stalled.
 *
 * `boundedSpawn` (`test/helpers/bounded-spawn.ts`) gives each child its own
 * bound and NAMES it on failure. It settles on a timer rather than waiting
 * for the child's stdio streams to close, because a plain `execFile` timeout
 * waits for `'close'`, and a grandchild holding the inherited pipes (the
 * tests below) keeps that event from ever firing. On timeout it kills the
 * process tree it can reach and rejects with an Error whose message is
 * exactly `child <label> timed out after <timeoutMs> ms`.
 */

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
    skipUnless(ctx, posixProcessGroupsAvailable().ok, posixProcessGroupsAvailable().reason);

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
      // RP-264 round 2, A2: a 300 ms bound left too little room for two node
      // startups plus the pid write under load — the reviewer warned this
      // race COULD go red under the 8x slowdown RP-264's own diagnosis
      // measured, not that they had observed this test fail — 1500 ms keeps
      // that margin while the elapsed ceiling below still proves the wrapper does
      // not wait for the grandchild's held-open pipe (which would otherwise
      // never close, since the grandchild loops forever).
      const boundMs = 1_500;
      const start = Date.now();
      let rejected: Error | undefined;
      try {
        await boundedSpawn('holder', process.execPath, ['-e', rootScript], { timeoutMs: boundMs });
      } catch (error) {
        rejected = error as Error;
      }
      const elapsed = Date.now() - start;

      expect(
        elapsed,
        `boundedSpawn took ${elapsed} ms for a ${boundMs} ms bound — it must settle on its own timer, ` +
          "not wait for the grandchild's held pipe to close",
      ).toBeLessThan(boundMs + 1_500);
      expect(rejected).toBeDefined();
      expect(rejected?.message).toBe(`child holder timed out after ${boundMs} ms`);

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

  // RP-264 round 2, B1 (code-reviewer HOLD): the helper resolves a
  // signal-killed child with `code: code ?? 0`, so a SIGKILL death is
  // reported as a clean exit — the one field `codex.test.ts` gates on
  // (`code !== 0` for git init and git rev-parse).
  it('reports a child killed by SIGKILL as a signal death, never as exit code 0', async (ctx) => {
    skipUnless(ctx, posixSignalDeathAvailable().ok, posixSignalDeathAvailable().reason);

    const result = await boundedSpawn(
      'self-kill',
      process.execPath,
      ['-e', "process.kill(process.pid, 'SIGKILL');"],
      { timeoutMs: 5_000 },
    );

    // Node reports a signal-killed child with `code: null`; that must never
    // collapse to the same `0` a clean exit reports. Pinned here: 1, matching
    // the execFile convention `codex.test.ts` used before this helper
    // replaced it (`error ? (error.code ?? 1) : 0`) — plus a `signal` field
    // so a caller can tell "failed" from "died by signal" apart.
    expect(result.code).not.toBe(0);
    expect(result.code).toBe(1);
    expect(result.signal).toBe('SIGKILL');
  });

  // RP-264 round 2, B2 (code-reviewer HOLD): no shipped test fails if the
  // helper waits for the child's stdio `'close'` event instead of settling
  // on its own timer — the group-kill in the existing grandchild test above
  // also makes `'close'` fire promptly, so a close-waiting mutant passes it
  // too. This grandchild escapes the group (`detached: true`) and inherits
  // the piped stdio, so the tree-kill's group signal cannot reach it and its
  // held-open pipe cannot close on its own for the length of its own sleep —
  // a mutant that settles on `'close'` would wait on it regardless of the
  // configured bound.
  it('rejects on its own timer even when an escaped, detached grandchild still holds the pipes', async (ctx) => {
    skipUnless(ctx, posixProcessGroupsAvailable().ok, posixProcessGroupsAvailable().reason);

    const scratch = await mkdtemp(path.join(tmpdir(), 'rp264-bounded-spawn-escaped-'));
    const pidFile = path.join(scratch, 'escaped.pid');
    const grandchildScript =
      "const fs = require('node:fs');" +
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
      'setTimeout(() => {}, 5000);';
    const rootScript =
      "const { spawn } = require('node:child_process');" +
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'inherit', detached: true });` +
      'process.exit(0);';

    const boundMs = 600;
    let escapedPid: number | undefined;
    try {
      const start = Date.now();
      let rejected: Error | undefined;
      try {
        await boundedSpawn('esc', process.execPath, ['-e', rootScript], { timeoutMs: boundMs });
      } catch (error) {
        rejected = error as Error;
      }
      const elapsed = Date.now() - start;

      expect(rejected).toBeDefined();
      expect(rejected?.message).toBe(`child esc timed out after ${boundMs} ms`);
      // The reviewer measured the real helper reject at ~605 ms and a
      // settles-on-'close' mutant still pending at 4 s for this exact
      // reproduction; 2 s sits comfortably between the two.
      expect(
        elapsed,
        `boundedSpawn took ${elapsed} ms for a ${boundMs} ms bound with an escaped, pipe-holding ` +
          "grandchild still alive — it must settle on its own timer, not wait for 'close'",
      ).toBeLessThan(2_000);

      escapedPid = await waitForPid(pidFile);
      expect(escapedPid, 'the escaped grandchild never recorded its own pid').toBeDefined();
    } finally {
      // The escaped grandchild is, by construction, outside the tree-kill's
      // reach — that is what makes it discriminate the mutant. Clean it up
      // here rather than asserting its death.
      if (escapedPid !== undefined && isAlive(escapedPid)) {
        process.kill(escapedPid, 'SIGKILL');
      }
      await removeFixture(scratch);
    }
  });
});

// RP-264 round 3 (security-scanner HOLD, B1): the timer fires whenever
// 'close' has not — including the exact case the helper's own header names,
// where the direct child has already exited and an escaped grandchild still
// holds the pipes. Node releases an exited child's pid, and the OS is free
// to reuse it. A tree-kill sent after that point does not reach the child it
// meant to kill: on win32, `taskkill /PID <pid> /T /F` force-kills whatever
// process now HAS that pid, and its whole tree; on POSIX, the positive-pid
// fallback (`bounded-spawn.ts:96`) signals a reaped pid.
//
// Required contract this pins: the tree-kill runs only while the child is
// still running (`child.exitCode === null && child.signalCode === null`),
// and only for `pid > 0`. When the child has already exited, the helper
// sends no kill at all, but still rejects on its own timer with the named
// timeout — the settle-on-timer property is untouched by this fix.
//
// Observed through a test seam rather than an OS-dependent probe, per this
// repo's own convention against mocking or patching module internals
// (`.claude/rules/node-ts.md`): `BoundedSpawnOptions` gains an optional
//
//   killTree?: (pid: number) => void | Promise<void>
//
// called with the child's own pid in place of the real tree-kill, and only
// under the same running-and-positive-pid condition the real kill must now
// carry. This is the Green step's seam to add — `BoundedSpawnOptions` does
// not declare it yet, so `tsc` refuses every call below that passes one:
// `error TS2353: Object literal may only specify known properties, and
// 'killTree' does not exist in type 'BoundedSpawnOptions'`. Both tests below
// therefore fail to typecheck today; at the (type-erased) vitest-runtime
// level, only the second currently fails outright — the first's "no call"
// expectation holds vacuously while the seam is unwired, and becomes a real
// regression guard only once the Green step wires it under the running
// check.
describe('boundedSpawn: never signals a pid it no longer owns', () => {
  it('sends no kill when the direct child has already exited before the timer fires', async (ctx) => {
    skipUnless(ctx, posixProcessGroupsAvailable().ok, posixProcessGroupsAvailable().reason);

    const scratch = await mkdtemp(path.join(tmpdir(), 'rp264-bounded-spawn-reaped-'));
    const pidFile = path.join(scratch, 'grandchild.pid');
    // Same escape mechanism as the "escaped, detached grandchild" test above:
    // the grandchild inherits the root's piped stdio and outlives it, so
    // 'close' cannot fire — but here the point is not the grandchild's own
    // fate, it is that the ROOT (the direct child `boundedSpawn` itself
    // spawned) is long gone, reaped, and its pid free to reuse by the time
    // the 300 ms timer fires.
    const grandchildScript =
      "const fs = require('node:fs');" +
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
      'setTimeout(() => {}, 5000);';
    const rootScript =
      "const { spawn } = require('node:child_process');" +
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'inherit', detached: true });` +
      'process.exit(0);';

    const calls: number[] = [];
    const boundMs = 300;
    let grandchildPid: number | undefined;
    try {
      let rejected: Error | undefined;
      try {
        await boundedSpawn('reaped', process.execPath, ['-e', rootScript], {
          timeoutMs: boundMs,
          killTree: (pid: number) => {
            calls.push(pid);
          },
        });
      } catch (error) {
        rejected = error as Error;
      }

      expect(rejected).toBeDefined();
      expect(rejected?.message).toBe(`child reaped timed out after ${boundMs} ms`);
      expect(
        calls,
        'a kill was sent for a pid the child no longer owns — Node may already have reused it',
      ).toEqual([]);

      grandchildPid = await waitForPid(pidFile);
    } finally {
      if (grandchildPid !== undefined && isAlive(grandchildPid)) {
        process.kill(grandchildPid, 'SIGKILL');
      }
      await removeFixture(scratch);
    }
  });

  it('kills the direct child once, by its own pid, when the child itself outlives the bound', async () => {
    const calls: number[] = [];
    const boundMs = 300;

    let rejected: Error | undefined;
    try {
      await boundedSpawn('slow', process.execPath, ['-e', 'setTimeout(() => {}, 5000);'], {
        timeoutMs: boundMs,
        killTree: (pid: number) => {
          calls.push(pid);
        },
      });
    } catch (error) {
      rejected = error as Error;
    }

    expect(rejected).toBeDefined();
    expect(rejected?.message).toBe(`child slow timed out after ${boundMs} ms`);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThan(0);
  });
});
