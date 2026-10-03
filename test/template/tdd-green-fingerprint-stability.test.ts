import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { jiraReadback } from './tdd-tracker-fixture.js';

// Git may abbreviate object IDs differently in a diff depending on local
// configuration. Evidence fingerprints describe bytes, so their value must
// not depend on that presentation setting.
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
  trackerEnv,
}: {
  projectRoot: string;
  runDir: string;
  trackerEnv: NodeJS.ProcessEnv;
}) => {
  const resultName = 'unit-green.json';
  return run(
    process.execPath,
    [
      checkRun,
      '--name',
      'unit-green',
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
  trackerEnv,
}: {
  projectRoot: string;
  runDir: string;
  action: 'record-red' | 'record-green';
  check: string;
  trackerEnv: NodeJS.ProcessEnv;
}) =>
  run(
    process.execPath,
    [tddEvidence, action, '--ticket', 'RP-336', '--check', check],
    projectRoot,
    { ...trackerEnv, RIG_RUN_DIR: runDir },
  );

const createBaseline = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tdd-green-fingerprint-base-'));
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
  return root;
};

const greenEvidence = async ({
  baseline,
  abbrev,
  marker,
}: {
  baseline: string;
  abbrev: number;
  marker: string;
}) => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'tdd-green-fingerprint-worktree-'));
  const runDir = await mkdtemp(path.join(tmpdir(), 'tdd-green-fingerprint-run-'));
  await git(['clone', '-q', baseline, projectRoot], baseline);
  await git(['checkout', '-q', '-b', `feat/RP-336-${abbrev}-${marker}`], projectRoot);
  const baselineHeadSha = await git(['rev-parse', 'HEAD'], projectRoot);
  await git(['config', 'core.abbrev', String(abbrev)], projectRoot);

  await mkdir(path.join(projectRoot, 'test'), { recursive: true });
  await writeFile(
    path.join(projectRoot, 'test', 'feature.test.ts'),
    "import { feature } from '../src/feature.ts';\n\nit('returns new', () => expect(feature()).toBe('new'));\n",
  );
  await writeFile(
    path.join(projectRoot, 'vitest.config.mjs'),
    "export default { test: { include: ['test/**/*.test.ts'], globals: true } };\n",
  );

  const claims = (await import(
    pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
  )) as {
    revalidateClaim: (input: Record<string, unknown>) => { result: string };
    recordClaimTransition: (input: Record<string, unknown>) => unknown;
  };
  const ticket = {
    id: 'RP-336',
    state: 'open' as const,
    title: 'stable GREEN fingerprints',
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

  const red = await runVitest({ projectRoot, runDir, trackerEnv });
  expect(red.code, red.out).toBe(1);
  const recordedRed = await record({
    projectRoot,
    runDir,
    action: 'record-red',
    check: 'unit-green',
    trackerEnv,
  });
  expect(recordedRed.code, recordedRed.out).toBe(0);

  await writeFile(
    path.join(projectRoot, 'src', 'feature.ts'),
    `export const feature = () => "new";\nexport const marker = "${marker}";\n`,
  );
  const green = await runVitest({ projectRoot, runDir, trackerEnv });
  expect(green.code, green.out).toBe(0);
  const recordedGreen = await record({
    projectRoot,
    runDir,
    action: 'record-green',
    check: 'unit-green',
    trackerEnv,
  });
  expect(recordedGreen.code, recordedGreen.out).toBe(0);

  const claim = JSON.parse(
    await readFile(path.join(projectRoot, '.rig', 'claims', 'RP-336.json'), 'utf8'),
  ) as {
    tddEvidence: { implementationBoundary: { implementationDeltaFingerprint: { value: string } } };
  };
  const journal = (await import(pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href)) as {
    readRun: (input: { runDir: string }) => {
      events: Array<{
        kind?: string;
        data?: { name?: string; outcome?: string; workingTreeDiff?: { value?: string } };
      }>;
    };
  };
  const check = journal
    .readRun({ runDir })
    .events.slice()
    .reverse()
    .find(
      (event) =>
        event.kind === 'check-result' &&
        event.data?.name === 'unit-green' &&
        event.data?.outcome === 'pass',
    );
  expect(check?.data?.workingTreeDiff?.value).toMatch(/^[a-f0-9]{64}$/);

  return {
    implementationDelta:
      claim.tddEvidence.implementationBoundary.implementationDeltaFingerprint.value,
    workingTreeDiff: check?.data?.workingTreeDiff?.value,
  };
};

describe('RP-336 stable GREEN fingerprint inputs', () => {
  it('records identical working-tree and implementation deltas across Git abbreviation settings, while content changes differ', async () => {
    const baseline = await createBaseline();
    const [abbreviated, longer, mutated] = await Promise.all([
      greenEvidence({ baseline, abbrev: 7, marker: 'same' }),
      greenEvidence({ baseline, abbrev: 8, marker: 'same' }),
      greenEvidence({ baseline, abbrev: 7, marker: 'different' }),
    ]);

    expect(abbreviated.workingTreeDiff).toBe(longer.workingTreeDiff);
    expect(abbreviated.implementationDelta).toBe(longer.implementationDelta);
    expect(mutated.workingTreeDiff).not.toBe(abbreviated.workingTreeDiff);
    expect(mutated.implementationDelta).not.toBe(abbreviated.implementationDelta);
  });
});
