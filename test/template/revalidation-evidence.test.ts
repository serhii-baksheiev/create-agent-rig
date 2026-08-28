import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// AR-136 [RX4] Revalidation evidence log. Three points now revalidate (SELECT,
// BEFORE_PR, BEFORE_CLOSE) and each one journals a `revalidation` event — but
// a `changed: true` is only a CATCH if the re-read altered what the run did.
// A hold that changed nothing is noise, and the sources of noise are what
// decides whether a point is worth its cost. So this item does three things:
// one event shape at all three points, so a reader can join them; an `outcome`
// command with a deterministic join (the outcome ANSWERS one revalidation by
// seq — no guessing by ticket); and a report that counts opportunities,
// catches, false holds and unresolved holds per point, over every run under
// `.claude/runs`, and never silently drops a run it could not read.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universal, '.claude', 'scripts');
const queueDir = path.join(scriptsDir, 'queue');
const revalidateScript = path.join(scriptsDir, 'revalidate.mjs');
const reportScript = path.join(scriptsDir, 'revalidation-report.mjs');
const loopSkill = path.join(universal, '.claude', 'skills', 'loop', 'SKILL.md');
const read = (...parts: string[]) => readFile(path.join(...parts), 'utf8');

const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(scriptsDir, 'preflight.mjs')).href
)) as { withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };

interface JournalRecord {
  seq: number;
  at: string;
  kind?: string;
  data?: Record<string, unknown> | null;
  [key: string]: unknown;
}

const journal = (await import(pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href)) as {
  recordEvent: (input: {
    runDir: string;
    kind: string;
    data?: unknown;
    now: string;
  }) => JournalRecord;
  recordDecision: (input: {
    runDir: string;
    gate: string;
    verdict: string;
    now: string;
  }) => JournalRecord;
  readRun: (input: { runDir: string }) => { events: JournalRecord[]; ended: boolean };
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

const POINTS = ['SELECT', 'BEFORE_PR', 'BEFORE_CLOSE'] as const;
type Point = (typeof POINTS)[number];

/** The keys every `revalidation` event carries, at every point, in one shape. */
interface CommonShape {
  ticket: string;
  point: Point;
  changed: boolean | null;
  source: string[];
  action: 'hold' | 'continue' | 'unverifiable';
  task: { from: string | null; to: string | null };
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

const node = (script: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  run(process.execPath, [script, ...args], cwd, env);

/** An issue in the shape the Jira REST search returns. */
const jiraIssue = (over: Record<string, unknown> = {}) => ({
  key: 'AR-1',
  fields: {
    summary: 'add a route',
    status: { name: 'To Do', statusCategory: { key: 'new' } },
    labels: ['ready'],
    priority: null,
    created: '2026-07-01T00:00:00.000+0000',
    issuelinks: [],
    ...over,
  },
});

const IN_PROGRESS = { name: 'In Progress', statusCategory: { key: 'indeterminate' } };

/** A plain directory holding a jira queue config run OFFLINE, plus a run dir. */
const project = async (issue: Record<string, unknown>) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evidence-'));
  await mkdir(path.join(dir, '.claude'), { recursive: true });
  await mkdir(path.join(dir, '.rig'), { recursive: true });
  await writeFile(
    path.join(dir, '.rig', 'revalidation.json'),
    `${JSON.stringify(REVALIDATION_CONTRACT)}\n`,
  );
  await git(['init', '-q', '-b', 'master'], dir);
  await git(['add', '.rig/revalidation.json'], dir);
  await git(['commit', '-q', '-m', 'seed contract'], dir);
  await git(['checkout', '-q', '-b', 'feat/revalidation-evidence'], dir);
  const configPath = path.join(dir, '.claude', 'queue.json');
  await writeFile(
    configPath,
    JSON.stringify({ adapter: 'jira', options: { project: 'AR', issues: [jiraIssue(issue)] } }),
  );
  const runDir = await mkdtemp(path.join(tmpdir(), 'run-'));
  return { dir, configPath, runDir, env: { ...withoutGitLocation(), RIG_RUN_DIR: runDir } };
};

const trackClaim = async (root: string) => {
  await git(['add', '.rig/claims/AR-1.json'], root);
  await git(['commit', '-q', '-m', 'track claim baseline'], root);
};

const createAndTrackClaim = async (
  root: string,
  issue: Record<string, unknown>,
  targetRef: string | null,
) => {
  const jira = (await import(pathToFileURL(path.join(queueDir, 'jira.mjs')).href)) as {
    find: (id: string, options: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  };
  const claims = (await import(
    pathToFileURL(path.join(scriptsDir, 'lib', 'claim-records.mjs')).href
  )) as {
    revalidateClaim: (input: Record<string, unknown>) => { result: string };
    targetShaOf: (projectRoot: string, ref?: string | null) => string | null;
  };
  const ticket = await jira.find('AR-1', { project: 'AR', issues: [jiraIssue(issue)] });
  if (!ticket) throw new Error('claim fixture could not map its Jira issue');
  const result = claims.revalidateClaim({
    projectRoot: root,
    ticket,
    point: 'SELECT',
    targetSha: claims.targetShaOf(root, targetRef),
    allowCreate: true,
  });
  if (result.result !== 'BASELINE_CREATED') throw new Error(`claim fixture: ${result.result}`);
  await trackClaim(root);
};

const eventsOf = (runDir: string, kind: string): JournalRecord[] =>
  journal.readRun({ runDir }).events.filter((record) => record.kind === kind);

const rawEvents = async (runDir: string): Promise<JournalRecord[]> =>
  (await read(runDir, 'events.jsonl').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JournalRecord);

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

/** The smallest clone BEFORE_PR can compare: an origin, one seed commit, a branch. */
const gitClone = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-git-'));
  const origin = path.join(root, 'origin.git');
  const clone = path.join(root, 'clone');
  await mkdir(origin);
  await git(['init', '--bare', '-b', 'master'], origin);
  await git(['clone', '-q', origin, clone], root);
  await mkdir(path.join(clone, '.rig'), { recursive: true });
  await writeFile(
    path.join(clone, '.rig', 'revalidation.json'),
    `${JSON.stringify(REVALIDATION_CONTRACT)}\n`,
  );
  await writeFile(path.join(clone, 'a.txt'), 'a.txt v1\n');
  await git(['add', '-A'], clone);
  await git(['commit', '-q', '-m', 'seed'], clone);
  await git(['push', '-q', '-u', 'origin', 'master'], clone);
  await git(['checkout', '-q', '-b', 'feat/ar-1'], clone);
  await writeFile(path.join(clone, 'a.txt'), 'a.txt on the branch\n');
  await git(['commit', '-q', '-a', '-m', 'branch touches a.txt'], clone);
  return clone;
};

const expectCommonShape = (data: unknown, point: Point) => {
  const record = data as CommonShape;
  expect(record.point).toBe(point);
  expect(record.ticket).toBe('AR-1');
  expect([true, false, null]).toContain(record.changed);
  expect(Array.isArray(record.source), `source at ${point} is an array`).toBe(true);
  expect(['hold', 'continue', 'unverifiable']).toContain(record.action);
  expect(record.task, `task at ${point}`).toEqual(
    expect.objectContaining({ from: expect.anything(), to: expect.anything() }) as unknown,
  );
  for (const key of ['from', 'to'] as const) {
    const value = record.task[key];
    expect(value === null || typeof value === 'string', `task.${key} at ${point}`).toBe(true);
  }
};

describe('A. one revalidation shape at all three points', () => {
  it('takeUpEvidenceOf reports marker movement without returning a drift decision', async () => {
    const { takeUpEvidenceOf } = (await import(
      pathToFileURL(path.join(queueDir, 'core.mjs')).href
    )) as {
      takeUpEvidenceOf: (input: {
        ticket: unknown;
        snapshot?: string | null;
      }) => Record<string, unknown>;
    };
    expect(takeUpEvidenceOf({ ticket: { id: 'AR-1', updatedAt: T2 }, snapshot: T1 })).toEqual({
      changed: true,
      task: { from: T1, to: T2 },
    });
    expect(takeUpEvidenceOf({ ticket: { id: 'AR-1', updatedAt: T1 }, snapshot: T1 })).toEqual({
      changed: false,
      task: { from: T1, to: T1 },
    });
    expect(takeUpEvidenceOf({ ticket: { id: 'AR-1', updatedAt: null }, snapshot: T1 })).toEqual({
      changed: null,
      task: { from: T1, to: null },
    });
  });

  it('the journaled events of SELECT, BEFORE_PR and BEFORE_CLOSE share exactly the common keys and value types', async () => {
    // SELECT — through the queue CLI, twice, so the second one is a real compare.
    const select = await project({ updated: T1 });
    const first = await node(
      path.join(queueDir, 'index.mjs'),
      ['next', '--json', '--config', select.configPath],
      select.dir,
      select.env,
    );
    expect(first.code, first.out).toBe(0);
    await trackClaim(select.dir);
    await writeFile(
      select.configPath,
      JSON.stringify({
        adapter: 'jira',
        options: { project: 'AR', issues: [jiraIssue({ updated: T2 })] },
      }),
    );
    const second = await node(
      path.join(queueDir, 'index.mjs'),
      ['next', '--json', '--config', select.configPath],
      select.dir,
      select.env,
    );
    expect(second.code, second.out).toBe(0);
    const selectEvents = eventsOf(select.runDir, 'revalidation');
    expect(selectEvents).toHaveLength(2);
    expectCommonShape(selectEvents[1]!.data, 'SELECT');
    expect(selectEvents[1]!.data).toMatchObject({
      changed: false,
      source: [],
      action: 'continue',
      task: { from: T1, to: T2 },
    });

    // BEFORE_PR — in a git clone whose run took the item up at T1.
    const clone = await gitClone();
    await mkdir(path.join(clone, '.claude'), { recursive: true });
    const prConfig = path.join(clone, '.claude', 'queue.json');
    await writeFile(
      prConfig,
      JSON.stringify({
        adapter: 'jira',
        options: { project: 'AR', issues: [jiraIssue({ status: IN_PROGRESS, updated: T1 })] },
      }),
    );
    const prRun = await mkdtemp(path.join(tmpdir(), 'run-pr-'));
    await writeFile(path.join(prRun, 'state.json'), JSON.stringify({ takeUps: { 'AR-1': T1 } }));
    await createAndTrackClaim(clone, { status: IN_PROGRESS, updated: T1 }, 'origin/master');
    const pr = await node(
      revalidateScript,
      ['--point', 'BEFORE_PR', '--ticket', 'AR-1', '--config', prConfig, '--json'],
      clone,
      { ...withoutGitLocation(), RIG_RUN_DIR: prRun },
    );
    expect(pr.code, pr.out).toBe(0);
    const prEvents = eventsOf(prRun, 'revalidation');
    expect(prEvents).toHaveLength(1);
    expectCommonShape(prEvents[0]!.data, 'BEFORE_PR');

    // BEFORE_CLOSE — the same durable claim contract, with no remote lookup.
    const close = await project({ status: IN_PROGRESS, updated: T1 });
    await createAndTrackClaim(close.dir, { status: IN_PROGRESS, updated: T1 }, 'master');
    await writeFile(
      path.join(close.runDir, 'state.json'),
      JSON.stringify({ takeUps: { 'AR-1': T1 } }),
    );
    const closed = await node(
      revalidateScript,
      ['--point', 'BEFORE_CLOSE', '--ticket', 'AR-1', '--config', close.configPath, '--json'],
      close.dir,
      close.env,
    );
    expect(closed.code, closed.out).toBe(0);
    const closeEvents = eventsOf(close.runDir, 'revalidation');
    expect(closeEvents).toHaveLength(1);
    expectCommonShape(closeEvents[0]!.data, 'BEFORE_CLOSE');
  });

  it('the SELECT text line does not turn updatedAt-only movement into a hold', async () => {
    const p = await project({ updated: T1 });
    const first = await node(
      path.join(queueDir, 'index.mjs'),
      ['next', '--config', p.configPath],
      p.dir,
      p.env,
    );
    expect(first.code, first.out).toBe(0);
    await trackClaim(p.dir);
    expect(first.stdout).not.toMatch(/^revalidate:/m);
    await writeFile(
      p.configPath,
      JSON.stringify({
        adapter: 'jira',
        options: { project: 'AR', issues: [jiraIssue({ updated: T2 })] },
      }),
    );
    const second = await node(
      path.join(queueDir, 'index.mjs'),
      ['next', '--config', p.configPath],
      p.dir,
      p.env,
    );
    expect(second.code, second.out).toBe(0);
    expect(second.code, second.out).toBe(0);
    expect(second.stdout).not.toContain('task:updatedAt');
    expect(second.stdout).not.toContain('re-read');
  });
});

describe('B. `revalidate.mjs outcome` answers one revalidation event by seq', () => {
  /** A run dir seeded with the given revalidation events, in order. */
  const seeded = async (
    events: Array<{ ticket: string; point: Point }>,
  ): Promise<{ dir: string; runDir: string; env: NodeJS.ProcessEnv }> => {
    const p = await project({ updated: T1 });
    for (const data of events) {
      journal.recordEvent({
        runDir: p.runDir,
        kind: 'revalidation',
        data: {
          ...data,
          changed: true,
          source: ['task:updatedAt'],
          action: 'hold',
          task: { from: T1, to: T2 },
        },
        now: NOW,
      });
    }
    return p;
  };

  const outcome = (p: { dir: string; env: NodeJS.ProcessEnv }, args: string[]) =>
    node(revalidateScript, ['outcome', ...args], p.dir, p.env);

  it('appends one revalidation-outcome whose `answers` is the seq of the latest matching revalidation', async () => {
    const p = await seeded([
      { ticket: 'AR-1', point: 'SELECT' }, // seq 1
      { ticket: 'AR-1', point: 'BEFORE_PR' }, // seq 2
      { ticket: 'AR-1', point: 'SELECT' }, // seq 3 — the latest SELECT for AR-1
      { ticket: 'AR-2', point: 'SELECT' }, // seq 4 — another ticket
    ]);
    const result = await outcome(p, [
      '--point',
      'SELECT',
      '--ticket',
      'AR-1',
      '--action-changed',
      'true',
      '--note',
      'a late comment re-scoped it',
    ]);
    expect(result.code, result.out).toBe(0);
    const outcomes = eventsOf(p.runDir, 'revalidation-outcome');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.data).toMatchObject({
      ticket: 'AR-1',
      point: 'SELECT',
      actionChanged: true,
      actionRequired: true,
      action: 'semantic decision',
      driftOrigin: 'unknown',
      resolvedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      note: 'a late comment re-scoped it',
      answers: 3,
    });
    expect(journal.readRun({ runDir: p.runDir }).events).toHaveLength(5);
  });

  it('records `actionChanged: false` with `note: null` when no note is given', async () => {
    const p = await seeded([{ ticket: 'AR-1', point: 'BEFORE_CLOSE' }]);
    const result = await outcome(p, [
      '--point',
      'BEFORE_CLOSE',
      '--ticket',
      'AR-1',
      '--action-changed',
      'false',
    ]);
    expect(result.code, result.out).toBe(0);
    expect(eventsOf(p.runDir, 'revalidation-outcome')[0]!.data).toMatchObject({
      ticket: 'AR-1',
      point: 'BEFORE_CLOSE',
      actionChanged: false,
      actionRequired: false,
      action: 'continue',
      driftOrigin: 'unknown',
      resolvedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      note: null,
      answers: 1,
    });
  });

  it('stores a note carrying a quote character verbatim', async () => {
    const p = await seeded([{ ticket: 'AR-1', point: 'SELECT' }]);
    const note = `the owner's "done" comment changed nothing`;
    const result = await outcome(p, [
      '--point',
      'SELECT',
      '--ticket',
      'AR-1',
      '--action-changed',
      'false',
      '--note',
      note,
    ]);
    expect(result.code, result.out).toBe(0);
    expect(eventsOf(p.runDir, 'revalidation-outcome')[0]!.data).toMatchObject({ note });
  });

  it('--json prints the record it wrote', async () => {
    const p = await seeded([{ ticket: 'AR-1', point: 'SELECT' }]);
    const result = await outcome(p, [
      '--point',
      'SELECT',
      '--ticket',
      'AR-1',
      '--action-changed',
      'true',
      '--json',
    ]);
    expect(result.code, result.out).toBe(0);
    const printed = JSON.parse(result.stdout) as JournalRecord;
    expect(printed).toMatchObject({
      seq: 2,
      kind: 'revalidation-outcome',
      data: { ticket: 'AR-1', point: 'SELECT', actionChanged: true, answers: 1 },
    });
    expect(eventsOf(p.runDir, 'revalidation-outcome')[0]).toEqual(printed);
  });

  it('refuses without RIG_RUN_DIR: exit 1, stderr only, nothing written', async () => {
    const p = await seeded([{ ticket: 'AR-1', point: 'SELECT' }]);
    const env = { ...p.env };
    delete env['RIG_RUN_DIR'];
    const result = await outcome({ dir: p.dir, env }, [
      '--point',
      'SELECT',
      '--ticket',
      'AR-1',
      '--action-changed',
      'true',
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).not.toBe('');
    expect(eventsOf(p.runDir, 'revalidation-outcome')).toHaveLength(0);
  });

  it('refuses when no revalidation event matches the ticket AND point: exit 1, nothing written', async () => {
    const p = await seeded([
      { ticket: 'AR-1', point: 'SELECT' },
      { ticket: 'AR-2', point: 'BEFORE_PR' },
    ]);
    const result = await outcome(p, [
      '--point',
      'BEFORE_PR',
      '--ticket',
      'AR-1',
      '--action-changed',
      'true',
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).not.toBe('');
    expect(await rawEvents(p.runDir)).toHaveLength(2);
  });

  it.each([['yes'], ['1'], ['TRUE'], ['']])(
    'refuses --action-changed %j: only the literal true or false is an answer',
    async (value) => {
      const p = await seeded([{ ticket: 'AR-1', point: 'SELECT' }]);
      const result = await outcome(p, [
        '--point',
        'SELECT',
        '--ticket',
        'AR-1',
        '--action-changed',
        value,
      ]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(await rawEvents(p.runDir)).toHaveLength(1);
    },
  );

  it('refuses a missing --action-changed', async () => {
    const p = await seeded([{ ticket: 'AR-1', point: 'SELECT' }]);
    const result = await outcome(p, ['--point', 'SELECT', '--ticket', 'AR-1']);
    expect(result.code).toBe(1);
    expect(await rawEvents(p.runDir)).toHaveLength(1);
  });

  it('the existing `--point BEFORE_CLOSE --ticket` form without `outcome` still revalidates', async () => {
    const p = await project({ status: IN_PROGRESS, updated: T1 });
    await createAndTrackClaim(p.dir, { status: IN_PROGRESS, updated: T1 }, 'master');
    await writeFile(path.join(p.runDir, 'state.json'), JSON.stringify({ takeUps: { 'AR-1': T1 } }));
    const result = await node(
      revalidateScript,
      ['--point', 'BEFORE_CLOSE', '--ticket', 'AR-1', '--config', p.configPath, '--json'],
      p.dir,
      p.env,
    );
    expect(result.code, result.out).toBe(0);
    expect(eventsOf(p.runDir, 'revalidation')).toHaveLength(1);
    expect(eventsOf(p.runDir, 'revalidation-outcome')).toHaveLength(0);
  });
});

describe('C. `revalidation-report.mjs --since` counts catches that altered the action', () => {
  const SINCE = '2026-08-20T00:00:00.000Z';
  const BEFORE = '2026-08-01T12:00:00.000Z';
  const AFTER = '2026-08-21T12:00:00.000Z';

  const revalidation = (
    point: Point,
    changed: boolean | null,
    source: string[] = changed ? ['task:updatedAt'] : [],
  ) => ({
    ticket: 'AR-1',
    point,
    changed,
    source,
    action: changed === true ? 'hold' : changed === null ? 'unverifiable' : 'continue',
    task: { from: T1, to: changed ? T2 : T1 },
  });

  interface PointCounts {
    opportunities: number;
    catches: number;
    unverifiable: number;
    actionChanged: number;
    falseHolds: number;
    unresolved: number;
  }
  interface Report {
    since: string;
    points: Record<Point, PointCounts>;
    noise: Record<string, number>;
    totals: PointCounts;
    runs: { read: number; skipped: Array<{ run: string; why: string }> };
  }

  /**
   * Three runs: `run-a` entirely before `since`; `run-b` after it, carrying every
   * outcome the report distinguishes; `run-c` a hand-written journal with a gap
   * in its seq, which readRun refuses.
   */
  const runsFixture = async (): Promise<string> => {
    const runs = await mkdtemp(path.join(tmpdir(), 'runs-'));
    const runA = path.join(runs, 'run-a');
    const runB = path.join(runs, 'run-b');
    const runC = path.join(runs, 'run-c');
    await mkdir(runA);
    await mkdir(runB);
    await mkdir(runC);

    // run-a: before since. A hold answered true — must not count. And an
    // outcome whose `answers` collides with run-b's unanswered hold's seq — an
    // outcome only answers within its own run.
    journal.recordEvent({
      runDir: runA,
      kind: 'revalidation',
      data: revalidation('SELECT', true),
      now: BEFORE,
    });
    journal.recordEvent({
      runDir: runA,
      kind: 'revalidation-outcome',
      data: { ticket: 'AR-1', point: 'SELECT', actionChanged: true, note: null, answers: 1 },
      now: BEFORE,
    });
    journal.recordEvent({
      runDir: runA,
      kind: 'revalidation-outcome',
      data: { ticket: 'AR-1', point: 'SELECT', actionChanged: true, note: null, answers: 6 },
      now: BEFORE,
    });

    // run-b: after since (its first event exactly AT since — inclusive).
    journal.recordDecision({
      runDir: runB,
      gate: 'item-selection',
      verdict: 'selected',
      now: SINCE,
    }); // seq 1
    journal.recordEvent({
      runDir: runB,
      kind: 'revalidation',
      data: revalidation('SELECT', false),
      now: SINCE,
    }); // seq 2
    journal.recordEvent({
      runDir: runB,
      kind: 'revalidation',
      data: revalidation('SELECT', false),
      now: AFTER,
    }); // seq 3
    journal.recordEvent({
      runDir: runB,
      kind: 'revalidation',
      data: revalidation('BEFORE_PR', true),
      now: AFTER,
    }); // seq 4
    journal.recordEvent({
      runDir: runB,
      kind: 'revalidation-outcome',
      data: {
        ticket: 'AR-1',
        point: 'BEFORE_PR',
        actionChanged: false,
        note: 'own comment',
        answers: 4,
      },
      now: AFTER,
    }); // seq 5
    journal.recordEvent({
      runDir: runB,
      kind: 'revalidation',
      data: revalidation('SELECT', true),
      now: AFTER,
    }); // seq 6 — unanswered
    journal.recordEvent({
      runDir: runB,
      kind: 'revalidation',
      data: revalidation('BEFORE_CLOSE', true, ['task:state']),
      now: AFTER,
    }); // seq 7
    journal.recordEvent({
      runDir: runB,
      kind: 'revalidation-outcome',
      data: {
        ticket: 'AR-1',
        point: 'BEFORE_CLOSE',
        actionChanged: true,
        note: 'someone closed it',
        answers: 7,
      },
      now: AFTER,
    }); // seq 8
    journal.recordEvent({
      runDir: runB,
      kind: 'revalidation',
      data: revalidation('SELECT', null),
      now: AFTER,
    }); // seq 9

    // run-c: seq 1 then 3 — a gap readRun refuses.
    await writeFile(
      path.join(runC, 'events.jsonl'),
      [
        JSON.stringify({
          seq: 1,
          at: AFTER,
          kind: 'revalidation',
          data: revalidation('SELECT', true),
        }),
        JSON.stringify({
          seq: 3,
          at: AFTER,
          kind: 'revalidation',
          data: revalidation('SELECT', true),
        }),
      ].join('\n') + '\n',
    );
    return runs;
  };

  const report = (args: string[], cwd = repoRoot) =>
    node(reportScript, args, cwd, withoutGitLocation());

  const reportJson = async (runs: string): Promise<{ code: number; out: string; data: Report }> => {
    const result = await report(['--since', SINCE, '--runs', runs, '--json']);
    expect(result.stdout, result.out).not.toBe('');
    return { code: result.code, out: result.out, data: JSON.parse(result.stdout) as Report };
  };

  it('counts per point: opportunities, catches, unverifiable, actionChanged, falseHolds, unresolved', async () => {
    const runs = await runsFixture();
    const { code, out, data } = await reportJson(runs);
    expect(code, out).toBe(0);
    expect(data.points.SELECT).toEqual({
      opportunities: 4,
      catches: 1,
      unverifiable: 1,
      actionChanged: 0,
      falseHolds: 0,
      unresolved: 1,
    });
    expect(data.points.BEFORE_PR).toEqual({
      opportunities: 1,
      catches: 1,
      unverifiable: 0,
      actionChanged: 0,
      falseHolds: 1,
      unresolved: 0,
    });
    expect(data.points.BEFORE_CLOSE).toEqual({
      opportunities: 1,
      catches: 1,
      unverifiable: 0,
      actionChanged: 1,
      falseHolds: 0,
      unresolved: 0,
    });
  });

  it('sums the three points into totals', async () => {
    const runs = await runsFixture();
    const { data } = await reportJson(runs);
    expect(data.totals).toEqual({
      opportunities: 6,
      catches: 3,
      unverifiable: 1,
      actionChanged: 1,
      falseHolds: 1,
      unresolved: 1,
    });
  });

  it('names the sources of the false holds as noise', async () => {
    const runs = await runsFixture();
    const { data } = await reportJson(runs);
    expect(data.noise).toEqual({ 'task:updatedAt': 1 });
  });

  it('reports a run it could not read under skipped, with why, and never drops it silently', async () => {
    const runs = await runsFixture();
    const { data } = await reportJson(runs);
    expect(data.runs.read).toBe(2);
    expect(data.runs.skipped).toHaveLength(1);
    expect(data.runs.skipped[0]!.run).toBe('run-c');
    expect(data.runs.skipped[0]!.why).toMatch(/seq|sequence/i);
  });

  it('text mode prints one line per point and a totals line', async () => {
    const runs = await runsFixture();
    const result = await report(['--since', SINCE, '--runs', runs]);
    expect(result.code, result.out).toBe(0);
    for (const point of POINTS) {
      expect(result.stdout).toMatch(new RegExp(`^${point}\\b`, 'm'));
    }
    expect(result.stdout).toMatch(/^totals?\b/im);
    expect(result.stdout).toMatch(/run-c/);
  });

  it('a since that no run reaches reports zero everywhere, and still counts the runs it read', async () => {
    const runs = await runsFixture();
    const result = await report(['--since', '2027-01-01T00:00:00.000Z', '--runs', runs, '--json']);
    expect(result.code, result.out).toBe(0);
    const data = JSON.parse(result.stdout) as Report;
    expect(data.totals.opportunities).toBe(0);
    expect(data.runs.read).toBe(2);
  });

  it.each([['not-a-date'], ['2026-13-45']])(
    'refuses an unparsable --since %j: exit 1',
    async (since) => {
      const runs = await runsFixture();
      const result = await report(['--since', since, '--runs', runs, '--json']);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim()).not.toBe('');
    },
  );

  it('refuses without --since: exit 1', async () => {
    const runs = await runsFixture();
    const result = await report(['--runs', runs, '--json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
  });
});

describe('D. the loop skill points at the outcome command and the report', () => {
  const section = (text: string, from: string, to: string): string => {
    const start = text.indexOf(from);
    const end = text.indexOf(to, start);
    expect(start, `heading ${from}`).toBeGreaterThan(-1);
    return end === -1 ? text.slice(start) : text.slice(start, end);
  };

  it('§2 carries the outcome command instead of the recordEvent snippet', async () => {
    const s2 = section(await read(loopSkill), '## 2.', '## 3.');
    expect(s2).toContain('node .claude/scripts/revalidate.mjs outcome --point');
    expect(s2).not.toMatch(/--input-type=module[^`]*revalidation-outcome/);
  });

  it('§2 states the rule that no-change is always recorded', async () => {
    const s2 = section(await read(loopSkill), '## 2.', '## 3.');
    expect(s2).toMatch(/no-change[^\n]*always recorded|always recorded[^\n]*no-change/i);
  });

  it('§9 Closing points at the same command with BEFORE_CLOSE', async () => {
    const s9 = section(await read(loopSkill), '## 9.', '\n## 10.');
    expect(s9).toMatch(/revalidate\.mjs outcome --point BEFORE_CLOSE/);
  });

  it('pr-ship step 1 records the outcome of a BEFORE_PR hold with the same command', async () => {
    const skill = await read(path.join(universal, '.claude', 'skills', 'pr-ship', 'SKILL.md'));
    expect(skill).toMatch(/revalidate\.mjs outcome --point BEFORE_PR/);
  });

  it('the README or the loop skill names revalidation-report.mjs --since', async () => {
    const readme = existsSync(path.join(repoRoot, 'README.md'))
      ? await read(repoRoot, 'README.md')
      : '';
    const skill = await read(loopSkill);
    expect(`${readme}\n${skill}`).toMatch(/revalidation-report\.mjs --since/);
  });
});

describe('the report finds the runs where the loop declared them', () => {
  const SINCE = '2026-08-20T00:00:00.000Z';
  const AFTER = '2026-08-21T12:00:00.000Z';
  const git = (args: string[], cwd: string) =>
    new Promise<void>((resolve, reject) => {
      execFile('git', args, { cwd, env: withoutGitLocation() }, (error, _out, stderr) =>
        error ? reject(new Error(`git ${args.join(' ')} failed: ${stderr}`)) : resolve(),
      );
    });

  it("reads the main checkout's runs by default, even from a linked worktree", async () => {
    // A rig with the scripts installed, one run recorded in ITS .claude/runs, and
    // a linked worktree that carries no runs at all — the report run from the
    // worktree must still read the run, or a session in a worktree would report
    // a rig with no revalidations.
    const root = await mkdtemp(path.join(tmpdir(), 'report-main-'));
    const main = path.join(root, 'main');
    await mkdir(path.join(main, '.claude'), { recursive: true });
    await cp(scriptsDir, path.join(main, '.claude', 'scripts'), { recursive: true });
    await git(['init', '-q', '-b', 'master'], main);
    // The scripts are committed so the linked worktree carries them; the run
    // directory is created AFTER the commit so only the main checkout has it.
    await git(['add', '-A'], main);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], main);
    const runDir = path.join(main, '.claude', 'runs', 'run-x');
    await mkdir(runDir, { recursive: true });
    journal.recordEvent({
      runDir,
      kind: 'revalidation',
      data: {
        ticket: 'AR-1',
        point: 'SELECT',
        changed: false,
        source: [],
        action: 'continue',
        task: { from: T1, to: T1 },
      },
      now: AFTER,
    });
    const worktree = path.join(root, 'wt');
    await git(['worktree', 'add', '-q', worktree, '-b', 'wt'], main);
    expect(existsSync(path.join(worktree, '.claude', 'runs'))).toBe(false);
    const script = path.join(worktree, '.claude', 'scripts', 'revalidation-report.mjs');
    const result = await node(script, ['--since', SINCE, '--json'], worktree, withoutGitLocation());
    expect(result.code, result.out).toBe(0);
    const data = JSON.parse(result.stdout) as {
      runs: { read: number };
      totals: { opportunities: number };
    };
    expect(data.runs.read).toBe(1);
    expect(data.totals.opportunities).toBe(1);
  });
});
