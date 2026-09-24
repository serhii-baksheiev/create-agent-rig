import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stubCommand, type StubHandle } from '../helpers/stub-command.js';

/**
 * RP-221 — respect tracker assignee as human ownership authority.
 *
 * A human reassignment must be visible to selection and to claim(): an item
 * assigned to someone other than the current controller is held, never
 * taken; an item reassigned away between selection and claim() is refused
 * rather than mutated. Unassigned items, and items assigned to the current
 * actor, stay eligible exactly as before.
 *
 * Design shape assumed by this Red step (see the report accompanying it for
 * the full rationale):
 *
 *   - `ticket.assignee` on the neutral shape: `null` (unassigned), a single
 *     opaque id/login (jira), or an array of ids/logins (github allows
 *     several). `core.mjs` normalises all three via one internal helper.
 *   - `core.mjs` `selectionOf`/`selectNext` gain a `currentActor` option:
 *     `{ id: string } | null`. A new closed-vocabulary cause `'assigned'`
 *     joins `SKIP_CAUSES` and `HOLDING_CAUSES`.
 *   - `jira.mjs` and `github-issues.mjs` each export `currentActor()`,
 *     resolving to `{ id }` or `null` on any failure — never throwing, and
 *     never surfacing an email address or display name.
 *   - `claim()` on both tracker adapters accepts a `currentActor` option and
 *     re-reads the assignee in its existing pre-read: an item now assigned
 *     to another actor refuses as `claim-stale`, before any mutating
 *     request.
 *   - `plan-md.mjs` is unaffected: no assignee concept, no `currentActor`
 *     export.
 */

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

const CANARY_EMAIL = 'rp221-canary@example.invalid';

const ticket = (over: Record<string, unknown> = {}) => ({
  id: 'T-1',
  title: 't',
  state: 'open',
  labels: [],
  tier: 'normal',
  blockedBy: [],
  blocks: [],
  priority: 3,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: null,
  body: null,
  triage: false,
  trigger: null,
  owner: null,
  assignee: null,
  ...over,
});

// --- core.mjs: selection reads the assignee against the current actor ------

describe('selection respects the tracker assignee as human ownership authority (RP-221)', () => {
  it('takes an unassigned item regardless of whether the current actor is known', async () => {
    const { selectionOf } = await load('core.mjs');
    expect(selectionOf(ticket({ assignee: null }), { currentActor: { id: 'me' } }).eligible).toBe(
      true,
    );
    expect(selectionOf(ticket({ assignee: null }), { currentActor: null }).eligible).toBe(true);
    expect(selectionOf(ticket({ assignee: undefined }), {}).eligible).toBe(true);
  });

  it('takes an item assigned to the current actor', async () => {
    const { selectionOf } = await load('core.mjs');
    expect(
      selectionOf(ticket({ assignee: 'acct-me' }), { currentActor: { id: 'acct-me' } }).eligible,
    ).toBe(true);
  });

  it('holds an item assigned to another actor, naming the cause and both identities', async () => {
    const { selectionOf } = await load('core.mjs');
    const selection = selectionOf(ticket({ assignee: 'acct-them' }), {
      currentActor: { id: 'acct-me' },
    });
    expect(selection.eligible).toBe(false);
    expect(selection.causes).toEqual(['assigned']);
    expect(selection.reasons.join(' ')).toMatch(/acct-them/);
    expect(selection.reasons.join(' ')).toMatch(/human|tracker/i);
  });

  it('holds an assigned item when the current actor is unknown — cannot confirm is not a match (fail closed)', async () => {
    const { selectionOf } = await load('core.mjs');
    const selection = selectionOf(ticket({ assignee: 'acct-them' }), { currentActor: null });
    expect(selection.eligible).toBe(false);
    expect(selection.causes).toEqual(['assigned']);
  });

  it('is unaffected by an unknown actor when the item itself is unassigned', async () => {
    const { selectionOf } = await load('core.mjs');
    expect(selectionOf(ticket({ assignee: null }), { currentActor: null }).eligible).toBe(true);
  });

  it('treats several assignees (GitHub) as eligible when the current actor is among them', async () => {
    const { selectionOf } = await load('core.mjs');
    expect(
      selectionOf(ticket({ assignee: ['acct-me', 'acct-other'] }), {
        currentActor: { id: 'acct-me' },
      }).eligible,
    ).toBe(true);
  });

  it('holds several assignees (GitHub) when the current actor is not among them', async () => {
    const { selectionOf } = await load('core.mjs');
    const selection = selectionOf(ticket({ assignee: ['acct-a', 'acct-b'] }), {
      currentActor: { id: 'acct-me' },
    });
    expect(selection.eligible).toBe(false);
    expect(selection.causes).toEqual(['assigned']);
  });

  it('an empty assignee array reads as unassigned', async () => {
    const { selectionOf } = await load('core.mjs');
    expect(selectionOf(ticket({ assignee: [] }), { currentActor: null }).eligible).toBe(true);
  });

  it('is a holding cause, so a queue of reassigned items ends as "nothing selectable", not "empty"', async () => {
    const { HOLDING_CAUSES, SKIP_CAUSES, selectNext, stopConditionOf } = await load('core.mjs');
    expect(SKIP_CAUSES).toContain('assigned');
    expect(HOLDING_CAUSES).toContain('assigned');
    const result = selectNext([ticket({ assignee: 'acct-them' })], {
      currentActor: { id: 'acct-me' },
    });
    expect(result.ticket).toBeNull();
    const stop = stopConditionOf({ candidates: 0, skipped: result.skipped });
    expect(stop.kind).toBe('nothing-selectable');
    expect(stop.why).toMatch(/assigned/);
  });
});

// --- jira.mjs: the neutral mapping, currentActor(), and the email canary ---

describe('jira → assignee identity (RP-221)', () => {
  const issue = (assignee: unknown) => ({
    key: 'ABC-1',
    fields: {
      summary: 's',
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      labels: [],
      issuelinks: [],
      assignee,
    },
  });

  it('maps the opaque accountId onto ticket.assignee, and null when there is none', async () => {
    const { toTicket } = await load('jira.mjs');
    expect(
      toTicket(
        issue({
          accountId: 'acct-123',
          emailAddress: CANARY_EMAIL,
          displayName: 'Someone Human',
        }),
      ).assignee,
    ).toBe('acct-123');
    expect(toTicket(issue(null)).assignee).toBeNull();
  });

  it('never surfaces the assignee’s displayName or emailAddress on the neutral ticket', async () => {
    const { toTicket } = await load('jira.mjs');
    const mapped = toTicket(
      issue({ accountId: 'acct-123', emailAddress: CANARY_EMAIL, displayName: 'Someone Human' }),
    );
    const serialised = JSON.stringify(mapped);
    expect(serialised).not.toContain(CANARY_EMAIL);
    expect(serialised).not.toContain('Someone Human');
  });

  it('requests the assignee field, so a live search can populate ticket.assignee', async () => {
    const source = await (
      await import('node:fs/promises')
    ).readFile(path.join(queueDir, 'jira.mjs'), 'utf8');
    expect(source).toMatch(/['"]assignee['"]/);
  });
});

describe('jira currentActor() (RP-221)', () => {
  const CREDENTIALS = {
    JIRA_BASE_URL: 'https://example.invalid',
    JIRA_EMAIL: 'a@b.c',
    JIRA_API_TOKEN: 'x',
  };

  let realFetch: typeof globalThis.fetch;
  let realStdoutWrite: typeof process.stdout.write;
  let realStderrWrite: typeof process.stderr.write;
  const written: string[] = [];

  beforeEach(() => {
    realFetch = globalThis.fetch;
    realStdoutWrite = process.stdout.write;
    realStderrWrite = process.stderr.write;
    written.length = 0;
    process.stdout.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.stdout.write = realStdoutWrite;
    process.stderr.write = realStderrWrite;
  });

  it('reads GET /rest/api/3/myself and answers only the opaque accountId', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      calls.push({ url: String(input), method: String(init.method ?? 'GET') });
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
        json: () =>
          Promise.resolve({
            accountId: 'acct-me',
            emailAddress: CANARY_EMAIL,
            displayName: 'The Current Actor',
          }),
        text: () => Promise.resolve(''),
      });
    }) as unknown as typeof globalThis.fetch;

    const { currentActor } = await load('jira.mjs');
    const actor = await currentActor({ env: CREDENTIALS });

    expect(actor).toEqual({ id: 'acct-me' });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe('/rest/api/3/myself');

    // The independent oracle: the canary email travelled in the fake's
    // response body, so its absence from the returned value and from every
    // byte this process wrote is the actual proof, not a re-check of the
    // same mapping logic.
    expect(JSON.stringify(actor)).not.toContain(CANARY_EMAIL);
    expect(written.join('')).not.toContain(CANARY_EMAIL);
  });

  it('resolves null, never throws, when the request fails', async () => {
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        headers: { get: () => null },
        json: () => Promise.resolve({ errorMessages: ['unauthorized'] }),
        text: () => Promise.resolve('unauthorized'),
      })) as unknown as typeof globalThis.fetch;

    const { currentActor } = await load('jira.mjs');
    await expect(currentActor({ env: CREDENTIALS })).resolves.toBeNull();
  });

  it('resolves null, never throws, when credentials are missing', async () => {
    const { currentActor } = await load('jira.mjs');
    await expect(currentActor({ env: {} })).resolves.toBeNull();
  });
});

// --- github-issues.mjs: the neutral mapping and currentActor() -------------

describe('github-issues → assignee identity (RP-221)', () => {
  const issue = (assignees: string[]) => ({
    number: 7,
    title: 's',
    state: 'OPEN',
    labels: [],
    body: '',
    url: 'https://example.invalid/7',
    createdAt: '2026-08-01T00:00:00Z',
    assignees: assignees.map((login) => ({ login })),
  });

  it('maps `assignees` logins onto ticket.assignee, and null when there are none', async () => {
    const { toTicket } = await load('github-issues.mjs');
    expect(toTicket(issue(['alice']) as never).assignee).toEqual(['alice']);
    expect(toTicket(issue(['alice', 'bob']) as never).assignee).toEqual(['alice', 'bob']);
    expect(toTicket(issue([]) as never).assignee).toBeNull();
  });
});

describe('github-issues currentActor() (RP-221)', () => {
  let installed: StubHandle | null = null;

  afterEach(() => {
    installed?.restore();
    installed = null;
  });

  it('reads the caller’s own login', async () => {
    installed = await stubCommand(
      'gh',
      `
        if (args[0] === 'api' && args[1] === 'user') return { stdout: 'me\\n' };
        return { stdout: '[]\\n' };
      `,
    );
    const { currentActor } = await load('github-issues.mjs');
    await expect(currentActor()).resolves.toEqual({ id: 'me' });
  });

  it('resolves null, never throws, when the command fails', async () => {
    installed = await stubCommand(
      'gh',
      `
        if (args[0] === 'api' && args[1] === 'user') return { exitCode: 1 };
        return { stdout: '[]\\n' };
      `,
    );
    const { currentActor } = await load('github-issues.mjs');
    await expect(currentActor()).resolves.toBeNull();
  });
});

// --- plan-md.mjs: unaffected -------------------------------------------------

describe('plan-md carries no assignee concept (RP-221)', () => {
  it('parses items with no assignee field at all', async () => {
    const { parsePlan } = await load('plan-md.mjs');
    const [item] = parsePlan('# P\n\n## Agent queue\n\n- Do the thing\n\n## Journal\n');
    expect(item.assignee).toBeUndefined();
  });

  it('exports no currentActor — there is no tracker account to ask', async () => {
    const adapter = await load('plan-md.mjs');
    expect(Object.keys(adapter)).not.toContain('currentActor');
  });

  it('a plan-md item stays eligible regardless of currentActor, known or not', async () => {
    const { parsePlan } = await load('plan-md.mjs');
    const { selectionOf } = await load('core.mjs');
    const [item] = parsePlan('# P\n\n## Agent queue\n\n- Do the thing\n\n## Journal\n');
    expect(selectionOf(item, { currentActor: { id: 'me' } }).eligible).toBe(true);
    expect(selectionOf(item, { currentActor: null }).eligible).toBe(true);
  });
});

// --- claim(): a reassignment between SELECT and claim wins, without a write -

describe('jira claim() refuses a reassignment that lands after selection (RP-221)', () => {
  const CREDENTIALS = {
    JIRA_BASE_URL: 'https://example.invalid',
    JIRA_EMAIL: 'a@b.c',
    JIRA_API_TOKEN: 'x',
  };
  const T0 = '2026-09-01T00:00:00.000Z';

  let realFetch: typeof globalThis.fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('refuses as claim-stale, with zero transition POSTs, when the pre-read shows it now assigned to another actor', async () => {
    const ticketSnapshot = { id: 'RP-50', updatedAt: T0, assignee: null };
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const url = String(input);
      const method = String(init.method ?? 'GET');
      calls.push({ url, method });
      const pathname = new URL(url).pathname;
      if (method === 'GET' && pathname === '/rest/api/3/issue/RP-50') {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: () => null },
          json: () =>
            Promise.resolve({
              fields: {
                status: { name: 'To Do', statusCategory: { key: 'new' } },
                updated: T0,
                assignee: { accountId: 'acct-someone-else' },
              },
            }),
          text: () => Promise.resolve(''),
        });
      }
      if (method === 'POST' && /\/transitions$/.test(pathname)) {
        return Promise.resolve({
          ok: true,
          status: 204,
          statusText: 'No Content',
          headers: { get: () => null },
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(''),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: { get: () => null },
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
      });
    }) as unknown as typeof globalThis.fetch;

    const { claim } = await load('jira.mjs');
    const result = await claim(ticketSnapshot, {
      transitionId: '21',
      env: CREDENTIALS,
      currentActor: { id: 'acct-me' },
    });

    expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-stale' });
    expect(
      calls.filter((c) => c.method === 'POST' && /\/transitions$/.test(new URL(c.url).pathname)),
    ).toHaveLength(0);
  });

  it('does not refuse on the assignee alone when the pre-read shows it assigned to the current actor', async () => {
    const ticketSnapshot = { id: 'RP-51', updatedAt: T0, assignee: null };
    let transitionPosts = 0;
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const url = String(input);
      const method = String(init.method ?? 'GET');
      const pathname = new URL(url).pathname;
      if (method === 'GET' && pathname === '/rest/api/3/issue/RP-51') {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: () => null },
          json: () =>
            Promise.resolve({
              fields: {
                status: { name: 'To Do', statusCategory: { key: 'new' } },
                updated: T0,
                assignee: { accountId: 'acct-me' },
              },
            }),
          text: () => Promise.resolve(''),
        });
      }
      if (method === 'POST' && /\/transitions$/.test(pathname)) {
        transitionPosts += 1;
        return Promise.resolve({
          ok: true,
          status: 204,
          statusText: 'No Content',
          headers: { get: () => null },
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(''),
        });
      }
      // Every later read-back call this test does not care about the outcome
      // of — answered with a plain failure, which resolves the whole claim as
      // claim-unverifiable rather than throwing.
      return Promise.resolve({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: { get: () => null },
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
      });
    }) as unknown as typeof globalThis.fetch;

    const { claim } = await load('jira.mjs');
    const result = await claim(ticketSnapshot, {
      transitionId: '21',
      env: CREDENTIALS,
      currentActor: { id: 'acct-me' },
    });

    // The point under test: the assignee gate did not stop it — it reached
    // the mutation. Whatever the read-back afterwards decides is out of scope
    // here (RP-220 owns that), so `reason` is deliberately not asserted.
    expect(result.reason, JSON.stringify(result)).not.toBe('claim-stale');
    expect(transitionPosts).toBe(1);
  });
});

describe('github-issues claim() refuses a reassignment that lands after selection (RP-221)', () => {
  const T0 = '2026-09-01T00:00:00.000Z';
  let installed: StubHandle | null = null;
  let logPath: string;

  beforeEach(async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(path.join(tmpdir(), 'rp221-gh-'));
    logPath = path.join(dir, 'calls.log');
    await writeFile(logPath, '');
  });

  afterEach(() => {
    installed?.restore();
    installed = null;
  });

  const editCallsIn = async (): Promise<number> => {
    const { readFile } = await import('node:fs/promises');
    const lines = (await readFile(logPath, 'utf8')).split('\n').filter(Boolean);
    return lines.filter((line) => line.startsWith('issue edit')).length;
  };

  it('refuses as claim-stale, with zero label-edit calls, when the pre-read shows it now assigned to another login', async () => {
    installed = await stubCommand(
      'gh',
      `
        const fs = require('node:fs');
        fs.appendFileSync(${JSON.stringify(logPath)}, args.join(' ') + '\\n');
        if (args[0] === 'issue' && args[1] === 'view') {
          return { stdout: JSON.stringify({
            state: 'OPEN',
            labels: [],
            updatedAt: ${JSON.stringify(T0)},
            assignees: [{ login: 'someone-else' }],
          }) + '\\n' };
        }
        if (args[0] === 'issue' && args[1] === 'edit') {
          return { stdout: '' };
        }
        return { stdout: '[]\\n' };
      `,
    );
    const ticketSnapshot = { id: '42', updatedAt: T0, assignee: null };

    const { claim } = await load('github-issues.mjs');
    const result = await claim(ticketSnapshot, { currentActor: { id: 'me' } });

    expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-stale' });
    expect(await editCallsIn()).toBe(0);
  });

  it('does not refuse on the assignee alone when the pre-read shows it assigned to the current actor', async () => {
    installed = await stubCommand(
      'gh',
      `
        const fs = require('node:fs');
        fs.appendFileSync(${JSON.stringify(logPath)}, args.join(' ') + '\\n');
        if (args[0] === 'issue' && args[1] === 'view') {
          const jsonIdx = args.indexOf('--json');
          const fields = String(args[jsonIdx + 1] || '').split(',');
          const out = {};
          if (fields.includes('state')) out.state = 'OPEN';
          if (fields.includes('labels')) out.labels = [];
          if (fields.includes('updatedAt')) out.updatedAt = ${JSON.stringify(T0)};
          if (fields.includes('assignees')) out.assignees = [{ login: 'me' }];
          return { stdout: JSON.stringify(out) + '\\n' };
        }
        if (args[0] === 'issue' && args[1] === 'edit') {
          return { stdout: '' };
        }
        if (args[0] === 'api' && args[1] === 'user') return { stdout: 'me\\n' };
        return { stdout: '[]\\n' };
      `,
    );
    const ticketSnapshot = { id: '43', updatedAt: T0, assignee: null };

    const { claim } = await load('github-issues.mjs');
    const result = await claim(ticketSnapshot, { currentActor: { id: 'me' } });

    // The point under test: the assignee gate did not stop it — it reached
    // the mutation. Whatever the read-back afterwards decides is out of
    // scope here (RP-220 owns that), so `reason` is deliberately not
    // asserted beyond "not claim-stale".
    expect(result.reason, JSON.stringify(result)).not.toBe('claim-stale');
    expect(await editCallsIn()).toBe(1);
  });
});
