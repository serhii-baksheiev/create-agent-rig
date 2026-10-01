import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RP-273 — a queue pilot selected Jira item RP-96, whose labels carried
 * `frozen` and `later` (both unknown to the lifecycle vocabulary, so neither
 * held it) while the intended workload carried `rel-1.1.0`. Two gaps this
 * file pins:
 *
 *  A. `frozen` and `later` join the deferral vocabulary — `lifecycleOf`
 *     reads either as `parked: true`, exactly like `parked` itself.
 *  B. An adapter-neutral `scope: { labels: string[] }` option, read by
 *     `selectNext`/`selectionOf`: an item not carrying every listed label is
 *     rejected with the new, non-holding cause `out-of-scope`.
 *  C. The CLI wires `config.options.scope` (after the board overlay) into
 *     `next` and `list`.
 *  D. The loop skill's §2 names `frozen`, `later` and `scope`.
 */

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

const ticket = (over: Record<string, unknown> = {}) => ({
  id: 'T-1',
  title: 't',
  state: 'open',
  labels: [],
  tier: 'normal',
  blockedBy: [],
  blocks: [],
  priority: 3,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: null,
  body: null,
  triage: false,
  trigger: null,
  owner: null,
  lifecycle: null,
  parked: false,
  ...over,
});

// The exact label set RP-96 carried during the 1.1.0 pilot.
const RP96_LABELS = [
  'agent-queue',
  'elevated',
  'frozen',
  'governance',
  'later',
  'm2',
  'owner-rig',
  'repo-rig',
  'revalidation',
  'supporting-lane',
];

describe('frozen and later join the deferral vocabulary', () => {
  it('DEFERRAL_LABELS names exactly parked, frozen and later, and cannot be extended at runtime', async () => {
    const { DEFERRAL_LABELS } = await load('core.mjs');
    expect(DEFERRAL_LABELS).toEqual(['parked', 'frozen', 'later']);
    expect(Object.isFrozen(DEFERRAL_LABELS)).toBe(true);
  });

  it('reads frozen and later as parked, without setting a lifecycle', async () => {
    const { lifecycleOf } = await load('core.mjs');
    expect(lifecycleOf(['frozen'])).toEqual({ lifecycle: null, parked: true });
    expect(lifecycleOf(['later'])).toEqual({ lifecycle: null, parked: true });
    expect(lifecycleOf(['keep-core', 'frozen'])).toEqual({ lifecycle: 'keep-core', parked: true });
  });

  it('jira maps frozen and later onto ticket.parked', async () => {
    const { toTicket } = await load('jira.mjs');
    const issue = (labels: string[]) => ({
      key: 'AR-1',
      fields: { summary: 's', labels, status: { statusCategory: { key: 'new' } }, issuelinks: [] },
    });
    expect(toTicket(issue(['frozen']))).toMatchObject({ lifecycle: null, parked: true });
    expect(toTicket(issue(['later']))).toMatchObject({ lifecycle: null, parked: true });
  });

  it('github-issues maps frozen and later onto ticket.parked', async () => {
    const { toTicket } = await load('github-issues.mjs');
    const issue = (labels: string[]) => ({
      number: 1,
      title: 't',
      state: 'OPEN',
      labels: labels.map((name) => ({ name })),
      body: '',
      url: 'https://example.invalid/1',
      createdAt: '2026-08-01T00:00:00Z',
    });
    expect(toTicket(issue(['frozen']))).toMatchObject({ lifecycle: null, parked: true });
    expect(toTicket(issue(['later']))).toMatchObject({ lifecycle: null, parked: true });
  });

  it.each(['frozen', 'later'])(
    'plan-md reads [%s] as deferred and removes the marker from the title',
    async (marker) => {
      const { parsePlan } = await load('plan-md.mjs');
      const [item] = parsePlan(
        `## Agent queue\n\n- deferred work [${marker}]\n\n## Operator queue`,
      );
      expect(item).toMatchObject({ title: 'deferred work', lifecycle: null, parked: true });
    },
  );
});

describe('scoped selection', () => {
  it('accepts an in-scope, otherwise-eligible ticket', async () => {
    const { selectionOf } = await load('core.mjs');
    const selection = selectionOf(ticket({ labels: ['rel-1.1.0'] }), {
      scope: { labels: ['rel-1.1.0'] },
    });
    expect(selection.eligible).toBe(true);
    expect(selection.causes).toEqual([]);
  });

  it('rejects a more attractive off-scope candidate and selects the in-scope one instead', async () => {
    const { selectNext } = await load('core.mjs');
    const attractive = ticket({
      id: 'T-attractive',
      labels: [],
      priority: 1,
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    const inScope = ticket({
      id: 'T-inscope',
      labels: ['rel-1.1.0'],
      priority: 5,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const result = selectNext([attractive, inScope], { scope: { labels: ['rel-1.1.0'] } });
    expect(result.ticket?.id).toBe('T-inscope');
    const skip = result.skipped.find((s: { id: string }) => s.id === 'T-attractive');
    expect(skip?.causes).toEqual(['out-of-scope']);
    expect(skip?.reason).toMatch(/rel-1\.1\.0/);
  });

  it.each(['frozen', 'later'])(
    'holds an in-scope %s item as deferred and names its deferral',
    async (label) => {
      const { selectionOf, lifecycleOf } = await load('core.mjs');
      const deferred = selectionOf(
        ticket({ labels: ['rel-1.1.0', label], ...lifecycleOf(['rel-1.1.0', label]) }),
        { scope: { labels: ['rel-1.1.0'] } },
      );
      expect(deferred.eligible).toBe(false);
      expect(deferred.causes).toEqual(['deferred']);
      expect(deferred.reasons.join(' ')).toMatch(
        new RegExp(`${label}.*deferred|deferred.*${label}`, 'i'),
      );
    },
  );

  it('rejects the exact RP-96 label set as both out-of-scope and deferred when scoped to rel-1.1.0', async () => {
    const { selectionOf, lifecycleOf } = await load('core.mjs');
    const rp96 = ticket({ labels: RP96_LABELS, ...lifecycleOf(RP96_LABELS) });
    const scoped = selectionOf(rp96, { scope: { labels: ['rel-1.1.0'] } });
    expect(scoped.eligible).toBe(false);
    expect(scoped.causes).toContain('out-of-scope');
    expect(scoped.causes).toContain('deferred');
    expect(scoped.causes).toHaveLength(2);
  });

  it('rejects the exact RP-96 label set as deferred alone when unscoped', async () => {
    const { selectionOf, lifecycleOf } = await load('core.mjs');
    const rp96 = ticket({ labels: RP96_LABELS, ...lifecycleOf(RP96_LABELS) });
    const unscoped = selectionOf(rp96, {});
    expect(unscoped.eligible).toBe(false);
    expect(unscoped.causes).toEqual(['deferred']);
  });

  it.each([
    ['escalated', { labels: ['rel-1.1.0', 'escalated'] }, 'escalated'],
    ['obsolete', { labels: ['rel-1.1.0'], lifecycle: 'obsolete' }, 'obsolete'],
    ['re-scope', { labels: ['rel-1.1.0'], lifecycle: 're-scope' }, 're-scope'],
    ['parked', { labels: ['rel-1.1.0'], parked: true }, 'deferred'],
    [
      'in-progress, claimed by another session',
      { labels: ['rel-1.1.0'], state: 'in-progress' },
      'in-progress',
    ],
    ['triage', { labels: ['rel-1.1.0'], triage: true }, 'triage'],
    [
      'blocked by an open link',
      { labels: ['rel-1.1.0'], blockedBy: [{ id: 'X', resolved: false }] },
      'blocked',
    ],
  ] as const)(
    '%s stays rejected on its own cause even while in scope',
    async (_name, overrides, cause) => {
      const { selectionOf } = await load('core.mjs');
      const selection = selectionOf(ticket(overrides as Record<string, unknown>), {
        scope: { labels: ['rel-1.1.0'] },
      });
      expect(selection.eligible).toBe(false);
      expect(selection.causes).toContain(cause);
      expect(selection.causes).not.toContain('out-of-scope');
    },
  );

  it('keeps normal priority/createdAt order among in-scope candidates', async () => {
    const { selectNext } = await load('core.mjs');
    const a = ticket({
      id: 'A',
      labels: ['rel-1.1.0'],
      priority: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const b = ticket({
      id: 'B',
      labels: ['rel-1.1.0'],
      priority: 1,
      createdAt: '2026-02-01T00:00:00.000Z',
    });
    const scoped = selectNext([a, b], { scope: { labels: ['rel-1.1.0'] } });
    const unscoped = selectNext([a, b], {});
    expect(scoped.ticket?.id).toBe(unscoped.ticket?.id);
    expect(scoped.ticket?.id).toBe('B');
  });

  it('is unscoped when scope is undefined or null, exactly as when the key is absent', async () => {
    const { selectNext } = await load('core.mjs');
    const tickets = [
      ticket({ id: 'A', labels: [] }),
      ticket({ id: 'B', labels: ['unrelated-label'] }),
    ];
    const noKey = selectNext(tickets, {});
    const undef = selectNext(tickets, { scope: undefined });
    const nul = selectNext(tickets, { scope: null });
    expect(undef).toEqual(noKey);
    expect(nul).toEqual(noKey);
    expect(noKey.ticket?.id).toBe('A');
  });

  it('ends a queue where only off-scope items are eligible as queue-empty, never nothing-selectable', async () => {
    const { selectNext, stopConditionOf, SKIP_CAUSES, HOLDING_CAUSES } = await load('core.mjs');
    const result = selectNext([ticket({ id: 'A', labels: [] })], {
      scope: { labels: ['rel-1.1.0'] },
    });
    expect(result.ticket).toBeNull();
    expect(result.candidates).toBe(0);
    const stop = stopConditionOf({ candidates: 0, skipped: result.skipped });
    expect(stop.kind).toBe('queue-empty');
    expect(stop.why).toMatch(/scope.*change|change.*scope/i);
    expect(stop.why).not.toMatch(/human.*unblock|unblock.*human/i);
    expect(SKIP_CAUSES).toContain('out-of-scope');
    expect(HOLDING_CAUSES).not.toContain('out-of-scope');
  });

  it('requires every listed label, not any one of them', async () => {
    const { selectionOf } = await load('core.mjs');
    const scope = { labels: ['rel-1.1.0', 'must-ship'] };
    const partial = selectionOf(ticket({ labels: ['rel-1.1.0'] }), { scope });
    expect(partial.eligible).toBe(false);
    expect(partial.causes).toContain('out-of-scope');
    const full = selectionOf(ticket({ labels: ['rel-1.1.0', 'must-ship'] }), { scope });
    expect(full.eligible).toBe(true);
  });

  it.each([
    ['an empty object', {}],
    ['empty labels', { labels: [] }],
    ['labels not an array', { labels: 'rel' }],
    ['an empty-string entry', { labels: [''] }],
    ['a control-character entry', { labels: ['rel-1.2.0\n'] }],
    ['a non-string entry', { labels: [3] }],
    ['a bare string instead of an object', 'rel-1.1.0'],
  ] as const)(
    'a malformed scope (%s) makes selectNext throw, naming scope',
    async (_name, scope) => {
      const { selectNext } = await load('core.mjs');
      expect(() => selectNext([ticket()], { scope })).toThrow(/scope/);
    },
  );
});

describe('the CLI wires config.options.scope into `next`', () => {
  const run = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      execFile(process.execPath, [path.join(queueDir, 'index.mjs'), ...args], {}, (e, out, err) =>
        resolve({
          code: e && typeof e.code === 'number' ? e.code : 0,
          stdout: String(out),
          stderr: String(err),
        }),
      );
    });

  const rig = async (config: Record<string, unknown>): Promise<string> => {
    const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(path.join(tmpdir(), 'scope-cli-'));
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(path.join(dir, '.claude', 'queue.json'), JSON.stringify(config));
    await writeFile(
      path.join(dir, 'PLAN.md'),
      '# P\n\n## Agent queue\n\n- Do the thing\n\n## Operator queue\n',
    );
    return path.join(dir, '.claude', 'queue.json');
  };

  it('a configured scope refuses plan-md instead of treating its label-less items as out-of-scope', async () => {
    const cfg = await rig({ adapter: 'plan-md', options: { scope: { labels: ['rel-x'] } } });
    const next = await run(['next', '--config', cfg, '--json']);
    expect(next.code).not.toBe(0);
    expect(next.stdout).not.toMatch(/"id"/);
    expect(next.stderr).toMatch(/plan-md/i);
    expect(next.stderr).toMatch(/scope/i);
  });

  it('a `boards.<name>.scope` entry refuses plan-md too', async () => {
    const cfg = await rig({
      adapter: 'plan-md',
      board: 'X',
      boards: { X: { scope: { labels: ['rel-x'] } } },
    });
    const next = await run(['next', '--config', cfg, '--json']);
    expect(next.code).not.toBe(0);
    expect(next.stdout).not.toMatch(/"id"/);
    expect(next.stderr).toMatch(/plan-md/i);
    expect(next.stderr).toMatch(/scope/i);
  });

  it('a malformed `options.scope` exits non-zero, selects nothing, and names scope on stderr', async () => {
    const cfg = await rig({ adapter: 'plan-md', options: { scope: {} } });
    const next = await run(['next', '--config', cfg, '--json']);
    expect(next.code).not.toBe(0);
    expect(next.stdout).not.toMatch(/"id"/);
    expect(next.stderr).toMatch(/scope/);
    expect(next.stderr).not.toMatch(/(?:^|\n)\s*at\s+/);
  });
});

describe('the loop skill documents frozen, later and the scope option', () => {
  it('§2 names frozen, later and scope where selection is described', async () => {
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
    const section = skill.split(/^## 2\. /m)[1]?.split(/^## 3\. /m)[0] ?? '';
    for (const word of ['frozen', 'later', 'scope']) {
      expect(section, word).toContain(word);
    }
  });
});
