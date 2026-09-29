import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';
import setup from '../helpers/unattended-flag-leak-audit.js';

/**
 * RP-288 — every other test of this module drives the `auditFor(options)`
 * seam directly, supplying its own `homes`/`env`/`sleep` (RP-296,
 * unattended-flag-leak-audit-nested.test.ts,
 * unattended-flag-leak-audit-wiring.test.ts,
 * unattended-flag-leak-audit-persistence-window.test.ts). Nothing exercises
 * the module's actual vitest `globalSetup` ENTRY POINT — the zero-argument
 * default export — end to end: reading the real `process.env.HOME` through
 * `homesOf` (stop-flag.mjs) the way vitest itself calls it for every
 * project, with the module's OWN real `sleep` (a genuine `setTimeout`), not
 * an injected one.
 *
 * This drives that entry point directly, with `process.env.HOME` redirected
 * to a fresh temp directory for the duration of the test (restored in
 * `afterEach`) and a flag planted in that temp home ONLY — never in the real
 * `userInfo().homedir`, which `homesOf` also audits but which this test never
 * writes to.
 *
 * RP-288 follow-up: the default export takes no options, so it always waits
 * out the module's real ~35 s recheck window — and this test used to
 * genuinely sleep that long, at the cost of every full run and the Windows
 * lane, with its own per-case timeout raised to 40 s just to fit
 * (`node-ts.md`: "a test that needs a sleep is a design smell"). vitest's
 * fake timers now replace only `setTimeout` (`toFake: ['setTimeout']`) — the
 * one primitive `auditFor`'s default `sleep` calls. The two `fs`-backed
 * checks on either side of that wait are real I/O, untouched by the fake
 * clock, so they still run for real; `waitForTimerRegistration` below
 * flushes the real event loop (via `setImmediate`, which stays real because
 * it is not in `toFake`) until the teardown's own `sleep(...)` call has
 * actually registered its fake timer, so `vi.advanceTimersByTimeAsync` has
 * something to advance instead of racing ahead of it and finding nothing
 * scheduled yet.
 *
 * Independent-oracle rule (`.claude/rules/invariants.md`): the planted flag
 * name is the same literal, unsubstituted
 * `__PROJECT_NAME__-<16-hex>-loop-UNATTENDED` shape
 * test/template/unattended-flag-audit-helper.test.ts already hand-writes —
 * never derived by calling into unattended-flag.mjs's own hashing.
 */

// RP-288: every home this file creates is tracked here and removed in
// `afterEach`, so a run of this file leaves nothing behind in the OS temp
// directory.
const createdHomes: string[] = [];

const tempHome = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'unattended-flag-leak-audit-default-export-'));
  createdHomes.push(dir);
  return dir;
};

async function plantFlag(home: string, name: string): Promise<string> {
  const dir = path.join(home, '.claude');
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, name);
  await writeFile(target, '{}\n');
  return target;
}

// The module's own default (`DEFAULT_RECHECK_WINDOW_MS`,
// unattended-flag-leak-audit.ts) — pinned as a literal here rather than
// imported, so this test still catches a default that silently drifted; the
// module's own default is separately pinned by
// unattended-flag-leak-audit-persistence-window.test.ts's bounded-window case.
const RECHECK_WINDOW_MS = 35_000;

/**
 * Flushes the real event loop — `setImmediate` is not among the fake timers
 * this file installs (`toFake: ['setTimeout']`) — until the pending
 * teardown's own `sleep(...)` call has registered its fake `setTimeout`, or
 * the bound below is hit. Bounded by REAL wall-clock time (`Date.now()`,
 * also not faked here), not by an iteration count: under a full parallel
 * `pnpm test` this file's `readdir` calls queue behind sibling test files'
 * own heavy fs/child-process work on the shared libuv threadpool, and a
 * fixed tick count measured in isolation (200 ticks) was observed to read 0
 * timers and fail even though the real teardown had merely not reached its
 * `sleep(...)` call yet — a false negative, not a regression. Bounded so a
 * genuine regression (the recheck window never gets scheduled at all — e.g.
 * the default export stops calling `sleep`) still fails within this figure
 * rather than hanging; still two orders of magnitude below the 35 s window
 * this whole rework exists to avoid waiting out for real.
 */
async function waitForTimerRegistration(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (vi.getTimerCount() === 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

describe('the default export (the vitest globalSetup entry) end to end, through a real HOME override', () => {
  const originalHome = process.env.HOME;

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;

    const homes = createdHomes.splice(0);
    await Promise.all(homes.map((dir) => removeFixture(dir)));
  });

  it('rejects at teardown when a flag is planted in the HOME-derived home after setup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const home = await tempHome();
      process.env.HOME = home;

      const teardown = await setup();
      const planted = await plantFlag(home, '__PROJECT_NAME__-1122334455667788-loop-UNATTENDED');

      const pending = teardown();
      await waitForTimerRegistration();
      expect(
        vi.getTimerCount(),
        'the RP-288 recheck window must actually have been scheduled before it can be advanced',
      ).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(RECHECK_WINDOW_MS);

      let caught: unknown;
      try {
        await pending;
      } catch (err) {
        caught = err;
      }
      expect(
        caught,
        'the default export teardown should have thrown the RP-271 leak error',
      ).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/RP-271/);
      expect((caught as Error).message).toContain(planted);
    } finally {
      vi.useRealTimers();
    }
  });
});
