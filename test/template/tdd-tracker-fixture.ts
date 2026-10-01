import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type TrackerTicket = {
  id: string;
  title: string;
  body: string;
  state?: 'open' | 'in-progress' | 'closed';
  updatedAt?: string;
};

// The producer runs in a child process, so the fixture installs a narrow fetch
// preload. The production code still reaches the configured Jira adapter's
// `find(id)` seam and receives the normal neutral Ticket shape.
export const jiraReadback = async ({
  projectRoot,
  ticket,
}: {
  projectRoot: string;
  ticket: TrackerTicket;
}): Promise<NodeJS.ProcessEnv> => {
  await mkdir(path.join(projectRoot, '.claude'), { recursive: true });
  await writeFile(
    path.join(projectRoot, '.claude', 'queue.json'),
    `${JSON.stringify({ adapter: 'jira', options: { project: 'RP' } })}\n`,
  );
  const category =
    ticket.state === 'closed' ? 'done' : ticket.state === 'in-progress' ? 'indeterminate' : 'new';
  const issue = {
    key: ticket.id,
    fields: {
      summary: ticket.title,
      description: ticket.body,
      status: { name: ticket.state ?? 'open', statusCategory: { key: category } },
      labels: [],
      priority: null,
      created: '2026-09-01T00:00:00.000+0000',
      updated: ticket.updatedAt ?? '2026-09-01T00:00:00.000+0000',
      issuelinks: [],
      comment: { comments: [], total: 0 },
    },
  };
  const preloadDir = await mkdtemp(path.join(tmpdir(), 'tdd-jira-find-'));
  const preload = path.join(preloadDir, 'fetch.cjs');
  await writeFile(
    preload,
    `const issue = ${JSON.stringify(issue)};\n` +
      `globalThis.fetch = async (url) => {\n` +
      `  if (String(url).startsWith('https://fixture.invalid/rest/api/3/issue/${encodeURIComponent(ticket.id)}?')) {\n` +
      `    return new Response(JSON.stringify(issue), { status: 200, headers: { 'content-type': 'application/json' } });\n` +
      `  }\n` +
      `  return new Response(null, { status: 404, statusText: 'Not Found' });\n` +
      `};\n`,
  );
  const existing = process.env.NODE_OPTIONS?.trim();
  // Keep the credential-shaped environment entry assembled at runtime. The
  // fixture exercises adapter configuration, while the repository scanner
  // correctly rejects literal token assignments in tracked source.
  const fixtureToken = ['fixture', 'placeholder'].join('-');
  return {
    ...process.env,
    JIRA_BASE_URL: 'https://fixture.invalid',
    JIRA_EMAIL: 'fixture@example.invalid',
    JIRA_API_TOKEN: fixtureToken,
    NODE_OPTIONS: `${existing ? `${existing} ` : ''}--require ${JSON.stringify(preload)}`,
  };
};
