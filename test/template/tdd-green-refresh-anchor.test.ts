import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { jiraReadback } from './tdd-tracker-fixture.js';

// RP-396 review round 1 (B1, Class A false SHIP): `mergedDefaultRefresh`
// checks that the merge commit is the MECHANICAL merge of its two parents
// via `git merge-tree --write-tree <priorHead> <defaultHead>` — but
// `merge-tree` picks its OWN merge base from commit ancestry, which is never
// required to equal `priorDefault` (the point the prior boundary was
// measured from: the selected baseline, or the last VALIDATED merged-default
// refresh). Ordinary history reproduces it: the item does its initial
// RED -> GREEN at baseline B0; the default then adds `src/r.ts` (commit Y);
// the item merges Y directly with no GREEN refresh recorded; the item then
// commits `git rm src/r.ts` on its own branch; the default advances to D
// (an unrelated change, D does not touch r.ts); the item merges D — this
// merge's own computed base is Y (common ancestor of the rm commit and D),
// so it is clean and r.ts stays deleted. Helpers below are copied from
// `test/template/tdd-green-refresh-overlap.test.ts` rather than imported, so
// that file's recorded-evidence bytes stay untouched.
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

const claimBytes = (root: string) => readFile(path.join(root, '.rig', 'claims', `${TICKET}.json`));

const setupInitialGreen = async (label: string) => {
  const root = await mkdtemp(path.join(tmpdir(), `tdd-green-refresh-anchor-${label}-`));
  const runDir = await mkdtemp(path.join(tmpdir(), `tdd-green-refresh-anchor-${label}-run-`));
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

  await writeFile(path.join(root, 'src', 'feature.ts'), 'export const feature = () => "new";\n');
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

it('refuses a refresh whose merge base is not the prior validated default', async () => {
  const { root, runDir, trackerEnv } = await setupInitialGreen('base');

  // Default adds src/r.ts (commit Y).
  await git(['checkout', '-q', 'master'], root);
  await writeFile(path.join(root, 'src', 'r.ts'), 'export const r = 1;\n');
  await git(['add', 'src/r.ts'], root);
  await git(['commit', '-q', '-m', 'Y default adds src/r.ts'], root);
  await publishOriginMaster(root);

  // The item merges Y directly — no GREEN refresh recorded for this merge.
  await git(['checkout', '-q', `feat/${TICKET}`], root);
  await git(['merge', '-q', '--no-ff', '-m', 'merge Y (no refresh recorded)', 'master'], root);

  // The item then removes the default-branch file on its own branch.
  await git(['rm', '-q', 'src/r.ts'], root);
  await git(['commit', '-q', '-m', 'remove src/r.ts after merging Y'], root);

  // The default advances to D — an unrelated change that does not touch r.ts.
  await git(['checkout', '-q', 'master'], root);
  await writeFile(path.join(root, 'src', 'other.ts'), 'export const other = 1;\n');
  await git(['add', 'src/other.ts'], root);
  await git(['commit', '-q', '-m', 'D unrelated default advance'], root);
  await publishOriginMaster(root);

  // The item merges D — clean, because the merge's own computed base is Y.
  await git(['checkout', '-q', `feat/${TICKET}`], root);
  await git(['merge', '-q', '--no-ff', '-m', 'merge D', 'master'], root);

  const green = await runVitest({ root, runDir, name: 'unit-green-anchor', trackerEnv });
  expect(green.code, green.out).toBe(0);

  const before = await claimBytes(root);
  const refreshed = await record({
    root,
    runDir,
    action: 'record-green',
    check: 'unit-green-anchor',
    trackerEnv,
  });

  expect(refreshed.code, refreshed.out).toBe(1);
  expect(await claimBytes(root)).toEqual(before);
});

it('refuses a refresh while a tracked production edit is left uncommitted on top of a clean merge', async () => {
  const { root, runDir, trackerEnv } = await setupInitialGreen('uncommitted');

  // Default advances with a disjoint, unrelated change (clean overlap).
  await git(['checkout', '-q', 'master'], root);
  await writeFile(path.join(root, 'src', 'other.ts'), 'export const other = 1;\n');
  await git(['add', 'src/other.ts'], root);
  await git(['commit', '-q', '-m', 'M1 unrelated default advance'], root);
  await publishOriginMaster(root);

  await git(['checkout', '-q', `feat/${TICKET}`], root);
  await git(['merge', '-q', '--no-ff', '-m', 'clean direct default merge', 'master'], root);

  // A tracked production edit is left uncommitted on top of the merge,
  // BEFORE the fresh PASS run — so the recorded check's own observed
  // working-tree delta already reflects it, and the refusal below is
  // `noUncommittedProductionChange`'s, not an earlier working-tree mismatch.
  await writeFile(
    path.join(root, 'src', 'feature.ts'),
    'export const feature = () => "new";\nexport const untracked = true;\n',
  );

  const green = await runVitest({ root, runDir, name: 'unit-green-uncommitted', trackerEnv });
  expect(green.code, green.out).toBe(0);

  const before = await claimBytes(root);
  const refreshed = await record({
    root,
    runDir,
    action: 'record-green',
    check: 'unit-green-uncommitted',
    trackerEnv,
  });

  expect(refreshed.code, refreshed.out).toBe(1);
  expect(await claimBytes(root)).toEqual(before);
});
