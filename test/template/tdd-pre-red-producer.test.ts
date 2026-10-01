import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { jiraReadback } from './tdd-tracker-fixture.js';

// RP-328 snapshots the observable state that exists before RED. A later
// controller can inspect the portable claim without recovering this run journal.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const checkRun = path.join(scriptsDir, 'check-run.mjs');
const tddEvidence = path.join(scriptsDir, 'tdd-evidence.mjs');
const vitestCli = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const relevantSpec =
  'rig:tdd-spec/v1 {"file":"test/feature.test.ts","fullName":"returns the replacement value"}';

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

const fingerprint = { algorithm: 'sha256', value: expect.stringMatching(/^[a-f0-9]{64}$/) };

const makeFixture = async ({
  dirty,
  dispatched,
  mergeDefaultBeforeRed = false,
  priorDispatch = false,
  foreignCurrentDispatch = false,
}: {
  dirty: boolean;
  dispatched: boolean;
  mergeDefaultBeforeRed?: boolean;
  priorDispatch?: boolean;
  foreignCurrentDispatch?: boolean;
}) => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'tdd-pre-red-producer-'));
  const runDir = priorDispatch
    ? path.join(projectRoot, '.claude', 'runs', '20261001-130000')
    : await mkdtemp(path.join(tmpdir(), 'tdd-pre-red-producer-run-'));
  await mkdir(path.join(projectRoot, '.rig'), { recursive: true });
  await mkdir(path.join(projectRoot, '.claude'), { recursive: true });
  await mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await writeFile(
    path.join(projectRoot, '.rig', 'revalidation.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      detection: {
        mode: 'pull',
        sources: ['run-state', 'journal'],
        acceptedLatency: '24h',
        push: false,
      },
      pairedFacts: [],
    })}\n`,
  );
  await writeFile(
    path.join(projectRoot, 'src', 'feature.ts'),
    'export const feature = () => "old";\n',
  );
  await writeFile(
    path.join(projectRoot, '.claude', 'queue.json'),
    '{"adapter":"jira","options":{"project":"RP"}}\n',
  );
  await writeFile(path.join(projectRoot, '.gitignore'), '.claude/runs/\n');
  await git(['init', '-q', '-b', 'master'], projectRoot);
  await git(
    ['add', '.gitignore', '.rig/revalidation.json', '.claude/queue.json', 'src/feature.ts'],
    projectRoot,
  );
  await git(['commit', '-q', '-m', 'baseline'], projectRoot);
  const baselineHeadSha = await git(['rev-parse', 'HEAD'], projectRoot);
  await git(['checkout', '-q', '-b', 'feat/RP-328'], projectRoot);

  if (mergeDefaultBeforeRed) {
    await git(['checkout', '-q', 'master'], projectRoot);
    await writeFile(
      path.join(projectRoot, 'src', 'unrelated-master.ts'),
      'export const unrelatedMaster = true;\n',
    );
    await git(['add', 'src/unrelated-master.ts'], projectRoot);
    await git(['commit', '-q', '-m', 'unrelated master advance'], projectRoot);
    await git(['checkout', '-q', 'feat/RP-328'], projectRoot);
    await git(
      ['merge', '--no-ff', '-m', 'merge unrelated master advance before RED', 'master'],
      projectRoot,
    );
  }

  const claims = (await import(
    pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
  )) as {
    revalidateClaim: (input: Record<string, unknown>) => { result: string };
  };
  const ticket = {
    id: 'RP-328',
    state: 'open' as const,
    title: 'portable pre-RED producer',
    body: relevantSpec,
    labels: [],
    blockedBy: [],
    blocks: [],
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

  if (dirty) {
    await writeFile(
      path.join(projectRoot, 'src', 'committed.ts'),
      'export const committed = true;\n',
    );
    await git(['add', 'src/committed.ts'], projectRoot);
    await git(['commit', '-q', '-m', 'production before RED'], projectRoot);
    await writeFile(path.join(projectRoot, 'src', 'staged.ts'), 'export const staged = true;\n');
    await git(['add', 'src/staged.ts'], projectRoot);
    await writeFile(
      path.join(projectRoot, 'src', 'untracked.ts'),
      'export const untracked = true;\n',
    );
    await writeFile(
      path.join(projectRoot, '.claude', 'queue.json'),
      '{"adapter":"jira","options":{"project":"RP","preRedProducer":true}}\n',
    );
  }

  await mkdir(path.join(projectRoot, 'test'), { recursive: true });
  await writeFile(
    path.join(projectRoot, 'test', 'feature.test.ts'),
    "import { feature } from '../src/feature.ts';\n\nit('returns the replacement value', () => expect(feature()).toBe('new'));\n",
  );
  await writeFile(
    path.join(projectRoot, 'vitest.config.mjs'),
    "export default { test: { include: ['test/**/*.test.ts'], globals: true } };\n",
  );

  if (dispatched) {
    const journal = (await import(
      pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href
    )) as {
      recordEvent: (input: Record<string, unknown>) => unknown;
      recordDecision: (input: Record<string, unknown>) => unknown;
    };
    journal.recordDecision({
      runDir,
      gate: 'item-selection',
      verdict: 'taken RP-328',
      now: '2026-10-01T00:00:00.000Z',
    });
    journal.recordEvent({
      runDir,
      kind: 'dispatch-start',
      data: {
        schema: 1,
        agentType: 'implementation-agent',
        agentRef: 'implementation-agent-before-red',
        ticket: 'RP-328',
      },
      now: '2026-10-01T00:00:00.000Z',
    });
  }

  if (foreignCurrentDispatch) {
    const journal = (await import(
      pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href
    )) as {
      recordEvent: (input: Record<string, unknown>) => unknown;
      recordDecision: (input: Record<string, unknown>) => unknown;
    };
    journal.recordDecision({
      runDir,
      gate: 'item-selection',
      verdict: 'taken RP-OTHER',
      now: '2026-10-01T00:00:01.000Z',
    });
    journal.recordEvent({
      runDir,
      kind: 'dispatch-start',
      data: {
        schema: 1,
        agentType: 'implementation-agent',
        agentRef: 'implementation-agent-for-RP-OTHER',
        ticket: 'RP-OTHER',
      },
      now: '2026-10-01T00:00:01.000Z',
    });
  }

  if (priorDispatch) {
    const priorRunDir = path.join(projectRoot, '.claude', 'runs', '20261001-120000');
    await mkdir(runDir, { recursive: true });
    await mkdir(priorRunDir, { recursive: true });
    const journal = (await import(
      pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href
    )) as {
      recordEvent: (input: Record<string, unknown>) => unknown;
      recordDecision: (input: Record<string, unknown>) => unknown;
    };
    journal.recordDecision({
      runDir: priorRunDir,
      gate: 'item-selection',
      verdict: 'taken RP-328',
      now: '2026-10-01T00:00:00.000Z',
    });
    journal.recordEvent({
      runDir: priorRunDir,
      kind: 'dispatch-start',
      data: {
        schema: 1,
        agentType: 'implementation-agent',
        agentRef: 'implementation-agent-before-red-in-prior-run',
        ticket: 'RP-328',
      },
      now: '2026-10-01T00:00:00.000Z',
    });
  }

  const redJson = path.join(runDir, 'red.json');
  const check = await run(
    process.execPath,
    [
      checkRun,
      '--name',
      'unit-red',
      '--vitest-json',
      'red.json',
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
      redJson,
    ],
    projectRoot,
    { ...trackerEnv, RIG_RUN_DIR: runDir },
  );
  expect(check.code, check.out).toBe(1);
  const recorded = await run(
    process.execPath,
    [tddEvidence, 'record-red', '--ticket', 'RP-328', '--check', 'unit-red'],
    projectRoot,
    { ...trackerEnv, RIG_RUN_DIR: runDir },
  );
  expect(recorded.code, recorded.out).toBe(0);

  return {
    projectRoot,
    runDir,
    trackerEnv,
    baselineHeadSha,
    claim: JSON.parse(
      await readFile(path.join(projectRoot, '.rig', 'claims', 'RP-328.json'), 'utf8'),
    ),
  };
};

it('records portable pre-RED implementation state', async () => {
  const dirty = await makeFixture({ dirty: true, dispatched: true });
  const preRed = dirty.claim.tddEvidence.preRed;

  expect(preRed).toMatchObject({
    baseline: { headSha: dirty.baselineHeadSha },
    red: { check: 'unit-red', fingerprint },
    production: {
      pathCount: 4,
      fingerprint,
    },
    implementationAgentDispatch: { count: 1, fingerprint },
    fingerprint,
  });

  const evidence = (await import(
    pathToFileURL(path.join(scriptsDir, 'lib', 'tdd-evidence.mjs')).href
  )) as {
    validatePortableEvidence: (value: unknown) => { ok: boolean };
  };
  expect(evidence.validatePortableEvidence(dirty.claim.tddEvidence).ok).toBe(true);
  dirty.claim.tddEvidence.preRed.production.pathCount = 5;
  expect(evidence.validatePortableEvidence(dirty.claim.tddEvidence).ok).toBe(false);

  const clean = await makeFixture({ dirty: false, dispatched: false });
  expect(clean.claim.tddEvidence.preRed).toMatchObject({
    baseline: { headSha: clean.baselineHeadSha },
    red: { check: 'unit-red', fingerprint },
    production: { pathCount: 0, fingerprint },
    implementationAgentDispatch: { count: 0, fingerprint },
    fingerprint,
  });

  // The selected-work baseline remains the RED lineage even when an unrelated
  // master commit is merged before GREEN. Shipping must fingerprint only this
  // item's production delta relative to the shipping base.
  const mergedBeforeGreen = await makeFixture({ dirty: false, dispatched: false });
  await writeFile(
    path.join(mergedBeforeGreen.projectRoot, 'src', 'feature.ts'),
    'export const feature = () => "new";\n',
  );
  await git(['add', 'src/feature.ts'], mergedBeforeGreen.projectRoot);
  await git(['commit', '-q', '-m', 'RP-328 implementation'], mergedBeforeGreen.projectRoot);

  await git(['checkout', '-q', 'master'], mergedBeforeGreen.projectRoot);
  await writeFile(
    path.join(mergedBeforeGreen.projectRoot, 'src', 'unrelated-master.ts'),
    'export const unrelatedMaster = true;\n',
  );
  await git(['add', 'src/unrelated-master.ts'], mergedBeforeGreen.projectRoot);
  await git(['commit', '-q', '-m', 'unrelated master advance'], mergedBeforeGreen.projectRoot);
  await git(['checkout', '-q', 'feat/RP-328'], mergedBeforeGreen.projectRoot);
  await git(
    ['merge', '--no-ff', '-m', 'merge unrelated master advance', 'master'],
    mergedBeforeGreen.projectRoot,
  );

  const greenJson = path.join(mergedBeforeGreen.runDir, 'green.json');
  const green = await run(
    process.execPath,
    [
      checkRun,
      '--name',
      'unit-green',
      '--vitest-json',
      'green.json',
      '--',
      process.execPath,
      vitestCli,
      'run',
      '--root',
      mergedBeforeGreen.projectRoot,
      '--config',
      path.join(mergedBeforeGreen.projectRoot, 'vitest.config.mjs'),
      '--reporter=json',
      '--outputFile',
      greenJson,
    ],
    mergedBeforeGreen.projectRoot,
    { ...mergedBeforeGreen.trackerEnv, RIG_RUN_DIR: mergedBeforeGreen.runDir },
  );
  expect(green.code, green.out).toBe(0);
  const recordedGreen = await run(
    process.execPath,
    [tddEvidence, 'record-green', '--ticket', 'RP-328', '--check', 'unit-green'],
    mergedBeforeGreen.projectRoot,
    { ...mergedBeforeGreen.trackerEnv, RIG_RUN_DIR: mergedBeforeGreen.runDir },
  );
  expect(recordedGreen.code, recordedGreen.out).toBe(0);
  await git(['add', '.rig/claims/RP-328.json'], mergedBeforeGreen.projectRoot);
  await git(
    ['commit', '-q', '-m', 'record portable GREEN evidence'],
    mergedBeforeGreen.projectRoot,
  );

  const ship = await run(
    process.execPath,
    [tddEvidence, 'verify-ship', '--ticket', 'RP-328', '--base', 'master'],
    mergedBeforeGreen.projectRoot,
    {
      ...mergedBeforeGreen.trackerEnv,
      RIG_RUN_DIR: await mkdtemp(path.join(tmpdir(), 'tdd-pre-red-producer-ship-')),
    },
  );
  expect(ship.code, ship.out).toBe(0);

  // An unrelated default-branch advance merged before RED is baseline context,
  // not pre-RED implementation for this item.
  const mergedBeforeRed = await makeFixture({
    dirty: false,
    dispatched: false,
    mergeDefaultBeforeRed: true,
  });
  expect.soft(mergedBeforeRed.claim.tddEvidence.preRed.production.pathCount).toBe(0);

  // A resumed controller must preserve a same-ticket implementation dispatch
  // from its immediately preceding journal, but reject a foreign-ticket
  // dispatch from the current journal.
  const foreignCurrent = await makeFixture({
    dirty: false,
    dispatched: false,
    foreignCurrentDispatch: true,
  });
  expect.soft(foreignCurrent.claim.tddEvidence.preRed.implementationAgentDispatch.count).toBe(0);
  const resumed = await makeFixture({ dirty: false, dispatched: false, priorDispatch: true });
  expect.soft(resumed.claim.tddEvidence.preRed.implementationAgentDispatch.count).toBe(1);

  // The file can grow after lstatSync. The reader must reject at the bound
  // without calling an unbounded read API for that mutable path.
  const stateFixture = await mkdtemp(path.join(tmpdir(), 'tdd-pre-red-state-bound-'));
  await git(['init', '-q', '-b', 'master'], stateFixture);
  await writeFile(path.join(stateFixture, 'tracked.ts'), 'export const tracked = true;\n');
  await git(['add', 'tracked.ts'], stateFixture);
  await git(['commit', '-q', '-m', 'baseline'], stateFixture);
  await writeFile(path.join(stateFixture, 'untracked.ts'), 'small\n');
  const stateProbe = path.join(
    await mkdtemp(path.join(tmpdir(), 'tdd-pre-red-state-probe-')),
    'probe.mjs',
  );
  await writeFile(
    stateProbe,
    `import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const targetPath = process.argv[2] + '/untracked.ts';
const originalOpen = fs.openSync;
const original = fs.readFileSync;
const originalWrite = fs.writeFileSync;
let targetFd = null;
let unbounded = false;
fs.openSync = (target, ...args) => {
  const fd = originalOpen(target, ...args);
  if (target === targetPath) {
    targetFd = fd;
    originalWrite(targetPath, 'x'.repeat(2048));
  }
  return fd;
};
fs.readFileSync = (target, options) => {
  if (target === targetFd) {
    unbounded = true;
    throw new Error('unbounded read attempted');
  }
  return original(target, options);
};
syncBuiltinESMExports();
const { workingTreeStateFingerprint } = await import(${JSON.stringify(
      pathToFileURL(path.join(scriptsDir, 'lib', 'git-working-tree-state.mjs')).href,
    )});
try {
  workingTreeStateFingerprint({ projectRoot: process.argv[2], gitHead: process.argv[3], maxBytes: 1024 });
} catch (error) {
  if (unbounded) throw error;
  if (!/byte bound/.test(String(error.message))) throw error;
  process.exit(0);
}
throw new Error('working-tree state unexpectedly accepted an over-bound file');
`,
  );
  const stateProbeResult = await run(
    process.execPath,
    [stateProbe, stateFixture, await git(['rev-parse', 'HEAD'], stateFixture)],
    stateFixture,
  );
  expect.soft(stateProbeResult.code, stateProbeResult.out).toBe(0);
});
