import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { jiraReadback } from './tdd-tracker-fixture.js';

// RP-306 shipping is a mechanical gate over the tracked claim. A fresh
// controller must not need the previous controller's ignored run journal to
// prove an evidence chain that check-run and the producer actually recorded.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const checkRun = path.join(scriptsDir, 'check-run.mjs');
const tddEvidence = path.join(scriptsDir, 'tdd-evidence.mjs');
const vitestCli = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');

type Result = { code: number; stdout: string; stderr: string; out: string };

const run = (file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Result> =>
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

const git = async (args: string[], cwd: string) => {
  const result = await run(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
    cwd,
    process.env,
  );
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
  return result.stdout.trim();
};

const revalidationContract = {
  schemaVersion: 1,
  detection: {
    mode: 'pull',
    sources: ['run-state', 'journal'],
    acceptedLatency: '24h',
    push: false,
  },
  pairedFacts: [],
};

const runVitestCheck = ({
  name,
  projectRoot,
  runDir,
  vitestConfig,
  trackerEnv = process.env,
}: {
  name: string;
  projectRoot: string;
  runDir: string;
  vitestConfig: string;
  trackerEnv?: NodeJS.ProcessEnv;
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
      '--root',
      projectRoot,
      '--config',
      vitestConfig,
      '--reporter=json',
      '--outputFile',
      path.join(runDir, resultName),
    ],
    projectRoot,
    { ...trackerEnv, RIG_RUN_DIR: runDir },
  );
};

const record = ({
  command,
  check,
  projectRoot,
  runDir,
  trackerEnv = process.env,
}: {
  command: 'record-red' | 'record-green';
  check: string;
  projectRoot: string;
  runDir: string;
  trackerEnv?: NodeJS.ProcessEnv;
}) =>
  run(
    process.execPath,
    [tddEvidence, command, '--ticket', 'RP-306', '--check', check],
    projectRoot,
    { ...trackerEnv, RIG_RUN_DIR: runDir },
  );

const project = async ({ evidence = false }: { evidence?: boolean } = {}) => {
  const root = await mkdtemp(path.join(tmpdir(), 'tdd-ship-'));
  await mkdir(path.join(root, '.rig'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(
    path.join(root, '.rig', 'revalidation.json'),
    `${JSON.stringify(revalidationContract)}\n`,
  );
  await writeFile(path.join(root, 'src', 'feature.ts'), 'export const feature = () => "old";\n');
  await git(['init', '-q', '-b', 'master'], root);
  await git(['add', '.rig/revalidation.json', 'src/feature.ts'], root);
  await git(['commit', '-q', '-m', 'baseline'], root);
  const baselineHeadSha = await git(['rev-parse', 'HEAD'], root);
  await git(['checkout', '-q', '-b', 'feat/RP-306'], root);

  const claims = (await import(
    pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
  )) as {
    revalidateClaim: (input: Record<string, unknown>) => { result: string };
  };
  const ticket = {
    id: 'RP-306',
    state: 'open' as const,
    title: 'change feature',
    body: 'rig:tdd-spec/v1 {"file":"test/feature.test.ts","fullName":"returns the replacement value"}',
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
      targetSha: baselineHeadSha,
      allowCreate: true,
    }).result,
  ).toBe('BASELINE_CREATED');

  if (evidence) {
    const testPath = path.join(root, 'test', 'feature.test.ts');
    const vitestConfig = path.join(root, 'vitest.config.mjs');
    await mkdir(path.dirname(testPath), { recursive: true });
    await writeFile(
      testPath,
      "import { feature } from '../src/feature.ts';\n\nit('returns the replacement value', () => expect(feature()).toBe('new'));\n",
    );
    await writeFile(
      vitestConfig,
      "export default { test: { include: ['test/**/*.test.ts'], globals: true } };\n",
    );
    const priorControllerRun = await mkdtemp(path.join(tmpdir(), 'prior-controller-run-'));
    const red = await runVitestCheck({
      name: 'unit-red',
      projectRoot: root,
      runDir: priorControllerRun,
      vitestConfig,
      trackerEnv,
    });
    expect(red.code, red.out).toBe(1);
    const redRecord = await record({
      command: 'record-red',
      check: 'unit-red',
      projectRoot: root,
      runDir: priorControllerRun,
      trackerEnv,
    });
    expect(redRecord.code, redRecord.out).toBe(0);

    await writeFile(path.join(root, 'src', 'feature.ts'), 'export const feature = () => "new";\n');
    await git(['add', 'src/feature.ts'], root);
    await git(['commit', '-q', '-m', 'change feature behaviour'], root);
    const green = await runVitestCheck({
      name: 'unit-green',
      projectRoot: root,
      runDir: priorControllerRun,
      vitestConfig,
      trackerEnv,
    });
    expect(green.code, green.out).toBe(0);
    const greenRecord = await record({
      command: 'record-green',
      check: 'unit-green',
      projectRoot: root,
      runDir: priorControllerRun,
      trackerEnv,
    });
    expect(greenRecord.code, greenRecord.out).toBe(0);
  } else {
    await writeFile(path.join(root, 'src', 'feature.ts'), 'export const feature = () => "new";\n');
    await git(['add', 'src/feature.ts'], root);
    await git(['commit', '-q', '-m', 'change feature behaviour'], root);
  }

  await git(['add', '.rig/claims/RP-306.json'], root);
  await git(['commit', '-q', '-m', 'track selected work evidence'], root);
  return { root, trackerEnv };
};

const verifyShip = (root: string, runDir: string, trackerEnv: NodeJS.ProcessEnv = process.env) =>
  run(
    process.execPath,
    [tddEvidence, 'verify-ship', '--ticket', 'RP-306', '--base', 'master'],
    root,
    { ...trackerEnv, RIG_RUN_DIR: runDir },
  );

describe('RP-306 compact shipping verdict', () => {
  it('records the exact portable TDD-2 stage fingerprints in a fresh controller journal', async () => {
    const { root, trackerEnv } = await project({ evidence: true });
    const verificationRun = await mkdtemp(path.join(tmpdir(), 'tdd-verdict-fresh-run-'));
    const result = await verifyShip(root, verificationRun, trackerEnv);
    expect(result.code, result.out).toBe(0);

    const claim = JSON.parse(
      await readFile(path.join(root, '.rig', 'claims', 'RP-306.json'), 'utf8'),
    );
    const journal = (await import(
      pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href
    )) as {
      readRun: (input: { runDir: string }) => { events: Array<{ kind?: string; data?: unknown }> };
    };
    const verdict = journal
      .readRun({ runDir: verificationRun })
      .events.filter((event) => event.kind === 'tdd-ship-verification')
      .at(-1);
    expect(verdict).toMatchObject({
      data: {
        ticket: 'RP-306',
        level: 'TDD-2',
        evidenceFingerprints: {
          red: claim.tddEvidence.red.fingerprint,
          implementationBoundary: claim.tddEvidence.implementationBoundary.fingerprint,
          green: claim.tddEvidence.green.fingerprint,
        },
      },
    });
  });

  it('HOLDs when a tracked portable stage fingerprint is mutated', async () => {
    const { root, trackerEnv } = await project({ evidence: true });
    const claimPath = path.join(root, '.rig', 'claims', 'RP-306.json');
    const claim = JSON.parse(await readFile(claimPath, 'utf8'));
    claim.tddEvidence.green.fingerprint.value = '0'.repeat(64);
    await writeFile(claimPath, `${JSON.stringify(claim, null, 2)}\n`);
    await git(['add', '.rig/claims/RP-306.json'], root);
    await git(['commit', '-q', '-m', 'mutate portable GREEN fingerprint'], root);

    const result = await verifyShip(
      root,
      await mkdtemp(path.join(tmpdir(), 'tdd-verdict-mutated-run-')),
      trackerEnv,
    );
    expect(result.code, result.out).toBe(2);
    expect(result.out).toMatch(/portable|TDD-2|fingerprint/i);
  });
});
