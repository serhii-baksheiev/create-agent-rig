import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { jiraReadback } from './tdd-tracker-fixture.js';

// A selected-work baseline stays fixed while each verified default merge moves
// the production-delta base forward. Every retained transition binds that fixed
// selection to the particular default head it imported.
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

const fetchOriginMaster = (root: string) =>
  git(['fetch', '-q', 'origin', '+refs/heads/master:refs/remotes/origin/master'], root);

const publishOriginMaster = async (root: string) => {
  await git(['push', '-q', 'origin', 'master:master'], root);
  await fetchOriginMaster(root);
};

const deleteOriginMaster = async (root: string) => {
  await git(['push', '-q', 'origin', '--delete', 'master'], root);
  await git(['update-ref', '-d', 'refs/remotes/origin/master'], root);
};

const publishDivergentOriginMain = async ({
  root,
  baseline,
}: {
  root: string;
  baseline: string;
}) => {
  await git(['push', '-q', 'origin', 'master:master', `${baseline}:refs/heads/main`], root);
  await fetchOriginMaster(root);
  await git(['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main'], root);
};

const deleteOriginMain = async (root: string) => {
  await git(['push', '-q', 'origin', '--delete', 'main'], root);
  await git(['update-ref', '-d', 'refs/remotes/origin/main'], root);
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
  it('refreshes TDD-2 GREEN across two verified merged default advances without attributing either production delta', async () => {
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
    await git(['init', '--bare', '-q', path.join(root, 'origin.git')], root);
    await git(
      [
        '--git-dir',
        path.join(root, 'origin.git'),
        'symbolic-ref',
        'HEAD',
        'refs/heads/fixture-default',
      ],
      root,
    );
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
    const originalRedClaim = JSON.parse(
      await readFile(path.join(root, '.rig', 'claims', 'RP-306.json'), 'utf8'),
    );
    const originalRed = originalRedClaim.tddEvidence.red;
    await writeFile(
      path.join(root, 'test', 'feature.test.ts'),
      "// retained relevant spec after a comment-only refresh\nimport { feature } from '../src/feature.ts';\n\nit('returns new', () => expect(feature()).toBe('new'));\n",
    );
    const replacementRed = await runVitest({
      root,
      runDir,
      name: 'unit-red-after-comment-refresh',
      trackerEnv,
    });
    expect(replacementRed.code, replacementRed.out).toBe(1);
    const recordReplacementRed = await record({
      root,
      runDir,
      action: 'record-red',
      check: 'unit-red-after-comment-refresh',
      trackerEnv,
    });
    expect(recordReplacementRed.code, recordReplacementRed.out).toBe(0);
    const replacementRedClaim = JSON.parse(
      await readFile(path.join(root, '.rig', 'claims', 'RP-306.json'), 'utf8'),
    );
    expect(replacementRedClaim.fingerprints.scope.targetSha).toBe(baseline);
    expect(replacementRedClaim.tddEvidence.red.test).toMatchObject({
      file: originalRed.test.file,
      fullName: originalRed.test.fullName,
    });
    expect(replacementRedClaim.tddEvidence.red.test.fileSha256).not.toBe(
      originalRed.test.fileSha256,
    );
    expect(replacementRedClaim.tddEvidenceHistory).toHaveLength(1);
    expect(replacementRedClaim.tddEvidenceHistory[0].evidence.red).toEqual(originalRed);
    expect(replacementRedClaim.tddEvidenceHistory[0].transition).toMatchObject({
      priorRedFingerprint: originalRed.fingerprint,
      replacementRedFingerprint: replacementRedClaim.tddEvidence.red.fingerprint,
    });
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

    const initialClaim = JSON.parse(
      await readFile(path.join(root, '.rig', 'claims', 'RP-306.json'), 'utf8'),
    );
    const implementationDelta =
      initialClaim.tddEvidence.implementationBoundary.implementationDeltaFingerprint;
    expect(initialClaim.fingerprints.scope.targetSha).toBe(baseline);
    expect(initialClaim.tddEvidence.baseline.headSha).toBe(baseline);
    expect(initialClaim.tddEvidence.red).toEqual(replacementRedClaim.tddEvidence.red);
    expect(initialClaim.tddEvidenceHistory[0].evidence.red).toEqual(originalRed);

    await git(['checkout', '-q', 'master'], root);
    await writeFile(
      path.join(root, 'src', 'rp325.ts'),
      'export const rp325 = () => "independent";\n',
    );
    await git(['add', 'src/rp325.ts'], root);
    await git(['commit', '-q', '-m', 'M1 disjoint RP-325 advance'], root);
    await publishOriginMaster(root);
    const firstDefaultAdvance = await git(['rev-parse', 'HEAD'], root);
    await git(['checkout', '-q', 'feat/RP-306'], root);
    await git(['merge', '--no-ff', '-m', 'merge current master', 'master'], root);
    expect(await git(['rev-parse', 'HEAD^2'], root)).toBe(firstDefaultAdvance);

    const revalidated = claims.revalidateClaim({
      projectRoot: root,
      ticket: { ...ticket, state: 'in-progress' },
      point: 'BEFORE_PR',
      targetSha: firstDefaultAdvance,
    });
    expect(revalidated).toMatchObject({ result: 'CHANGED', action: 'hold' });

    // The fully-qualified remote default is the only acceptable first refresh
    // target; a same-spelled local tag must not shadow it.
    await git(['tag', '-f', 'origin/master', baseline], root);

    const firstRefreshedGreen = await runVitest({
      root,
      runDir,
      name: 'unit-green-first-refresh',
      trackerEnv,
    });
    expect(firstRefreshedGreen.code, firstRefreshedGreen.out).toBe(0);
    const firstRefresh = await record({
      root,
      runDir,
      action: 'record-green',
      check: 'unit-green-first-refresh',
      trackerEnv,
    });
    expect(firstRefresh.code, firstRefresh.out).toBe(0);
    await git(['add', '.rig/claims/RP-306.json'], root);
    await git(['commit', '-q', '-m', 'refresh GREEN after first merged default advance'], root);

    const firstRefreshClaim = JSON.parse(
      await readFile(path.join(root, '.rig', 'claims', 'RP-306.json'), 'utf8'),
    );
    expect(firstRefreshClaim.fingerprints.scope.targetSha).toBe(baseline);
    expect(firstRefreshClaim.tddEvidence.baseline.headSha).toBe(baseline);
    expect(firstRefreshClaim.tddEvidence.red.test).toEqual(initialClaim.tddEvidence.red.test);
    expect(
      firstRefreshClaim.tddEvidence.implementationBoundary.implementationDeltaFingerprint,
    ).toEqual(implementationDelta);
    expect(firstRefreshClaim.tddEvidenceHistory).toHaveLength(2);
    expect(firstRefreshClaim.tddEvidenceHistory[0].evidence.red).toEqual(originalRed);
    expect(firstRefreshClaim.tddEvidenceHistory[0].transition).toMatchObject({
      priorRedFingerprint: originalRed.fingerprint,
      replacementRedFingerprint: initialClaim.tddEvidence.red.fingerprint,
    });
    expect(firstRefreshClaim.tddEvidenceHistory[1].evidence.green.fingerprint).toEqual(
      initialClaim.tddEvidence.green.fingerprint,
    );
    expect(firstRefreshClaim.tddEvidenceHistory[1].transition).toMatchObject({
      mergedDefaultSha: firstDefaultAdvance,
      priorGreenFingerprint: initialClaim.tddEvidence.green.fingerprint,
      replacementGreenFingerprint: firstRefreshClaim.tddEvidence.green.fingerprint,
      priorImplementationBoundaryFingerprint:
        initialClaim.tddEvidence.implementationBoundary.fingerprint,
      replacementImplementationBoundaryFingerprint:
        firstRefreshClaim.tddEvidence.implementationBoundary.fingerprint,
    });

    await git(['checkout', '-q', 'master'], root);
    await writeFile(
      path.join(root, 'src', 'rp350.ts'),
      'export const rp350 = () => "another independent default change";\n',
    );
    await git(['add', 'src/rp350.ts'], root);
    await git(['commit', '-q', '-m', 'M2 disjoint RP-350 advance'], root);
    await publishOriginMaster(root);
    const secondDefaultAdvance = await git(['rev-parse', 'HEAD'], root);
    await git(['checkout', '-q', 'feat/RP-306'], root);
    await git(['merge', '--no-ff', '-m', 'merge next current master', 'master'], root);
    expect(await git(['rev-parse', 'HEAD^2'], root)).toBe(secondDefaultAdvance);

    // This is the one fresh native PASS for the unchanged post-merge source
    // boundary. The two authority probes below only alter remote refs: they
    // deliberately reuse this receipt rather than pay three identical Vitest
    // startups under one 15 s dependent workflow.
    const secondBoundaryGreen = await runVitest({
      root,
      runDir,
      name: 'unit-green-second-merged-boundary',
      trackerEnv,
    });
    expect(secondBoundaryGreen.code, secondBoundaryGreen.out).toBe(0);

    // A configured remote with no trustworthy remote target must fail closed:
    // the local default advance and a local tag are not substitutes for it.
    await deleteOriginMaster(root);
    const missingDefaultRefresh = await record({
      root,
      runDir,
      action: 'record-green',
      check: 'unit-green-second-merged-boundary',
      trackerEnv,
    });
    expect(missingDefaultRefresh.code, missingDefaultRefresh.out).toBe(1);
    expect(missingDefaultRefresh.out).toMatch(/default|resolve/i);

    // Divergent remote candidates remain unsafe when origin/HEAD is absent.
    await publishDivergentOriginMain({ root, baseline });
    const ambiguousDefaultRefresh = await record({
      root,
      runDir,
      action: 'record-green',
      check: 'unit-green-second-merged-boundary',
      trackerEnv,
    });
    expect(ambiguousDefaultRefresh.code, ambiguousDefaultRefresh.out).toBe(1);
    expect(ambiguousDefaultRefresh.out).toMatch(/default|resolve|ambiguous/i);

    await deleteOriginMain(root);
    expect(await git(['rev-parse', 'refs/remotes/origin/master'], root)).toBe(secondDefaultAdvance);

    expect(
      (
        await record({
          root,
          runDir,
          action: 'record-green',
          check: 'unit-green-second-merged-boundary',
          trackerEnv,
        })
      ).code,
    ).toBe(0);
    await git(['add', '.rig/claims/RP-306.json'], root);
    await git(['commit', '-q', '-m', 'refresh GREEN after second merged default advance'], root);

    const terminalClaim = JSON.parse(
      await readFile(path.join(root, '.rig', 'claims', 'RP-306.json'), 'utf8'),
    );
    expect(terminalClaim.fingerprints.scope.targetSha).toBe(baseline);
    expect(terminalClaim.tddEvidence.baseline.headSha).toBe(baseline);
    expect(terminalClaim.tddEvidence.red.test).toEqual(initialClaim.tddEvidence.red.test);
    // Both M1 and M2 are imported bases. The only implementation delta is F1.
    expect(terminalClaim.tddEvidence.implementationBoundary.implementationDeltaFingerprint).toEqual(
      implementationDelta,
    );
    expect(terminalClaim.tddEvidenceHistory).toHaveLength(3);
    expect(terminalClaim.tddEvidenceHistory[0].evidence.red).toEqual(originalRed);
    expect(terminalClaim.tddEvidenceHistory[0].transition).toMatchObject({
      priorRedFingerprint: originalRed.fingerprint,
      replacementRedFingerprint: initialClaim.tddEvidence.red.fingerprint,
    });
    expect(terminalClaim.tddEvidenceHistory[1].evidence.green.fingerprint).toEqual(
      initialClaim.tddEvidence.green.fingerprint,
    );
    expect(terminalClaim.tddEvidenceHistory[2].evidence.green.fingerprint).toEqual(
      firstRefreshClaim.tddEvidence.green.fingerprint,
    );
    expect(
      terminalClaim.tddEvidenceHistory
        .slice(1)
        .map(
          (entry: { transition: { mergedDefaultSha: string } }) =>
            entry.transition.mergedDefaultSha,
        ),
    ).toEqual([firstDefaultAdvance, secondDefaultAdvance]);
    expect(terminalClaim.tddEvidenceHistory[2].transition).toMatchObject({
      priorGreenFingerprint: firstRefreshClaim.tddEvidence.green.fingerprint,
      replacementGreenFingerprint: terminalClaim.tddEvidence.green.fingerprint,
      priorImplementationBoundaryFingerprint:
        firstRefreshClaim.tddEvidence.implementationBoundary.fingerprint,
      replacementImplementationBoundaryFingerprint:
        terminalClaim.tddEvidence.implementationBoundary.fingerprint,
    });

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
