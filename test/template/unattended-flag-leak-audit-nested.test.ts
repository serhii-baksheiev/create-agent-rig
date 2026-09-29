import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';
import { auditFor } from '../helpers/unattended-flag-leak-audit.js';

// RP-296 — diagnosed in the RP-231 pilot: `test/template/rig-run-dir-scrub.test.ts`
// › "holds with the variable exported around the whole vitest process" spawns a
// NESTED vitest (env `RIG_SCRUB_TEST_CHILD=1`) reusing this repo's own
// vitest.config.ts, so the nested run also executes the
// `test/helpers/unattended-flag-leak-audit.ts` global setup (RP-271). That
// nested teardown snapshots the real homes' `__PROJECT_NAME__-*-loop-UNATTENDED`
// files at nested-setup time and throws if any are new at nested-teardown time
// — but the SAME real homes are shared with every OTHER test file of the same
// outer `pnpm test`, several of which (e.g. test/template/queue-board.test.ts)
// legitimately arm and clear that flag while the nested child is alive. The
// nested child's teardown can therefore observe an outer test's flag mid-flight
// and report a leak that is not its own, failing the whole suite intermittently.
//
// Owner directive: preserve the RP-271 TOP-LEVEL audit's fail-closed behaviour
// exactly — only the nested child (`RIG_SCRUB_TEST_CHILD` set) should skip the
// audit; the outer run's own audit already owns anything the child could leak.
//
// The seam under test: the module's zero-argument default export stays the
// vitest `globalSetup` entry and calls the named export
// `auditFor({ env, homes })`, whose `env` defaults to `process.env` and whose
// `homes` defaults to the real homes the audit always read. With
// `RIG_SCRUB_TEST_CHILD` set in `env`, `auditFor` returns a no-op teardown
// without snapshotting anything; without it, the RP-271 audit runs unchanged.
//
// This file drives that seam directly with fixture homes/env, so it never
// touches the real home: none of the paths passed below are the real
// `userInfo().homedir` or `$HOME`, and nothing here plants a flag anywhere but
// a temp directory this test created and owns.
//
// Independent-oracle rule (`.claude/rules/invariants.md`): the planted flag
// names below are the same literal, unsubstituted
// `__PROJECT_NAME__-<16-hex>-loop-UNATTENDED` shape
// test/template/unattended-flag-audit-helper.test.ts already hand-writes —
// never derived by calling into unattended-flag.mjs's own hashing.

// RP-288: every home this file creates is tracked here and removed in
// `afterEach`, so a run of this file leaves nothing behind in the OS temp
// directory.
const createdHomes: string[] = [];

const tempHome = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'unattended-flag-leak-audit-nested-'));
  createdHomes.push(dir);
  return dir;
};

afterEach(async () => {
  const homes = createdHomes.splice(0);
  await Promise.all(homes.map((dir) => removeFixture(dir)));
});

async function plantFlag(home: string, name: string): Promise<string> {
  const dir = path.join(home, '.claude');
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, name);
  await writeFile(target, '{}\n');
  return target;
}

describe('the nested RIG_SCRUB_TEST_CHILD marker suppresses the RP-271 leak audit', () => {
  it('does not throw at teardown when a new flag appears between setup and teardown', async () => {
    expect(
      typeof auditFor,
      'test/helpers/unattended-flag-leak-audit.ts should export an auditFor(options) seam',
    ).toBe('function');

    const home = await tempHome();
    const teardown = await auditFor({
      env: { ...process.env, RIG_SCRUB_TEST_CHILD: '1' },
      homes: [home],
    });

    // Simulates an outer test file (queue-board.test.ts) arming the shared
    // flag while this nested child is alive — this must not be read as this
    // child's own leak.
    await plantFlag(home, '__PROJECT_NAME__-0123456789abcdef-loop-UNATTENDED');

    await expect(teardown()).resolves.toBeUndefined();
  });

  it('does not even attempt to read the homes it was given', async () => {
    expect(
      typeof auditFor,
      'test/helpers/unattended-flag-leak-audit.ts should export an auditFor(options) seam',
    ).toBe('function');

    // A "home" that is a plain file, not a directory: reading `<home>/.claude`
    // rejects with ENOTDIR, not the tolerated ENOENT — so if `auditFor` (with
    // the marker set) ever attempted to snapshot this home at all, the setup
    // call below would reject. It must not even try.
    const home = await tempHome();
    const poisonedHome = path.join(home, 'not-a-directory');
    await writeFile(poisonedHome, 'not a directory\n');

    await expect(
      auditFor({
        env: { ...process.env, RIG_SCRUB_TEST_CHILD: '1' },
        homes: [poisonedHome],
      }),
    ).resolves.toEqual(expect.any(Function));
  });

  it('without the marker, the same appearing-flag scenario still throws the RP-271 leak error', async () => {
    expect(
      typeof auditFor,
      'test/helpers/unattended-flag-leak-audit.ts should export an auditFor(options) seam',
    ).toBe('function');

    const home = await tempHome();
    // RP-288: recheckWindowMs: 0 keeps this test fast — it exercises the
    // throw-on-leak path, not the recheck window's own timing, which
    // test/template/unattended-flag-leak-audit-persistence-window.test.ts
    // pins with an injected fake sleep instead.
    const teardown = await auditFor({ homes: [home], recheckWindowMs: 0 });

    const planted = await plantFlag(home, '__PROJECT_NAME__-fedcba9876543210-loop-UNATTENDED');

    let caught: unknown;
    try {
      await teardown();
    } catch (err) {
      caught = err;
    }
    expect(caught, 'teardown should have thrown the RP-271 leak error').toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/RP-271/);
    expect((caught as Error).message).toContain(planted);
  });

  /**
   * RP-295 comment 21408 — `auditFor` currently reads the marker with
   * `if (env.RIG_SCRUB_TEST_CHILD)`, a plain truthiness check. That treats
   * EVERY non-empty string as "this is the nested child", including the
   * literal string `'0'` — which is exactly what a shell does NOT mean by
   * "unset" or "false", and is a value an env-propagation bug (a stray
   * `RIG_SCRUB_TEST_CHILD=0` surviving from an unrelated place) could easily
   * produce. The marker must match the literal `'1'` the nested spawn in
   * rig-run-dir-scrub.test.ts and unattended-flag-leak-audit.ts's own header
   * comment both document — nothing looser.
   */
  it('does not treat RIG_SCRUB_TEST_CHILD="0" as the nested-child marker — the audit still runs and still throws', async () => {
    const home = await tempHome();
    // RP-288: recheckWindowMs: 0 keeps this test fast — see the comment on
    // the equivalent call above.
    const teardown = await auditFor({
      env: { ...process.env, RIG_SCRUB_TEST_CHILD: '0' },
      homes: [home],
      recheckWindowMs: 0,
    });

    const planted = await plantFlag(home, '__PROJECT_NAME__-a1b2c3d4e5f60718-loop-UNATTENDED');

    let caught: unknown;
    try {
      await teardown();
    } catch (err) {
      caught = err;
    }
    expect(
      caught,
      'RIG_SCRUB_TEST_CHILD="0" is not the "1" marker — the audit must not have been skipped',
    ).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/RP-271/);
    expect((caught as Error).message).toContain(planted);
  });
});
