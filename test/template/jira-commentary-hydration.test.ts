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
    if (url.pathname === '/rest/api/3/issue/RP-368/comment') {
      const commentCalls = calls.filter(
        (entry) => entry.url.pathname === '/rest/api/3/issue/RP-368/comment',
      ).length;
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

  await expect(list()).rejects.toThrow(/comment|byte|size|cap|limit|bound/i);
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
    await expect(list()).rejects.toThrow(/comment|byte|size|cap|limit|bound/i);
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

it('fails closed when the authoritative comment read is unavailable or incomplete', async () => {
  installJira(() => ({ status: 503, statusText: 'Service Unavailable' }));
  await expect(list()).rejects.toThrow(/comment|503|unavailable|authoritative/i);

  const calls = installJira(() =>
    commentaryPage(0, commentsFrom(expectedIds.slice(0, 20)), { isLast: true }),
  );
  await expect(list()).rejects.toThrow(/comment|incomplete|truncated|total|complete/i);
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
])('fails closed before mapping when an authoritative comment page $name', async ({ pages }) => {
  installJira((_url, call) => pages[Math.min(call - 1, pages.length - 1)]!);
  await expect(list()).rejects.toThrow(/comment|duplicate|id|metadata|total|complete/i);
});

it('rejects metadata whose declared record total exceeds the bounded hydration cap before it accumulates comments', async () => {
  const calls = installJira(() =>
    commentaryPage(0, commentsFrom(expectedIds.slice(0, 20)), { total: 1001, isLast: false }),
  );

  await expect(list()).rejects.toThrow(/comment|record|cap|limit|total|bound/i);
  expect(
    calls.filter((call) => call.url.pathname === '/rest/api/3/issue/RP-368/comment'),
  ).toHaveLength(1);
});

it('rejects a page stream whose total grows, rather than accumulating an unbounded authoritative read', async () => {
  const calls = installJira((url) => {
    const startAt = Number(url.searchParams.get('startAt') ?? 0);
    return commentaryPage(startAt, commentsFrom(expectedIds.slice(startAt, startAt + 20)), {
      total: startAt === 0 ? 31 : 32,
      isLast: false,
    });
  });

  await expect(list()).rejects.toThrow(/comment|grow|total|metadata|bound/i);
  expect(
    calls.filter((call) => call.url.pathname === '/rest/api/3/issue/RP-368/comment'),
  ).toHaveLength(2);
});

it('rejects a comment page that exceeds the byte budget before its records reach the mapper', async () => {
  installJira(() =>
    commentaryPage(0, commentsFrom(expectedIds.slice(0, 20)), {
      isLast: false,
      headers: { 'content-length': String(1024 * 1024 * 16) },
    }),
  );

  await expect(list()).rejects.toThrow(/comment|byte|size|cap|limit|bound/i);
});

it('applies a timeout to an authoritative comment page that never finishes', async () => {
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

  const pending = list();
  const rejected = expect(pending).rejects.toThrow(/comment|timed out|timeout/i);
  await commentRequest;
  expect(
    calls.filter((call) => call.url.pathname === '/rest/api/3/issue/RP-368/comment'),
  ).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(20_000);
  await rejected;
});
