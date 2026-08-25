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

  it('leaves the in-progress label on an issue whose close did not land', async () => {
    await installGh('OPEN');
    const { close } = await load('github-issues.mjs');
    close({ id: '13' });
    const log = await argvLog();
    expect(log.some((line) => line.includes('--remove-label'))).toBe(false);
  });

  it('removes the in-progress label only after the read-back says CLOSED', async () => {
    await installGh('CLOSED');
    const { close } = await load('github-issues.mjs');
    close({ id: '13' });
    const log = await argvLog();
    const viewAt = log.findIndex((line) => line.startsWith('issue view 13'));
    const labelAt = log.findIndex((line) => line.includes('--remove-label in-progress'));
    expect(labelAt, log.join('\n')).toBeGreaterThan(viewAt);
  });
});

// The close point must see an item somebody already closed, which is exactly
// the item `listEligible` drops for selection's sake — so the contract carries
// `find`, and each adapter decides how to reach past its own filter.
describe('find: one item by id, closed included', () => {
  it('is part of the adapter contract, so a fourth adapter cannot forget it', async () => {
    const { ADAPTER_CONTRACT } = await load('core.mjs');
    expect(ADAPTER_CONTRACT).toContain('find');
  });

  it('jira maps a done issue to a closed ticket through the offline seam', async () => {
    const { find } = await load('jira.mjs');
    const issues = [
      {
        key: 'ABC-13',
        fields: {
          summary: 's',
          status: { name: 'Done', statusCategory: { key: 'done' } },
          labels: [],
          created: '2026-07-01T00:00:00.000+0000',
          updated: '2026-07-02T00:00:00.000+0000',
          issuelinks: [],
        },
      },
    ];
    const found = await find('ABC-13', { issues });
    expect(found).toMatchObject({
      id: 'ABC-13',
      state: 'closed',
      updatedAt: '2026-07-02T00:00:00.000Z',
    });
    expect(await find('ABC-99', { issues })).toBeNull();
  });

  it('github asks `gh issue view` with the full field list and maps CLOSED to closed', async () => {
    const bin = await mkdtemp(path.join(tmpdir(), 'stub-gh-find-'));
    const logFile = path.join(bin, 'calls.log');
    await writeFile(
      path.join(bin, 'gh'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> "${logFile}"`,
        `printf '%s\\n' '{"number":13,"title":"t","body":"","state":"CLOSED","labels":[],"url":null,"createdAt":null,"updatedAt":"2026-07-02T00:00:00Z"}'`,
        'exit 0',
        '',
      ].join('\n'),
    );
    await chmod(path.join(bin, 'gh'), 0o755);
    const original = process.env['PATH'];
    process.env['PATH'] = `${bin}${path.delimiter}${original ?? ''}`;
    try {
      const { find } = await load('github-issues.mjs');
      const found = find('13');
      expect(found).toMatchObject({ id: '13', state: 'closed', updatedAt: '2026-07-02T00:00:00Z' });
      const log = (await readFile(logFile, 'utf8')).split('\n').filter(Boolean);
      expect(log[0]).toMatch(/^issue view 13 --json .*updatedAt/);
      // and the offline seam, which needs no gh at all
      expect(
        find('7', { issues: [{ number: 7, title: 'x', state: 'OPEN', labels: [] }] }),
      ).toMatchObject({
        id: '7',
        state: 'open',
      });
      expect(find('8', { issues: [] })).toBeNull();
    } finally {
      if (original === undefined) delete process.env['PATH'];
      else process.env['PATH'] = original;
    }
  });

  it('plan-md finds a line by position and answers null for one that is not there', async () => {
    const { find } = await load('plan-md.mjs');
    const dir = await mkdtemp(path.join(tmpdir(), 'plan-find-'));
    const planPath = path.join(dir, 'PLAN.md');
    await writeFile(planPath, '# P\n\n## Agent queue\n\n- keep me\n\n## Journal\n');
    expect(find('1', { planPath })).toMatchObject({ id: '1', title: 'keep me', state: 'open' });
    expect(find('2', { planPath })).toBeNull();
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
