import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stubCommand, type StubHandle } from '../helpers/stub-command.js';

// RP-220 — verified, stale-safe tracker claims.
//
// Every case here targets `claim(ticket, opts)` gaining a pre-read/read-back
// protocol around the mutation it already performs. Nothing here touches
// production code: these are the failing (Red) tests that pin the contract
// down before it exists.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const queueDir = path.join(scriptsDir, 'queue');
const claimRecordsScript = path.join(scriptsDir, 'lib', 'claim-records.mjs');

const load = (file: string) => import(pathToFileURL(path.join(queueDir, file)).href);

const T0 = '2026-09-01T00:00:00.000Z';
const bump = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString();

const git = (args: string[], cwd: string): string =>
  execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

interface NeutralTicket {
  id: string;
  title: string;
  url?: string | null;
  state?: string;
  labels?: string[];
  blockedBy?: Array<{ id: string; resolved: boolean }>;
  blocks?: string[];
  priority?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
  commentary?: { count: number; ids: string[]; complete: boolean };
}

const neutralTicket = (over: Partial<NeutralTicket> = {}): NeutralTicket => ({
  id: 'RP-1',
  title: 'do the thing',
  url: null,
  state: 'open',
  labels: [],
  blockedBy: [],
  blocks: [],
  priority: 999,
  createdAt: T0,
  updatedAt: T0,
  commentary: { count: 0, ids: [], complete: true },
  ...over,
});

/**
 * A git-backed project root carrying a valid `.rig/revalidation.json` and a
 * SELECT baseline for `ticket`, exactly like `content-blind-revalidation.test.ts`
 * sets one up — the minimum `recordClaimTransition` needs to have something to
 * update rather than refuse as missing.
 */
const bootstrapProject = async (ticket: NeutralTicket, claimedState: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'rp220-claim-'));
  git(['init', '-q', '-b', 'master'], root);
  await mkdir(path.join(root, '.rig'), { recursive: true });
  await writeFile(
    path.join(root, '.rig', 'revalidation.json'),
    JSON.stringify({
      schemaVersion: 1,
      detection: {
        mode: 'pull',
        sources: ['run-state', 'journal'],
        acceptedLatency: '24h',
        push: false,
      },
      pairedFacts: [],
    }),
  );
  git(['add', '.rig/revalidation.json'], root);
  git(['commit', '-q', '-m', 'seed'], root);

  const claimRecords = await import(
    `${pathToFileURL(claimRecordsScript).href}?bootstrap=${Date.now()}-${Math.random()}`
  );
  const result = claimRecords.revalidateClaim({
    projectRoot: root,
    ticket,
    point: 'SELECT',
    claimedState,
    targetSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    allowCreate: true,
    isResume: false,
  });
  if (result.result !== 'BASELINE_CREATED') {
    throw new Error(`test setup: could not create a claim baseline: ${JSON.stringify(result)}`);
  }
  return root;
};

const claimPathFor = (root: string, id: string) => path.join(root, '.rig', 'claims', `${id}.json`);

// --- a small in-memory fake Jira, behind a stubbed fetch --------------------

interface FetchCall {
  url: string;
  method: string;
}

interface JsonReply {
  status: number;
  statusText?: string;
  json?: unknown;
}

const reply = (scripted: JsonReply) => ({
  ok: scripted.status >= 200 && scripted.status < 300,
  status: scripted.status,
  statusText: scripted.statusText ?? '',
  headers: { get: () => null },
  json: () => Promise.resolve(scripted.json ?? {}),
  text: () => Promise.resolve(JSON.stringify(scripted.json ?? {})),
});

/**
 * Models exactly what the brief measured live: the global `21 → In Progress`
 * transition is always offered; a transition POST — including a looped one —
 * appends one changelog history and moves `updated` to that history's
 * `created`.
 */
class FakeJira {
  id: string;
  statusCategory: string;
  statusName: string;
  updated: string;
  histories: Array<{ created: string; items: Array<{ field: string }> }>;
  calls: FetchCall[];

  constructor({
    id,
    statusCategory = 'new',
    statusName = 'To Do',
    updated,
  }: {
    id: string;
    statusCategory?: string;
    statusName?: string;
    updated: string;
  }) {
    this.id = id;
    this.statusCategory = statusCategory;
    this.statusName = statusName;
    this.updated = updated;
    this.histories = [];
    this.calls = [];
  }

  applyTransition() {
    const created = bump(this.updated, 1000 + this.histories.length * 1000);
    this.statusCategory = 'indeterminate';
    this.statusName = 'In Progress';
    this.updated = created;
    this.histories.push({ created, items: [{ field: 'status' }] });
    return created;
  }

  handle(url: string, method: string): JsonReply {
    this.calls.push({ url, method });
    const u = new URL(url);
    if (method === 'POST' && /\/transitions$/.test(u.pathname)) {
      this.applyTransition();
      return { status: 204 };
    }
    if (method === 'GET' && /\/transitions$/.test(u.pathname)) {
      return {
        status: 200,
        json: {
          transitions: [
            {
              id: '21',
              to: { status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
            },
          ],
        },
      };
    }
    if (method === 'GET' && /\/changelog$/.test(u.pathname)) {
      const maxResults = Number(u.searchParams.get('maxResults') ?? '0');
      const startAt = Number(u.searchParams.get('startAt') ?? '0');
      const values = maxResults === 1 ? this.histories.slice(0, 1) : this.histories.slice(startAt);
      return { status: 200, json: { total: this.histories.length, startAt, maxResults, values } };
    }
    if (method === 'GET' && /\/issue\/[^/]+$/.test(u.pathname)) {
      const fields = String(u.searchParams.get('fields') ?? '');
      const body: Record<string, unknown> = {};
      if (fields.includes('status')) {
        body.status = { name: this.statusName, statusCategory: { key: this.statusCategory } };
      }
      if (fields.includes('updated') || fields === '') body.updated = this.updated;
      return { status: 200, json: { fields: body } };
    }
    return { status: 404, statusText: 'Not Found' };
  }
}

const installFetch = (fake: FakeJira) => {
  globalThis.fetch = ((input: unknown, init: { method?: string } = {}) =>
    Promise.resolve(
      reply(fake.handle(String(input), String(init.method ?? 'GET'))),
    )) as unknown as typeof globalThis.fetch;
};

const CREDENTIALS = {
  JIRA_BASE_URL: 'https://example.invalid',
  JIRA_EMAIL: 'a@b.c',
  JIRA_API_TOKEN: 'x',
};

describe('jira claim() is verified and stale-selection safe (RP-220)', () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('refuses as claim-stale when the item moved to In Progress after selection, with no mutation', async () => {
    const ticket = neutralTicket({ id: 'RP-1', updatedAt: T0 });
    const fake = new FakeJira({
      id: 'RP-1',
      statusCategory: 'indeterminate',
      statusName: 'In Progress',
      updated: T0,
    });
    installFetch(fake);

    const { claim } = await load('jira.mjs');
    const result = await claim(ticket, { transitionId: '21', env: CREDENTIALS });

    expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-stale' });
    expect(
      fake.calls.filter(
        (c) => c.method === 'POST' && /\/transitions$/.test(new URL(c.url).pathname),
      ),
    ).toHaveLength(0);
  });

  it('refuses as claim-stale when the item was edited after selection (same status, newer updated), with no mutation', async () => {
    const ticket = neutralTicket({ id: 'RP-1', updatedAt: T0 });
    const fake = new FakeJira({
      id: 'RP-1',
      statusCategory: 'new',
      statusName: 'To Do',
      updated: bump(T0, 60_000),
    });
    installFetch(fake);

    const { claim } = await load('jira.mjs');
    const result = await claim(ticket, { transitionId: '21', env: CREDENTIALS });

    expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-stale' });
    expect(
      fake.calls.filter(
        (c) => c.method === 'POST' && /\/transitions$/.test(new URL(c.url).pathname),
      ),
    ).toHaveLength(0);
  });

  it('verifies and records the workflow claim for the sole claimant of an unchanged snapshot', async () => {
    const ticket = neutralTicket({ id: 'RP-3', updatedAt: T0 });
    const root = await bootstrapProject(ticket, 'in-progress');
    const fake = new FakeJira({
      id: 'RP-3',
      statusCategory: 'new',
      statusName: 'To Do',
      updated: T0,
    });
    installFetch(fake);

    const { claim } = await load('jira.mjs');
    const result = await claim(ticket, { transitionId: '21', env: CREDENTIALS, projectRoot: root });

    expect(result).toMatchObject({ ok: true, claimed: true, workflowClaimRecorded: true });
    expect(
      fake.calls.filter(
        (c) => c.method === 'POST' && /\/transitions$/.test(new URL(c.url).pathname),
      ),
    ).toHaveLength(1);

    const claimPath = claimPathFor(root, 'RP-3');
    expect(existsSync(claimPath)).toBe(true);
    const persisted = JSON.parse(await readFile(claimPath, 'utf8'));
    expect(persisted.workflowClaim).toEqual({ claimedState: 'in-progress' });
  });

  it('refuses as claim-contended when a foreign change lands between the pre-read and the read-back, and never records a workflow claim', async () => {
    const ticket = neutralTicket({ id: 'RP-4', updatedAt: T0 });
    const root = await bootstrapProject(ticket, 'in-progress');
    const fake = new FakeJira({
      id: 'RP-4',
      statusCategory: 'new',
      statusName: 'To Do',
      updated: T0,
    });

    let sawOwnTransition = false;
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const url = String(input);
      const method = String(init.method ?? 'GET');
      const scripted = fake.handle(url, method);
      // Immediately after OUR OWN transition POST lands, a second controller's
      // write (a foreign transition) races in before we get to read back —
      // exactly the shape the brief's rationale describes: two claims from one
      // snapshot always leave two histories.
      if (method === 'POST' && /\/transitions$/.test(new URL(url).pathname) && !sawOwnTransition) {
        sawOwnTransition = true;
        fake.applyTransition();
      }
      return Promise.resolve(reply(scripted));
    }) as unknown as typeof globalThis.fetch;

    const { claim } = await load('jira.mjs');
    const result = await claim(ticket, { transitionId: '21', env: CREDENTIALS, projectRoot: root });

    expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-contended' });
    // the transition itself is not rolled back — the item may still be held by
    // whoever won — but nothing here recorded a workflow claim on our behalf
    const claimPath = claimPathFor(root, 'RP-4');
    const persisted = JSON.parse(await readFile(claimPath, 'utf8'));
    expect(persisted.workflowClaim).toBeUndefined();
  });

  it('resolves as claim-unverifiable, never rejects, when a read-back request fails after the POST', async () => {
    const ticket = neutralTicket({ id: 'RP-5', updatedAt: T0 });
    const fake = new FakeJira({
      id: 'RP-5',
      statusCategory: 'new',
      statusName: 'To Do',
      updated: T0,
    });
    let transitioned = false;
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      const url = String(input);
      const method = String(init.method ?? 'GET');
      const u = new URL(url);
      if (method === 'POST' && /\/transitions$/.test(u.pathname)) {
        transitioned = true;
        fake.calls.push({ url, method });
        return Promise.resolve(reply({ status: 204 }));
      }
      if (transitioned && method === 'GET' && /\/issue\/[^/]+$/.test(u.pathname)) {
        fake.calls.push({ url, method });
        return Promise.resolve(reply({ status: 500, statusText: 'Internal Server Error' }));
      }
      return Promise.resolve(reply(fake.handle(url, method)));
    }) as unknown as typeof globalThis.fetch;

    const { claim } = await load('jira.mjs');
    await expect(claim(ticket, { transitionId: '21', env: CREDENTIALS })).resolves.toMatchObject({
      ok: false,
      claimed: false,
      reason: 'claim-unverifiable',
    });
  });

  it('refuses as claim-unverifiable with zero requests when the ticket carries no selection snapshot', async () => {
    const ticket = neutralTicket({ id: 'RP-6', updatedAt: null });
    const calls: FetchCall[] = [];
    globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
      calls.push({ url: String(input), method: String(init.method ?? 'GET') });
      return Promise.resolve(reply({ status: 200, json: {} }));
    }) as unknown as typeof globalThis.fetch;

    const { claim } = await load('jira.mjs');
    const result = await claim(ticket, { transitionId: '21', env: CREDENTIALS });

    expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-unverifiable' });
    expect(calls).toHaveLength(0);
  });

  // The Done criterion: two controllers claiming from the same unchanged
  // snapshot can never both receive a truthful successful claim. A
  // controllable scheduler drives specific interleavings of the two
  // controllers' request sequences.
  describe('the Done criterion: two controllers racing from one unchanged snapshot', () => {
    const assertShape = (result: { claimed: unknown }) => {
      expect(
        typeof result.claimed,
        `claim() must answer a boolean claimed, got ${JSON.stringify(result)}`,
      ).toBe('boolean');
    };

    it('fully sequential A-then-B: the second controller finds it already moved', async () => {
      const ticket = neutralTicket({ id: 'RP-7', updatedAt: T0 });
      const root = await bootstrapProject(ticket, 'in-progress');
      const fake = new FakeJira({
        id: 'RP-7',
        statusCategory: 'new',
        statusName: 'To Do',
        updated: T0,
      });
      installFetch(fake);
      const { claim } = await load('jira.mjs');

      const resultA = await claim(ticket, {
        transitionId: '21',
        env: CREDENTIALS,
        projectRoot: root,
      });
      const resultB = await claim(ticket, {
        transitionId: '21',
        env: CREDENTIALS,
        projectRoot: root,
      });

      assertShape(resultA);
      assertShape(resultB);
      const trueCount = [resultA, resultB].filter((r) => r.claimed === true).length;
      expect(
        trueCount,
        `both A and B were claimed:true — ${JSON.stringify({ resultA, resultB })}`,
      ).toBeLessThanOrEqual(1);
      expect(resultA.claimed).toBe(true);
      expect(resultB).toMatchObject({ claimed: false, reason: 'claim-stale' });
    });

    it('fully sequential B-then-A (order reversed): still at most one verified', async () => {
      const ticket = neutralTicket({ id: 'RP-8', updatedAt: T0 });
      const root = await bootstrapProject(ticket, 'in-progress');
      const fake = new FakeJira({
        id: 'RP-8',
        statusCategory: 'new',
        statusName: 'To Do',
        updated: T0,
      });
      installFetch(fake);
      const { claim } = await load('jira.mjs');

      const resultB = await claim(ticket, {
        transitionId: '21',
        env: CREDENTIALS,
        projectRoot: root,
      });
      const resultA = await claim(ticket, {
        transitionId: '21',
        env: CREDENTIALS,
        projectRoot: root,
      });

      assertShape(resultA);
      assertShape(resultB);
      const trueCount = [resultA, resultB].filter((r) => r.claimed === true).length;
      expect(
        trueCount,
        `both were claimed:true — ${JSON.stringify({ resultA, resultB })}`,
      ).toBeLessThanOrEqual(1);
      expect(resultB.claimed).toBe(true);
      expect(resultA).toMatchObject({ claimed: false, reason: 'claim-stale' });
    });

    /**
     * A tiny controllable scheduler: `fetch` never resolves on its own; a call
     * queues a `{url, method, resolve}` record and the test releases them in
     * a chosen order via `releaseWhere`, flushing microtasks between releases
     * so the caller's next `await` has a chance to enqueue its next call.
     */
    const gatedFetch = (fake: FakeJira) => {
      const queue: Array<{ url: string; method: string; resolve: (value: unknown) => void }> = [];
      const fetchImpl = ((input: unknown, init: { method?: string } = {}) =>
        new Promise((resolve) => {
          queue.push({ url: String(input), method: String(init.method ?? 'GET'), resolve });
        })) as unknown as typeof globalThis.fetch;

      const flush = async () => {
        for (let i = 0; i < 30; i += 1) await Promise.resolve();
      };

      const releaseWhere = async (
        predicate: (call: { url: string; method: string }) => boolean,
        pick: 'first' | 'last' = 'first',
      ) => {
        await flush();
        const matches = queue
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => predicate(item));
        if (matches.length === 0) {
          throw new Error(
            `no pending call matched; queue was: ${
              queue.map((q) => `${q.method} ${q.url}`).join(' | ') || '(empty)'
            }`,
          );
        }
        const chosen = pick === 'first' ? matches[0]! : matches[matches.length - 1]!;
        queue.splice(chosen.index, 1);
        chosen.item.resolve(reply(fake.handle(chosen.item.url, chosen.item.method)));
        await flush();
      };

      return { fetchImpl, releaseWhere, flush };
    };

    const isPreOrReadBack = (c: { url: string; method: string }) =>
      c.method === 'GET' &&
      /\/issue\/[^/]+$/.test(new URL(c.url).pathname) &&
      String(new URL(c.url).searchParams.get('fields')).includes('status');
    const isTransitionPost = (c: { url: string; method: string }) =>
      c.method === 'POST' && /\/transitions$/.test(new URL(c.url).pathname);
    const isChangelogHead = (c: { url: string; method: string }) =>
      c.method === 'GET' &&
      /\/changelog$/.test(new URL(c.url).pathname) &&
      new URL(c.url).searchParams.get('maxResults') === '1';
    const isChangelogTail = (c: { url: string; method: string }) =>
      c.method === 'GET' &&
      /\/changelog$/.test(new URL(c.url).pathname) &&
      new URL(c.url).searchParams.get('maxResults') !== '1';
    const isRebaseline = (c: { url: string; method: string }) =>
      c.method === 'GET' &&
      /\/issue\/[^/]+$/.test(new URL(c.url).pathname) &&
      !String(new URL(c.url).searchParams.get('fields')).includes('status');

    it('both pre-reads land before either POST, and both read-backs are last: both refuse', async () => {
      const ticket = neutralTicket({ id: 'RP-9', updatedAt: T0 });
      const root = await bootstrapProject(ticket, 'in-progress');
      const fake = new FakeJira({
        id: 'RP-9',
        statusCategory: 'new',
        statusName: 'To Do',
        updated: T0,
      });
      const { fetchImpl, releaseWhere } = gatedFetch(fake);
      globalThis.fetch = fetchImpl;
      const { claim } = await load('jira.mjs');

      const claimA = claim(ticket, { transitionId: '21', env: CREDENTIALS, projectRoot: root });
      const claimB = claim(ticket, { transitionId: '21', env: CREDENTIALS, projectRoot: root });

      await releaseWhere(isPreOrReadBack); // first pre-read
      await releaseWhere(isPreOrReadBack); // second pre-read
      await releaseWhere(isTransitionPost); // first POST
      await releaseWhere(isTransitionPost); // second POST
      await releaseWhere(isPreOrReadBack); // first read-back
      await releaseWhere(isPreOrReadBack); // second read-back
      await releaseWhere(isChangelogHead);
      await releaseWhere(isChangelogHead);
      await releaseWhere(isChangelogTail);
      await releaseWhere(isChangelogTail);

      const [resultA, resultB] = (await Promise.all([claimA, claimB])) as [
        { claimed: unknown; reason?: string },
        { claimed: unknown; reason?: string },
      ];

      assertShape(resultA);
      assertShape(resultB);
      const trueCount = [resultA, resultB].filter((r) => r.claimed === true).length;
      expect(
        trueCount,
        `both saw only one history yet both verified — ${JSON.stringify({ resultA, resultB })}`,
      ).toBeLessThanOrEqual(1);
      // per the brief's own rationale, this interleaving refuses BOTH
      expect(resultA).toMatchObject({ claimed: false, reason: 'claim-contended' });
      expect(resultB).toMatchObject({ claimed: false, reason: 'claim-contended' });
    });

    it("A's read-back lands strictly before B's POST, while B's pre-read preceded A's POST: exactly A verifies", async () => {
      const ticket = neutralTicket({ id: 'RP-10', updatedAt: T0 });
      const root = await bootstrapProject(ticket, 'in-progress');
      const fake = new FakeJira({
        id: 'RP-10',
        statusCategory: 'new',
        statusName: 'To Do',
        updated: T0,
      });
      const { fetchImpl, releaseWhere } = gatedFetch(fake);
      globalThis.fetch = fetchImpl;
      const { claim } = await load('jira.mjs');

      const claimA = claim(ticket, { transitionId: '21', env: CREDENTIALS, projectRoot: root });
      const claimB = claim(ticket, { transitionId: '21', env: CREDENTIALS, projectRoot: root });

      // B's pre-read is released (and so completes) before A's pre-read — and
      // because `transitionId` is supplied, nothing else stands between a
      // resolved pre-read and that controller's own POST: releasing B's
      // pre-read first means B's POST is the one that lands in the queue
      // first, and A's POST lands second once A's own pre-read is released.
      await releaseWhere(isPreOrReadBack, 'last'); // B's pre-read (arrived second)
      await releaseWhere(isPreOrReadBack, 'first'); // A's pre-read (only one left)

      // A runs all the way to a verified claim while B's POST sits unreleased.
      // B's POST reached the queue first (see above), so it is the 'first'
      // match here — A's is the 'last' one, and picking 'first' would grab
      // B's instead and invert the whole interleaving this test names.
      await releaseWhere(isTransitionPost, 'last'); // A's POST (B's POST stays queued, unreleased)
      await releaseWhere(isPreOrReadBack); // A's read-back
      await releaseWhere(isChangelogHead); // A's changelog head
      await releaseWhere(isChangelogTail); // A's changelog tail (sees exactly 1)
      await releaseWhere(isRebaseline); // A's post-verify rebaseline

      // Only now does B's POST land.
      await releaseWhere(isTransitionPost); // B's POST
      await releaseWhere(isPreOrReadBack); // B's read-back
      await releaseWhere(isChangelogHead); // B's changelog head
      await releaseWhere(isChangelogTail); // B's changelog tail (sees 2 — contended)

      const [resultA, resultB] = (await Promise.all([claimA, claimB])) as [
        { claimed: unknown; reason?: string },
        { claimed: unknown; reason?: string },
      ];

      assertShape(resultA);
      assertShape(resultB);
      const trueCount = [resultA, resultB].filter((r) => r.claimed === true).length;
      expect(
        trueCount,
        `expected exactly A verified — ${JSON.stringify({ resultA, resultB })}`,
      ).toBeLessThanOrEqual(1);
      expect(resultA).toMatchObject({ claimed: true });
      expect(resultB).toMatchObject({ claimed: false, reason: 'claim-contended' });
    });
  });
});

// --- the GitHub adapter ------------------------------------------------------

/**
 * A stateful fake `gh` on PATH, backed by a JSON file (a real subprocess per
 * call cannot keep JS state in memory) — models an issue's state/labels and
 * its events list, and the measured GitHub behaviour the brief names: a
 * `labeled` add that finds the label already present writes NO event.
 */
const installGhFake = async (state: {
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  updatedAt: string;
  login: string;
  events: Array<{
    event: string;
    label: { name: string };
    actor: { login: string };
    created_at: string;
  }>;
  injectForeignBeforeEdit?: boolean;
  foreignLogin?: string;
  foreignEventAt?: string;
  ownEventAt?: string;
}): Promise<{
  stub: StubHandle;
  statePath: string;
  logPath: string;
  calls: () => Promise<string[]>;
}> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rp220-gh-'));
  const statePath = path.join(dir, 'state.json');
  const logPath = path.join(dir, 'calls.log');
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(logPath, '');

  const handler = `
    const fs = require('node:fs');
    const statePath = ${JSON.stringify(statePath)};
    const logPath = ${JSON.stringify(logPath)};
    fs.appendFileSync(logPath, args.join(' ') + '\\n');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const persist = () => fs.writeFileSync(statePath, JSON.stringify(state));

    if (args[0] === 'issue' && args[1] === 'view') {
      const jsonIdx = args.indexOf('--json');
      const fields = String(args[jsonIdx + 1] || '').split(',');
      const out = {};
      for (const f of fields) {
        if (f === 'state') out.state = state.state;
        if (f === 'labels') out.labels = state.labels.map((name) => ({ name }));
        if (f === 'updatedAt') out.updatedAt = state.updatedAt;
      }
      return { stdout: JSON.stringify(out) + '\\n' };
    }
    if (args[0] === 'issue' && args[1] === 'edit') {
      const addIdx = args.indexOf('--add-label');
      const label = args[addIdx + 1];
      if (state.injectForeignBeforeEdit && !state._foreignInjected) {
        state._foreignInjected = true;
        if (!state.labels.includes(label)) {
          state.labels.push(label);
          state.events.push({
            event: 'labeled',
            label: { name: label },
            actor: { login: state.foreignLogin },
            created_at: state.foreignEventAt,
          });
        }
      }
      if (!state.labels.includes(label)) {
        state.labels.push(label);
        state.events.push({
          event: 'labeled',
          label: { name: label },
          actor: { login: state.login },
          created_at: state.ownEventAt,
        });
      }
      persist();
      return { stdout: '' };
    }
    if (args[0] === 'api' && args[1] === 'user') {
      return { stdout: state.login + '\\n' };
    }
    if (args[0] === 'api' && String(args[1] || '').startsWith('repos/')) {
      return { stdout: JSON.stringify(state.events) + '\\n' };
    }
    return { stdout: '[]\\n' };
  `;

  const stub = await stubCommand('gh', handler);
  return {
    stub,
    statePath,
    logPath,
    calls: async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean),
  };
};

describe('github-issues claim() is verified and stale-selection safe (RP-220)', () => {
  let installed: Awaited<ReturnType<typeof installGhFake>> | null = null;

  afterEach(() => {
    installed?.stub.restore();
    installed = null;
  });

  it.each([
    [
      'already labelled in-progress',
      { state: 'OPEN' as const, labels: ['in-progress'], updatedAt: T0 },
    ],
    ['closed', { state: 'CLOSED' as const, labels: [], updatedAt: T0 }],
    [
      'updatedAt moved since selection',
      { state: 'OPEN' as const, labels: [], updatedAt: bump(T0, 60_000) },
    ],
  ])(
    'refuses as claim-stale when the item is %s, with no issue-edit call',
    async (_label, over) => {
      installed = await installGhFake({
        login: 'me',
        events: [],
        ...over,
      });
      const ticket = neutralTicket({ id: '42', updatedAt: T0 });

      const { claim } = await load('github-issues.mjs');
      const result = await claim(ticket, {});

      expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-stale' });
      const calls = await installed.calls();
      expect(
        calls.some((line) => line.startsWith('issue edit') && line.includes('--add-label')),
      ).toBe(false);
    },
  );

  it('verifies when exactly one in-progress labelled event after the snapshot is by the current login', async () => {
    installed = await installGhFake({
      state: 'OPEN',
      labels: [],
      updatedAt: T0,
      login: 'me',
      events: [],
      ownEventAt: bump(T0, 1000),
    });
    const ticket = neutralTicket({ id: '42', updatedAt: T0 });
    const root = await bootstrapProject(ticket, 'in-progress');

    const { claim } = await load('github-issues.mjs');
    const result = await claim(ticket, { projectRoot: root });

    expect(result).toMatchObject({ ok: true, claimed: true, workflowClaimRecorded: true });
    const claimPath = claimPathFor(root, '42');
    const persisted = JSON.parse(await readFile(claimPath, 'utf8'));
    expect(persisted.workflowClaim).toEqual({ claimedState: 'in-progress' });
  });

  it('refuses as claim-contended when the only in-progress labelled event after the snapshot is by another login', async () => {
    // The second add wrote no event (measured, RP-220 brief): a foreign
    // controller's own add-label lands first (writing the one event), and our
    // own edit then finds the label already present and writes nothing.
    installed = await installGhFake({
      state: 'OPEN',
      labels: [],
      updatedAt: T0,
      login: 'me',
      events: [],
      injectForeignBeforeEdit: true,
      foreignLogin: 'someone-else',
      foreignEventAt: bump(T0, 1000),
      ownEventAt: bump(T0, 2000),
    });
    const ticket = neutralTicket({ id: '42', updatedAt: T0 });
    const root = await bootstrapProject(ticket, 'in-progress');

    const { claim } = await load('github-issues.mjs');
    const result = await claim(ticket, { projectRoot: root });

    expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-contended' });
    const claimPath = claimPathFor(root, '42');
    const persisted = JSON.parse(await readFile(claimPath, 'utf8'));
    expect(persisted.workflowClaim).toBeUndefined();
  });

  // invariants.md, "State the limits — and test them": a limit sentence is
  // either generated from what it describes or a pointer to the test that
  // proves it. This is that test.
  it('states, in its own header, the same-account limit this fake just exercised', async () => {
    const source = await readFile(path.join(queueDir, 'github-issues.mjs'), 'utf8');
    expect(source, 'the same-GitHub-account limit is not documented near claim()').toMatch(
      /same .{0,20}account/i,
    );
    expect(source, 'the measured re-add-writes-no-event behaviour is not named').toMatch(
      /re-adding|already present/i,
    );
    expect(source, 'the consequence (no event) is not spelled out').toMatch(/no event|writes no/i);
  });
});
