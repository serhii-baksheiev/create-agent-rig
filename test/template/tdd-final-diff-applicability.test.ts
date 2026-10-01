import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// RP-306 derives applicability from the final Git diff. A controller-written
// TDD-0 record and its prose do not exempt a behaviour-changing source diff.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const tddEvidence = path.join(scriptsDir, 'tdd-evidence.mjs');

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

describe('RP-306 final-diff applicability', () => {
  it('HOLDs a production diff despite controller prose and a structurally valid TDD-0 claim', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tdd-final-diff-'));
    await mkdir(path.join(root, '.rig'), { recursive: true });
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(
      path.join(root, '.rig', 'revalidation.json'),
      `${JSON.stringify(revalidationContract)}\n`,
    );
    await writeFile(path.join(root, 'src', 'feature.ts'), 'export const feature = () => "old";\n');
    await git(['init', '-q', '-b', 'master'], root);
    await git(['add', '.rig/revalidation.json', 'src/feature.ts'], root);
    await git(['commit', '-q', '-m', 'baseline'], root);
    const baselineHeadSha = await git(['rev-parse', 'HEAD'], root);
    await git(['checkout', '-q', '-b', 'feat/RP-306'], root);

    const claims = (await import(
      pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
    )) as {
      revalidateClaim: (input: Record<string, unknown>) => { result: string };
    };
    const ticket = {
      id: 'RP-306',
      state: 'open' as const,
      title: 'change feature',
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

    await writeFile(path.join(root, 'src', 'feature.ts'), 'export const feature = () => "new";\n');
    await writeFile(
      path.join(root, 'docs', 'controller-note.md'),
      'Controller prose: TDD is not applicable.\n',
    );
    await git(['add', 'src/feature.ts', 'docs/controller-note.md'], root);
    await git(['commit', '-q', '-m', 'change feature'], root);

    const helper = (await import(
      pathToFileURL(path.join(scriptsDir, 'lib', 'tdd-evidence.mjs')).href
    )) as {
      validatePortableEvidence: (input: unknown) => { ok: boolean };
    };
    const claimPath = path.join(root, '.rig', 'claims', 'RP-306.json');
    const claim = JSON.parse(await readFile(claimPath, 'utf8')) as Record<string, unknown>;
    const controllerTdd0 = {
      schemaVersion: 1,
      ticket: 'RP-306',
      applicability: {
        level: 'TDD-0',
        authority: { kind: 'path-contract', id: 'controller-prose' },
      },
      baseline: { headSha: baselineHeadSha },
    };
    expect(helper.validatePortableEvidence(controllerTdd0)).toEqual({ ok: true });
    claim.tddEvidence = controllerTdd0;
    await writeFile(claimPath, `${JSON.stringify(claim, null, 2)}\n`);
    await git(['add', '.rig/claims/RP-306.json'], root);
    await git(['commit', '-q', '-m', 'record controller tdd claim'], root);

    const result = await run(
      process.execPath,
      [tddEvidence, 'verify-ship', '--ticket', 'RP-306', '--base', 'master'],
      root,
      { ...process.env, RIG_RUN_DIR: await mkdtemp(path.join(tmpdir(), 'tdd-final-diff-run-')) },
    );
    expect(result.code, result.out).toBe(2);
    expect(result.out).toMatch(/final production diff[\s\S]{0,100}TDD-2/i);
  });

  it('HOLDs a final .rig revalidation contract change without portable TDD-2 evidence', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tdd-revalidation-diff-'));
    await mkdir(path.join(root, '.rig'), { recursive: true });
    await writeFile(
      path.join(root, '.rig', 'revalidation.json'),
      `${JSON.stringify(revalidationContract)}\n`,
    );
    await git(['init', '-q', '-b', 'master'], root);
    await git(['add', '.rig/revalidation.json'], root);
    await git(['commit', '-q', '-m', 'baseline'], root);
    const baselineHeadSha = await git(['rev-parse', 'HEAD'], root);
    await git(['checkout', '-q', '-b', 'feat/RP-306'], root);

    const claims = (await import(
      pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
    )) as {
      revalidateClaim: (input: Record<string, unknown>) => { result: string };
    };
    expect(
      claims.revalidateClaim({
        projectRoot: root,
        ticket: {
          id: 'RP-306',
          state: 'open' as const,
          title: 'change revalidation contract',
          labels: [],
          blockedBy: [],
          blocks: [],
        },
        point: 'SELECT',
        targetSha: baselineHeadSha,
        allowCreate: true,
      }).result,
    ).toBe('BASELINE_CREATED');
    await git(['add', '.rig/claims/RP-306.json'], root);
    await git(['commit', '-q', '-m', 'record selected work'], root);

    await writeFile(
      path.join(root, '.rig', 'revalidation.json'),
      `${JSON.stringify({ ...revalidationContract, pairedFacts: ['fresh-pr'] })}\n`,
    );
    await git(['add', '.rig/revalidation.json'], root);
    await git(['commit', '-q', '-m', 'tighten revalidation contract'], root);

    const result = await run(
      process.execPath,
      [tddEvidence, 'verify-ship', '--ticket', 'RP-306', '--base', 'master'],
      root,
      { ...process.env, RIG_RUN_DIR: await mkdtemp(path.join(tmpdir(), 'tdd-revalidation-run-')) },
    );
    expect(result.code, result.out).toBe(2);
    expect(result.out).toMatch(/TDD-2|portable/i);
  });

  it('accepts a packages CLI test-only final diff as TDD-0 without portable TDD-2 evidence', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tdd-package-test-diff-'));
    await mkdir(path.join(root, '.rig'), { recursive: true });
    await mkdir(path.join(root, 'packages', 'cli', 'test'), { recursive: true });
    await writeFile(
      path.join(root, '.rig', 'revalidation.json'),
      `${JSON.stringify(revalidationContract)}\n`,
    );
    await writeFile(path.join(root, 'packages', 'cli', 'test', 'upgrade.test.ts'), 'export {};\n');
    await git(['init', '-q', '-b', 'master'], root);
    await git(['add', '.rig/revalidation.json', 'packages/cli/test/upgrade.test.ts'], root);
    await git(['commit', '-q', '-m', 'baseline'], root);
    const baselineHeadSha = await git(['rev-parse', 'HEAD'], root);
    await git(['checkout', '-q', '-b', 'feat/RP-306'], root);

    const claims = (await import(
      pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
    )) as {
      revalidateClaim: (input: Record<string, unknown>) => { result: string };
    };
    expect(
      claims.revalidateClaim({
        projectRoot: root,
        ticket: {
          id: 'RP-306',
          state: 'open' as const,
          title: 'test-only change',
          labels: [],
          blockedBy: [],
          blocks: [],
        },
        point: 'SELECT',
        targetSha: baselineHeadSha,
        allowCreate: true,
      }).result,
    ).toBe('BASELINE_CREATED');
    await git(['add', '.rig/claims/RP-306.json'], root);
    await git(['commit', '-q', '-m', 'record selected work'], root);

    await writeFile(
      path.join(root, 'packages', 'cli', 'test', 'upgrade.test.ts'),
      "import { expect, it } from 'vitest';\n\nit('keeps an upgrade invariant', () => expect(true).toBe(true));\n",
    );
    await git(['add', 'packages/cli/test/upgrade.test.ts'], root);
    await git(['commit', '-q', '-m', 'add upgrade invariant'], root);

    const result = await run(
      process.execPath,
      [tddEvidence, 'verify-ship', '--ticket', 'RP-306', '--base', 'master'],
      root,
      { ...process.env, RIG_RUN_DIR: await mkdtemp(path.join(tmpdir(), 'tdd-package-test-run-')) },
    );
    expect(result.code, result.out).toBe(0);
    expect(result.out).toMatch(/TDD-0/i);
  });
});
