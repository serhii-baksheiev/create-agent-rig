import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// RP-94. `pr-ship` names owner-directed / hotfix work with no queue item as a
// legitimate path — step 4 tells the fan-out to say "no item" and have the
// reviewer skip the item-contract check openly. Step 1 then made that path
// unexecutable: it called `revalidate.mjs` with an unconditional `--ticket`,
// and the script refused without one. The contradiction was found downstream
// on published 0.7.0 (`gitHead` 6589db36).
//
// The fix is a SECOND explicit mode, never an inferred one and never a skip:
// `--owner-directed` runs the same main-vs-branch drift comparison without a
// tracker, and is refused wherever it could become a way around the claim
// chain.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universal, '.claude', 'scripts');
const revalidateScript = path.join(scriptsDir, 'revalidate.mjs');
const skillPath = path.join(universal, '.claude', 'skills', 'pr-ship', 'SKILL.md');

const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(scriptsDir, 'preflight.mjs')).href
)) as { withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };

const journal = (await import(pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href)) as {
  recordDecision: (input: {
    runDir: string;
    gate: string;
    verdict: string;
    blockers?: Array<{ file: string; rule: string; note: string }>;
    now: string;
  }) => unknown;
  readRun: (input: { runDir: string }) => {
    events: Array<{ kind: string; data: Record<string, unknown> | null }>;
  };
};

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  out: string;
}

const run = (file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Run> =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, env }, (error, stdout, stderr) => {
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        stdout,
        stderr,
        out: stdout + stderr,
      });
    });
  });

const git = async (args: string[], cwd: string): Promise<string> => {
  const result = await run(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
    cwd,
    withoutGitLocation(),
  );
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
  return result.stdout.trim();
};

/**
 * A repository with no queue item and no claim record — the shape owner-directed
 * work actually has. `origin/master` is a real remote-tracking ref, and
 * `moveMain` lands a commit on it through a second clone so the default branch
 * moves without the branch doing anything.
 *
 * Deliberately NOT the `revalidate.test.ts` fixture: that one exists to build a
 * tracked claim baseline, and the absence of one is the condition under test.
 */
interface Fixture {
  clone: string;
  runDir: string;
  env: NodeJS.ProcessEnv;
  moveMain: (files: string[]) => Promise<void>;
}

const fixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'owner-directed-'));
  const origin = path.join(root, 'origin.git');
  const clone = path.join(root, 'clone');
  const other = path.join(root, 'other');
  await mkdir(origin);
  await git(['init', '--bare', '-b', 'master'], origin);
  await git(['clone', '-q', origin, clone], root);
  // 🔴 The seed carries the temp root, so two fixtures are two DIFFERENT
  // repositories. Without it the content, the author and the message were all
  // fixed, so two fixtures built inside the same second produced byte-identical
  // commits — identical shas, identical merge-bases — and the detection-id test
  // below compared a repository with itself while claiming to compare two.
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    await writeFile(path.join(clone, name), `${name} v1 in ${root}\n`);
  }
  await git(['add', '-A'], clone);
  await git(['commit', '-q', '-m', 'seed'], clone);
  await git(['push', '-q', '-u', 'origin', 'master'], clone);
  await git(['checkout', '-q', '-b', 'hotfix/owner-directed'], clone);
  await writeFile(path.join(clone, 'a.txt'), 'a.txt on the branch\n');
  await git(['commit', '-q', '-a', '-m', 'the hotfix touches a.txt'], clone);

  const moveMain = async (files: string[]): Promise<void> => {
    await git(['clone', '-q', origin, other], root).catch(() => '');
    await git(['pull', '-q', 'origin', 'master'], other);
    for (const name of files) {
      await writeFile(path.join(other, name), `${name} moved on main\n`);
    }
    await git(['add', '-A'], other);
    await git(['commit', '-q', '-m', `main touches ${files.join(',')}`], other);
    await git(['push', '-q', 'origin', 'HEAD:master'], other);
    await git(['fetch', '-q', 'origin'], clone);
  };

  const runDir = await mkdtemp(path.join(tmpdir(), 'run-'));
  return { clone, runDir, env: { ...withoutGitLocation(), RIG_RUN_DIR: runDir }, moveMain };
};

const revalidate = (f: Fixture, args: string[]) =>
  run(process.execPath, [revalidateScript, ...args], f.clone, f.env);

const ownerDirected = (f: Fixture, extra: string[] = []) =>
  revalidate(f, ['--point', 'BEFORE_PR', '--owner-directed', '--base', 'origin/master', ...extra]);

interface Result {
  ticket: string | null;
  mode?: string;
  point: string;
  action: 'hold' | 'continue' | 'unverifiable';
  source: string[];
  changed: boolean | null;
  main: { base: string; mergeBase: string; cited: string[]; changed: string[] };
  evidence?: Record<string, unknown>;
}

const jsonOf = async (r: Run): Promise<Result> => {
  expect(r.stdout, r.out).not.toBe('');
  return JSON.parse(r.stdout) as Result;
};

const revalidationEvents = (runDir: string) =>
  journal.readRun({ runDir }).events.filter((e) => e.kind === 'revalidation');

describe('revalidate.mjs — the owner-directed BEFORE_PR mode (RP-94)', () => {
  it('runs BEFORE_PR with no item and no claim when the default branch did not move under the branch', async () => {
    const f = await fixture();
    const r = await ownerDirected(f, ['--json']);
    expect(r.code, r.out).toBe(0);
    const result = await jsonOf(r);
    expect(result.action).toBe('continue');
    expect(result.source).toEqual([]);
    // No fictitious item id is invented for the record.
    expect(result.ticket).toBeNull();
    expect(result.mode).toBe('owner-directed');
  });

  it('journals one explicit revalidation event naming the mode, with no ticket', async () => {
    const f = await fixture();
    expect((await ownerDirected(f)).code).toBe(0);
    const events = revalidationEvents(f.runDir);
    expect(events).toHaveLength(1);
    expect(events[0]?.data?.mode).toBe('owner-directed');
    expect(events[0]?.data?.ticket).toBeNull();
    expect(events[0]?.data?.point).toBe('BEFORE_PR');
  });

  it('HOLDs when the default branch moved under a path the branch touches', async () => {
    const f = await fixture();
    await f.moveMain(['a.txt']);
    const r = await ownerDirected(f, ['--json']);
    expect(r.code, r.out).toBe(2);
    const result = await jsonOf(r);
    expect(result.action).toBe('hold');
    expect(result.source).toEqual(['main:a.txt']);
    expect(result.main.changed).toEqual(['a.txt']);
  });

  it('does not hold when the default branch moved under an unrelated path', async () => {
    const f = await fixture();
    await f.moveMain(['b.txt']);
    const r = await ownerDirected(f, ['--json']);
    expect(r.code, r.out).toBe(0);
    expect((await jsonOf(r)).action).toBe('continue');
  });

  it('HOLDs when the default branch moved under a path a check-premises record cited', async () => {
    const f = await fixture();
    journal.recordDecision({
      runDir: f.runDir,
      gate: 'check-premises',
      verdict: 'HOLD',
      blockers: [{ file: 'c.txt', rule: 'premise', note: 'the hotfix rests on c.txt' }],
      now: '2026-09-02T10:00:00.000Z',
    });
    await f.moveMain(['c.txt']);
    const r = await ownerDirected(f, ['--json']);
    expect(r.code, r.out).toBe(2);
    const result = await jsonOf(r);
    expect(result.source).toEqual(['main:c.txt']);
    expect(result.main.cited).toContain('c.txt');
  });

  it('needs no tracker credentials: an adapter name that cannot resolve is never reached', async () => {
    const f = await fixture();
    const configPath = path.join(f.clone, 'broken-queue.json');
    await writeFile(configPath, JSON.stringify({ adapter: 'no-such-adapter' }));
    const bare = { ...f.env };
    for (const key of ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN']) delete bare[key];
    const r = await run(
      process.execPath,
      [
        revalidateScript,
        '--point',
        'BEFORE_PR',
        '--owner-directed',
        '--base',
        'origin/master',
        '--config',
        configPath,
      ],
      f.clone,
      bare,
    );
    expect(r.code, r.out).toBe(0);
    // The ticketed mode on the same config is the control: it DOES resolve one.
    const ticketed = await run(
      process.execPath,
      [
        revalidateScript,
        '--point',
        'BEFORE_PR',
        '--ticket',
        'RP-1',
        '--base',
        'origin/master',
        '--config',
        configPath,
      ],
      f.clone,
      bare,
    );
    expect(ticketed.code, ticketed.out).toBe(1);
    expect(ticketed.stderr).toMatch(/could not be resolved/);
  });
});

describe('revalidate.mjs — the mode is always explicit (RP-94)', () => {
  it('refuses both modes at once: exit 1, stderr only, nothing journaled', async () => {
    const f = await fixture();
    const r = await revalidate(f, [
      '--point',
      'BEFORE_PR',
      '--ticket',
      'RP-1',
      '--owner-directed',
      '--base',
      'origin/master',
    ]);
    expect(r.code, r.out).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/--ticket/);
    expect(r.stderr).toMatch(/--owner-directed/);
    expect(revalidationEvents(f.runDir)).toHaveLength(0);
  });

  it('refuses neither mode: exit 1, and the message names both ways forward', async () => {
    const f = await fixture();
    const r = await revalidate(f, ['--point', 'BEFORE_PR', '--base', 'origin/master']);
    expect(r.code, r.out).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/--ticket/);
    expect(r.stderr).toMatch(/--owner-directed/);
    expect(revalidationEvents(f.runDir)).toHaveLength(0);
  });

  it('refuses owner-directed at BEFORE_CLOSE — the mode exists for BEFORE_PR only', async () => {
    const f = await fixture();
    const r = await revalidate(f, ['--point', 'BEFORE_CLOSE', '--owner-directed']);
    expect(r.code, r.out).toBe(1);
    expect(r.stdout).toBe('');
    // 🔴 Assert the refusal's OWN message, not just exit 1. A review found the
    // first version of this file asserting only `code === 1` and empty stdout,
    // which several unrelated failures also produce — the test passed with the
    // refusal deleted. Every refusal below names itself.
    expect(r.stderr).toMatch(/BEFORE_PR mode only/);
    expect(r.stderr).toMatch(/BEFORE_CLOSE/);
    expect(revalidationEvents(f.runDir)).toHaveLength(0);
  });
});

describe('revalidate.mjs — owner-directed is never a way around the claim chain (RP-94)', () => {
  // 🔴 THE refusal this mode most needs, and the one the first version of it
  // shipped without. Measured by a reviewer: a ticketed BEFORE_PR that exited 2
  // UNVERIFIABLE latched a `revalidationHold`, and re-running the SAME
  // checkpoint as `--owner-directed` in the same run exited 0 with nothing in
  // the repository changed. Neither other refusal could fire in that state —
  // `takeUps` is never populated at all on the default `plan-md` adapter, and
  // the commonest hold is a MISSING claim record, which is exactly when the
  // branch writes none. This is the end-to-end sequence, not a synthesised
  // state file: the hold is written by the ticketed path itself.
  it('refuses when this run carries an unresolved revalidation hold', async () => {
    const f = await fixture();
    const configPath = path.join(f.clone, 'queue.json');
    await writeFile(configPath, JSON.stringify({ adapter: 'jira', options: { project: 'RP' } }));
    const bare = { ...f.env };
    for (const key of ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN']) delete bare[key];

    const ticketed = await run(
      process.execPath,
      [
        revalidateScript,
        '--point',
        'BEFORE_PR',
        '--ticket',
        'RP-1',
        '--base',
        'origin/master',
        '--config',
        configPath,
      ],
      f.clone,
      bare,
    );
    expect(ticketed.code, ticketed.out).toBe(2);
    const state = JSON.parse(await readFile(path.join(f.runDir, 'state.json'), 'utf8')) as {
      revalidationHold?: { ticket: string; result: string; detectionId: string };
    };
    expect(state.revalidationHold?.result).toBe('UNVERIFIABLE');

    const laundered = await ownerDirected(f);
    expect(laundered.code, laundered.out).toBe(1);
    expect(laundered.stdout).toBe('');
    expect(laundered.stderr).toMatch(/unresolved revalidation hold/);
    expect(laundered.stderr).toMatch(/RP-1/);
    expect(laundered.stderr).toMatch(new RegExp(state.revalidationHold!.detectionId));
    // and the refusal journalled nothing of its own
    expect(revalidationEvents(f.runDir)).toHaveLength(1);
  });

  it('refuses when the declared run already carries a take-up', async () => {
    const f = await fixture();
    await writeFile(
      path.join(f.runDir, 'state.json'),
      JSON.stringify({ takeUps: { 'RP-1': '2026-09-01T00:00:00.000Z' } }),
    );
    const r = await ownerDirected(f);
    expect(r.code, r.out).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/already declares a take-up/);
    expect(r.stderr).toMatch(/RP-1/);
    expect(revalidationEvents(f.runDir)).toHaveLength(0);
  });

  // 🔴 The stop inputs are read FAIL-CLOSED. `readState` — the reader the first
  // version used — swallows every parse failure and answers `{}`, and its own
  // header forbids exactly this use: "a corrupt file there may be hiding a
  // persisted stop". Measured: a truncated state.json carrying a take-up
  // continued.
  it.each([
    ['truncated JSON', '{"takeUps": {"RP-1": "2026-09-01T00:00:00.000Z"'],
    ['not an object at all', '"a string"'],
  ])('refuses a run whose state.json is %s, rather than reading it as empty', async (_l, body) => {
    const f = await fixture();
    await writeFile(path.join(f.runDir, 'state.json'), body);
    const r = await ownerDirected(f);
    expect(r.code, r.out).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/could not be read|not readable/);
    expect(revalidationEvents(f.runDir)).toHaveLength(0);
  });

  // `Object.keys` answers `[]` for both of these, so a permissive read would
  // turn "this cannot be read" into "there is nothing here".
  it.each([
    ['a list', '[]'],
    ['a number', '5'],
  ])('refuses when takeUps is %s rather than an object', async (_label, value) => {
    const f = await fixture();
    await writeFile(path.join(f.runDir, 'state.json'), `{"takeUps": ${value}}`);
    const r = await ownerDirected(f);
    expect(r.code, r.out).toBe(1);
    expect(r.stderr).toMatch(/take-up record is not readable/);
    expect(revalidationEvents(f.runDir)).toHaveLength(0);
  });

  // 🔴 The case `--diff-filter=AM` could not see, measured by a reviewer: git
  // reports `git mv .rig/claims/RP-1.json .rig/claims/RP-2.json` as `R100`, so
  // the AM filter returned NOTHING and a branch demonstrably ending up with a
  // claim record it did not have at the merge base passed the check. Matching
  // the CLASS — "this branch touched the claim store" — is what closes it,
  // rather than enumerating the statuses the class can wear.
  it('refuses when the branch RENAMES a claim record — the case --diff-filter=AM could not see', async () => {
    const f = await fixture();
    await mkdir(path.join(f.clone, '.rig', 'claims'), { recursive: true });
    await writeFile(
      path.join(f.clone, '.rig', 'claims', 'RP-1.json'),
      JSON.stringify({ schemaVersion: 1, ticket: 'RP-1' }),
    );
    await git(['add', '-A'], f.clone);
    await git(['commit', '-q', '-m', 'seed the claim'], f.clone);
    await git(['push', '-q', 'origin', 'HEAD:master'], f.clone);
    await git(['fetch', '-q', 'origin'], f.clone);
    await git(['mv', '.rig/claims/RP-1.json', '.rig/claims/RP-2.json'], f.clone);
    await git(['commit', '-q', '-a', '-m', 'move the claim'], f.clone);
    // the shape that defeated the narrower filter
    expect(await git(['diff', '--name-status', 'origin/master', 'HEAD'], f.clone)).toMatch(/^R/m);
    expect(
      await git(['diff', '--name-only', '--diff-filter=AM', 'origin/master', 'HEAD'], f.clone),
    ).toBe('');
    const r = await ownerDirected(f);
    expect(r.code, r.out).toBe(1);
    expect(r.stderr).toMatch(/touches tracked claim records/);
    expect(r.stderr).toMatch(/RP-2\.json/);
  });

  // A branch that deletes its claim makes the TICKETED call UNVERIFIABLE, so
  // excluding `D` left the deletion on the bypass path rather than out of scope.
  it('refuses when the branch DELETES its claim record', async () => {
    const f = await fixture();
    await mkdir(path.join(f.clone, '.rig', 'claims'), { recursive: true });
    await writeFile(path.join(f.clone, '.rig', 'claims', 'RP-3.json'), '{}');
    await git(['add', '-A'], f.clone);
    await git(['commit', '-q', '-m', 'seed the claim'], f.clone);
    await git(['push', '-q', 'origin', 'HEAD:master'], f.clone);
    await git(['fetch', '-q', 'origin'], f.clone);
    await git(['rm', '-q', '.rig/claims/RP-3.json'], f.clone);
    await git(['commit', '-q', '-m', 'remove the claim'], f.clone);
    const r = await ownerDirected(f);
    expect(r.code, r.out).toBe(1);
    expect(r.stderr).toMatch(/RP-3\.json/);
  });

  // This mode resolves no queue config, so it cannot ask where the rig root is;
  // anchoring the pattern at the repository root alone missed a nested one.
  it('refuses a claim record under a rig root nested below the git root', async () => {
    const f = await fixture();
    await mkdir(path.join(f.clone, 'sub', '.rig', 'claims'), { recursive: true });
    await writeFile(path.join(f.clone, 'sub', '.rig', 'claims', 'RP-9.json'), '{}');
    await git(['add', '-A'], f.clone);
    await git(['commit', '-q', '-m', 'a nested claim record'], f.clone);
    const r = await ownerDirected(f);
    expect(r.code, r.out).toBe(1);
    expect(r.stderr).toMatch(/sub\/\.rig\/claims\/RP-9\.json/);
  });

  it('matches the path claimPathFor actually builds, from the repository root and from a nested rig root', async () => {
    const claims = (await import(
      pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
    )) as { claimPathFor: (root: string, ticket: unknown) => string };
    const source = await readFile(revalidateScript, 'utf8');
    const pattern = source.match(/const CLAIM_RECORD = (\/.*\/);/)?.[1];
    expect(pattern, 'CLAIM_RECORD is no longer declared as a literal').toBeTruthy();
    const claimRecord = new RegExp(pattern!.slice(1, -1));
    // The real builder decides the shape; this test is the correspondence
    // check that keeps the second spelling in step with it.
    for (const root of ['/repo', '/repo/sub']) {
      const built = claims.claimPathFor(root, { id: 'RP-1' }).split(path.sep).join('/');
      const relative = built.slice(built.indexOf('/repo/') + '/repo/'.length);
      expect(claimRecord.test(relative), `${relative} is not matched`).toBe(true);
    }
    expect(claimRecord.test('.rig/claims/RP-1.json')).toBe(true);
    // and it stays narrow: neither a nested subdirectory nor a neighbour
    expect(claimRecord.test('.rig/claims/nested/RP-1.json')).toBe(false);
    expect(claimRecord.test('.rig/revalidation.json')).toBe(false);
  });

  it('refuses when the branch diff adds a tracked claim record', async () => {
    const f = await fixture();
    await mkdir(path.join(f.clone, '.rig', 'claims'), { recursive: true });
    await writeFile(
      path.join(f.clone, '.rig', 'claims', 'RP-1.json'),
      JSON.stringify({ schemaVersion: 1, ticket: 'RP-1' }),
    );
    await git(['add', '.rig/claims/RP-1.json'], f.clone);
    await git(['commit', '-q', '-m', 'a claim record on the branch'], f.clone);
    const r = await ownerDirected(f);
    expect(r.code, r.out).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/\.rig\/claims\/RP-1\.json/);
    expect(revalidationEvents(f.runDir)).toHaveLength(0);
  });

  it('refuses when the branch diff modifies a tracked claim record', async () => {
    const f = await fixture();
    // The record exists on the default branch, so the branch MODIFIES it.
    await mkdir(path.join(f.clone, '.rig', 'claims'), { recursive: true });
    await writeFile(
      path.join(f.clone, '.rig', 'claims', 'RP-2.json'),
      JSON.stringify({ schemaVersion: 1, ticket: 'RP-2' }),
    );
    await git(['add', '.rig/claims/RP-2.json'], f.clone);
    await git(['commit', '-q', '-m', 'seed the claim'], f.clone);
    await git(['push', '-q', 'origin', 'HEAD:master'], f.clone);
    await git(['fetch', '-q', 'origin'], f.clone);
    await writeFile(
      path.join(f.clone, '.rig', 'claims', 'RP-2.json'),
      JSON.stringify({ schemaVersion: 1, ticket: 'RP-2', tampered: true }),
    );
    await git(['commit', '-q', '-a', '-m', 'rewrite the claim'], f.clone);
    const r = await ownerDirected(f);
    expect(r.code, r.out).toBe(1);
    expect(r.stderr).toMatch(/\.rig\/claims\/RP-2\.json/);
  });

  it('leaves the ticketed mode exactly as it was: a missing claim is UNVERIFIABLE and holds', async () => {
    const f = await fixture();
    const configPath = path.join(f.clone, 'queue.json');
    await writeFile(
      configPath,
      JSON.stringify({
        adapter: 'jira',
        options: {
          project: 'RP',
          issues: [
            {
              key: 'RP-1',
              fields: {
                summary: 'an item',
                status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
                labels: ['in-progress'],
                priority: null,
                created: '2026-07-01T00:00:00.000+0000',
                updated: '2026-07-01T00:00:00.000+0000',
                issuelinks: [],
              },
            },
          ],
        },
      }),
    );
    const r = await revalidate(f, [
      '--point',
      'BEFORE_PR',
      '--ticket',
      'RP-1',
      '--base',
      'origin/master',
      '--config',
      configPath,
      '--json',
    ]);
    expect(r.code, r.out).toBe(2);
    const result = await jsonOf(r);
    expect(result.action).toBe('unverifiable');
    expect(result.ticket).toBe('RP-1');
  });
});

describe('revalidate.mjs — an owner-directed HOLD can be answered (RP-94)', () => {
  // 🔴 Without this the skill's stated exit-2 remedy was a command the script
  // refused — the same shape of contradiction RP-94 exists to remove. The
  // detection carries `ticket: null`, so the outcome addresses it by MODE.
  it('answers an owner-directed hold with an owner-directed outcome', async () => {
    const f = await fixture();
    await f.moveMain(['a.txt']);
    const held = await ownerDirected(f, ['--json']);
    expect(held.code, held.out).toBe(2);
    const detection = await jsonOf(held);

    const outcome = await revalidate(f, [
      'outcome',
      '--point',
      'BEFORE_PR',
      '--owner-directed',
      '--action-changed',
      'false',
      '--note',
      'main moved on a.txt, the hotfix is unaffected',
      '--json',
    ]);
    expect(outcome.code, outcome.out).toBe(0);
    const record = JSON.parse(outcome.stdout) as {
      data: { detectionId: string; ticket: string | null; mode?: string; actionRequired: boolean };
    };
    // It answers THAT detection, and invents no id for the record either.
    expect(record.data.detectionId).toBe((detection as unknown as { id: string }).id);
    expect(record.data.ticket).toBeNull();
    expect(record.data.mode).toBe('owner-directed');
    expect(record.data.actionRequired).toBe(false);
  });

  // The detection id must not be a constant. `revalidation-report.mjs` indexes
  // typed resolutions across EVERY run, so an id depending only on the mode,
  // the point and the drifted paths would let one `--action-changed false`
  // recorded long ago mark a later, genuine hold as already answered.
  //
  // ⚠ What this buys, stated exactly rather than overclaimed: the id separates
  // different points of history, because `mergeBase` is in it. It does NOT make
  // one hold unique per run — the same branch at the same merge base with the
  // same drift is deliberately the same id, which is what lets an outcome
  // answer a retry of the same checkpoint. That is the tradeoff
  // `answerUnverifiable`'s identity already makes, and the test below pins both
  // halves of it.
  it('gives two different branch states two different detection ids', async () => {
    const first = await fixture();
    await first.moveMain(['a.txt']);
    const a = await jsonOf(await ownerDirected(first, ['--json']));

    const second = await fixture();
    await second.moveMain(['a.txt']);
    const b = await jsonOf(await ownerDirected(second, ['--json']));

    // same mode, same point, same `source` — and still distinguishable
    expect(a.source).toEqual(b.source);
    expect((a as unknown as { id: string }).id).not.toBe((b as unknown as { id: string }).id);
  });

  it('gives the same branch state the same id on a retry, so one outcome answers the retry too', async () => {
    const f = await fixture();
    await f.moveMain(['a.txt']);
    const once = await jsonOf(await ownerDirected(f, ['--json']));
    const twice = await jsonOf(await ownerDirected(f, ['--json']));
    expect((once as unknown as { id: string }).id).toBe((twice as unknown as { id: string }).id);
  });

  it('refuses a ticketed outcome aimed at an owner-directed detection', async () => {
    const f = await fixture();
    await f.moveMain(['a.txt']);
    expect((await ownerDirected(f)).code).toBe(2);
    const r = await revalidate(f, [
      'outcome',
      '--point',
      'BEFORE_PR',
      '--ticket',
      'null',
      '--action-changed',
      'false',
    ]);
    expect(r.code, r.out).toBe(1);
    expect(r.stderr).toMatch(/no revalidation of null at BEFORE_PR/);
  });

  // 🔴 The mutation this pins: `e.data?.mode === OWNER_DIRECTED` → `true` in
  // the outcome match. The suite was green under it, because the positive test
  // has only one detection in the run, the cross-match test exercises the other
  // arm, and the empty-run refusal below refuses either way. What the mutation
  // buys is the round-1 bypass coming back through the door opened to fix the
  // round-1 prose contradiction: an owner-directed outcome would match the
  // TICKETED detection and hand its id to `clearRevalidationHold`, releasing
  // the latch the hold refusal exists to hold shut.
  //
  // The second assertion is the one that matters. Asserting the message alone
  // would go green again the day somebody rewords it; asserting that the hold
  // is STILL THERE is about the consequence.
  it('refuses an owner-directed outcome when a ticketed hold is the only one this run carries — and leaves that hold latched', async () => {
    const f = await fixture();
    const configPath = path.join(f.clone, 'queue.json');
    await writeFile(configPath, JSON.stringify({ adapter: 'jira', options: { project: 'RP' } }));
    const bare = { ...f.env };
    for (const key of ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN']) delete bare[key];
    const ticketed = await run(
      process.execPath,
      [
        revalidateScript,
        '--point',
        'BEFORE_PR',
        '--ticket',
        'RP-1',
        '--base',
        'origin/master',
        '--config',
        configPath,
      ],
      f.clone,
      bare,
    );
    expect(ticketed.code, ticketed.out).toBe(2);
    const holdBefore = (
      JSON.parse(await readFile(path.join(f.runDir, 'state.json'), 'utf8')) as {
        revalidationHold: { detectionId: string };
      }
    ).revalidationHold;
    expect(holdBefore.detectionId).toBeTruthy();

    const r = await revalidate(f, [
      'outcome',
      '--point',
      'BEFORE_PR',
      '--owner-directed',
      '--action-changed',
      'false',
    ]);
    expect(r.code, r.out).toBe(1);
    expect(r.stderr).toMatch(/no revalidation of owner-directed work at BEFORE_PR/);
    // 🔴 the consequence: the ticketed hold is untouched
    const holdAfter = (
      JSON.parse(await readFile(path.join(f.runDir, 'state.json'), 'utf8')) as {
        revalidationHold?: { detectionId: string };
      }
    ).revalidationHold;
    expect(holdAfter?.detectionId).toBe(holdBefore.detectionId);
  });

  it('refuses an owner-directed outcome when this run holds no owner-directed detection', async () => {
    const f = await fixture();
    const r = await revalidate(f, [
      'outcome',
      '--point',
      'BEFORE_PR',
      '--owner-directed',
      '--action-changed',
      'false',
    ]);
    expect(r.code, r.out).toBe(1);
    expect(r.stderr).toMatch(/no revalidation of owner-directed work at BEFORE_PR/);
  });
});

describe('revalidate.mjs — an undeclared run says what it could not check (RP-94)', () => {
  // 🔴 With no RIG_RUN_DIR the hold and take-up refusals have nothing to read.
  // That is inherent; reading as though they had passed is not. "Could not
  // check" is reported as itself, on stdout and in the record.
  it('says out loud that an undeclared run checked neither the hold nor the take-up', async () => {
    const f = await fixture();
    const noRun = { ...f.env };
    delete noRun.RIG_RUN_DIR;
    const r = await run(
      process.execPath,
      [revalidateScript, '--point', 'BEFORE_PR', '--owner-directed', '--base', 'origin/master'],
      f.clone,
      noRun,
    );
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toMatch(/no RIG_RUN_DIR/);
    expect(r.stdout).toMatch(/were NOT checked/);
    // and nothing was journalled into the run that was never declared
    expect(revalidationEvents(f.runDir)).toHaveLength(0);
  });

  it('records the same thing in evidence.runState, both ways round', async () => {
    const f = await fixture();
    const declared = await jsonOf(await ownerDirected(f, ['--json']));
    expect(declared.evidence?.runState).toMatch(/read fail-closed/);

    const noRun = { ...f.env };
    delete noRun.RIG_RUN_DIR;
    const undeclaredRun = await run(
      process.execPath,
      [
        revalidateScript,
        '--point',
        'BEFORE_PR',
        '--owner-directed',
        '--base',
        'origin/master',
        '--json',
      ],
      f.clone,
      noRun,
    );
    const undeclared = JSON.parse(
      undeclaredRun.stdout.slice(undeclaredRun.stdout.indexOf('{')),
    ) as Result;
    expect(undeclared.evidence?.runState).toMatch(/NOT read/);
  });
});

describe('pr-ship states both BEFORE_PR paths, and skips neither (RP-94)', () => {
  const surfaces = [
    ['universal (canonical)', skillPath],
    ['the synced Claude tree', path.join(repoRoot, '.claude', 'skills', 'pr-ship', 'SKILL.md')],
    ['the Codex projection', path.join(repoRoot, '.agents', 'skills', 'pr-ship', 'SKILL.md')],
    [
      'the templates Codex projection',
      path.join(universal, '.agents', 'skills', 'pr-ship', 'SKILL.md'),
    ],
  ] as const;

  it.each(surfaces)('%s carries the owner-directed BEFORE_PR call', async (_label, file) => {
    const text = await readFile(file, 'utf8');
    expect(text).toMatch(/revalidate\.mjs --point BEFORE_PR --ticket <item-id>/);
    expect(text).toMatch(/revalidate\.mjs --point BEFORE_PR --owner-directed/);
  });

  it('every surface carries the same BEFORE_PR step, byte for byte', async () => {
    const texts = await Promise.all(surfaces.map(([, file]) => readFile(file, 'utf8')));
    const stepOf = (text: string) => {
      const start = text.indexOf('--point BEFORE_PR --ticket');
      const end = text.indexOf('--point BEFORE_PR --owner-directed');
      expect(start, 'the ticketed call is missing').toBeGreaterThan(-1);
      expect(end, 'the owner-directed call is missing').toBeGreaterThan(-1);
      return text.slice(Math.min(start, end), Math.max(start, end) + 200);
    };
    const [first, ...rest] = texts.map(stepOf);
    for (const other of rest) expect(other).toBe(first);
  });

  // 🔴 The mutation this pins: "owner-directed work simply skips BEFORE_PR".
  // That is the cheap fix the ticket forbids, and prose is where it would be
  // written. A skill that tells a run to skip the checkpoint fails here.
  it('never offers skipping BEFORE_PR as the answer for work with no item', async () => {
    const text = await readFile(skillPath, 'utf8');
    expect(text).not.toMatch(/skip (?:the )?(?:step 1|BEFORE_PR|revalidation)/i);
    expect(text).not.toMatch(/BEFORE_PR (?:is|can be) skipped/i);
  });

  // The fan-out consequence stays exactly one check wide.
  it('says the fan-out is told `no item — owner-directed`, and only that check is skipped', async () => {
    const text = await readFile(skillPath, 'utf8');
    expect(text).toMatch(/no item — owner-directed/);
    // `\s+`, not a literal space: markdown wraps, and a term split across two
    // lines is the same term. Nothing about the claim is weakened by it.
    expect(text).toMatch(/item-contract\s+check/);
  });
});
