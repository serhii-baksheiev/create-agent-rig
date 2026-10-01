import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { jiraReadback } from './tdd-tracker-fixture.js';

// A GREEN must attest to the implementation delta that ships. Recording the
// boundary after an already-observed GREEN lets a later production mutation
// inherit a passing result that never exercised it.
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

const git = async (args: string[], cwd: string) => {
  const result = await run(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
    cwd,
  );
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
  return result.out.trim();
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

const runVitest = ({
  projectRoot,
  runDir,
  name,
  trackerEnv = process.env,
}: {
  projectRoot: string;
  runDir: string;
  name: string;
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
      path.join(projectRoot, 'vitest.config.mjs'),
      '--reporter=json',
      '--outputFile',
      path.join(runDir, resultName),
    ],
    projectRoot,
    { ...trackerEnv, RIG_RUN_DIR: runDir },
  );
};

const record = ({
  projectRoot,
  runDir,
  action,
  check,
  trackerEnv = process.env,
}: {
  projectRoot: string;
  runDir: string;
  action: string;
  check: string;
  trackerEnv?: NodeJS.ProcessEnv;
}) =>
  run(
    process.execPath,
    [tddEvidence, action, '--ticket', 'RP-306', '--check', check],
    projectRoot,
    { ...trackerEnv, RIG_RUN_DIR: runDir },
  );

const fixture = async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'tdd-green-order-'));
  const runDir = await mkdtemp(path.join(tmpdir(), 'tdd-green-order-run-'));
  await mkdir(path.join(projectRoot, '.rig'), { recursive: true });
  await mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await mkdir(path.join(projectRoot, 'test'), { recursive: true });
  await writeFile(
    path.join(projectRoot, '.rig', 'revalidation.json'),
    `${JSON.stringify(revalidationContract)}\n`,
  );
  await writeFile(
    path.join(projectRoot, 'src', 'feature.ts'),
    'export const feature = () => "old";\n',
  );
  await writeFile(
    path.join(projectRoot, 'test', 'feature.test.ts'),
    "import { feature } from '../src/feature.ts';\n\nit('returns new', () => expect(feature()).toBe('new'));\n",
  );
  await writeFile(
    path.join(projectRoot, 'vitest.config.mjs'),
    "export default { test: { include: ['test/**/*.test.ts'], globals: true } };\n",
  );
  await git(['init', '-q', '-b', 'master'], projectRoot);
  await git(['add', '.rig/revalidation.json', 'src/feature.ts'], projectRoot);
  await git(['commit', '-q', '-m', 'baseline'], projectRoot);
  const baselineHeadSha = await git(['rev-parse', 'HEAD'], projectRoot);
  await git(['checkout', '-q', '-b', 'feat/RP-306'], projectRoot);

  const claims = (await import(
    pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
  )) as {
    revalidateClaim: (input: Record<string, unknown>) => { result: string };
    recordClaimTransition: (input: Record<string, unknown>) => unknown;
  };
  const ticket = {
    id: 'RP-306',
    state: 'open' as const,
    title: 'change feature',
    body: 'rig:tdd-spec/v1 {"file":"test/feature.test.ts","fullName":"returns new"}',
    labels: [],
    blockedBy: [],
    blocks: [],
  };
  const trackerEnv = await jiraReadback({ projectRoot, ticket });
  expect(
    claims.revalidateClaim({
      projectRoot,
      ticket,
      point: 'SELECT',
      targetSha: baselineHeadSha,
      allowCreate: true,
    }).result,
  ).toBe('BASELINE_CREATED');
  claims.recordClaimTransition({
    projectRoot,
    ticket: { ...ticket, state: 'in-progress' },
    claimedState: 'in-progress',
  });

  const red = await runVitest({ projectRoot, runDir, name: 'unit-red', trackerEnv });
  expect(red.code, red.out).toBe(1);
  const recordedRed = await record({
    projectRoot,
    runDir,
    action: 'record-red',
    check: 'unit-red',
    trackerEnv,
  });
  expect(recordedRed.code, recordedRed.out).toBe(0);

  await writeFile(
    path.join(projectRoot, 'src', 'feature.ts'),
    'export const feature = () => "new";\n',
  );
  await git(['add', 'src/feature.ts'], projectRoot);
  await git(['commit', '-q', '-m', 'implementation A'], projectRoot);
  const green = await runVitest({ projectRoot, runDir, name: 'unit-green', trackerEnv });
  expect(green.code, green.out).toBe(0);

  await writeFile(
    path.join(projectRoot, 'src', 'feature.ts'),
    'export const feature = () => "changed after green";\n',
  );
  await git(['add', 'src/feature.ts'], projectRoot);
  await git(['commit', '-q', '-m', 'implementation B after green'], projectRoot);
  return { projectRoot, runDir, trackerEnv };
};

describe('RP-306 GREEN boundary ordering', () => {
  it('refuses a GREEN observed before the final production implementation delta', async () => {
    const { projectRoot, runDir, trackerEnv } = await fixture();
    const result = await record({
      projectRoot,
      runDir,
      action: 'record-green',
      check: 'unit-green',
      trackerEnv,
    });

    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(
      /GREEN[\s\S]{0,140}(?:boundary|implementation|commit)|(?:boundary|implementation|commit)[\s\S]{0,140}GREEN/i,
    );
    const claim = JSON.parse(
      await readFile(path.join(projectRoot, '.rig', 'claims', 'RP-306.json'), 'utf8'),
    );
    expect(claim.tddEvidence?.applicability?.level).toBe('TDD-1');
  });
});
