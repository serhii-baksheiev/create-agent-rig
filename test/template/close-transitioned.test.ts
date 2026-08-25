import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// AR-135 [RX3]: a close that returns `ok: true` after a POST that "succeeded" is
// a claim, not a fact — a Jira workflow can accept the transition and leave the
// issue where it was, `gh issue close` on an already-closed issue is a no-op, and
// a PLAN.md rewrite can find nothing to remove. Every adapter's `close()` reads
// the item back and reports `transitioned` from what it read, so the loop can
// refuse to publish Done on a close that did not happen.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const queueDir = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'universal',
  '.claude',
  'scripts',
  'queue',
);
const load = (file: string) => import(pathToFileURL(path.join(queueDir, file)).href);

const ticket = { id: 'ABC-13', title: 'add a route', state: 'in-progress', labels: [] };

describe('jira close proves the transition by reading the issue back', () => {
  const CREDENTIALS = {
    JIRA_BASE_URL: 'https://example.invalid',
    JIRA_EMAIL: 'a@b.c',
    JIRA_API_TOKEN: 'x',
  };

  interface Call {
    pathname: string;
    search: string;
    method: string;
  }

  const calls: Call[] = [];
  let realFetch: typeof globalThis.fetch;
  let statusAfter: { name: string; statusCategory: { key: string } };

  beforeEach(() => {
    calls.length = 0;
    realFetch = globalThis.fetch;
    // A hand-written structural stub: comment POST → 201, transition POST → 204,
    // and the read-back GET answers whatever `statusAfter` says the board did.
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const url = new URL(String(input));
      const method = String(init.method ?? 'GET');
      calls.push({ pathname: url.pathname, search: url.search, method });
      if (method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve({ fields: { status: statusAfter } }),
        });
      }
      const status = url.pathname.endsWith('/transitions') ? 204 : 201;
      return Promise.resolve({
        ok: true,
        status,
        statusText: status === 204 ? 'No Content' : 'Created',
        json: () => Promise.resolve({}),
      });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('GETs the issue status after the transition POST and reports transitioned: true when the category is done', async () => {
    statusAfter = { name: 'Done', statusCategory: { key: 'done' } };
    const { close } = await load('jira.mjs');
    const result = await close(ticket, { transitionId: '31', env: CREDENTIALS });

    expect(result).toEqual({ ok: true, transitioned: true, status: 'Done' });
    const transition = calls.findIndex(
      (c) => c.method === 'POST' && c.pathname === '/rest/api/3/issue/ABC-13/transitions',
    );
    expect(transition, JSON.stringify(calls)).toBeGreaterThan(-1);
    const readBack = calls[calls.length - 1]!;
    expect(readBack.method).toBe('GET');
    expect(readBack.pathname).toBe('/rest/api/3/issue/ABC-13');
    expect(readBack.search).toContain('fields=status');
    expect(calls.indexOf(readBack)).toBeGreaterThan(transition);
  });

  it('reports transitioned: false when the POST succeeded but the issue did not move', async () => {
    statusAfter = { name: 'In Progress', statusCategory: { key: 'indeterminate' } };
    const { close } = await load('jira.mjs');
    const result = await close(ticket, { transitionId: '31', env: CREDENTIALS });
    expect(result).toEqual({ ok: true, transitioned: false, status: 'In Progress' });
  });

  it('reports transitioned: false with no transitionId, still reading the status back', async () => {
    statusAfter = { name: 'In Progress', statusCategory: { key: 'indeterminate' } };
    const { close } = await load('jira.mjs');
    const result = await close(ticket, { env: CREDENTIALS });
    expect(result).toMatchObject({ ok: true, transitioned: false, status: 'In Progress' });
    expect(calls.some((c) => c.method === 'POST' && c.pathname.endsWith('/transitions'))).toBe(
      false,
    );
  });
});

describe('github close proves the transition by asking gh for the state', () => {
  let original: string | undefined;
  let bin: string;
  let logFile: string;

  /** A `gh` on PATH that logs its argv one call per line and answers `issue view`. */
  const installGh = async (state: 'CLOSED' | 'OPEN'): Promise<void> => {
    bin = await mkdtemp(path.join(tmpdir(), 'stub-gh-'));
    logFile = path.join(bin, 'calls.log');
    await writeFile(
      path.join(bin, 'gh'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> "${logFile}"`,
        'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
        `  printf '{"state":"${state}"}\\n'`,
        'fi',
        'exit 0',
        '',
      ].join('\n'),
    );
    await chmod(path.join(bin, 'gh'), 0o755);
    original = process.env['PATH'];
    process.env['PATH'] = `${bin}${path.delimiter}${original ?? ''}`;
  };

  afterEach(() => {
    if (original === undefined) delete process.env['PATH'];
    else process.env['PATH'] = original;
  });

  const argvLog = async (): Promise<string[]> =>
    (await readFile(logFile, 'utf8')).split('\n').filter(Boolean);

  it('runs `issue view <id> --json state` after `issue close` and reports transitioned: true on CLOSED', async () => {
    await installGh('CLOSED');
    const { close } = await load('github-issues.mjs');
    const result = close({ id: '13' }, { prUrl: 'https://example.invalid/pr/1' });
    expect(result).toMatchObject({ ok: true, transitioned: true });
    const log = await argvLog();
    const closeAt = log.findIndex((line) => line.startsWith('issue close 13'));
    const viewAt = log.findIndex((line) => line.startsWith('issue view 13'));
    expect(closeAt, log.join('\n')).toBeGreaterThan(-1);
    expect(viewAt, log.join('\n')).toBeGreaterThan(closeAt);
    expect(log[viewAt]).toContain('--json state');
  });

  it('reports transitioned: false when gh still sees the issue OPEN', async () => {
    await installGh('OPEN');
    const { close } = await load('github-issues.mjs');
    const result = close({ id: '13' });
    expect(result).toMatchObject({ ok: true, transitioned: false });
  });
});

describe('plan-md close proves the transition by re-parsing the plan', () => {
  const PLAN = [
    '# P',
    '',
    '## Agent queue',
    '',
    '- keep me',
    '- remove me',
    '',
    '## Journal',
    '',
  ].join('\n');

  const planFile = async (): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'close-plan-'));
    const planPath = path.join(dir, 'PLAN.md');
    await writeFile(planPath, PLAN);
    return planPath;
  };

  it('reports transitioned: true once the item’s line is gone', async () => {
    const planPath = await planFile();
    const { close } = await load('plan-md.mjs');
    const result = close({ id: '2' }, { planPath });
    expect(result).toMatchObject({ ok: true, transitioned: true });
    expect(await readFile(planPath, 'utf8')).not.toContain('- remove me');
  });

  it('reports transitioned: false for an id the plan does not carry', async () => {
    const planPath = await planFile();
    const { close } = await load('plan-md.mjs');
    const result = close({ id: '9' }, { planPath });
    expect(result).toMatchObject({ ok: true, transitioned: false });
    expect(await readFile(planPath, 'utf8')).toBe(PLAN);
  });
});
