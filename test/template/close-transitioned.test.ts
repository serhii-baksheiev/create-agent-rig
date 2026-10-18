import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stubCommand, type StubHandle } from '../helpers/stub-command.js';

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
  let availableTransitions: unknown;
  let unreadableReadBack = false;
  let rejectTransition = false;
  let rejectDiscovery = false;
  let unreadableDiscovery = false;
  let rejectComment = false;

  beforeEach(() => {
    calls.length = 0;
    realFetch = globalThis.fetch;
    // A hand-written structural stub: comment POST → 201, transition POST → 204,
    // and the read-back GET answers whatever `statusAfter` says the board did.
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const url = new URL(String(input));
      const method = String(init.method ?? 'GET');
      calls.push({ pathname: url.pathname, search: url.search, method });
      if (method === 'GET' && url.pathname.endsWith('/transitions')) {
        return Promise.resolve({
          ok: !rejectDiscovery && !unreadableDiscovery,
          status: rejectDiscovery ? 403 : unreadableDiscovery ? 503 : 200,
          statusText: rejectDiscovery
            ? 'Forbidden'
            : unreadableDiscovery
              ? 'Service Unavailable'
              : 'OK',
          json: () => Promise.resolve({ transitions: availableTransitions }),
        });
      }
      if (method === 'GET') {
        return Promise.resolve({
          ok: !unreadableReadBack,
          status: unreadableReadBack ? 503 : 200,
          statusText: unreadableReadBack ? 'Service Unavailable' : 'OK',
          json: () => Promise.resolve({ fields: { status: statusAfter } }),
        });
      }
      if (method === 'POST' && url.pathname.endsWith('/transitions') && rejectTransition) {
        return Promise.resolve({
          ok: false,
          status: 409,
          statusText: 'Conflict',
          json: () => Promise.resolve({}),
        });
      }
      if (method === 'POST' && url.pathname.endsWith('/comment') && rejectComment) {
        return Promise.resolve({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          json: () => Promise.resolve({}),
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
    availableTransitions = [{ id: '31', to: { name: 'Done', statusCategory: { key: 'done' } } }];
    rejectTransition = false;
    unreadableReadBack = false;
    rejectDiscovery = false;
    unreadableDiscovery = false;
    rejectComment = false;
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
    const readBackAt = calls.findIndex(
      (c) => c.method === 'GET' && c.pathname === '/rest/api/3/issue/ABC-13',
    );
    const readBack = calls[readBackAt]!;
    expect(readBack.method).toBe('GET');
    expect(readBack.pathname).toBe('/rest/api/3/issue/ABC-13');
    expect(readBack.search).toContain('fields=status');
    const commentAt = calls.findIndex(
      (c) => c.method === 'POST' && c.pathname.endsWith('/comment'),
    );
    expect(readBackAt, JSON.stringify(calls)).toBeGreaterThan(transition);
    expect(commentAt, JSON.stringify(calls)).toBeGreaterThan(readBackAt);
  });

  it('returns a typed failed close without a comment when the readback is not Done', async () => {
    statusAfter = { name: 'In Progress', statusCategory: { key: 'indeterminate' } };
    const { close } = await load('jira.mjs');
    const result = await close(ticket, { transitionId: '31', env: CREDENTIALS });
    expect(result).toMatchObject({ ok: false, transitioned: false, reason: expect.any(String) });
    expect(calls.some((c) => c.method === 'POST' && c.pathname.endsWith('/comment'))).toBe(false);
  });

  it('selects a Done-category transition, confirms Done, then posts the closing comment', async () => {
    statusAfter = { name: 'Done', statusCategory: { key: 'done' } };
    availableTransitions = [
      { id: '21', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
      { id: '31', to: { name: 'Done', statusCategory: { key: 'done' } } },
    ];
    const { close } = await load('jira.mjs');
    const result = await close(ticket, { env: CREDENTIALS });
    expect(result).toMatchObject({ ok: true, transitioned: true, status: 'Done' });
    const discoveryAt = calls.findIndex(
      (c) => c.method === 'GET' && c.pathname.endsWith('/transitions'),
    );
    const transitionAt = calls.findIndex(
      (c) => c.method === 'POST' && c.pathname.endsWith('/transitions'),
    );
    const readBackAt = calls.findIndex(
      (c) => c.method === 'GET' && c.pathname === '/rest/api/3/issue/ABC-13',
    );
    const commentAt = calls.findIndex(
      (c) => c.method === 'POST' && c.pathname.endsWith('/comment'),
    );
    expect(discoveryAt, JSON.stringify(calls)).toBeGreaterThan(-1);
    expect(transitionAt, JSON.stringify(calls)).toBeGreaterThan(discoveryAt);
    expect(readBackAt, JSON.stringify(calls)).toBeGreaterThan(transitionAt);
    expect(commentAt, JSON.stringify(calls)).toBeGreaterThan(readBackAt);
  });

  it('returns a typed failed close without a comment when no Done transition is available', async () => {
    statusAfter = { name: 'In Progress', statusCategory: { key: 'indeterminate' } };
    availableTransitions = [
      { id: '21', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
    ];
    const { close } = await load('jira.mjs');
    await expect(close(ticket, { env: CREDENTIALS })).resolves.toMatchObject({
      ok: false,
      transitioned: false,
      reason: expect.any(String),
    });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('fails closed for every malformed transition-discovery shape before it writes', async () => {
    const malformed = [
      { id: '31' },
      [null, { id: '31', to: { name: 'Done', statusCategory: { key: 'done' } } }],
      [{ id: 31, to: { name: 'Done', statusCategory: { key: 'done' } } }],
    ];
    for (const transitions of malformed) {
      calls.length = 0;
      statusAfter = { name: 'Done', statusCategory: { key: 'done' } };
      availableTransitions = transitions;
      const { close } = await load('jira.mjs');
      await expect(close(ticket, { env: CREDENTIALS })).resolves.toMatchObject({
        ok: false,
        transitioned: false,
        reason: expect.any(String),
      });
      expect(calls.some((c) => c.method === 'POST')).toBe(false);
    }
  });

  it('returns a typed failed close without a comment when Jira rejects transition discovery', async () => {
    statusAfter = { name: 'In Progress', statusCategory: { key: 'indeterminate' } };
    rejectDiscovery = true;
    const { close } = await load('jira.mjs');
    await expect(close(ticket, { env: CREDENTIALS })).resolves.toMatchObject({
      ok: false,
      transitioned: false,
      reason: expect.any(String),
    });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('returns a typed failed close without a comment when transition discovery is unreadable', async () => {
    statusAfter = { name: 'In Progress', statusCategory: { key: 'indeterminate' } };
    unreadableDiscovery = true;
    const { close } = await load('jira.mjs');
    await expect(close(ticket, { env: CREDENTIALS })).resolves.toMatchObject({
      ok: false,
      transitioned: false,
      reason: expect.any(String),
    });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('returns a typed failed close without a comment when Jira rejects the transition', async () => {
    statusAfter = { name: 'In Progress', statusCategory: { key: 'indeterminate' } };
    rejectTransition = true;
    const { close } = await load('jira.mjs');
    await expect(close(ticket, { transitionId: '31', env: CREDENTIALS })).resolves.toMatchObject({
      ok: false,
      transitioned: false,
      reason: expect.any(String),
    });
    expect(calls.some((c) => c.method === 'POST' && c.pathname.endsWith('/comment'))).toBe(false);
  });

  it('returns a typed failed close without a comment when the post-transition readback is unreadable', async () => {
    statusAfter = { name: 'Done', statusCategory: { key: 'done' } };
    unreadableReadBack = true;
    const { close } = await load('jira.mjs');
    await expect(close(ticket, { transitionId: '31', env: CREDENTIALS })).resolves.toMatchObject({
      ok: false,
      transitioned: false,
      reason: expect.any(String),
    });
    expect(calls.some((c) => c.method === 'POST' && c.pathname.endsWith('/comment'))).toBe(false);
  });

  it('reports a confirmed Done transition as a typed partial failure when its later closing comment is rejected', async () => {
    statusAfter = { name: 'Done', statusCategory: { key: 'done' } };
    rejectComment = true;
    const { close } = await load('jira.mjs');
    await expect(close(ticket, { transitionId: '31', env: CREDENTIALS })).resolves.toMatchObject({
      ok: false,
      transitioned: true,
      reason: expect.any(String),
    });
    const transitionAt = calls.findIndex(
      (c) => c.method === 'POST' && c.pathname.endsWith('/transitions'),
    );
    const commentAt = calls.findIndex(
      (c) => c.method === 'POST' && c.pathname.endsWith('/comment'),
    );
    expect(transitionAt, JSON.stringify(calls)).toBeGreaterThan(-1);
    expect(commentAt, JSON.stringify(calls)).toBeGreaterThan(transitionAt);
  });
});

describe('github close proves the transition by asking gh for the state', () => {
  let logFile: string;

  /** A `gh` on PATH that logs its argv one call per line and answers `issue view`. */
  let stub: StubHandle | undefined;
  const installGh = async (
    state: 'CLOSED' | 'OPEN',
    {
      rejectComment = false,
      rejectClose = false,
      rejectReadBack = false,
      rejectLabelCleanup = false,
    } = {},
  ): Promise<void> => {
    logFile = path.join(await mkdtemp(path.join(tmpdir(), 'stub-gh-')), 'calls.log');
    stub = await stubCommand(
      'gh',
      `require('node:fs').appendFileSync(${JSON.stringify(logFile)}, args.join(' ') + '\\n');
       if (${rejectReadBack} && args[0] === 'issue' && args[1] === 'view') throw new Error('readback unavailable');
       if (args[0] === 'issue' && args[1] === 'view') return { stdout: '{"state":"${state}"}\\n' };
       if (${rejectClose} && args[0] === 'issue' && args[1] === 'close') throw new Error('close rejected');
       if (${rejectLabelCleanup} && args[0] === 'issue' && args[1] === 'edit') throw new Error('label cleanup unavailable');
       if (${rejectComment} && args[0] === 'issue' && args[1] === 'comment') throw new Error('comment unavailable');
       return {};`,
    );
  };

  afterEach(() => {
    stub?.restore();
    stub = undefined;
  });

  const argvLog = async (): Promise<string[]> =>
    (await readFile(logFile, 'utf8')).split('\n').filter(Boolean);

  it('runs `issue view <id> --json state` after `issue close` and reports transitioned: true on CLOSED', async () => {
    await installGh('CLOSED');
    const { close } = await load('github-issues.mjs');
    const result = await close({ id: '13' }, { prUrl: 'https://example.invalid/pr/1' });
    expect(result).toMatchObject({ ok: true, transitioned: true });
    const log = await argvLog();
    const closeAt = log.findIndex((line) => line.startsWith('issue close 13'));
    const viewAt = log.findIndex((line) => line.startsWith('issue view 13'));
    const commentAt = log.findIndex((line) => line.startsWith('issue comment 13'));
    expect(closeAt, log.join('\n')).toBeGreaterThan(-1);
    expect(viewAt, log.join('\n')).toBeGreaterThan(closeAt);
    expect(log[viewAt]).toContain('--json state');
    expect(commentAt, log.join('\n')).toBeGreaterThan(viewAt);
  });

  it('returns a typed failed close and does not post a closing comment when gh still sees the issue OPEN', async () => {
    await installGh('OPEN');
    const { close } = await load('github-issues.mjs');
    const result = await close({ id: '13' });
    expect(result).toMatchObject({ ok: false, transitioned: false, reason: expect.any(String) });
    expect((await argvLog()).some((line) => line.startsWith('issue comment 13'))).toBe(false);
  });

  it('returns a typed failed close without a comment when gh rejects issue close', async () => {
    await installGh('OPEN', { rejectClose: true });
    const { close } = await load('github-issues.mjs');
    const result = await close({ id: '13' });
    expect(result).toMatchObject({ ok: false, transitioned: false, reason: expect.any(String) });
    const log = await argvLog();
    expect(log.filter((line) => line.startsWith('issue close 13'))).toHaveLength(1);
    expect(log.some((line) => line.startsWith('issue comment 13'))).toBe(false);
  });

  it('returns a typed failed close without a comment when the gh CLOSED readback is unavailable', async () => {
    await installGh('CLOSED', { rejectReadBack: true });
    const { close } = await load('github-issues.mjs');
    const result = await close({ id: '13' });
    expect(result).toMatchObject({ ok: false, transitioned: false, reason: expect.any(String) });
    const log = await argvLog();
    expect(log.filter((line) => line.startsWith('issue close 13'))).toHaveLength(1);
    expect(log.some((line) => line.startsWith('issue comment 13'))).toBe(false);
  });

  it('leaves the in-progress label on an issue whose close did not land', async () => {
    await installGh('OPEN');
    const { close } = await load('github-issues.mjs');
    await close({ id: '13' });
    const log = await argvLog();
    expect(log.some((line) => line.includes('--remove-label'))).toBe(false);
  });

  it('removes the in-progress label only after the read-back says CLOSED', async () => {
    await installGh('CLOSED');
    const { close } = await load('github-issues.mjs');
    await close({ id: '13' });
    const log = await argvLog();
    const viewAt = log.findIndex((line) => line.startsWith('issue view 13'));
    const labelAt = log.findIndex((line) => line.includes('--remove-label in-progress'));
    expect(labelAt, log.join('\n')).toBeGreaterThan(viewAt);
  });

  it('reports the confirmed transition as a typed partial failure when its later closing comment fails', async () => {
    await installGh('CLOSED', { rejectComment: true });
    const { close } = await load('github-issues.mjs');
    const result = await close({ id: '13' });
    expect(result).toMatchObject({ ok: false, transitioned: true, reason: expect.any(String) });
    const log = await argvLog();
    expect(log.filter((line) => line.startsWith('issue close 13'))).toHaveLength(1);
  });

  it('reports a confirmed CLOSED state as a typed partial failure when in-progress label cleanup fails', async () => {
    await installGh('CLOSED', { rejectLabelCleanup: true });
    const { close } = await load('github-issues.mjs');
    const result = await close({ id: '13' });
    expect(result).toMatchObject({ ok: false, transitioned: true, reason: expect.any(String) });
    const log = await argvLog();
    const closeAt = log.findIndex((line) => line.startsWith('issue close 13'));
    const labelAt = log.findIndex((line) => line.includes('--remove-label in-progress'));
    expect(closeAt, log.join('\n')).toBeGreaterThan(-1);
    expect(labelAt, log.join('\n')).toBeGreaterThan(closeAt);
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

  it('jira asks for the issue BY KEY on the live path, so a Done item still comes back', async () => {
    const CREDENTIALS = {
      JIRA_BASE_URL: 'https://example.invalid',
      JIRA_EMAIL: 'a@b.c',
      JIRA_API_TOKEN: 'x',
    };
    const calls: Array<{ pathname: string; search: string; method: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const url = new URL(String(input));
      calls.push({
        pathname: url.pathname,
        search: url.search,
        method: String(init.method ?? 'GET'),
      });
      const known = url.pathname.endsWith('/issue/ABC-13');
      return Promise.resolve({
        ok: known,
        status: known ? 200 : 404,
        statusText: known ? 'OK' : 'Not Found',
        json: () =>
          Promise.resolve({
            key: 'ABC-13',
            fields: {
              summary: 's',
              status: { name: 'Done', statusCategory: { key: 'done' } },
              labels: [],
              created: '2026-07-01T00:00:00.000+0000',
              issuelinks: [],
            },
          }),
      });
    }) as unknown as typeof globalThis.fetch;
    try {
      const { find } = await load('jira.mjs');
      const found = await find('ABC-13', { env: CREDENTIALS });
      expect(found).toMatchObject({ id: 'ABC-13', state: 'closed' });
      // never the search endpoint, whose JQL excludes Done
      expect(calls.every((c) => !c.pathname.includes('/search'))).toBe(true);
      expect(calls[0]).toMatchObject({ method: 'GET', pathname: '/rest/api/3/issue/ABC-13' });
      expect(calls[0]!.search).toContain('fields=');
      expect(await find('ABC-99', { env: CREDENTIALS })).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('github asks `gh issue view` with the full field list and maps CLOSED to closed', async () => {
    const bin = await mkdtemp(path.join(tmpdir(), 'stub-gh-find-'));
    const logFile = path.join(bin, 'calls.log');
    const payload =
      '{"number":13,"title":"t","body":"","state":"CLOSED","labels":[],"url":null,"createdAt":null,"updatedAt":"2026-07-02T00:00:00Z"}';
    const stub = await stubCommand(
      'gh',
      `require('node:fs').appendFileSync(${JSON.stringify(logFile)}, args.join(' ') + '\\n');
       // find() also reads the two \`issue list\` windows to cross-index
       // \`blocks\` (RP-449) — an array, even an empty one, is what a real
       // \`gh issue list --json\` answers; this fixture's point is the single
       // \`issue view\`, so the windows just need to be READABLE.
       if (args[0] === 'issue' && args[1] === 'list') return { stdout: '[]\\n' };
       return { stdout: ${JSON.stringify(payload + '\n')} };`,
    );
    try {
      const { find } = await load('github-issues.mjs');
      const found = find('13');
      expect(found).toMatchObject({ id: '13', state: 'closed', updatedAt: '2026-07-02T00:00:00Z' });
      // the stubbed list windows come back empty, so the cross-index finds no
      // dependants for #13 here — not because a single view can never carry one
      expect(found.blocks).toEqual([]);
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
      stub.restore();
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

  it("reports transitioned: true once the item's line is gone", async () => {
    const planPath = await planFile();
    const { close } = await load('plan-md.mjs');
    const result = await close({ id: '2' }, { planPath });
    expect(result).toMatchObject({ ok: true, transitioned: true });
    expect(await readFile(planPath, 'utf8')).not.toContain('- remove me');
  });

  it('returns a typed failed close for an id the plan does not carry', async () => {
    const planPath = await planFile();
    const { close } = await load('plan-md.mjs');
    const result = await close({ id: '9' }, { planPath });
    expect(result).toMatchObject({ ok: false, transitioned: false, reason: expect.any(String) });
    expect(await readFile(planPath, 'utf8')).toBe(PLAN);
  });
});

// RP-447: the resolution half of a continuation. A close that transitioned
// leaves one `item-closed` event in the run journal; one that did not leaves none.
describe('close journals an item-closed event only when it transitioned', () => {
  const runJournal = path.join(queueDir, '..', 'run-journal.mjs');

  const itemClosedEvents = async (
    runDir: string,
  ): Promise<Array<{ kind: string; data: unknown }>> => {
    const { readRun } = await import(pathToFileURL(runJournal).href);
    const { events } = readRun({ runDir }) as {
      events: Array<{ kind: string; data: unknown }>;
    };
    return events.filter((event) => event.kind === 'item-closed');
  };

  const freshRunDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'close-run-'));

  it('jira close journals one item-closed event when it transitioned', async () => {
    const runDir = await freshRunDir();
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const method = String(init.method ?? 'GET');
      if (method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () =>
            Promise.resolve({
              fields: { status: { name: 'Done', statusCategory: { key: 'done' } } },
            }),
        });
      }
      const status = new URL(String(input)).pathname.endsWith('/transitions') ? 204 : 201;
      return Promise.resolve({
        ok: true,
        status,
        statusText: status === 204 ? 'No Content' : 'Created',
        json: () => Promise.resolve({}),
      });
    }) as unknown as typeof globalThis.fetch;
    try {
      const { close } = await load('jira.mjs');
      const result = await close(ticket, {
        transitionId: '31',
        env: {
          JIRA_BASE_URL: 'https://example.invalid',
          JIRA_EMAIL: 'a@b.c',
          JIRA_API_TOKEN: 'x',
          RIG_RUN_DIR: runDir,
        },
      });
      expect(result).toMatchObject({ transitioned: true });
      const events = await itemClosedEvents(runDir);
      expect(events).toHaveLength(1);
      expect(events[0]!.data).toEqual({ schemaVersion: 1, ticket: 'ABC-13' });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  /** The same `gh` the github close tests above install: it answers `issue view` with `state`. */
  let stub: StubHandle | undefined;
  const installGh = async (state: 'CLOSED' | 'OPEN'): Promise<void> => {
    stub = await stubCommand(
      'gh',
      `if (args[0] === 'issue' && args[1] === 'view') return { stdout: '{"state":"${state}"}\\n' };
       return {};`,
    );
  };

  afterEach(() => {
    stub?.restore();
    stub = undefined;
  });

  it('github-issues close journals one item-closed event when it transitioned', async () => {
    const runDir = await freshRunDir();
    await installGh('CLOSED');
    const { close } = await load('github-issues.mjs');
    const result = await close(
      { id: '13' },
      { prUrl: 'https://example.invalid/pr/1', env: { ...process.env, RIG_RUN_DIR: runDir } },
    );
    expect(result).toMatchObject({ transitioned: true });
    const events = await itemClosedEvents(runDir);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ schemaVersion: 1, ticket: '13' });
  });

  it('a close that did not transition journals nothing', async () => {
    const runDir = await freshRunDir();
    await installGh('OPEN');
    const { close } = await load('github-issues.mjs');
    const result = await close({ id: '13' }, { env: { ...process.env, RIG_RUN_DIR: runDir } });
    expect(result).toMatchObject({ transitioned: false });
    expect(await itemClosedEvents(runDir)).toEqual([]);
  });

  it('a plan-md close of an id the plan does not carry journals nothing', async () => {
    const runDir = await freshRunDir();
    const dir = await mkdtemp(path.join(tmpdir(), 'close-plan-'));
    const planPath = path.join(dir, 'PLAN.md');
    await writeFile(planPath, '# P\n\n## Agent queue\n\n- keep me\n\n## Journal\n');
    const { close } = await load('plan-md.mjs');
    const result = await close(
      { id: '9' },
      { planPath, env: { ...process.env, RIG_RUN_DIR: runDir } },
    );
    expect(result).toMatchObject({ transitioned: false });
    expect(await itemClosedEvents(runDir)).toEqual([]);
  });

  it('plan-md close journals one item-closed event when the line is gone', async () => {
    const runDir = await freshRunDir();
    const dir = await mkdtemp(path.join(tmpdir(), 'close-plan-'));
    const planPath = path.join(dir, 'PLAN.md');
    await writeFile(planPath, '# P\n\n## Agent queue\n\n- keep me\n- remove me\n\n## Journal\n');
    const { close } = await load('plan-md.mjs');
    const result = await close(
      { id: '2' },
      { planPath, env: { ...process.env, RIG_RUN_DIR: runDir } },
    );
    expect(result).toMatchObject({ transitioned: true });
    const events = await itemClosedEvents(runDir);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ schemaVersion: 1, ticket: '2' });
  });
});
