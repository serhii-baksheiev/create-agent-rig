import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// AR-134 [RX2] Revalidate BEFORE_PR. The SELECT check (AR-133) asks whether the
// ticket moved between take-up and the next selection. This one runs at the
// other end of the task, just before `pr-ship`, and asks two questions the
// branch itself cannot answer: did the ticket change since take-up, and did the
// default branch move under a file this task depends on — a file the branch
// edits, or one a `check-premises` verdict cited as load-bearing. Either one is
// a premise that rotted while the work was in flight; an unrelated file moving
// on main is not, and must not hold the PR.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universal, '.claude', 'scripts');
const skillsDir = path.join(universal, '.claude', 'skills');
const revalidateScript = path.join(scriptsDir, 'revalidate.mjs');
const loadScript = (file: string) => import(pathToFileURL(path.join(scriptsDir, file)).href);
const loadQueue = (file: string) =>
  import(pathToFileURL(path.join(scriptsDir, 'queue', file)).href);
const read = (...parts: string[]) => readFile(path.join(...parts), 'utf8');

const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(scriptsDir, 'preflight.mjs')).href
)) as { withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };

interface DecisionRecord {
  gate: string;
  verdict: string;
  blockers?: Array<{ file: string; rule: string; note: string }>;
}
interface EventRecord {
  kind: string;
  data: Record<string, unknown> | null;
}
const journal = (await loadScript('run-journal.mjs')) as {
  recordDecision: (input: {
    runDir: string;
    gate: string;
    verdict: string;
    blockers?: Array<{ file: string; rule: string; note: string }>;
    now: string;
  }) => unknown;
  readRun: (input: { runDir: string }) => {
    decisions: DecisionRecord[];
    events: EventRecord[];
    ended: boolean;
  };
};

const T1 = '2026-08-24T20:56:23.474Z';
const T2 = '2026-08-25T09:00:00.000Z';
const NOW = '2026-08-25T10:00:00.000Z';

interface Result {
  ticket: string;
  point: 'BEFORE_PR';
  changed: boolean | null;
  source: string[];
  action: 'hold' | 'continue' | 'unverifiable';
  task: { changed: boolean | null; from: string | null; to: string | null };
  main: { base: string; mergeBase: string; cited: string[]; changed: string[] };
}

const run = (
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string; out: string }> =>
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

const git = async (args: string[], cwd: string): Promise<string> => {
  const result = await run(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
    cwd,
    withoutGitLocation(),
  );
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
  return result.stdout.trim();
};

/**
 * A bare `origin` and a working clone on a feature branch that edits `a.txt`.
 * `moveMain` lands a commit on master through a SECOND clone and fetches it into
 * the working clone, so `origin/master` moves without the branch doing anything.
 */
const gitFixture = async (): Promise<{
  clone: string;
  moveMain: (files: string[], options?: { fetch?: boolean }) => Promise<void>;
}> => {
  const root = await mkdtemp(path.join(tmpdir(), 'revalidate-git-'));
  const origin = path.join(root, 'origin.git');
  const clone = path.join(root, 'clone');
  const other = path.join(root, 'other');
  await mkdir(origin);
  await git(['init', '--bare', '-b', 'master'], origin);
  await git(['clone', '-q', origin, clone], root);
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    await writeFile(path.join(clone, name), `${name} v1\n`);
  }
  await git(['add', '-A'], clone);
  await git(['commit', '-q', '-m', 'seed'], clone);
  await git(['push', '-q', '-u', 'origin', 'master'], clone);
  await git(['checkout', '-q', '-b', 'feat/ar-1'], clone);
  await writeFile(path.join(clone, 'a.txt'), 'a.txt on the branch\n');
  await git(['commit', '-q', '-a', '-m', 'branch touches a.txt'], clone);

  const moveMain = async (files: string[], { fetch = true } = {}): Promise<void> => {
    if (!existsSync(other)) await git(['clone', '-q', origin, other], root);
    await git(['pull', '-q', 'origin', 'master'], other);
    for (const name of files) {
      await writeFile(path.join(other, name), `${name} moved on main ${Date.now()}\n`);
    }
    await git(['add', '-A'], other);
    await git(['commit', '-q', '-m', `main touches ${files.join(',')}`], other);
    await git(['push', '-q', 'origin', 'HEAD:master'], other);
    // `fetch: false` leaves the clone's origin/master where it was — the stale
    // ref the script's header names as its limit.
    if (fetch) await git(['fetch', '-q', 'origin'], clone);
  };
  return { clone, moveMain };
};

/** An issue in the shape the Jira REST search returns — IN PROGRESS by default,
 *  because that is the state a ticket is in at BEFORE_PR. */
const jiraIssue = (over: Record<string, unknown> = {}) => ({
  key: 'AR-1',
  fields: {
    summary: 'add a route',
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    labels: ['in-progress'],
    priority: null,
    created: '2026-07-01T00:00:00.000+0000',
    issuelinks: [],
    ...over,
  },
});

interface Project {
  clone: string;
  configPath: string;
  runDir: string;
  env: NodeJS.ProcessEnv;
  moveMain: (files: string[], options?: { fetch?: boolean }) => Promise<void>;
  /** `null` means the issue carries NO `updated` field at all. */
  setUpdated: (updated: string | null) => Promise<void>;
}

const project = async ({
  updated = T1,
  snapshot = T1,
}: { updated?: string | null; snapshot?: string | null } = {}): Promise<Project> => {
  const { clone, moveMain } = await gitFixture();
  await mkdir(path.join(clone, '.claude'), { recursive: true });
  const configPath = path.join(clone, '.claude', 'queue.json');
  const setUpdated = (value: string | null) =>
    writeFile(
      configPath,
      JSON.stringify({
        adapter: 'jira',
        options: {
          project: 'AR',
          // `null` is the sentinel for an absent field: a parameter default
          // swallows `undefined`, so it could never mean "no marker" here.
          issues: [jiraIssue(value === null ? {} : { updated: value })],
        },
      }),
    );
  await setUpdated(updated);
  const runDir = await mkdtemp(path.join(tmpdir(), 'run-'));
  if (snapshot !== null) {
    await writeFile(
      path.join(runDir, 'state.json'),
      JSON.stringify({ takeUps: { 'AR-1': snapshot } }),
    );
  }
  return {
    clone,
    configPath,
    runDir,
    env: { ...withoutGitLocation(), RIG_RUN_DIR: runDir },
    moveMain,
    setUpdated,
  };
};

const revalidate = (p: Pick<Project, 'clone' | 'configPath' | 'env'>, extra: string[] = []) =>
  run(
    process.execPath,
    [
      revalidateScript,
      '--point',
      'BEFORE_PR',
      '--ticket',
      'AR-1',
      '--base',
      'origin/master',
      '--config',
      p.configPath,
      ...extra,
    ],
    p.clone,
    p.env,
  );

const revalidateJson = async (
  p: Pick<Project, 'clone' | 'configPath' | 'env'>,
): Promise<{ code: number; result: Result; out: string }> => {
  const { code, stdout, out } = await revalidate(p, ['--json']);
  expect(stdout, out).not.toBe('');
  return { code, result: JSON.parse(stdout) as Result, out };
};

const revalidationEvents = (runDir: string): EventRecord[] =>
  journal.readRun({ runDir }).events.filter((record) => record.kind === 'revalidation');

describe('the git fixture itself', () => {
  it('resolves origin/master, and moves it when main moves', async () => {
    const { clone, moveMain } = await gitFixture();
    const before = await git(['rev-parse', 'origin/master'], clone);
    expect(before).toMatch(/^[0-9a-f]{40}$/);
    await moveMain(['b.txt']);
    const after = await git(['rev-parse', 'origin/master'], clone);
    expect(after).not.toBe(before);
    expect(await git(['diff', '--name-only', 'origin/master...HEAD'], clone)).toBe('a.txt');
  });
});

describe('revalidate.mjs — the CLI contract', () => {
  it('enumerates its points, frozen', async () => {
    const { POINTS } = await loadScript('revalidate.mjs');
    expect(POINTS).toEqual(['BEFORE_PR', 'BEFORE_CLOSE']);
    expect(Object.isFrozen(POINTS)).toBe(true);
  });

  it('never fetches: the source text carries no `fetch`', async () => {
    const source = await read(revalidateScript);
    expect(source).not.toMatch(/fetch/);
  });

  it('reads the ref as it is: a stale origin/master reports continue', async () => {
    const p = await project();
    await p.moveMain(['a.txt'], { fetch: false });
    const { code, result, out } = await revalidateJson(p);
    expect(code, out).toBe(0);
    expect(result.action).toBe('continue');
    expect(result.main.changed).toEqual([]);
    // and once the ref is current, the same path is the hold it should be
    await p.moveMain(['a.txt'], { fetch: true });
    expect((await revalidateJson(p)).result.source).toEqual(['main:a.txt']);
  });

  it.each([
    ['an unknown point', ['--point', 'AFTER_MERGE', '--ticket', 'AR-1']],
    ['a missing ticket', ['--point', 'BEFORE_PR']],
    [
      'a base that is not a revision',
      ['--point', 'BEFORE_PR', '--ticket', 'AR-1', '--base', 'no-such-ref'],
    ],
  ])('refuses %s: exit 1, stderr only, nothing journaled', async (_label, args) => {
    const p = await project();
    const { code, stdout, stderr } = await run(
      process.execPath,
      [revalidateScript, ...args, '--config', p.configPath, '--json'],
      p.clone,
      p.env,
    );
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr.trim()).not.toBe('');
    expect(existsSync(path.join(p.runDir, 'events.jsonl'))).toBe(false);
  });
});

describe('the task source — the ticket moved since take-up', () => {
  it('holds when the in-progress ticket carries a newer updatedAt than the take-up snapshot', async () => {
    const p = await project({ updated: T2, snapshot: T1 });
    const { code, result, out } = await revalidateJson(p);
    expect(code, out).toBe(2);
    expect(result).toMatchObject({
      ticket: 'AR-1',
      point: 'BEFORE_PR',
      changed: true,
      action: 'hold',
      task: { changed: true, from: T1, to: T2 },
    });
    expect(result.source).toContain('task:updatedAt');
  });

  it('continues when the marker is unchanged and main has not moved', async () => {
    const p = await project();
    const { code, result, out } = await revalidateJson(p);
    expect(code, out).toBe(0);
    expect(result).toMatchObject({
      changed: false,
      action: 'continue',
      source: [],
      task: { changed: false, from: T1, to: T1 },
      main: { changed: [] },
    });
  });

  it('is unverifiable when the run has no take-up snapshot for the ticket', async () => {
    const p = await project({ snapshot: null });
    const { code, result, out } = await revalidateJson(p);
    expect(code, out).toBe(0);
    expect(result.task.changed).toBeNull();
    expect(result).toMatchObject({ changed: null, action: 'unverifiable', source: [] });
  });

  it('is unverifiable when the ticket carries no marker', async () => {
    const p = await project({ updated: null });
    const { result } = await revalidateJson(p);
    expect(result.task).toMatchObject({ changed: null, to: null });
    expect(result.action).toBe('unverifiable');
  });

  it('is unverifiable without a run dir, and still computes the main source', async () => {
    const p = await project();
    await p.moveMain(['a.txt']);
    const env = { ...p.env };
    delete env.RIG_RUN_DIR;
    const { code, result, out } = await revalidateJson({ ...p, env });
    expect(code, out).toBe(2);
    expect(result.task.changed).toBeNull();
    expect(result.source).toEqual(['main:a.txt']);
    expect(existsSync(path.join(p.runDir, 'events.jsonl'))).toBe(false);
  });
});

describe('the main source — the default branch moved under a cited file', () => {
  it('holds when main touched a file the branch also touches', async () => {
    const p = await project();
    await p.moveMain(['a.txt']);
    const { code, result, out } = await revalidateJson(p);
    expect(code, out).toBe(2);
    expect(result).toMatchObject({ changed: true, action: 'hold', source: ['main:a.txt'] });
    expect(result.main.cited).toContain('a.txt');
    expect(result.main.changed).toEqual(['a.txt']);
    expect(result.main.base).toBe('origin/master');
    expect(result.main.mergeBase).toMatch(/^[0-9a-f]{40}$/);
  });

  it('does not hold on an unrelated main change', async () => {
    const p = await project();
    await p.moveMain(['b.txt']);
    const { code, result, out } = await revalidateJson(p);
    expect(code, out).toBe(0);
    expect(result).toMatchObject({ changed: false, action: 'continue', source: [] });
    expect(result.main.changed).toEqual([]);
    expect(result.main.cited).not.toContain('b.txt');
  });

  it('holds when main touched a file a check-premises verdict cited as a blocker', async () => {
    const p = await project();
    journal.recordDecision({
      runDir: p.runDir,
      gate: 'check-premises',
      verdict: 'UNVERIFIABLE',
      blockers: [{ file: 'c.txt', rule: 'r', note: 'n' }],
      now: NOW,
    });
    await p.moveMain(['c.txt']);
    const { code, result, out } = await revalidateJson(p);
    expect(code, out).toBe(2);
    expect(result.main.cited).toEqual(expect.arrayContaining(['a.txt', 'c.txt']));
    expect(result.source).toEqual(['main:c.txt']);
  });

  it('ignores blockers from a gate other than check-premises', async () => {
    const p = await project();
    journal.recordDecision({
      runDir: p.runDir,
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: [{ file: 'c.txt', rule: 'r', note: 'n' }],
      now: NOW,
    });
    await p.moveMain(['c.txt']);
    const { code, result, out } = await revalidateJson(p);
    expect(code, out).toBe(0);
    expect(result.main.cited).not.toContain('c.txt');
    expect(result.action).toBe('continue');
  });
});

describe('what it prints and what it journals', () => {
  it('text mode on hold names every changed source on one line', async () => {
    const p = await project({ updated: T2 });
    await p.moveMain(['a.txt']);
    const { code, stdout } = await revalidate(p);
    expect(code).toBe(2);
    const line = stdout.split('\n').find((l) => l.startsWith('revalidate BEFORE_PR: AR-1 hold'));
    expect(line, stdout).toBeDefined();
    expect(line).toContain('task:updatedAt');
    expect(line).toContain('main:a.txt');
  });

  it('text mode on continue says so', async () => {
    const p = await project();
    const { code, stdout } = await revalidate(p);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^revalidate BEFORE_PR: AR-1 continue/m);
  });

  it('appends exactly one revalidation event carrying the result', async () => {
    const p = await project({ updated: T2 });
    const { result } = await revalidateJson(p);
    const events = revalidationEvents(p.runDir);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual(result);
    expect(events[0]!.data).toMatchObject({ point: 'BEFORE_PR', action: 'hold' });
  });
});

describe('beforePrRevalidationOf aggregates the sources, purely', () => {
  const load = async () =>
    (await loadQueue('core.mjs')) as {
      revalidationOf: (input: { ticket: unknown; snapshot?: string | null }) => {
        changed: boolean | null;
      };
      beforePrRevalidationOf: (input: {
        ticket: string;
        task: { changed: boolean | null };
        mainChanged: string[];
      }) => Omit<Result, 'task' | 'main'>;
    };

  it('holds on a task change, naming task:updatedAt', async () => {
    const { revalidationOf, beforePrRevalidationOf } = await load();
    const task = revalidationOf({ ticket: { id: 'AR-1', updatedAt: T2 }, snapshot: T1 });
    expect(beforePrRevalidationOf({ ticket: 'AR-1', task, mainChanged: [] })).toEqual({
      ticket: 'AR-1',
      point: 'BEFORE_PR',
      changed: true,
      source: ['task:updatedAt'],
      action: 'hold',
    });
  });

  it('holds on main-only changes, one source per path', async () => {
    const { revalidationOf, beforePrRevalidationOf } = await load();
    const task = revalidationOf({ ticket: { id: 'AR-1', updatedAt: T1 }, snapshot: T1 });
    expect(
      beforePrRevalidationOf({ ticket: 'AR-1', task, mainChanged: ['a.txt', 'c.txt'] }),
    ).toEqual({
      ticket: 'AR-1',
      point: 'BEFORE_PR',
      changed: true,
      source: ['main:a.txt', 'main:c.txt'],
      action: 'hold',
    });
  });

  it('continues when neither moved and the task was verifiable', async () => {
    const { revalidationOf, beforePrRevalidationOf } = await load();
    const task = revalidationOf({ ticket: { id: 'AR-1', updatedAt: T1 }, snapshot: T1 });
    expect(beforePrRevalidationOf({ ticket: 'AR-1', task, mainChanged: [] })).toEqual({
      ticket: 'AR-1',
      point: 'BEFORE_PR',
      changed: false,
      source: [],
      action: 'continue',
    });
  });

  it('is unverifiable when main did not move and the task could not be checked', async () => {
    const { beforePrRevalidationOf } = await load();
    expect(
      beforePrRevalidationOf({ ticket: 'AR-1', task: { changed: null }, mainChanged: [] }),
    ).toEqual({
      ticket: 'AR-1',
      point: 'BEFORE_PR',
      changed: null,
      source: [],
      action: 'unverifiable',
    });
  });
});

describe('the skills that run it say so', () => {
  it('pr-ship runs the BEFORE_PR revalidation and reads exit 2 as a HOLD', async () => {
    const skill = await read(skillsDir, 'pr-ship', 'SKILL.md');
    expect(skill).toContain('node .claude/scripts/revalidate.mjs --point BEFORE_PR');
    expect(skill).toMatch(/exit(?: code)? 2[^\n]*HOLD/);
  });

  it('loop journals the check-premises verdict through recordDecision', async () => {
    const skill = await read(skillsDir, 'loop', 'SKILL.md');
    expect(skill).toMatch(/recordDecision\([\s\S]{0,400}gate:\s*['"]check-premises['"]/);
  });
});

// AR-135 [RX3] Revalidate BEFORE_CLOSE. The PR merged; the run is about to
// publish the item as Done. Two things can have happened in between that the
// merge cannot see: the ticket moved (a late comment, an edit — `updatedAt`
// against the LAST validation, not the take-up), or somebody moved its state
// (already closed it, or pushed it back to open). Either one means the close
// would publish a state the board does not agree with. No git is involved: the
// branch is gone, the merge is the fact, and the question is only about the item.

interface CloseResult {
  ticket: string;
  point: 'BEFORE_CLOSE';
  changed: boolean | null;
  source: string[];
  action: 'hold' | 'continue' | 'unverifiable';
  task: { changed: boolean | null; from: string | null; to: string | null };
  state: { expected: 'in-progress'; actual: string | null };
  dependants: string[];
}

const T3 = '2026-08-25T11:30:00.000Z';

const IN_PROGRESS = { name: 'In Progress', statusCategory: { key: 'indeterminate' } };
const DONE = { name: 'Done', statusCategory: { key: 'done' } };
const TO_DO = { name: 'To Do', statusCategory: { key: 'new' } };

const blocksLink = (key: string) => ({
  type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  outwardIssue: { key, fields: { status: { statusCategory: { key: 'new' } } } },
});

interface CloseProject {
  dir: string;
  configPath: string;
  runDir: string;
  env: NodeJS.ProcessEnv;
}

/**
 * A plain directory — deliberately NOT a git repository — holding only the
 * queue config, plus a run directory. `snapshot` is `takeUps[AR-1]`; `null`
 * writes no state.json at all.
 */
const closeProject = async ({
  updated = T1,
  snapshot = T1,
  status = IN_PROGRESS,
  issuelinks = [] as unknown[],
}: {
  updated?: string | null;
  snapshot?: string | null;
  status?: { name: string; statusCategory: { key: string } };
  issuelinks?: unknown[];
} = {}): Promise<CloseProject> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'revalidate-close-'));
  await mkdir(path.join(dir, '.claude'), { recursive: true });
  const configPath = path.join(dir, '.claude', 'queue.json');
  await writeFile(
    configPath,
    JSON.stringify({
      adapter: 'jira',
      options: {
        project: 'AR',
        issues: [jiraIssue({ status, issuelinks, ...(updated === null ? {} : { updated }) })],
      },
    }),
  );
  const runDir = await mkdtemp(path.join(tmpdir(), 'run-close-'));
  if (snapshot !== null) {
    await writeFile(
      path.join(runDir, 'state.json'),
      JSON.stringify({ takeUps: { 'AR-1': snapshot } }),
    );
  }
  return { dir, configPath, runDir, env: { ...withoutGitLocation(), RIG_RUN_DIR: runDir } };
};

const revalidateClose = (
  p: Pick<CloseProject, 'dir' | 'configPath' | 'env'>,
  extra: string[] = [],
) =>
  run(
    process.execPath,
    [
      revalidateScript,
      '--point',
      'BEFORE_CLOSE',
      '--ticket',
      'AR-1',
      '--config',
      p.configPath,
      ...extra,
    ],
    p.dir,
    p.env,
  );

const revalidateCloseJson = async (
  p: Pick<CloseProject, 'dir' | 'configPath' | 'env'>,
  extra: string[] = [],
): Promise<{ code: number; result: CloseResult; out: string }> => {
  const { code, stdout, out } = await revalidateClose(p, [...extra, '--json']);
  expect(stdout, out).not.toBe('');
  return { code, result: JSON.parse(stdout) as CloseResult, out };
};

/** The BEFORE_PR event the run wrote earlier: its `task.to` is the last validation. */
const recordBeforePr = (runDir: string, to: string) =>
  (journal as unknown as { recordEvent: (input: unknown) => unknown }).recordEvent({
    runDir,
    kind: 'revalidation',
    data: { ticket: 'AR-1', point: 'BEFORE_PR', task: { to } },
    now: NOW,
  });

describe('revalidate.mjs knows BEFORE_CLOSE', () => {
  it('names BEFORE_PR and BEFORE_CLOSE as its points, frozen', async () => {
    const { POINTS } = await loadScript('revalidate.mjs');
    expect(POINTS).toEqual(['BEFORE_PR', 'BEFORE_CLOSE']);
    expect(Object.isFrozen(POINTS)).toBe(true);
  });

  it('needs no git: runs in a plain directory and ignores --base there', async () => {
    const p = await closeProject();
    expect(existsSync(path.join(p.dir, '.git'))).toBe(false);
    const { code, result, out } = await revalidateCloseJson(p, ['--base', 'no-such-ref']);
    expect(code, out).toBe(0);
    expect(result).toMatchObject({ ticket: 'AR-1', point: 'BEFORE_CLOSE', action: 'continue' });
    expect(result).not.toHaveProperty('main');
  });
});

describe('BEFORE_CLOSE — the task source compares against the LAST validation', () => {
  it('continues when the marker equals the last BEFORE_PR event, even though take-up is older', async () => {
    const p = await closeProject({ updated: T2, snapshot: T1 });
    recordBeforePr(p.runDir, T2);
    const { code, result, out } = await revalidateCloseJson(p);
    expect(code, out).toBe(0);
    expect(result).toMatchObject({
      changed: false,
      action: 'continue',
      source: [],
      task: { changed: false, from: T2, to: T2 },
    });
  });

  it('holds when the marker moved past the last BEFORE_PR event, with `from` being that event', async () => {
    const p = await closeProject({ updated: T3, snapshot: T1 });
    recordBeforePr(p.runDir, T2);
    const { code, result, out } = await revalidateCloseJson(p);
    expect(code, out).toBe(2);
    expect(result).toMatchObject({
      changed: true,
      action: 'hold',
      source: ['task:updatedAt'],
      task: { changed: true, from: T2, to: T3 },
    });
  });

  it('falls back to the take-up snapshot when no revalidation event exists', async () => {
    const p = await closeProject({ updated: T1, snapshot: T1 });
    const { code, result, out } = await revalidateCloseJson(p);
    expect(code, out).toBe(0);
    expect(result).toMatchObject({
      action: 'continue',
      task: { changed: false, from: T1, to: T1 },
    });
  });

  it('is unverifiable when there is neither an event nor a take-up snapshot', async () => {
    const p = await closeProject({ snapshot: null });
    const { code, result, out } = await revalidateCloseJson(p);
    expect(code, out).toBe(0);
    expect(result).toMatchObject({
      changed: null,
      action: 'unverifiable',
      source: [],
      task: { changed: null, from: null, to: T1 },
    });
  });
});

describe('BEFORE_CLOSE — the state source: in-progress is the only state a close expects', () => {
  it('holds on task:state when someone already closed the item', async () => {
    const p = await closeProject({ status: DONE });
    const { code, result, out } = await revalidateCloseJson(p);
    expect(code, out).toBe(2);
    expect(result).toMatchObject({
      changed: true,
      action: 'hold',
      source: ['task:state'],
      state: { expected: 'in-progress', actual: 'closed' },
    });
  });

  it('holds on task:state when the item was moved back to open', async () => {
    const p = await closeProject({ status: TO_DO });
    const { code, result, out } = await revalidateCloseJson(p);
    expect(code, out).toBe(2);
    expect(result.source).toEqual(['task:state']);
    expect(result.state).toEqual({ expected: 'in-progress', actual: 'open' });
  });

  it('reports the expected state on continue too', async () => {
    const p = await closeProject();
    const { result } = await revalidateCloseJson(p);
    expect(result.state).toEqual({ expected: 'in-progress', actual: 'in-progress' });
  });
});

describe('BEFORE_CLOSE — the dependants the close would release', () => {
  it('lists the keys this item blocks', async () => {
    const p = await closeProject({ issuelinks: [blocksLink('AR-7'), blocksLink('AR-9')] });
    const { result } = await revalidateCloseJson(p);
    expect(result.dependants).toEqual(['AR-7', 'AR-9']);
  });

  it('is an empty list when nothing waits on it', async () => {
    const p = await closeProject();
    const { result } = await revalidateCloseJson(p);
    expect(result.dependants).toEqual([]);
  });
});

describe('BEFORE_CLOSE — what it prints and what it journals', () => {
  it('text mode on hold names both sources on one line', async () => {
    const p = await closeProject({ updated: T3, snapshot: T1, status: DONE });
    const { code, stdout } = await revalidateClose(p);
    expect(code).toBe(2);
    expect(stdout).toMatch(/^revalidate BEFORE_CLOSE: AR-1 hold — task:updatedAt, task:state/m);
  });

  it('text mode on continue says so', async () => {
    const p = await closeProject();
    const { code, stdout } = await revalidateClose(p);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^revalidate BEFORE_CLOSE: AR-1 continue/m);
  });

  it('appends exactly one BEFORE_CLOSE revalidation event after the BEFORE_PR one, and does not end the run', async () => {
    const p = await closeProject({ updated: T3, snapshot: T1 });
    recordBeforePr(p.runDir, T2);
    const { result } = await revalidateCloseJson(p);
    const events = revalidationEvents(p.runDir);
    expect(events).toHaveLength(2);
    expect(events[1]!.data).toEqual(result);
    expect(events[1]!.data).toMatchObject({ point: 'BEFORE_CLOSE', action: 'hold' });
    expect(journal.readRun({ runDir: p.runDir }).ended).toBe(false);
  });

  it('is unverifiable without a run dir, and writes nothing', async () => {
    const p = await closeProject();
    const env = { ...p.env };
    delete env.RIG_RUN_DIR;
    const { code, result, out } = await revalidateCloseJson({ ...p, env });
    expect(code, out).toBe(0);
    expect(result).toMatchObject({ action: 'unverifiable', task: { changed: null } });
    expect(existsSync(path.join(p.runDir, 'events.jsonl'))).toBe(false);
  });
});

describe('beforeCloseRevalidationOf aggregates task and state, purely', () => {
  const load = async () =>
    (await loadQueue('core.mjs')) as {
      beforeCloseRevalidationOf: (input: {
        ticket: string;
        task: { changed: boolean | null };
        state: string | null;
      }) => Omit<CloseResult, 'task' | 'state' | 'dependants'>;
    };

  it('holds on a task change, naming task:updatedAt', async () => {
    const { beforeCloseRevalidationOf } = await load();
    expect(
      beforeCloseRevalidationOf({ ticket: 'AR-1', task: { changed: true }, state: 'in-progress' }),
    ).toEqual({
      ticket: 'AR-1',
      point: 'BEFORE_CLOSE',
      changed: true,
      source: ['task:updatedAt'],
      action: 'hold',
    });
  });

  it('holds on a closed state, naming task:state', async () => {
    const { beforeCloseRevalidationOf } = await load();
    expect(
      beforeCloseRevalidationOf({ ticket: 'AR-1', task: { changed: false }, state: 'closed' }),
    ).toEqual({
      ticket: 'AR-1',
      point: 'BEFORE_CLOSE',
      changed: true,
      source: ['task:state'],
      action: 'hold',
    });
  });

  it('names task:updatedAt before task:state when both moved', async () => {
    const { beforeCloseRevalidationOf } = await load();
    expect(
      beforeCloseRevalidationOf({ ticket: 'AR-1', task: { changed: true }, state: 'open' }).source,
    ).toEqual(['task:updatedAt', 'task:state']);
  });

  it('continues when the task compared unchanged and the state is in-progress', async () => {
    const { beforeCloseRevalidationOf } = await load();
    expect(
      beforeCloseRevalidationOf({ ticket: 'AR-1', task: { changed: false }, state: 'in-progress' }),
    ).toEqual({
      ticket: 'AR-1',
      point: 'BEFORE_CLOSE',
      changed: false,
      source: [],
      action: 'continue',
    });
  });

  it('is unverifiable when the task could not be compared and the state is in-progress', async () => {
    const { beforeCloseRevalidationOf } = await load();
    expect(
      beforeCloseRevalidationOf({ ticket: 'AR-1', task: { changed: null }, state: 'in-progress' }),
    ).toEqual({
      ticket: 'AR-1',
      point: 'BEFORE_CLOSE',
      changed: null,
      source: [],
      action: 'unverifiable',
    });
  });
});

describe('the loop skill closes through the BEFORE_CLOSE check', () => {
  const closingSection = async (): Promise<string> => {
    const skill = await read(skillsDir, 'loop', 'SKILL.md');
    const start = skill.indexOf('## 9.');
    expect(start, 'section 9 is missing').toBeGreaterThan(-1);
    return skill.slice(start);
  };

  it('runs the BEFORE_CLOSE revalidation before the close call and reads a hold as a stop', async () => {
    const section = await closingSection();
    const check = section.indexOf('node .claude/scripts/revalidate.mjs --point BEFORE_CLOSE');
    expect(check, 'no BEFORE_CLOSE command in the closing section').toBeGreaterThan(-1);
    const closeCall = section.indexOf('close(', check);
    expect(closeCall, 'the close call is not after the check').toBeGreaterThan(check);
    expect(section.slice(check)).toMatch(
      /hold[^\n]*(stops|halts|blocks)[^\n]*close|(stops|halts|blocks)[^\n]*close[^\n]*hold/i,
    );
  });

  it('says the close result’s `transitioned` is what proves the close', async () => {
    const section = await closingSection();
    expect(section).toMatch(/transitioned/);
    expect(section).toMatch(/close[\s\S]{0,400}`transitioned`|`transitioned`[\s\S]{0,400}close/);
  });
});
