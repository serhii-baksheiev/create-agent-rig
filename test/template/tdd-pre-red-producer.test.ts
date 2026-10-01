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

const makeFixture = async ({ dirty, dispatched }: { dirty: boolean; dispatched: boolean }) => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'tdd-pre-red-producer-'));
  const runDir = await mkdtemp(path.join(tmpdir(), 'tdd-pre-red-producer-run-'));
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
  await git(['init', '-q', '-b', 'master'], projectRoot);
  await git(['add', '.rig/revalidation.json', '.claude/queue.json', 'src/feature.ts'], projectRoot);
  await git(['commit', '-q', '-m', 'baseline'], projectRoot);
  const baselineHeadSha = await git(['rev-parse', 'HEAD'], projectRoot);
  await git(['checkout', '-q', '-b', 'feat/RP-328'], projectRoot);

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
    };
    journal.recordEvent({
      runDir,
      kind: 'dispatch-start',
      data: {
        schema: 1,
        agentType: 'implementation-agent',
        agentRef: 'implementation-agent-before-red',
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
});
