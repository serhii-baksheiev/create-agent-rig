import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { jiraReadback } from './tdd-tracker-fixture.js';

// A merged-default refresh may carry forward one already evidenced production
// delta. It must not certify production introduced by the merge itself, and it
// must import the next default from the previously validated default lineage.
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

const fetchOriginMaster = (root: string) =>
  git(['fetch', '-q', 'origin', '+refs/heads/master:refs/remotes/origin/master'], root);

const publishOriginMaster = async ({
  root,
  source = 'master',
  force = false,
}: {
  root: string;
  source?: string;
  force?: boolean;
}) => {
  await git(['push', '-q', ...(force ? ['--force'] : []), 'origin', `${source}:master`], root);
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
  run(process.execPath, [tddEvidence, action, '--ticket', 'RP-306', '--check', check], root, {
    ...trackerEnv,
    RIG_RUN_DIR: runDir,
  });

const setupInitialGreen = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tdd-baseline-refresh-authority-'));
  const runDir = await mkdtemp(path.join(tmpdir(), 'tdd-baseline-refresh-authority-run-'));
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
  await git(['checkout', '-q', '-b', 'feat/RP-306'], root);

  const claims = (await import(
    pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
  )) as {
    revalidateClaim: (input: Record<string, unknown>) => { result: string };
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
  await git(['commit', '-q', '-m', 'F1 evidenced feature implementation'], root);
  const green = await runVitest({ root, runDir, name: 'unit-green', trackerEnv });
  expect(green.code, green.out).toBe(0);
  expect(
    (await record({ root, runDir, action: 'record-green', check: 'unit-green', trackerEnv })).code,
  ).toBe(0);
  await git(['add', '.rig/claims/RP-306.json'], root);
  await git(['commit', '-q', '-m', 'track initial portable GREEN'], root);

  return { baseline, root, runDir, trackerEnv };
};

const defaultAdvance = async ({
  root,
  filename,
  value,
}: {
  root: string;
  filename: string;
  value: string;
}) => {
  await git(['checkout', '-q', 'master'], root);
  await writeFile(path.join(root, 'src', filename), `export const ${value} = true;\n`);
  await git(['add', path.join('src', filename)], root);
  await git(['commit', '-q', '-m', `default advance ${filename}`], root);
  const head = await git(['rev-parse', 'HEAD'], root);
  await publishOriginMaster({ root });
  return head;
};

const claimBytes = (root: string) => readFile(path.join(root, '.rig', 'claims', 'RP-306.json'));

describe('RP-306 merged-default refresh authority', () => {
  it('refuses a current default that the feature branch has not actually merged', async () => {
    const { root, runDir, trackerEnv } = await setupInitialGreen();
    await defaultAdvance({
      root,
      filename: 'unmerged-current-default.ts',
      value: 'unmergedCurrentDefault',
    });
    await git(['checkout', '-q', 'feat/RP-306'], root);

    const green = await runVitest({
      root,
      runDir,
      name: 'unit-green-unmerged-current-default',
      trackerEnv,
    });
    expect(green.code, green.out).toBe(0);
    const before = await claimBytes(root);
    const refreshed = await record({
      root,
      runDir,
      action: 'record-green',
      check: 'unit-green-unmerged-current-default',
      trackerEnv,
    });

    expect(refreshed.code, refreshed.out).toBe(1);
    expect(await claimBytes(root)).toEqual(before);
  });

  it('refuses a second refresh after the terminal merged-default history was tampered', async () => {
    const { baseline, root, runDir, trackerEnv } = await setupInitialGreen();
    await defaultAdvance({
      root,
      filename: 'first-tamper-default.ts',
      value: 'firstTamperDefault',
    });
    await git(['checkout', '-q', 'feat/RP-306'], root);
    await git(['merge', '--no-ff', '-m', 'merge first validated default', 'master'], root);
    const firstGreen = await runVitest({
      root,
      runDir,
      name: 'unit-green-first-tamper-default',
      trackerEnv,
    });
    expect(firstGreen.code, firstGreen.out).toBe(0);
    expect(
      (
        await record({
          root,
          runDir,
          action: 'record-green',
          check: 'unit-green-first-tamper-default',
          trackerEnv,
        })
      ).code,
    ).toBe(0);
    await git(['add', '.rig/claims/RP-306.json'], root);
    await git(['commit', '-q', '-m', 'track first validated default refresh'], root);

    const tampered = JSON.parse((await claimBytes(root)).toString('utf8'));
    tampered.tddEvidenceHistory.at(-1).transition.mergedDefaultSha = baseline;
    await writeFile(
      path.join(root, '.rig', 'claims', 'RP-306.json'),
      JSON.stringify(tampered, null, 2) + '\n',
    );
    await git(['add', '.rig/claims/RP-306.json'], root);
    await git(['commit', '-q', '-m', 'tamper terminal merged-default history'], root);

    await defaultAdvance({
      root,
      filename: 'second-tamper-default.ts',
      value: 'secondTamperDefault',
    });
    await git(['checkout', '-q', 'feat/RP-306'], root);
    await git(['merge', '--no-ff', '-m', 'merge second current default', 'master'], root);
    const green = await runVitest({
      root,
      runDir,
      name: 'unit-green-tampered-terminal-history',
      trackerEnv,
    });
    expect(green.code, green.out).toBe(0);
    const before = await claimBytes(root);
    const refreshed = await record({
      root,
      runDir,
      action: 'record-green',
      check: 'unit-green-tampered-terminal-history',
      trackerEnv,
    });

    expect(refreshed.code, refreshed.out).toBe(1);
    expect(await claimBytes(root)).toEqual(before);
  });

  it('refuses a refresh that adds new production only in the direct merge commit', async () => {
    const { root, runDir, trackerEnv } = await setupInitialGreen();
    await defaultAdvance({
      root,
      filename: 'default-advance.ts',
      value: 'defaultAdvance',
    });
    await git(['checkout', '-q', 'feat/RP-306'], root);
    await git(['merge', '--no-ff', '--no-commit', 'master'], root);
    await writeFile(
      path.join(root, 'src', 'introduced-by-merge.ts'),
      'export const introducedByMerge = true;\n',
    );
    await git(['add', 'src/introduced-by-merge.ts'], root);
    await git(['commit', '-q', '-m', 'merge current default with un-evidenced production'], root);

    const green = await runVitest({
      root,
      runDir,
      name: 'unit-green-merge-production',
      trackerEnv,
    });
    expect(green.code, green.out).toBe(0);
    const before = await claimBytes(root);
    const refreshed = await record({
      root,
      runDir,
      action: 'record-green',
      check: 'unit-green-merge-production',
      trackerEnv,
    });

    expect(refreshed.code, refreshed.out).toBe(1);
    expect(await claimBytes(root)).toEqual(before);
  });

  it('refuses a refresh when tracked production changes after a clean direct default merge', async () => {
    const { root, runDir, trackerEnv } = await setupInitialGreen();
    await defaultAdvance({
      root,
      filename: 'clean-default-advance.ts',
      value: 'cleanDefaultAdvance',
    });
    await git(['checkout', '-q', 'feat/RP-306'], root);
    await git(['merge', '--no-ff', '-m', 'clean direct default merge', 'master'], root);
    await writeFile(
      path.join(root, 'src', 'feature.ts'),
      'export const feature = () => "new";\nexport const dirtyWorkingTreeProduction = true;\n',
    );

    const green = await runVitest({
      root,
      runDir,
      name: 'unit-green-dirty-working-tree-production',
      trackerEnv,
    });
    expect(green.code, green.out).toBe(0);
    const before = await claimBytes(root);
    const refreshed = await record({
      root,
      runDir,
      action: 'record-green',
      check: 'unit-green-dirty-working-tree-production',
      trackerEnv,
    });

    expect(refreshed.code, refreshed.out).toBe(1);
    expect(await claimBytes(root)).toEqual(before);
  });

  it('refuses a sibling default that is descended from the selected baseline but not the prior validated default', async () => {
    const { baseline, root, runDir, trackerEnv } = await setupInitialGreen();
    await defaultAdvance({
      root,
      filename: 'first-default.ts',
      value: 'firstDefault',
    });
    await git(['checkout', '-q', 'feat/RP-306'], root);
    await git(['merge', '--no-ff', '-m', 'merge first validated default', 'master'], root);
    const firstGreen = await runVitest({
      root,
      runDir,
      name: 'unit-green-first-default',
      trackerEnv,
    });
    expect(firstGreen.code, firstGreen.out).toBe(0);
    expect(
      (
        await record({
          root,
          runDir,
          action: 'record-green',
          check: 'unit-green-first-default',
          trackerEnv,
        })
      ).code,
    ).toBe(0);
    await git(['add', '.rig/claims/RP-306.json'], root);
    await git(['commit', '-q', '-m', 'track first default refresh'], root);

    await git(['checkout', '-q', '-b', 'sibling-default', baseline], root);
    await writeFile(
      path.join(root, 'src', 'sibling-default.ts'),
      'export const siblingDefault = true;\n',
    );
    await git(['add', 'src/sibling-default.ts'], root);
    await git(['commit', '-q', '-m', 'sibling default advance'], root);
    await git(['checkout', '-q', 'feat/RP-306'], root);
    await git(['merge', '--no-ff', '-m', 'merge sibling default', 'sibling-default'], root);
    await publishOriginMaster({ root, source: 'sibling-default', force: true });

    const green = await runVitest({ root, runDir, name: 'unit-green-sibling-default', trackerEnv });
    expect(green.code, green.out).toBe(0);
    const before = await claimBytes(root);
    const refreshed = await record({
      root,
      runDir,
      action: 'record-green',
      check: 'unit-green-sibling-default',
      trackerEnv,
    });

    expect(refreshed.code, refreshed.out).toBe(1);
    expect(await claimBytes(root)).toEqual(before);
  });
});
