import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';
import { auditFor } from '../helpers/unattended-flag-leak-audit.js';

/**
 * RP-288 scope addition (Jira comment 21563, failure-diagnostician finding).
 *
 * The RP-271 audit (`test/helpers/unattended-flag-leak-audit.ts`) snapshots
 * the shared real `~/.claude` at run start (`auditFor`, `snapshotUnattendedFlags`)
 * and fails teardown on ANY new `__PROJECT_NAME__` flag (`newUnattendedFlags`).
 * A SCOPED arm from a DIFFERENT, concurrent suite mirrors into
 * `userInfo().homedir` by the very design RP-271 itself documents — and that
 * other run clears its own flag correctly, just not necessarily before THIS
 * run's teardown happens to look. Measured (failure-diagnostician): a
 * flag-free file failed the audit in 4 of 121 runs, beside a green peer
 * suite that armed and correctly cleared its own scoped flag in that window.
 *
 * Acceptance: teardown reports only flags that PERSIST. A candidate still
 * "new" at the first check is re-checked ONCE more after a bounded window —
 * long enough to outlast the longest legitimate arm; the doctor guard batch
 * this repo runs can itself take up to a 30 s timeout, so ~35 s is the
 * default (bounded: at least 31 s, at most 60 s — test (c) below). Only a
 * candidate still present at the SECOND check is reported.
 *
 * The injection point this file exercises, on `auditFor`'s own options
 * (`test/helpers/unattended-flag-leak-audit.ts`) — two optional fields
 * alongside the existing `env`/`homes`:
 *
 *   - `recheckWindowMs?: number` — how long to wait before the second check;
 *     defaults to a value in `[31_000, 60_000]` ms (test (c)).
 *   - `sleep?: (ms: number) => Promise<void>` — the delay primitive teardown
 *     calls with `recheckWindowMs`, defaulting to a real `setTimeout`-based
 *     wait so a normal run genuinely waits out the window. Every test below
 *     injects a synchronous fake instead, so nothing here actually waits in
 *     real time.
 *
 * Teardown's shape: on a non-empty first `newUnattendedFlags(snapshot)`
 * result, `await sleep(recheckWindowMs)`, then re-run
 * `newUnattendedFlags(snapshot)` against the SAME original snapshot; only the
 * SECOND result is ever reported (thrown on). If the first result is already
 * empty, `sleep` is never called at all — there is nothing to wait out.
 *
 * Independent-oracle rule (`.claude/rules/invariants.md`): every planted
 * flag name below is the same literal, unsubstituted
 * `__PROJECT_NAME__-<16-hex>-loop-UNATTENDED` shape
 * test/template/unattended-flag-audit-helper.test.ts already hand-writes —
 * never derived from unattended-flag.mjs's own hashing.
 *
 * Sandbox: every home here is a fresh `mkdtemp` directory, removed through
 * the shared `removeFixture` (test/helpers/remove-fixture.ts) in `afterEach`
 * below; nothing in this file ever reads or writes the real home, and no
 * `sleep` here is the real one — every window is fake.
 */

const homes: string[] = [];
const tempHome = async (): Promise<string> => {
  const home = await mkdtemp(path.join(tmpdir(), 'unattended-flag-leak-audit-window-'));
  homes.push(home);
  return home;
};

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => removeFixture(home)));
});

async function plantFlag(home: string, name: string): Promise<string> {
  const dir = path.join(home, '.claude');
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, name);
  await writeFile(target, '{}\n');
  return target;
}

/** A hand-written recording stub — no mocking framework (`node-ts.md`). */
function recordingSleep(
  onCall: (ms: number) => void | Promise<void>,
): (ms: number) => Promise<void> {
  return async (ms: number) => {
    await onCall(ms);
  };
}

describe('RP-288: the RP-271 audit re-checks a candidate over a bounded window before reporting it', () => {
  it('(a) a flag planted after setup and REMOVED before the window ends is not reported', async () => {
    const home = await tempHome();
    const target = path.join(home, '.claude', '__PROJECT_NAME__-a1a1a1a1a1a1a1a1-loop-UNATTENDED');
    const calls: number[] = [];
    // Simulates the OTHER run's own, correct clear happening during the
    // recheck window — exactly the false-positive the diagnostician measured.
    const sleep = recordingSleep(async (ms) => {
      calls.push(ms);
      await rm(target, { force: true });
    });

    const teardown = await auditFor({ homes: [home], recheckWindowMs: 35_000, sleep });
    await plantFlag(home, '__PROJECT_NAME__-a1a1a1a1a1a1a1a1-loop-UNATTENDED');

    await expect(teardown()).resolves.toBeUndefined();
    expect(calls, 'the recheck window must actually have been used').toEqual([35_000]);
  });

  it('(b) a flag still present after the window is reported, naming it', async () => {
    const home = await tempHome();
    const calls: number[] = [];
    const sleep = recordingSleep((ms) => {
      calls.push(ms);
    });

    const teardown = await auditFor({ homes: [home], recheckWindowMs: 35_000, sleep });
    const planted = await plantFlag(home, '__PROJECT_NAME__-b2b2b2b2b2b2b2b2-loop-UNATTENDED');

    let caught: unknown;
    try {
      await teardown();
    } catch (err) {
      caught = err;
    }
    expect(
      caught,
      'a flag still present after the recheck window should be reported',
    ).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/RP-271/);
    expect((caught as Error).message).toContain(planted);
    expect(calls, 'the recheck window must actually have been used').toEqual([35_000]);
  });

  it('(c) the default recheck window is bounded: at least 31s, at most 60s', async () => {
    const home = await tempHome();
    const calls: number[] = [];
    const sleep = recordingSleep((ms) => {
      calls.push(ms);
    });

    // No recheckWindowMs override — exercises the module's own default.
    const teardown = await auditFor({ homes: [home], sleep });
    await plantFlag(home, '__PROJECT_NAME__-c3c3c3c3c3c3c3c3-loop-UNATTENDED');

    await expect(teardown()).rejects.toThrow(/RP-271/);
    expect(calls, 'the default recheck window must have used the injected sleep').toHaveLength(1);
    expect(calls[0]).toBeGreaterThanOrEqual(31_000);
    expect(calls[0]).toBeLessThanOrEqual(60_000);
  });
});
