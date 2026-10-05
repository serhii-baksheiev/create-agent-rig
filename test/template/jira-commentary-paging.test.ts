import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

// Jira Cloud's GET /rest/api/3/issue/{key}/comment pages carry startAt,
// maxResults, total and comments only; unlike the search API they have no
// isLast field. The fixtures below copy that live shape, so the hydration's
// completion signal is tested against the API it actually talks to.
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

interface Call {
  url: URL;
}

const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
  });

const commentsFrom = (ids: string[]) => ids.map((id) => ({ id }));

let restoreFetch: typeof globalThis.fetch | undefined;

const installJira = (
  commentReply: (request: URL) => { body: unknown },
  searchReply: () => { body: unknown },
) => {
  const calls: Call[] = [];
  restoreFetch ??= globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const url = new URL(String(input));
    calls.push({ url });
    if (url.pathname === '/rest/api/3/search/jql') {
      return Promise.resolve(response(searchReply().body));
    }
    if (url.pathname === '/rest/api/3/issue/RP-368/comment') {
      return Promise.resolve(response(commentReply(url).body));
    }
    return Promise.resolve(new Response(null, { status: 404, statusText: 'Not Found' }));
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
});

it('hydrates a truncated comment window from comment pages that carry no isLast field, as Jira Cloud returns them', async () => {
  const noIsLastIds = Array.from({ length: 34 }, (_, index) => `rp368-comment-${index + 1}`);
  const noIsLastIssue = () => ({
    key: 'RP-368',
    fields: {
      summary: 'hydrate a truncated window Jira Cloud never marks isLast on',
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      labels: ['rel-1.2.0'],
      priority: null,
      created: '2026-10-03T00:00:00.000+0000',
      issuelinks: [],
      comment: { total: 34, comments: commentsFrom(noIsLastIds.slice(0, 20)) },
    },
  });

  const calls = installJira(
    (url) => {
      const startAt = Number(url.searchParams.get('startAt') ?? 0);
      if (startAt === 0) {
        return {
          body: {
            startAt: 0,
            maxResults: 20,
            total: 34,
            comments: commentsFrom(noIsLastIds.slice(0, 20)),
          },
        };
      }
      if (startAt === 20) {
        return {
          body: {
            startAt: 20,
            maxResults: 20,
            total: 34,
            comments: commentsFrom(noIsLastIds.slice(20)),
          },
        };
      }
      return { body: { startAt: 34, maxResults: 20, total: 34, comments: [] } };
    },
    () => ({ body: { issues: [noIsLastIssue()], isLast: true } }),
  );

  const tickets = (await list()) as Array<{
    id: string;
    commentary: { count: number; ids: string[]; complete: boolean };
  }>;

  expect(tickets).toHaveLength(1);
  expect(tickets[0]).toMatchObject({ id: 'RP-368' });
  expect(tickets[0]!.commentary).toEqual({
    count: noIsLastIds.length,
    ids: noIsLastIds,
    complete: true,
  });

  const commentCalls = calls.filter(
    (call) => call.url.pathname === '/rest/api/3/issue/RP-368/comment',
  );
  expect(commentCalls.map((call) => call.url.searchParams.get('startAt'))).toEqual(['0', '20']);
});
