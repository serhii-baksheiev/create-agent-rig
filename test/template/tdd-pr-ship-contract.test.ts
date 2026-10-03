import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// RP-306 is enforced at the shipping gate. A controller's prose cannot choose
// the applicability level: the verifier derives it from the final Git diff.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const tddEvidence = path.join(scriptsDir, 'tdd-evidence.mjs');
const prShipSkill = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'universal',
  '.claude',
  'skills',
  'pr-ship',
  'SKILL.md',
);

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

const docsOnlyProject = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tdd-pr-ship-contract-'));
  await mkdir(path.join(root, '.rig'), { recursive: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(
    path.join(root, '.rig', 'revalidation.json'),
    `${JSON.stringify(revalidationContract)}\n`,
  );
  await writeFile(path.join(root, 'docs', 'workflow.md'), 'baseline docs\n');
  await git(['init', '-q', '-b', 'master'], root);
  await git(['add', '.rig/revalidation.json', 'docs/workflow.md'], root);
  await git(['commit', '-q', '-m', 'baseline'], root);
  const baselineHeadSha = await git(['rev-parse', 'HEAD'], root);
  await git(['checkout', '-q', '-b', 'docs/RP-306'], root);

  const claims = (await import(
    pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
  )) as {
    revalidateClaim: (input: Record<string, unknown>) => { result: string };
  };
  const ticket = {
    id: 'RP-306',
    state: 'open' as const,
    title: 'document workflow',
    labels: [],
    blockedBy: [],
    blocks: [],
  };
  expect(
    claims.revalidateClaim({
      projectRoot: root,
      ticket,
      point: 'SELECT',
      targetSha: baselineHeadSha,
      allowCreate: true,
    }).result,
  ).toBe('BASELINE_CREATED');
  await writeFile(
    path.join(root, 'docs', 'workflow.md'),
    'controller prose: this release is a refactor, but Git decides applicability.\n',
  );
  await git(['add', 'docs/workflow.md', '.rig/claims/RP-306.json'], root);
  await git(['commit', '-q', '-m', 'document workflow'], root);
  return root;
};

const rootReadmeProject = async ({ mixedProduction = false } = {}) => {
  const root = await mkdtemp(path.join(tmpdir(), 'tdd-pr-ship-root-readme-'));
  await mkdir(path.join(root, '.rig'), { recursive: true });
  await writeFile(
    path.join(root, '.rig', 'revalidation.json'),
    `${JSON.stringify(revalidationContract)}\n`,
  );
  await writeFile(path.join(root, 'README.md'), 'baseline README\n');
  if (mixedProduction) {
    await mkdir(path.join(root, 'packages', 'cli', 'src'), { recursive: true });
    await writeFile(
      path.join(root, 'packages', 'cli', 'src', 'marker.ts'),
      'export const marker = 0;\n',
    );
  }
  await git(['init', '-q', '-b', 'master'], root);
  await git(
    [
      'add',
      '.rig/revalidation.json',
      'README.md',
      ...(mixedProduction ? ['packages/cli/src/marker.ts'] : []),
    ],
    root,
  );
  await git(['commit', '-q', '-m', 'baseline'], root);
  const baselineHeadSha = await git(['rev-parse', 'HEAD'], root);
  await git(['checkout', '-q', '-b', 'docs/RP-367'], root);

  const claims = (await import(
    pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
  )) as {
    revalidateClaim: (input: Record<string, unknown>) => { result: string };
  };
  const ticket = {
    id: 'RP-367',
    state: 'open' as const,
    title: 'classify README-only workflow prose',
    labels: [],
    blockedBy: [],
    blocks: [],
  };
  expect(
    claims.revalidateClaim({
      projectRoot: root,
      ticket,
      point: 'SELECT',
      targetSha: baselineHeadSha,
      allowCreate: true,
    }).result,
  ).toBe('BASELINE_CREATED');
  await writeFile(
    path.join(root, 'README.md'),
    'controller prose calls this release a refactor, but final Git paths decide applicability.\n',
  );
  if (mixedProduction) {
    await writeFile(
      path.join(root, 'packages', 'cli', 'src', 'marker.ts'),
      'export const marker = 1;\n',
    );
  }
  await git(
    [
      'add',
      'README.md',
      '.rig/claims/RP-367.json',
      ...(mixedProduction ? ['packages/cli/src/marker.ts'] : []),
    ],
    root,
  );
  await git(['commit', '-q', '-m', 'document root workflow'], root);
  return root;
};

describe('RP-306 pr-ship enforcement contract', () => {
  it('runs verify-ship for a ticket before it can emit SHIP and treats exit 2 as HOLD', async () => {
    const skill = await readFile(prShipSkill, 'utf8');
    const invocation =
      'node .claude/scripts/tdd-evidence.mjs verify-ship --ticket <item-id> --base origin/<default>';
    const invokeAt = skill.indexOf(invocation);
    expect(invokeAt).toBeGreaterThanOrEqual(0);
    expect(invokeAt).toBeLessThan(skill.indexOf('## Verdict'));
    expect(skill.slice(invokeAt, skill.indexOf('## Verdict'))).toMatch(/exit 2[\s\S]{0,500}HOLD/);
  });

  it('derives TDD-0 from a docs-only final Git diff even when controller prose says otherwise', async () => {
    const root = await rootReadmeProject();
    const result = await run(
      process.execPath,
      [tddEvidence, 'verify-ship', '--ticket', 'RP-367', '--base', 'master'],
      root,
      {
        ...process.env,
        RIG_RUN_DIR: await mkdtemp(path.join(tmpdir(), 'tdd-pr-ship-readme-run-')),
      },
    );

    expect(result.code, result.out).toBe(0);
    expect(result.out).toMatch(/TDD-0|not applicable/i);
  });

  it('keeps docs-only final Git diffs at TDD-0 when controller prose says otherwise', async () => {
    const root = await docsOnlyProject();
    const result = await run(
      process.execPath,
      [tddEvidence, 'verify-ship', '--ticket', 'RP-306', '--base', 'master'],
      root,
      {
        ...process.env,
        RIG_RUN_DIR: await mkdtemp(path.join(tmpdir(), 'tdd-pr-ship-fresh-run-')),
      },
    );

    expect(result.code, result.out).toBe(0);
    expect(result.out).toMatch(/TDD-0|not applicable/i);
  });

  it('keeps a root README.md diff mixed with a production path at TDD-2', async () => {
    const root = await rootReadmeProject({ mixedProduction: true });
    const result = await run(
      process.execPath,
      [tddEvidence, 'verify-ship', '--ticket', 'RP-367', '--base', 'master'],
      root,
      { ...process.env, RIG_RUN_DIR: await mkdtemp(path.join(tmpdir(), 'tdd-pr-ship-mixed-run-')) },
    );

    expect(result.code, result.out).toBe(2);
    expect(result.out).toMatch(/TDD-2|final Git diff|TDD evidence/i);
  });
});
