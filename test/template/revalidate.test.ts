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
const REVALIDATION_CONTRACT = {
  schemaVersion: 1,
  detection: {
    mode: 'pull',
    sources: ['run-state', 'journal'],
    acceptedLatency: '24h',
    push: false,
  },
  pairedFacts: [],
};

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
  await mkdir(path.join(clone, '.rig'), { recursive: true });
  await writeFile(
    path.join(clone, '.rig', 'revalidation.json'),
    `${JSON.stringify(REVALIDATION_CONTRACT)}\n`,
  );
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

const trackClaimBaseline = async (
  root: string,
  issue: Record<string, unknown>,
  targetRef: string | null,
) => {
  const jira = (await loadQueue('jira.mjs')) as {
    find: (id: string, options: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  };
  const claims = (await loadScript('lib/claim-records.mjs')) as {
    revalidateClaim: (input: Record<string, unknown>) => { result: string };
    targetShaOf: (projectRoot: string, ref?: string | null) => string | null;
  };
  const selectedIssue = {
    ...issue,
    fields: {
      ...((issue.fields ?? {}) as Record<string, unknown>),
      status: { name: 'To Do', statusCategory: { key: 'new' } },
    },
  };
  const ticket = await jira.find('AR-1', { project: 'AR', issues: [selectedIssue] });
  if (!ticket) throw new Error('claim fixture could not map its Jira issue');
  const result = claims.revalidateClaim({
    projectRoot: root,
    ticket,
    point: 'SELECT',
    targetSha: claims.targetShaOf(root, targetRef),
    allowCreate: true,
  });
  if (result.result !== 'BASELINE_CREATED') throw new Error(`claim fixture: ${result.result}`);
  await git(['add', '.rig/claims/AR-1.json'], root);
  await git(['commit', '-q', '-m', 'track claim baseline'], root);
};

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
  const issueFor = (value: string | null) => jiraIssue(value === null ? {} : { updated: value });
  const setUpdated = (value: string | null) =>
    writeFile(
      configPath,
      JSON.stringify({
        adapter: 'jira',
        options: {
          project: 'AR',
          // `null` is the sentinel for an absent field: a parameter default
          // swallows `undefined`, so it could never mean "no marker" here.
          issues: [issueFor(value)],
        },
      }),
    );
  await setUpdated(updated);
  await trackClaimBaseline(clone, issueFor(updated), 'origin/master');
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
    expect((await revalidateJson(p)).result.source).toEqual(['claim:scope', 'main:a.txt']);
  });

  it.each([
    ['an unknown point', ['--point', 'AFTER_MERGE', '--ticket', 'AR-1']],
    ['a missing ticket', ['--point', 'BEFORE_PR']],
    ['a ticket that looks like an option', ['--point', 'BEFORE_CLOSE', '--ticket', '--help']],
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

describe('take-up markers remain compatibility evidence, not drift authority', () => {
  it('continues when only updatedAt moved and still reports the marker evidence', async () => {
    const p = await project({ updated: T2, snapshot: T1 });
    const { code, result, out } = await revalidateJson(p);
    expect(code, out).toBe(0);
    expect(result).toMatchObject({
      ticket: 'AR-1',
      point: 'BEFORE_PR',
      changed: false,
      action: 'continue',
      task: { changed: true, from: T1, to: T2 },
    });
    expect(result.source).not.toContain('task:updatedAt');
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

  it('uses the tracked claim when the run has no take-up snapshot', async () => {
    const p = await project({ snapshot: null });
    const { code, result, out } = await revalidateJson(p);
    expect(code, out).toBe(0);
    expect(result.task.changed).toBeNull();
    expect(result).toMatchObject({ changed: false, action: 'continue', source: [] });
  });

  it('uses the tracked claim when the ticket carries no marker', async () => {
    const p = await project({ updated: null });
    const { result } = await revalidateJson(p);
    expect(result.task).toMatchObject({ changed: null, to: null });
    expect(result.action).toBe('continue');
  });

  it('uses the tracked claim without a run dir, and still computes the main source', async () => {
    const p = await project();
    await p.moveMain(['a.txt']);
    const env = { ...p.env };
    delete env.RIG_RUN_DIR;
    const { code, result, out } = await revalidateJson({ ...p, env });
    expect(code, out).toBe(2);
    expect(result.task.changed).toBeNull();
    expect(result.source).toEqual(['claim:scope', 'main:a.txt']);
    expect(existsSync(path.join(p.runDir, 'events.jsonl'))).toBe(false);
  });
});

describe('the main source — the default branch moved under a cited file', () => {
  it('holds when main touched a file the branch also touches', async () => {
    const p = await project();
    await p.moveMain(['a.txt']);
    const { code, result, out } = await revalidateJson(p);
    expect(code, out).toBe(2);
    expect(result).toMatchObject({
      changed: true,
      action: 'hold',
      source: ['claim:scope', 'main:a.txt'],
    });
    expect(result.main.cited).toContain('a.txt');
    expect(result.main.changed).toEqual(['a.txt']);
    expect(result.main.base).toBe('origin/master');
    expect(result.main.mergeBase).toMatch(/^[0-9a-f]{40}$/);
  });

  it('holds on target-SHA drift even when main changed only an uncited path', async () => {
    const p = await project();
    await p.moveMain(['b.txt']);
    const { code, result, out } = await revalidateJson(p);
    expect(code, out).toBe(2);
    expect(result).toMatchObject({ changed: true, action: 'hold', source: ['claim:scope'] });
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
    expect(result.source).toEqual(['claim:scope', 'main:c.txt']);
  });

  it('ignores non-premise blocker paths while target-SHA drift still holds', async () => {
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
    expect(code, out).toBe(2);
    expect(result.main.cited).not.toContain('c.txt');
    expect(result).toMatchObject({ action: 'hold', source: ['claim:scope'] });
  });
});

describe('what it prints and what it journals', () => {
  it('text mode on hold names authoritative sources on one line', async () => {
    const p = await project({ updated: T2 });
    await p.moveMain(['a.txt']);
    const { code, stdout } = await revalidate(p);
    expect(code).toBe(2);
    const line = stdout.split('\n').find((l) => l.startsWith('revalidate BEFORE_PR: AR-1 hold'));
    expect(line, stdout).toBeDefined();
    expect(line).toContain('main:a.txt');
    expect(line).not.toContain('task:updatedAt');
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
    expect(events[0]!.data).toMatchObject({ point: 'BEFORE_PR', action: 'continue' });
  });
});

describe('takeUpEvidenceOf cannot make a BEFORE_PR decision', () => {
  const load = async () =>
    (await loadQueue('core.mjs')) as {
      takeUpEvidenceOf: (input: { ticket: unknown; snapshot?: string | null }) => {
        changed: boolean | null;
        task: { from: string | null; to: string | null };
      };
    };

  it('reports a moved marker as evidence only', async () => {
    const { takeUpEvidenceOf } = await load();
    const evidence = takeUpEvidenceOf({ ticket: { id: 'AR-1', updatedAt: T2 }, snapshot: T1 });
    expect(evidence).toEqual({
      changed: true,
      task: { from: T1, to: T2 },
    });
    expect(evidence).not.toHaveProperty('action');
    expect(evidence).not.toHaveProperty('source');
  });

  it('reports unchanged and unavailable markers without authority', async () => {
    const { takeUpEvidenceOf } = await load();
    expect(takeUpEvidenceOf({ ticket: { id: 'AR-1', updatedAt: T1 }, snapshot: T1 })).toEqual({
      changed: false,
      task: { from: T1, to: T1 },
    });
    expect(takeUpEvidenceOf({ ticket: { id: 'AR-1', updatedAt: null }, snapshot: T1 })).toEqual({
      changed: null,
      task: { from: T1, to: null },
    });
  });
});

describe('withAdditionalDrift extends the claim detection, not marker evidence', () => {
  const load = async () =>
    (await loadScript('lib/claim-records.mjs')) as {
      withAdditionalDrift: (
        detection: Record<string, unknown>,
        sources?: string[],
      ) => Record<string, unknown>;
    };
  const current = () => ({
    schemaVersion: 1,
    id: 'current-id',
    ticket: 'AR-1',
    point: 'BEFORE_PR',
    checkpoint: 'BEFORE_PR',
    result: 'CURRENT',
    changed: false,
    source: [],
    action: 'continue',
    movedFingerprintSet: [],
    sourcePointer: '.rig/claims/AR-1.json',
  });

  it('adds cited main drift to the current claim result', async () => {
    const { withAdditionalDrift } = await load();
    expect(withAdditionalDrift(current(), ['main:a.txt', 'main:c.txt'])).toMatchObject({
      result: 'CHANGED',
      changed: true,
      action: 'hold',
      source: ['main:a.txt', 'main:c.txt'],
    });
  });

  it('adds the close state source to the current claim result', async () => {
    const { withAdditionalDrift } = await load();
    expect(withAdditionalDrift(current(), ['task:state'])).toMatchObject({
      result: 'CHANGED',
      action: 'hold',
      source: ['task:state'],
    });
  });

  it('refuses to restore task:updatedAt as a drift source', async () => {
    const { withAdditionalDrift } = await load();
    expect(() => withAdditionalDrift(current(), ['task:updatedAt'])).toThrow(/updatedAt|source/i);
  });

  it('preserves an existing fingerprint hold and adds checkpoint evidence', async () => {
    const { withAdditionalDrift } = await load();
    const hold = {
      ...current(),
      result: 'CHANGED',
      changed: true,
      action: 'hold',
      source: ['claim:scope'],
    };
    expect(withAdditionalDrift(hold, ['main:a.txt'])).toMatchObject({
      result: 'CHANGED',
      action: 'hold',
      source: ['claim:scope', 'main:a.txt'],
    });
  });

  it('returns the same current detection when there is no additional drift', async () => {
    const { withAdditionalDrift } = await load();
    const detection = current();
    expect(withAdditionalDrift(detection)).toBe(detection);
  });

  it('gives the same additional drift a stable detection id', async () => {
    const { withAdditionalDrift } = await load();
    expect(withAdditionalDrift(current(), ['main:a.txt']).id).toBe(
      withAdditionalDrift(current(), ['main:a.txt']).id,
    );
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
  dependantState: Record<string, string>;
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
 * A minimal repository holding the durable claim, queue config and a run
 * directory. `snapshot` is compatibility evidence only; `null` writes no
 * state.json at all.
 */
const closeProject = async ({
  updated = T1,
  snapshot = T1,
  status = IN_PROGRESS,
  issuelinks = [] as unknown[],
  others = [] as unknown[],
}: {
  updated?: string | null;
  snapshot?: string | null;
  status?: { name: string; statusCategory: { key: string } };
  issuelinks?: unknown[];
  /** Other issues the offline seam carries — the dependants `find` re-reads. */
  others?: unknown[];
} = {}): Promise<CloseProject> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'revalidate-close-'));
  await mkdir(path.join(dir, '.claude'), { recursive: true });
  await mkdir(path.join(dir, '.rig'), { recursive: true });
  await writeFile(
    path.join(dir, '.rig', 'revalidation.json'),
    `${JSON.stringify(REVALIDATION_CONTRACT)}\n`,
  );
  await git(['init', '-q', '-b', 'master'], dir);
  await git(['add', '.rig/revalidation.json'], dir);
  await git(['commit', '-q', '-m', 'seed contract'], dir);
  await git(['checkout', '-q', '-b', 'feat/revalidation-close'], dir);
  const configPath = path.join(dir, '.claude', 'queue.json');
  const issue = jiraIssue({ status, issuelinks, ...(updated === null ? {} : { updated }) });
  await writeFile(
    configPath,
    JSON.stringify({
      adapter: 'jira',
      options: {
        project: 'AR',
        issues: [issue, ...others],
      },
    }),
  );
  await trackClaimBaseline(dir, issue, 'master');
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

  it('needs no remote target ref at close and ignores --base there', async () => {
    const p = await closeProject();
    expect(existsSync(path.join(p.dir, '.git'))).toBe(true);
    const { code, result, out } = await revalidateCloseJson(p, ['--base', 'no-such-ref']);
    expect(code, out).toBe(0);
    expect(result).toMatchObject({ ticket: 'AR-1', point: 'BEFORE_CLOSE', action: 'continue' });
    expect(result).not.toHaveProperty('main');
  });
});

describe('BEFORE_CLOSE — markers remain evidence beside the durable claim', () => {
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

  it('continues when only the marker moved past the last validation', async () => {
    const p = await closeProject({ updated: T3, snapshot: T1 });
    recordBeforePr(p.runDir, T2);
    const { code, result, out } = await revalidateCloseJson(p);
    expect(code, out).toBe(0);
    expect(result).toMatchObject({
      changed: false,
      action: 'continue',
      source: [],
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

  it('uses the tracked claim when there is neither an event nor a take-up snapshot', async () => {
    const p = await closeProject({ snapshot: null });
    const { code, result, out } = await revalidateCloseJson(p);
    expect(code, out).toBe(0);
    expect(result).toMatchObject({
      changed: false,
      action: 'continue',
      source: [],
      task: { changed: null, from: null, to: T1 },
    });
  });
});

describe('BEFORE_CLOSE — workflow state remains part of claim:scope', () => {
  it('is unverifiable when the tracker no longer offers the item or its claim', async () => {
    const p = await closeProject();
    const { code, stdout, out } = await run(
      process.execPath,
      [
        revalidateScript,
        '--point',
        'BEFORE_CLOSE',
        '--ticket',
        'AR-9',
        '--config',
        p.configPath,
        '--json',
      ],
      p.dir,
      p.env,
    );
    expect(code, out).toBe(2);
    const result = JSON.parse(stdout) as CloseResult;
    expect(result.state).toEqual({ expected: 'in-progress', actual: 'missing' });
    expect(result).toMatchObject({ result: 'UNVERIFIABLE', action: 'unverifiable' });
    expect(result.source).toEqual([]);
    expect(result.task.changed).toBeNull();
  });

  it('holds on claim:scope when someone already closed the item', async () => {
    const p = await closeProject({ status: DONE });
    const { code, result, out } = await revalidateCloseJson(p);
    expect(code, out).toBe(2);
    expect(result).toMatchObject({
      changed: true,
      action: 'hold',
      source: ['claim:scope'],
      state: { expected: 'in-progress', actual: 'closed' },
    });
  });

  it('holds on claim:scope when the item was moved back to open', async () => {
    const p = await closeProject({ status: TO_DO });
    const { code, result, out } = await revalidateCloseJson(p);
    expect(code, out).toBe(2);
    expect(result.source).toEqual(['claim:scope']);
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
    expect(result.dependantState).toEqual({});
  });

  it("re-reads each dependant's state, and names one the tracker no longer offers", async () => {
    const done = { name: 'Done', statusCategory: { key: 'done' } };
    const p = await closeProject({
      issuelinks: [blocksLink('AR-7'), blocksLink('AR-9'), blocksLink('AR-11')],
      others: [
        { ...jiraIssue({ status: done }), key: 'AR-7' },
        { ...jiraIssue(), key: 'AR-9' },
      ],
    });
    const { code, result } = await revalidateCloseJson(p);
    // a dependant already closed, or gone, is reported — it is not a hold
    expect(code).toBe(0);
    expect(result.dependantState).toEqual({
      'AR-7': 'closed',
      'AR-9': 'in-progress',
      'AR-11': 'missing',
    });
  });
});

describe('BEFORE_CLOSE — what it prints and what it journals', () => {
  it('text mode on hold names the authoritative scope source on one line', async () => {
    const p = await closeProject({ updated: T3, snapshot: T1, status: DONE });
    const { code, stdout } = await revalidateClose(p);
    expect(code).toBe(2);
    expect(stdout).toMatch(/^revalidate BEFORE_CLOSE: AR-1 hold — claim:scope/m);
    expect(stdout).not.toContain('task:updatedAt');
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
    expect(events[1]!.data).toMatchObject({ point: 'BEFORE_CLOSE', action: 'continue' });
    expect(journal.readRun({ runDir: p.runDir }).ended).toBe(false);
  });

  it('uses the tracked claim without a run dir, and writes nothing', async () => {
    const p = await closeProject();
    const env = { ...p.env };
    delete env.RIG_RUN_DIR;
    const { code, result, out } = await revalidateCloseJson({ ...p, env });
    expect(code, out).toBe(0);
    expect(result).toMatchObject({ action: 'continue', task: { changed: null } });
    expect(existsSync(path.join(p.runDir, 'events.jsonl'))).toBe(false);
  });
});

describe('takeUpEvidenceOf cannot make a BEFORE_CLOSE decision', () => {
  const load = async () =>
    (await loadQueue('core.mjs')) as {
      takeUpEvidenceOf: (input: { ticket: unknown; snapshot?: string | null }) => {
        changed: boolean | null;
        task: { from: string | null; to: string | null };
      };
    };

  it('keeps the last marker comparison as evidence without action or sources', async () => {
    const { takeUpEvidenceOf } = await load();
    const evidence = takeUpEvidenceOf({ ticket: { id: 'AR-1', updatedAt: T3 }, snapshot: T2 });
    expect(evidence).toEqual({
      changed: true,
      task: { from: T2, to: T3 },
    });
    expect(evidence).not.toHaveProperty('action');
    expect(evidence).not.toHaveProperty('source');
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
