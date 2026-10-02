import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

// RP-338: Git stores an autocrlf-normalized claim blob, while a Windows
// checkout has CRLF bytes. Ship verification must compare through Git's clean
// filter without accepting a separately modified claim.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const tddEvidence = path.join(scriptsDir, 'tdd-evidence.mjs');

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

it('RP-338 Git clean-filter claim identity accepts a tracked CRLF checkout and still rejects modified claim bytes', async () => {
  const fixtures: string[] = [];
  const temporaryDirectory = async (prefix: string) => {
    const fixture = await mkdtemp(path.join(tmpdir(), prefix));
    fixtures.push(fixture);
    return fixture;
  };
  const root = await temporaryDirectory('tdd-clean-filter-claim-');
  try {
    await mkdir(path.join(root, '.rig'), { recursive: true });
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(
      path.join(root, '.rig', 'revalidation.json'),
      `${JSON.stringify(revalidationContract)}\n`,
    );
    await writeFile(path.join(root, 'docs', 'baseline.md'), 'Baseline documentation.\n');
    await git(['init', '-q', '-b', 'master'], root);
    await git(['config', 'core.autocrlf', 'true'], root);
    await git(['add', '.rig/revalidation.json', 'docs/baseline.md'], root);
    await git(['commit', '-q', '-m', 'baseline'], root);
    const baselineHeadSha = await git(['rev-parse', 'HEAD'], root);
    await git(['checkout', '-q', '-b', 'feat/RP-338'], root);

    const claims = (await import(
      pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
    )) as {
      revalidateClaim: (input: Record<string, unknown>) => { result: string };
    };
    expect(
      claims.revalidateClaim({
        projectRoot: root,
        ticket: {
          id: 'RP-338',
          state: 'open' as const,
          title: 'clean-filter claim identity',
          labels: [],
          blockedBy: [],
          blocks: [],
        },
        point: 'SELECT',
        targetSha: baselineHeadSha,
        allowCreate: true,
      }).result,
    ).toBe('BASELINE_CREATED');
    const claimPath = path.join(root, '.rig', 'claims', 'RP-338.json');
    await git(['add', '.rig/claims/RP-338.json'], root);
    await git(['commit', '-q', '-m', 'record selected work'], root);
    await writeFile(path.join(root, 'docs', 'RP-338.md'), 'Documentation-only final diff.\n');
    await git(['add', 'docs/RP-338.md'], root);
    await git(['commit', '-q', '-m', 'add RP-338 documentation'], root);

    await git(['checkout', '-q', 'master'], root);
    await git(['checkout', '-q', 'feat/RP-338'], root);
    const checkedOutClaim = await readFile(claimPath, 'utf8');
    expect(
      checkedOutClaim,
      'core.autocrlf=true materializes the tracked claim with CRLF',
    ).toContain('\r\n');

    const ship = (runDir: string) =>
      run(
        process.execPath,
        [tddEvidence, 'verify-ship', '--ticket', 'RP-338', '--base', 'master'],
        root,
        { ...process.env, RIG_RUN_DIR: runDir },
      );

    const normalizedCheckout = await ship(
      await temporaryDirectory('tdd-clean-filter-claim-normalized-'),
    );
    expect(normalizedCheckout.code, normalizedCheckout.out).toBe(0);
    expect(normalizedCheckout.out).toMatch(/TDD-0/i);

    await writeFile(claimPath, `${checkedOutClaim} `);
    const modifiedClaim = await ship(await temporaryDirectory('tdd-clean-filter-claim-modified-'));
    expect(modifiedClaim.code, modifiedClaim.out).toBe(2);
    expect(modifiedClaim.out).toMatch(/portable claim is not the tracked HEAD content/i);
  } finally {
    await Promise.all(fixtures.map((fixture) => removeFixture(fixture)));
  }
});
