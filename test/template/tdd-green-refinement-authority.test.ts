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
}: { commitInitialImplementation?: boolean; commitDate?: string } = {}) => {
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
  await git(['init', '-q', '-b', 'master'], root);
  await git(['config', 'core.autocrlf', 'true'], root);
  await git(['init', '--bare', '-q', remote], root);
  await git(['remote', 'add', 'origin', remote], root);
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
  await git(['push', '-q', 'origin', 'master'], root);
  await git(['fetch', '-q', 'origin'], root);
  await git(['checkout', '-q', '-b', 'feat/RP-375'], root);
  const defaultClone = await mkdtemp(path.join(tmpdir(), 'rp375-same-baseline-default-'));
  await git(['clone', '-q', remote, defaultClone], root);

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
}: {
  defaultClone: string;
  remote: string;
  root: string;
  fetch: boolean;
  foreignContent?: string;
}) => {
  await writeFile(path.join(defaultClone, 'src', 'foreign-default.ts'), foreignContent);
  await git(['add', 'src/foreign-default.ts'], defaultClone);
  await git(['commit', '-q', '-m', 'M1 foreign default production'], defaultClone);
  const advanced = await git(['rev-parse', 'HEAD'], defaultClone);
  await git(['push', '-q', 'origin', 'master'], defaultClone);
  expect(await git(['ls-remote', remote, 'refs/heads/master'], root)).toContain(advanced);
  if (fetch) await git(['fetch', '-q', 'origin'], root);
  return {
    advanced,
    cached: await git(['rev-parse', 'refs/remotes/origin/master'], root),
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
