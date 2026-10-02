import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

// RP-338: a CRLF-only checkout of a tracked claim is legitimate, but a clean
// filter configured for that path must not make a different parsed claim count
// as the tracked content.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const tddEvidence = path.join(scriptsDir, 'tdd-evidence.mjs');

type Result = { code: number; out: string };

const CHILD_TIMEOUT_MS = 10_000;
const CHILD_MAX_BUFFER_BYTES = 1024 * 1024;

const run = (
  file: string,
  args: string[],
  cwd: string,
  env = process.env,
  input?: string,
): Promise<Result> =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { cwd, env, timeout: CHILD_TIMEOUT_MS, maxBuffer: CHILD_MAX_BUFFER_BYTES },
      (error, stdout, stderr) =>
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          out: stdout + stderr,
        }),
    );
    if (input !== undefined) child.stdin?.end(input);
  });

const git = async (args: string[], cwd: string, input?: string) => {
  const result = await run(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
    cwd,
    process.env,
    input,
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
      recordClaimTransition: (input: Record<string, unknown>) => unknown;
    };
    const ticket = {
      id: 'RP-338',
      state: 'open' as const,
      title: 'clean-filter claim identity',
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
    claims.recordClaimTransition({
      projectRoot: root,
      ticket: { ...ticket, state: 'in-progress' },
      claimedState: 'in-progress',
    });
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

    await writeFile(claimPath, checkedOutClaim);
    const lossyFilter = path.join(root, 'lossy-clean-filter.cjs');
    await writeFile(
      lossyFilter,
      [
        'const [from, to] = process.argv.slice(2);',
        'const chunks = [];',
        "process.stdin.on('data', (chunk) => chunks.push(chunk));",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(Buffer.concat(chunks).toString('utf8').replace(from, to));",
        '});',
      ].join('\n'),
    );
    await writeFile(
      path.join(root, '.gitattributes'),
      '.rig/claims/RP-338.json filter=rp338-lossy\n',
    );
    await git(
      [
        'config',
        'filter.rp338-lossy.clean',
        [process.execPath, lossyFilter, 'closed', 'in-progress']
          .map((value) => JSON.stringify(value))
          .join(' '),
      ],
      root,
    );

    const claim = JSON.parse(checkedOutClaim) as {
      workflowClaim?: { claimedState?: string };
    };
    expect(claim.workflowClaim?.claimedState).toBe('in-progress');
    const filteredMutation = checkedOutClaim.replace(
      '"claimedState": "in-progress"',
      '"claimedState": "closed"',
    );
    expect(JSON.parse(filteredMutation).workflowClaim.claimedState).toBe('closed');
    await writeFile(claimPath, filteredMutation);

    const claimGitPath = '.rig/claims/RP-338.json';
    const filteredHash = await git(
      ['hash-object', '--path', claimGitPath, '--stdin'],
      root,
      filteredMutation,
    );
    const trackedHash = await git(['rev-parse', '--verify', `HEAD:${claimGitPath}`], root);
    expect(filteredHash, 'the fixture clean filter hides the persisted state mutation').toBe(
      trackedHash,
    );

    const filteredMutationShip = await ship(
      await temporaryDirectory('tdd-clean-filter-claim-lossy-filter-'),
    );
    expect(filteredMutationShip.code, filteredMutationShip.out).toBe(2);
    expect(filteredMutationShip.out).toMatch(/portable claim is not the tracked HEAD content/i);
  } finally {
    await Promise.all(fixtures.map((fixture) => removeFixture(fixture)));
  }
});
