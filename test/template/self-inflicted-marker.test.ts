import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * AR-140 — the adapter records the marker its own write produced, so a
 * self-inflicted move is not a catch.
 *
 * Measured (RX3/RX4): every BEFORE_PR catch of one run — 3 of 3 — was a hold
 * on `task:updatedAt` moved by the run's own comments on the item; the same
 * again on every BEFORE_CLOSE of the run after it. A tracker adapter now reads
 * the marker back after each write it makes (claim, comment, close, escalate)
 * and records it as the take-up, so the next comparison starts from there.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const queueDir = path.join(scriptsDir, 'queue');
const load = (file: string) => import(pathToFileURL(path.join(scriptsDir, file)).href);
const loadQueue = (file: string) => import(pathToFileURL(path.join(queueDir, file)).href);

const T1 = '2026-08-24T10:00:00.000Z';
const T2 = '2026-08-25T10:00:00.000Z';
const T3 = '2026-08-26T10:00:00.000Z';

const created: string[] = [];
const scratch = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  created.push(dir);
  return dir;
};
afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

const captureStderr = async <T>(body: () => Promise<T>): Promise<{ result: T; stderr: string }> => {
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

describe('jira re-records the marker after each write of its own', () => {
  // Shape only — assembled here so no credential-looking value sits in the tree.
  const CREDENTIALS = {
    JIRA_BASE_URL: 'https://example.invalid',
    JIRA_EMAIL: 'a@b.c',
    JIRA_API_TOKEN: 'x',
  };
  let realFetch: typeof globalThis.fetch;
  /** The marker the stub reports; a write moves it, as the tracker would. */
  let updated = '2026-08-25T10:00:00.000+0000';

  beforeEach(() => {
    updated = '2026-08-25T10:00:00.000+0000';
    realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string, init: { method?: string } = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      if (method !== 'GET') updated = '2026-08-26T10:00:00.000+0000';
      const body = url.endsWith('/transitions')
        ? {
            transitions: [
              { id: '31', to: { statusCategory: { key: 'indeterminate' } } },
              { id: '41', to: { statusCategory: { key: 'done' } } },
            ],
          }
        : url.includes('/issue/AR-1')
          ? { key: 'AR-1', fields: { updated, status: { statusCategory: { key: 'done' } } } }
          : {};
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

  const ticket = { id: 'AR-1', title: 't' };

  it.each(['claim', 'comment', 'close', 'escalate'])(
    '%s leaves the take-up at the marker the write produced',
    async (op) => {
      const adapter = await loadQueue('jira.mjs');
      const { readState, recordTakeUp } = await load('run-state.mjs');
      const runDir = await scratch('run-');
      recordTakeUp(runDir, { id: 'AR-1', updatedAt: T1 });
      const env = { ...CREDENTIALS, RIG_RUN_DIR: runDir };
      if (op === 'claim') await adapter.claim(ticket, { env });
      if (op === 'comment') await adapter.comment(ticket, 'a note', { env });
      if (op === 'close')
        await adapter.close(ticket, { prUrl: 'https://x/1', transitionId: '41', env });
      if (op === 'escalate') await adapter.escalate(ticket, 'a diagnosis', { env });
      expect(readState(runDir).takeUps).toEqual({ 'AR-1': T3 });
    },
  );

  it('records nothing without a run directory, and the write still succeeds', async () => {
    const adapter = await loadQueue('jira.mjs');
    expect(await adapter.comment(ticket, 'a note', { env: { ...CREDENTIALS } })).toEqual({
      ok: true,
    });
  });

  it.each(['claim', 'comment', 'close', 'escalate'])(
    '%s on a stale run directory is announced, never thrown, and the write still succeeds',
    async (op) => {
      // Round 2 of AR-140 measured why every write needs this: close wrote its
      // marker outside the announce path once, and threw after the transition.
      const adapter = await loadQueue('jira.mjs');
      const stale = path.join(tmpdir(), 'run-dir-that-was-never-created');
      const env = { ...CREDENTIALS, RIG_RUN_DIR: stale };
      const { result, stderr } = await captureStderr(async () => {
        if (op === 'claim') return adapter.claim(ticket, { env });
        if (op === 'comment') return adapter.comment(ticket, 'a note', { env });
        if (op === 'close')
          return adapter.close(ticket, { prUrl: 'https://x/1', transitionId: '41', env });
        return adapter.escalate(ticket, 'a diagnosis', { env });
      });
      expect(result).toMatchObject({ ok: true });
      expect(stderr).toMatch(/AR-1.*marker was NOT re-recorded/);
    },
  );
});

describe('github-issues re-records the marker after each write of its own', () => {
  const withStubGh = async <T>(body: () => Promise<T>): Promise<T> => {
    const bin = await realpath(await scratch('stub-gh-'));
    // `issue view` answers the marker; `--json state` (close's read-back) gets
    // both fields, which is what the adapter asks for.
    await writeFile(
      path.join(bin, 'gh'),
      [
        '#!/bin/sh',
        'case "$1 $2" in',
        '  "issue view") echo \'{"state":"CLOSED","updatedAt":"2026-08-26T10:00:00Z"}\' ;;',
        '  *) exit 0 ;;',
        'esac',
        '',
      ].join('\n'),
    );
    await chmod(path.join(bin, 'gh'), 0o755);
    const savedPath = process.env['PATH'];
    process.env['PATH'] = `${bin}${path.delimiter}${savedPath ?? ''}`;
    try {
      return await body();
    } finally {
      process.env['PATH'] = savedPath;
    }
  };
  const withRunDir = async <T>(runDir: string, body: () => Promise<T>): Promise<T> => {
    const saved = process.env['RIG_RUN_DIR'];
    process.env['RIG_RUN_DIR'] = runDir;
    try {
      return await body();
    } finally {
      if (saved === undefined) delete process.env['RIG_RUN_DIR'];
      else process.env['RIG_RUN_DIR'] = saved;
    }
  };
  const ticket = { id: '7', title: 't' };

  it.each(['claim', 'comment', 'close', 'escalate'])(
    '%s leaves the take-up at the marker the write produced',
    async (op) => {
      const adapter = await loadQueue('github-issues.mjs');
      const { readState, recordTakeUp } = await load('run-state.mjs');
      const runDir = await scratch('run-');
      recordTakeUp(runDir, { id: '7', updatedAt: T1 });
      await withStubGh(() =>
        withRunDir(runDir, async () => {
          if (op === 'claim') adapter.claim(ticket);
          if (op === 'comment') adapter.comment(ticket, 'a note');
          if (op === 'close') adapter.close(ticket, { prUrl: 'https://x/1' });
          if (op === 'escalate') adapter.escalate(ticket, 'a diagnosis');
        }),
      );
      expect(readState(runDir).takeUps).toEqual({ '7': '2026-08-26T10:00:00Z' });
    },
  );
});

describe('BEFORE_CLOSE compares against the newest baseline the run holds', () => {
  const jiraIssue = (updated: string) => ({
    key: 'AR-1',
    self: 'https://example.invalid/AR-1',
    fields: {
      summary: 'add a route',
      labels: [],
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      priority: { name: 'Medium' },
      created: '2026-07-01T00:00:00.000+0000',
      updated,
      issuelinks: [],
    },
  });

  const run = async (opts: { updated: string; takeUp: string; lastValidation: string }) => {
    const { withoutGitLocation } = await load('git-env.mjs');
    const { recordTakeUp } = await load('run-state.mjs');
    const journal = await load('run-journal.mjs');
    const dir = await scratch('close-');
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    const configPath = path.join(dir, '.claude', 'queue.json');
    await writeFile(
      configPath,
      JSON.stringify({
        adapter: 'jira',
        options: { project: 'AR', issues: [jiraIssue(opts.updated)] },
      }),
    );
    const runDir = await scratch('run-');
    journal.recordEvent({
      runDir,
      kind: 'revalidation',
      data: {
        ticket: 'AR-1',
        point: 'BEFORE_PR',
        changed: false,
        source: [],
        action: 'continue',
        task: { from: T1, to: opts.lastValidation },
      },
      now: '2026-08-26T00:00:00.000Z',
    });
    recordTakeUp(runDir, { id: 'AR-1', updatedAt: opts.takeUp });
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
      execFile(
        process.execPath,
        [
          path.join(scriptsDir, 'revalidate.mjs'),
          '--point',
          'BEFORE_CLOSE',
          '--ticket',
          'AR-1',
          '--config',
          configPath,
          '--json',
        ],
        { cwd: dir, env: { ...withoutGitLocation(), RIG_RUN_DIR: runDir } },
        (e, out, err) =>
          resolve({ code: e && typeof e.code === 'number' ? e.code : 0, stdout: out, stderr: err }),
      ),
    );
  };

  it('continues when the run’s own write moved the marker after the last validation', async () => {
    const { code, stdout } = await run({ updated: T2, lastValidation: T1, takeUp: T2 });
    expect(code, stdout).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ action: 'continue', task: { from: T2, to: T2 } });
  });

  it('continues when the last validation is newer than the take-up', async () => {
    const { code, stdout } = await run({ updated: T2, lastValidation: T2, takeUp: T1 });
    expect(code, stdout).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ action: 'continue', task: { from: T2 } });
  });

  it('still holds when the marker moved past both', async () => {
    const { code, stdout } = await run({ updated: T3, lastValidation: T1, takeUp: T2 });
    expect(code).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({ action: 'hold', task: { from: T2, to: T3 } });
  });
});
