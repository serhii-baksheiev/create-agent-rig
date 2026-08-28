import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RP-50 — replacement semantics for the existing SELECT / BEFORE_PR /
 * BEFORE_CLOSE chain. `updatedAt` remains compatibility evidence, while these
 * tests pin the durable claim record as the only drift authority.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universal, '.claude', 'scripts');
const queueScript = path.join(scriptsDir, 'queue', 'index.mjs');
const revalidateScript = path.join(scriptsDir, 'revalidate.mjs');
const reportScript = path.join(scriptsDir, 'revalidation-report.mjs');
const claimRecordsScript = path.join(scriptsDir, 'lib', 'claim-records.mjs');
const runStateScript = path.join(scriptsDir, 'run-state.mjs');

const T1 = '2026-08-28T08:00:00.000Z';
const T2 = '2026-08-28T09:00:00.000Z';
const SCOPE_SENTINEL = 'scope prose must never be copied into drift evidence';
const COMMENT_SENTINEL = 'comment text must never be copied into drift evidence';
const PAIRED_CONTENT = ['paired fact alpha private content', 'paired fact beta private content'];

const VALID_CONTRACT = {
  schemaVersion: 1,
  detection: {
    mode: 'pull',
    sources: ['run-state', 'journal'],
    acceptedLatency: '24h',
    push: false,
  },
  pairedFacts: [{ id: 'scope-pair', paths: ['paired-alpha.txt', 'paired-beta.txt'] }],
};

interface CommandResult {
  code: number;
  stdout: string;
  out: string;
}

const run = (
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, env }, (error, stdout, stderr) => {
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        stdout,
        out: stdout + stderr,
      });
    });
  });

const git = async (args: string[], cwd: string): Promise<string> => {
  const result = await run(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
    cwd,
    { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  );
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
  return result.stdout.trim();
};

const description = (text: string) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const jiraIssue = (over: Record<string, unknown> = {}) => ({
  key: 'RP-50',
  self: 'https://example.invalid/browse/RP-50',
  fields: {
    summary: 'Replace marker authority with content-blind claims',
    description: description(SCOPE_SENTINEL),
    status: { name: 'To Do', statusCategory: { key: 'new' } },
    labels: ['keep-core'],
    priority: { name: 'Medium' },
    created: '2026-08-01T00:00:00.000+0000',
    updated: T1,
    issuelinks: [],
    comment: {
      total: 1,
      comments: [{ id: '10001', body: description(COMMENT_SENTINEL) }],
    },
    ...over,
  },
});

interface Project {
  root: string;
  configPath: string;
  runDir: string;
  claimPath: string;
  targetSha: string;
  env: NodeJS.ProcessEnv;
  setIssue: (issue: Record<string, unknown>) => Promise<void>;
}

const project = async (): Promise<Project> => {
  const root = await mkdtemp(path.join(tmpdir(), 'content-blind-revalidation-'));
  await git(['init', '-q', '-b', 'master'], root);
  await mkdir(path.join(root, '.rig'), { recursive: true });
  await writeFile(path.join(root, '.rig', 'revalidation.json'), JSON.stringify(VALID_CONTRACT));
  await writeFile(path.join(root, 'scope.txt'), 'seed\n');
  await writeFile(path.join(root, 'paired-alpha.txt'), `${PAIRED_CONTENT[0]}\n`);
  await writeFile(path.join(root, 'paired-beta.txt'), `${PAIRED_CONTENT[1]}\n`);
  await git(
    ['add', 'scope.txt', 'paired-alpha.txt', 'paired-beta.txt', '.rig/revalidation.json'],
    root,
  );
  await git(['commit', '-q', '-m', 'seed'], root);
  const targetSha = await git(['rev-parse', 'master'], root);
  await git(['checkout', '-q', '-b', 'feat/rp-50'], root);
  await writeFile(path.join(root, 'work.txt'), 'feature\n');
  await git(['add', 'work.txt'], root);
  await git(['commit', '-q', '-m', 'feature'], root);

  const configPath = path.join(root, '.claude', 'queue.json');
  const runDir = path.join(root, '.claude', 'runs', '20260828-120000');
  await mkdir(path.dirname(configPath), { recursive: true });
  await mkdir(runDir, { recursive: true });
  const setIssue = (issue: Record<string, unknown>) =>
    writeFile(
      configPath,
      JSON.stringify({ adapter: 'jira', options: { project: 'RP', issues: [issue] } }),
    );
  await setIssue(jiraIssue());

  return {
    root,
    configPath,
    runDir,
    targetSha,
    claimPath: path.join(root, '.rig', 'claims', 'RP-50.json'),
    env: {
      ...process.env,
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      RIG_RUN_DIR: runDir,
    },
    setIssue,
  };
};

const next = (p: Project) =>
  run(process.execPath, [queueScript, 'next', '--config', p.configPath, '--json'], p.root, p.env);

const nextText = (p: Project) =>
  run(process.execPath, [queueScript, 'next', '--config', p.configPath], p.root, p.env);

const trackClaim = async (p: Project): Promise<boolean> => {
  expect(existsSync(p.claimPath), 'SELECT must create the claim before it can be tracked').toBe(
    true,
  );
  if (!existsSync(p.claimPath)) return false;
  await git(['add', '.rig/claims/RP-50.json'], p.root);
  await git(['commit', '-q', '-m', 'track RP-50 claim baseline'], p.root);
  expect(await git(['ls-files', '--error-unmatch', '.rig/claims/RP-50.json'], p.root)).toBe(
    '.rig/claims/RP-50.json',
  );
  return true;
};

const before = (p: Project, point: 'BEFORE_PR' | 'BEFORE_CLOSE') =>
  run(
    process.execPath,
    [
      revalidateScript,
      '--point',
      point,
      '--ticket',
      'RP-50',
      '--base',
      'master',
      '--config',
      p.configPath,
      '--json',
    ],
    p.root,
    p.env,
  );

// CLI JSON is intentionally heterogeneous; assertions below validate its shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonOf = (result: CommandResult): Record<string, any> => {
  expect(result.stdout, result.out).not.toBe('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return JSON.parse(result.stdout) as Record<string, any>;
};

const valuesFor = (value: unknown, wanted: string): unknown[] => {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((entry) => valuesFor(entry, wanted));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [
    ...(key.toLowerCase() === wanted.toLowerCase() ? [entry] : []),
    ...valuesFor(entry, wanted),
  ]);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const eventsOf = async (runDir: string): Promise<Array<Record<string, any>>> =>
  (await readFile(path.join(runDir, 'events.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((line) => JSON.parse(line) as Record<string, any>);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reportOf = async (p: Project): Promise<Record<string, any>> => {
  const result = await run(
    process.execPath,
    [
      reportScript,
      '--since',
      '2026-01-01T00:00:00.000Z',
      '--runs',
      path.dirname(p.runDir),
      '--json',
    ],
    p.root,
    p.env,
  );
  expect(result.code, result.out).toBe(0);
  return jsonOf(result);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runPreflight = async (contract: unknown | null): Promise<Record<string, any>> => {
  const root = await mkdtemp(path.join(tmpdir(), 'revalidation-contract-'));
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await cp(scriptsDir, path.join(root, '.claude', 'scripts'), { recursive: true });
  if (contract !== null) {
    await mkdir(path.join(root, '.rig'), { recursive: true });
    await writeFile(path.join(root, '.rig', 'revalidation.json'), JSON.stringify(contract));
  }
  const result = await run(
    process.execPath,
    [path.join(root, '.claude', 'scripts', 'preflight.mjs'), '--json'],
    root,
    { ...process.env, RIG_RUN_DIR: undefined, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  );
  expect(result.code, result.out).toBe(0);
  return jsonOf(result);
};

describe('the durable claim baseline at SELECT', () => {
  it('creates a versioned content-blind claim and returns BASELINE_CREATED', async () => {
    const p = await project();
    const result = await next(p);
    expect(result.code, result.out).toBe(0);
    expect(jsonOf(result).revalidation).toMatchObject({
      ticket: 'RP-50',
      point: 'SELECT',
      result: 'BASELINE_CREATED',
      action: 'continue',
    });

    expect(existsSync(p.claimPath)).toBe(true);
    if (!existsSync(p.claimPath)) return;
    const ignored = await run(
      'git',
      ['check-ignore', '--quiet', '--no-index', '.rig/claims/RP-50.json'],
      p.root,
      p.env,
    );
    expect(ignored.code, 'the durable record must be eligible for git tracking').toBe(1);
    const claim = JSON.parse(await readFile(p.claimPath, 'utf8')) as Record<string, unknown>;
    expect(valuesFor(claim, 'schemaVersion').length).toBeGreaterThan(0);
    expect(valuesFor(claim, 'scope').length).toBeGreaterThan(0);
    expect(valuesFor(claim, 'commentary').length).toBeGreaterThan(0);
    expect(JSON.stringify(claim)).toContain('RP-50');
    expect(JSON.stringify(claim)).toContain(p.targetSha);
    expect(JSON.stringify(claim)).toMatch(/[0-9a-f]{64}/i);
    expect(JSON.stringify(claim)).not.toContain(SCOPE_SENTINEL);
    expect(JSON.stringify(claim)).not.toContain(COMMENT_SENTINEL);
  });

  it('refuses to resume from an existing claim until Git tracks it', async () => {
    const p = await project();
    expect((await next(p)).code).toBe(0);
    expect(existsSync(p.claimPath)).toBe(true);
    if (!existsSync(p.claimPath)) return;
    expect(
      await git(['status', '--short', '--untracked-files=all', '--', p.claimPath], p.root),
    ).toBe('?? .rig/claims/RP-50.json');

    const resume = await next(p);
    expect(resume.code, resume.out).toBe(2);
    const revalidation = jsonOf(resume).revalidation;
    expect(revalidation).toMatchObject({ result: 'UNVERIFIABLE', action: 'unverifiable' });
    expect(JSON.stringify(revalidation)).toMatch(/untracked.*\.rig\/claims\/RP-50\.json/i);
  });

  it('creates the first baseline even when compatibility take-up evidence exists', async () => {
    const p = await project();
    await writeFile(
      path.join(p.runDir, 'state.json'),
      JSON.stringify({ takeUps: { 'RP-50': '2026-08-01T00:00:00.000Z' } }),
    );

    const result = await next(p);
    expect(result.code, result.out).toBe(0);
    expect(jsonOf(result).revalidation).toMatchObject({
      result: 'BASELINE_CREATED',
      action: 'continue',
    });
  });

  it('creates the first baseline after a legacy SELECT event from the updatedAt engine', async () => {
    const p = await project();
    const journal = await import(pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href);
    journal.recordEvent({
      runDir: p.runDir,
      kind: 'revalidation',
      data: {
        ticket: 'RP-50',
        point: 'SELECT',
        changed: true,
        source: ['task:updatedAt'],
        task: { from: T1, to: T2 },
      },
      now: T2,
    });

    const result = await next(p);
    expect(result.code, result.out).toBe(0);
    expect(jsonOf(result).revalidation).toMatchObject({
      result: 'BASELINE_CREATED',
      action: 'continue',
    });
  });
});

describe('fingerprints, not updatedAt, decide scope drift', () => {
  it('stays CURRENT for marker-only movement and holds on changed scope', async () => {
    const p = await project();
    expect((await next(p)).code).toBe(0);
    if (!(await trackClaim(p))) return;

    await p.setIssue(jiraIssue({ updated: T2 }));
    const markerOnly = await next(p);
    expect(markerOnly.code, markerOnly.out).toBe(0);
    const current = jsonOf(markerOnly).revalidation;
    expect(current).toMatchObject({ result: 'CURRENT', action: 'continue' });
    expect(current.source ?? []).not.toContain('task:updatedAt');

    await p.setIssue(
      jiraIssue({
        updated: T2,
        description: description(`${SCOPE_SENTINEL} — materially revised`),
      }),
    );
    const moved = await next(p);
    expect(moved.code, moved.out).toBe(2);
    const detection = jsonOf(moved).revalidation;
    expect(detection.result).not.toBe('CURRENT');
    expect(detection.action).toBe('hold');
    expect(detection.movedFingerprintSet).toEqual(expect.arrayContaining(['scope']));
    expect(detection.sourcePointer).toMatch(/\.rig\/claims\/RP-50\.json/);
    expect(JSON.stringify(detection)).not.toContain(SCOPE_SENTINEL);
  });

  it('holds when the target branch SHA moves without a tracker edit', async () => {
    const p = await project();
    expect((await next(p)).code).toBe(0);
    if (!(await trackClaim(p))) return;
    const tree = await git(['rev-parse', `${p.targetSha}^{tree}`], p.root);
    const movedTarget = await git(
      ['commit-tree', tree, '-p', p.targetSha, '-m', 'move target without touching ticket'],
      p.root,
    );
    await git(['update-ref', 'refs/heads/master', movedTarget], p.root);

    const result = await next(p);
    expect(result.code, result.out).toBe(2);
    expect(jsonOf(result).revalidation).toMatchObject({
      result: 'CHANGED',
      action: 'hold',
      movedFingerprintSet: expect.arrayContaining(['scope']),
    });
  });
});

describe('workflow state participates in the checkpoint-aware scope fingerprint', () => {
  it('adapters declare their observable claimed workflow state', async () => {
    const states = await Promise.all(
      ['jira', 'github-issues', 'plan-md'].map(async (adapter) => {
        const module = await import(
          `${pathToFileURL(path.join(scriptsDir, 'queue', `${adapter}.mjs`)).href}?claimed-state=${Date.now()}`
        );
        return [adapter, module.claimedState];
      }),
    );

    expect(Object.fromEntries(states)).toEqual({
      jira: 'in-progress',
      'github-issues': 'in-progress',
      'plan-md': 'open',
    });
  });

  it('accepts the Rig claim transition from open at SELECT to in-progress at BEFORE_PR', async () => {
    const p = await project();
    expect((await next(p)).code).toBe(0);
    if (!(await trackClaim(p))) return;

    await p.setIssue(
      jiraIssue({
        updated: T2,
        status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      }),
    );

    const result = await before(p, 'BEFORE_PR');
    expect(result.code, result.out).toBe(0);
    expect(jsonOf(result)).toMatchObject({
      result: 'CURRENT',
      action: 'continue',
    });
    expect(jsonOf(result).source ?? []).not.toContain('claim:scope');
  });

  it('holds claim:scope when workflow state returns to open after the Rig claim transition', async () => {
    const p = await project();
    expect((await next(p)).code).toBe(0);
    if (!(await trackClaim(p))) return;

    await p.setIssue(
      jiraIssue({
        updated: T2,
        status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      }),
    );
    await p.setIssue(jiraIssue({ updated: T2 }));

    const result = await before(p, 'BEFORE_PR');
    expect(result.code, result.out).toBe(2);
    expect(jsonOf(result)).toMatchObject({
      result: 'CHANGED',
      action: 'hold',
      movedFingerprintSet: expect.arrayContaining(['scope']),
      source: expect.arrayContaining(['claim:scope']),
    });
    expect(jsonOf(result).source ?? []).not.toContain('task:state');
  });
});

describe('commentary fingerprints are ids/count and hold only at close', () => {
  it('defers an added comment through SELECT and BEFORE_PR, then holds at BEFORE_CLOSE', async () => {
    const p = await project();
    expect((await next(p)).code).toBe(0);
    if (!(await trackClaim(p))) return;
    const withNewComment = jiraIssue({
      updated: T2,
      comment: {
        total: 2,
        comments: [
          { id: '10001', body: description(`${COMMENT_SENTINEL} — rewritten`) },
          { id: '10002', body: description('new commentary content is irrelevant') },
        ],
      },
    });
    await p.setIssue(withNewComment);

    const select = jsonOf(await next(p)).revalidation;
    expect(select).toMatchObject({ result: 'CURRENT', action: 'continue' });
    expect(select.movedFingerprintSet ?? []).not.toContain('commentary');

    await p.setIssue(
      jiraIssue({
        ...withNewComment.fields,
        status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      }),
    );

    const pr = await before(p, 'BEFORE_PR');
    expect(pr.code, pr.out).toBe(0);
    const beforePr = jsonOf(pr);
    expect(beforePr.action).toBe('continue');
    expect(beforePr.movedFingerprintSet ?? []).not.toContain('commentary');

    await p.setIssue(
      jiraIssue({
        ...withNewComment.fields,
        status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      }),
    );
    const close = await before(p, 'BEFORE_CLOSE');
    expect(close.code, close.out).toBe(2);
    const beforeClose = jsonOf(close);
    expect(beforeClose.action).toBe('hold');
    expect(beforeClose.movedFingerprintSet).toEqual(expect.arrayContaining(['commentary']));
    expect(JSON.stringify(beforeClose)).not.toContain(COMMENT_SENTINEL);
    expect(JSON.stringify(beforeClose)).not.toContain('new commentary content is irrelevant');
  });
});

describe('Jira commentary fingerprints require the complete id set', () => {
  it('refuses SELECT when comment.total exceeds the returned comment ids', async () => {
    const p = await project();
    await p.setIssue(
      jiraIssue({
        comment: {
          total: 2,
          comments: [{ id: '10001', body: description(COMMENT_SENTINEL) }],
        },
      }),
    );

    const selection = await next(p);

    expect(selection.code, selection.out).toBe(2);
    expect(jsonOf(selection).revalidation).toMatchObject({
      result: 'UNVERIFIABLE',
      action: 'unverifiable',
    });
    expect(JSON.stringify(jsonOf(selection).revalidation)).toMatch(
      /comment.*(incomplete|truncated|missing|total)/i,
    );
    expect(existsSync(p.claimPath)).toBe(false);
  });

  it('never returns CURRENT for same-total unseen ID changes at BEFORE_CLOSE', async () => {
    const p = await project();
    await p.setIssue(
      jiraIssue({
        comment: {
          total: 2,
          comments: [
            { id: '10001', body: description(COMMENT_SENTINEL) },
            { id: '10002', body: description('second complete comment') },
          ],
        },
      }),
    );
    expect((await next(p)).code).toBe(0);
    if (!(await trackClaim(p))) return;
    const legacyClaim = JSON.parse(await readFile(p.claimPath, 'utf8'));
    legacyClaim.fingerprints.commentary.value = createHash('sha256')
      .update(JSON.stringify({ count: 2, ids: ['10001'] }))
      .digest('hex');
    await writeFile(p.claimPath, `${JSON.stringify(legacyClaim)}\n`);
    await git(['add', '.rig/claims/RP-50.json'], p.root);
    await git(['commit', '-q', '-m', 'track legacy truncated commentary baseline'], p.root);
    await p.setIssue(
      jiraIssue({
        comment: {
          total: 2,
          comments: [{ id: '10001', body: description(COMMENT_SENTINEL) }],
        },
        status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      }),
    );

    const close = await before(p, 'BEFORE_CLOSE');

    expect(close.code, close.out).toBe(2);
    expect(jsonOf(close)).toMatchObject({ result: 'UNVERIFIABLE', action: 'unverifiable' });
    expect(JSON.stringify(jsonOf(close))).toMatch(/comment.*(incomplete|truncated|missing|total)/i);
  });
});

describe('GitHub commentary fingerprints require proof beyond the capped list window', () => {
  const comments = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ id: `IC_kwDO-comment-${index + 1}` }));
  const issue = (over: Record<string, unknown> = {}) => ({
    number: 50,
    title: 'GitHub capped commentary fixture',
    body: SCOPE_SENTINEL,
    state: 'OPEN',
    labels: [],
    url: 'https://example.invalid/issues/50',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: T1,
    comments: comments(100),
    ...over,
  });

  it('refuses SELECT when the transport returns exactly its 100-comment window without a total', async () => {
    const p = await project();
    const claimPath = path.join(p.root, '.rig', 'claims', '50.json');
    await writeFile(
      p.configPath,
      JSON.stringify({ adapter: 'github-issues', options: { issues: [issue()] } }),
    );

    const selection = await next(p);

    expect(selection.code).toBe(2);
    expect(jsonOf(selection).revalidation).toMatchObject({
      ticket: '50',
      result: 'UNVERIFIABLE',
      action: 'unverifiable',
    });
    expect(JSON.stringify(jsonOf(selection).revalidation)).toMatch(
      /comment.*(complete|cap|limit|window|total)/i,
    );
    expect(existsSync(claimPath)).toBe(false);
  });

  it('never returns CURRENT for a tracked legacy baseline at the 100-comment cap', async () => {
    const p = await project();
    const claimPath = path.join(p.root, '.rig', 'claims', '50.json');
    await writeFile(
      p.configPath,
      JSON.stringify({
        adapter: 'github-issues',
        options: { issues: [issue({ comments: comments(99) })] },
      }),
    );
    expect((await next(p)).code).toBe(0);
    const legacyClaim = JSON.parse(await readFile(claimPath, 'utf8'));
    const cappedIds = comments(100)
      .map((comment) => comment.id)
      .sort();
    legacyClaim.fingerprints.commentary.value = createHash('sha256')
      .update(JSON.stringify({ count: 100, ids: cappedIds }))
      .digest('hex');
    legacyClaim.fingerprints.commentary.count = 100;
    await writeFile(claimPath, `${JSON.stringify(legacyClaim)}\n`);
    await git(['add', '.rig/claims/50.json'], p.root);
    await git(['commit', '-q', '-m', 'track legacy capped GitHub commentary baseline'], p.root);
    await writeFile(
      p.configPath,
      JSON.stringify({
        adapter: 'github-issues',
        options: {
          issues: [issue({ labels: [{ name: 'in-progress' }] })],
        },
      }),
    );

    const close = await run(
      process.execPath,
      [
        revalidateScript,
        '--point',
        'BEFORE_CLOSE',
        '--ticket',
        '50',
        '--base',
        'master',
        '--config',
        p.configPath,
        '--json',
      ],
      p.root,
      p.env,
    );

    expect(close.code, close.out).toBe(2);
    expect(jsonOf(close)).toMatchObject({
      ticket: '50',
      result: 'UNVERIFIABLE',
      action: 'unverifiable',
    });
    expect(JSON.stringify(jsonOf(close))).toMatch(/comment.*(complete|cap|limit|window|total)/i);
  });
});

describe('a missing durable claim blocks every resumed checkpoint', () => {
  it.each(['SELECT', 'BEFORE_PR', 'BEFORE_CLOSE'] as const)(
    '%s returns UNVERIFIABLE instead of progressing',
    async (point) => {
      const p = await project();
      expect((await next(p)).code).toBe(0);
      if (!(await trackClaim(p))) return;
      await rm(p.claimPath, { force: true });
      if (point === 'BEFORE_CLOSE') {
        await p.setIssue(
          jiraIssue({ status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } }),
        );
      }

      const result = point === 'SELECT' ? await next(p) : await before(p, point);
      expect(result.code, result.out).toBe(2);
      const output = jsonOf(result);
      const revalidation = point === 'SELECT' ? output.revalidation : output;
      expect(revalidation).toMatchObject({ result: 'UNVERIFIABLE', action: 'unverifiable' });
      expect(JSON.stringify(revalidation)).toMatch(/missing.*\.rig\/claims\/RP-50\.json/i);
    },
  );

  it('refuses a deleted tracked claim in a fresh run without take-up markers', async () => {
    const p = await project();
    expect((await next(p)).code).toBe(0);
    if (!(await trackClaim(p))) return;
    await rm(p.claimPath);
    const freshRun = path.join(p.root, '.claude', 'runs', '20260828-130000');
    await mkdir(freshRun, { recursive: true });
    const fresh = { ...p, runDir: freshRun, env: { ...p.env, RIG_RUN_DIR: freshRun } };

    const result = await next(fresh);
    expect(result.code, result.out).toBe(2);
    expect(jsonOf(result).revalidation).toMatchObject({
      result: 'UNVERIFIABLE',
      action: 'unverifiable',
    });
  });

  it('names an unverifiable claim in text mode instead of silently printing the ticket', async () => {
    const p = await project();
    expect((await next(p)).code).toBe(0);
    if (!(await trackClaim(p))) return;
    await rm(p.claimPath);

    const result = await nextText(p);
    expect(result.code, result.out).toBe(2);
    expect(result.stdout).toMatch(/revalidate: RP-50 unverifiable/i);
    expect(result.stdout).toContain('.rig/claims/RP-50.json');
  });
});

describe('the v0.1 repository revalidation contract', () => {
  it.each([
    ['missing', null],
    [
      'invalid',
      {
        ...VALID_CONTRACT,
        pairedFacts: [{ id: 'not-a-pair', paths: ['paired-alpha.txt'] }],
      },
    ],
  ])('preflight hard-refuses a %s contract as no-detection-contract', async (_label, contract) => {
    const output = await runPreflight(contract);
    expect(output.verdict).toBe('STOP');
    expect(JSON.stringify(output)).toContain('no-detection-contract');
    expect(valuesFor(output, 'detectionContract')[0]).toMatchObject({ ok: false });
  });

  it('accepts the default pull/run-state+journal/24h/no-push contract', async () => {
    const output = await runPreflight(VALID_CONTRACT);
    expect(valuesFor(output, 'detectionContract')[0]).toMatchObject({ ok: true });
    const evidence = JSON.stringify(valuesFor(output, 'detectionContract')[0]).toLowerCase();
    expect(evidence).toContain('pull');
    expect(evidence).toMatch(/run.?state/);
    expect(evidence).toContain('journal');
    expect(evidence).toContain('24h');
    expect(evidence).toMatch(/no.?push|"push":false/);
    expect(JSON.stringify(output)).not.toContain('no-detection-contract');
  });

  it('refuses a paired-fact symlink instead of hashing outside the repository', async () => {
    const p = await project();
    const outside = path.join(path.dirname(p.root), 'outside-revalidation-content.txt');
    await writeFile(outside, 'outside content must not be read\n');
    await rm(path.join(p.root, 'paired-alpha.txt'));
    await symlink(outside, path.join(p.root, 'paired-alpha.txt'));

    const result = await next(p);
    expect(result.code, result.out).toBe(2);
    const detection = jsonOf(result).revalidation;
    expect(detection).toMatchObject({ result: 'UNVERIFIABLE', action: 'unverifiable' });
    expect(JSON.stringify(detection)).not.toContain('outside content must not be read');
  });
});

describe('paired facts participate in the content-blind scope set', () => {
  it.each([
    ['paired-alpha.txt', 'paired fact alpha changed but never echoed'],
    ['paired-beta.txt', 'paired fact beta changed but never echoed'],
  ])('BEFORE_PR holds when %s changes', async (file, changedContent) => {
    const p = await project();
    expect((await next(p)).code).toBe(0);
    if (!(await trackClaim(p))) return;
    await writeFile(path.join(p.root, file), `${changedContent}\n`);
    await git(['add', file], p.root);
    await git(['commit', '-q', '-m', `change ${file}`], p.root);

    const result = await before(p, 'BEFORE_PR');
    expect(result.code, result.out).toBe(2);
    const detection = jsonOf(result);
    expect(detection).toMatchObject({ result: 'CHANGED', action: 'hold' });
    expect(detection.movedFingerprintSet).toEqual(expect.arrayContaining(['scope']));
    expect(detection.sourcePointer).toMatch(/\.rig\/claims\/RP-50\.json/);
    const evidence = JSON.stringify(detection);
    expect(evidence).not.toContain(changedContent);
    for (const content of PAIRED_CONTENT) expect(evidence).not.toContain(content);
  });
});

describe('a checkpoint hold becomes a selector stop input', () => {
  it.each(['CHANGED', 'UNVERIFIABLE'] as const)(
    '%s writes revalidation-hold to run state and stops the next selection',
    async (kind) => {
      const p = await project();
      expect((await next(p)).code).toBe(0);
      if (!(await trackClaim(p))) return;
      if (kind === 'CHANGED') {
        await p.setIssue(
          jiraIssue({ description: description(`${SCOPE_SENTINEL} — changed after SELECT`) }),
        );
      } else {
        await rm(p.claimPath);
      }

      const checkpoint = await before(p, 'BEFORE_PR');
      expect(checkpoint.code, checkpoint.out).toBe(2);
      expect(jsonOf(checkpoint).result).toBe(kind);

      const state = JSON.parse(await readFile(path.join(p.runDir, 'state.json'), 'utf8'));
      const stateEvidence = JSON.stringify(state);
      expect(stateEvidence).toContain('revalidation-hold');
      expect(stateEvidence).toContain('RP-50');
      expect(stateEvidence).toContain('BEFORE_PR');
      expect(stateEvidence).toContain(kind);

      const selection = await next(p);
      expect(selection.code, selection.out).toBe(1);
      expect(jsonOf(selection).stop).toMatchObject({ kind: 'revalidation-hold', success: false });
    },
  );
});

describe('selection reconciles unresolved append-only revalidation evidence', () => {
  it.each([
    ['absent state', 'CHANGED', false],
    ['empty state', 'CHANGED', true],
    ['absent state', 'CONFLICT', false],
    ['empty state', 'UNVERIFIABLE', true],
  ] as const)(
    'stops with %s when the unresolved journal result is %s',
    async (_stateCase, result, writeEmptyState) => {
      const p = await project();
      expect((await next(p)).code).toBe(0);
      if (!(await trackClaim(p))) return;
      const statePath = path.join(p.runDir, 'state.json');
      if (writeEmptyState) await writeFile(statePath, '{}\n');
      else await rm(statePath, { force: true });
      const journal = await import(pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href);
      journal.recordEvent({
        runDir: p.runDir,
        kind: 'revalidation',
        data: {
          schemaVersion: 1,
          id: `unresolved-${result.toLowerCase()}-${writeEmptyState ? 'empty' : 'absent'}`,
          ticket: 'RP-50',
          point: 'BEFORE_PR',
          checkpoint: 'BEFORE_PR',
          result,
          changed: result === 'UNVERIFIABLE' ? null : true,
          source: result === 'UNVERIFIABLE' ? [] : ['claim:scope'],
          action: result === 'UNVERIFIABLE' ? 'unverifiable' : 'hold',
          movedFingerprintSet: result === 'UNVERIFIABLE' ? [] : ['scope'],
          sourcePointer: '.rig/claims/RP-50.json',
          observedAt: T2,
        },
        now: T2,
      });

      const selection = await next(p);

      expect(selection.code, selection.out).toBe(1);
      expect(jsonOf(selection).stop).toMatchObject({
        kind: 'revalidation-hold',
        success: false,
      });
    },
  );

  it.each(['absent', 'empty'] as const)(
    'keeps a detection unresolved with %s state when its typed outcome has no boolean verdict',
    async (stateMode) => {
      const p = await project();
      expect((await next(p)).code).toBe(0);
      if (!(await trackClaim(p))) return;
      const journal = await import(pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href);
      const detectionId = `missing-boolean-${stateMode}`;
      journal.recordEvent({
        runDir: p.runDir,
        kind: 'revalidation',
        data: {
          schemaVersion: 1,
          id: detectionId,
          ticket: 'RP-50',
          point: 'BEFORE_PR',
          checkpoint: 'BEFORE_PR',
          result: 'CHANGED',
          changed: true,
          source: ['claim:scope'],
          action: 'hold',
          movedFingerprintSet: ['scope'],
          sourcePointer: '.rig/claims/RP-50.json',
          observedAt: T1,
        },
        now: T1,
      });
      journal.recordEvent({
        runDir: p.runDir,
        kind: 'revalidation-outcome',
        data: {
          detectionId,
          action: 'continue',
          driftOrigin: 'operator',
          resolvedAt: T2,
        },
        now: T2,
      });
      const statePath = path.join(p.runDir, 'state.json');
      if (stateMode === 'empty') await writeFile(statePath, '{}\n');
      else await rm(statePath, { force: true });

      const selection = await next(p);

      expect(selection.code, selection.out).toBe(1);
      expect(jsonOf(selection).stop).toMatchObject({
        kind: 'revalidation-hold',
        success: false,
      });
    },
  );
});

describe('claim record shape is fail-closed', () => {
  it('refuses a tracked claim symlink instead of following it', async () => {
    const p = await project();
    expect((await next(p)).code).toBe(0);
    if (!(await trackClaim(p))) return;
    const copy = path.join(p.root, 'claim-copy.json');
    await writeFile(copy, await readFile(p.claimPath));
    await rm(p.claimPath);
    await symlink('../../claim-copy.json', p.claimPath);
    await git(['add', '.rig/claims/RP-50.json'], p.root);
    await git(['commit', '-q', '-m', 'replace claim with symlink'], p.root);

    const result = await next(p);
    expect(result.code, result.out).toBe(2);
    expect(jsonOf(result).revalidation).toMatchObject({
      result: 'UNVERIFIABLE',
      action: 'unverifiable',
    });
  });

  it('treats a non-SHA fingerprint as UNVERIFIABLE', async () => {
    const p = await project();
    expect((await next(p)).code).toBe(0);
    if (!(await trackClaim(p))) return;
    const claim = JSON.parse(await readFile(p.claimPath, 'utf8'));
    claim.fingerprints.scope.value = 'not-a-sha';
    await writeFile(p.claimPath, `${JSON.stringify(claim)}\n`);
    await git(['add', '.rig/claims/RP-50.json'], p.root);
    await git(['commit', '-q', '-m', 'malformed claim fixture'], p.root);

    const result = await before(p, 'BEFORE_PR');
    expect(result.code, result.out).toBe(2);
    expect(jsonOf(result)).toMatchObject({ result: 'UNVERIFIABLE', action: 'unverifiable' });
  });

  it('accepts a tracked claim whose target branch uses a Git SHA-256 object id', async () => {
    const p = await project();
    const targetSha = 'a'.repeat(64);
    const ticket = {
      id: 'RP-50',
      title: 'Git SHA-256 claim fixture',
      body: null,
      labels: [],
      blockedBy: [],
      blocks: [],
      commentary: { count: 0, ids: [] },
    };
    const claimRecords = (await import(
      `${pathToFileURL(claimRecordsScript).href}?git-sha256=${Date.now()}`
    )) as {
      revalidateClaim: (input: Record<string, unknown>) => Record<string, unknown>;
    };

    expect(
      claimRecords.revalidateClaim({
        projectRoot: p.root,
        ticket,
        point: 'SELECT',
        targetSha,
        allowCreate: true,
        isResume: false,
      }),
    ).toMatchObject({ result: 'BASELINE_CREATED', action: 'continue' });
    await git(['add', '.rig/claims/RP-50.json'], p.root);
    await git(['commit', '-q', '-m', 'track SHA-256 claim fixture'], p.root);

    expect(
      claimRecords.revalidateClaim({
        projectRoot: p.root,
        ticket,
        point: 'BEFORE_PR',
        targetSha,
        allowCreate: false,
        isResume: true,
      }),
    ).toMatchObject({ result: 'CURRENT', action: 'continue' });
  });
});

describe('journal evidence identifies detections without copying content', () => {
  it('reuses a stable detection id for the same drift at the same checkpoint', async () => {
    const p = await project();
    expect((await next(p)).code).toBe(0);
    if (!(await trackClaim(p))) return;
    await p.setIssue(
      jiraIssue({ description: description(`${SCOPE_SENTINEL} — detection evidence change`) }),
    );
    expect((await before(p, 'BEFORE_PR')).code).toBe(2);
    expect((await before(p, 'BEFORE_PR')).code).toBe(2);

    const detections = (await eventsOf(p.runDir))
      .filter((event) => event.kind === 'revalidation')
      .map((event) => event.data)
      .filter((data) => data?.result === 'CHANGED' && data?.point === 'BEFORE_PR');
    expect(detections).toHaveLength(2);
    for (const detection of detections) {
      expect(detection).toMatchObject({
        schemaVersion: 1,
        id: expect.any(String),
        ticket: 'RP-50',
        checkpoint: 'BEFORE_PR',
        result: 'CHANGED',
        movedFingerprintSet: expect.arrayContaining(['scope']),
        sourcePointer: expect.stringMatching(/\.rig\/claims\/RP-50\.json/),
      });
      expect(JSON.stringify(detection)).not.toContain(SCOPE_SENTINEL);
    }
    expect(detections[1]!.id).toBe(detections[0]!.id);
  });
});

describe('revalidate outcome resolves a detection and makes false-HOLD observable', () => {
  it('journals a typed resolution through the existing outcome command', async () => {
    const p = await project();
    expect((await next(p)).code).toBe(0);
    if (!(await trackClaim(p))) return;
    await p.setIssue(
      jiraIssue({ description: description(`${SCOPE_SENTINEL} — operator reviewed drift`) }),
    );
    expect((await before(p, 'BEFORE_PR')).code).toBe(2);
    const detection = (await eventsOf(p.runDir))
      .filter((event) => event.kind === 'revalidation')
      .map((event) => event.data)
      .find((data) => data?.result === 'CHANGED' && data?.point === 'BEFORE_PR');

    expect((await reportOf(p)).totals.falseHolds).toBe(0);
    const result = await run(
      process.execPath,
      [
        revalidateScript,
        'outcome',
        '--point',
        'BEFORE_PR',
        '--ticket',
        'RP-50',
        '--action-changed',
        'false',
        '--note',
        'content-blind comparison required no action',
        '--json',
      ],
      p.root,
      p.env,
    );
    expect(result.code, result.out).toBe(0);
    const resolution = jsonOf(result).data;
    expect(resolution).toMatchObject({
      detectionId: expect.any(String),
      action: expect.stringMatching(/^(continue|refresh|stop|semantic decision|codify)$/),
      actionRequired: false,
      driftOrigin: expect.stringMatching(/^(operator|third-party|merge-ci|dependency|unknown)$/),
      resolvedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(resolution.detectionId).toBe(detection?.id);
    const state = JSON.parse(await readFile(path.join(p.runDir, 'state.json'), 'utf8'));
    expect(state).not.toHaveProperty('revalidationHold');
    expect((await reportOf(p)).totals.falseHolds).toBe(1);
  });

  it('derives false-HOLD from result != CURRENT and actionRequired false, only after resolution', async () => {
    const { reportOf: classify } = (await import(pathToFileURL(reportScript).href)) as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reportOf: (input: { runs: unknown[]; since: string }) => Record<string, any>;
    };
    const detection = {
      seq: 1,
      at: '2026-08-28T12:00:00.000Z',
      kind: 'revalidation',
      data: {
        schemaVersion: 1,
        id: 'stable-detection-id',
        ticket: 'RP-50',
        point: 'BEFORE_PR',
        checkpoint: 'BEFORE_PR',
        result: 'CHANGED',
        movedFingerprintSet: ['scope'],
        sourcePointer: '.rig/claims/RP-50.json',
      },
    };
    const base = {
      runs: [{ run: 'run-a', events: [detection] }],
      since: '2026-01-01T00:00:00.000Z',
    };
    expect(classify(base).totals.falseHolds).toBe(0);

    const resolution = {
      seq: 2,
      at: '2026-08-28T12:01:00.000Z',
      kind: 'revalidation-outcome',
      data: {
        detectionId: 'stable-detection-id',
        action: 'continue',
        actionRequired: false,
        driftOrigin: 'operator',
        resolvedAt: '2026-08-28T12:01:00.000Z',
      },
    };
    expect(
      classify({ ...base, runs: [{ run: 'run-a', events: [detection, resolution] }] }).totals
        .falseHolds,
    ).toBe(1);
  });

  it('joins a typed resolution to its detection across run directories', async () => {
    const { reportOf: classify } = (await import(pathToFileURL(reportScript).href)) as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reportOf: (input: { runs: unknown[]; since: string }) => Record<string, any>;
    };
    const detection = {
      seq: 1,
      at: '2026-08-28T12:00:00.000Z',
      kind: 'revalidation',
      data: {
        id: 'cross-run-detection',
        point: 'BEFORE_PR',
        result: 'CHANGED',
      },
    };
    const resolution = {
      seq: 1,
      at: '2026-08-28T12:01:00.000Z',
      kind: 'revalidation-outcome',
      data: {
        detectionId: 'cross-run-detection',
        action: 'continue',
        actionRequired: false,
      },
    };

    const report = classify({
      runs: [
        { run: 'run-a', events: [detection] },
        { run: 'run-b', events: [resolution] },
      ],
      since: '2026-01-01T00:00:00.000Z',
    });
    expect(report.totals).toMatchObject({ falseHolds: 1, unresolved: 0 });
  });

  it('keeps a detection unresolved when a malformed resolution has no boolean verdict', async () => {
    const { reportOf: classify } = (await import(pathToFileURL(reportScript).href)) as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reportOf: (input: { runs: unknown[]; since: string }) => Record<string, any>;
    };
    const detection = {
      seq: 1,
      at: '2026-08-28T12:00:00.000Z',
      kind: 'revalidation',
      data: {
        id: 'malformed-resolution-detection',
        point: 'BEFORE_PR',
        result: 'CHANGED',
      },
    };
    const malformedResolution = {
      seq: 2,
      at: '2026-08-28T12:01:00.000Z',
      kind: 'revalidation-outcome',
      data: {
        detectionId: 'malformed-resolution-detection',
        action: 'continue',
      },
    };

    const report = classify({
      runs: [{ run: 'run-a', events: [detection, malformedResolution] }],
      since: '2026-01-01T00:00:00.000Z',
    });
    expect(report.totals).toMatchObject({ falseHolds: 0, unresolved: 1 });
  });
});

describe('reviewer hardening — SELECT cannot bypass or recreate durable evidence', () => {
  it('returns UNVERIFIABLE when SELECT has neither a run directory nor a detection contract', async () => {
    const p = await project();
    await rm(path.join(p.root, '.rig', 'revalidation.json'));
    const env = { ...p.env };
    delete env.RIG_RUN_DIR;

    const result = await run(
      process.execPath,
      [queueScript, 'next', '--config', p.configPath, '--json'],
      p.root,
      env,
    );

    expect(result.code, result.out).toBe(2);
    expect(jsonOf(result).revalidation).toMatchObject({
      result: 'UNVERIFIABLE',
      action: 'unverifiable',
    });
    expect(JSON.stringify(jsonOf(result).revalidation)).toMatch(/no-detection-contract/i);
  });

  it.each([
    ['readable prior journal', false],
    ['corrupt prior journal', true],
  ])(
    'does not recreate a deleted untracked baseline on a fresh-run resume with a %s',
    async (_label, corruptJournal) => {
      const p = await project();
      const baseline = await next(p);
      expect(baseline.code, baseline.out).toBe(0);
      expect(jsonOf(baseline).revalidation.result).toBe('BASELINE_CREATED');
      await rm(p.claimPath);
      if (corruptJournal) {
        await writeFile(path.join(p.runDir, 'events.jsonl'), '{not valid journal json\n');
      }

      const freshRunDir = path.join(p.root, '.claude', 'runs', '20260828-130000');
      await mkdir(freshRunDir, { recursive: true });
      const result = await run(
        process.execPath,
        [queueScript, 'next', '--config', p.configPath, '--json'],
        p.root,
        { ...p.env, RIG_RUN_DIR: freshRunDir },
      );

      expect(result.code, result.out).toBe(2);
      expect(jsonOf(result).revalidation).toMatchObject({
        result: 'UNVERIFIABLE',
        action: 'unverifiable',
      });
      expect(jsonOf(result).revalidation.result).not.toBe('BASELINE_CREATED');
      expect(existsSync(p.claimPath)).toBe(false);
      if (corruptJournal) {
        expect(JSON.stringify(jsonOf(result).revalidation)).toMatch(
          /journal.*(invalid|unreadable|corrupt)/i,
        );
      }
    },
  );
});

describe('UNVERIFIABLE detection identity is checkout-independent', () => {
  it('uses the same id for the same missing-contract condition in two absolute roots', async () => {
    const projects = await Promise.all([project(), project()]);
    await Promise.all(projects.map((p) => rm(path.join(p.root, '.rig', 'revalidation.json'))));

    const results = await Promise.all(projects.map(next));
    const detections = results.map((result) => {
      expect(result.code, result.out).toBe(2);
      return jsonOf(result).revalidation;
    });

    expect.soft(detections[1].id).toBe(detections[0].id);
    for (const [index, detection] of detections.entries()) {
      expect(detection).toMatchObject({ result: 'UNVERIFIABLE', action: 'unverifiable' });
      expect.soft(JSON.stringify(detection)).not.toContain(projects[index]!.root);
    }
  });
});

describe('an incomplete sibling-run search cannot authorize a first baseline', () => {
  it.each(['candidate cap', 'entry budget'] as const)(
    'returns UNVERIFIABLE when the %s truncates prior SELECT evidence',
    async (limit) => {
      const p = await project();
      const runsRoot = path.dirname(p.runDir);
      try {
        if (limit === 'candidate cap') {
          await Promise.all(
            Array.from({ length: 201 }, (_, index) =>
              mkdir(path.join(runsRoot, `20260827-${String(index).padStart(6, '0')}`)),
            ),
          );
        } else {
          const names = Array.from(
            { length: 10_001 },
            (_, index) => `non-run-entry-${String(index).padStart(5, '0')}`,
          );
          for (let offset = 0; offset < names.length; offset += 250) {
            await Promise.all(
              names.slice(offset, offset + 250).map((name) => mkdir(path.join(runsRoot, name))),
            );
          }
        }

        const selection = await next(p);
        const revalidation = jsonOf(selection).revalidation;

        expect.soft(selection.code, selection.out).toBe(2);
        expect.soft(revalidation).toMatchObject({
          result: 'UNVERIFIABLE',
          action: 'unverifiable',
        });
        expect.soft(revalidation.result).not.toBe('BASELINE_CREATED');
        expect(JSON.stringify(revalidation.evidence)).toMatch(
          /(incomplete|truncated|limit|cap|budget)/i,
        );
      } finally {
        await rm(p.root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe('markerless plan-md resume derives from the durable SELECT journal', () => {
  it.each([
    ['readable prior SELECT journal', false],
    ['corrupt prior SELECT journal', true],
  ])(
    'refuses to recreate a deleted untracked baseline with a %s',
    async (_label, corruptJournal) => {
      const p = await project();
      await writeFile(
        path.join(p.root, 'PLAN.md'),
        '# Project\n\n## Agent queue\n\n- RP-50 plan item\n',
      );
      await writeFile(p.configPath, JSON.stringify({ adapter: 'plan-md' }));
      const planClaim = path.join(p.root, '.rig', 'claims', '1.json');

      const baseline = await next(p);
      expect(baseline.code, baseline.out).toBe(0);
      expect(jsonOf(baseline).revalidation).toMatchObject({
        ticket: '1',
        point: 'SELECT',
        result: 'BASELINE_CREATED',
      });
      expect(
        (await eventsOf(p.runDir)).some(
          (event) =>
            event.kind === 'revalidation' &&
            event.data?.ticket === '1' &&
            event.data?.result === 'BASELINE_CREATED',
        ),
      ).toBe(true);
      expect(existsSync(path.join(p.runDir, 'state.json'))).toBe(false);
      await rm(planClaim);
      if (corruptJournal) {
        await writeFile(path.join(p.runDir, 'events.jsonl'), '{not valid journal json\n');
      }

      const freshRunDir = path.join(p.root, '.claude', 'runs', '20260828-140000');
      await mkdir(freshRunDir, { recursive: true });
      const resumed = await run(
        process.execPath,
        [queueScript, 'next', '--config', p.configPath, '--json'],
        p.root,
        { ...p.env, RIG_RUN_DIR: freshRunDir },
      );

      expect(resumed.code, resumed.out).toBe(2);
      expect(jsonOf(resumed).revalidation).toMatchObject({
        ticket: '1',
        result: 'UNVERIFIABLE',
        action: 'unverifiable',
      });
      expect(jsonOf(resumed).revalidation.result).not.toBe('BASELINE_CREATED');
      expect(existsSync(planClaim)).toBe(false);
      if (corruptJournal) {
        expect(JSON.stringify(jsonOf(resumed).revalidation)).toMatch(
          /journal.*(invalid|unreadable|corrupt)/i,
        );
      }
    },
  );
});

describe('resolution time bounds a stable detection id', () => {
  it('does not resolve a later detection with an earlier same-id resolution', async () => {
    const { reportOf: classify } = (await import(pathToFileURL(reportScript).href)) as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reportOf: (input: { runs: unknown[]; since: string }) => Record<string, any>;
    };
    const resolution = {
      seq: 1,
      at: '2026-08-28T12:00:00.000Z',
      kind: 'revalidation-outcome',
      data: {
        detectionId: 'reused-detection-id',
        action: 'continue',
        actionRequired: false,
        resolvedAt: '2026-08-28T12:00:00.000Z',
      },
    };
    const laterDetection = {
      seq: 2,
      at: '2026-08-28T13:00:00.000Z',
      kind: 'revalidation',
      data: {
        id: 'reused-detection-id',
        point: 'BEFORE_PR',
        result: 'CHANGED',
      },
    };

    const report = classify({
      runs: [{ run: 'run-a', events: [resolution, laterDetection] }],
      since: '2026-01-01T00:00:00.000Z',
    });

    expect(report.totals).toMatchObject({ falseHolds: 0, unresolved: 1 });
  });
});

describe('repository paths stay inside the repository', () => {
  it('rejects a paired-fact path whose ancestor symlink escapes the repository', async () => {
    const p = await project();
    const outside = await mkdtemp(path.join(tmpdir(), 'paired-fact-outside-'));
    const outsideContent = ['outside', 'paired', 'content'].join('-');
    await writeFile(path.join(outside, 'fact.txt'), outsideContent);
    await symlink(
      outside,
      path.join(p.root, 'linked-facts'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await writeFile(
      path.join(p.root, '.rig', 'revalidation.json'),
      JSON.stringify({
        ...VALID_CONTRACT,
        pairedFacts: [{ id: 'escaped-pair', paths: ['linked-facts/fact.txt', 'paired-beta.txt'] }],
      }),
    );
    await git(['add', '.rig/revalidation.json'], p.root);
    await git(['commit', '-q', '-m', 'declare escaped paired fact fixture'], p.root);

    const result = await next(p);

    expect(result.code, result.out).toBe(2);
    expect(jsonOf(result).revalidation).toMatchObject({
      result: 'UNVERIFIABLE',
      action: 'unverifiable',
    });
    expect(JSON.stringify(jsonOf(result).revalidation)).toMatch(
      /paired.*(escape|outside|symlink)/i,
    );
    expect(JSON.stringify(jsonOf(result).revalidation)).not.toContain(outsideContent);
  });

  it('does not write a baseline through a .rig/claims ancestor symlink', async () => {
    const p = await project();
    const outside = await mkdtemp(path.join(tmpdir(), 'claim-record-outside-'));
    await symlink(
      outside,
      path.join(p.root, '.rig', 'claims'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await next(p);

    expect(result.code, result.out).toBe(2);
    expect(jsonOf(result).revalidation).toMatchObject({
      result: 'UNVERIFIABLE',
      action: 'unverifiable',
    });
    expect(existsSync(path.join(outside, 'RP-50.json'))).toBe(false);
    expect(JSON.stringify(jsonOf(result).revalidation)).toMatch(/claim.*(escape|outside|symlink)/i);
  });
});

describe('a tracked claim must match the Git index', () => {
  it.each(['modified', 'replaced'])(
    'rejects a tracked claim %s only in the worktree',
    async (mode) => {
      const p = await project();
      expect((await next(p)).code).toBe(0);
      if (!(await trackClaim(p))) return;
      const claim = JSON.parse(await readFile(p.claimPath, 'utf8'));
      claim.fingerprints.scope.value = '0'.repeat(64);
      if (mode === 'replaced') await rm(p.claimPath);
      await writeFile(p.claimPath, `${JSON.stringify(claim)}\n`);

      const result = await next(p);

      expect(result.code, result.out).toBe(2);
      expect(jsonOf(result).revalidation).toMatchObject({
        result: 'UNVERIFIABLE',
        action: 'unverifiable',
      });
      expect(JSON.stringify(jsonOf(result).revalidation)).toMatch(
        /(index|tracked).*(worktree|diverg)/i,
      );
    },
  );

  it('does not copy malformed claim bytes into parse-error evidence', async () => {
    const p = await project();
    expect((await next(p)).code).toBe(0);
    if (!(await trackClaim(p))) return;
    const malformedSentinel = ['CLAIM', 'PARSE', 'BYTES', 'MUST', 'NOT', 'ECHO'].join('_');
    const leakedPrefix = malformedSentinel.slice(0, 10);
    await writeFile(p.claimPath, `{"schemaVersion":1,"value":${malformedSentinel}}`);
    await git(['add', '.rig/claims/RP-50.json'], p.root);
    await git(['commit', '-q', '-m', 'malformed tracked claim fixture'], p.root);

    const result = await next(p);

    expect(result.code, result.out).toBe(2);
    expect(jsonOf(result).revalidation).toMatchObject({
      result: 'UNVERIFIABLE',
      action: 'unverifiable',
    });
    expect(JSON.stringify(jsonOf(result).revalidation)).not.toContain(leakedPrefix);
    expect(JSON.stringify(jsonOf(result).revalidation)).toMatch(
      /claim.*(invalid|malformed|unreadable)/i,
    );
  });
});

describe('run-state uncertainty preserves the revalidation brake', () => {
  it('fails closed at selection when a corrupt state may contain revalidationHold', async () => {
    const p = await project();
    await writeFile(
      path.join(p.runDir, 'state.json'),
      '{"revalidationHold":{"kind":"revalidation-hold","ticket":"RP-50"',
    );

    const result = await next(p);

    expect(result.code, result.out).toBe(1);
    expect(jsonOf(result).stop).toMatchObject({ success: false });
    expect(JSON.stringify(jsonOf(result).stop)).toMatch(/state.*(corrupt|invalid|unreadable)/i);
    expect(jsonOf(result).revalidation).not.toMatchObject({ result: 'BASELINE_CREATED' });
    expect(existsSync(p.claimPath)).toBe(false);
  });

  it('rejects oversized selection state from metadata before attempting a full read', async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), 'oversized-selection-state-'));
    const statePath = path.join(runDir, 'state.json');
    await writeFile(statePath, Buffer.alloc(256 * 1024 + 1, 0x20));
    const require = createRequire(import.meta.url);
    const mutableFs = require('node:fs') as {
      readFileSync: (...args: unknown[]) => unknown;
    };
    const originalReadFileSync = mutableFs.readFileSync;
    let attemptedFullRead = false;
    mutableFs.readFileSync = (...args: unknown[]) => {
      if (path.resolve(String(args[0])) === path.resolve(statePath)) {
        attemptedFullRead = true;
        throw new Error('full selection-state read trap');
      }
      return originalReadFileSync(...args);
    };
    syncBuiltinESMExports();
    let failure: unknown;

    try {
      const runState = (await import(
        `${pathToFileURL(runStateScript).href}?oversized=${Date.now()}`
      )) as {
        readStateForSelection: (runDir: string) => unknown;
      };
      runState.readStateForSelection(runDir);
    } catch (error) {
      failure = error;
    } finally {
      mutableFs.readFileSync = originalReadFileSync;
      syncBuiltinESMExports();
    }

    expect.soft(attemptedFullRead).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/run state.*(exceeds|oversized|too large)/i);
  });

  it.each([
    ['record', 'corrupt'],
    ['clear', 'corrupt'],
    ['record', 'symlink'],
    ['clear', 'symlink'],
    ['record', 'oversized'],
    ['clear', 'oversized'],
  ] as const)(
    '%s refuses a present %s state instead of replacing unknown stop inputs',
    async (operation, shape) => {
      const runDir = await mkdtemp(path.join(tmpdir(), 'revalidation-hold-state-'));
      const statePath = path.join(runDir, 'state.json');
      const existingHold = {
        kind: 'revalidation-hold',
        ticket: 'RP-50',
        checkpoint: 'BEFORE_PR',
        result: 'CHANGED',
        detectionId: 'existing-detection',
      };
      try {
        if (shape === 'corrupt') {
          await writeFile(statePath, '{"budgetExhausted":true,"revalidationHold":');
        } else if (shape === 'oversized') {
          await writeFile(
            statePath,
            `${JSON.stringify({
              budgetExhausted: true,
              revalidationHold: existingHold,
              padding: 'x'.repeat(256 * 1024),
            })}\n`,
          );
        } else {
          const linkedState = path.join(runDir, 'linked-state.json');
          await writeFile(
            linkedState,
            `${JSON.stringify({ budgetExhausted: true, revalidationHold: existingHold })}\n`,
          );
          await symlink('linked-state.json', statePath, 'file');
        }
        const original = await readFile(statePath);
        const originalDigest = createHash('sha256').update(original).digest('hex');
        const runState = (await import(
          `${pathToFileURL(runStateScript).href}?hold-${operation}-${shape}=${Date.now()}`
        )) as {
          recordRevalidationHold: (runDir: string, detection: Record<string, unknown>) => unknown;
          clearRevalidationHold: (runDir: string, detectionId: string) => unknown;
        };
        let failure: unknown;

        try {
          if (operation === 'record') {
            runState.recordRevalidationHold(runDir, {
              ticket: 'RP-50',
              checkpoint: 'BEFORE_CLOSE',
              id: 'replacement-detection',
              result: 'UNVERIFIABLE',
            });
          } else {
            runState.clearRevalidationHold(runDir, 'existing-detection');
          }
        } catch (error) {
          failure = error;
        }

        expect.soft(failure).toBeInstanceOf(Error);
        expect
          .soft(String((failure as Error | undefined)?.message ?? ''))
          .toMatch(/run state.*(corrupt|invalid|unreadable|symlink|exceeds|oversized|too large)/i);
        const after = await readFile(statePath);
        expect.soft(createHash('sha256').update(after).digest('hex')).toBe(originalDigest);
        if (shape === 'corrupt') {
          expect.soft(after.toString('utf8')).toContain('"budgetExhausted":true');
        }
        if (shape === 'symlink') {
          expect((await lstat(statePath)).isSymbolicLink()).toBe(true);
        }
      } finally {
        await rm(runDir, { recursive: true, force: true });
      }
    },
  );
});

describe('the detection contract is classified before it is followed or fully read', () => {
  it('rejects a contract symlink instead of following its target', async () => {
    const p = await project();
    const outside = await mkdtemp(path.join(tmpdir(), 'contract-target-'));
    const outsideMarker = ['CONTRACT', 'SYMLINK', 'TARGET', 'BYTES'].join('_');
    const target = path.join(outside, 'revalidation.json');
    await writeFile(target, JSON.stringify({ ...VALID_CONTRACT, note: outsideMarker }));
    await rm(path.join(p.root, '.rig', 'revalidation.json'));
    await symlink(target, path.join(p.root, '.rig', 'revalidation.json'));

    const result = await next(p);

    expect(result.code, result.out).toBe(2);
    expect(jsonOf(result).revalidation).toMatchObject({
      result: 'UNVERIFIABLE',
      action: 'unverifiable',
    });
    expect(JSON.stringify(jsonOf(result).revalidation)).toMatch(
      /contract.*(symlink|regular file)/i,
    );
    expect(JSON.stringify(jsonOf(result).revalidation)).not.toContain(outsideMarker);
  });

  it('rejects a special contract path as not a regular file', async () => {
    const p = await project();
    await rm(path.join(p.root, '.rig', 'revalidation.json'));
    await mkdir(path.join(p.root, '.rig', 'revalidation.json'));

    const result = await next(p);

    expect(result.code, result.out).toBe(2);
    expect(jsonOf(result).revalidation).toMatchObject({
      result: 'UNVERIFIABLE',
      action: 'unverifiable',
    });
    expect(JSON.stringify(jsonOf(result).revalidation)).toMatch(/contract.*not a regular file/i);
  });

  it('rejects an oversized contract from metadata before attempting a full read', async () => {
    const p = await project();
    const contractPath = path.join(p.root, '.rig', 'revalidation.json');
    await writeFile(contractPath, Buffer.alloc(256 * 1024 + 1, 0x20));
    const require = createRequire(import.meta.url);
    const mutableFs = require('node:fs') as {
      readFileSync: (...args: unknown[]) => unknown;
    };
    const originalReadFileSync = mutableFs.readFileSync;
    let attemptedFullRead = false;
    mutableFs.readFileSync = (...args: unknown[]) => {
      if (path.resolve(String(args[0])) === path.resolve(contractPath)) {
        attemptedFullRead = true;
        throw new Error('full contract read trap');
      }
      return originalReadFileSync(...args);
    };
    syncBuiltinESMExports();

    try {
      const claimRecords = (await import(
        `${pathToFileURL(claimRecordsScript).href}?oversize=${Date.now()}`
      )) as {
        readRevalidationContract: (root: string) => unknown;
      };
      expect(() => claimRecords.readRevalidationContract(p.root)).toThrow(
        /no-detection-contract.*exceeds/i,
      );
      expect(attemptedFullRead).toBe(false);
    } finally {
      mutableFs.readFileSync = originalReadFileSync;
      syncBuiltinESMExports();
    }
  });
});

describe('claim persistence resists validation-to-use pathname swaps', () => {
  it('does not accept an external contract swapped in after containment validation', async () => {
    const p = await project();
    const contractPath = path.join(p.root, '.rig', 'revalidation.json');
    const outside = await mkdtemp(path.join(tmpdir(), 'contract-race-target-'));
    const outsideContract = path.join(outside, 'revalidation.json');
    await writeFile(
      outsideContract,
      JSON.stringify({
        ...VALID_CONTRACT,
        pairedFacts: [],
      }),
    );
    const require = createRequire(import.meta.url);
    const mutableFs = require('node:fs') as {
      realpathSync: (...args: unknown[]) => unknown;
      symlinkSync: (target: string, path: string, type?: string) => void;
      unlinkSync: (path: string) => void;
    };
    const originalRealpathSync = mutableFs.realpathSync;
    let swapped = false;
    mutableFs.realpathSync = (...args: unknown[]) => {
      const resolved = originalRealpathSync(...args);
      if (!swapped && path.resolve(String(args[0])) === path.resolve(contractPath)) {
        mutableFs.unlinkSync(contractPath);
        mutableFs.symlinkSync(outsideContract, contractPath, 'file');
        swapped = true;
      }
      return resolved;
    };
    syncBuiltinESMExports();

    try {
      const claimRecords = (await import(
        `${pathToFileURL(claimRecordsScript).href}?contract-race=${Date.now()}`
      )) as {
        readRevalidationContract: (root: string) => unknown;
      };
      expect(() => claimRecords.readRevalidationContract(p.root)).toThrow(/no-detection-contract/i);
      expect(swapped).toBe(true);
    } finally {
      mutableFs.realpathSync = originalRealpathSync;
      syncBuiltinESMExports();
    }
  });

  it('does not write a baseline outside after the claim directory passes containment', async () => {
    const p = await project();
    const claimDirectory = path.join(p.root, '.rig', 'claims');
    const outside = await mkdtemp(path.join(tmpdir(), 'claim-race-target-'));
    const outsideClaim = path.join(outside, 'RP-50.json');
    const require = createRequire(import.meta.url);
    const mutableFs = require('node:fs') as {
      realpathSync: (...args: unknown[]) => unknown;
      rmdirSync: (path: string) => void;
      symlinkSync: (target: string, path: string, type?: string) => void;
    };
    const originalRealpathSync = mutableFs.realpathSync;
    let swapped = false;
    mutableFs.realpathSync = (...args: unknown[]) => {
      const resolved = originalRealpathSync(...args);
      if (!swapped && path.resolve(String(args[0])) === path.resolve(claimDirectory)) {
        mutableFs.rmdirSync(claimDirectory);
        mutableFs.symlinkSync(
          outside,
          claimDirectory,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        swapped = true;
      }
      return resolved;
    };
    syncBuiltinESMExports();

    try {
      const claimRecords = (await import(
        `${pathToFileURL(claimRecordsScript).href}?claim-race=${Date.now()}`
      )) as {
        revalidateClaim: (input: Record<string, unknown>) => Record<string, unknown>;
      };
      const result = claimRecords.revalidateClaim({
        projectRoot: p.root,
        ticket: {
          id: 'RP-50',
          title: 'claim directory race fixture',
          body: null,
          labels: [],
          blockedBy: [],
          blocks: [],
          commentary: { count: 0, ids: [] },
        },
        point: 'SELECT',
        targetSha: p.targetSha,
        allowCreate: true,
        isResume: false,
      });

      expect(swapped).toBe(true);
      expect(existsSync(outsideClaim)).toBe(false);
      expect(result).toMatchObject({ result: 'UNVERIFIABLE', action: 'unverifiable' });
    } finally {
      mutableFs.realpathSync = originalRealpathSync;
      syncBuiltinESMExports();
    }
  });

  it('does not write through an in-repository claim-directory symlink swapped after validation', async () => {
    const p = await project();
    const claimDirectory = path.join(p.root, '.rig', 'claims');
    const redirectedDirectory = path.join(p.root, '.rig', 'redirected-claims');
    const redirectedClaim = path.join(redirectedDirectory, 'RP-50.json');
    await mkdir(redirectedDirectory);
    const require = createRequire(import.meta.url);
    const mutableFs = require('node:fs') as {
      realpathSync: (...args: unknown[]) => unknown;
      rmdirSync: (path: string) => void;
      symlinkSync: (target: string, path: string, type?: string) => void;
    };
    const originalRealpathSync = mutableFs.realpathSync;
    let swapped = false;
    mutableFs.realpathSync = (...args: unknown[]) => {
      const resolved = originalRealpathSync(...args);
      if (!swapped && path.resolve(String(args[0])) === path.resolve(claimDirectory)) {
        mutableFs.rmdirSync(claimDirectory);
        mutableFs.symlinkSync(
          redirectedDirectory,
          claimDirectory,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        swapped = true;
      }
      return resolved;
    };
    syncBuiltinESMExports();

    try {
      const claimRecords = (await import(
        `${pathToFileURL(claimRecordsScript).href}?claim-in-repo-race=${Date.now()}`
      )) as {
        revalidateClaim: (input: Record<string, unknown>) => Record<string, unknown>;
      };
      const result = claimRecords.revalidateClaim({
        projectRoot: p.root,
        ticket: {
          id: 'RP-50',
          title: 'in-repository claim directory race fixture',
          body: null,
          labels: [],
          blockedBy: [],
          blocks: [],
          commentary: { count: 0, ids: [] },
        },
        point: 'SELECT',
        targetSha: p.targetSha,
        allowCreate: true,
        isResume: false,
      });

      expect(swapped).toBe(true);
      expect(existsSync(redirectedClaim)).toBe(false);
      expect(result).toMatchObject({ result: 'UNVERIFIABLE', action: 'unverifiable' });
    } finally {
      mutableFs.realpathSync = originalRealpathSync;
      syncBuiltinESMExports();
    }
  });
});
