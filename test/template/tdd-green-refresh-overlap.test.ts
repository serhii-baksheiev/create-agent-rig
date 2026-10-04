import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { jiraReadback } from './tdd-tracker-fixture.js';

// RP-396 (Class B false HOLD): a clean direct `--no-ff` merge of the default
// branch that also touched the item's OWN production file in a disjoint hunk
// must still let a GREEN refresh through. `mergedDefaultRefresh` recomputes
// the working-tree production delta from the NEW default tip and requires it
// to reproduce the prior implementation boundary BYTE-FOR-BYTE
// (`--full-index` diff bytes, hashed). The foreign hunk changes the pre-image
// blob of the shared file even though the owned hunk's text is unchanged, so
// the two diffs' `index` lines differ and the refresh is wrongly refused.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const checkRun = path.join(scriptsDir, 'check-run.mjs');
const tddEvidence = path.join(scriptsDir, 'tdd-evidence.mjs');
const vitestCli = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const TICKET = 'RP-396';

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

const fetchOriginMaster = (root: string) =>
  git(['fetch', '-q', 'origin', '+refs/heads/master:refs/remotes/origin/master'], root);

const publishOriginMaster = async (root: string) => {
  await git(['push', '-q', 'origin', 'master:master'], root);
  await fetchOriginMaster(root);
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
  run(process.execPath, [tddEvidence, action, '--ticket', TICKET, '--check', check], root, {
    ...trackerEnv,
    RIG_RUN_DIR: runDir,
  });

// A ~20-line production file so the owned (top) and foreign (bottom) hunks
// sit well outside git's default 3-line context window and stay disjoint.
const featureLines = (line1: string) => {
  const lines = [line1];
  for (let n = 2; n <= 19; n += 1) lines.push(`export const line${n} = ${n};`);
  return `${lines.join('\n')}\n`;
};

const claimBytes = (root: string) => readFile(path.join(root, '.rig', 'claims', `${TICKET}.json`));

const setupInitialGreen = async (label: string) => {
  const root = await mkdtemp(path.join(tmpdir(), `tdd-green-refresh-overlap-${label}-`));
  const runDir = await mkdtemp(path.join(tmpdir(), `tdd-green-refresh-overlap-${label}-run-`));
  await mkdir(path.join(root, '.rig'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, '.rig', 'revalidation.json'), `${JSON.stringify(contract)}\n`);
  await writeFile(
    path.join(root, 'src', 'feature.ts'),
    featureLines('export const feature = () => "old";'),
  );
  await writeFile(
    path.join(root, 'test', 'feature.test.ts'),
    "import { feature } from '../src/feature.ts';\n\nit('returns new', () => expect(feature()).toBe('new'));\n",
  );
  await writeFile(
    path.join(root, 'vitest.config.mjs'),
    "export default { test: { include: ['test/**/*.test.ts'], globals: true } };\n",
  );
  await git(['init', '-q', '-b', 'master'], root);
  await git(['init', '--bare', '-q', path.join(root, 'origin.git')], root);
  await git(['remote', 'add', 'origin', path.join(root, 'origin.git')], root);
  await git(['add', '.rig/revalidation.json', 'src/feature.ts'], root);
  await git(['commit', '-q', '-m', 'B0 selected work baseline'], root);
  await git(['push', '-q', '--set-upstream', 'origin', 'master'], root);
  await fetchOriginMaster(root);
  const baseline = await git(['rev-parse', 'HEAD'], root);
  await git(['checkout', '-q', '-b', `feat/${TICKET}`], root);

  const claims = (await import(
    pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
  )) as {
    revalidateClaim: (input: Record<string, unknown>) => { result: string };
    recordClaimTransition: (input: Record<string, unknown>) => unknown;
  };
  const ticket = {
    id: TICKET,
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

  // Owned change near the TOP of the file.
  await writeFile(
    path.join(root, 'src', 'feature.ts'),
    featureLines('export const feature = () => "new";'),
  );
  await git(['add', 'src/feature.ts'], root);
  await git(['commit', '-q', '-m', 'F1 evidenced feature implementation'], root);
  const green = await runVitest({ root, runDir, name: 'unit-green', trackerEnv });
  expect(green.code, green.out).toBe(0);
  expect(
    (await record({ root, runDir, action: 'record-green', check: 'unit-green', trackerEnv })).code,
  ).toBe(0);
  await git(['add', `.rig/claims/${TICKET}.json`], root);
  await git(['commit', '-q', '-m', 'track initial portable GREEN'], root);

  return { baseline, root, runDir, trackerEnv };
};

// Advances origin/master with a FOREIGN change near the BOTTOM of the same
// src/feature.ts file — disjoint from the owned top hunk.
const foreignDefaultAdvance = async (root: string) => {
  await git(['checkout', '-q', 'master'], root);
  const current = await readFile(path.join(root, 'src', 'feature.ts'), 'utf8');
  const foreign = current.replace(
    'export const line19 = 19;',
    'export const line19 = 19000; // foreign disjoint bottom change',
  );
  expect(foreign).not.toBe(current);
  await writeFile(path.join(root, 'src', 'feature.ts'), foreign);
  await git(['add', 'src/feature.ts'], root);
  await git(['commit', '-q', '-m', 'M1 foreign disjoint bottom change'], root);
  const head = await git(['rev-parse', 'HEAD'], root);
  await publishOriginMaster(root);
  return head;
};

it("refreshes GREEN after a clean direct default merge that also changed the item's own production file", async () => {
  const { root, runDir, trackerEnv } = await setupInitialGreen('clean');
  const defaultAdvanceSha = await foreignDefaultAdvance(root);
  await git(['checkout', '-q', `feat/${TICKET}`], root);
  await git(['merge', '--no-ff', '-m', 'clean direct default merge', 'master'], root);
  expect(await git(['rev-parse', 'HEAD^2'], root)).toBe(defaultAdvanceSha);

  const green = await runVitest({
    root,
    runDir,
    name: 'unit-green-overlap-merge',
    trackerEnv,
  });
  expect(green.code, green.out).toBe(0);
  const refreshed = await record({
    root,
    runDir,
    action: 'record-green',
    check: 'unit-green-overlap-merge',
    trackerEnv,
  });

  expect(refreshed.code, refreshed.out).toBe(0);
  const claim = JSON.parse((await claimBytes(root)).toString('utf8'));
  expect(claim.tddEvidenceHistory).toHaveLength(1);
  expect(claim.tddEvidenceHistory[0].transition.mergedDefaultSha).toBe(defaultAdvanceSha);
  await git(['add', `.rig/claims/${TICKET}.json`], root);
  await git(['commit', '-q', '-m', 'refresh GREEN across overlapping default merge'], root);

  const ship = await run(
    process.execPath,
    [tddEvidence, 'verify-ship', '--ticket', TICKET, '--base', 'master'],
    root,
    { ...trackerEnv, RIG_RUN_DIR: runDir },
  );
  expect(ship.code, ship.out).toBe(0);
});

it("still refuses a merge commit that adds a manual production edit to the item's own file", async () => {
  const { root, runDir, trackerEnv } = await setupInitialGreen('tampered');
  await foreignDefaultAdvance(root);
  await git(['checkout', '-q', `feat/${TICKET}`], root);
  await git(['merge', '--no-ff', '--no-commit', 'master'], root);
  const merged = await readFile(path.join(root, 'src', 'feature.ts'), 'utf8');
  await writeFile(
    path.join(root, 'src', 'feature.ts'),
    merged.replace(
      'export const line10 = 10;',
      'export const line10 = 10000; // manual edit added in the merge commit',
    ),
  );
  await git(['add', 'src/feature.ts'], root);
  await git(['commit', '-q', '-m', 'merge current default with a manual production edit'], root);

  const green = await runVitest({
    root,
    runDir,
    name: 'unit-green-overlap-merge-manual-edit',
    trackerEnv,
  });
  expect(green.code, green.out).toBe(0);
  const before = await claimBytes(root);
  const refreshed = await record({
    root,
    runDir,
    action: 'record-green',
    check: 'unit-green-overlap-merge-manual-edit',
    trackerEnv,
  });

  expect(refreshed.code, refreshed.out).toBe(1);
  expect(await claimBytes(root)).toEqual(before);
});
