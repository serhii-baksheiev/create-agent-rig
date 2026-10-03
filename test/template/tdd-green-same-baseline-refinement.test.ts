import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
type Fingerprint = { algorithm: string; value: string };
type Evidence = {
  ticket: unknown;
  baseline: { headSha: string };
  implementationBoundary: {
    fingerprint: Fingerprint;
    source: unknown;
    implementationDeltaFingerprint: unknown;
    predecessorFingerprint: unknown;
  };
  green: {
    fingerprint: Fingerprint;
    predecessorFingerprint: Fingerprint;
    test: unknown;
    source: unknown;
    observation: unknown;
  };
};

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

const git = async (args: string[], root: string) => {
  const result = await run(
    'git',
    ['-c', 'user.email=rp370@example.invalid', '-c', 'user.name=rp370', ...args],
    root,
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
  run(process.execPath, [tddEvidence, action, '--ticket', 'RP-370', '--check', check], root, {
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

const claimBytes = (root: string) => readFile(path.join(root, '.rig', 'claims', 'RP-370.json'));

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
};

const fingerprint = (record: unknown) => ({
  algorithm: 'sha256',
  value: createHash('sha256')
    .update(JSON.stringify(canonical(record)))
    .digest('hex'),
});

const expectedSameBaselineTransition = ({
  ticket,
  baseline,
  prior,
  replacement,
}: {
  ticket: unknown;
  baseline: string;
  prior: Evidence;
  replacement: Evidence;
}) => {
  const transition = {
    priorGreenFingerprint: prior.green.fingerprint,
    replacementGreenFingerprint: replacement.green.fingerprint,
    priorImplementationBoundaryFingerprint: prior.implementationBoundary.fingerprint,
    replacementImplementationBoundaryFingerprint: replacement.implementationBoundary.fingerprint,
    sameBaselineRefinement: true,
  };
  return {
    ...transition,
    fingerprint: fingerprint({
      ticket,
      baselineHeadSha: baseline,
      stage: 'same-baseline-green-refinement',
      ...transition,
    }),
  };
};

const rewriteEvidenceFingerprints = (evidence: Evidence) => {
  const boundary = evidence.implementationBoundary;
  boundary.fingerprint = fingerprint({
    ticket: evidence.ticket,
    baselineHeadSha: evidence.baseline.headSha,
    stage: 'implementation-boundary',
    source: boundary.source,
    implementationDeltaFingerprint: boundary.implementationDeltaFingerprint,
    predecessorFingerprint: boundary.predecessorFingerprint,
  });
  evidence.green.predecessorFingerprint = boundary.fingerprint;
  evidence.green.fingerprint = fingerprint({
    ticket: evidence.ticket,
    baselineHeadSha: evidence.baseline.headSha,
    stage: 'green',
    test: evidence.green.test,
    source: evidence.green.source,
    observation: evidence.green.observation,
    predecessorFingerprint: evidence.green.predecessorFingerprint,
  });
};

const setupInitialGreen = async ({ commitInitialImplementation = true } = {}) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rp370-same-baseline-'));
  const runDir = await mkdtemp(path.join(tmpdir(), 'rp370-same-baseline-run-'));
  const remote = await mkdtemp(path.join(tmpdir(), 'rp370-same-baseline-remote-'));
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
  await git(['commit', '-q', '-m', 'B0 selected baseline'], root);
  const baseline = await git(['rev-parse', 'HEAD'], root);
  await git(['push', '-q', 'origin', 'master'], root);
  await git(['fetch', '-q', 'origin'], root);
  const defaultClone = await mkdtemp(path.join(tmpdir(), 'rp370-same-baseline-default-'));
  await git(['clone', '-q', remote, defaultClone], root);
  await git(['checkout', '-q', '-b', 'feat/RP-370'], root);

  const claims = (await import(
    pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
  )) as {
    revalidateClaim: (input: Record<string, unknown>) => { result: string };
    recordClaimTransition: (input: Record<string, unknown>) => unknown;
  };
  const ticket = {
    id: 'RP-370',
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
    await git(['add', '.rig/claims/RP-370.json'], root);
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
}: {
  defaultClone: string;
  remote: string;
  root: string;
  fetch: boolean;
}) => {
  await writeFile(
    path.join(defaultClone, 'src', 'foreign-default.ts'),
    'export const foreignDefault = true;\n',
  );
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

const recordsUncommittedRemoteContinuation = async ({
  fetch,
  label,
}: {
  fetch: boolean;
  label: string;
}) => {
  const uncommitted = await setupInitialGreen({ commitInitialImplementation: false });
  expect(await git(['diff', '--name-only', '--', 'src/feature.ts'], uncommitted.root)).toBe(
    'src/feature.ts',
  );
  const remoteDefault = await advanceRemoteDefault({ ...uncommitted, fetch });
  expect(remoteDefault.advanced).not.toBe(uncommitted.baseline);
  expect(remoteDefault.cached).toBe(fetch ? remoteDefault.advanced : uncommitted.baseline);
  expect(await git(['rev-parse', 'HEAD'], uncommitted.root)).toBe(uncommitted.baseline);
  expect(
    (
      await run(
        'git',
        ['merge-base', '--is-ancestor', remoteDefault.advanced, uncommitted.baseline],
        remoteDefault.defaultClone,
      )
    ).code,
  ).toBe(1);
  await refineSource(uncommitted.root, { commit: false });
  const check = `unit-green-refined-uncommitted-${label}`;
  const refined = await runVitest({
    root: uncommitted.root,
    runDir: uncommitted.runDir,
    name: check,
    trackerEnv: uncommitted.trackerEnv,
  });
  expect(refined.code, refined.out).toBe(0);

  const recorded = await record({
    root: uncommitted.root,
    runDir: uncommitted.runDir,
    action: 'record-green',
    check,
    trackerEnv: uncommitted.trackerEnv,
  });
  expect(recorded.code, recorded.out).toBe(0);

  const refinedClaim = JSON.parse((await claimBytes(uncommitted.root)).toString('utf8'));
  expect(refinedClaim.fingerprints.scope.targetSha).toBe(uncommitted.baseline);
  expect(refinedClaim.tddEvidence.baseline.headSha).toBe(uncommitted.baseline);
  expect(refinedClaim.tddEvidence.red).toEqual(uncommitted.initialClaim.tddEvidence.red);
  expect(refinedClaim.tddEvidence.green.fingerprint).not.toBe(
    uncommitted.initialClaim.tddEvidence.green.fingerprint,
  );
  expect(refinedClaim.tddEvidenceHistory).toHaveLength(1);
  expect(refinedClaim.tddEvidenceHistory[0].evidence.red).toEqual(
    uncommitted.initialClaim.tddEvidence.red,
  );
  expect(refinedClaim.tddEvidenceHistory[0].evidence.green).toEqual(
    uncommitted.initialClaim.tddEvidence.green,
  );
  expect(refinedClaim.tddEvidenceHistory[0].transition).toEqual(
    expectedSameBaselineTransition({
      ticket: refinedClaim.tddEvidence.ticket,
      baseline: uncommitted.baseline,
      prior: uncommitted.initialClaim.tddEvidence,
      replacement: refinedClaim.tddEvidence,
    }),
  );
};

it('records a fresh same-baseline GREEN after an owned source refinement while retaining the prior evidence', async () => {
  expect(path.isAbsolute(tddEvidence)).toBe(true);
  await recordsUncommittedRemoteContinuation({ fetch: true, label: 'fetched-live-default' });

  const committed = await setupInitialGreen();
  await refineSource(committed.root);
  const committedRefinement = await runVitest({
    root: committed.root,
    runDir: committed.runDir,
    name: 'unit-green-refined-committed-source',
    trackerEnv: committed.trackerEnv,
  });
  expect(committedRefinement.code, committedRefinement.out).toBe(0);
  expect(
    (
      await record({
        root: committed.root,
        runDir: committed.runDir,
        action: 'record-green',
        check: 'unit-green-refined-committed-source',
        trackerEnv: committed.trackerEnv,
      })
    ).code,
  ).toBe(0);

  const ownedCommitted = await setupInitialGreen();
  const liveDefault = await advanceRemoteDefault({ ...ownedCommitted, fetch: true });
  expect(liveDefault.cached).toBe(liveDefault.advanced);
  await refineSource(ownedCommitted.root, { commit: false });
  const ownedCommittedCheck = 'unit-green-refined-owned-committed-primary';
  expect(
    (
      await runVitest({
        root: ownedCommitted.root,
        runDir: ownedCommitted.runDir,
        name: ownedCommittedCheck,
        trackerEnv: ownedCommitted.trackerEnv,
      })
    ).code,
  ).toBe(0);
  const ownedCommittedRecorded = await record({
    root: ownedCommitted.root,
    runDir: ownedCommitted.runDir,
    action: 'record-green',
    check: ownedCommittedCheck,
    trackerEnv: ownedCommitted.trackerEnv,
  });
  expect(ownedCommittedRecorded.code, ownedCommittedRecorded.out).toBe(0);
});

it('records the same owned uncommitted continuation when its remote-tracking cache is stale', async () => {
  await recordsUncommittedRemoteContinuation({ fetch: false, label: 'stale-cache' });
});

it('records an owned uncommitted correction after committed GREEN work and a fetched live-default advance', async () => {
  const fixture = await setupInitialGreen();
  const { root, runDir, trackerEnv } = fixture;
  const remoteDefault = await advanceRemoteDefault({ ...fixture, fetch: true });
  expect(remoteDefault.cached).toBe(remoteDefault.advanced);
  await refineSource(root, { commit: false });
  const check = 'unit-green-refined-owned-committed-after-live-default';
  expect((await runVitest({ root, runDir, name: check, trackerEnv })).code).toBe(0);

  const recorded = await record({ root, runDir, action: 'record-green', check, trackerEnv });
  expect(recorded.code, recorded.out).toBe(0);

  const refinedClaim = JSON.parse((await claimBytes(root)).toString('utf8'));
  expect(refinedClaim.tddEvidence.baseline.headSha).toBe(fixture.baseline);
  expect(refinedClaim.tddEvidenceHistory).toHaveLength(1);
  expect(refinedClaim.tddEvidenceHistory[0].transition.sameBaselineRefinement).toBe(true);
});

it('records a later owned correction after a verified default import without another default advance', async () => {
  const fixture = await setupInitialGreen();
  const { root, runDir, trackerEnv } = fixture;
  const remoteDefault = await advanceRemoteDefault({ ...fixture, fetch: true });
  await git(['merge', '--no-ff', '-q', 'origin/master', '-m', 'merge current default'], root);
  const refreshCheck = 'unit-green-refreshed-direct-default-import';
  expect((await runVitest({ root, runDir, name: refreshCheck, trackerEnv })).code).toBe(0);
  expect(
    (await record({ root, runDir, action: 'record-green', check: refreshCheck, trackerEnv })).code,
  ).toBe(0);
  await git(['add', '.rig/claims/RP-370.json'], root);
  await git(['commit', '-q', '-m', 'record verified default GREEN refresh'], root);
  expect(await git(['rev-parse', 'origin/master'], root)).toBe(remoteDefault.advanced);

  await refineSource(root, { commit: false });
  const correctionCheck = 'unit-green-refined-after-verified-default-import';
  expect((await runVitest({ root, runDir, name: correctionCheck, trackerEnv })).code).toBe(0);
  const recorded = await record({
    root,
    runDir,
    action: 'record-green',
    check: correctionCheck,
    trackerEnv,
  });
  expect(recorded.code, recorded.out).toBe(0);

  const refinedClaim = JSON.parse((await claimBytes(root)).toString('utf8'));
  expect(refinedClaim.tddEvidenceHistory).toHaveLength(2);
  expect(refinedClaim.tddEvidenceHistory[1].transition.sameBaselineRefinement).toBe(true);
});

it('refuses a stale refined PASS after its observed source boundary changes', async () => {
  const { root, runDir, trackerEnv } = await setupInitialGreen();
  await refineSource(root);
  expect(
    (await runVitest({ root, runDir, name: 'unit-green-refined-stale', trackerEnv })).code,
  ).toBe(0);
  const before = await claimBytes(root);
  await writeFile(
    path.join(root, 'src', 'feature.ts'),
    'export const feature = (value = "new") => value.trimEnd();\n',
  );
  const recorded = await record({
    root,
    runDir,
    action: 'record-green',
    check: 'unit-green-refined-stale',
    trackerEnv,
  });
  expect(recorded.code, recorded.out).toBe(1);
  expect(await claimBytes(root)).toEqual(before);
});

it('refuses a refined PASS when the relevant spec changed after the original RED', async () => {
  const { root, runDir, trackerEnv } = await setupInitialGreen();
  await writeFile(
    path.join(root, 'test', 'feature.test.ts'),
    `// changed relevant spec bytes\n${featureTest}`,
  );
  expect(
    (await runVitest({ root, runDir, name: 'unit-green-refined-spec-change', trackerEnv })).code,
  ).toBe(0);
  const before = await claimBytes(root);
  const recorded = await record({
    root,
    runDir,
    action: 'record-green',
    check: 'unit-green-refined-spec-change',
    trackerEnv,
  });
  expect(recorded.code, recorded.out).toBe(1);
  expect(await claimBytes(root)).toEqual(before);
});

it('refuses a refined PASS when the retained initial claim was tampered', async () => {
  const { root, runDir, trackerEnv } = await setupInitialGreen();
  await refineSource(root);
  expect(
    (await runVitest({ root, runDir, name: 'unit-green-refined-tampered', trackerEnv })).code,
  ).toBe(0);
  const tampered = JSON.parse((await claimBytes(root)).toString('utf8'));
  tampered.tddEvidence.green.fingerprint.value = '0'.repeat(64);
  await writeFile(
    path.join(root, '.rig', 'claims', 'RP-370.json'),
    `${JSON.stringify(tampered, null, 2)}\n`,
  );
  const before = await claimBytes(root);
  const recorded = await record({
    root,
    runDir,
    action: 'record-green',
    check: 'unit-green-refined-tampered',
    trackerEnv,
  });
  expect(recorded.code, recorded.out).toBe(1);
  expect(await claimBytes(root)).toEqual(before);
});

it('refuses a history entry whose valid fingerprints conceal the same implementation delta', async () => {
  const { baseline, root, runDir, trackerEnv } = await setupInitialGreen();
  await refineSource(root);
  const firstCheck = 'unit-green-refined-history-source';
  expect((await runVitest({ root, runDir, name: firstCheck, trackerEnv })).code).toBe(0);
  expect(
    (await record({ root, runDir, action: 'record-green', check: firstCheck, trackerEnv })).code,
  ).toBe(0);
  const tampered = JSON.parse((await claimBytes(root)).toString('utf8'));
  const history = tampered.tddEvidenceHistory[0];
  history.evidence.implementationBoundary.implementationDeltaFingerprint =
    tampered.tddEvidence.implementationBoundary.implementationDeltaFingerprint;
  rewriteEvidenceFingerprints(history.evidence);
  history.transition = expectedSameBaselineTransition({
    ticket: tampered.tddEvidence.ticket,
    baseline,
    prior: history.evidence,
    replacement: tampered.tddEvidence,
  });
  await writeFile(
    path.join(root, '.rig', 'claims', 'RP-370.json'),
    `${JSON.stringify(tampered, null, 2)}\n`,
  );
  await writeFile(
    path.join(root, 'src', 'feature.ts'),
    'export const feature = (value = "new") => value.trimEnd();\n',
  );
  await git(['add', 'src/feature.ts'], root);
  await git(['commit', '-q', '-m', 'F3 later owned correction'], root);
  const check = 'unit-green-refined-history-same-delta';
  expect((await runVitest({ root, runDir, name: check, trackerEnv })).code).toBe(0);
  const before = await claimBytes(root);
  const recorded = await record({ root, runDir, action: 'record-green', check, trackerEnv });
  expect(recorded.code, recorded.out).toBe(1);
  expect(await claimBytes(root)).toEqual(before);
});

it('retains the strict default-refresh refusal when current default advanced but was not merged', async () => {
  const fixture = await setupInitialGreen();
  const { root, runDir, trackerEnv } = fixture;
  const remoteDefault = await advanceRemoteDefault({ ...fixture, fetch: true });
  expect(remoteDefault.cached).toBe(remoteDefault.advanced);
  await refineSource(root);
  expect(
    (await runVitest({ root, runDir, name: 'unit-green-refined-unmerged-default', trackerEnv }))
      .code,
  ).toBe(0);
  const before = await claimBytes(root);
  const recorded = await record({
    root,
    runDir,
    action: 'record-green',
    check: 'unit-green-refined-unmerged-default',
    trackerEnv,
  });
  expect(recorded.code, recorded.out).toBe(1);
  expect(await claimBytes(root)).toEqual(before);
});

it.each([
  { fetch: false, label: 'a stale remote-tracking cache' },
  { fetch: true, label: 'a fetched remote-tracking cache' },
])('refuses a foreign production merge with %s', async ({ fetch, label }) => {
  const fixture = await setupInitialGreen();
  const { root, runDir, trackerEnv } = fixture;
  const remoteDefault = await advanceRemoteDefault({ ...fixture, fetch });
  expect(remoteDefault.cached).toBe(fetch ? remoteDefault.advanced : fixture.baseline);
  if (!fetch) {
    await git(['fetch', '-q', 'origin', 'master:refs/heads/rp370-live-default'], root);
    await git(
      ['merge', '--no-ff', '-q', 'rp370-live-default', '-m', 'merge foreign default'],
      root,
    );
  } else {
    await git(['merge', '--no-ff', '-q', 'origin/master', '-m', 'merge foreign default'], root);
  }
  await refineSource(root);
  const check = `unit-green-refined-foreign-default-${fetch ? 'fetched' : 'stale'}`;
  expect((await runVitest({ root, runDir, name: check, trackerEnv })).code).toBe(0);
  const before = await claimBytes(root);
  const recorded = await record({
    root,
    runDir,
    action: 'record-green',
    check,
    trackerEnv,
  });
  expect(recorded.code, `${label}: ${recorded.out}`).toBe(1);
  expect(await claimBytes(root)).toEqual(before);
});
