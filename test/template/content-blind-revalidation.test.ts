import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
