import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Extraction brief §6.6: the second adapter, whose only job is to prove the seam
// holds. If adding it needed a change above the seam, the seam was in the wrong
// place — so this file also asserts that core.mjs was not touched to accommodate it.

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

interface Ticket {
  id: string;
  title: string;
  state: string;
  labels: string[];
  tier: string;
  blockedBy: Array<{ id: string; resolved: boolean }>;
  blocks: string[];
  priority: number;
  createdAt: string | null;
  triage: boolean;
  trigger: string | null;
}

/** An issue in the shape the Jira REST search returns. */
const issue = (over: Record<string, unknown> = {}) => ({
  key: 'ABC-13',
  fields: {
    summary: 'add a route',
    status: { name: 'To Do', statusCategory: { key: 'new' } },
    labels: [],
    priority: null,
    created: '2026-07-01T00:00:00.000+0000',
    issuelinks: [],
    ...((over.fields as Record<string, unknown>) ?? {}),
  },
  ...Object.fromEntries(Object.entries(over).filter(([key]) => key !== 'fields')),
});

const blockedByLink = (key: string, categoryKey: string) => ({
  type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  inwardIssue: { key, fields: { status: { statusCategory: { key: categoryKey } } } },
});

const blocksLink = (key: string) => ({
  type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  outwardIssue: { key, fields: { status: { statusCategory: { key: 'new' } } } },
});

describe('the jira adapter satisfies the same contract, with no change above the seam', () => {
  it('implements every named operation', async () => {
    const { ADAPTER_CONTRACT } = await load('core.mjs');
    const adapter = await load('jira.mjs');
    for (const operation of ADAPTER_CONTRACT as string[]) {
      expect(typeof adapter[operation], operation).toBe('function');
    }
    expect(adapter.name).toBe('jira');
  });

  it('is resolvable from the registry', async () => {
    const { resolveAdapter } = await load('index.mjs');
    expect((await resolveAdapter('jira')).name).toBe('jira');
  });

  it('reuses the shared selection logic instead of reimplementing it', async () => {
    const source = await readFile(path.join(queueDir, 'jira.mjs'), 'utf8');
    expect(source).toMatch(/from '\.\/core\.mjs'/);
    // an adapter that re-derives eligibility is a second answer to the same
    // question, and the two will disagree
    expect(source).not.toMatch(/export const (selectionOf|sortCandidates|stopConditionOf)/);
  });
});

describe('jira → the neutral ticket shape', () => {
  it('maps the key, summary and creation time', async () => {
    const { toTicket } = await load('jira.mjs');
    const t = toTicket(issue()) as Ticket;
    expect(t).toMatchObject({ id: 'ABC-13', title: 'add a route', state: 'open' });
    expect(t.createdAt).toMatch(/^2026-07-01/);
  });

  it('maps the three status categories onto the three states', async () => {
    const { toTicket } = await load('jira.mjs');
    const withCategory = (key: string) =>
      (toTicket(issue({ fields: { status: { name: 'x', statusCategory: { key } } } })) as Ticket)
        .state;
    expect(withCategory('new')).toBe('open');
    expect(withCategory('indeterminate')).toBe('in-progress');
    expect(withCategory('done')).toBe('closed');
  });

  it('derives tier, trigger and triage from labels', async () => {
    const { toTicket } = await load('jira.mjs');
    const withLabels = (labels: string[]) => toTicket(issue({ fields: { labels } })) as Ticket;
    expect(withLabels(['elevated']).tier).toBe('elevated');
    expect(withLabels(['trigger-auto']).trigger).toBe('auto');
    expect(withLabels(['trigger-human']).trigger).toBe('human');
    expect(withLabels(['triage']).triage).toBe(true);
    expect(withLabels([]).tier).toBe('normal');
    expect(withLabels([]).trigger).toBeNull();
  });

  // AR-45, owner ruling: `human-review` is a GitHub word. On this board it is a
  // workflow label meaning "a human is looking at it" — nothing to do with the
  // autonomy tier — so reading it as `elevated` rations the queue on a signal
  // that means something else, and rations it against items nobody marked.
  // `elevated` is the marker on both adapters; the plan-md side already spells
  // it `[elevated]`.
  it('reads the elevated tier from an elevated label and not from human-review', async () => {
    const { toTicket } = await load('jira.mjs');
    const tierOf = (labels: string[]) => (toTicket(issue({ fields: { labels } })) as Ticket).tier;
    expect(tierOf(['elevated'])).toBe('elevated');
    // the old marker is now an ordinary label: it must not ration anything
    expect(tierOf(['human-review'])).toBe('normal');
  });

  it('🔴 reads blockers from ISSUE LINKS and each blocker’s own status', async () => {
    const { toTicket } = await load('jira.mjs');
    const t = toTicket(
      issue({
        fields: {
          labels: ['ready'],
          issuelinks: [blockedByLink('ABC-7', 'done'), blockedByLink('ABC-9', 'indeterminate')],
        },
      }),
    ) as Ticket;
    // the label says ready; the links are the dependency and one is still open
    expect(t.blockedBy).toEqual([
      { id: 'ABC-7', resolved: true },
      { id: 'ABC-9', resolved: false },
    ]);

    const { selectionOf } = await load('core.mjs');
    expect(selectionOf(t).eligible).toBe(false);
  });

  it('a blocker with no readable status counts as unresolved', async () => {
    const { toTicket } = await load('jira.mjs');
    const t = toTicket(
      issue({
        fields: {
          issuelinks: [{ type: { inward: 'is blocked by' }, inwardIssue: { key: 'ABC-7' } }],
        },
      }),
    ) as Ticket;
    expect(t.blockedBy).toEqual([{ id: 'ABC-7', resolved: false }]);
  });

  it('ignores link types that are not a dependency', async () => {
    const { toTicket } = await load('jira.mjs');
    const t = toTicket(
      issue({
        fields: {
          issuelinks: [
            {
              type: { inward: 'relates to', outward: 'relates to' },
              inwardIssue: { key: 'ABC-2' },
            },
            { type: { inward: 'is duplicated by' }, inwardIssue: { key: 'ABC-3' } },
          ],
        },
      }),
    ) as Ticket;
    expect(t.blockedBy).toEqual([]);
  });

  it('collects what it blocks, so the sort can prefer it', async () => {
    const { toTicket } = await load('jira.mjs');
    const t = toTicket(issue({ fields: { issuelinks: [blocksLink('ABC-20')] } })) as Ticket;
    expect(t.blocks).toEqual(['ABC-20']);
  });

  it('maps priority names to a comparable number and defaults to the lowest', async () => {
    const { toTicket } = await load('jira.mjs');
    const withPriority = (priority: unknown) =>
      (toTicket(issue({ fields: { priority } })) as Ticket).priority;
    expect(withPriority({ name: 'Highest' })).toBe(1);
    expect(withPriority({ name: 'High' })).toBe(2);
    expect(withPriority({ name: 'Medium' })).toBe(3);
    expect(withPriority({ name: 'Low' })).toBe(4);
    expect(withPriority(null)).toBe(999);
    expect(withPriority({ name: 'Something custom' })).toBe(999);
  });

  it('maps a whole search response, offline', async () => {
    const { listEligible } = await load('jira.mjs');
    const tickets = (await listEligible({
      issues: [
        issue({ key: 'ABC-1' }),
        issue({
          key: 'ABC-2',
          fields: { status: { name: 'Done', statusCategory: { key: 'done' } } },
        }),
      ],
    })) as Ticket[];
    // closed items never reach selection
    expect(tickets.map((t) => t.id)).toEqual(['ABC-1']);
  });
});

describe('the JQL it builds', () => {
  /**
   * The parenthesised groups that carry the `labels IS EMPTY` escape hatch.
   *
   * ⚠ The JQL gotcha the adapter already documents: `labels != x` does **not**
   * match an issue whose labels field is empty. An exclusion outside such a group
   * therefore hides every unlabelled item — which is most of them — so this is
   * how a new exclusion clause reintroduces the hole while still reading right.
   */
  const guardedGroups = (jql: string): string[] =>
    [...jql.matchAll(/\(([^()]*)\)/g)]
      .map((match) => match[1]!)
      .filter((group) => /labels IS EMPTY/i.test(group));

  // AR-45: `triage` is the loop's own proposals; `operator-queue` is the owner's
  // lane, and an item there is work a HUMAN has taken. The loop picking one up is
  // two sessions on one task. The exclusion belongs in the adapter's own filter,
  // not in a hand-written `options.jql` a reinstall would drop.
  it('excludes triage and the operator queue explicitly, not merely by a missing marker', async () => {
    const { buildJql } = await load('jira.mjs');
    const jql = buildJql({ project: 'ABC' }) as string;
    expect(jql).toContain('project = ABC');

    for (const label of ['triage', 'operator-queue']) {
      // belt and braces: an item carrying BOTH ready and the label stays unselectable
      expect(jql, label).toContain(label);
      const group = guardedGroups(jql).find((candidate) => candidate.includes(label));
      expect(
        group,
        `${label} is excluded outside a group carrying "labels IS EMPTY"`,
      ).toBeDefined();

      // 🔴 The OPERATOR, not merely the label's presence. `labels = triage` sits
      // in the same guarded group, reads almost identically, and selects exactly
      // the two lanes this clause exists to keep out — the loop's own proposals
      // and the owner's queue. Asserting only that the label appears somewhere
      // lets that inversion through, which is how this test was weakened once.
      expect(group!, `${label} must be excluded with !=`).toMatch(
        new RegExp(String.raw`labels\s*!=\s*"?${label}"?`, 'i'),
      );
      expect(group!, `${label} must never be REQUIRED`).not.toMatch(
        new RegExp(String.raw`labels\s*=\s*"?${label}"?`, 'i'),
      );
    }

    // and nothing excludes either label a second time, unguarded, elsewhere in
    // the query — one such clause is enough to drop every unlabelled item
    const outsideTheGroups = jql.replace(/\([^()]*labels IS EMPTY[^()]*\)/gi, '');
    expect(outsideTheGroups).not.toMatch(/triage|operator-queue/i);
  });

  it('drops an item parked in the operator queue and takes the same item without that label', async () => {
    const { listEligible } = await load('jira.mjs');
    const idsFor = async (labels: string[]) =>
      (
        (await listEligible({ issues: [issue({ key: 'AR-9', fields: { labels } })] })) as Ticket[]
      ).map((ticket) => ticket.id);

    // the offline seam skips the query, so the filter has to hold in the adapter
    // too — a board reached by an `options.jql` override answers otherwise
    await expect(idsFor(['ready', 'operator-queue'])).resolves.toEqual([]);
    await expect(idsFor(['ready'])).resolves.toEqual(['AR-9']);
  });

  it('an explicit jql in the config wins over the built one', async () => {
    const { buildJql } = await load('jira.mjs');
    // AR-51: an override may narrow the query, never point it at another board —
    // so the fixture names the same key. The earlier fixture (`project = OTHER`)
    // is exactly the case buildJql now refuses; jira-jql-validation.test.ts pins it.
    expect(buildJql({ project: 'ABC', jql: 'project = ABC AND labels = x' })).toBe(
      'project = ABC AND labels = x',
    );
  });

  it('refuses to guess when neither a project nor a jql is configured', async () => {
    const { buildJql } = await load('jira.mjs');
    expect(() => buildJql({})).toThrow(/project|jql/i);
  });
});

// AR-45, measured on the live instance rather than inferred from a changelog:
//
//     GET  /rest/api/3/search      → 410 Gone
//     POST /rest/api/3/search/jql  → 200
//
// So every selection this adapter has run since the removal threw on the status
// line, and the loop read it as "the queue is unreadable" — the queue was fine.
//
// The replacement is NOT a URL swap: it takes its arguments in a JSON body and
// `fields` is an ARRAY there, not the comma-joined string the query parameter
// took. It also paginates by `nextPageToken`/`isLast` instead of
// `startAt`/`total` — deliberately NOT pinned here: cursor pagination is AR-54's
// scope, and a test written for it in this PR would pin an interface this change
// does not own.
describe('the search endpoint it calls', () => {
  const CREDENTIALS = {
    JIRA_BASE_URL: 'https://example.invalid',
    JIRA_EMAIL: 'a@b.c',
    JIRA_API_TOKEN: 'x',
  };

  interface Call {
    url: string;
    method: string;
    body: Record<string, unknown> | null;
  }

  const calls: Call[] = [];
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    calls.length = 0;
    realFetch = globalThis.fetch;
    // A hand-written structural stub, per the stack rules — no mocking framework
    // and no patching of module internals.
    globalThis.fetch = ((input: unknown, init: { method?: string; body?: string } = {}) => {
      calls.push({
        url: String(input),
        method: String(init.method ?? 'GET'),
        body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      });
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

  it('asks the JQL search endpoint, passing the query in a JSON body', async () => {
    const { search } = await load('jira.mjs');
    await search({ project: 'AR', limit: 25, env: CREDENTIALS });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/rest/api/3/search/jql');
    expect(new URL(call.url).search).toBe('');
    expect(call.body).toMatchObject({ maxResults: 25 });
    expect(String((call.body as { jql: unknown }).jql)).toContain('project = AR');
  });

  it('names the fields it wants as a list, because the body will not take a joined string', async () => {
    const { search } = await load('jira.mjs');
    await search({ project: 'AR', env: CREDENTIALS });

    expect(calls[0]!.body, 'the query travelled in the URL, so there is no body to read').not.toBe(
      null,
    );
    const fields = (calls[0]!.body as { fields: unknown }).fields;
    expect(Array.isArray(fields), `fields was ${JSON.stringify(fields)}`).toBe(true);
    // `description` is the one whose absence is silent: the triage dedupe reads
    // the fingerprint out of it, and without it every stop files a fresh issue.
    expect(fields as string[]).toEqual(
      expect.arrayContaining(['summary', 'status', 'labels', 'issuelinks', 'description']),
    );
  });

  // The file claims it reports "the status alone; never echo the response body,
  // which can carry the token back in an error envelope". That claim got more
  // load-bearing with this change — the query it must not echo now travels in a
  // body the same function serialises — and a claim with no test is a guess.
  it('reports the status alone, never the response body nor the query it sent', async () => {
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: () => Promise.resolve({ errorMessages: ['token tok_SENTINEL rejected'] }),
        text: () => Promise.resolve('token tok_SENTINEL rejected'),
      })) as unknown as typeof globalThis.fetch;

    const { search } = await load('jira.mjs');
    const error = await search({ project: 'AR', env: CREDENTIALS }).then(
      () => new Error('the request resolved; it was supposed to reject'),
      (thrown: unknown) => thrown as Error,
    );

    expect(error.message).toMatch(/401 Unauthorized/);
    expect(error.message, 'the error envelope reached the message').not.toMatch(/SENTINEL/);
    expect(error.message, 'the query reached the message').not.toMatch(/project = AR/);
    // the credential is never in the URL either, so it cannot reach a proxy log
    expect(error.message).not.toMatch(new RegExp(CREDENTIALS.JIRA_API_TOKEN));
  });

  it('never requests the retired search path, whichever operation does the searching', async () => {
    const { search, proposeTriage } = await load('jira.mjs');
    await search({ project: 'AR', env: CREDENTIALS });
    await proposeTriage(
      {
        finding: 'queue empty twenty times',
        part: 'PLAN.md',
        change: 'seed the queue',
        proof: 'the next run has work',
      },
      { project: 'AR', env: CREDENTIALS },
    );

    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      // the exact path, and the query-parameter form — both answer 410 Gone
      expect(new URL(call.url).pathname, call.url).not.toBe('/rest/api/3/search');
      expect(call.url, 'the retired query-parameter form').not.toMatch(/\/rest\/api\/3\/search\?/);
    }
  });
});

// AR-54: the three things the endpoint change above deliberately left out —
// timeout, retry, cursor pagination — plus the two defects they surfaced. The
// option shapes pinned here are the interface the implementation follows:
//
//     search({ ..., timeoutMs })                 default 20000; an AbortSignal
//                                                reaches fetch as `init.signal`
//     search({ ..., retry: { sleep } })          `sleep(ms)` is awaited between
//                                                attempts; tests inject a no-op
//                                                and read the ms it was given
//     search({ ..., hardCap })                   default 1000 issues; a capped
//                                                list is announced on stderr
//     proposeTriage(p, { ..., retry })           the same options travel down
//
// `search()` keeps returning `{ issues }`, now the union of every page.
describe('hardening beyond the endpoint (AR-54)', () => {
  const CREDENTIALS = {
    JIRA_BASE_URL: 'https://example.invalid',
    JIRA_EMAIL: 'a@b.c',
    JIRA_API_TOKEN: 'x',
  };

  interface Call {
    url: string;
    method: string;
    body: Record<string, unknown> | null;
    signal: AbortSignal | null;
  }

  /** One scripted response, in the shape `request` reads off `fetch`. */
  interface Scripted {
    status: number;
    statusText?: string;
    headers?: Record<string, string>;
    json?: unknown;
  }

  const calls: Call[] = [];
  const stderr: string[] = [];
  let realFetch: typeof globalThis.fetch;
  let realStderrWrite: typeof process.stderr.write;

  const reply = (scripted: Scripted) => ({
    ok: scripted.status >= 200 && scripted.status < 300,
    status: scripted.status,
    statusText: scripted.statusText ?? '',
    headers: {
      get: (name: string) =>
        scripted.headers?.[name] ?? scripted.headers?.[name.toLowerCase()] ?? null,
    },
    json: () => Promise.resolve(scripted.json ?? { issues: [] }),
    text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
  });

  /** Answer the n-th fetch with the n-th script; the last script repeats. */
  const scriptFetch = (scripts: Scripted[]) => {
    globalThis.fetch = ((
      input: unknown,
      init: { method?: string; body?: string; signal?: AbortSignal } = {},
    ) => {
      calls.push({
        url: String(input),
        method: String(init.method ?? 'GET'),
        body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
        signal: init.signal ?? null,
      });
      const scripted = scripts[Math.min(calls.length - 1, scripts.length - 1)]!;
      return Promise.resolve(reply(scripted));
    }) as unknown as typeof globalThis.fetch;
  };

  const sleeps: number[] = [];
  const noSleep = {
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };

  beforeEach(() => {
    calls.length = 0;
    sleeps.length = 0;
    stderr.length = 0;
    realFetch = globalThis.fetch;
    realStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    scriptFetch([{ status: 200, json: { issues: [] } }]);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.stderr.write = realStderrWrite;
  });

  describe('a request times out instead of hanging the loop', () => {
    it('hands fetch an AbortSignal', async () => {
      const { search } = await load('jira.mjs');
      await search({ project: 'AR', env: CREDENTIALS, timeoutMs: 20000 });
      expect(calls[0]!.signal, 'no signal reached fetch').toBeInstanceOf(AbortSignal);
    });

    it('rejects naming the timeout and the route when fetch never resolves', async () => {
      // a fetch that only ever ends by being aborted — like a stalled socket
      globalThis.fetch = ((input: unknown, init: { signal?: AbortSignal } = {}) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
          });
        })) as unknown as typeof globalThis.fetch;

      const { search } = await load('jira.mjs');
      const error = await search({ project: 'AR', env: CREDENTIALS, timeoutMs: 5 }).then(
        () => new Error('the request resolved; it was supposed to time out'),
        (thrown: unknown) => thrown as Error,
      );
      expect(error.message).toMatch(/timed out|timeout/i);
      expect(error.message).toMatch(/\b5\s*ms\b|\b5\b/);
      expect(error.message).toContain('/rest/api/3/search/jql');
    }, 2000);
  });

  describe('a transient failure is retried, and the server’s Retry-After is honoured', () => {
    it('a 429 followed by a 200 yields the 200 body', async () => {
      scriptFetch([
        { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '1' } },
        { status: 200, json: { issues: [issue({ key: 'AR-1' })] } },
      ]);
      const { search } = await load('jira.mjs');
      const response = (await search({ project: 'AR', env: CREDENTIALS, retry: noSleep })) as {
        issues: Array<{ key: string }>;
      };
      expect(calls).toHaveLength(2);
      expect(response.issues.map((i) => i.key)).toEqual(['AR-1']);
    });

    it('sleeps for the Retry-After the 429 carried, in milliseconds', async () => {
      scriptFetch([
        { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '1' } },
        { status: 200, json: { issues: [] } },
      ]);
      const { search } = await load('jira.mjs');
      await search({ project: 'AR', env: CREDENTIALS, retry: noSleep });
      expect(sleeps).toEqual([1000]);
    });

    it.each([502, 503, 504])('retries a %i like a 429', async (status) => {
      scriptFetch([
        { status, statusText: 'Gateway' },
        { status: 200, json: { issues: [] } },
      ]);
      const { search } = await load('jira.mjs');
      await expect(
        search({ project: 'AR', env: CREDENTIALS, retry: noSleep }),
      ).resolves.toBeDefined();
      expect(calls).toHaveLength(2);
    });

    it('gives up after four consecutive 503s, naming the status and the attempts', async () => {
      scriptFetch([{ status: 503, statusText: 'Service Unavailable' }]);
      const { search } = await load('jira.mjs');
      const error = await search({ project: 'AR', env: CREDENTIALS, retry: noSleep }).then(
        () => new Error('the request resolved; it was supposed to give up'),
        (thrown: unknown) => thrown as Error,
      );
      expect(calls, 'one initial attempt plus three retries').toHaveLength(4);
      expect(error.message).toMatch(/503/);
      expect(error.message).toMatch(/attempt/i);
      expect(error.message).toMatch(/\b4\b/);
    });

    it('does not retry a 401 — a bad credential is not transient', async () => {
      scriptFetch([{ status: 401, statusText: 'Unauthorized' }]);
      const { search } = await load('jira.mjs');
      await expect(search({ project: 'AR', env: CREDENTIALS, retry: noSleep })).rejects.toThrow(
        /401/,
      );
      expect(calls).toHaveLength(1);
      expect(sleeps).toEqual([]);
    });
  });

  describe('search follows the cursor, so a board longer than one page is read whole', () => {
    const twoPages = (): Scripted[] => [
      { status: 200, json: { issues: [issue({ key: 'AR-1' })], nextPageToken: 't2' } },
      { status: 200, json: { issues: [issue({ key: 'AR-2' })], isLast: true } },
    ];

    it('returns both pages as one list', async () => {
      scriptFetch(twoPages());
      const { search } = await load('jira.mjs');
      const response = (await search({ project: 'AR', env: CREDENTIALS })) as {
        issues: Array<{ key: string }>;
      };
      expect(response.issues.map((i) => i.key)).toEqual(['AR-1', 'AR-2']);
    });

    it('sends the token from page 1 in the body of the request for page 2', async () => {
      scriptFetch(twoPages());
      const { search } = await load('jira.mjs');
      await search({ project: 'AR', env: CREDENTIALS });
      expect(calls).toHaveLength(2);
      expect(calls[0]!.body).not.toHaveProperty('nextPageToken');
      expect(calls[1]!.body).toMatchObject({ nextPageToken: 't2' });
    });

    it('stops at hardCap and says on stderr that the list was capped', async () => {
      scriptFetch(twoPages());
      const { search } = await load('jira.mjs');
      const response = (await search({ project: 'AR', env: CREDENTIALS, hardCap: 1 })) as {
        issues: Array<{ key: string }>;
      };
      expect(calls, 'page 2 was fetched past the cap').toHaveLength(1);
      expect(response.issues.map((i) => i.key)).toEqual(['AR-1']);
      expect(stderr.join(''), 'nothing announced the cap').toMatch(/capped/i);
    });
  });

  describe('liveness bounds — no header or page shape may hold the loop indefinitely', () => {
    it('caps Retry-After so a hostile header cannot sleep the loop for a day', async () => {
      scriptFetch([
        { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '86400' } },
        { status: 200, json: { issues: [issue({ key: 'AR-1' })] } },
      ]);
      const { search } = await load('jira.mjs');
      const response = (await search({ project: 'AR', env: CREDENTIALS, retry: noSleep })) as {
        issues: Array<{ key: string }>;
      };
      expect(sleeps, 'the 429 was not slept on at all').toHaveLength(1);
      expect(sleeps[0], 'a day-long Retry-After was honoured verbatim').toBeLessThanOrEqual(60_000);
      expect(response.issues.map((i) => i.key)).toEqual(['AR-1']);
    });

    it(
      'stops paging when a page brings no issues, even if the token repeats',
      { timeout: 3000 },
      async () => {
        // Every page is empty and carries the same token. The stub yields to a
        // macrotask per call: a microtask-only loop would starve the event loop
        // and vitest's timeout could never fire — the run would hang instead of
        // going red.
        scriptFetch([{ status: 200, json: { issues: [], nextPageToken: 'same' } }]);
        const scripted = globalThis.fetch;
        globalThis.fetch = ((input: unknown, init?: RequestInit) =>
          new Promise((resolve) =>
            setImmediate(() => resolve(scripted(input as string, init))),
          )) as unknown as typeof globalThis.fetch;
        const { search } = await load('jira.mjs');
        const response = (await search({ project: 'AR', env: CREDENTIALS, retry: noSleep })) as {
          issues: unknown[];
        };
        expect(response).toEqual({ issues: [] });
        expect(
          calls.length,
          'an empty page with a repeating token was followed',
        ).toBeLessThanOrEqual(2);
      },
    );

    it('keeps the timeout armed while the body is read', { timeout: 2000 }, async () => {
      // Variant of the stalled-socket stub above: here the headers arrive, so
      // fetch resolves with a 200, but the body never does. The stub's json()
      // settles only when `init.signal` fires — so what is measured is whether
      // the implementation keeps its AbortController armed past the headers,
      // not whether some unrelated timer happens to reject first.
      globalThis.fetch = ((input: unknown, init: { signal?: AbortSignal } = {}) =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: () => null },
          json: () =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () =>
                reject(new DOMException('aborted', 'AbortError')),
              );
            }),
          text: () => Promise.resolve(''),
        })) as unknown as typeof globalThis.fetch;

      const { search } = await load('jira.mjs');
      const error = await search({ project: 'AR', env: CREDENTIALS, timeoutMs: 50 }).then(
        () => new Error('the request resolved; the body was supposed to time out'),
        (thrown: unknown) => thrown as Error,
      );
      expect(error.message).toMatch(/timed out/i);
    });
  });

  describe('a priority the English ladder does not know', () => {
    it('falls back to the numeric id, so a localised board still sorts', async () => {
      const { toTicket } = await load('jira.mjs');
      const withPriority = (priority: unknown) =>
        (toTicket(issue({ fields: { priority } })) as Ticket).priority;
      expect(withPriority({ name: 'Höchste', id: '1' })).toBe(1);
      expect(withPriority({ name: 'Mittel', id: '3' })).toBe(3);
    });

    it('still sorts last with neither a known name nor an id', async () => {
      const { toTicket } = await load('jira.mjs');
      expect(
        (toTicket(issue({ fields: { priority: { name: 'Höchste' } } })) as Ticket).priority,
      ).toBe(999);
    });
  });

  describe('the triage dedupe reads every page of proposals', () => {
    it('increments a duplicate that sits on page 2 instead of filing again', async () => {
      const { proposeTriage, triageItemFor } = await load('jira.mjs');
      const proposal = {
        finding: 'queue empty twenty times',
        part: 'PLAN.md',
        change: 'seed the queue',
        proof: 'the next run has work',
      };
      const { fingerprint } = triageItemFor(proposal) as { fingerprint: string };
      const triageIssue = (key: string, text: string) =>
        issue({ key, fields: { labels: ['triage'], description: text } });

      // Answered by URL rather than by call order: the dedupe search pages, and
      // the comment that follows a hit must not be fed a search page.
      globalThis.fetch = ((input: unknown, init: { method?: string; body?: string } = {}) => {
        const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
        calls.push({
          url: String(input),
          method: String(init.method ?? 'GET'),
          body,
          signal: null,
        });
        const route = new URL(String(input)).pathname;
        if (route === '/rest/api/3/search/jql') {
          return Promise.resolve(
            reply(
              body?.nextPageToken === 't2'
                ? {
                    status: 200,
                    json: {
                      issues: [triageIssue('AR-2', `fingerprint: ${fingerprint}`)],
                      isLast: true,
                    },
                  }
                : {
                    status: 200,
                    json: {
                      issues: [triageIssue('AR-1', 'fingerprint: other')],
                      nextPageToken: 't2',
                    },
                  },
            ),
          );
        }
        return Promise.resolve(reply({ status: 200, json: {} }));
      }) as unknown as typeof globalThis.fetch;

      const result = (await proposeTriage(proposal, { project: 'AR', env: CREDENTIALS })) as {
        incremented?: string;
        filed?: string;
      };
      expect(result.filed, 'a duplicate on page 2 was filed as new').toBeUndefined();
      expect(result.incremented).toBe('AR-2');
      expect(
        calls.filter((c) => c.method === 'POST' && new URL(c.url).pathname === '/rest/api/3/issue'),
      ).toHaveLength(0);
    });
  });
});

describe('credentials and the operations that write', () => {
  it('reads credentials from the environment only — never from a file in the repo', async () => {
    const source = await readFile(path.join(queueDir, 'jira.mjs'), 'utf8');
    // the three names are read from the environment, and the default is process.env
    expect(source).toContain('JIRA_API_TOKEN');
    expect(source).toMatch(/env\s*=\s*process\.env/);
    // no default, no fallback, no example value that could be mistaken for real —
    // a placeholder that looks like a credential is a credential someone commits
    expect(source).not.toMatch(/JIRA_(API_TOKEN|EMAIL|BASE_URL)\s*(\|\||\?\?|=)\s*['"][^'"]/);
    expect(source).not.toMatch(/Basic [A-Za-z0-9+/]{16,}/);
    expect(source).not.toMatch(/@atlassian\.net['"]|atlassian\.net\/rest.*token/i);
  });

  it('says what is missing rather than failing with a 401', async () => {
    const { requireCredentials } = await load('jira.mjs');
    expect(() => requireCredentials({})).toThrow(/JIRA_BASE_URL|JIRA_EMAIL|JIRA_API_TOKEN/);
    expect(() =>
      requireCredentials({
        JIRA_BASE_URL: 'https://example.invalid',
        JIRA_EMAIL: 'a@b.c',
        JIRA_API_TOKEN: 'x',
      }),
    ).not.toThrow();
  });

  it('forces a proposal into triage and never makes it selectable', async () => {
    const { triageItemFor } = await load('jira.mjs');
    const item = triageItemFor({
      finding: 'queue empty twenty times',
      part: 'PLAN.md',
      change: 'seed the queue',
      proof: 'the next run has work',
    });
    expect(item.labels).toContain('triage');
    expect(item.labels).not.toContain('ready');
    expect(item.selectable).toBe(false);
    expect(item.body).toContain(item.fingerprint);
  });

  it('exposes no way to create work', async () => {
    const adapter = await load('jira.mjs');
    expect(Object.keys(adapter)).not.toContain('create');
    expect(Object.keys(adapter)).not.toContain('createTicket');
  });
});

// AR-45: the tier marker is the one fact a work item carries across trackers, and
// the ration in `core.mjs` reads it by that one name. Two adapters that spell it
// differently mean an item rationed on one board and waved through on the other —
// and moving this repo's queue from PLAN.md to Jira is exactly that migration.
describe('the same work item reads the same on both adapters', () => {
  it('gives a plan-md [elevated] item and a jira elevated-labelled issue one tier', async () => {
    const { parsePlan } = await load('plan-md.mjs');
    const { toTicket } = await load('jira.mjs');

    const [fromPlan] = parsePlan(
      '# P\n\n## Agent queue\n\n- rotate the signing key [elevated]\n\n## Journal\n',
    ) as Ticket[];
    const fromJira = toTicket(
      issue({ fields: { summary: 'rotate the signing key', labels: ['elevated'] } }),
    ) as Ticket;

    expect(fromJira.tier).toBe(fromPlan!.tier);
    expect(fromJira.tier).toBe('elevated');
  });

  it('gives an unmarked item the normal tier on both, so the ration is not held by default', async () => {
    const { parsePlan } = await load('plan-md.mjs');
    const { toTicket } = await load('jira.mjs');

    const [fromPlan] = parsePlan(
      '# P\n\n## Agent queue\n\n- rotate the signing key\n\n## Journal\n',
    ) as Ticket[];
    const fromJira = toTicket(
      issue({ fields: { summary: 'rotate the signing key', labels: [] } }),
    ) as Ticket;

    expect(fromJira.tier).toBe(fromPlan!.tier);
    expect(fromJira.tier).toBe('normal');
  });
});

// AR-45: which queue this repository reads is a fact about THIS repository, and
// `.claude/queue.json` is a GENERATED file — composed from the template and
// checked by `sync-agent-os.mjs --check`. So the value lands as a repo-specific
// override inside `compose()`, the same class as the `.claude/hooks/dod-checks.json`
// override that is already there. Editing the template instead would hand this
// repo's board to every generated project; exempting the file from composition
// would make the drift check stop verifying it at all.
describe('the queue this repository reads, and the one a generated project gets', () => {
  const jsonAt = async (...parts: string[]): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(path.join(repoRoot, ...parts), 'utf8')) as Record<string, unknown>;

  it('reads its own board through the jira adapter', async () => {
    expect(await jsonAt('.claude', 'queue.json')).toMatchObject({
      adapter: 'jira',
      options: { project: 'AR' },
    });
  });

  it('leaves a generated project on the zero-setup default rather than this repo’s board', async () => {
    const template = await jsonAt('templates', 'agent-os', 'universal', '.claude', 'queue.json');
    expect(template.adapter).toBe('plan-md');
    // a fresh project has no Jira, no credentials and certainly no AR board
    expect(JSON.stringify(template)).not.toMatch(/jira|"AR"/i);
  });

  // The drift check itself is NOT re-run here: `dogfood.test.ts` already spawns
  // `sync-agent-os.mjs --check` under the same suite, and a second spawn buys the
  // same answer at the same cost. What this file owns is the pair of values that
  // check would let through either way — the two assertions above.
  it('carries every key the template ships, so the override derives rather than replaces', async () => {
    const template = await jsonAt('templates', 'agent-os', 'universal', '.claude', 'queue.json');
    const mine = await jsonAt('.claude', 'queue.json');
    // `adapter` and `options` are this repo's to decide; anything else the
    // template grows later must arrive here on the next sync rather than being
    // dropped by a literal that only knew about today's two keys.
    for (const key of Object.keys(template)) {
      if (key === 'adapter' || key === 'options') continue;
      expect(mine, `template key "${key}" was dropped by the override`).toHaveProperty(key);
    }
  });
});

describe('composition', () => {
  it('layers.json classifies the adapter as process', async () => {
    const manifest = JSON.parse(
      await readFile(
        path.join(repoRoot, 'templates', 'agent-os', 'universal', 'layers.json'),
        'utf8',
      ),
    ) as Record<string, string[]>;
    expect(manifest['process']).toContain('.claude/scripts/queue/jira.mjs');
  });

  it('the loop skill names all three adapters, so the choice is visible', async () => {
    const skill = await readFile(
      path.join(
        repoRoot,
        'templates',
        'agent-os',
        'universal',
        '.claude',
        'skills',
        'loop',
        'SKILL.md',
      ),
      'utf8',
    );
    for (const adapter of ['plan-md', 'github-issues', 'jira']) {
      expect(skill, adapter).toContain(adapter);
    }
  });
});
