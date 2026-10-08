import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

/**
 * RP-281 — preflight reports against the RP-280 posture contract
 * (`.claude/scripts/lib/posture.mjs`) instead of a policy of its own: every
 * scripted check carries the contract's stable id and an exact outcome, the
 * items it does not check are named by id and only as `unknown`, and the
 * verdict is the contract's `preflightVerdict`.
 *
 * The expected ids below are written out by hand — an independent oracle, not
 * a read of either production module.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const load = (file: string) => import(pathToFileURL(path.join(scriptsDir, file)).href);

type Condition = { id: string; classification: string; surfaces: string[] };
type Check = { ok: boolean | string; detail?: string; id?: string; outcome?: string };
type Report = {
  verdict: string;
  checks: Record<string, Check>;
  unchecked: string[];
  uncheckedConditions: { id: string; outcome: string; detail: string }[];
  rendered: string;
};

const EXPECTED_CHECK_IDS: Record<string, string> = {
  killSwitch: 'kill-switch-armed',
  runDirNotExported: 'run-dir-inherited',
  unattendedFlag: 'unattended-flag-stale',
  detectionContract: 'detection-contract-invalid',
  queue: 'queue-unreadable',
  defaultBranchFresh: 'default-branch-stale',
  lastDeploy: 'last-deploy-failed',
};
const EXPECTED_UNCHECKED_IDS = ['budget-declared', 'stray-worktree'];
const NATIVE_STATE_IDS = [
  'harness-hooks-loaded',
  'codex-hook-trust',
  'workspace-trust',
  'native-sandbox-mode',
  'session-root-matches-run',
  'run-dir-fresh-per-run',
];

const allPass = (): Record<string, Check> =>
  Object.fromEntries(
    Object.keys(EXPECTED_CHECK_IDS).map((key) => [key, { ok: true, detail: 'd' }]),
  );

/** Both directions of a correspondence, so either side gaining an entry is named. */
const mismatches = (contract: string[], reported: string[]) => ({
  missing: contract.filter((id) => !reported.includes(id)).sort(),
  extra: reported.filter((id) => !contract.includes(id)).sort(),
});

describe('preflight reports against the posture contract (RP-281)', () => {
  it('names exactly the conditions the contract puts on the preflight surface, and nothing else', async () => {
    const { POSTURE_CONDITIONS } = await load('lib/posture.mjs');
    const { CHECK_IDS, UNCHECKED_CONDITIONS } = await load('preflight.mjs');
    const onPreflight = (POSTURE_CONDITIONS as Condition[])
      .filter((c) => c.surfaces.includes('preflight'))
      .map((c) => c.id);
    const reported = [
      ...Object.values((CHECK_IDS ?? {}) as Record<string, string>),
      ...((UNCHECKED_CONDITIONS ?? []) as { id: string }[]).map((c) => c.id),
    ];
    expect(mismatches(onPreflight, reported)).toEqual({ missing: [], extra: [] });
    expect(CHECK_IDS).toEqual(EXPECTED_CHECK_IDS);
    expect(((UNCHECKED_CONDITIONS ?? []) as { id: string }[]).map((c) => c.id).sort()).toEqual(
      EXPECTED_UNCHECKED_IDS,
    );
  });

  it('the correspondence names the offender on each side (mutation: the contract gains an id, preflight gains an id)', () => {
    const contract = ['a-condition', 'b-condition'];
    expect(mismatches([...contract, 'new-in-contract'], contract)).toEqual({
      missing: ['new-in-contract'],
      extra: [],
    });
    expect(mismatches(contract, [...contract, 'new-in-preflight'])).toEqual({
      missing: [],
      extra: ['new-in-preflight'],
    });
  });

  it('scripts only observable conditions, and lists only not-observable ones as unchecked', async () => {
    const { conditionById } = await load('lib/posture.mjs');
    const { CHECK_IDS, UNCHECKED_CONDITIONS } = await load('preflight.mjs');
    for (const id of Object.values(CHECK_IDS as Record<string, string>)) {
      expect((conditionById(id) as Condition).classification, id).not.toBe('not-observable');
    }
    for (const { id } of UNCHECKED_CONDITIONS as { id: string }[]) {
      expect((conditionById(id) as Condition).classification, id).toBe('not-observable');
    }
  });

  it('gives every scripted check its contract id and an exact outcome — stale is an observed fail, unknown stays unknown', async () => {
    const { report } = await load('preflight.mjs');
    const result = report({
      ...allPass(),
      defaultBranchFresh: { ok: 'stale', detail: 'behind' },
      lastDeploy: { ok: 'unknown', detail: 'no history' },
    }) as Report;
    for (const [key, id] of Object.entries(EXPECTED_CHECK_IDS)) {
      expect(result.checks[key]?.id, key).toBe(id);
    }
    expect(result.checks.killSwitch?.outcome).toBe('pass');
    expect(result.checks.defaultBranchFresh?.outcome).toBe('fail');
    expect(result.checks.lastDeploy?.outcome).toBe('unknown');
    expect(result.rendered).toMatch(/default-branch-stale/);
  });

  it('names every condition it does not check by id and only as unknown, so a clean scripted run cautions rather than reporting GO', async () => {
    const { report } = await load('preflight.mjs');
    const result = report(allPass()) as Report;
    expect(result.uncheckedConditions.map((c) => c.id).sort()).toEqual(EXPECTED_UNCHECKED_IDS);
    for (const condition of result.uncheckedConditions) {
      expect(condition.outcome, condition.id).toBe('unknown');
    }
    expect(result.unchecked.length).toBe(EXPECTED_UNCHECKED_IDS.length);
    expect(result.verdict).toBe('CAUTION');
    expect((report(allPass(), { unchecked: [] }) as Report).verdict).toBe('GO');
  });

  it('never reports a native harness state it did not measure', async () => {
    const { report } = await load('preflight.mjs');
    const result = report(allPass()) as Report;
    const named = [
      ...Object.values(result.checks).map((c) => c.id),
      ...result.uncheckedConditions.map((c) => c.id),
    ];
    for (const id of NATIVE_STATE_IDS) {
      expect(named, id).not.toContain(id);
      expect(result.rendered, id).not.toContain(id);
    }
  });

  it('takes the verdict from the contract: every required check stops on its own, an advisory fail only cautions', async () => {
    const { verdictOf } = await load('preflight.mjs');
    for (const key of Object.keys(EXPECTED_CHECK_IDS)) {
      const expected = key === 'defaultBranchFresh' ? 'CAUTION' : 'STOP';
      expect(verdictOf({ ...allPass(), [key]: { ok: false } }), key).toBe(expected);
    }
    expect(verdictOf(allPass())).toBe('GO');
  });
});

describe('preflight refuses an unattended flag already on disk for this checkout (RP-281)', () => {
  // One temp dir per case, removed by its exact path; the flag is written under
  // a fake HOME only — never into the real one.
  const withHome = async (fn: (home: string, root: string) => Promise<void>) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rp281-flag-'));
    const home = path.join(dir, 'home');
    const root = path.join(dir, 'checkout');
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await mkdir(root, { recursive: true });
    try {
      await fn(home, root);
    } finally {
      await removeFixture(dir);
    }
  };

  // The env-derived home is the first candidate the flag module names.
  const flagPath = async (home: string, root: string) => {
    const { unattendedFlags } = await load('unattended-flag.mjs');
    return (
      unattendedFlags({ ...process.env, HOME: home, CLAUDE_PROJECT_DIR: root }) as string[]
    )[0]!;
  };

  it('passes when no flag is armed for this checkout', async () => {
    const { checkUnattendedFlag } = await load('preflight.mjs');
    await withHome(async (home, root) => {
      expect(checkUnattendedFlag(root, { ...process.env, HOME: home })).toMatchObject({ ok: true });
    });
  });

  it('stops on a flag a previous run left armed, naming its item', async () => {
    const { checkUnattendedFlag, report } = await load('preflight.mjs');
    await withHome(async (home, root) => {
      await writeFile(await flagPath(home, root), JSON.stringify({ item: 'RP-9999', allow: [] }));
      const check = checkUnattendedFlag(root, { ...process.env, HOME: home }) as Check;
      expect(check.ok).toBe(false);
      expect(check.detail).toMatch(/RP-9999/);
      const result = report({ ...allPass(), unattendedFlag: check }) as Report;
      expect(result.checks.unattendedFlag?.id).toBe('unattended-flag-stale');
      expect(result.verdict).toBe('STOP');
    });
  });

  it('stops on a flag that is on disk but unreadable, saying why', async () => {
    const { checkUnattendedFlag } = await load('preflight.mjs');
    await withHome(async (home, root) => {
      await writeFile(await flagPath(home, root), 'not json');
      const check = checkUnattendedFlag(root, { ...process.env, HOME: home }) as Check;
      expect(check.ok).toBe(false);
      expect(check.detail).toMatch(/unreadable/);
      expect(check.detail).toMatch(/not valid JSON/);
    });
  });

  it('is one of the items the script walks: --json carries it with its id and the run stops', async () => {
    const projectRoot = path.join(scriptsDir, '..', '..');
    await withHome(async (home) => {
      await writeFile(
        await flagPath(home, projectRoot),
        JSON.stringify({ item: 'RP-9999', allow: [] }),
      );
      const stdout = await new Promise<string>((resolve) =>
        execFile(
          process.execPath,
          [path.join(scriptsDir, 'preflight.mjs'), '--json'],
          { cwd: repoRoot, env: { ...process.env, HOME: home } },
          (_error, out) => resolve(out),
        ),
      );
      const parsed = JSON.parse(stdout) as Report;
      expect(parsed.checks.unattendedFlag).toMatchObject({
        ok: false,
        id: 'unattended-flag-stale',
        outcome: 'fail',
      });
      expect(parsed.verdict).toBe('STOP');
    });
  }, 60_000);
});

describe('preflight treats an uninspectable kill-switch path as a failure, never a pass (RP-462)', () => {
  // `existsSync` (what `brakeIsOn` used before RP-462) swallows EACCES into
  // `false` — a STOP file sitting behind a chmod-000 directory reads exactly
  // like no STOP file at all. This reproduces that against `checkKillSwitch`
  // directly, written against the literal expected shape — never derived by
  // calling `brakeIsOn`/`stopFlags` to compute what "should" come out, which
  // is exactly how this bug hid (`.claude/rules/invariants.md`, the
  // independent-oracle invariant).
  //
  // Same platform/root limits as guard-hardening.test.ts's matching RP-462
  // describe: chmod 000 denies nothing on Windows or for root.
  const canChmodDeny = process.platform !== 'win32' && process.getuid?.() !== 0;

  it.skipIf(!canChmodDeny)(
    'reports fail — detail names "cannot be inspected" and the EACCES code — and the verdict is STOP',
    async () => {
      const { checkKillSwitch, report } = await load('preflight.mjs');
      const dir = await mkdtemp(path.join(tmpdir(), 'rp462-preflight-locked-'));
      const locked = path.join(dir, 'locked');
      await mkdir(locked);
      const flag = path.join(locked, 'STOP');
      await writeFile(flag, '');
      await chmod(locked, 0o000);
      const previous = process.env.AGENT_LOOP_STOP;
      process.env.AGENT_LOOP_STOP = flag;
      try {
        const check = (checkKillSwitch as () => Check)();
        expect(check.ok).toBe(false);
        expect(check.detail ?? '').toMatch(/cannot be inspected/);
        expect(check.detail ?? '').toMatch(/EACCES/);
        const result = report({ ...allPass(), killSwitch: check }) as Report;
        expect(result.checks.killSwitch?.outcome).toBe('fail');
        expect(result.verdict).toBe('STOP');
      } finally {
        if (previous === undefined) delete process.env.AGENT_LOOP_STOP;
        else process.env.AGENT_LOOP_STOP = previous;
        // Restore before cleanup, or removing `dir` recursively has to read
        // `locked` to empty it first and fails the same way the bug does.
        await chmod(locked, 0o755);
        await removeFixture(dir);
      }
    },
  );

  it.skipIf(!canChmodDeny)(
    'control: AGENT_LOOP_STOP naming a path that does not exist (ENOENT) stays pass/absent',
    async () => {
      const { checkKillSwitch } = await load('preflight.mjs');
      const dir = await mkdtemp(path.join(tmpdir(), 'rp462-preflight-enoent-'));
      const previous = process.env.AGENT_LOOP_STOP;
      process.env.AGENT_LOOP_STOP = path.join(dir, 'absent-STOP');
      try {
        const check = (checkKillSwitch as () => Check)();
        expect(check.ok).toBe(true);
        expect(check.detail).toBe('absent');
      } finally {
        if (previous === undefined) delete process.env.AGENT_LOOP_STOP;
        else process.env.AGENT_LOOP_STOP = previous;
        await removeFixture(dir);
      }
    },
  );
});
