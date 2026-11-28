import { execFile, execFileSync } from 'node:child_process';
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
const FIXTURE_TARGET_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

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
    targetSha: FIXTURE_TARGET_SHA,
    allowCreate: true,
    isResume: false,
  });
  if (result.result !== 'BASELINE_CREATED') {
    throw new Error(`test setup: could not create a claim baseline: ${JSON.stringify(result)}`);
  }
  return root;
};

const claimPathFor = (root: string, id: string) => path.join(root, '.rig', 'claims', `${id}.json`);

const nativeSelectionFor = async (root: string, ticket: NeutralTicket, now: string) => {
  git(['add', `.rig/claims/${ticket.id}.json`], root);
  git(['commit', '-q', '-m', 'version SELECT baseline'], root);
  const origin = path.join(root, '.fixture-origin.git');
  git(['init', '--bare', '-b', 'master', origin], root);
  git(['remote', 'add', 'origin', origin], root);
  git(['push', '-q', '-u', 'origin', 'master'], root);
  git(['fetch', '-q', 'origin'], root);

  const claims = await import(
    `${pathToFileURL(claimRecordsScript).href}?native-selection=${Date.now()}-${Math.random()}`
  );
  const selected = claims.revalidateClaim({
    projectRoot: root,
    ticket,
    point: 'SELECT',
    claimedState: 'in-progress',
    targetSha: FIXTURE_TARGET_SHA,
    allowCreate: false,
    isResume: false,
  });
  if (selected.result !== 'CURRENT') {
    throw new Error(`test setup: SELECT baseline was not current: ${JSON.stringify(selected)}`);
  }
  const runDir = path.join(root, '.claude', 'runs', 'native-selection');
  await mkdir(runDir, { recursive: true });
  const journal = await import(
    `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?native-selection=${Date.now()}-${Math.random()}`
  );
  journal.recordDecision({
    runDir,
    gate: 'item-selection',
    verdict: `taken ${ticket.id}`,
    why: ticket.title,
    now,
  });
  journal.recordEvent({
    runDir,
    kind: 'revalidation',
    data: { ...selected, task: { from: null, to: ticket.updatedAt } },
    now,
  });
  return runDir;
};

const scopedRun = async <T>(runDir: string, work: () => T | Promise<T>): Promise<T> => {
  const previousRunDir = process.env.RIG_RUN_DIR;
  process.env.RIG_RUN_DIR = runDir;
  try {
    return await work();
  } finally {
    if (previousRunDir === undefined) delete process.env.RIG_RUN_DIR;
    else process.env.RIG_RUN_DIR = previousRunDir;
  }
};

const runGithubClaimChild = (
  ticket: NeutralTicket,
  projectRoot: string,
  runDir: string,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const adapterUrl = pathToFileURL(path.join(queueDir, 'github-issues.mjs')).href;
  const script = `
    const { claim } = await import(${JSON.stringify(adapterUrl)});
    const result = claim(${JSON.stringify(ticket)}, { projectRoot: ${JSON.stringify(projectRoot)} });
    process.stdout.write(JSON.stringify(result instanceof Promise ? await result : result));
  `;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--input-type=module', '--eval', script],
      { cwd: projectRoot, env: { ...process.env, RIG_RUN_DIR: runDir } },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
};

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
    priorHistories = [],
  }: {
    id: string;
    statusCategory?: string;
    statusName?: string;
    updated: string;
    // Seeds history entries that predate the selection snapshot — the fixture
    // shape B2's "created > snapshot" pin needs (round2.md item 1).
    priorHistories?: Array<{ created: string; items: Array<{ field: string }> }>;
  }) {
    this.id = id;
    this.statusCategory = statusCategory;
    this.statusName = statusName;
    this.updated = updated;
    this.histories = [...priorHistories];
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

const admitJiraClaim = async (root: string, ticket: NeutralTicket, now: string) => {
  const runDir = await nativeSelectionFor(root, ticket, now);
  const gh = await stubCommand(
    'gh',
    "if (args[0] === 'api' && String(args[1] || '').includes('/pulls?')) return { stdout: '[]\\n' };\n" +
      "return { stdout: '[]\\n' };",
  );
  return { gh, env: { ...process.env, ...CREDENTIALS, RIG_RUN_DIR: runDir } };
};

describe('jira claim() is verified and stale-selection safe (RP-220)', () => {
  let realFetch: typeof globalThis.fetch;
  let admissionGh: StubHandle | null = null;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    admissionGh?.restore();
    admissionGh = null;
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

  it('refuses a Jira claim before mutation and rebaseline reads when no run is declared for native admission', async () => {
    const ticket = neutralTicket({ id: 'RP-2', updatedAt: T0 });
    const fake = new FakeJira({
      id: 'RP-2',
      statusCategory: 'new',
      statusName: 'To Do',
      updated: T0,
    });
    installFetch(fake);

    const { claim } = await load('jira.mjs');
    const result = await claim(ticket, { transitionId: '21', env: CREDENTIALS });

    expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-unverifiable' });
    expect(
      fake.calls.filter(
        (call) => call.method === 'POST' && /\/transitions$/.test(new URL(call.url).pathname),
      ),
    ).toHaveLength(0);
    expect(
      fake.calls.some(
        (call) =>
          call.method === 'GET' && new URL(call.url).searchParams.get('fields') === 'updated',
      ),
    ).toBe(false);
  });

  it('verifies and records the workflow claim for the sole claimant of an unchanged snapshot', async () => {
    const ticket = neutralTicket({ id: 'RP-3', updatedAt: T0 });
    const root = await bootstrapProject(ticket, 'in-progress');
    const admission = await admitJiraClaim(root, ticket, T0);
    admissionGh = admission.gh;
    const fake = new FakeJira({
      id: 'RP-3',
      statusCategory: 'new',
      statusName: 'To Do',
      updated: T0,
    });
    installFetch(fake);

    const { claim } = await load('jira.mjs');
    const result = await claim(ticket, {
      transitionId: '21',
      env: admission.env,
      projectRoot: root,
    });

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
    const admission = await admitJiraClaim(root, ticket, T0);
    admissionGh = admission.gh;
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
    const result = await claim(ticket, {
      transitionId: '21',
      env: admission.env,
      projectRoot: root,
    });

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
      const admission = await admitJiraClaim(root, ticket, T0);
      admissionGh = admission.gh;
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
        env: admission.env,
        projectRoot: root,
      });
      const resultB = await claim(ticket, {
        transitionId: '21',
        env: admission.env,
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
      const admission = await admitJiraClaim(root, ticket, T0);
      admissionGh = admission.gh;
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
        env: admission.env,
        projectRoot: root,
      });
      const resultA = await claim(ticket, {
        transitionId: '21',
        env: admission.env,
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

      return { fetchImpl, releaseWhere, flush, queue };
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

    it('both initial and final authority pre-reads land before either POST, and both read-backs are last: both refuse', async () => {
      const ticket = neutralTicket({ id: 'RP-9', updatedAt: T0 });
      const root = await bootstrapProject(ticket, 'in-progress');
      const admission = await admitJiraClaim(root, ticket, T0);
      admissionGh = admission.gh;
      const fake = new FakeJira({
        id: 'RP-9',
        statusCategory: 'new',
        statusName: 'To Do',
        updated: T0,
      });
      const { fetchImpl, releaseWhere } = gatedFetch(fake);
      globalThis.fetch = fetchImpl;
      const { claim } = await load('jira.mjs');

      const claimA = claim(ticket, { transitionId: '21', env: admission.env, projectRoot: root });
      const claimB = claim(ticket, { transitionId: '21', env: admission.env, projectRoot: root });

      await releaseWhere(isPreOrReadBack); // first pre-read
      await releaseWhere(isPreOrReadBack); // second pre-read
      await releaseWhere(isPreOrReadBack); // first final authority pre-read
      await releaseWhere(isPreOrReadBack); // second final authority pre-read
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
      const admission = await admitJiraClaim(root, ticket, T0);
      admissionGh = admission.gh;
      const fake = new FakeJira({
        id: 'RP-10',
        statusCategory: 'new',
        statusName: 'To Do',
        updated: T0,
      });
      const { fetchImpl, releaseWhere, flush, queue } = gatedFetch(fake);
      globalThis.fetch = fetchImpl;
      const { claim } = await load('jira.mjs');

      const claimA = claim(ticket, { transitionId: '21', env: admission.env, projectRoot: root });
      const claimB = claim(ticket, { transitionId: '21', env: admission.env, projectRoot: root });
      let aResolved = false;
      void claimA.then(() => {
        aResolved = true;
      });

      // B's initial pre-read is released before A's. Both then complete their
      // final authority pre-read while the item is still unclaimed, so the
      // following POST order models an actual overlap rather than a stale
      // response fabricated after the other controller's mutation.
      await releaseWhere(isPreOrReadBack, 'last'); // B's pre-read (arrived second)
      await releaseWhere(isPreOrReadBack, 'first'); // A's pre-read (only one left)
      await releaseWhere(isPreOrReadBack, 'last'); // B's final authority pre-read
      await releaseWhere(isPreOrReadBack, 'first'); // A's final authority pre-read

      // A runs all the way to a verified claim while B's POST sits unreleased.
      // The final reads queued B then A; releasing A's final read first puts
      // A's POST first in the mutation queue, leaving B's second POST held.
      await releaseWhere(isTransitionPost, 'first'); // A's POST (B's POST stays queued, unreleased)
      await releaseWhere(isPreOrReadBack); // A's read-back
      await releaseWhere(isChangelogHead); // A's changelog head
      await releaseWhere(isChangelogTail); // A's changelog tail (sees exactly 1)

      // RP-554 changes this successful-claim path: admission requires a declared
      // run, so A now legitimately rebaselines before its claim resolves. The
      // separate no-run refusal above preserves the former no-write guarantee.
      await flush();
      expect(
        queue.some(isRebaseline),
        `a successful claim with declared native admission did not rebaseline: ${queue
          .map((c) => `${c.method} ${c.url}`)
          .join(' | ')}`,
      ).toBe(true);
      await releaseWhere(isRebaseline);
      await claimA;
      expect(aResolved).toBe(true);

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

  // round2.md item 1 (B2): every mutation the reviewer named survived the
  // round-1 suite. Each case below fixtures the shape that specific mutation
  // needs to be caught by, independent of the production line it targets —
  // verified by applying the mutation to jira.mjs by hand, watching this file
  // go red, and reverting (never left in the tree).
  describe('B2 — pinning the verification rule against the reviewer-flagged mutations', () => {
    it('does not count a status-change history that predates the selection snapshot (pins the created>snapshot filter, jira.mjs ~639)', async () => {
      const ticket = neutralTicket({ id: 'RP-11', updatedAt: T0 });
      const root = await bootstrapProject(ticket, 'in-progress');
      const admission = await admitJiraClaim(root, ticket, T0);
      admissionGh = admission.gh;
      const fake = new FakeJira({
        id: 'RP-11',
        statusCategory: 'new',
        statusName: 'To Do',
        updated: T0,
        priorHistories: [{ created: bump(T0, -3_600_000), items: [{ field: 'status' }] }],
      });
      installFetch(fake);

      const { claim } = await load('jira.mjs');
      const result = await claim(ticket, {
        transitionId: '21',
        env: admission.env,
        projectRoot: root,
      });

      expect(
        result,
        `a pre-snapshot status history must never count toward contention — ${JSON.stringify(result)}`,
      ).toMatchObject({ ok: true, claimed: true });
    });

    it('refuses even with exactly one post-snapshot status history when the read-back category is not in-progress (pins the category check, jira.mjs ~644)', async () => {
      const ticket = neutralTicket({ id: 'RP-12', updatedAt: T0 });
      const root = await bootstrapProject(ticket, 'in-progress');
      const admission = await admitJiraClaim(root, ticket, T0);
      admissionGh = admission.gh;
      const afterHistoryCreated = bump(T0, 1000);
      let transitioned = false;
      globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
        const url = String(input);
        const method = String(init.method ?? 'GET');
        const u = new URL(url);
        if (method === 'POST' && /\/transitions$/.test(u.pathname)) {
          transitioned = true;
          return Promise.resolve(reply({ status: 204 }));
        }
        if (method === 'GET' && /\/changelog$/.test(u.pathname)) {
          const maxResults = Number(u.searchParams.get('maxResults') ?? '0');
          // A workflow automation carried the issue straight through
          // "In Progress" to "Done": exactly ONE status history entry landed
          // after the snapshot, but the category the read-back sees is not
          // "indeterminate" any more.
          const values = transitioned
            ? [{ created: afterHistoryCreated, items: [{ field: 'status' }] }]
            : [];
          return Promise.resolve(
            reply({ status: 200, json: { total: values.length, startAt: 0, maxResults, values } }),
          );
        }
        if (method === 'GET' && /\/issue\/[^/]+$/.test(u.pathname)) {
          const fields = String(u.searchParams.get('fields') ?? '');
          const body: Record<string, unknown> = {};
          if (fields.includes('status')) {
            body.status = transitioned
              ? { name: 'Done', statusCategory: { key: 'done' } }
              : { name: 'To Do', statusCategory: { key: 'new' } };
          }
          if (fields.includes('updated') || fields === '')
            body.updated = transitioned ? afterHistoryCreated : T0;
          return Promise.resolve(reply({ status: 200, json: { fields: body } }));
        }
        return Promise.resolve(reply({ status: 404, statusText: 'Not Found' }));
      }) as unknown as typeof globalThis.fetch;

      const { claim } = await load('jira.mjs');
      const result = await claim(ticket, {
        transitionId: '21',
        env: admission.env,
        projectRoot: root,
      });

      expect(
        result,
        `a read-back category outside "indeterminate" must never verify, even with exactly one status history after the snapshot — ${JSON.stringify(result)}`,
      ).toMatchObject({ ok: false, claimed: false, reason: 'claim-contended' });
    });

    it('refuses when the sole post-snapshot history entry is not itself a status change (pins the status-item check, jira.mjs ~643)', async () => {
      const ticket = neutralTicket({ id: 'RP-13', updatedAt: T0 });
      const root = await bootstrapProject(ticket, 'in-progress');
      const admission = await admitJiraClaim(root, ticket, T0);
      admissionGh = admission.gh;
      const afterHistoryCreated = bump(T0, 1000);
      let transitioned = false;
      globalThis.fetch = ((input: unknown, init: { method?: string } = {}) => {
        const url = String(input);
        const method = String(init.method ?? 'GET');
        const u = new URL(url);
        if (method === 'POST' && /\/transitions$/.test(u.pathname)) {
          transitioned = true;
          return Promise.resolve(reply({ status: 204 }));
        }
        if (method === 'GET' && /\/changelog$/.test(u.pathname)) {
          const maxResults = Number(u.searchParams.get('maxResults') ?? '0');
          // The category genuinely reads "indeterminate" below, but the one
          // history entry that landed after the snapshot names a different
          // field — a label change riding along, never a status change.
          const values = transitioned
            ? [{ created: afterHistoryCreated, items: [{ field: 'labels' }] }]
            : [];
          return Promise.resolve(
            reply({ status: 200, json: { total: values.length, startAt: 0, maxResults, values } }),
          );
        }
        if (method === 'GET' && /\/issue\/[^/]+$/.test(u.pathname)) {
          const fields = String(u.searchParams.get('fields') ?? '');
          const body: Record<string, unknown> = {};
          if (fields.includes('status')) {
            body.status = transitioned
              ? { name: 'In Progress', statusCategory: { key: 'indeterminate' } }
              : { name: 'To Do', statusCategory: { key: 'new' } };
          }
          if (fields.includes('updated') || fields === '')
            body.updated = transitioned ? afterHistoryCreated : T0;
          return Promise.resolve(reply({ status: 200, json: { fields: body } }));
        }
        return Promise.resolve(reply({ status: 404, statusText: 'Not Found' }));
      }) as unknown as typeof globalThis.fetch;

      const { claim } = await load('jira.mjs');
      const result = await claim(ticket, {
        transitionId: '21',
        env: admission.env,
        projectRoot: root,
      });

      expect(
        result,
        `a sole post-snapshot history entry that is not a status change must never verify — ${JSON.stringify(result)}`,
      ).toMatchObject({ ok: false, claimed: false, reason: 'claim-contended' });
    });
  });

  // invariants.md, "State the limits — and test them": a limit sentence is
  // either generated from what it describes or a pointer to the test that
  // proves it. This is jira.mjs's equivalent of the GitHub header test below.
  it('states, in its own header, that every claim transition — a looped one included — writes its own changelog history, and that this is untested against a live tracker', async () => {
    const source = await readFile(path.join(queueDir, 'jira.mjs'), 'utf8');
    expect(source, 'the looped-transition assumption is not named near claim()').toMatch(
      /loop(ed)?/i,
    );
    expect(source, 'the changelog-per-transition claim is not stated').toMatch(
      /writes its own changelog history|appends one changelog history/i,
    );
    expect(source, 'the fake modelling this assumption is not named').toMatch(
      /fake[\s\S]{0,60}models it|the fake in the tests models it/i,
    );
    expect(source, 'the assumption is not marked untested against a live tracker').toMatch(
      /untested against a live tracker/i,
    );
  });
});

// round2.md item 3 (B4): both adapters' `claim()` headers currently claim
// "none throws once the write has landed" without scoping WHICH write —
// they must say the ambiguous case (the write itself failing) still rejects,
// and point at the pin that already proves it for the mutating-call retry
// rule (`queue-jira.test.ts` › "does not retry %s").
describe('the claim() headers scope "never throws" to a write that has already landed', () => {
  it('jira.mjs says claim() throws before its write or when the write itself fails, and points at the retry pin', async () => {
    const source = await readFile(path.join(queueDir, 'jira.mjs'), 'utf8');
    expect(
      source,
      'jira.mjs does not scope the never-throws claim to "the write itself fails"',
    ).toMatch(/throws before its write[\s\S]{0,160}?or when the write itself fails outright/i);
    expect(source, 'the header still claims claim() throws only when the write fails').not.toMatch(
      /throws only if the write itself fails/i,
    );
    expect(
      source,
      'jira.mjs does not point at the queue-jira.test.ts pin for a write that fails outright',
    ).toMatch(/does not retry %s/);
  });

  it('github-issues.mjs says claim() throws before its write or when the write itself fails', async () => {
    const source = await readFile(path.join(queueDir, 'github-issues.mjs'), 'utf8');
    expect(
      source,
      'github-issues.mjs does not scope the never-throws claim to "the write itself fails"',
    ).toMatch(/throws before its write[\s\S]{0,160}?or when the write itself fails outright/i);
    expect(source, 'the header still claims claim() throws only when the write fails').not.toMatch(
      /throws only if the write itself fails/i,
    );
  });
});

// round2.md "Decision on B1": loop §9 currently says, unqualified, that "the
// adapter re-reads the item before its write and verifies the write after
// it" — true of Jira, true of GitHub only across distinct accounts, and
// false of plan-md, whose claim writes nothing at all.
describe('loop §9 states the verified-claim guarantee at its true, per-adapter scope', () => {
  it('names Jira, scopes GitHub to distinct accounts, and says a plan-md claim verifies nothing', async () => {
    const skillPath = path.join(
      repoRoot,
      'templates',
      'agent-os',
      'universal',
      '.claude',
      'skills',
      'loop',
      'SKILL.md',
    );
    const source = await readFile(skillPath, 'utf8');
    expect(source, '§9 no longer names Jira for the verified-claim guarantee').toMatch(/jira/i);
    expect(source, '§9 does not scope the GitHub guarantee to distinct accounts').toMatch(
      /distinct account|different account/i,
    );
    expect(source, '§9 does not say a plan-md claim verifies nothing').toMatch(
      /plan-md[\s\S]{0,120}verifies nothing|verifies nothing[\s\S]{0,120}plan-md/i,
    );
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
  duplicateWorkPulls?: boolean;
  nativeCheckMarker?: string;
  reassignDuringDuplicateWork?: boolean;
  foreignAssignee?: string;
  nativeDuplicateWorkMutation?: 'close' | 'label-in-progress' | 'updated-at';
  nativeUpdatedAt?: string;
  // Round2 B1 decision: two controllers under the SAME GitHub account race
  // through the final authority read→write window. The file-backed barrier
  // below admits both real child processes only after each has reached that
  // final read; it does not fabricate an old reply after a completed claim.
  sameAccountRace?: boolean;
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
    const raceDir = statePath + '.same-account-race';
    const raceToken = Buffer.from(process.env.RIG_RUN_DIR || '').toString('hex');
    fs.appendFileSync(logPath, args.join(' ') + '\\n');
    let state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    let writeSequence = 0;
    const persist = () => {
      const temporaryPath = statePath + '.' + process.pid + '.' + (++writeSequence) + '.tmp';
      fs.writeFileSync(temporaryPath, JSON.stringify(state));
      fs.renameSync(temporaryPath, statePath);
    };

    if (args[0] === 'issue' && args[1] === 'view') {
      const jsonIdx = args.indexOf('--json');
      const fieldsArg = String(args[jsonIdx + 1] || '');
      const fields = fieldsArg.split(',');
      const isPreRead = fieldsArg === 'state,labels,updatedAt';
      const out = {};
      for (const f of fields) {
        if (f === 'state') out.state = state.state;
        if (f === 'labels') out.labels = state.labels.map((name) => ({ name }));
        if (f === 'updatedAt') out.updatedAt = state.updatedAt;
        if (f === 'assignees') {
          const assignees = state._reassigned ? [state.foreignAssignee] : state.assignees || [];
          out.assignees = assignees.map((login) => ({ login }));
        }
      }
      if (state.sameAccountRace && isPreRead && fs.existsSync(raceDir + '/' + raceToken + '.duplicate')) {
        fs.mkdirSync(raceDir, { recursive: true });
        fs.writeFileSync(raceDir + '/' + raceToken + '.final', '');
        const deadline = Date.now() + 5000;
        while (true) {
          const finalReads = fs.readdirSync(raceDir).filter((entry) => entry.endsWith('.final'));
          if (finalReads.length >= 2) break;
          if (Date.now() >= deadline) throw new Error('same-account final-authority barrier timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        return { stdout: JSON.stringify(out) + '\\n' };
      }
      return { stdout: JSON.stringify(out) + '\\n' };
    }
    if (args[0] === 'issue' && args[1] === 'edit') {
      let editLock;
      if (state.sameAccountRace) {
        fs.mkdirSync(raceDir, { recursive: true });
        editLock = raceDir + '/edit.lock';
        const deadline = Date.now() + 5000;
        while (true) {
          try {
            fs.mkdirSync(editLock);
            break;
          } catch (error) {
            if (!error || error.code !== 'EEXIST') throw error;
            if (Date.now() >= deadline) throw new Error('same-account edit lock timed out');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      }
      const addIdx = args.indexOf('--add-label');
      const label = args[addIdx + 1];
      try {
        let mutated = false;
        if (state.injectForeignBeforeEdit && !state._foreignInjected) {
          state._foreignInjected = true;
          mutated = true;
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
          mutated = true;
        }
        if (mutated) persist();
        return { stdout: '' };
      } finally {
        if (editLock) fs.rmdirSync(editLock);
      }
    }
    if (args[0] === 'api' && args[1] === 'user') {
      return { stdout: state.login + '\\n' };
    }
    if (args[0] === 'api' && String(args[1] || '').includes('/pulls?')) {
      if (state.sameAccountRace) {
        fs.mkdirSync(raceDir, { recursive: true });
        fs.writeFileSync(raceDir + '/' + raceToken + '.duplicate', '');
      }
      if (state.nativeCheckMarker) fs.writeFileSync(state.nativeCheckMarker, 'checked\\n');
      let mutated = false;
      if (state.reassignDuringDuplicateWork && !state._reassigned) {
        state._reassigned = true;
        mutated = true;
      }
      if (state.nativeDuplicateWorkMutation === 'close' && state.state !== 'CLOSED') {
        state.state = 'CLOSED';
        mutated = true;
      }
      if (state.nativeDuplicateWorkMutation === 'label-in-progress' && !state.labels.includes('in-progress')) {
        state.labels.push('in-progress');
        mutated = true;
      }
      if (state.nativeDuplicateWorkMutation === 'updated-at' && state.updatedAt !== state.nativeUpdatedAt) {
        state.updatedAt = state.nativeUpdatedAt;
        mutated = true;
      }
      if (mutated) persist();
      return state.duplicateWorkPulls ? { stdout: '[]\\n' } : { stdout: JSON.stringify(state.events) + '\\n' };
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

  it('refuses a GitHub claim without native SELECT admission before adding the in-progress label', async () => {
    installed = await installGhFake({
      state: 'OPEN',
      labels: [],
      updatedAt: T0,
      login: 'me',
      events: [],
      ownEventAt: bump(T0, 1000),
    });
    const ticket = neutralTicket({ id: '42', updatedAt: T0 });

    const { claim } = await load('github-issues.mjs');
    const result = claim(ticket, {});

    expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-unverifiable' });
    const calls = await installed.calls();
    expect(
      calls.some((line) => line.startsWith('issue edit') && line.includes('--add-label')),
    ).toBe(false);
  });

  it('permits a GitHub claim after a native SELECT admission and clean duplicate-work check', async () => {
    installed = await installGhFake({
      state: 'OPEN',
      labels: [],
      updatedAt: T0,
      login: 'me',
      events: [],
      ownEventAt: bump(T0, 1000),
      duplicateWorkPulls: true,
    });
    const ticket = neutralTicket({ id: '42', updatedAt: T0 });
    const root = await bootstrapProject(ticket, 'in-progress');
    git(['add', '.rig/claims/42.json'], root);
    git(['commit', '-q', '-m', 'version selected claim baseline'], root);
    const origin = path.join(root, '.fixture-origin.git');
    git(['init', '--bare', '-b', 'master', origin], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', '-u', 'origin', 'master'], root);
    git(['fetch', '-q', 'origin'], root);

    const records = await import(
      `${pathToFileURL(claimRecordsScript).href}?github-admission=${Date.now()}-${Math.random()}`
    );
    const selected = records.revalidateClaim({
      projectRoot: root,
      ticket,
      point: 'SELECT',
      claimedState: 'in-progress',
      targetSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      allowCreate: false,
      isResume: false,
    });
    expect(selected.result, JSON.stringify(selected)).toBe('CURRENT');
    const runDir = path.join(root, '.claude', 'runs', 'github-admission');
    await mkdir(runDir, { recursive: true });
    const journal = await import(
      `${pathToFileURL(path.join(scriptsDir, 'run-journal.mjs')).href}?github-admission=${Date.now()}-${Math.random()}`
    );
    journal.recordDecision({
      runDir,
      gate: 'item-selection',
      verdict: 'taken 42',
      why: ticket.title,
      now: T0,
    });
    journal.recordEvent({
      runDir,
      kind: 'revalidation',
      data: { ...selected, task: { from: null, to: ticket.updatedAt } },
      now: T0,
    });

    const previousRunDir = process.env.RIG_RUN_DIR;
    process.env.RIG_RUN_DIR = runDir;
    try {
      const { claim } = await load('github-issues.mjs');
      const result = claim(ticket, { projectRoot: root });

      expect(result).toMatchObject({ ok: true, claimed: true, workflowClaimRecorded: true });
      const calls = await installed.calls();
      expect(
        calls.some(
          (line) => line.startsWith('issue edit') && line.includes('--add-label in-progress'),
        ),
      ).toBe(true);
      const persisted = JSON.parse(await readFile(claimPathFor(root, '42'), 'utf8'));
      expect(persisted.workflowClaim).toEqual({ claimedState: 'in-progress' });
    } finally {
      if (previousRunDir === undefined) delete process.env.RIG_RUN_DIR;
      else process.env.RIG_RUN_DIR = previousRunDir;
    }
  });

  it('refuses a GitHub claim when an initially unassigned issue is reassigned during native duplicate-work', async () => {
    const ticket = neutralTicket({ id: '42', updatedAt: T0 });
    const root = await bootstrapProject(ticket, 'in-progress');
    const runDir = await nativeSelectionFor(root, ticket, T0);
    const nativeMarker = path.join(root, 'native-duplicate-work.log');
    installed = await installGhFake({
      state: 'OPEN',
      labels: [],
      updatedAt: T0,
      login: 'me',
      events: [],
      ownEventAt: bump(T0, 1000),
      duplicateWorkPulls: true,
      nativeCheckMarker: nativeMarker,
      reassignDuringDuplicateWork: true,
      foreignAssignee: 'other-actor',
    });

    await scopedRun(runDir, async () => {
      const { claim } = await load('github-issues.mjs');
      const result = claim(ticket, { projectRoot: root, currentActor: { id: 'me' } });

      expect(existsSync(nativeMarker)).toBe(true);
      expect(result).not.toBeInstanceOf(Promise);
      expect(result).toMatchObject({ ok: false, claimed: false });
      expect(result).not.toMatchObject({ workflowClaimRecorded: true });
      const calls = await installed!.calls();
      expect(calls.some((line) => line.includes('/pulls?state=open'))).toBe(true);
      expect(
        calls.some(
          (line) => line.startsWith('issue edit') && line.includes('--add-label in-progress'),
        ),
      ).toBe(false);
      const persisted = JSON.parse(await readFile(claimPathFor(root, '42'), 'utf8'));
      expect(persisted.workflowClaim).toBeUndefined();
    });
  });

  it('refuses a GitHub claim when native duplicate-work closes the selected issue', async () => {
    const ticket = neutralTicket({ id: '42', updatedAt: T0 });
    const root = await bootstrapProject(ticket, 'in-progress');
    const runDir = await nativeSelectionFor(root, ticket, T0);
    const nativeMarker = path.join(root, 'native-duplicate-work.log');
    installed = await installGhFake({
      state: 'OPEN',
      labels: [],
      updatedAt: T0,
      login: 'me',
      events: [],
      ownEventAt: bump(T0, 1000),
      duplicateWorkPulls: true,
      nativeCheckMarker: nativeMarker,
      nativeDuplicateWorkMutation: 'close',
    });

    await scopedRun(runDir, async () => {
      const { claim } = await load('github-issues.mjs');
      const result = claim(ticket, { projectRoot: root, currentActor: { id: 'me' } });

      expect(existsSync(nativeMarker)).toBe(true);
      expect(result).toMatchObject({ ok: false, claimed: false });
      expect(result).not.toMatchObject({ workflowClaimRecorded: true });
      const calls = await installed!.calls();
      expect(calls.some((line) => line.includes('/pulls?state=open'))).toBe(true);
      expect(
        calls.some(
          (line) => line.startsWith('issue edit') && line.includes('--add-label in-progress'),
        ),
      ).toBe(false);
      const persisted = JSON.parse(await readFile(claimPathFor(root, '42'), 'utf8'));
      expect(persisted.workflowClaim).toBeUndefined();
    });
  });

  it('refuses a GitHub claim when native duplicate-work labels the selected issue in-progress', async () => {
    const ticket = neutralTicket({ id: '42', updatedAt: T0 });
    const root = await bootstrapProject(ticket, 'in-progress');
    const runDir = await nativeSelectionFor(root, ticket, T0);
    const nativeMarker = path.join(root, 'native-duplicate-work.log');
    installed = await installGhFake({
      state: 'OPEN',
      labels: [],
      updatedAt: T0,
      login: 'me',
      events: [],
      ownEventAt: bump(T0, 1000),
      duplicateWorkPulls: true,
      nativeCheckMarker: nativeMarker,
      nativeDuplicateWorkMutation: 'label-in-progress',
    });

    await scopedRun(runDir, async () => {
      const { claim } = await load('github-issues.mjs');
      const result = claim(ticket, { projectRoot: root, currentActor: { id: 'me' } });

      expect(existsSync(nativeMarker)).toBe(true);
      expect(result).toMatchObject({ ok: false, claimed: false });
      expect(result).not.toMatchObject({ workflowClaimRecorded: true });
      const calls = await installed!.calls();
      expect(calls.some((line) => line.includes('/pulls?state=open'))).toBe(true);
      expect(
        calls.some(
          (line) => line.startsWith('issue edit') && line.includes('--add-label in-progress'),
        ),
      ).toBe(false);
      const persisted = JSON.parse(await readFile(claimPathFor(root, '42'), 'utf8'));
      expect(persisted.workflowClaim).toBeUndefined();
    });
  });

  it('refuses a GitHub claim when native duplicate-work advances the selected issue timestamp', async () => {
    const ticket = neutralTicket({ id: '42', updatedAt: T0 });
    const root = await bootstrapProject(ticket, 'in-progress');
    const runDir = await nativeSelectionFor(root, ticket, T0);
    const nativeMarker = path.join(root, 'native-duplicate-work.log');
    installed = await installGhFake({
      state: 'OPEN',
      labels: [],
      updatedAt: T0,
      login: 'me',
      events: [],
      ownEventAt: bump(T0, 1000),
      duplicateWorkPulls: true,
      nativeCheckMarker: nativeMarker,
      nativeDuplicateWorkMutation: 'updated-at',
      nativeUpdatedAt: bump(T0, 1000),
    });

    await scopedRun(runDir, async () => {
      const { claim } = await load('github-issues.mjs');
      const result = claim(ticket, { projectRoot: root, currentActor: { id: 'me' } });

      expect(existsSync(nativeMarker)).toBe(true);
      expect(result).toMatchObject({ ok: false, claimed: false });
      expect(result).not.toMatchObject({ workflowClaimRecorded: true });
      const calls = await installed!.calls();
      expect(calls.some((line) => line.includes('/pulls?state=open'))).toBe(true);
      expect(
        calls.some(
          (line) => line.startsWith('issue edit') && line.includes('--add-label in-progress'),
        ),
      ).toBe(false);
      const persisted = JSON.parse(await readFile(claimPathFor(root, '42'), 'utf8'));
      expect(persisted.workflowClaim).toBeUndefined();
    });
  });

  it('verifies when exactly one in-progress labelled event after the snapshot is by the current login', async () => {
    installed = await installGhFake({
      state: 'OPEN',
      labels: [],
      updatedAt: T0,
      login: 'me',
      events: [],
      ownEventAt: bump(T0, 1000),
      duplicateWorkPulls: true,
    });
    const ticket = neutralTicket({ id: '42', updatedAt: T0 });
    const root = await bootstrapProject(ticket, 'in-progress');
    const runDir = await nativeSelectionFor(root, ticket, T0);

    await scopedRun(runDir, async () => {
      const { claim } = await load('github-issues.mjs');
      const result = claim(ticket, { projectRoot: root });

      expect(result).toMatchObject({ ok: true, claimed: true, workflowClaimRecorded: true });
      const claimPath = claimPathFor(root, '42');
      const persisted = JSON.parse(await readFile(claimPath, 'utf8'));
      expect(persisted.workflowClaim).toEqual({ claimedState: 'in-progress' });
    });
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
      duplicateWorkPulls: true,
    });
    const ticket = neutralTicket({ id: '42', updatedAt: T0 });
    const root = await bootstrapProject(ticket, 'in-progress');
    const runDir = await nativeSelectionFor(root, ticket, T0);

    await scopedRun(runDir, async () => {
      const { claim } = await load('github-issues.mjs');
      const result = claim(ticket, { projectRoot: root });

      expect(result).toMatchObject({ ok: false, claimed: false, reason: 'claim-contended' });
      const claimPath = claimPathFor(root, '42');
      const persisted = JSON.parse(await readFile(claimPath, 'utf8'));
      expect(persisted.workflowClaim).toBeUndefined();
    });
  });

  // round2.md item 1 (B2): the reviewer's remaining GitHub mutations, pinned
  // the same way as the Jira set above — verified by hand-applying each
  // mutation to github-issues.mjs, watching this file go red, and reverting.
  describe('B2 — pinning the verification rule against the reviewer-flagged mutations', () => {
    it('does not count an in-progress labelled event that predates the selection snapshot (pins the created_at>snapshot filter, github-issues.mjs ~283)', async () => {
      installed = await installGhFake({
        state: 'OPEN',
        labels: [],
        updatedAt: T0,
        login: 'me',
        // A stale event from long before selection — the label was added
        // and later removed, so it is absent from `labels` today but still
        // sits in the issue's event history.
        events: [
          {
            event: 'labeled',
            label: { name: 'in-progress' },
            actor: { login: 'me' },
            created_at: bump(T0, -3_600_000),
          },
        ],
        ownEventAt: bump(T0, 1000),
        duplicateWorkPulls: true,
      });
      const ticket = neutralTicket({ id: '42', updatedAt: T0 });
      const root = await bootstrapProject(ticket, 'in-progress');
      const runDir = await nativeSelectionFor(root, ticket, T0);

      await scopedRun(runDir, async () => {
        const { claim } = await load('github-issues.mjs');
        const result = claim(ticket, { projectRoot: root });

        expect(
          result,
          `a pre-snapshot labelled event must never count toward contention — ${JSON.stringify(result)}`,
        ).toMatchObject({ ok: true, claimed: true });
      });
    });

    it('refuses as claim-unverifiable when the events page comes back full (100) — it may be truncated (pins the full-page refusal, github-issues.mjs ~272)', async () => {
      const filler = Array.from({ length: 99 }, (_, i) => ({
        event: 'commented',
        label: { name: '' },
        actor: { login: 'someone' },
        created_at: bump(T0, -1000 * (i + 1)),
      }));
      installed = await installGhFake({
        state: 'OPEN',
        labels: [],
        updatedAt: T0,
        login: 'me',
        events: filler,
        ownEventAt: bump(T0, 1000),
      });
      const ticket = neutralTicket({ id: '42', updatedAt: T0 });
      const root = await bootstrapProject(ticket, 'in-progress');

      const { claim } = await load('github-issues.mjs');
      const result = await claim(ticket, { projectRoot: root });

      expect(
        result,
        `an events page landing at exactly 100 must be treated as possibly truncated — ${JSON.stringify(result)}`,
      ).toMatchObject({ ok: false, claimed: false, reason: 'claim-unverifiable' });
    });

    it('refuses as claim-contended when two in-progress labelled events by the caller land after the snapshot (pins the ===1 check, github-issues.mjs ~285)', async () => {
      installed = await installGhFake({
        state: 'OPEN',
        labels: [],
        updatedAt: T0,
        login: 'me',
        events: [
          {
            event: 'labeled',
            label: { name: 'in-progress' },
            actor: { login: 'me' },
            created_at: bump(T0, 500),
          },
        ],
        ownEventAt: bump(T0, 1000),
        duplicateWorkPulls: true,
      });
      const ticket = neutralTicket({ id: '42', updatedAt: T0 });
      const root = await bootstrapProject(ticket, 'in-progress');
      const runDir = await nativeSelectionFor(root, ticket, T0);

      await scopedRun(runDir, async () => {
        const { claim } = await load('github-issues.mjs');
        const result = claim(ticket, { projectRoot: root });

        expect(
          result,
          `two in-progress labelled events after the snapshot by the caller must never verify — ${JSON.stringify(result)}`,
        ).toMatchObject({ ok: false, claimed: false, reason: 'claim-contended' });
      });
    });
  });

  // round2.md "Decision on B1": the truthful semantics for GitHub are
  // stale-selection safe and verified against OTHER accounts; the SAME
  // account case is a stated, TESTED limit, never a claim of exclusivity.
  it('the documented same-account limit: two same-account controllers can both come back claimed:true (not a claim of exclusivity)', async () => {
    installed = await installGhFake({
      state: 'OPEN',
      labels: [],
      updatedAt: T0,
      login: 'me',
      events: [],
      ownEventAt: bump(T0, 1000),
      sameAccountRace: true,
      duplicateWorkPulls: true,
    });
    const ticket = neutralTicket({ id: '42', updatedAt: T0 });
    const rootA = await bootstrapProject(ticket, 'in-progress');
    const rootB = await bootstrapProject(ticket, 'in-progress');
    const runA = await nativeSelectionFor(rootA, ticket, T0);
    const runB = await nativeSelectionFor(rootB, ticket, T0);

    const [childA, childB] = await Promise.all([
      runGithubClaimChild(ticket, rootA, runA),
      runGithubClaimChild(ticket, rootB, runB),
    ]);
    expect(childA.code, childA.stderr).toBe(0);
    expect(childB.code, childB.stderr).toBe(0);
    const resultA = JSON.parse(childA.stdout) as Record<string, unknown>;
    const resultB = JSON.parse(childB.stdout) as Record<string, unknown>;
    const raceDir = `${installed.statePath}.same-account-race`;
    const raceMarkers = await readFile(
      path.join(raceDir, `${Buffer.from(runA).toString('hex')}.final`),
      'utf8',
    );
    expect(raceMarkers).toBe('');
    expect(
      await readFile(path.join(raceDir, `${Buffer.from(runB).toString('hex')}.final`), 'utf8'),
    ).toBe('');
    const finalState = JSON.parse(await readFile(installed.statePath, 'utf8')) as {
      events: Array<{ event: string; label: { name: string }; actor: { login: string } }>;
    };
    expect(
      finalState.events.filter(
        (event) =>
          event.event === 'labeled' &&
          event.label.name === 'in-progress' &&
          event.actor.login === 'me',
      ),
    ).toHaveLength(1);

    expect(resultA, `controller A: ${JSON.stringify(resultA)}`).toMatchObject({
      ok: true,
      claimed: true,
    });
    expect(
      resultB,
      `the same-GitHub-account limit means a second controller under the identical login also ` +
        `reads back as claimed:true — a stated, tested limit, never a claim of exclusivity: ${JSON.stringify(resultB)}`,
    ).toMatchObject({ ok: true, claimed: true });
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
