import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { jiraReadback } from './tdd-tracker-fixture.js';

// The durable PR/Jira verdict cannot point only to an ignored run journal: a
// fresh controller needs the exact portable TDD chain in verify-ship's output.
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
  trackerEnv,
}: {
  name: string;
  projectRoot: string;
  runDir: string;
  trackerEnv: NodeJS.ProcessEnv;
}) =>
  run(
    process.execPath,
    [
      checkRun,
      '--name',
      name,
      '--vitest-json',
      `${name}.json`,
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
      path.join(runDir, `${name}.json`),
    ],
    projectRoot,
    { ...trackerEnv, RIG_RUN_DIR: runDir },
  );

const record = ({
  action,
  projectRoot,
  runDir,
  check,
  trackerEnv,
}: {
  action: 'record-red' | 'record-green';
  projectRoot: string;
  runDir: string;
  check: string;
  trackerEnv: NodeJS.ProcessEnv;
}) =>
  run(
    process.execPath,
    [tddEvidence, action, '--ticket', 'RP-306', '--check', check],
    projectRoot,
    { ...trackerEnv, RIG_RUN_DIR: runDir },
  );

describe('RP-306 durable shipping verdict', () => {
  it('prints the exact portable RED, implementation-boundary, and GREEN fingerprints on a TDD-2 PASS', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'tdd-durable-verdict-'));
    const runDir = await mkdtemp(path.join(tmpdir(), 'tdd-durable-verdict-run-'));
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
      "import { feature } from '../src/feature.ts';\n\nit('returns replacement', () => expect(feature()).toBe('new'));\n",
    );
    await writeFile(
      path.join(projectRoot, 'vitest.config.mjs'),
      "export default { test: { include: ['test/**/*.test.ts'], globals: true } };\n",
    );
    await git(['init', '-q', '-b', 'master'], projectRoot);
    await git(['add', '.rig/revalidation.json', 'src/feature.ts'], projectRoot);
    await git(['commit', '-q', '-m', 'selected work baseline'], projectRoot);
    const baselineHeadSha = await git(['rev-parse', 'HEAD'], projectRoot);
    await git(['checkout', '-q', '-b', 'feat/RP-306'], projectRoot);

    const ticket = {
      id: 'RP-306',
      state: 'open' as const,
      title: 'feature change',
      body: 'rig:tdd-spec/v1 {"file":"test/feature.test.ts","fullName":"returns replacement"}',
      labels: [],
      blockedBy: [],
      blocks: [],
    };
    const claims = (await import(
      pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
    )) as {
      revalidateClaim: (input: Record<string, unknown>) => { result: string };
    };
    expect(
      claims.revalidateClaim({
        projectRoot,
        ticket,
        point: 'SELECT',
        targetSha: baselineHeadSha,
        allowCreate: true,
      }).result,
    ).toBe('BASELINE_CREATED');
    const trackerEnv = await jiraReadback({ projectRoot, ticket });

    const red = await runVitestCheck({ name: 'red', projectRoot, runDir, trackerEnv });
    expect(red.code, red.out).toBe(1);
    const redRecord = await record({
      action: 'record-red',
      projectRoot,
      runDir,
      check: 'red',
      trackerEnv,
    });
    expect(redRecord.code, redRecord.out).toBe(0);

    await writeFile(
      path.join(projectRoot, 'src', 'feature.ts'),
      'export const feature = () => "new";\n',
    );
    await git(['add', 'src/feature.ts'], projectRoot);
    await git(['commit', '-q', '-m', 'implement feature'], projectRoot);
    const green = await runVitestCheck({ name: 'green', projectRoot, runDir, trackerEnv });
    expect(green.code, green.out).toBe(0);
    const greenRecord = await record({
      action: 'record-green',
      projectRoot,
      runDir,
      check: 'green',
      trackerEnv,
    });
    expect(greenRecord.code, greenRecord.out).toBe(0);

    await git(['add', '.rig/claims/RP-306.json'], projectRoot);
    await git(['commit', '-q', '-m', 'track portable evidence'], projectRoot);
    const claim = JSON.parse(
      await readFile(path.join(projectRoot, '.rig', 'claims', 'RP-306.json'), 'utf8'),
    ) as {
      tddEvidence: {
        red: { fingerprint: { value: string } };
        implementationBoundary: { fingerprint: { value: string } };
        green: { fingerprint: { value: string } };
      };
    };

    const verdict = await run(
      process.execPath,
      [tddEvidence, 'verify-ship', '--ticket', 'RP-306', '--base', 'master'],
      projectRoot,
      { ...trackerEnv, RIG_RUN_DIR: await mkdtemp(path.join(tmpdir(), 'tdd-durable-ship-run-')) },
    );
    expect(verdict.code, verdict.out).toBe(0);
    expect(verdict.stdout).toContain(claim.tddEvidence.red.fingerprint.value);
    expect(verdict.stdout).toContain(claim.tddEvidence.implementationBoundary.fingerprint.value);
    expect(verdict.stdout).toContain(claim.tddEvidence.green.fingerprint.value);
  });
});
