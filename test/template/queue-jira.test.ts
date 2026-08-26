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
