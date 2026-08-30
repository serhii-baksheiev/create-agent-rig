import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// AR-133 [RX1], superseded by RP-50's durable content-blind baseline. SELECT
// still records take-up markers for compatibility evidence, but only the
// tracked `.rig/claims/<ticket>.json` decides drift.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universal, '.claude', 'scripts');
const queueDir = path.join(scriptsDir, 'queue');
const load = (file: string) => import(pathToFileURL(path.join(queueDir, file)).href);
const loadScript = (file: string) => import(pathToFileURL(path.join(scriptsDir, file)).href);
const read = (...parts: string[]) => readFile(path.join(...parts), 'utf8');

// The one git-env sanitiser the shipped scripts export — see queue.test.ts for
// the scar that made it necessary.
const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(scriptsDir, 'preflight.mjs')).href
)) as { withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };

const T1 = '2026-08-24T20:56:23.474Z';
const T2 = '2026-08-25T09:00:00.000Z';

// AR-136 [RX4]: one shape at every point — `source` is a list of source names
// (never a bare string or null), `action` is the hold vocabulary the other two
// points already use, and the compared markers sit under `task`.
interface Revalidation {
  ticket: string;
  point: 'SELECT';
  changed: boolean | null;
  source: string[];
  action: 'hold' | 'continue' | 'unverifiable';
  task: { from: string | null; to: string | null };
}

interface EventRecord {
  kind: string;
  data: Record<string, unknown> | null;
}

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

/** A GitHub issue as `gh issue list --json` reports it. */
const ghIssue = (over: Record<string, unknown> = {}) => ({
  number: 7,
  title: 'add a route',
  body: '',
  state: 'OPEN',
  labels: [{ name: 'ready' }],
  url: 'https://example.invalid/issues/7',
  createdAt: '2026-07-01T00:00:00Z',
  ...over,
});

const runNode = (
  script: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; out: string }> =>
  new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { cwd, env }, (error, stdout, stderr) => {
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        stdout,
        out: stdout + stderr,
      });
    });
  });

const runCli = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  runNode(path.join(queueDir, 'index.mjs'), args, cwd, env);

const git = async (args: string[], cwd: string): Promise<void> => {
  const result = await new Promise<{ code: number; out: string }>((resolve) => {
    execFile(
      'git',
      ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
      { cwd, env: withoutGitLocation() },
      (error, stdout, stderr) =>
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          out: stdout + stderr,
        }),
    );
  });
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
};

const seedContract = async (dir: string): Promise<void> => {
  await mkdir(path.join(dir, '.rig'), { recursive: true });
  await writeFile(
    path.join(dir, '.rig', 'revalidation.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      detection: {
        mode: 'pull',
        sources: ['run-state', 'journal'],
        acceptedLatency: '24h',
        push: false,
      },
      pairedFacts: [],
    })}\n`,
  );
  await git(['init', '-q', '-b', 'master'], dir);
  await git(['add', '.rig/revalidation.json'], dir);
  await git(['commit', '-q', '-m', 'seed contract'], dir);
  await git(['checkout', '-q', '-b', 'feat/revalidation'], dir);
};

const trackClaim = async (dir: string, id = 'AR-1'): Promise<void> => {
  await git(['add', `.rig/claims/${id}.json`], dir);
  await git(['commit', '-q', '-m', `track ${id} claim`], dir);
};

/**
 * A project whose queue is the jira adapter run OFFLINE: `options.issues` is the
 * adapter's own seam, so no credential and no network are needed. The config
 * is rewritten between runs to move the ticket's `updated` marker.
 */
const jiraProject = async (): Promise<{
  dir: string;
  configPath: string;
  runDir: string;
  env: NodeJS.ProcessEnv;
  setUpdated: (updated: string | undefined) => Promise<void>;
}> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'revalidate-'));
  await seedContract(dir);
  await mkdir(path.join(dir, '.claude'), { recursive: true });
  const configPath = path.join(dir, '.claude', 'queue.json');
  const setUpdated = (updated: string | undefined) =>
    writeFile(
      configPath,
      JSON.stringify({
        adapter: 'jira',
        options: {
          project: 'AR',
          issues: [jiraIssue(updated === undefined ? {} : { updated })],
        },
      }),
    );
  await setUpdated(T1);
  const runDir = await mkdtemp(path.join(tmpdir(), 'run-'));
  return {
    dir,
    configPath,
    runDir,
    env: { ...withoutGitLocation(), RIG_RUN_DIR: runDir },
    setUpdated,
  };
};

const planProject = async (): Promise<{
  dir: string;
  configPath: string;
  runDir: string;
  env: NodeJS.ProcessEnv;
}> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'revalidate-plan-'));
  await seedContract(dir);
  await mkdir(path.join(dir, '.claude'), { recursive: true });
  await writeFile(path.join(dir, 'PLAN.md'), '# P\n\n## Agent queue\n\n- add a route\n');
  const configPath = path.join(dir, '.claude', 'queue.json');
  await writeFile(configPath, JSON.stringify({ adapter: 'plan-md' }));
  const runDir = await mkdtemp(path.join(tmpdir(), 'run-'));
  return { dir, configPath, runDir, env: { ...withoutGitLocation(), RIG_RUN_DIR: runDir } };
};

const nextJson = async (
  configPath: string,
  dir: string,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown> & { revalidation: Revalidation | null }> => {
  const { code, stdout, out } = await runCli(['next', '--json', '--config', configPath], dir, env);
  expect(code, out).toBe(0);
  return JSON.parse(stdout) as Record<string, unknown> & { revalidation: Revalidation | null };
};

// An absent file is an empty state, exactly as `readState` reads it: a run
// that had nothing to snapshot writes nothing, and that absence is the assertion.
const stateOf = async (runDir: string): Promise<Record<string, unknown>> =>
  JSON.parse(await read(runDir, 'state.json').catch(() => '{}')) as Record<string, unknown>;

const revalidationEvents = async (runDir: string): Promise<EventRecord[]> =>
  (await read(runDir, 'events.jsonl'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EventRecord)
    .filter((record) => record.kind === 'revalidation');

describe('the neutral ticket carries a freshness marker', () => {
  it('jira maps `fields.updated` to an ISO `updatedAt`', async () => {
    const { toTicket } = await load('jira.mjs');
    const ticket = toTicket(jiraIssue({ updated: '2026-08-25T00:56:23.474+0400' }));
    expect(ticket.updatedAt).toBe(T1);
  });

  it('jira reports null when the issue carries no `updated`', async () => {
    const { toTicket } = await load('jira.mjs');
    const ticket = toTicket(jiraIssue());
    expect(ticket).toHaveProperty('updatedAt');
    expect(ticket.updatedAt).toBeNull();
  });

  it('github maps `updatedAt`, and null when absent', async () => {
    const { toTicket } = await load('github-issues.mjs');
    expect(toTicket(ghIssue({ updatedAt: '2026-08-24T20:56:23Z' })).updatedAt).toBe(
      '2026-08-24T20:56:23Z',
    );
    const bare = toTicket(ghIssue());
    expect(bare).toHaveProperty('updatedAt');
    expect(bare.updatedAt).toBeNull();
  });

  it('github asks `gh issue list --json` for `updatedAt`', async () => {
    // gh is not run here, so the request is pinned by reading the field list
    // the adapter hands it.
    const source = await read(queueDir, 'github-issues.mjs');
    const fields = /const FIELDS = '([^']*)'/.exec(source);
    expect(fields, 'FIELDS constant').not.toBeNull();
    expect(fields![1]!.split(',')).toContain('updatedAt');
  });

  it('plan-md items carry `updatedAt: null`, because a flat list has no marker', async () => {
    const { parsePlan } = await load('plan-md.mjs');
    const [item] = parsePlan('# P\n\n## Agent queue\n\n- add a route\n');
    expect(item).toHaveProperty('updatedAt');
    expect(item.updatedAt).toBeNull();
  });
});

describe('the jira search asks for the marker', () => {
  const CREDENTIALS = {
    JIRA_BASE_URL: 'https://example.invalid',
    JIRA_EMAIL: 'a@b.c',
    JIRA_API_TOKEN: 'x',
  };
  const bodies: Array<Record<string, unknown> | null> = [];
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    bodies.length = 0;
    realFetch = globalThis.fetch;
    globalThis.fetch = ((_input: unknown, init: { body?: string } = {}) => {
      bodies.push(init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null);
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({ issues: [] }),
      });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("lists 'updated' among the fields it requests", async () => {
    const { search } = await load('jira.mjs');
    await search({ project: 'AR', env: CREDENTIALS });
    expect(bodies[0]).not.toBeNull();
    expect(bodies[0]!.fields as string[]).toEqual(expect.arrayContaining(['updated']));
  });
});

describe('takeUpEvidenceOf reports marker movement without deciding drift', () => {
  const ticket = (updatedAt: string | null | undefined) => ({ id: 'AR-1', updatedAt });

  it('is unverifiable when the ticket has no marker', async () => {
    const { takeUpEvidenceOf } = await load('core.mjs');
    expect(takeUpEvidenceOf({ ticket: ticket(null), snapshot: T1 })).toEqual({
      changed: null,
      task: { from: T1, to: null },
    });
    expect(takeUpEvidenceOf({ ticket: { id: 'AR-1' }, snapshot: undefined })).toMatchObject({
      changed: null,
      task: { from: null },
    });
  });

  it('continues, and offers the marker as the new snapshot, when nothing was snapshotted yet', async () => {
    const { takeUpEvidenceOf } = await load('core.mjs');
    expect(takeUpEvidenceOf({ ticket: ticket(T1), snapshot: undefined })).toEqual({
      changed: false,
      task: { from: null, to: T1 },
    });
    expect(takeUpEvidenceOf({ ticket: ticket(T1), snapshot: null })).toMatchObject({
      changed: false,
      task: { from: null, to: T1 },
    });
  });

  it('continues when the snapshot equals the marker', async () => {
    const { takeUpEvidenceOf } = await load('core.mjs');
    const evidence = takeUpEvidenceOf({ ticket: ticket(T1), snapshot: T1 });
    expect(evidence).toMatchObject({
      changed: false,
      task: { from: T1, to: T1 },
    });
    expect(evidence).not.toHaveProperty('source');
    expect(evidence).not.toHaveProperty('action');
  });

  it('reports movement without naming a source or action', async () => {
    const { takeUpEvidenceOf } = await load('core.mjs');
    const evidence = takeUpEvidenceOf({ ticket: ticket(T2), snapshot: T1 });
    expect(evidence).toEqual({
      changed: true,
      task: { from: T1, to: T2 },
    });
    expect(evidence).not.toHaveProperty('source');
    expect(evidence).not.toHaveProperty('action');
  });

  it('reports `changed: true` in exactly one of the four cases', async () => {
    const { takeUpEvidenceOf } = await load('core.mjs');
    const cases = [
      { ticket: ticket(null), snapshot: T1 },
      { ticket: ticket(T1), snapshot: undefined },
      { ticket: ticket(T1), snapshot: T1 },
      { ticket: ticket(T2), snapshot: T1 },
    ];
    const changed = cases.map((input) => (takeUpEvidenceOf(input) as Revalidation).changed);
    expect(changed).toEqual([null, false, false, true]);
  });
});

describe('recordTakeUp snapshots the marker in the run state', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(path.join(tmpdir(), 'takeup-'));
  });

  it('writes `takeUps[id]` and reads it back through readState', async () => {
    const { recordTakeUp, readState } = await loadScript('run-state.mjs');
    recordTakeUp(runDir, { id: 'AR-1', updatedAt: T1 });
    expect(readState(runDir).takeUps).toEqual({ 'AR-1': T1 });
  });

  it('keeps the first id when a second is recorded, and overwrites a re-recorded id', async () => {
    const { recordTakeUp, readState } = await loadScript('run-state.mjs');
    recordTakeUp(runDir, { id: 'AR-1', updatedAt: T1 });
    recordTakeUp(runDir, { id: 'AR-2', updatedAt: T2 });
    expect(readState(runDir).takeUps).toEqual({ 'AR-1': T1, 'AR-2': T2 });
    recordTakeUp(runDir, { id: 'AR-1', updatedAt: T2 });
    expect(readState(runDir).takeUps).toEqual({ 'AR-1': T2, 'AR-2': T2 });
  });

  it('does nothing and returns null without a run directory', async () => {
    const { recordTakeUp } = await loadScript('run-state.mjs');
    expect(recordTakeUp(undefined, { id: 'AR-1', updatedAt: T1 })).toBeNull();
    expect(recordTakeUp('', { id: 'AR-1', updatedAt: T1 })).toBeNull();
  });

  it('writes nothing when the marker is not a string', async () => {
    const { recordTakeUp, readState } = await loadScript('run-state.mjs');
    recordTakeUp(runDir, { id: 'AR-1', updatedAt: null });
    expect(existsSync(path.join(runDir, 'state.json'))).toBe(false);
    expect(readState(runDir).takeUps).toBeUndefined();
  });
});

describe('`next` revalidates through the durable claim and preserves take-up evidence', () => {
  it('first SELECT creates the baseline, snapshots the marker, and journals one detection', async () => {
    const { dir, configPath, runDir, env } = await jiraProject();
    const out = await nextJson(configPath, dir, env);
    expect(out.revalidation).toMatchObject({
      ticket: 'AR-1',
      point: 'SELECT',
      result: 'BASELINE_CREATED',
      changed: false,
      source: [],
      action: 'continue',
      task: { from: null, to: T1 },
      // AR-138: a first sight names no baseline at all — neither this run's
      // nor an earlier run's — which is what makes it a first sight.
      baseline: null,
    });
    expect((await stateOf(runDir)).takeUps).toEqual({ 'AR-1': T1 });
    const events = await revalidationEvents(runDir);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      ticket: 'AR-1',
      point: 'SELECT',
      result: 'BASELINE_CREATED',
      changed: false,
      source: [],
      action: 'continue',
      task: { from: null, to: T1 },
      baseline: null,
    });
  });

  it('a moved marker stays evidence-only while the tracked claim remains CURRENT', async () => {
    const { dir, configPath, runDir, env, setUpdated } = await jiraProject();
    await nextJson(configPath, dir, env);
    await trackClaim(dir);
    await setUpdated(T2);
    const out = await nextJson(configPath, dir, env);
    expect(out.revalidation).toMatchObject({
      result: 'CURRENT',
      changed: false,
      source: [],
      action: 'continue',
      task: { from: T1, to: T2 },
    });
    expect((await stateOf(runDir)).takeUps).toEqual({ 'AR-1': T2 });
    const events = await revalidationEvents(runDir);
    expect(events).toHaveLength(2);
    expect(events[1]!.data).toMatchObject({
      result: 'CURRENT',
      changed: false,
      source: [],
      action: 'continue',
    });
  });

  it('the same marker twice continues quietly', async () => {
    const { dir, configPath, env } = await jiraProject();
    await nextJson(configPath, dir, env);
    await trackClaim(dir);
    const out = await nextJson(configPath, dir, env);
    expect(out.revalidation).toMatchObject({
      changed: false,
      source: [],
      action: 'continue',
      task: { from: T1, to: T1 },
    });
  });

  it('text mode does not print a hold for updatedAt-only movement', async () => {
    const { dir, configPath, env, setUpdated } = await jiraProject();
    const first = await runCli(['next', '--config', configPath], dir, env);
    expect(first.code, first.out).toBe(0);
    expect(first.stdout).not.toMatch(/^revalidate:/m);
    await trackClaim(dir);

    await setUpdated(T2);
    const second = await runCli(['next', '--config', configPath], dir, env);
    expect(second.code, second.out).toBe(0);
    expect(second.stdout).not.toMatch(/^revalidate:/m);
    expect(second.stdout).not.toContain('task:updatedAt');
  });

  it('an adapter with no marker still creates an authoritative claim baseline', async () => {
    const { dir, configPath, runDir, env } = await planProject();
    const out = await nextJson(configPath, dir, env);
    expect(out.revalidation).toMatchObject({
      point: 'SELECT',
      result: 'BASELINE_CREATED',
      changed: false,
      source: [],
      action: 'continue',
      task: { from: null, to: null },
    });
    expect(await stateOf(runDir)).not.toHaveProperty('takeUps');
    const events = await revalidationEvents(runDir);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      result: 'BASELINE_CREATED',
      changed: false,
      action: 'continue',
    });
  });

  it('a run journal that predates revalidation reads the missing claim as UNVERIFIABLE', async () => {
    const { dir, configPath, runDir, env } = await jiraProject();
    // The CLI resolves `../run-journal.mjs` from its own location, so the stale
    // module has to sit in a copy of the scripts tree, not in the project.
    const scripts = await mkdtemp(path.join(tmpdir(), 'stale-journal-'));
    await cp(path.dirname(queueDir), scripts, { recursive: true });
    await writeFile(
      path.join(scripts, 'run-journal.mjs'),
      'export const recordDecision = () => ({});\nexport const isTraceExhausted = () => false;\n',
    );
    const result = await runNode(
      path.join(scripts, 'queue', 'index.mjs'),
      ['next', '--json', '--config', configPath],
      dir,
      env,
    );
    expect(result.code, result.out).toBe(2);
    expect(result.out).toMatch(/predates revalidation events/);
    expect(result.out).not.toMatch(/is not a function/);
    const parsed = JSON.parse(result.stdout) as {
      revalidation: { changed: boolean | null; result: string; action: string };
    };
    expect(parsed.revalidation).toMatchObject({
      changed: null,
      result: 'UNVERIFIABLE',
      action: 'unverifiable',
    });
    expect(await read(runDir, 'state.json')).toContain('takeUps');
  });

  it('a present but unreadable state file refuses selection before baseline creation', async () => {
    const { dir, configPath, runDir, env } = await jiraProject();
    // A directory where the file goes: the write-then-rename inside updateState
    // fails, and the journal beside it is untouched.
    await mkdir(path.join(runDir, 'state.json'));
    const result = await runCli(['next', '--json', '--config', configPath], dir, env);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/run-state-unreadable|run state is unreadable/);
    expect(result.out).not.toMatch(/run journal:/);
    const parsed = JSON.parse(result.stdout) as {
      stop: { success: boolean };
      revalidation: null;
    };
    expect(parsed.stop.success).toBe(false);
    expect(parsed.revalidation).toBeNull();
    await expect(read(runDir, 'events.jsonl')).rejects.toThrow();
  });

  it("the loop skill's outcome command records what the re-read concluded", async () => {
    // The command is run AS THE SKILL PRINTS IT, placeholders filled: a snippet
    // that drifts from the module's signature fails here, not in a run.
    const skill = await readFile(
      path.join(universal, '.claude', 'skills', 'loop', 'SKILL.md'),
      'utf8',
    );
    // AR-136: the command is `revalidate.mjs outcome`, not an inline recordEvent.
    const block = skill.match(/```bash\n([^`]*revalidate\.mjs outcome --point SELECT[^`]*)```/);
    expect(block, 'the loop skill carries no `revalidate.mjs outcome` command').not.toBeNull();
    const command = block![1]!
      .replace(/<item-id>/g, 'AR-1')
      .replace(/<true ?\| ?false>/g, 'true')
      .replace(/<[^>]*(what changed|why)[^>]*>/g, 'a late comment re-scoped it');
    expect(command, 'a placeholder the test does not know').not.toMatch(/<[^>]+>/);
    const project = await mkdtemp(path.join(tmpdir(), 'outcome-'));
    await mkdir(path.join(project, '.claude'), { recursive: true });
    await cp(scriptsDir, path.join(project, '.claude', 'scripts'), { recursive: true });
    await writeFile(
      path.join(project, '.claude', 'queue.json'),
      JSON.stringify({ adapter: 'plan-md' }),
    );
    const runDir = await mkdtemp(path.join(tmpdir(), 'run-'));
    // The event the outcome answers — its seq is what the outcome must carry.
    const { recordEvent } = (await loadScript('run-journal.mjs')) as {
      recordEvent: (input: unknown) => { seq: number };
    };
    const answered = recordEvent({
      runDir,
      kind: 'revalidation',
      data: {
        ticket: 'AR-1',
        point: 'SELECT',
        changed: true,
        source: ['task:updatedAt'],
        action: 'hold',
        task: { from: T1, to: T2 },
      },
      now: T2,
    });
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(
        'sh',
        ['-c', command],
        { cwd: project, env: { ...withoutGitLocation(), RIG_RUN_DIR: runDir } },
        (error, stdout, stderr) => resolve({ code: error ? 1 : 0, out: stdout + stderr }),
      );
    });
    expect(result.code, result.out).toBe(0);
    const events = (await readFile(path.join(runDir, 'events.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EventRecord);
    expect(events).toHaveLength(2);
    expect(events[1]!.kind).toBe('revalidation-outcome');
    expect(events[1]!.data).toMatchObject({
      ticket: 'AR-1',
      point: 'SELECT',
      actionChanged: true,
      answers: answered.seq,
    });
  });

  it('without a run directory it creates the durable baseline but no run evidence', async () => {
    const { dir, configPath, runDir, env } = await jiraProject();
    const bare = { ...env };
    delete bare['RIG_RUN_DIR'];
    const out = await nextJson(configPath, dir, bare);
    expect(out.revalidation).toMatchObject({
      result: 'BASELINE_CREATED',
      action: 'continue',
      sourcePointer: '.rig/claims/AR-1.json',
    });
    expect(existsSync(path.join(dir, '.rig', 'claims', 'AR-1.json'))).toBe(true);
    expect(existsSync(path.join(runDir, 'state.json'))).toBe(false);
    expect(existsSync(path.join(runDir, 'events.jsonl'))).toBe(false);
  });
});
