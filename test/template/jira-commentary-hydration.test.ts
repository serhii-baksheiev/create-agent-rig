import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

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

const credentials = {
  JIRA_BASE_URL: 'https://example.invalid',
  JIRA_EMAIL: 'a@b.c',
  JIRA_API_TOKEN: 'x',
};

const expectedIds = Array.from({ length: 31 }, (_, index) => `comment-${index + 1}`);
const inlineIds = expectedIds.slice(0, 20);

const listedIssue = () => ({
  key: 'RP-368',
  fields: {
    summary: 'complete bounded Jira commentary metadata',
    status: { name: 'To Do', statusCategory: { key: 'new' } },
    labels: ['rel-1.2.0'],
    priority: null,
    created: '2026-10-03T00:00:00.000+0000',
    issuelinks: [],
    comment: { total: 31, comments: inlineIds.map((id) => ({ id })) },
  },
});

interface Call {
  url: URL;
  method: string;
  signal: AbortSignal | null;
}

interface Reply {
  status?: number;
  statusText?: string;
  body?: unknown;
  headers?: Record<string, string>;
  stream?: ReadableStream<Uint8Array>;
}

const response = ({
  status = 200,
  statusText = 'OK',
  body = {},
  headers = {},
  stream,
}: Reply = {}) =>
  new Response(stream ?? (status === 204 ? null : JSON.stringify(body)), {
    status,
    statusText,
    headers: { 'content-type': 'application/json', ...headers },
  });

const commentaryPage = (
  startAt: number,
  comments: Array<Record<string, unknown>>,
  {
    total = 31,
    isLast = typeof total === 'number' && startAt + comments.length >= total,
    headers = {},
  }: { total?: unknown; isLast?: boolean; headers?: Record<string, string> } = {},
): Reply => ({
  body: { startAt, maxResults: 20, total, isLast, comments },
  headers,
});

const commentsFrom = (ids: string[]) => ids.map((id) => ({ id }));

let restoreFetch: typeof globalThis.fetch | undefined;

const installJira = (
  commentReply: (request: URL, call: number, signal: AbortSignal | null) => Reply | Promise<Reply>,
  searchReply: (
    request: URL,
    call: number,
    signal: AbortSignal | null,
  ) => Reply | Promise<Reply> = () => ({ body: { issues: [listedIssue()], isLast: true } }),
) => {
  const calls: Call[] = [];
  restoreFetch ??= globalThis.fetch;
  globalThis.fetch = ((input: unknown, init: { method?: string; signal?: AbortSignal } = {}) => {
    const url = new URL(String(input));
    const call = { url, method: String(init.method ?? 'GET'), signal: init.signal ?? null };
    calls.push(call);
    if (url.pathname === '/rest/api/3/search/jql') {
      const searchCalls = calls.filter(
        (entry) => entry.url.pathname === '/rest/api/3/search/jql',
      ).length;
      return Promise.resolve(searchReply(url, searchCalls, call.signal)).then(response);
    }
    // Generalised from a single hardcoded RP-368 path so a test can install a
    // second issue's comment route too (RP-368's own call-count filters below
    // still match only its own pathname, so every existing assertion is unaffected).
    if (/^\/rest\/api\/3\/issue\/[^/]+\/comment$/.test(url.pathname)) {
      const commentCalls = calls.filter((entry) => entry.url.pathname === url.pathname).length;
      return Promise.resolve(commentReply(url, commentCalls, call.signal)).then(response);
    }
    return Promise.resolve(response({ status: 404, statusText: 'Not Found' }));
  }) as unknown as typeof globalThis.fetch;
  return calls;
};

const list = async () => {
  const { listEligible } = await load('jira.mjs');
  return listEligible({ project: 'RP', env: credentials });
};

afterEach(() => {
  if (restoreFetch) globalThis.fetch = restoreFetch;
  restoreFetch = undefined;
  vi.useRealTimers();
});

it('hydrates every comment before mapping a listed Jira issue while preserving authoritative completeness', async () => {
  const calls = installJira((url) => {
    const startAt = Number(url.searchParams.get('startAt') ?? 0);
    return startAt === 0
      ? commentaryPage(0, commentsFrom(expectedIds.slice(0, 20)), { isLast: false })
      : commentaryPage(20, commentsFrom(expectedIds.slice(20)));
  });

  const tickets = (await list()) as Array<{
    id: string;
    commentary: { count: number; ids: string[]; complete: boolean };
  }>;

  expect(tickets).toHaveLength(1);
  expect(tickets[0]).toMatchObject({ id: 'RP-368' });
  expect(tickets[0]!.commentary).toEqual({
    count: expectedIds.length,
    ids: expectedIds,
    complete: true,
  });
  expect(new Set(tickets[0]!.commentary.ids).size).toBe(expectedIds.length);

  const commentCalls = calls.filter(
    (call) => call.url.pathname === '/rest/api/3/issue/RP-368/comment',
  );
  expect(commentCalls).toHaveLength(2);
  expect(commentCalls.map((call) => call.url.searchParams.get('startAt'))).toEqual(['0', '20']);
  expect(commentCalls.every((call) => call.method === 'GET')).toBe(true);
  expect(commentCalls.every((call) => call.signal instanceof AbortSignal)).toBe(true);

  // A second, independently truncated issue whose own comment read is
  // unavailable: its failure stays scoped to it — RP-368 above still
  // hydrates complete, this one is listed with its inline window and
  // `complete: false`, and the selection as a whole still resolves.
  const secondIssueInlineIds = Array.from(
    { length: 20 },
    (_, index) => `rp369-comment-${index + 1}`,
  );
  const secondIssue = () => ({
    key: 'RP-369',
    fields: {
      summary: 'a second truncated issue whose comment read is unavailable',
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      labels: ['rel-1.2.0'],
      priority: null,
      created: '2026-10-03T00:00:00.000+0000',
      issuelinks: [],
      comment: { total: 25, comments: commentsFrom(secondIssueInlineIds) },
    },
  });

  const twoIssueCalls = installJira(
    (url) => {
      if (url.pathname === '/rest/api/3/issue/RP-369/comment') {
        return { status: 503, statusText: 'Service Unavailable' };
      }
      const startAt = Number(url.searchParams.get('startAt') ?? 0);
      return startAt === 0
        ? commentaryPage(0, commentsFrom(expectedIds.slice(0, 20)), { isLast: false })
        : commentaryPage(20, commentsFrom(expectedIds.slice(20)));
    },
    () => ({ body: { issues: [listedIssue(), secondIssue()], isLast: true } }),
  );

  const twoTickets = (await list()) as Array<{
    id: string;
    commentary: { count: number; ids: string[]; complete: boolean };
  }>;

  expect(twoTickets).toHaveLength(2);
  const hydratedRp368 = twoTickets.find((ticket) => ticket.id === 'RP-368');
  const unavailableRp369 = twoTickets.find((ticket) => ticket.id === 'RP-369');
  expect(hydratedRp368?.commentary).toEqual({
    count: expectedIds.length,
    ids: expectedIds,
    complete: true,
  });
  expect(unavailableRp369?.commentary).toEqual({
    count: 25,
    ids: secondIssueInlineIds,
    complete: false,
  });
  expect(
    twoIssueCalls.filter((call) => call.url.pathname === '/rest/api/3/issue/RP-369/comment'),
  ).toHaveLength(1);

  const chunk = new TextEncoder().encode('x'.repeat(256 * 1024));
  let pulls = 0;
  let pulledBytes = 0;
  let cancelled = false;
  const streamingCalls = installJira(() => ({
    stream: new ReadableStream({
      pull(controller) {
        if (pulls === 8) {
          controller.close();
          return;
        }
        pulls += 1;
        pulledBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    }),
  }));

  const streamedTickets = (await list()) as Array<{
    id: string;
    commentary: { count: number; ids: string[]; complete: boolean };
  }>;
  expect(streamedTickets).toHaveLength(1);
  expect(streamedTickets[0]!.commentary).toEqual({
    count: expectedIds.length,
    ids: inlineIds,
    complete: false,
  });
  expect(
    streamingCalls.filter((call) => call.url.pathname === '/rest/api/3/issue/RP-368/comment'),
  ).toHaveLength(1);
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThanOrEqual(5);
  expect(pulledBytes).toBeLessThanOrEqual(5 * chunk.byteLength);

  const oversizedChunk = new Uint8Array(1024 * 1024 + 1);
  let oversizedPulls = 0;
  const copySpy = vi.spyOn(Buffer, 'from');
  const oversizedCalls = installJira(() => ({
    stream: new ReadableStream(
      {
        pull(controller) {
          oversizedPulls += 1;
          if (oversizedPulls === 1) controller.enqueue(oversizedChunk);
          else controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
  }));

  try {
    const oversizedTickets = (await list()) as Array<{
      id: string;
      commentary: { count: number; ids: string[]; complete: boolean };
    }>;
    expect(oversizedTickets).toHaveLength(1);
    expect(oversizedTickets[0]!.commentary).toEqual({
      count: expectedIds.length,
      ids: inlineIds,
      complete: false,
    });
    expect(
      oversizedCalls.filter((call) => call.url.pathname === '/rest/api/3/issue/RP-368/comment'),
    ).toHaveLength(1);
    expect(copySpy.mock.calls.filter(([value]) => value === oversizedChunk)).toHaveLength(0);
    expect(oversizedPulls).toBe(1);
  } finally {
    copySpy.mockRestore();
  }

  await load('jira.mjs');
  vi.useFakeTimers();
  let firstSearchStarted!: () => void;
  const firstSearch = new Promise<void>((resolve) => {
    firstSearchStarted = resolve;
  });
  let secondSearchStarted!: () => void;
  const secondSearch = new Promise<void>((resolve) => {
    secondSearchStarted = resolve;
  });
  let secondAborted = false;
  const searchCalls = installJira(
    () => ({ status: 500, statusText: 'comment hydration must not start' }),
    (_url, call, signal) => {
      if (call === 1) {
        firstSearchStarted();
        return new Promise<Reply>((resolve) => {
          setTimeout(
            () => resolve({ body: { issues: [listedIssue()], nextPageToken: 'page-2' } }),
            11_000,
          );
        });
      }
      secondSearchStarted();
      return new Promise<Reply>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          secondAborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    },
  );

  const deadlineFailure = list().then(
    () => {
      throw new Error('the second search request unexpectedly completed after the shared deadline');
    },
    (error) => error,
  );
  await firstSearch;
  await vi.advanceTimersByTimeAsync(11_000);
  await secondSearch;
  await vi.advanceTimersByTimeAsync(9_000);
  expect(secondAborted).toBe(true);
  await expect(deadlineFailure).resolves.toMatchObject({
    message: expect.stringMatching(/timed out|timeout|budget/i),
  });
  expect(searchCalls.filter((call) => call.url.pathname === '/rest/api/3/search/jql')).toHaveLength(
    2,
  );
  expect(
    searchCalls.filter((call) => call.url.pathname === '/rest/api/3/issue/RP-368/comment'),
  ).toHaveLength(0);
});

it('leaves only that ticket incomplete when the authoritative comment read is unavailable or incomplete', async () => {
  installJira(() => ({ status: 503, statusText: 'Service Unavailable' }));
  const unavailable = (await list()) as Array<{
    id: string;
    commentary: { count: number; ids: string[]; complete: boolean };
  }>;
  expect(unavailable).toHaveLength(1);
  expect(unavailable[0]!.commentary).toEqual({
    count: expectedIds.length,
    ids: inlineIds,
    complete: false,
  });

  const calls = installJira(() =>
    commentaryPage(0, commentsFrom(expectedIds.slice(0, 20)), { isLast: true }),
  );
  const incomplete = (await list()) as Array<{
    id: string;
    commentary: { count: number; ids: string[]; complete: boolean };
  }>;
  expect(incomplete).toHaveLength(1);
  expect(incomplete[0]!.commentary).toEqual({
    count: expectedIds.length,
    ids: inlineIds,
    complete: false,
  });
  expect(
    calls.filter((call) => call.url.pathname === '/rest/api/3/issue/RP-368/comment'),
  ).toHaveLength(1);
});

it.each([
  {
    name: 'duplicates',
    pages: [
      commentaryPage(0, commentsFrom([...expectedIds.slice(0, 19), expectedIds[0]!]), {
        isLast: false,
      }),
      commentaryPage(20, commentsFrom(expectedIds.slice(20))),
    ],
  },
  {
    name: 'omits an id',
    pages: [
      commentaryPage(0, [...commentsFrom(expectedIds.slice(0, 19)), {}], { isLast: false }),
      commentaryPage(20, commentsFrom(expectedIds.slice(20))),
    ],
  },
  {
    name: 'carries corrupt total metadata',
    pages: [
      commentaryPage(0, commentsFrom(expectedIds.slice(0, 20)), {
        total: '31',
        isLast: false,
      }),
    ],
  },
])(
  'leaves only that ticket incomplete before mapping when an authoritative comment page $name',
  async ({ pages }) => {
    installJira((_url, call) => pages[Math.min(call - 1, pages.length - 1)]!);
    const tickets = (await list()) as Array<{
      id: string;
      commentary: { count: number; ids: string[]; complete: boolean };
    }>;
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.commentary).toEqual({
      count: expectedIds.length,
      ids: inlineIds,
      complete: false,
    });
  },
);

it('leaves only that ticket incomplete when its declared record total exceeds the bounded hydration cap before it accumulates comments', async () => {
  const calls = installJira(() =>
    commentaryPage(0, commentsFrom(expectedIds.slice(0, 20)), { total: 1001, isLast: false }),
  );

  const tickets = (await list()) as Array<{
    id: string;
    commentary: { count: number; ids: string[]; complete: boolean };
  }>;
  expect(tickets).toHaveLength(1);
  expect(tickets[0]!.commentary).toEqual({
    count: expectedIds.length,
    ids: inlineIds,
    complete: false,
  });
  expect(
    calls.filter((call) => call.url.pathname === '/rest/api/3/issue/RP-368/comment'),
  ).toHaveLength(1);
});

it("leaves only that ticket incomplete when a page stream's total grows, rather than accumulating an unbounded authoritative read", async () => {
  const calls = installJira((url) => {
    const startAt = Number(url.searchParams.get('startAt') ?? 0);
    return commentaryPage(startAt, commentsFrom(expectedIds.slice(startAt, startAt + 20)), {
      total: startAt === 0 ? 31 : 32,
      isLast: false,
    });
  });

  const tickets = (await list()) as Array<{
    id: string;
    commentary: { count: number; ids: string[]; complete: boolean };
  }>;
  expect(tickets).toHaveLength(1);
  expect(tickets[0]!.commentary).toEqual({
    count: expectedIds.length,
    ids: inlineIds,
    complete: false,
  });
  expect(
    calls.filter((call) => call.url.pathname === '/rest/api/3/issue/RP-368/comment'),
  ).toHaveLength(2);
});

it('leaves only that ticket incomplete when a comment page exceeds the byte budget before its records reach the mapper', async () => {
  installJira(() =>
    commentaryPage(0, commentsFrom(expectedIds.slice(0, 20)), {
      isLast: false,
      headers: { 'content-length': String(1024 * 1024 * 16) },
    }),
  );

  const tickets = (await list()) as Array<{
    id: string;
    commentary: { count: number; ids: string[]; complete: boolean };
  }>;
  expect(tickets).toHaveLength(1);
  expect(tickets[0]!.commentary).toEqual({
    count: expectedIds.length,
    ids: inlineIds,
    complete: false,
  });
});

it('leaves only that ticket incomplete when an authoritative comment page never finishes, once its timeout fires', async () => {
  vi.useFakeTimers();
  let commentRequestStarted!: () => void;
  const commentRequest = new Promise<void>((resolve) => {
    commentRequestStarted = resolve;
  });
  const calls = installJira((_url, _call, signal) => {
    commentRequestStarted();
    return new Promise<Reply>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  });

  // Attached synchronously, so a rejection while the timer is advanced below
  // is never briefly unhandled — the same shape the deadline case further up
  // this file uses for the same reason.
  const outcome = list().then(
    (tickets) => ({ tickets }),
    (error) => ({ error }),
  ) as Promise<{
    tickets?: Array<{
      id: string;
      commentary: { count: number; ids: string[]; complete: boolean };
    }>;
    error?: Error;
  }>;
  await commentRequest;
  expect(
    calls.filter((call) => call.url.pathname === '/rest/api/3/issue/RP-368/comment'),
  ).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(20_000);
  const result = await outcome;
  if (result.error) throw result.error;
  const tickets = result.tickets!;
  expect(tickets).toHaveLength(1);
  expect(tickets[0]!.commentary).toEqual({
    count: expectedIds.length,
    ids: inlineIds,
    complete: false,
  });
});

it('makes zero comment requests for a later truncated ticket once one ticket has exhausted the shared records budget', async () => {
  // One ticket's declared total (1000) consumes the entire shared
  // MAX_COMMENT_RECORDS budget in a single page — a bound this fixture must
  // respect too, so it returns all 1000 comments at once rather than paging.
  const exhaustingIds = Array.from({ length: 1000 }, (_, index) => `rp900-comment-${index + 1}`);
  const exhaustingIssue = () => ({
    key: 'RP-900',
    fields: {
      summary: 'a ticket whose declared comment total alone exhausts the shared records budget',
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      labels: ['rel-1.2.0'],
      priority: null,
      created: '2026-10-03T00:00:00.000+0000',
      issuelinks: [],
      comment: { total: 1000, comments: commentsFrom(exhaustingIds.slice(0, 20)) },
    },
  });

  const calls = installJira(
    (url) => {
      if (url.pathname === '/rest/api/3/issue/RP-900/comment') {
        return commentaryPage(0, commentsFrom(exhaustingIds), { total: 1000, isLast: true });
      }
      // RP-368's comment endpoint must never be reached once the shared
      // budget is exhausted — if it is, this loudly distinct failure makes
      // that visible instead of silently returning a plausible page.
      return {
        status: 500,
        statusText: 'RP-368 comment must not be requested once the shared budget is exhausted',
      };
    },
    () => ({ body: { issues: [exhaustingIssue(), listedIssue()], isLast: true } }),
  );

  const tickets = (await list()) as Array<{
    id: string;
    commentary: { count: number; ids: string[]; complete: boolean };
  }>;

  expect(tickets).toHaveLength(2);
  const exhausting = tickets.find((ticket) => ticket.id === 'RP-900');
  const starved = tickets.find((ticket) => ticket.id === 'RP-368');
  expect(exhausting?.commentary).toEqual({ count: 1000, ids: exhaustingIds, complete: true });
  expect(starved?.commentary).toEqual({
    count: expectedIds.length,
    ids: inlineIds,
    complete: false,
  });
  expect(
    calls.filter((call) => call.url.pathname === '/rest/api/3/issue/RP-368/comment'),
  ).toHaveLength(0);
});

// RP-368 round 2, blocker B1: `readTextWithinByteLimit` throws when a page
// overflows its own byte limit BEFORE the bytes it already read are charged
// to `budget.bytes` (the charge only runs on the success path, after the page
// has been fully read and parsed). A failed, over-limit page must still spend
// the shared byte budget it pulled — otherwise every later truncated issue is
// handed the FULL MAX_COMMENT_BYTES allowance again, and a board with many
// truncated issues each streaming an oversized page reads every one of them
// in full instead of stopping once the selection's shared budget is spent.
it("makes zero comment requests for a later truncated ticket once one ticket's overflowing page has exhausted the shared byte budget", async () => {
  // One ticket's comment page overflows the ENTIRE shared MAX_COMMENT_BYTES
  // budget in its very first chunk — the budget is spent here by reading more
  // than the per-page byte limit allows, not by declaring a huge total (that
  // is the RECORDS-budget case just above this one).
  const overflowingInlineIds = Array.from(
    { length: 20 },
    (_, index) => `rp910-comment-${index + 1}`,
  );
  const overflowingIssue = () => ({
    key: 'RP-910',
    fields: {
      summary: 'a ticket whose comment page overflows the shared byte budget',
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      labels: ['rel-1.2.0'],
      priority: null,
      created: '2026-10-03T00:00:00.000+0000',
      issuelinks: [],
      comment: { total: 31, comments: commentsFrom(overflowingInlineIds) },
    },
  });

  // 1 MiB + 1 byte: one byte over jira.mjs's own MAX_COMMENT_BYTES, hard-coded
  // here rather than imported — the same convention the oversized-chunk case
  // earlier in this file already uses.
  const overflowChunk = new Uint8Array(1024 * 1024 + 1);

  const calls = installJira(
    (url) => {
      if (url.pathname === '/rest/api/3/issue/RP-910/comment') {
        return {
          stream: new ReadableStream({
            pull(controller) {
              controller.enqueue(overflowChunk);
              controller.close();
            },
          }),
        };
      }
      // RP-368's comment endpoint must never be reached once the shared BYTE
      // budget is exhausted — if it is, this loudly distinct failure makes
      // that visible instead of silently returning a plausible page.
      return {
        status: 500,
        statusText: 'RP-368 comment must not be requested once the shared byte budget is exhausted',
      };
    },
    () => ({ body: { issues: [overflowingIssue(), listedIssue()], isLast: true } }),
  );

  const tickets = (await list()) as Array<{
    id: string;
    commentary: { count: number; ids: string[]; complete: boolean };
  }>;

  expect(tickets).toHaveLength(2);
  const overflowing = tickets.find((ticket) => ticket.id === 'RP-910');
  const starved = tickets.find((ticket) => ticket.id === 'RP-368');
  expect(overflowing?.commentary).toEqual({
    count: 31,
    ids: overflowingInlineIds,
    complete: false,
  });
  expect(starved?.commentary).toEqual({
    count: expectedIds.length,
    ids: inlineIds,
    complete: false,
  });
  expect(
    calls.filter((call) => call.url.pathname === '/rest/api/3/issue/RP-368/comment'),
  ).toHaveLength(0);
});

// RP-368 round 2, blocker B2: `inlineCommentaryIsComplete` sends an issue to
// hydration whenever its inline `comment` field is malformed — a present
// `total` that is not a non-negative safe integer, or `comments` that is not
// an array. But once that hydration read fails (any status, including these
// 503s), the per-ticket catch in `listEligible` leaves the RAW issue for
// `toTicket` to map — and `toTicket` disagrees with `inlineCommentaryIsComplete`
// about the very same field: it falls back to `comments.length` / `[]` and
// reports `complete: true` for a shape `inlineCommentaryIsComplete` itself
// just refused to trust.
it.each([
  { name: 'total is missing entirely', comment: { comments: [{ id: '1' }] } },
  {
    name: 'total is a numeric string, not a number',
    comment: { total: '5', comments: [{ id: '1' }] },
  },
  {
    name: 'total is a number but not a safe integer',
    comment: { total: 5.5, comments: [{ id: '1' }] },
  },
  { name: 'total is present but comments is absent', comment: { total: 0 } },
  { name: 'total is present but comments is not an array', comment: { total: 0, comments: {} } },
])(
  'lists an issue complete: false when its authoritative read fails and the inline comment field it fell back to has $name',
  async ({ comment }) => {
    const malformedIssue = () => ({
      key: 'RP-920',
      fields: {
        summary: 'an issue whose inline comment field is malformed',
        status: { name: 'To Do', statusCategory: { key: 'new' } },
        labels: ['rel-1.2.0'],
        priority: null,
        created: '2026-10-03T00:00:00.000+0000',
        issuelinks: [],
        comment,
      },
    });
    installJira(
      () => ({ status: 503, statusText: 'Service Unavailable' }),
      () => ({ body: { issues: [malformedIssue()], isLast: true } }),
    );

    const tickets = (await list()) as Array<{
      id: string;
      commentary: { count: number; ids: string[]; complete: boolean };
    }>;
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.commentary.complete).toBe(false);
  },
);

it('maps an issue with no comment field at all to the empty, complete commentary set, with no hydration attempt', async () => {
  const noCommentIssue = () => ({
    key: 'RP-921',
    fields: {
      summary: 'an issue with no comment field at all',
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      labels: ['rel-1.2.0'],
      priority: null,
      created: '2026-10-03T00:00:00.000+0000',
      issuelinks: [],
    },
  });
  const calls = installJira(
    () => ({ status: 500, statusText: 'comment hydration must not be attempted' }),
    () => ({ body: { issues: [noCommentIssue()], isLast: true } }),
  );

  const tickets = (await list()) as Array<{
    id: string;
    commentary: { count: number; ids: string[]; complete: boolean };
  }>;
  expect(tickets).toHaveLength(1);
  expect(tickets[0]!.commentary).toEqual({ count: 0, ids: [], complete: true });
  expect(calls.filter((call) => /\/comment$/.test(call.url.pathname))).toHaveLength(0);
});
