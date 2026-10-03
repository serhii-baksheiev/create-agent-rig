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

type Result = { code: number; out: string };

const run = (file: string, args: string[], cwd: string, env = process.env): Promise<Result> =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, env }, (error, stdout, stderr) =>
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    );
  });

const git = async (args: string[], root: string) => {
  const result = await run(
    'git',
    ['-c', 'user.email=rp370@example.invalid', '-c', 'user.name=rp370', ...args],
    root,
  );
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
  return result.out.trim();
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

const setupInitialGreen = async ({ commitInitialImplementation = true } = {}) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rp370-same-baseline-'));
  const runDir = await mkdtemp(path.join(tmpdir(), 'rp370-same-baseline-run-'));
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
  await git(['remote', 'add', 'origin', path.join(root, 'origin.git')], root);
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
  await git(['update-ref', 'refs/remotes/origin/master', baseline], root);
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
  return { baseline, initialClaim, root, runDir, trackerEnv };
};

const refineSource = async (root: string, { commit = true } = {}) => {
  await writeFile(path.join(root, 'src', 'feature.ts'), refinedImplementation);
  if (commit) {
    await git(['add', 'src/feature.ts'], root);
    await git(['commit', '-q', '-m', 'F2 trim correction after GREEN'], root);
  }
};

it('records a fresh same-baseline GREEN after an owned source refinement while retaining the prior evidence', async () => {
  const uncommitted = await setupInitialGreen({ commitInitialImplementation: false });
  expect(await git(['diff', '--name-only', '--', 'src/feature.ts'], uncommitted.root)).toBe(
    'src/feature.ts',
  );
  await refineSource(uncommitted.root, { commit: false });
  const refined = await runVitest({
    root: uncommitted.root,
    runDir: uncommitted.runDir,
    name: 'unit-green-refined-uncommitted-source',
    trackerEnv: uncommitted.trackerEnv,
  });
  expect(refined.code, refined.out).toBe(0);

  const recorded = await record({
    root: uncommitted.root,
    runDir: uncommitted.runDir,
    action: 'record-green',
    check: 'unit-green-refined-uncommitted-source',
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
  expect(refinedClaim.tddEvidenceHistory[0].transition).toEqual(expect.any(Object));

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

it('retains the strict default-refresh refusal when current default advanced but was not merged', async () => {
  const { root, runDir, trackerEnv } = await setupInitialGreen();
  await git(['checkout', '-q', 'master'], root);
  await writeFile(
    path.join(root, 'src', 'default-advance.ts'),
    'export const defaultAdvance = true;\n',
  );
  await git(['add', 'src/default-advance.ts'], root);
  await git(['commit', '-q', '-m', 'M1 unmerged current default'], root);
  const advancedDefault = await git(['rev-parse', 'HEAD'], root);
  await git(['checkout', '-q', 'feat/RP-370'], root);
  await git(['update-ref', 'refs/remotes/origin/master', advancedDefault], root);
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
