import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { jiraReadback } from './tdd-tracker-fixture.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const checkRun = path.join(scriptsDir, 'check-run.mjs');
const tddEvidence = path.join(scriptsDir, 'tdd-evidence.mjs');
const vitestCli = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');

type Result = { code: number; out: string; stderr: string; stdout: string };

const run = (file: string, args: string[], cwd: string, env = process.env): Promise<Result> =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, env }, (error, stdout, stderr) => {
      const out = stdout + stderr;
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        out,
        stderr,
        stdout,
      });
    });
  });

const git = async (args: string[], root: string, { date }: { date?: string } = {}) => {
  // `date`, when given, pins GIT_AUTHOR_DATE/GIT_COMMITTER_DATE for this one
  // git invocation so the resulting commit is byte-identical across runs
  // that write identical content. Omitting it (the default) leaves every
  // other call in this file on today's behavior: the system clock.
  const env = date
    ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
    : process.env;
  const result = await run(
    'git',
    ['-c', 'user.email=rp375@example.invalid', '-c', 'user.name=rp375', ...args],
    root,
    env,
  );
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stdout}${result.stderr}`);
  }
  return result.stdout.trim();
};

const runVitest = ({
  root,
  runDir,
  name,
  trackerEnv,
}: {
  root: string;
  runDir: string;
  name: string;
  trackerEnv: NodeJS.ProcessEnv;
}) => {
  const resultName = `${name}.json`;
  return run(
    process.execPath,
    [
      checkRun,
      '--name',
      name,
      '--vitest-json',
      resultName,
      '--',
      process.execPath,
      vitestCli,
      'run',
      '--pool=threads',
      '--maxWorkers=1',
      '--root',
      root,
      '--config',
      path.join(root, 'vitest.config.mjs'),
      '--reporter=json',
      '--outputFile',
      path.join(runDir, resultName),
    ],
    root,
    { ...trackerEnv, RIG_RUN_DIR: runDir },
  );
};

const record = ({
  root,
  runDir,
  action,
  check,
  trackerEnv,
}: {
  root: string;
  runDir: string;
  action: 'record-red' | 'record-green';
  check: string;
  trackerEnv: NodeJS.ProcessEnv;
}) =>
  run(process.execPath, [tddEvidence, action, '--ticket', 'RP-375', '--check', check], root, {
    ...trackerEnv,
    RIG_RUN_DIR: runDir,
  });

const contract = {
  schemaVersion: 1,
  detection: {
    mode: 'pull',
    sources: ['run-state', 'journal'],
    acceptedLatency: '24h',
    push: false,
  },
  pairedFacts: [],
};

const featureTest =
  "import { feature } from '../src/feature.ts';\n\nit('returns new', () => expect(feature()).toBe('new'));\n";
const initialFeature = 'export const feature = () => "old";\n';
const initialImplementation = 'export const feature = (value = "new") => value;\n';
const refinedImplementation = 'export const feature = (value = "new") => value.trim();\n';
// RP-370 review round 1 (B2): a third, independent production boundary used
// by "keeps refining after a refinement returns to an earlier boundary" to
// move PAST a boundary the chain already visited once (A -> B -> A -> C).
const thirdRefinedImplementation =
  'export const feature = (value = "new") => value.trim().toString();\n';

const claimBytes = (root: string) => readFile(path.join(root, '.rig', 'claims', 'RP-375.json'));

// Fixed so two independent fixture repos that write identical content select
// a byte-identical B0 commit (see "keeps a later correction boundary
// relative to the validated merged default" below, which anchors its
// anti-replay binding at B0 and needs that commit to be reproducible, not
// just content-equal, across both of its scenario runs).
const FIXED_B0_COMMIT_DATE = '2020-01-01T00:00:00+00:00';

const setupInitialGreen = async ({
  commitInitialImplementation = true,
  commitDate,
  defaultBranch = 'master',
  useOrigin = true,
}: {
  commitInitialImplementation?: boolean;
  commitDate?: string;
  // RP-370 review round 1 (B1): the fixture's bare origin publishes under this
  // branch name, so a non-'master' default (e.g. 'main') is reachable without
  // rewriting every call site below.
  defaultBranch?: string;
  // RP-370 review round 1 (B1): when false, the fixture never configures an
  // 'origin' remote at all — the local repository is the whole story, which is
  // the "no remote configured" shape `liveDefaultTargetSha` must also handle.
  useOrigin?: boolean;
} = {}) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rp375-same-baseline-'));
  const runDir = await mkdtemp(path.join(tmpdir(), 'rp375-same-baseline-run-'));
  const remote = await mkdtemp(path.join(tmpdir(), 'rp375-same-baseline-remote-'));
  await Promise.all([
    mkdir(path.join(root, '.rig'), { recursive: true }),
    mkdir(path.join(root, 'src'), { recursive: true }),
    mkdir(path.join(root, 'test'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, '.rig', 'revalidation.json'), `${JSON.stringify(contract)}\n`),
    writeFile(path.join(root, 'src', 'feature.ts'), initialFeature),
    writeFile(path.join(root, 'test', 'feature.test.ts'), featureTest),
    writeFile(
      path.join(root, 'vitest.config.mjs'),
      "export default { test: { include: ['test/**/*.test.ts'], globals: true } };\n",
    ),
  ]);
  await git(['init', '-q', '-b', defaultBranch], root);
  await git(['config', 'core.autocrlf', 'true'], root);
  if (useOrigin) {
    await git(['init', '--bare', '-q', remote], root);
    // Pin the bare origin's HEAD to the branch this fixture actually
    // publishes under: a bare `init` otherwise follows `init.defaultBranch`,
    // which may not agree with `defaultBranch` above and would leave a clone
    // of `remote` checked out on the wrong (or an unborn) branch.
    await git(['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`], remote);
    await git(['remote', 'add', 'origin', remote], root);
  }
  await git(
    [
      'add',
      '.rig/revalidation.json',
      'src/feature.ts',
      'test/feature.test.ts',
      'vitest.config.mjs',
    ],
    root,
  );
  await git(['commit', '-q', '-m', 'B0 selected baseline'], root, { date: commitDate });
  const baseline = await git(['rev-parse', 'HEAD'], root);
  let defaultClone = '';
  if (useOrigin) {
    await git(['push', '-q', 'origin', defaultBranch], root);
    await git(['fetch', '-q', 'origin'], root);
  }
  await git(['checkout', '-q', '-b', 'feat/RP-375'], root);
  if (useOrigin) {
    defaultClone = await mkdtemp(path.join(tmpdir(), 'rp375-same-baseline-default-'));
    await git(['clone', '-q', remote, defaultClone], root);
  }

  const claims = (await import(
    pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
  )) as {
    revalidateClaim: (input: Record<string, unknown>) => { result: string };
    recordClaimTransition: (input: Record<string, unknown>) => unknown;
  };
  const ticket = {
    id: 'RP-375',
    state: 'open' as const,
    title: 'same-baseline refinement',
    body: 'rig:tdd-spec/v1 {"file":"test/feature.test.ts","fullName":"returns new"}',
    labels: [],
    blockedBy: [],
    blocks: [],
  };
  const trackerEnv = await jiraReadback({ projectRoot: root, ticket });
  expect(
    claims.revalidateClaim({
      projectRoot: root,
      ticket,
      point: 'SELECT',
      targetSha: baseline,
      allowCreate: true,
    }).result,
  ).toBe('BASELINE_CREATED');
  claims.recordClaimTransition({
    projectRoot: root,
    ticket: { ...ticket, state: 'in-progress' },
    claimedState: 'in-progress',
  });

  const red = await runVitest({ root, runDir, name: 'unit-red-initial', trackerEnv });
  expect(red.code, red.out).toBe(1);
  expect(
    (await record({ root, runDir, action: 'record-red', check: 'unit-red-initial', trackerEnv }))
      .code,
  ).toBe(0);

  await writeFile(path.join(root, 'src', 'feature.ts'), initialImplementation);
  if (commitInitialImplementation) {
    await git(['add', 'src/feature.ts'], root);
    await git(['commit', '-q', '-m', 'F1 initial owned implementation'], root);
  }
  const firstGreen = await runVitest({ root, runDir, name: 'unit-green-initial', trackerEnv });
  expect(firstGreen.code, firstGreen.out).toBe(0);
  expect(
    (
      await record({
        root,
        runDir,
        action: 'record-green',
        check: 'unit-green-initial',
        trackerEnv,
      })
    ).code,
  ).toBe(0);
  const initialClaim = JSON.parse((await claimBytes(root)).toString('utf8'));
  if (commitInitialImplementation) {
    await git(['add', '.rig/claims/RP-375.json'], root);
    await git(['commit', '-q', '-m', 'record initial GREEN'], root);
  }
  return { baseline, defaultClone, initialClaim, remote, root, runDir, trackerEnv };
};

const refineSource = async (root: string, { commit = true } = {}) => {
  await writeFile(path.join(root, 'src', 'feature.ts'), refinedImplementation);
  if (commit) {
    await git(['add', 'src/feature.ts'], root);
    await git(['commit', '-q', '-m', 'F2 trim correction after GREEN'], root);
  }
};

const advanceRemoteDefault = async ({
  defaultClone,
  remote,
  root,
  fetch,
  foreignContent = 'export const foreignDefault = true;\n',
  defaultBranch = 'master',
}: {
  defaultClone: string;
  remote: string;
  root: string;
  fetch: boolean;
  foreignContent?: string;
  // RP-370 review round 1 (B1): advance the branch the fixture actually
  // publishes as its default under, not a hardcoded 'master'.
  defaultBranch?: string;
}) => {
  await writeFile(path.join(defaultClone, 'src', 'foreign-default.ts'), foreignContent);
  await git(['add', 'src/foreign-default.ts'], defaultClone);
  await git(['commit', '-q', '-m', 'M1 foreign default production'], defaultClone);
  const advanced = await git(['rev-parse', 'HEAD'], defaultClone);
  await git(['push', '-q', 'origin', defaultBranch], defaultClone);
  expect(await git(['ls-remote', remote, `refs/heads/${defaultBranch}`], root)).toContain(advanced);
  if (fetch) await git(['fetch', '-q', 'origin'], root);
  return {
    advanced,
    cached: await git(['rev-parse', `refs/remotes/origin/${defaultBranch}`], root),
    defaultClone,
  };
};

it('refuses a normal owned-looking tip that hides an earlier committed production interval', async () => {
  const fixture = await setupInitialGreen();
  const { root, runDir, trackerEnv } = fixture;
  await writeFile(
    path.join(root, 'src', 'foreign-interval.ts'),
    'export const foreignInterval = true;\n',
  );
  await git(['add', 'src/foreign-interval.ts'], root);
  await git(['commit', '-q', '-m', 'foreign committed production interval'], root);
  await refineSource(root);
  const check = 'unit-green-refined-after-foreign-interval';
  expect((await runVitest({ root, runDir, name: check, trackerEnv })).code).toBe(0);
  const before = await claimBytes(root);
  const recorded = await record({ root, runDir, action: 'record-green', check, trackerEnv });
  expect(recorded.code, recorded.out).toBe(1);
  expect(await claimBytes(root)).toEqual(before);
});

it('refuses a stale M1 direct import when live origin master has advanced to M2', async () => {
  const fixture = await setupInitialGreen();
  const { defaultClone, remote, root, runDir, trackerEnv } = fixture;
  const first = await advanceRemoteDefault({ defaultClone, remote, root, fetch: true });
  await git(['merge', '--no-ff', '-q', 'origin/master', '-m', 'merge cached M1'], root);
  await writeFile(
    path.join(defaultClone, 'src', 'foreign-default-m2.ts'),
    'export const foreignDefaultM2 = true;\n',
  );
  await git(['add', 'src/foreign-default-m2.ts'], defaultClone);
  await git(['commit', '-q', '-m', 'M2 live default advance'], defaultClone);
  const liveM2 = await git(['rev-parse', 'HEAD'], defaultClone);
  await git(['push', '-q', 'origin', 'master'], defaultClone);
  expect(await git(['ls-remote', remote, 'refs/heads/master'], root)).toContain(liveM2);
  expect(await git(['rev-parse', 'origin/master'], root)).toBe(first.advanced);
  const check = 'unit-green-stale-m1-direct-import-live-m2';
  expect((await runVitest({ root, runDir, name: check, trackerEnv })).code).toBe(0);
  const before = await claimBytes(root);
  const recorded = await record({ root, runDir, action: 'record-green', check, trackerEnv });
  expect(recorded.code, recorded.out).toBe(1);
  expect(await claimBytes(root)).toEqual(before);
});

it('refuses a reset to the selected baseline after a validated merged-default import', async () => {
  const fixture = await setupInitialGreen();
  const { defaultClone, remote, root, runDir, trackerEnv } = fixture;
  const imported = await advanceRemoteDefault({ defaultClone, remote, root, fetch: true });
  await git(['merge', '--no-ff', '-q', 'origin/master', '-m', 'merge validated M1'], root);
  const refreshCheck = 'unit-green-validated-m1-import';
  expect((await runVitest({ root, runDir, name: refreshCheck, trackerEnv })).code).toBe(0);
  expect(
    (await record({ root, runDir, action: 'record-green', check: refreshCheck, trackerEnv })).code,
  ).toBe(0);
  await git(['add', '.rig/claims/RP-375.json'], root);
  await git(['commit', '-q', '-m', 'track validated M1 import'], root);
  expect(await git(['rev-parse', 'origin/master'], root)).toBe(imported.advanced);

  await git(['reset', '--mixed', fixture.baseline], root);
  await refineSource(root, { commit: false });
  const check = 'unit-green-reset-after-validated-m1';
  expect((await runVitest({ root, runDir, name: check, trackerEnv })).code).toBe(0);
  const before = await claimBytes(root);
  const recorded = await record({ root, runDir, action: 'record-green', check, trackerEnv });
  expect(recorded.code, recorded.out).toBe(1);
  expect(await claimBytes(root)).toEqual(before);
});

it.each([['committed', true] as const, ['uncommitted', false] as const])(
  'keeps a later correction boundary relative to the validated merged default (%s correction)',
  async (_variant, commitCorrection) => {
    // Cold review of 89feb8c, round 3: the refreshed implementation-delta
    // fingerprint for a later same-baseline correction must be anchored at the
    // validated merged-default tip (M1), never back at the selected baseline
    // (B0) — a foreign production change that M1 already merged is not the
    // item's own delta. This is an independent oracle: it never recomputes the
    // fingerprint itself. It runs the identical scenario twice, varying only the
    // CONTENT of the foreign file M1 merges, and asserts the item's own
    // recorded implementationDeltaFingerprint is byte-identical across both
    // runs. Anchored at M1 the differing foreign content cannot reach the
    // fingerprint; anchored at B0 (the defect) it would, because the diff from
    // B0 still contains the foreign file. Both a committed and an uncommitted
    // correction are exercised: the uncommitted one reaches the fingerprint
    // comparison even on a producer that anchors at B0, so the anchor itself is
    // what this case pins.
    const performScenario = async (foreignContent: string) => {
      const fixture = await setupInitialGreen({ commitDate: FIXED_B0_COMMIT_DATE });
      const { baseline, root, runDir, trackerEnv } = fixture;
      const imported = await advanceRemoteDefault({ ...fixture, fetch: true, foreignContent });
      await git(['merge', '--no-ff', '-q', 'origin/master', '-m', 'merge validated M1'], root);
      const refreshCheck = 'unit-green-refresh-before-later-correction';
      expect((await runVitest({ root, runDir, name: refreshCheck, trackerEnv })).code).toBe(0);
      expect(
        (await record({ root, runDir, action: 'record-green', check: refreshCheck, trackerEnv }))
          .code,
      ).toBe(0);
      await git(['add', '.rig/claims/RP-375.json'], root);
      await git(['commit', '-q', '-m', 'record validated M1 refresh'], root);
      expect(await git(['rev-parse', 'origin/master'], root)).toBe(imported.advanced);

      await refineSource(root, { commit: commitCorrection });
      const correctionCheck = 'unit-green-later-correction-relative-to-m1';
      expect((await runVitest({ root, runDir, name: correctionCheck, trackerEnv })).code).toBe(0);
      const recorded = await record({
        root,
        runDir,
        action: 'record-green',
        check: correctionCheck,
        trackerEnv,
      });
      expect(recorded.code, recorded.out).toBe(0);
      await git(['add', '.rig/claims/RP-375.json', 'src/feature.ts'], root);
      await git(['commit', '-q', '-m', 'record same-baseline correction after M1 refresh'], root);

      const claim = JSON.parse((await claimBytes(root)).toString('utf8'));
      return { baseline, claim, imported, root, runDir, trackerEnv };
    };

    // The two fixtures are independent repos, so they run concurrently: the
    // case's work is two scenarios, its wall time one.
    const [first, second] = await Promise.all([
      performScenario('export const foreignDefault = "variant-one";\n'),
      performScenario(
        'export const foreignDefault = "a very different and much longer variant two payload";\n',
      ),
    ]);

    // Precondition for the oracle below: both runs must have selected a
    // byte-identical B0. Without this, the fingerprint-equality assertion
    // could never pass even when the production code anchors correctly
    // (vacuous failure), and if it ever started passing by accident (e.g. the
    // fixture stopped varying B0's inputs at all) it would say nothing about
    // the anchor. FIXED_B0_COMMIT_DATE is what makes this hold.
    expect(first.baseline).toEqual(second.baseline);
    // And the two runs' M1 merges must genuinely differ in content, or the
    // fingerprint-equality assertion below would be trivially true no matter
    // where the implementation anchors.
    expect(first.imported.advanced).not.toEqual(second.imported.advanced);

    expect(first.claim.tddEvidenceHistory).toHaveLength(2);
    expect(first.claim.tddEvidenceHistory[1].transition.sameBaselineRefinement).toBe(true);
    expect(second.claim.tddEvidenceHistory).toHaveLength(2);
    expect(second.claim.tddEvidenceHistory[1].transition.sameBaselineRefinement).toBe(true);
    expect(first.claim.tddEvidence.implementationBoundary.implementationDeltaFingerprint).toEqual(
      second.claim.tddEvidence.implementationBoundary.implementationDeltaFingerprint,
    );

    const verificationRunDir = await mkdtemp(
      path.join(tmpdir(), 'rp375-refinement-authority-ship-'),
    );
    const ship = await run(
      process.execPath,
      [tddEvidence, 'verify-ship', '--ticket', 'RP-375', '--base', first.imported.advanced],
      first.root,
      { ...first.trackerEnv, RIG_RUN_DIR: verificationRunDir },
    );
    expect(ship.code, ship.out).toBe(0);
  },
);

// RP-370 review round 1 (B1): `liveDefaultTargetSha` only ever asks origin
// about `refs/heads/master`, but every TDD-2 re-GREEN (both a same-baseline
// refinement and a merged-default refresh) calls it unconditionally. A rig
// whose origin default branch is `main` must still be able to record a
// GREEN after importing a foreign advance of that default.
it("records a merged-default refresh when origin's default branch is main", async () => {
  const fixture = await setupInitialGreen({ defaultBranch: 'main' });
  const { defaultClone, remote, root, runDir, trackerEnv } = fixture;
  const imported = await advanceRemoteDefault({
    defaultClone,
    remote,
    root,
    fetch: true,
    defaultBranch: 'main',
  });
  await git(['merge', '--no-ff', '-q', 'origin/main', '-m', 'merge foreign main default'], root);
  expect(await git(['rev-parse', 'origin/main'], root)).toBe(imported.advanced);
  const check = 'unit-green-main-default-refresh';
  expect((await runVitest({ root, runDir, name: check, trackerEnv })).code).toBe(0);
  const recorded = await record({ root, runDir, action: 'record-green', check, trackerEnv });
  expect(recorded.code, recorded.out).toBe(0);
});

// Same defect, the simpler shape: no default advance at all, just an owned
// correction after GREEN. `sameBaselineRefinement` reaches `liveDefaultTargetSha`
// before it ever inspects whether anything actually moved.
it("records a same-baseline refinement when origin's default branch is main", async () => {
  const fixture = await setupInitialGreen({ defaultBranch: 'main' });
  const { root, runDir, trackerEnv } = fixture;
  await refineSource(root);
  const check = 'unit-green-main-default-same-baseline';
  expect((await runVitest({ root, runDir, name: check, trackerEnv })).code).toBe(0);
  const recorded = await record({ root, runDir, action: 'record-green', check, trackerEnv });
  expect(recorded.code, recorded.out).toBe(0);
});

// RP-370 review round 1 (B1): a repository with no `origin` remote at all is
// also a rig this script has to serve — `targetShaOf` in lib/claim-records.mjs
// already falls back to a local `master`/`main` there. `liveDefaultTargetSha`
// does not: it runs `git ls-remote ... origin ...` unconditionally and that
// fails outright with no remote named `origin` configured.
it('records a merged-default refresh in a repository with no origin remote', async () => {
  const fixture = await setupInitialGreen({ useOrigin: false });
  const { root, runDir, trackerEnv } = fixture;
  await git(['checkout', '-q', 'master'], root);
  await writeFile(
    path.join(root, 'src', 'foreign-local-default.ts'),
    'export const foreignLocalDefault = true;\n',
  );
  await git(['add', 'src/foreign-local-default.ts'], root);
  await git(['commit', '-q', '-m', 'M1 local default advance (no origin)'], root);
  const advancedLocalMaster = await git(['rev-parse', 'HEAD'], root);
  await git(['checkout', '-q', 'feat/RP-375'], root);
  await git(['merge', '--no-ff', '-q', 'master', '-m', 'merge local default advance'], root);
  expect(await git(['rev-parse', 'master'], root)).toBe(advancedLocalMaster);
  const check = 'unit-green-no-origin-merged-default-refresh';
  expect((await runVitest({ root, runDir, name: check, trackerEnv })).code).toBe(0);
  const recorded = await record({ root, runDir, action: 'record-green', check, trackerEnv });
  expect(recorded.code, recorded.out).toBe(0);
});

// RP-370 review round 1 (B1, security advisory): `git ls-remote --refs origin
// refs/heads/master` tail-matches any ref whose path ENDS with those
// components — a branch literally named `x/refs/heads/master` reports as a
// second `refs/heads/master` line, which `liveDefaultTargetSha` reads as
// ambiguity and refuses. An attacker-reachable branch name must not be able
// to block every future re-GREEN on the item.
it('does not treat a branch named x/refs/heads/master as a second default', async () => {
  const fixture = await setupInitialGreen();
  const { baseline, remote, root, runDir, trackerEnv } = fixture;
  await git(['push', '-q', remote, `${baseline}:refs/heads/x/refs/heads/master`], root);
  await refineSource(root);
  const check = 'unit-green-decoy-branch-name';
  expect((await runVitest({ root, runDir, name: check, trackerEnv })).code).toBe(0);
  const recorded = await record({ root, runDir, action: 'record-green', check, trackerEnv });
  expect(recorded.code, recorded.out).toBe(0);
});

// RP-370 review round 1 (B2): the recorder's "GREEN refinement history
// repeats an implementation boundary" guard compares the PRIOR evidence
// (the state about to be superseded) against every history entry's recorded
// delta, not against the state the chain is about to MOVE TO. A chain that
// legitimately returns to an earlier boundary (A -> B -> A) leaves that
// earlier boundary's delta sitting in history; the very next refinement
// away from it (A -> C) then collides with that stale entry even though it
// is moving the implementation forward, not repeating anything. Once stuck
// this way the chain stays stuck: a later merged-default refresh hits the
// identical guard before it ever reaches refresh-specific logic.
// Each step is a source commit, a GREEN check and record, and then a separate
// commit of the recorded claim — the same two-commit shape `setupInitialGreen`
// itself uses for the very first GREEN. Committing the claim after every step
// (not only the last) matters here: an uncommitted claim update changes which
// provenance path `sameBaselineRefinement` takes on the NEXT call, which would
// make these cases exercise something other than the boundary revisit they
// are pinned on.
const refineAndRecordOn =
  ({ root, runDir, trackerEnv }: Awaited<ReturnType<typeof setupInitialGreen>>) =>
  async (content: string, label: string) => {
    await writeFile(path.join(root, 'src', 'feature.ts'), content);
    await git(['add', 'src/feature.ts'], root);
    await git(['commit', '-q', '-m', `${label} source`], root);
    const check = `unit-green-${label}`;
    expect((await runVitest({ root, runDir, name: check, trackerEnv })).code).toBe(0);
    const recorded = await record({ root, runDir, action: 'record-green', check, trackerEnv });
    expect(recorded.code, recorded.out).toBe(0);
    await git(['add', '.rig/claims/RP-375.json'], root);
    await git(['commit', '-q', '-m', `${label} record GREEN`], root);
  };

// The revisit and the refresh after it are two cases rather than one: each
// attested GREEN is a real nested Vitest run, and the single six-run case sat
// at the 15 s case budget on windows-latest (13228 ms at c641788, timed out at
// b94e5e5). Split, each case does five runs and keeps every assertion.
it('keeps refining after a refinement returns to an earlier boundary', async () => {
  const refineAndRecord = refineAndRecordOn(await setupInitialGreen());
  await refineAndRecord(refinedImplementation, 'refine-to-b'); // A -> B
  await refineAndRecord(initialImplementation, 'refine-back-to-a'); // B -> A
  await refineAndRecord(thirdRefinedImplementation, 'refine-to-c'); // A -> C
});

it('records a merged-default refresh after a refinement returned to an earlier boundary', async () => {
  const fixture = await setupInitialGreen();
  const { defaultClone, remote, root, runDir, trackerEnv } = fixture;
  const refineAndRecord = refineAndRecordOn(fixture);
  await refineAndRecord(refinedImplementation, 'refine-to-b'); // A -> B
  await refineAndRecord(initialImplementation, 'refine-back-to-a'); // B -> A

  // A merged-default refresh must also still be reachable after the chain
  // has revisited a boundary — a guard that fires before refinement vs.
  // refresh is even decided would get the refresh stuck too, not only the
  // next refinement.
  const imported = await advanceRemoteDefault({ defaultClone, remote, root, fetch: true });
  await git(
    ['merge', '--no-ff', '-q', 'origin/master', '-m', 'merge validated default after revisit'],
    root,
  );
  expect(await git(['rev-parse', 'origin/master'], root)).toBe(imported.advanced);
  const checkRefresh = 'unit-green-refresh-after-revisit';
  expect((await runVitest({ root, runDir, name: checkRefresh, trackerEnv })).code).toBe(0);
  const recordedRefresh = await record({
    root,
    runDir,
    action: 'record-green',
    check: checkRefresh,
    trackerEnv,
  });
  expect(recordedRefresh.code, recordedRefresh.out).toBe(0);
});
