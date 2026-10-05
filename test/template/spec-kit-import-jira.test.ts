import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

// RP-279 — the Spec Kit bridge gains a second target. Everything about WHICH
// tasks exist and HOW they depend on each other already lives in
// `spec-kit-import.mjs` (`parseTasks`, `creationOrder`, `dependenciesFor`,
// `reportFor`); this file is about the Jira-specific half: a Jira project key
// read from `.claude/queue.json`, Jira credentials from the environment, and
// native "Blocks" issue links instead of a body line a GitHub issue carries.
//
// The fake below is a stateful, in-process Jira standing in for
// `globalThis.fetch` — the same approach `queue-jira-visibility.test.ts` and
// `queue-jira.test.ts` already use for `jira.mjs` itself, because the thing
// under test here is reached through a real network call, not a subprocess:
// stubbing a child process's `fetch` would need a second process to answer
// it, where stubbing this process's own `fetch` needs nothing of the kind.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'universal',
  '.claude',
  'scripts',
  'queue',
);
const load = (file: string) => import(pathToFileURL(path.join(scriptsDir, file)).href);

const loadImporter = async () =>
  (await load('spec-kit-import.mjs')) as {
    importSpecKit: (options: {
      projectRoot: string;
      tasksPath?: string | null;
      dryRun?: boolean;
      target?: string;
    }) => Promise<Record<string, unknown>> | Record<string, unknown>;
  };

const CREDENTIALS = {
  JIRA_BASE_URL: 'https://jira.example.invalid',
  JIRA_EMAIL: 'rig@example.invalid',
  JIRA_API_TOKEN: 'test-token',
};

const temporaryPaths = new Set<string>();

const TASKS = [
  '# Tasks: Export',
  '',
  '## Phase 1: Setup',
  '',
  '- [ ] T001 Create the export configuration',
  '- [ ] T002 Generate exports (depends on T001)',
  '- [ ] T003 Document why T002 exists',
  '',
].join('\n');

/** A temporary project: one `specs/001-export/tasks.md`, one `.claude/queue.json`. */
const scratchProject = async (
  tasks = TASKS,
  queueConfig: Record<string, unknown> = { adapter: 'jira', options: { project: 'RP' } },
): Promise<{ dir: string }> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spec-kit-import-jira-'));
  temporaryPaths.add(dir);
  const tasksPath = path.join(dir, 'specs', '001-export', 'tasks.md');
  await mkdir(path.dirname(tasksPath), { recursive: true });
  await writeFile(tasksPath, tasks);
  await mkdir(path.join(dir, '.claude'), { recursive: true });
  await writeFile(path.join(dir, '.claude', 'queue.json'), `${JSON.stringify(queueConfig)}\n`);
  return { dir };
};

type StatusCategory = 'new' | 'indeterminate' | 'done';

/** From THIS issue's own point of view — exactly how `jira.mjs`'s `toTicket` reads a link. */
type FakeLink = { relation: 'blockedBy' | 'blocks' | 'relatesTo'; otherKey: string };

interface FakeIssue {
  key: string;
  summary: string;
  /** The description's paragraphs, flattened — `[marker, title]` for a projected task. */
  paragraphs: string[];
  labels: string[];
  statusCategory: StatusCategory;
  links: FakeLink[];
}

interface Call {
  method: string;
  pathname: string;
  search: string;
  body: unknown;
}

const BLOCKS_TYPE = { id: '1000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
const RELATES_TYPE = { id: '1010', name: 'Relates', inward: 'relates to', outward: 'relates to' };

const statusOf = (category: StatusCategory) => ({
  name: category === 'done' ? 'Done' : category === 'indeterminate' ? 'In Progress' : 'To Do',
  statusCategory: { key: category },
});

const adfOf = (paragraphs: string[]) => ({
  type: 'doc',
  version: 1,
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

const paragraphsOfAdf = (description: unknown): string[] => {
  const doc = description as { content?: Array<{ content?: Array<{ text?: string }> }> } | null;
  return (doc?.content ?? []).map((paragraph) => paragraph.content?.[0]?.text ?? '');
};

interface FakeJiraOptions {
  issues?: FakeIssue[];
  /** Keys the search JQL omits entirely — a lagging search index. */
  unindexed?: string[];
  /** Keys search returns regardless of their live label — a STALE positive. */
  forceSearchHits?: string[];
  linkTypes?: Array<{ id: string; name: string; inward: string; outward: string }>;
  permissions?: Partial<
    Record<'BROWSE_PROJECTS' | 'CREATE_ISSUES' | 'EDIT_ISSUES' | 'LINK_ISSUES', boolean>
  >;
  createmetaHasIssueLinks?: boolean;
  /** Forces the repeated-page-token stop in `jira.mjs`'s own `search`, so it reports an incomplete read. */
  searchTruncated?: boolean;
  /** Summaries whose create request answers 500 — modelling one failed write. */
  failCreateSummaries?: string[];
  projectKey?: string;
}

const isMutatingCall = (call: Call) =>
  (call.method === 'POST' &&
    (call.pathname === '/rest/api/3/issue' || call.pathname === '/rest/api/3/issueLink')) ||
  call.method === 'PUT';

/** A tiny, stateful, in-memory Jira — enough of the REST surface to drive the importer. */
const createFakeJira = (options: FakeJiraOptions = {}) => {
  const projectKey = options.projectKey ?? 'RP';
  const issues = new Map<string, FakeIssue>(
    (options.issues ?? []).map((issue) => [issue.key, issue]),
  );
  const unindexed = new Set(options.unindexed ?? []);
  const forceSearchHits = new Set(options.forceSearchHits ?? []);
  const linkTypes = options.linkTypes ?? [BLOCKS_TYPE];
  const permissions = {
    BROWSE_PROJECTS: true,
    CREATE_ISSUES: true,
    EDIT_ISSUES: true,
    LINK_ISSUES: true,
    ...options.permissions,
  };
  const createmetaHasIssueLinks = options.createmetaHasIssueLinks ?? true;
  const failCreateSummaries = new Set(options.failCreateSummaries ?? []);
  let nextId = 101;

  const calls: Call[] = [];

  const fieldsOf = (issue: FakeIssue) => ({
    summary: issue.summary,
    description: adfOf(issue.paragraphs),
    labels: issue.labels,
    status: statusOf(issue.statusCategory),
    issuelinks: issue.links.map((link) => {
      const other = {
        key: link.otherKey,
        fields: { status: statusOf(issues.get(link.otherKey)?.statusCategory ?? 'new') },
      };
      if (link.relation === 'blockedBy') return { type: BLOCKS_TYPE, inwardIssue: other };
      if (link.relation === 'blocks') return { type: BLOCKS_TYPE, outwardIssue: other };
      return { type: RELATES_TYPE, inwardIssue: other };
    }),
  });

  /** X is blocked by Y — recorded on both issues, each from its own point of view. */
  const addBlocksLink = (dependentKey: string, blockerKey: string) => {
    const dependent = issues.get(dependentKey);
    const blocker = issues.get(blockerKey);
    if (!dependent || !blocker) {
      throw new Error(
        `fake Jira: cannot link ${dependentKey} to ${blockerKey} — one of them does not exist`,
      );
    }
    if (
      !dependent.links.some((link) => link.relation === 'blockedBy' && link.otherKey === blockerKey)
    ) {
      dependent.links.push({ relation: 'blockedBy', otherKey: blockerKey });
    }
    if (
      !blocker.links.some((link) => link.relation === 'blocks' && link.otherKey === dependentKey)
    ) {
      blocker.links.push({ relation: 'blocks', otherKey: dependentKey });
    }
  };

  const respond = (status: number, json: unknown = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText:
      status === 200 ? 'OK' : status === 201 ? 'Created' : status === 204 ? 'No Content' : 'Error',
    headers: { get: () => null },
    json: async () => json,
    text: async () => JSON.stringify(json),
  });

  const fetchImpl = (async (input: unknown, init: { method?: string; body?: string } = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ method, pathname: url.pathname, search: url.search, body });

    if (url.pathname === '/rest/api/3/mypermissions' && method === 'GET') {
      const requested = (url.searchParams.get('permissions') ?? '').split(',').filter(Boolean);
      return respond(200, {
        permissions: Object.fromEntries(
          requested.map((name) => [
            name,
            { havePermission: permissions[name as keyof typeof permissions] !== false },
          ]),
        ),
      });
    }

    if (url.pathname === '/rest/api/3/issueLinkType' && method === 'GET') {
      return respond(200, { issueLinkTypes: linkTypes });
    }

    if (url.pathname === '/rest/api/3/issue/createmeta' && method === 'GET') {
      return respond(200, {
        projects: [
          {
            key: projectKey,
            issuetypes: [
              {
                name: 'Task',
                fields: createmetaHasIssueLinks
                  ? { summary: {}, description: {}, issuelinks: {} }
                  : { summary: {}, description: {} },
              },
            ],
          },
        ],
      });
    }

    if (url.pathname === '/rest/api/3/search/jql' && method === 'POST') {
      const matching = [...issues.values()]
        .filter(
          (issue) =>
            (issue.labels.includes('rig-spec-kit') || forceSearchHits.has(issue.key)) &&
            !unindexed.has(issue.key),
        )
        .map((issue) => ({ key: issue.key, fields: fieldsOf(issue) }));
      if (options.searchTruncated) {
        // The same token every time: `jira.mjs`'s own repeated-page-token stop
        // (queue-jira.test.ts › "search reports truncated") fires on the
        // second request and the walk is reported incomplete.
        return respond(200, { issues: matching, nextPageToken: 'repeats-forever' });
      }
      return respond(200, { issues: matching, isLast: true });
    }

    const singleIssue = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(url.pathname);
    if (singleIssue && method === 'GET') {
      const issue = issues.get(singleIssue[1]!);
      if (!issue) return respond(404, { errorMessages: ['Issue does not exist'] });
      return respond(200, { key: issue.key, fields: fieldsOf(issue) });
    }

    if (url.pathname === '/rest/api/3/issue' && method === 'POST') {
      const fields = (body as { fields: Record<string, unknown> }).fields;
      const summary = String(fields.summary ?? '');
      if (failCreateSummaries.has(summary)) {
        return respond(500, { errorMessages: ['internal error'] });
      }
      const key = `${projectKey}-${nextId}`;
      nextId += 1;
      const created: FakeIssue = {
        key,
        summary,
        paragraphs: paragraphsOfAdf(fields.description),
        labels: Array.isArray(fields.labels) ? (fields.labels as string[]) : [],
        statusCategory: 'new',
        links: [],
      };
      issues.set(key, created);
      const updateLinks =
        (
          body as {
            update?: { issuelinks?: Array<{ add?: { outwardIssue?: { key: string } } }> };
          }
        ).update?.issuelinks ?? [];
      for (const entry of updateLinks) {
        const blockerKey = entry.add?.outwardIssue?.key;
        if (blockerKey) addBlocksLink(key, blockerKey);
      }
      return respond(201, {
        id: key,
        key,
        self: `https://jira.example.invalid/rest/api/3/issue/${key}`,
      });
    }

    if (singleIssue && method === 'PUT') {
      const issue = issues.get(singleIssue[1]!);
      if (!issue) return respond(404, { errorMessages: ['Issue does not exist'] });
      const fields =
        (body as { fields?: { summary?: string; description?: unknown } }).fields ?? {};
      if (typeof fields.summary === 'string') issue.summary = fields.summary;
      if (fields.description !== undefined) issue.paragraphs = paragraphsOfAdf(fields.description);
      return respond(204);
    }

    if (url.pathname === '/rest/api/3/issueLink' && method === 'POST') {
      const linkBody = body as { inwardIssue?: { key: string }; outwardIssue?: { key: string } };
      const dependentKey = linkBody.inwardIssue?.key;
      const blockerKey = linkBody.outwardIssue?.key;
      if (!dependentKey || !blockerKey)
        return respond(400, { errorMessages: ['missing issue keys'] });
      addBlocksLink(dependentKey, blockerKey);
      return respond(201, {});
    }

    throw new Error(`fake Jira: unhandled request ${method} ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;

  return {
    fetchImpl,
    calls,
    issues,
    /** Every issue, in the raw shape `jira.mjs`'s offline `issues` seam expects. */
    rawIssues: () =>
      [...issues.values()].map((issue) => ({ key: issue.key, fields: fieldsOf(issue) })),
  };
};

const withFetch = async <T>(
  jira: ReturnType<typeof createFakeJira>,
  body: () => Promise<T> | T,
): Promise<T> => {
  const real = globalThis.fetch;
  globalThis.fetch = jira.fetchImpl;
  try {
    return await body();
  } finally {
    globalThis.fetch = real;
  }
};

/** The key of the issue carrying this task's marker — found by reading the fake's own state. */
const keyFor = (jira: ReturnType<typeof createFakeJira>, identity: string): string => {
  const marker = `rig-spec-kit-task:${identity}`;
  const found = [...jira.issues.values()].find((issue) => issue.paragraphs[0] === marker);
  if (!found) throw new Error(`fake Jira: no issue carries marker ${marker}`);
  return found.key;
};

describe('queue import spec-kit --to jira (RP-279)', () => {
  let previousEnv: Record<string, string | undefined>;

  beforeEach(() => {
    previousEnv = Object.fromEntries(
      Object.keys(CREDENTIALS).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, CREDENTIALS);
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all([...temporaryPaths].map((temporaryPath) => removeFixture(temporaryPath)));
    temporaryPaths.clear();
  });

  it("dry-run report matches the github-issues target's shape and identities for the same tasks.md", async () => {
    const { dir } = await scratchProject();
    const jira = createFakeJira();
    const { importSpecKit } = await loadImporter();

    const report = await withFetch(jira, () =>
      importSpecKit({ projectRoot: dir, dryRun: true, target: 'jira' }),
    );

    expect(report).toMatchObject({
      dryRun: true,
      source: 'spec-kit',
      target: 'jira',
      taskCount: 3,
      dependencyCount: 1,
      counts: { create: 3, update: 0, unchanged: 0 },
      changes: [
        { identity: '001-export:T001', action: 'create', dependencies: [] },
        { identity: '001-export:T002', action: 'create', dependencies: ['001-export:T001'] },
        { identity: '001-export:T003', action: 'create', dependencies: [] },
      ],
    });
    const search = jira.calls.find((call) => call.pathname === '/rest/api/3/search/jql');
    expect((search?.body as { jql?: string } | null)?.jql).toBe(
      'project = RP AND labels = "rig-spec-kit"',
    );
    expect(jira.calls.filter(isMutatingCall), 'a dry run reads only and never writes').toEqual([]);
  });

  it('creates dependents with their Blocks link in the create request, then an identical reimport is unchanged', async () => {
    const { dir } = await scratchProject();
    const jira = createFakeJira();
    const { importSpecKit } = await loadImporter();

    const first = await withFetch(jira, () => importSpecKit({ projectRoot: dir, target: 'jira' }));
    expect(first).toMatchObject({ counts: { create: 3, update: 0, unchanged: 0 } });

    const t001Key = keyFor(jira, '001-export:T001');
    const t002 = jira.issues.get(keyFor(jira, '001-export:T002'))!;
    const t003 = jira.issues.get(keyFor(jira, '001-export:T003'))!;

    expect(t002.labels).toContain('rig-spec-kit');
    expect(t002.labels).not.toContain('triage');
    expect(t002.labels).not.toContain('operator-queue');
    expect(t002.paragraphs).toEqual(['rig-spec-kit-task:001-export:T002', 'Generate exports']);
    expect(t002.links).toEqual([{ relation: 'blockedBy', otherKey: t001Key }]);
    expect(t003.links).toEqual([]);

    const t002Create = jira.calls.find(
      (call) =>
        call.method === 'POST' &&
        call.pathname === '/rest/api/3/issue' &&
        (call.body as { fields: { summary: string } }).fields.summary === t002.summary,
    );
    expect(
      (
        t002Create?.body as {
          update?: {
            issuelinks?: Array<{
              add?: { type?: { name: string }; outwardIssue?: { key: string } };
            }>;
          };
        }
      )?.update?.issuelinks,
    ).toEqual([{ add: { type: { name: 'Blocks' }, outwardIssue: { key: t001Key } } }]);
    expect(
      jira.calls.filter(
        (call) => call.method === 'POST' && call.pathname === '/rest/api/3/issueLink',
      ),
    ).toEqual([]);

    const second = await withFetch(jira, () => importSpecKit({ projectRoot: dir, target: 'jira' }));
    expect(second).toMatchObject({ counts: { create: 0, update: 0, unchanged: 3 } });
    expect([...jira.issues.values()]).toHaveLength(3);
    expect(
      jira.calls.filter(isMutatingCall),
      'the reimport must add no further writes once every issue and link already matches',
    ).toHaveLength(3);
  });

  it('an imported dependent is held by listEligible and selectNext until its blocker is done', async () => {
    const { dir } = await scratchProject();
    const jira = createFakeJira();
    const { importSpecKit } = await loadImporter();
    await withFetch(jira, () => importSpecKit({ projectRoot: dir, target: 'jira' }));

    const t001Key = keyFor(jira, '001-export:T001');
    const t002Key = keyFor(jira, '001-export:T002');
    const { listEligible } = await load('jira.mjs');
    const { selectNext } = await load('core.mjs');

    const beforeDone = (await listEligible({ issues: jira.rawIssues() })) as Array<{ id: string }>;
    const selectedBefore = selectNext(beforeDone, {}) as {
      ticket: { id: string } | null;
      skipped: Array<{ id: string; causes: string[] }>;
    };
    expect(selectedBefore.ticket?.id).toBe(t001Key);
    expect(selectedBefore.skipped).toContainEqual(
      expect.objectContaining({ id: t002Key, causes: ['blocked'] }),
    );

    jira.issues.get(t001Key)!.statusCategory = 'done';
    const afterDone = (await listEligible({ issues: jira.rawIssues() })) as Array<{ id: string }>;
    const selectedAfter = selectNext(afterDone, {}) as { ticket: { id: string } | null };
    expect(selectedAfter.ticket?.id).toBe(t002Key);
  });

  it('adds a missing Blocks link to an existing projected issue and leaves user links untouched', async () => {
    const { dir } = await scratchProject();
    const existing: FakeIssue[] = [
      {
        key: 'RP-1',
        summary: 'Create the export configuration',
        paragraphs: ['rig-spec-kit-task:001-export:T001', 'Create the export configuration'],
        labels: ['rig-spec-kit'],
        statusCategory: 'new',
        links: [],
      },
      {
        key: 'RP-2',
        summary: 'Generate exports',
        paragraphs: ['rig-spec-kit-task:001-export:T002', 'Generate exports'],
        labels: ['rig-spec-kit'],
        statusCategory: 'new',
        // the Blocks link to RP-1 is MISSING — this is the drift the import must repair
        links: [{ relation: 'relatesTo', otherKey: 'RP-500' }],
      },
      {
        key: 'RP-3',
        summary: 'Document why T002 exists',
        paragraphs: ['rig-spec-kit-task:001-export:T003', 'Document why T002 exists'],
        labels: ['rig-spec-kit'],
        statusCategory: 'new',
        links: [],
      },
      {
        key: 'RP-500',
        summary: 'Unrelated user work',
        paragraphs: ['Not managed by this importer'],
        labels: [],
        statusCategory: 'new',
        links: [{ relation: 'relatesTo', otherKey: 'RP-2' }],
      },
    ];
    const jira = createFakeJira({ issues: existing });
    const { importSpecKit } = await loadImporter();

    await withFetch(jira, () => importSpecKit({ projectRoot: dir, target: 'jira' }));

    expect(
      jira.calls.filter(
        (call) => call.method === 'POST' && call.pathname === '/rest/api/3/issueLink',
      ),
    ).toEqual([
      {
        method: 'POST',
        pathname: '/rest/api/3/issueLink',
        search: '',
        body: {
          type: { name: 'Blocks' },
          inwardIssue: { key: 'RP-2' },
          outwardIssue: { key: 'RP-1' },
        },
      },
    ]);
    expect(
      jira.calls.filter((call) => call.method === 'POST' && call.pathname === '/rest/api/3/issue'),
    ).toEqual([]);
    const rp2 = jira.issues.get('RP-2')!;
    expect(rp2.links).toContainEqual({ relation: 'blockedBy', otherKey: 'RP-1' });
    expect(rp2.links).toContainEqual({ relation: 'relatesTo', otherKey: 'RP-500' });
    expect(jira.issues.get('RP-500')!.links).toEqual([{ relation: 'relatesTo', otherKey: 'RP-2' }]);
  });

  it('refuses a stale projected link before any write', async () => {
    const tasks = [
      '# Tasks: Export',
      '',
      '- [ ] T001 Create the export configuration',
      '- [ ] T002 Generate exports',
      '',
    ].join('\n');
    const { dir } = await scratchProject(tasks);
    const rp1: FakeIssue = {
      key: 'RP-1',
      summary: 'Create the export configuration',
      paragraphs: ['rig-spec-kit-task:001-export:T001', 'Create the export configuration'],
      labels: ['rig-spec-kit'],
      statusCategory: 'new',
      links: [{ relation: 'blocks', otherKey: 'RP-2' }],
    };
    const rp2: FakeIssue = {
      key: 'RP-2',
      summary: 'Generate exports',
      paragraphs: ['rig-spec-kit-task:001-export:T002', 'Generate exports'],
      labels: ['rig-spec-kit'],
      statusCategory: 'new',
      // tasks.md no longer lists this dependency — the link is stale
      links: [{ relation: 'blockedBy', otherKey: 'RP-1' }],
    };
    const jira = createFakeJira({ issues: [rp1, rp2] });
    const { importSpecKit } = await loadImporter();

    await expect(
      withFetch(jira, () => importSpecKit({ projectRoot: dir, target: 'jira' })),
    ).rejects.toThrow(
      /001-export:T001.*001-export:T002|001-export:T002.*001-export:T001|stale|no longer/i,
    );
    expect(jira.calls.filter(isMutatingCall), 'refused before any write').toEqual([]);
  });

  it('re-reads a search hit by key and refuses ownership the fresh read does not show', async () => {
    const tasks = '# Tasks: Export\n\n- [ ] T001 Create the export configuration\n';
    const { dir } = await scratchProject(tasks);
    const staleHit: FakeIssue = {
      key: 'RP-9',
      summary: 'Create the export configuration',
      paragraphs: ['rig-spec-kit-task:001-export:T001', 'Create the export configuration'],
      // the label is absent on the fresh read — a stale search index still listed it
      labels: [],
      statusCategory: 'new',
      links: [],
    };
    const jira = createFakeJira({ issues: [staleHit], forceSearchHits: ['RP-9'] });
    const { importSpecKit } = await loadImporter();

    const report = await withFetch(jira, () => importSpecKit({ projectRoot: dir, target: 'jira' }));

    expect(report).toMatchObject({ counts: { create: 1, update: 0, unchanged: 0 } });
    expect(jira.issues.get('RP-9')).toMatchObject({ labels: [], summary: staleHit.summary });
    const created = [...jira.issues.values()].find((issue) => issue.key !== 'RP-9');
    expect(
      created,
      'the stale hit must not have been trusted as the existing projection',
    ).toBeDefined();
    expect(created?.labels).toContain('rig-spec-kit');
  });

  it('refuses an ambiguous projection, including one produced by a lagging index', async () => {
    const tasks = '# Tasks: Export\n\n- [ ] T001 Create the export configuration\n';
    const { dir } = await scratchProject(tasks);
    const duplicateA: FakeIssue = {
      key: 'RP-7',
      summary: 'Export configuration',
      paragraphs: ['rig-spec-kit-task:001-export:T001', 'Export configuration'],
      labels: ['rig-spec-kit'],
      statusCategory: 'new',
      links: [],
    };
    const duplicateB: FakeIssue = {
      key: 'RP-8',
      summary: 'Second export configuration',
      paragraphs: ['rig-spec-kit-task:001-export:T001', 'Second export configuration'],
      labels: ['rig-spec-kit'],
      statusCategory: 'new',
      links: [],
    };
    // An unrelated projection the search index has not caught up with yet —
    // present only to prove it neither hides the real ambiguity above nor is
    // itself reported as part of it.
    const laggingUnrelated: FakeIssue = {
      key: 'RP-50',
      summary: 'Unrelated task',
      paragraphs: ['rig-spec-kit-task:001-export:T099', 'Unrelated task'],
      labels: ['rig-spec-kit'],
      statusCategory: 'new',
      links: [],
    };
    const jira = createFakeJira({
      issues: [duplicateA, duplicateB, laggingUnrelated],
      unindexed: ['RP-50'],
    });
    const { importSpecKit } = await loadImporter();

    await expect(
      withFetch(jira, () => importSpecKit({ projectRoot: dir, target: 'jira' })),
    ).rejects.toThrow(/ambiguous.*001-export:T001|001-export:T001.*ambiguous/i);
    expect(jira.calls.filter(isMutatingCall)).toEqual([]);
  });

  it('refuses a truncated search before writing', async () => {
    const { dir } = await scratchProject();
    const jira = createFakeJira({ searchTruncated: true });
    const { importSpecKit } = await loadImporter();

    await expect(
      withFetch(jira, () => importSpecKit({ projectRoot: dir, target: 'jira' })),
    ).rejects.toThrow(/truncat|incomplete|tail/i);
    expect(jira.calls.filter(isMutatingCall)).toEqual([]);
  });

  it.each([
    [
      'the BROWSE_PROJECTS permission',
      { permissions: { BROWSE_PROJECTS: false } },
      /BROWSE_PROJECTS/i,
      '/rest/api/3/mypermissions',
    ],
    [
      'the CREATE_ISSUES permission',
      { permissions: { CREATE_ISSUES: false } },
      /CREATE_ISSUES/i,
      '/rest/api/3/mypermissions',
    ],
    [
      'the EDIT_ISSUES permission',
      { permissions: { EDIT_ISSUES: false } },
      /EDIT_ISSUES/i,
      '/rest/api/3/mypermissions',
    ],
    [
      'the LINK_ISSUES permission',
      { permissions: { LINK_ISSUES: false } },
      /LINK_ISSUES/i,
      '/rest/api/3/mypermissions',
    ],
    [
      'the Blocks link type',
      { linkTypes: [{ id: '2000', name: 'Relates', inward: 'relates to', outward: 'relates to' }] },
      /blocks|link type/i,
      '/rest/api/3/issueLinkType',
    ],
    [
      'createmeta issuelinks',
      { createmetaHasIssueLinks: false },
      /issuelinks|createmeta/i,
      '/rest/api/3/issue/createmeta',
    ],
  ] as const)(
    'refuses before writing when %s is missing',
    async (_label, overrides, expected, expectedPathname) => {
      const { dir } = await scratchProject();
      const jira = createFakeJira(overrides as FakeJiraOptions);
      const { importSpecKit } = await loadImporter();

      await expect(
        withFetch(jira, () => importSpecKit({ projectRoot: dir, target: 'jira' })),
      ).rejects.toThrow(expected);
      expect(
        jira.calls.some((call) => call.pathname === expectedPathname),
        'the relevant preflight check never ran',
      ).toBe(true);
      expect(jira.calls.filter(isMutatingCall)).toEqual([]);
    },
  );

  it('a failed write names the completed keys, retries nothing, and echoes no task text', async () => {
    const sensitiveTitle = 'SENSITIVE_JIRA_TASK_TITLE_MUST_NOT_REACH_OUTPUT';
    const tasks = [
      '# Tasks: Export',
      '',
      '- [ ] T001 Create the export configuration',
      `- [ ] T002 ${sensitiveTitle} (depends on T001)`,
      '',
    ].join('\n');
    const { dir } = await scratchProject(tasks);
    const jira = createFakeJira({ failCreateSummaries: [sensitiveTitle] });
    const { importSpecKit } = await loadImporter();

    const thrown = await withFetch(jira, () =>
      importSpecKit({ projectRoot: dir, target: 'jira' }),
    ).then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(thrown, 'the failed create must surface as a thrown error').toBeInstanceOf(Error);
    expect(thrown!.message).not.toContain(sensitiveTitle);
    const t001Key = keyFor(jira, '001-export:T001');
    expect(thrown!.message).toContain(t001Key);
    const createCalls = jira.calls.filter(
      (call) => call.method === 'POST' && call.pathname === '/rest/api/3/issue',
    );
    expect(createCalls, 'T001 succeeds once and T002 fails once — neither is retried').toHaveLength(
      2,
    );
  });

  it.each([
    ['a non-jira adapter', { adapter: 'github-issues', options: { project: 'RP' } }],
    ['a config with no adapter at all', { options: { project: 'RP' } }],
    ['a jira adapter with no project key', { adapter: 'jira', options: {} }],
  ] as const)('refuses %s before contacting Jira', async (_label, queueConfig) => {
    const { dir } = await scratchProject(TASKS, queueConfig as Record<string, unknown>);
    const jira = createFakeJira();
    const { importSpecKit } = await loadImporter();

    await expect(
      withFetch(jira, () => importSpecKit({ projectRoot: dir, target: 'jira' })),
    ).rejects.toThrow(/adapter|project|jira/i);
    expect(jira.calls, 'a config refusal must happen before any Jira request').toEqual([]);
  });
});
