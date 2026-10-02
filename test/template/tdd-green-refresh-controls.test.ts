import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { jiraReadback } from './tdd-tracker-fixture.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const checkRun = path.join(scriptsDir, 'check-run.mjs');
const tddEvidence = path.join(scriptsDir, 'tdd-evidence.mjs');
const vitestCli = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const evidenceHelper = path.join(scriptsDir, 'lib', 'tdd-evidence.mjs');

type Result = { code: number; out: string };
type Fingerprint = { algorithm: 'sha256'; value: string };
type TestIdentity = { file: string; fullName: string; fileSha256: string };
type Evidence = {
  schemaVersion: 1;
  ticket: string;
  applicability: { level: 'TDD-2'; authority: { kind: 'check-run'; id: string } };
  baseline: { headSha: string };
  red: {
    test: TestIdentity;
    source: { runId: string; seq: number };
    observation: { outcome: 'fail'; checkFingerprint: Fingerprint };
    fingerprint: Fingerprint;
  };
  implementationBoundary: {
    source: { runId: string; seq: number };
    implementationDeltaFingerprint: Fingerprint;
    predecessorFingerprint: Fingerprint;
    fingerprint: Fingerprint;
  };
  green: {
    test: TestIdentity;
    source: { runId: string; seq: number };
    observation: { outcome: 'pass'; checkFingerprint: Fingerprint };
    predecessorFingerprint: Fingerprint;
    fingerprint: Fingerprint;
  };
};

const run = (file: string, args: string[], cwd: string, env = process.env): Promise<Result> =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, env }, (error, stdout, stderr) =>
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    );
  });

const git = async (args: string[], cwd: string) => {
  const result = await run(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
    cwd,
  );
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
  return result.out.trim();
};

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

const sha = (character: string, length = 64) => character.repeat(length);
const ticket = 'RP-347';
const baselineSha = sha('b', 40);
const relevantTest: TestIdentity = {
  file: 'test/feature.test.ts',
  fullName: 'returns new',
  fileSha256: sha('a'),
};

const linkEvidence = async (record: Evidence) => {
  const { fingerprintEvidence } = (await import(pathToFileURL(evidenceHelper).href)) as {
    fingerprintEvidence: (value: unknown) => Fingerprint;
  };
  record.red.fingerprint = fingerprintEvidence({
    ticket: record.ticket,
    baselineHeadSha: record.baseline.headSha,
    stage: 'red',
    test: record.red.test,
    source: record.red.source,
    observation: record.red.observation,
  });
  record.implementationBoundary.predecessorFingerprint = { ...record.red.fingerprint };
  record.implementationBoundary.fingerprint = fingerprintEvidence({
    ticket: record.ticket,
    baselineHeadSha: record.baseline.headSha,
    stage: 'implementation-boundary',
    source: record.implementationBoundary.source,
    implementationDeltaFingerprint: record.implementationBoundary.implementationDeltaFingerprint,
    predecessorFingerprint: record.implementationBoundary.predecessorFingerprint,
  });
  record.green.predecessorFingerprint = { ...record.implementationBoundary.fingerprint };
  record.green.fingerprint = fingerprintEvidence({
    ticket: record.ticket,
    baselineHeadSha: record.baseline.headSha,
    stage: 'green',
    test: record.green.test,
    source: record.green.source,
    observation: record.green.observation,
    predecessorFingerprint: record.green.predecessorFingerprint,
  });
  return record;
};

const portableTdd2 = async ({ implementation, green, sequence }: Record<string, string | number>) =>
  linkEvidence({
    schemaVersion: 1,
    ticket,
    applicability: { level: 'TDD-2', authority: { kind: 'check-run', id: 'unit-green' } },
    baseline: { headSha: baselineSha },
    red: {
      test: { ...relevantTest },
      source: { runId: 'controller', seq: 1 },
      observation: { outcome: 'fail', checkFingerprint: { algorithm: 'sha256', value: sha('f') } },
      fingerprint: { algorithm: 'sha256', value: sha('0') },
    },
    implementationBoundary: {
      source: { runId: 'controller', seq: Number(sequence) },
      implementationDeltaFingerprint: { algorithm: 'sha256', value: sha(String(implementation)) },
      predecessorFingerprint: { algorithm: 'sha256', value: sha('0') },
      fingerprint: { algorithm: 'sha256', value: sha('0') },
    },
    green: {
      test: { ...relevantTest },
      source: { runId: 'controller', seq: Number(sequence) + 1 },
      observation: {
        outcome: 'pass',
        checkFingerprint: { algorithm: 'sha256', value: sha(String(green)) },
      },
      predecessorFingerprint: { algorithm: 'sha256', value: sha('0') },
      fingerprint: { algorithm: 'sha256', value: sha('0') },
    },
  });

const greenRefreshHistory = async (prior: Evidence, replacement: Evidence) => {
  const { fingerprintEvidence } = (await import(pathToFileURL(evidenceHelper).href)) as {
    fingerprintEvidence: (value: unknown) => Fingerprint;
  };
  const transition = {
    priorGreenFingerprint: { ...prior.green.fingerprint },
    replacementGreenFingerprint: { ...replacement.green.fingerprint },
    priorImplementationBoundaryFingerprint: { ...prior.implementationBoundary.fingerprint },
    replacementImplementationBoundaryFingerprint: {
      ...replacement.implementationBoundary.fingerprint,
    },
    mergedDefaultSha: sha('d', 40),
    fingerprint: { algorithm: 'sha256' as const, value: sha('0') },
  };
  transition.fingerprint = fingerprintEvidence({
    ticket,
    baselineHeadSha: baselineSha,
    stage: 'merged-default-green-refresh',
    priorGreenFingerprint: transition.priorGreenFingerprint,
    replacementGreenFingerprint: transition.replacementGreenFingerprint,
    priorImplementationBoundaryFingerprint: transition.priorImplementationBoundaryFingerprint,
    replacementImplementationBoundaryFingerprint:
      transition.replacementImplementationBoundaryFingerprint,
    mergedDefaultSha: transition.mergedDefaultSha,
  });
  return [{ evidence: prior, transition }];
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
  run(process.execPath, [tddEvidence, action, '--ticket', ticket, '--check', check], root, {
    ...trackerEnv,
    RIG_RUN_DIR: runDir,
  });

const recordedGreenFixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tdd-green-refresh-controls-'));
  const runDir = await mkdtemp(path.join(tmpdir(), 'tdd-green-refresh-controls-run-'));
  await mkdir(path.join(root, '.rig'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, '.rig', 'revalidation.json'), `${JSON.stringify(contract)}\n`);
  await writeFile(path.join(root, 'src', 'feature.ts'), 'export const feature = () => "old";\n');
  await writeFile(
    path.join(root, 'test', 'feature.test.ts'),
    "import { feature } from '../src/feature.ts';\n\nit('returns new', () => expect(feature()).toBe('new'));\n",
  );
  await writeFile(
    path.join(root, 'vitest.config.mjs'),
    "export default { test: { include: ['test/**/*.test.ts'], globals: true } };\n",
  );
  await git(['init', '-q', '-b', 'master'], root);
  await git(['add', '.rig/revalidation.json', 'src/feature.ts'], root);
  await git(['commit', '-q', '-m', 'selected baseline'], root);
  const baseline = await git(['rev-parse', 'HEAD'], root);
  await git(['checkout', '-q', '-b', 'feat/RP-347'], root);

  const claims = (await import(
    pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
  )) as {
    revalidateClaim: (input: Record<string, unknown>) => { result: string };
    recordClaimTransition: (input: Record<string, unknown>) => unknown;
  };
  const trackerTicket = {
    id: ticket,
    state: 'open' as const,
    title: 'refresh GREEN evidence',
    body: 'rig:tdd-spec/v1 {"file":"test/feature.test.ts","fullName":"returns new"}',
    labels: [],
    blockedBy: [],
    blocks: [],
  };
  const trackerEnv = await jiraReadback({ projectRoot: root, ticket: trackerTicket });
  expect(
    claims.revalidateClaim({
      projectRoot: root,
      ticket: trackerTicket,
      point: 'SELECT',
      targetSha: baseline,
      allowCreate: true,
    }).result,
  ).toBe('BASELINE_CREATED');
  claims.recordClaimTransition({
    projectRoot: root,
    ticket: { ...trackerTicket, state: 'in-progress' },
    claimedState: 'in-progress',
  });

  const red = await runVitest({ root, runDir, name: 'unit-red', trackerEnv });
  expect(red.code, red.out).toBe(1);
  expect(
    (await record({ root, runDir, action: 'record-red', check: 'unit-red', trackerEnv })).code,
  ).toBe(0);
  await writeFile(path.join(root, 'src', 'feature.ts'), 'export const feature = () => "new";\n');
  await git(['add', 'src/feature.ts'], root);
  await git(['commit', '-q', '-m', 'feature implementation'], root);
  const green = await runVitest({ root, runDir, name: 'unit-green', trackerEnv });
  expect(green.code, green.out).toBe(0);
  expect(
    (await record({ root, runDir, action: 'record-green', check: 'unit-green', trackerEnv })).code,
  ).toBe(0);
  await git(['add', `.rig/claims/${ticket}.json`], root);
  await git(['commit', '-q', '-m', 'record GREEN evidence'], root);
  return { root, runDir, trackerEnv, baseline };
};

const advanceMaster = async (root: string, file: string) => {
  await git(['checkout', '-q', 'master'], root);
  await writeFile(
    path.join(root, 'src', file),
    `export const ${file.replace(/\.ts$/, '')} = true;\n`,
  );
  await git(['add', `src/${file}`], root);
  await git(['commit', '-q', '-m', `advance default with ${file}`], root);
  return git(['rev-parse', 'HEAD'], root);
};

describe('RP-347 GREEN refresh controls', () => {
  it('rejects a forged GREEN refresh-history fingerprint', async () => {
    const { validateTddEvidenceHistory } = (await import(pathToFileURL(evidenceHelper).href)) as {
      validateTddEvidenceHistory: (input: Record<string, unknown>) => {
        ok: boolean;
        problems?: string[];
      };
    };
    const prior = await portableTdd2({ implementation: 'c', green: 'd', sequence: 2 });
    const replacement = await portableTdd2({ implementation: 'e', green: 'f', sequence: 4 });
    const history = await greenRefreshHistory(prior, replacement);
    expect(
      validateTddEvidenceHistory({
        ticket,
        baselineHeadSha: baselineSha,
        activeEvidence: replacement,
        history,
      }),
    ).toEqual({ ok: true });

    const forged = [
      {
        ...history[0]!,
        transition: {
          ...history[0]!.transition,
          replacementGreenFingerprint: { algorithm: 'sha256' as const, value: sha('0') },
        },
      },
    ];
    expect(
      validateTddEvidenceHistory({
        ticket,
        baselineHeadSha: baselineSha,
        activeEvidence: replacement,
        history: forged,
      }),
    ).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([
        'tddEvidenceHistory[0].transition.replacementGreenFingerprint must match replacement GREEN',
      ]),
    });
  });

  it('refuses shipping when production changes after the recorded GREEN', async () => {
    const { root, runDir, trackerEnv, baseline } = await recordedGreenFixture();
    await writeFile(path.join(root, 'src', 'after-green.ts'), 'export const afterGreen = true;\n');
    await git(['add', 'src/after-green.ts'], root);
    await git(['commit', '-q', '-m', 'change production after GREEN'], root);

    const ship = await run(
      process.execPath,
      [tddEvidence, 'verify-ship', '--ticket', ticket, '--base', baseline],
      root,
      { ...trackerEnv, RIG_RUN_DIR: runDir },
    );

    expect(ship.code, ship.out).toBe(2);
    expect(ship.out).toMatch(/implementation boundary.*final production diff/i);
  });

  it('refuses a refresh without one direct merge of the advanced default branch', async () => {
    const { root, runDir, trackerEnv } = await recordedGreenFixture();
    await advanceMaster(root, 'default-advance.ts');
    await git(['checkout', '-q', 'feat/RP-347'], root);
    const green = await runVitest({ root, runDir, name: 'unit-green', trackerEnv });
    expect(green.code, green.out).toBe(0);

    const refresh = await record({
      root,
      runDir,
      action: 'record-green',
      check: 'unit-green',
      trackerEnv,
    });

    expect(refresh.code, refresh.out).toBe(1);
    expect(refresh.out).toMatch(/requires one direct merge of the current default branch/i);
  });

  it('refuses a refresh whose direct merge is behind the current default tip', async () => {
    const { root, runDir, trackerEnv } = await recordedGreenFixture();
    await advanceMaster(root, 'first-default-advance.ts');
    await git(['checkout', '-q', 'feat/RP-347'], root);
    await git(['merge', '--no-ff', '-m', 'merge first default advance', 'master'], root);
    await advanceMaster(root, 'second-default-advance.ts');
    await git(['checkout', '-q', 'feat/RP-347'], root);
    const green = await runVitest({ root, runDir, name: 'unit-green', trackerEnv });
    expect(green.code, green.out).toBe(0);

    const refresh = await record({
      root,
      runDir,
      action: 'record-green',
      check: 'unit-green',
      trackerEnv,
    });

    expect(refresh.code, refresh.out).toBe(1);
    expect(refresh.out).toMatch(/did not merge the current default branch tip/i);
  });
});
