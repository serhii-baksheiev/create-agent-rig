import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stubCommand } from '../helpers/stub-command.js';

/**
 * AR-138 compatibility evidence crosses runs, while RP-50 makes the durable
 * claim fingerprint the only decision baseline.
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

/** Every temp tree this file creates, removed at the end so none of them is a candidate baseline for a later run of the suite. */
const created: string[] = [];
const scratch = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  created.push(dir);
  return dir;
};
afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A runs root with N earlier run directories, each holding the state given. */
const runsRoot = async (
  previous: Array<Record<string, unknown> | 'unreadable'>,
): Promise<{ root: string; runDir: string; dirs: string[] }> => {
  const root = await scratch('runs-');
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

  it('reads only siblings named like a run, so a scratch directory beside the run is not yesterday', async () => {
    // CI measured this: under a shared temp root, a neighbouring test's
    // `takeup-*` directory carrying a state.json was read as an earlier run.
    const { previousTakeUp } = await load('run-state.mjs');
    const { root, runDir } = await runsRoot([]);
    const stray = path.join(root, 'takeup-abc123');
    await mkdir(stray, { recursive: true });
    await writeFile(path.join(stray, 'state.json'), JSON.stringify({ takeUps: { 'AR-1': T1 } }));
    expect(previousTakeUp(runDir, 'AR-1')).toBeNull();
  });

  it('a run declared under another naming looks at no siblings at all', async () => {
    // Measured locally: a temp root of 454 000 entries cost every SELECT a
    // 540 ms directory read for a question it could not answer.
    const { previousTakeUp } = await load('run-state.mjs');
    const { root } = await runsRoot([{ takeUps: { 'AR-1': T1 } }]);
    const unnamed = path.join(root, 'run-abc123');
    await mkdir(unnamed, { recursive: true });
    expect(previousTakeUp(unnamed, 'AR-1')).toBeNull();
  });

  it('answers null with no run directory, and null when the runs root does not exist', async () => {
    const { previousTakeUp } = await load('run-state.mjs');
    expect(previousTakeUp(undefined, 'AR-1')).toBeNull();
    expect(previousTakeUp('', 'AR-1')).toBeNull();
    expect(previousTakeUp(path.join(tmpdir(), 'no-such-runs-root', 'run'), 'AR-1')).toBeNull();
  });
});

describe('selection preserves earlier-run take-up evidence without using it as authority', () => {
  const nextJson = async (updated: string, previous: Record<string, unknown>[]) => {
    const { withoutGitLocation } = await load('git-env.mjs');
    const dir = await scratch('baseline-');
    await mkdir(path.join(dir, '.claude'), { recursive: true });
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
    for (const args of [
      ['init', '-q', '-b', 'master'],
      ['add', '.rig/revalidation.json'],
      ['commit', '-q', '-m', 'seed contract'],
    ]) {
      await new Promise<void>((resolve, reject) =>
        execFile(
          'git',
          ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
          { cwd: dir, env: withoutGitLocation() },
          (error) => (error ? reject(error) : resolve()),
        ),
      );
    }
    const configPath = path.join(dir, '.claude', 'queue.json');
    await writeFile(
      configPath,
      JSON.stringify({ adapter: 'jira', options: { project: 'AR', issues: [jiraIssue(updated)] } }),
    );
    const { runDir, dirs } = await runsRoot(previous);
    for (const [index, state] of previous.entries()) {
      const takeUps = state.takeUps;
      const selectedAt =
        typeof takeUps === 'object' && takeUps !== null
          ? (takeUps as Record<string, unknown>)['AR-1']
          : null;
      if (typeof selectedAt !== 'string') continue;
      await writeFile(
        path.join(dirs[index]!, 'events.jsonl'),
        `${JSON.stringify({
          seq: 1,
          at: selectedAt,
          kind: 'revalidation',
          data: {
            schemaVersion: 1,
            id: `prior-select-${index}`,
            ticket: 'AR-1',
            point: 'SELECT',
            checkpoint: 'SELECT',
            result: 'BASELINE_CREATED',
            changed: false,
            source: [],
            action: 'continue',
            movedFingerprintSet: [],
            sourcePointer: '.rig/claims/AR-1.json',
          },
        })}\n`,
      );
    }
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
      execFile(
        process.execPath,
        [path.join(queueDir, 'index.mjs'), 'next', '--config', configPath, '--json'],
        { cwd: dir, env: { ...withoutGitLocation(), RIG_RUN_DIR: runDir } },
        (e, out, err) =>
          resolve({ code: e && typeof e.code === 'number' ? e.code : 0, stdout: out, stderr: err }),
      ),
    );
    const events = (await readFile(path.join(runDir, 'events.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((e) => e.kind === 'revalidation');
    return { code: result.code, json: JSON.parse(result.stdout), event: events[0]?.data, dirs };
  };

  it('refuses a missing claim on resume while naming the moved compatibility marker', async () => {
    const { code, json, event, dirs } = await nextJson(T2, [{ takeUps: { 'AR-1': T1 } }]);
    expect(code).toBe(2);
    expect(json.revalidation).toMatchObject({
      result: 'UNVERIFIABLE',
      changed: null,
      action: 'unverifiable',
      task: { from: T1, to: T2 },
      baseline: 'previous-run',
    });
    expect(event).toMatchObject({
      result: 'UNVERIFIABLE',
      changed: null,
      baseline: 'previous-run',
      baselineRun: dirs[0],
    });
  });

  it('still refuses a missing claim when the compatibility marker did not move', async () => {
    const { code, json } = await nextJson(T2, [{ takeUps: { 'AR-1': T2 } }]);
    expect(code).toBe(2);
    expect(json.revalidation).toMatchObject({
      changed: null,
      action: 'unverifiable',
      result: 'UNVERIFIABLE',
      baseline: 'previous-run',
    });
  });

  it('is a first sight — baseline null, changed false — only when no prior SELECT exists', async () => {
    const { code, json } = await nextJson(T2, []);
    expect(code).toBe(0);
    expect(json.revalidation).toMatchObject({
      changed: false,
      result: 'BASELINE_CREATED',
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
    const runDir = await scratch('run-');
    const result = await proposeTriage(proposal, {
      project: 'AR',
      env: { ...CREDENTIALS, RIG_RUN_DIR: runDir },
    });
    expect(result).toMatchObject({ ok: true, id: 'AR-9' });
    expect(readState(runDir).takeUps).toEqual({ 'AR-9': '2026-08-26T09:00:00.000Z' });
    expect(calls.some((c) => c.method === 'GET' && c.url.includes('/issue/AR-9'))).toBe(true);
  });

  const captureStderr = async <T>(
    body: () => Promise<T>,
  ): Promise<{ result: T; stderr: string }> => {
    const chunks: string[] = [];
    const real = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      return { result: await body(), stderr: chunks.join('') };
    } finally {
      process.stderr.write = real;
    }
  };

  it('jira stays filed when the run directory is stale — announced, never thrown', async () => {
    const { proposeTriage } = await loadQueue('jira.mjs');
    const stale = path.join(tmpdir(), 'run-dir-that-was-never-created');
    const { result, stderr } = await captureStderr(() =>
      proposeTriage(proposal, { project: 'AR', env: { ...CREDENTIALS, RIG_RUN_DIR: stale } }),
    );
    expect(result).toMatchObject({ ok: true, id: 'AR-9' });
    expect(stderr).toMatch(/AR-9 is filed, but its baseline was NOT recorded/);
  });

  it('jira stays filed when the read-back fails — announced, never thrown', async () => {
    const { proposeTriage } = await loadQueue('jira.mjs');
    const runDir = await scratch('run-');
    const stubbed = globalThis.fetch;
    globalThis.fetch = ((input: string, init: { method?: string } = {}) =>
      (init.method ?? 'GET') === 'GET' && String(input).includes('/issue/AR-9')
        ? Promise.resolve({
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
            json: () => Promise.resolve({}),
          })
        : stubbed(input, init)) as unknown as typeof globalThis.fetch;
    const { result, stderr } = await captureStderr(() =>
      proposeTriage(proposal, { project: 'AR', env: { ...CREDENTIALS, RIG_RUN_DIR: runDir } }),
    );
    expect(result).toMatchObject({ ok: true, id: 'AR-9' });
    expect(stderr).toMatch(/NOT recorded .*503/);
  });

  it('jira files without a run directory and records nothing, rather than refusing to file', async () => {
    const { proposeTriage } = await loadQueue('jira.mjs');
    const result = await proposeTriage(proposal, { project: 'AR', env: { ...CREDENTIALS } });
    expect(result).toMatchObject({ ok: true, id: 'AR-9' });
  });
});

describe('github-issues records the filed proposal’s marker through gh', () => {
  /**
   * A `gh` on PATH that answers the two calls `proposeTriage` makes after the
   * dedupe listing: `issue create` prints the new URL, `issue view --json
   * updatedAt` prints the marker; `issue list` prints an empty list.
   */
  const withStubGh = async <T>(body: () => Promise<T>): Promise<T> => {
    const stub = await stubCommand(
      'gh',
      `if (args[0] === 'issue' && args[1] === 'list') return { stdout: '[]\\n' };
       if (args[0] === 'issue' && args[1] === 'create') return { stdout: 'https://example.invalid/o/r/issues/42\\n' };
       if (args[0] === 'issue' && args[1] === 'view') return { stdout: '{"updatedAt":"2026-08-26T09:00:00Z"}\\n' };
       return { exitCode: 1 };`,
    );
    try {
      return await body();
    } finally {
      stub.restore();
    }
  };

  const withRunDir = async <T>(runDir: string | undefined, body: () => Promise<T>): Promise<T> => {
    const saved = process.env['RIG_RUN_DIR'];
    if (runDir === undefined) delete process.env['RIG_RUN_DIR'];
    else process.env['RIG_RUN_DIR'] = runDir;
    try {
      return await body();
    } finally {
      if (saved === undefined) delete process.env['RIG_RUN_DIR'];
      else process.env['RIG_RUN_DIR'] = saved;
    }
  };

  const proposal = {
    finding: 'journal line',
    part: 'skill',
    change: 'a change',
    proof: 'an observation',
    asOf: null,
  };

  it('records the new issue’s updatedAt as a take-up in the declared run, keyed by its number', async () => {
    const { proposeTriage } = await loadQueue('github-issues.mjs');
    const { readState } = await load('run-state.mjs');
    const runDir = await scratch('run-');
    const result = await withStubGh(() => withRunDir(runDir, async () => proposeTriage(proposal)));
    expect(result).toMatchObject({ ok: true, id: '42' });
    expect(readState(runDir).takeUps).toEqual({ '42': '2026-08-26T09:00:00Z' });
  });

  it('stays filed when the run directory is stale — announced, never thrown', async () => {
    const { proposeTriage } = await loadQueue('github-issues.mjs');
    const stale = path.join(tmpdir(), 'run-dir-that-was-never-created');
    const chunks: string[] = [];
    const real = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let result: unknown;
    try {
      result = await withStubGh(() => withRunDir(stale, async () => proposeTriage(proposal)));
    } finally {
      process.stderr.write = real;
    }
    expect(result).toMatchObject({ ok: true, id: '42' });
    expect(chunks.join('')).toMatch(/#42 is filed, but its baseline was NOT recorded/);
  });
});
