import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { jiraReadback } from './tdd-tracker-fixture.js';

// RP-306 evidence is bound to the selected-work baseline, not to a moving
// master ref. A controller can merge a disjoint master advance and retain the
// same item evidence; its separate BEFORE_PR HOLD still requires a typed outcome.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const checkRun = path.join(scriptsDir, 'check-run.mjs');
const tddEvidence = path.join(scriptsDir, 'tdd-evidence.mjs');
const vitestCli = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');

type Result = { code: number; out: string };
type Revalidation = { result: string; action: string };

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

const runVitest = ({
  root,
  runDir,
  name,
  trackerEnv = process.env,
}: {
  root: string;
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
  trackerEnv = process.env,
}: {
  root: string;
  runDir: string;
  action: string;
  check: string;
  trackerEnv?: NodeJS.ProcessEnv;
}) =>
  run(process.execPath, [tddEvidence, action, '--ticket', 'RP-306', '--check', check], root, {
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

describe('RP-306 portable baseline continuation', () => {
  it('refreshes TDD-2 GREEN after a verified merged master advance without attributing its production delta', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tdd-baseline-continuation-'));
    const runDir = await mkdtemp(path.join(tmpdir(), 'tdd-baseline-continuation-run-'));
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
    await git(['commit', '-q', '-m', 'B0 selected work baseline'], root);
    const baseline = await git(['rev-parse', 'HEAD'], root);
    await git(['checkout', '-q', '-b', 'feat/RP-306'], root);

    const claims = (await import(
      pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
    )) as {
      revalidateClaim: (input: Record<string, unknown>) => Revalidation;
      recordClaimTransition: (input: Record<string, unknown>) => unknown;
    };
    const ticket = {
      id: 'RP-306',
      state: 'open' as const,
      title: 'feature change',
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

    const red = await runVitest({ root, runDir, name: 'unit-red', trackerEnv });
    expect(red.code, red.out).toBe(1);
    expect(
      (await record({ root, runDir, action: 'record-red', check: 'unit-red', trackerEnv })).code,
    ).toBe(0);
    await writeFile(path.join(root, 'src', 'feature.ts'), 'export const feature = () => "new";\n');
    await git(['add', 'src/feature.ts'], root);
    await git(['commit', '-q', '-m', 'F1 feature implementation'], root);
    const green = await runVitest({ root, runDir, name: 'unit-green', trackerEnv });
    expect(green.code, green.out).toBe(0);
    expect(
      (await record({ root, runDir, action: 'record-green', check: 'unit-green', trackerEnv }))
        .code,
    ).toBe(0);
    await git(['add', '.rig/claims/RP-306.json'], root);
    await git(['commit', '-q', '-m', 'track RP-306 portable TDD evidence'], root);

    await git(['checkout', '-q', 'master'], root);
    await writeFile(
      path.join(root, 'src', 'rp325.ts'),
      'export const rp325 = () => "independent";\n',
    );
    await git(['add', 'src/rp325.ts'], root);
    await git(['commit', '-q', '-m', 'M1 disjoint RP-325 advance'], root);
    const masterAdvance = await git(['rev-parse', 'HEAD'], root);
    await git(['checkout', '-q', 'feat/RP-306'], root);
    await git(['merge', '--no-ff', '-m', 'merge current master', 'master'], root);

    const revalidated = claims.revalidateClaim({
      projectRoot: root,
      ticket: { ...ticket, state: 'in-progress' },
      point: 'BEFORE_PR',
      targetSha: masterAdvance,
    });
    expect(revalidated).toMatchObject({ result: 'CHANGED', action: 'hold' });

    // The selected baseline remains B0, but a new GREEN after the verified
    // master merge must bind only F1. M1 is already in the shipping base.
    const refreshedGreen = await runVitest({ root, runDir, name: 'unit-green', trackerEnv });
    expect(refreshedGreen.code, refreshedGreen.out).toBe(0);
    expect(
      (await record({ root, runDir, action: 'record-green', check: 'unit-green', trackerEnv }))
        .code,
    ).toBe(0);
    await git(['add', '.rig/claims/RP-306.json'], root);
    await git(['commit', '-q', '-m', 'refresh GREEN after merged master advance'], root);

    const ship = await run(
      process.execPath,
      [tddEvidence, 'verify-ship', '--ticket', 'RP-306', '--base', 'master'],
      root,
      {
        ...trackerEnv,
        RIG_RUN_DIR: await mkdtemp(path.join(tmpdir(), 'tdd-baseline-resume-run-')),
      },
    );
    expect(ship.code, ship.out).toBe(0);
    expect(ship.out).toMatch(/TDD-2|portable/i);
  });
});
