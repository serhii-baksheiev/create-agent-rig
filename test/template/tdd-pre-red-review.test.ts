import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { jiraReadback } from './tdd-tracker-fixture.js';

// RP-328 review: portable pre-RED evidence must describe the production state
// observed by check-run, including index-only files and rig configuration.
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

const fixture = async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'tdd-pre-red-review-'));
  const runDir = await mkdtemp(path.join(tmpdir(), 'tdd-pre-red-review-run-'));
  await mkdir(path.join(projectRoot, '.rig'), { recursive: true });
  await mkdir(path.join(projectRoot, '.claude'), { recursive: true });
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
    "import { feature } from '../src/feature.ts';\n\nit('returns the replacement value', () => expect(feature()).toBe('new'));\n",
  );
  await writeFile(
    path.join(projectRoot, 'vitest.config.mjs'),
    "export default { test: { include: ['test/**/*.test.ts'], globals: true } };\n",
  );
  await writeFile(
    path.join(projectRoot, '.claude', 'queue.json'),
    '{"adapter":"jira","options":{"project":"RP"}}\n',
  );
  await git(['init', '-q', '-b', 'master'], projectRoot);
  await git(['add', '.rig/revalidation.json', '.claude/queue.json', 'src/feature.ts'], projectRoot);
  await git(['commit', '-q', '-m', 'baseline'], projectRoot);
  const baselineHeadSha = await git(['rev-parse', 'HEAD'], projectRoot);
  await git(['checkout', '-q', '-b', 'feat/RP-328-review'], projectRoot);

  const claims = (await import(
    pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
  )) as {
    revalidateClaim: (input: Record<string, unknown>) => { result: string };
  };
  const ticket = {
    id: 'RP-328',
    state: 'open' as const,
    title: 'portable pre-RED review',
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

  const runRed = () =>
    run(
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
        path.join(runDir, 'red.json'),
      ],
      projectRoot,
      { ...trackerEnv, RIG_RUN_DIR: runDir },
    );
  const recordRed = () =>
    run(
      process.execPath,
      [tddEvidence, 'record-red', '--ticket', 'RP-328', '--check', 'unit-red'],
      projectRoot,
      { ...trackerEnv, RIG_RUN_DIR: runDir },
    );
  const claim = async () =>
    JSON.parse(await readFile(path.join(projectRoot, '.rig', 'claims', 'RP-328.json'), 'utf8'));

  return { claim, projectRoot, recordRed, runRed };
};

const recordObservedRed = async (subject: Awaited<ReturnType<typeof fixture>>) => {
  const check = await subject.runRed();
  expect(check.code, check.out).toBe(1);
  return subject.recordRed();
};

describe('RP-328 pre-RED review regressions', () => {
  it('counts a staged production addition deleted from the worktree', async () => {
    const subject = await fixture();
    const staged = path.join(subject.projectRoot, 'src', 'index-only.ts');
    await writeFile(staged, 'export const indexOnly = true;\n');
    await git(['add', 'src/index-only.ts'], subject.projectRoot);
    await unlink(staged);

    const recorded = await recordObservedRed(subject);
    expect(recorded.code, recorded.out).toBe(0);
    expect((await subject.claim()).tddEvidence.preRed.production.pathCount).toBe(1);
  });

  it('counts an edited queue configuration as pre-RED production', async () => {
    const subject = await fixture();
    await writeFile(
      path.join(subject.projectRoot, '.claude', 'queue.json'),
      '{"adapter":"jira","options":{"project":"RP","preRedReview":true}}\n',
    );

    const recorded = await recordObservedRed(subject);
    expect(recorded.code, recorded.out).toBe(0);
    expect((await subject.claim()).tddEvidence.preRed.production.pathCount).toBe(1);
  });

  it('fails closed when a valid production path exceeds the portable path bound', async () => {
    const subject = await fixture();
    const segments = Array.from({ length: 6 }, (_, index) => `${index}`.repeat(100));
    const relativePath = path.posix.join('src', ...segments, 'feature.ts');
    expect(relativePath.length).toBeGreaterThan(512);
    const longPath = path.join(subject.projectRoot, ...relativePath.split('/'));
    await mkdir(path.dirname(longPath), { recursive: true });
    await writeFile(longPath, 'export const longPath = true;\n');

    const recorded = await recordObservedRed(subject);
    expect(recorded.code, recorded.out).toBe(1);
    expect(recorded.out).toMatch(/path|bound|pre-RED/i);
  });

  it('rejects production bytes changed after the RED check before record-red', async () => {
    const subject = await fixture();
    const check = await subject.runRed();
    expect(check.code, check.out).toBe(1);
    await writeFile(
      path.join(subject.projectRoot, 'src', 'feature.ts'),
      'export const feature = () => "changed after RED";\n',
    );

    const recorded = await subject.recordRed();
    expect(recorded.code, recorded.out).toBe(1);
    expect(recorded.out).toMatch(/pre-RED|boundary|production|changed/i);
  });
});
