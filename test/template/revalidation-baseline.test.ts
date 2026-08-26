import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * AR-138 — the take-up baseline crosses runs, and a proposal's baseline is the
 * marker it had when the loop filed it.
 *
 * Measured (RX1): SELECT compared only against a take-up recorded in the same
 * run, so an item taken up by yesterday's run and re-offered today reported
 * `changed: false` with `from: null` — a first sight — however far its marker
 * had moved; and a proposal the loop itself filed had no baseline at all.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const queueDir = path.join(scriptsDir, 'queue');
const load = (file: string) => import(pathToFileURL(path.join(scriptsDir, file)).href);
const loadQueue = (file: string) => import(pathToFileURL(path.join(queueDir, file)).href);

const T1 = '2026-08-24T10:00:00.000Z';
const T2 = '2026-08-25T10:00:00.000Z';

const jiraIssue = (updated: string) => ({
  key: 'AR-1',
  self: 'https://example.invalid/AR-1',
  fields: {
    summary: 'add a route',
    labels: [],
    status: { name: 'To Do', statusCategory: { key: 'new' } },
    priority: { name: 'Medium' },
    created: '2026-07-01T00:00:00.000+0000',
    updated,
    issuelinks: [],
  },
});

/** A runs root with N earlier run directories, each holding the state given. */
const runsRoot = async (
  previous: Array<Record<string, unknown> | 'unreadable'>,
): Promise<{ root: string; runDir: string; dirs: string[] }> => {
  const root = await mkdtemp(path.join(tmpdir(), 'runs-'));
  const dirs: string[] = [];
  for (const [i, state] of previous.entries()) {
    const dir = path.join(root, `20260820-00000${i}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'state.json'),
      state === 'unreadable' ? '{ not json' : JSON.stringify(state),
    );
    dirs.push(dir);
  }
  const runDir = path.join(root, '20260826-120000');
  await mkdir(runDir, { recursive: true });
  return { root, runDir, dirs };
};

describe('the take-up baseline reaches back into earlier runs', () => {
  it('finds the newest earlier run that took the item up, and names that run', async () => {
    const { previousTakeUp } = await load('run-state.mjs');
    const { runDir, dirs } = await runsRoot([
      { takeUps: { 'AR-1': T1 } },
      { takeUps: { 'AR-1': T2, 'AR-2': T1 } },
      { takeUps: { 'AR-2': T2 } },
    ]);
    expect(previousTakeUp(runDir, 'AR-1')).toEqual({ updatedAt: T2, runDir: dirs[1] });
    expect(previousTakeUp(runDir, 'AR-2')).toEqual({ updatedAt: T2, runDir: dirs[2] });
  });

  it('never reads its own run, and answers null when no earlier run took the item up', async () => {
    const { previousTakeUp, recordTakeUp } = await load('run-state.mjs');
    const { runDir } = await runsRoot([{ takeUps: { 'AR-2': T1 } }]);
    recordTakeUp(runDir, { id: 'AR-1', updatedAt: T2 });
    expect(previousTakeUp(runDir, 'AR-1')).toBeNull();
  });

  it('skips an earlier run whose state cannot be read, and reads the one behind it', async () => {
    const { previousTakeUp } = await load('run-state.mjs');
    const { runDir, dirs } = await runsRoot([{ takeUps: { 'AR-1': T1 } }, 'unreadable']);
    expect(previousTakeUp(runDir, 'AR-1')).toEqual({ updatedAt: T1, runDir: dirs[0] });
  });

  it('answers null with no run directory, and null when the runs root does not exist', async () => {
    const { previousTakeUp } = await load('run-state.mjs');
    expect(previousTakeUp(undefined, 'AR-1')).toBeNull();
    expect(previousTakeUp('', 'AR-1')).toBeNull();
    expect(previousTakeUp(path.join(tmpdir(), 'no-such-runs-root', 'run'), 'AR-1')).toBeNull();
  });
});

describe('selection compares against the earlier run when this run has no take-up yet', () => {
  const nextJson = async (updated: string, previous: Record<string, unknown>[]) => {
    const { withoutGitLocation } = await load('git-env.mjs');
    const dir = await mkdtemp(path.join(tmpdir(), 'baseline-'));
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    const configPath = path.join(dir, '.claude', 'queue.json');
    await writeFile(
      configPath,
      JSON.stringify({ adapter: 'jira', options: { project: 'AR', issues: [jiraIssue(updated)] } }),
    );
    const { runDir, dirs } = await runsRoot(previous);
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
      execFile(
        process.execPath,
        [path.join(queueDir, 'index.mjs'), 'next', '--config', configPath, '--json'],
        { cwd: dir, env: { ...withoutGitLocation(), RIG_RUN_DIR: runDir } },
        (e, out, err) =>
          resolve({ code: e && typeof e.code === 'number' ? e.code : 0, stdout: out, stderr: err }),
      ),
    );
    expect(result.code, result.stderr).toBe(0);
    const events = (await readFile(path.join(runDir, 'events.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((e) => e.kind === 'revalidation');
    return { json: JSON.parse(result.stdout), event: events[0]?.data, dirs };
  };

  it('holds when the marker moved past the earlier run’s take-up, and names that baseline', async () => {
    const { json, event, dirs } = await nextJson(T2, [{ takeUps: { 'AR-1': T1 } }]);
    expect(json.revalidation).toMatchObject({
      changed: true,
      action: 'hold',
      task: { from: T1, to: T2 },
      baseline: 'previous-run',
    });
    expect(event).toMatchObject({ changed: true, baseline: 'previous-run', baselineRun: dirs[0] });
  });

  it('continues when the marker is where the earlier run left it', async () => {
    const { json } = await nextJson(T2, [{ takeUps: { 'AR-1': T2 } }]);
    expect(json.revalidation).toMatchObject({
      changed: false,
      action: 'continue',
      baseline: 'previous-run',
    });
  });

  it('is a first sight — baseline null, changed false — only when no run ever took it up', async () => {
    const { json } = await nextJson(T2, []);
    expect(json.revalidation).toMatchObject({
      changed: false,
      task: { from: null, to: T2 },
      baseline: null,
    });
  });
});

describe('a proposal the loop files carries its own baseline', () => {
  // Shape only — assembled here so no credential-looking value sits in the tree.
  const CREDENTIALS = {
    JIRA_BASE_URL: 'https://example.invalid',
    JIRA_EMAIL: 'a@b.c',
    JIRA_API_TOKEN: 'x',
  };
  let realFetch: typeof globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];

  beforeEach(() => {
    calls.length = 0;
    realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string, init: { method?: string } = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      calls.push({ url, method });
      const body =
        method === 'POST' && url.endsWith('/rest/api/3/issue')
          ? { key: 'AR-9' }
          : url.includes('/rest/api/3/issue/AR-9')
            ? { key: 'AR-9', fields: { updated: '2026-08-26T09:00:00.000+0000' } }
            : { issues: [] };
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(body),
      });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const proposal = {
    finding: 'journal line',
    part: 'skill',
    change: 'a change',
    proof: 'an observation',
    asOf: null,
  };

  it('jira records the filed item’s marker as a take-up in the declared run', async () => {
    const { proposeTriage } = await loadQueue('jira.mjs');
    const { readState } = await load('run-state.mjs');
    const runDir = await mkdtemp(path.join(tmpdir(), 'run-'));
    const result = await proposeTriage(proposal, {
      project: 'AR',
      env: { ...CREDENTIALS, RIG_RUN_DIR: runDir },
    });
    expect(result).toMatchObject({ ok: true, id: 'AR-9' });
    expect(readState(runDir).takeUps).toEqual({ 'AR-9': '2026-08-26T09:00:00.000Z' });
    expect(calls.some((c) => c.method === 'GET' && c.url.includes('/issue/AR-9'))).toBe(true);
  });

  it('jira files without a run directory and records nothing, rather than refusing to file', async () => {
    const { proposeTriage } = await loadQueue('jira.mjs');
    const result = await proposeTriage(proposal, { project: 'AR', env: { ...CREDENTIALS } });
    expect(result).toMatchObject({ ok: true, id: 'AR-9' });
  });
});
