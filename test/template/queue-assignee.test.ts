import { execFile } from 'node:child_process';
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

  // Renamed (RP-221 round 2, r1-code-reviewer.md advisory): the assertions
  // below check only the tracker's assignee — `selection.reasons` never
  // repeats the current actor's own id (`assigneeMismatchOf` in core.mjs says
  // so explicitly), so a title promising "both identities" was never true of
  // what this test checks.
  it("holds an item assigned to another actor, naming the cause and the tracker's assignee", async () => {
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

  // The source-text scan this test used to run (`toMatch(/['"]assignee['"]/)`
  // against jira.mjs's own text) matched the word anywhere at all — a comment
  // mentioning "assignee" would have satisfied it exactly as well as the field
  // actually reaching the request. The behavioural version of this same claim
  // lives in queue-jira.test.ts › "names the fields it wants as a list,
  // because the body will not take a joined string", which now asserts
  // 'assignee' is present in the live search's own request body (RP-221 round
  // 2, r1-code-reviewer.md advisory).
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

// --- RP-221 round 2: claim() resolves its own actor when the caller omits it
//
// r1-code-reviewer.md B1: `claim()`'s `currentActor` option defaults to `null`
// on both adapters, and nothing in this repository's own call sites ever
// resolves and passes one for a real claim — `index.mjs` only threads
// `currentActor` into `selectNext` (selection), never into `claim`. The loop
// skill's own instruction ("pass the same `currentActor` resolved for
// selection") is prose, not a mechanism, so a caller that follows the
// documented shape `adapter.claim(ticket, { projectRoot })` — the shape
// `index.mjs`'s neighbouring code and the skill's own take-up step both use —
// gets `currentActor: null` and a self-assigned item is refused as
// `claim-stale`, indistinguishable from a genuine reassignment.
//
// The fix this pins: when the option is `undefined` (omitted entirely),
// `claim()` resolves the actor itself through the adapter's own
// `currentActor()` — the same function selection already calls — rather than
// silently treating "the caller forgot" the same as "known unknown". An
// explicit `currentActor: null` stays "known unknown" and still fails closed;
// see the assigned-to-someone-else cases below, which pass `null` on purpose
// and must keep refusing.

describe("jira claim() resolves this run's own tracker identity when the caller passes no currentActor option at all (RP-221 round 2)", () => {
  const CREDENTIALS = {
    JIRA_BASE_URL: 'https://example.invalid',
    JIRA_EMAIL: 'a@b.c',
    JIRA_API_TOKEN: 'x',
  };
  const T0 = '2026-09-04T00:00:00.000Z';

  let realFetch: typeof globalThis.fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('resolves the actor via /myself, and does not refuse on the assignee alone, for a self-assigned item', async () => {
    const ticketSnapshot = { id: 'RP-54', updatedAt: T0, assignee: null };
    const calls: Array<{ url: string; method: string }> = [];
    let transitionPosts = 0;
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const url = String(input);
      const method = String(init.method ?? 'GET');
      calls.push({ url, method });
      const pathname = new URL(url).pathname;
      if (method === 'GET' && pathname === '/rest/api/3/myself') {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: () => null },
          json: () => Promise.resolve({ accountId: 'acct-me' }),
          text: () => Promise.resolve(''),
        });
      }
      if (method === 'GET' && pathname === '/rest/api/3/issue/RP-54') {
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
      // The read-back afterwards is out of scope here (RP-220 owns that):
      // every later call answers a plain failure, which resolves the whole
      // claim as claim-unverifiable rather than throwing.
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
    // No `currentActor` key at all — the shape `index.mjs`'s own neighbouring
    // code and the loop skill's take-up step use today.
    const result = await claim(ticketSnapshot, { transitionId: '21', env: CREDENTIALS });

    expect(result.reason, JSON.stringify(result)).not.toBe('claim-stale');
    expect(transitionPosts).toBe(1);
    expect(calls.some((c) => new URL(c.url).pathname === '/rest/api/3/myself')).toBe(true);
  });

  it('resolves the actor via /myself and still refuses as claim-stale, with zero transition POSTs, when assigned to someone else', async () => {
    const ticketSnapshot = { id: 'RP-55', updatedAt: T0, assignee: null };
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const url = String(input);
      const method = String(init.method ?? 'GET');
      calls.push({ url, method });
      const pathname = new URL(url).pathname;
      if (method === 'GET' && pathname === '/rest/api/3/myself') {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: () => null },
          json: () => Promise.resolve({ accountId: 'acct-me' }),
          text: () => Promise.resolve(''),
        });
      }
      if (method === 'GET' && pathname === '/rest/api/3/issue/RP-55') {
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
        throw new Error('must not transition when the resolved actor does not match the assignee');
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
    const result = await claim(ticketSnapshot, { transitionId: '21', env: CREDENTIALS });

    expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-stale' });
    expect(calls.some((c) => new URL(c.url).pathname === '/rest/api/3/myself')).toBe(true);
    expect(
      calls.filter((c) => c.method === 'POST' && /\/transitions$/.test(new URL(c.url).pathname)),
    ).toHaveLength(0);
  });
});

describe("github-issues claim() resolves this run's own tracker identity when the caller passes no currentActor option at all (RP-221 round 2)", () => {
  const T0 = '2026-09-04T00:00:00.000Z';
  let installed: StubHandle | null = null;
  let logPath: string;

  beforeEach(async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(path.join(tmpdir(), 'rp221-gh-selfresolve-'));
    logPath = path.join(dir, 'calls.log');
    await writeFile(logPath, '');
  });

  afterEach(() => {
    installed?.restore();
    installed = null;
  });

  const callsIn = async (prefix: string): Promise<number> => {
    const { readFile } = await import('node:fs/promises');
    const lines = (await readFile(logPath, 'utf8')).split('\n').filter(Boolean);
    return lines.filter((line) => line.startsWith(prefix)).length;
  };

  it('resolves the login via `gh api user`, and does not refuse on the assignee alone, for a self-assigned item', async () => {
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
            assignees: [{ login: 'me' }],
          }) + '\\n' };
        }
        if (args[0] === 'issue' && args[1] === 'edit') {
          return { stdout: '' };
        }
        if (args[0] === 'api' && args[1] === 'user') return { stdout: 'me\\n' };
        return { stdout: '[]\\n' };
      `,
    );
    const ticketSnapshot = { id: '62', updatedAt: T0, assignee: null };

    const { claim } = await load('github-issues.mjs');
    // The shape the loop's take-up step uses today: no `currentActor` key.
    const result = await claim(ticketSnapshot, { projectRoot: process.cwd() });

    expect(result.reason, JSON.stringify(result)).not.toBe('claim-stale');
    expect(await callsIn('issue edit')).toBe(1);
    expect(await callsIn('api user')).toBeGreaterThan(0);
  });

  it('resolves the login via `gh api user` and still refuses as claim-stale, with zero label-edit calls, when assigned to someone else', async () => {
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
        if (args[0] === 'api' && args[1] === 'user') return { stdout: 'me\\n' };
        return { stdout: '[]\\n' };
      `,
    );
    const ticketSnapshot = { id: '63', updatedAt: T0, assignee: null };

    const { claim } = await load('github-issues.mjs');
    const result = await claim(ticketSnapshot, { projectRoot: process.cwd() });

    expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-stale' });
    expect(await callsIn('issue edit')).toBe(0);
    expect(await callsIn('api user')).toBeGreaterThan(0);
  });
});

// --- RP-221 round 2: the refusal detail names the true cause -----------------
//
// r1-code-reviewer.md B2: both adapters returned the identical detail string
// ("reassigned to another actor since selection") whether the pre-read showed
// a genuine mismatch OR the current actor could not be resolved at all — the
// same sentence for "I checked, and it is someone else" and "I could not
// check". A human reading the refusal cannot tell "reassign it back to me" and
// "fix this run's tracker credentials" apart from the same words. Every
// assertion below is a regex on the distinguishing words, never on an id or
// an email — the detail must tell the two causes apart without repeating the
// tracker's identity.

describe('jira claim() refusal detail tells a genuine mismatch apart from an unresolved actor (RP-221 round 2)', () => {
  const CREDENTIALS = {
    JIRA_BASE_URL: 'https://example.invalid',
    JIRA_EMAIL: 'a@b.c',
    JIRA_API_TOKEN: 'x',
  };
  const T0 = '2026-09-05T00:00:00.000Z';

  let realFetch: typeof globalThis.fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const fakeFetch = () =>
    ((input: unknown, init: { method?: string } = {}) => {
      const url = String(input);
      const method = String(init.method ?? 'GET');
      const pathname = new URL(url).pathname;
      if (method === 'GET' && pathname === '/rest/api/3/issue/RP-60') {
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
        throw new Error('must not transition on a refused claim');
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

  it('says the item is assigned to another actor when the current actor is known and does not match', async () => {
    globalThis.fetch = fakeFetch();
    const { claim } = await load('jira.mjs');
    const result = await claim(
      { id: 'RP-60', updatedAt: T0, assignee: null },
      { transitionId: '21', env: CREDENTIALS, currentActor: { id: 'acct-me' } },
    );

    expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-stale' });
    expect(String(result.detail)).toMatch(/another actor|reassigned/i);
    expect(String(result.detail)).not.toMatch(/could not|unresolved|unknown|unable/i);
    expect(String(result.detail)).not.toContain('acct-someone-else');
    expect(String(result.detail)).not.toContain('acct-me');
  });

  it('says the actor could not be resolved — a different detail — when the current actor is known unknown (explicit null) and the item is assigned', async () => {
    globalThis.fetch = fakeFetch();
    const { claim } = await load('jira.mjs');
    const result = await claim(
      { id: 'RP-60', updatedAt: T0, assignee: null },
      { transitionId: '21', env: CREDENTIALS, currentActor: null },
    );

    expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-stale' });
    expect(String(result.detail)).toMatch(
      /could not|unresolved|unknown|unable to (confirm|resolve)/i,
    );
    expect(String(result.detail)).not.toMatch(/another actor/i);
    expect(String(result.detail)).not.toContain('acct-someone-else');
  });
});

describe('github-issues claim() refusal detail tells a genuine mismatch apart from an unresolved actor (RP-221 round 2)', () => {
  const T0 = '2026-09-05T00:00:00.000Z';
  let installed: StubHandle | null = null;

  afterEach(() => {
    installed?.restore();
    installed = null;
  });

  const installGh = () =>
    stubCommand(
      'gh',
      `
        if (args[0] === 'issue' && args[1] === 'view') {
          return { stdout: JSON.stringify({
            state: 'OPEN',
            labels: [],
            updatedAt: ${JSON.stringify(T0)},
            assignees: [{ login: 'someone-else' }],
          }) + '\\n' };
        }
        if (args[0] === 'issue' && args[1] === 'edit') {
          throw new Error('must not edit on a refused claim');
        }
        return { stdout: '[]\\n' };
      `,
    );

  it('says the item is assigned to another actor when the current actor is known and does not match', async () => {
    installed = await installGh();
    const { claim } = await load('github-issues.mjs');
    const result = await claim(
      { id: '60', updatedAt: T0, assignee: null },
      { currentActor: { id: 'me' } },
    );

    expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-stale' });
    expect(String(result.detail)).toMatch(/another actor|reassigned/i);
    expect(String(result.detail)).not.toMatch(/could not|unresolved|unknown|unable/i);
    expect(String(result.detail)).not.toContain('someone-else');
  });

  it('says the actor could not be resolved — a different detail — when the current actor is known unknown (explicit null) and the item is assigned', async () => {
    installed = await installGh();
    const { claim } = await load('github-issues.mjs');
    const result = await claim({ id: '61', updatedAt: T0, assignee: null }, { currentActor: null });

    expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-stale' });
    expect(String(result.detail)).toMatch(
      /could not|unresolved|unknown|unable to (confirm|resolve)/i,
    );
    expect(String(result.detail)).not.toMatch(/another actor/i);
    expect(String(result.detail)).not.toContain('someone-else');
  });
});

// --- RP-221 round 2: an unreadable assignee is never read as unassigned ------
//
// r1-security-scanner.md advisory: `jira.mjs`'s `fields.assignee?.accountId ??
// null` and `github-issues.mjs`'s `assignee?.login ?? ''` (filtered as empty)
// both fold "assigned, but this shape has no id I can read" onto the exact
// same value as "unassigned" — `null` — which is the fail-OPEN direction
// `.claude/rules/invariants.md` names explicitly: "a field that is PRESENT in
// a shape the guard does not accept is the refusal case". An issue really can
// carry an assignee object with no `accountId` (a deactivated Jira account
// past GDPR anonymisation still leaves the field present) or a GitHub
// assignee entry with no resolvable `login`; either must be read as "assigned
// to someone nobody here can match", never as "nobody is assigned".

describe('an assignee present in a shape this adapter cannot read is never mistaken for unassigned (RP-221 round 2)', () => {
  const CANARY = 'rp221-unreadable-canary@example.invalid';

  it('jira: an assignee object with no readable accountId holds the item, and never mistakes it for unassigned', async () => {
    const { toTicket } = await load('jira.mjs');
    const issue = (assignee: unknown) => ({
      key: 'RP-70',
      fields: {
        summary: 's',
        status: { name: 'To Do', statusCategory: { key: 'new' } },
        labels: [],
        issuelinks: [],
        assignee,
      },
    });
    const ticket = toTicket(issue({ emailAddress: CANARY, displayName: 'Someone Human' }));

    // The one assertion this test exists for: NOT the same value `toTicket`
    // gives an issue that genuinely carries no assignee at all.
    expect(ticket.assignee, JSON.stringify(ticket.assignee)).not.toBeNull();
    expect(JSON.stringify(ticket)).not.toContain(CANARY);

    const { selectionOf } = await load('core.mjs');
    const selection = selectionOf(ticket, { currentActor: { id: 'acct-me' } });
    expect(selection.eligible).toBe(false);
    expect(selection.causes).toEqual(['assigned']);
    expect(JSON.stringify(selection)).not.toContain(CANARY);
  });

  it('github-issues: an assignees entry with no login holds the item, and never mistakes it for unassigned', async () => {
    const { toTicket } = await load('github-issues.mjs');
    const issue = {
      number: 71,
      title: 's',
      state: 'OPEN',
      labels: [],
      body: '',
      url: 'https://example.invalid/71',
      createdAt: '2026-08-01T00:00:00Z',
      // No `login` at all — the shape a partially-deleted or app-installed
      // assignee entry can carry.
      assignees: [{}],
    };
    const ticket = toTicket(issue as never);

    expect(ticket.assignee, JSON.stringify(ticket.assignee)).not.toBeNull();

    const { selectionOf } = await load('core.mjs');
    const selection = selectionOf(ticket, { currentActor: { id: 'acct-me' } });
    expect(selection.eligible).toBe(false);
    expect(selection.causes).toEqual(['assigned']);
  });

  it('jira claim(): an unreadable assignee refuses as claim-stale rather than proceeding as unassigned', async () => {
    const T0 = '2026-09-06T00:00:00.000Z';
    let posted = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const method = String(init.method ?? 'GET');
      const pathname = new URL(String(input)).pathname;
      if (method === 'GET' && pathname === '/rest/api/3/issue/RP-72') {
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
                // Present, but unreadable — no accountId.
                assignee: { emailAddress: 'someone@example.invalid' },
              },
            }),
          text: () => Promise.resolve(''),
        });
      }
      if (method === 'POST' && /\/transitions$/.test(pathname)) {
        posted = true;
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

    try {
      const { claim } = await load('jira.mjs');
      const result = await claim(
        { id: 'RP-72', updatedAt: T0, assignee: null },
        {
          transitionId: '21',
          env: {
            JIRA_BASE_URL: 'https://example.invalid',
            JIRA_EMAIL: 'a@b.c',
            JIRA_API_TOKEN: 'x',
          },
          currentActor: { id: 'acct-me' },
        },
      );
      expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-stale' });
      expect(posted).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('github-issues claim(): an unreadable assignee refuses as claim-stale rather than proceeding as unassigned', async () => {
    const T0 = '2026-09-06T00:00:00.000Z';
    const { mkdtemp, writeFile, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(path.join(tmpdir(), 'rp221-gh-unreadable-'));
    const logPath = path.join(dir, 'calls.log');
    await writeFile(logPath, '');
    const installed = await stubCommand(
      'gh',
      `
        const fs = require('node:fs');
        fs.appendFileSync(${JSON.stringify(logPath)}, args.join(' ') + '\\n');
        if (args[0] === 'issue' && args[1] === 'view') {
          return { stdout: JSON.stringify({
            state: 'OPEN',
            labels: [],
            updatedAt: ${JSON.stringify(T0)},
            assignees: [{}],
          }) + '\\n' };
        }
        if (args[0] === 'issue' && args[1] === 'edit') {
          return { stdout: '' };
        }
        return { stdout: '[]\\n' };
      `,
    );
    try {
      const { claim } = await load('github-issues.mjs');
      const result = await claim(
        { id: '73', updatedAt: T0, assignee: null },
        { currentActor: { id: 'me' } },
      );
      const lines = (await readFile(logPath, 'utf8')).split('\n').filter(Boolean);
      const editCalls = lines.filter((line) => line.startsWith('issue edit')).length;
      expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-stale' });
      expect(editCalls).toBe(0);
    } finally {
      installed.restore();
    }
  });
});

// --- RP-221 round 2: the CLI wires the resolved actor into selection ---------
//
// r1-code-reviewer.md B3: nothing spawned `index.mjs next` against a tracker
// adapter that actually carries an assignee and checked that the resolved
// actor reached `selectNext`. `queue-owner.test.ts` is the shape this mirrors
// for the `owner` marker (AR-132) — a CLI-level test, not a module-level call
// into `core.mjs` directly, because the wiring between `adapter.currentActor()`
// and `selectNext`'s `currentActor` option lives in `index.mjs` and nowhere
// else is it exercised end to end.
//
// The second case below — a self-assigned item is SELECTED — is also the one
// that would go red the moment `index.mjs` stopped passing `currentActor`
// into `selectNext` at all: with the option dropped, `assigned` always holds
// (an assigned item with an unconfirmed actor is never eligible), so the
// self-assigned item would report `ticket: null` instead of being taken.

describe('index.mjs next threads the resolved tracker identity into selection (RP-221 round 2)', () => {
  let installed: StubHandle | null = null;

  afterEach(() => {
    installed?.restore();
    installed = null;
  });

  const run = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      execFile(process.execPath, [path.join(queueDir, 'index.mjs'), ...args], {}, (e, out, err) =>
        resolve({
          code: e && typeof e.code === 'number' ? e.code : 0,
          stdout: String(out),
          stderr: String(err),
        }),
      );
    });

  const issue = (login: string) => ({
    number: 9,
    title: 'assignee-gated work',
    body: '',
    state: 'OPEN',
    labels: [],
    url: 'https://example.invalid/9',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    // Explicit and empty, not absent: an absent `comments` array reads as an
    // incomplete commentary window (SELECT then goes UNVERIFIABLE) — a real
    // finding for a live tracker, but a distraction from what this describe
    // block is pinning. RP-220 owns that check; RP-221 owns this one.
    comments: [],
    assignees: [{ login }],
  });

  const rig = async (assignedLogin: string): Promise<string> => {
    const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(path.join(tmpdir(), 'assignee-cli-'));
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
    await writeFile(
      path.join(dir, '.claude', 'queue.json'),
      JSON.stringify({ adapter: 'github-issues', options: { issues: [issue(assignedLogin)] } }),
    );
    return path.join(dir, '.claude', 'queue.json');
  };

  it('holds an item assigned to another actor with the `assigned` cause', async () => {
    installed = await stubCommand(
      'gh',
      `
        if (args[0] === 'api' && args[1] === 'user') return { stdout: 'me\\n' };
        return { stdout: '[]\\n' };
      `,
    );
    const cfg = await rig('someone-else');
    const result = await run(['next', '--config', cfg, '--json']);

    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ticket).toBeNull();
    expect(parsed.skipped[0].causes).toEqual(['assigned']);
  });

  it('selects an item assigned to the current actor, resolved through the tracker', async () => {
    installed = await stubCommand(
      'gh',
      `
        if (args[0] === 'api' && args[1] === 'user') return { stdout: 'me\\n' };
        return { stdout: '[]\\n' };
      `,
    );
    const cfg = await rig('me');
    const result = await run(['next', '--config', cfg, '--json']);

    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ticket?.id).toBe('9');
  });
});
