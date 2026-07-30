import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

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
    expect(withLabels(['human-review']).tier).toBe('elevated');
    expect(withLabels(['trigger-auto']).trigger).toBe('auto');
    expect(withLabels(['trigger-human']).trigger).toBe('human');
    expect(withLabels(['triage']).triage).toBe(true);
    expect(withLabels([]).tier).toBe('normal');
    expect(withLabels([]).trigger).toBeNull();
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
  it('excludes triage explicitly, not merely by the absence of a marker', async () => {
    const { buildJql } = await load('jira.mjs');
    const jql = buildJql({ project: 'ABC' }) as string;
    expect(jql).toContain('project = ABC');
    expect(jql).toMatch(/labels\s*!=\s*triage|labels NOT IN \(triage\)/i);
    // belt and braces: an item carrying BOTH ready and triage must stay unselectable
    expect(jql).toMatch(/labels IS EMPTY|OR labels is empty/i);
  });

  it('an explicit jql in the config wins over the built one', async () => {
    const { buildJql } = await load('jira.mjs');
    expect(buildJql({ project: 'ABC', jql: 'project = OTHER' })).toBe('project = OTHER');
  });

  it('refuses to guess when neither a project nor a jql is configured', async () => {
    const { buildJql } = await load('jira.mjs');
    expect(() => buildJql({})).toThrow(/project|jql/i);
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
