import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * AR-144 — the queue core gains a lifecycle vocabulary.
 *
 * Four labels, read the same way by every tracker: `keep-core` (in play, no
 * condition), `re-scope` (a human rewrites the item and removes the label),
 * `obsolete` (a human closes it with a comment naming the evidence) and
 * `parked` (orthogonal: on hold until a human un-parks it). The loop never
 * applies `obsolete` itself — that verdict belongs to a human.
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

describe('the lifecycle vocabulary is one frozen list, read the same way by every tracker', () => {
  it('names exactly keep-core, re-scope and obsolete, and cannot be extended at runtime', async () => {
    const { LIFECYCLE_LABELS } = await load('core.mjs');
    expect(LIFECYCLE_LABELS).toEqual(['keep-core', 're-scope', 'obsolete']);
    expect(Object.isFrozen(LIFECYCLE_LABELS)).toBe(true);
  });

  it('reads the lifecycle out of the labels, and null when none is present', async () => {
    const { lifecycleOf } = await load('core.mjs');
    expect(lifecycleOf(['elevated', 'keep-core'])).toEqual({
      lifecycle: 'keep-core',
      parked: false,
    });
    expect(lifecycleOf(['re-scope'])).toEqual({ lifecycle: 're-scope', parked: false });
    expect(lifecycleOf(['obsolete'])).toEqual({ lifecycle: 'obsolete', parked: false });
    expect(lifecycleOf(['elevated'])).toEqual({ lifecycle: null, parked: false });
    expect(lifecycleOf([])).toEqual({ lifecycle: null, parked: false });
    expect(lifecycleOf(undefined)).toEqual({ lifecycle: null, parked: false });
  });

  it('lets the most restrictive label win when several are present', async () => {
    const { lifecycleOf } = await load('core.mjs');
    expect(lifecycleOf(['keep-core', 'obsolete']).lifecycle).toBe('obsolete');
    expect(lifecycleOf(['re-scope', 'obsolete']).lifecycle).toBe('obsolete');
    expect(lifecycleOf(['keep-core', 're-scope']).lifecycle).toBe('re-scope');
  });

  it('reads parked as orthogonal to the lifecycle', async () => {
    const { lifecycleOf } = await load('core.mjs');
    expect(lifecycleOf(['parked'])).toEqual({ lifecycle: null, parked: true });
    expect(lifecycleOf(['keep-core', 'parked'])).toEqual({ lifecycle: 'keep-core', parked: true });
  });

  it('jira maps the labels onto ticket.lifecycle and ticket.parked', async () => {
    const { toTicket } = await load('jira.mjs');
    const issue = (labels: string[]) => ({
      key: 'AR-1',
      fields: { summary: 's', labels, status: { statusCategory: { key: 'new' } }, issuelinks: [] },
    });
    expect(toTicket(issue(['re-scope', 'parked']))).toMatchObject({
      lifecycle: 're-scope',
      parked: true,
    });
    expect(toTicket(issue([]))).toMatchObject({ lifecycle: null, parked: false });
  });

  it('github-issues maps the labels onto ticket.lifecycle and ticket.parked', async () => {
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
    expect(toTicket(issue(['re-scope', 'parked']))).toMatchObject({
      lifecycle: 're-scope',
      parked: true,
    });
    expect(toTicket(issue([]))).toMatchObject({ lifecycle: null, parked: false });
  });

  it('plan-md reads inline markers case-insensitively and strips them from the title', async () => {
    const { parsePlan } = await load('plan-md.mjs');
    const plan =
      '# P\n\n## Agent queue\n\n' +
      '- Rewrite me [re-scope]\n' +
      '- Later [Keep-Core] [parked]\n' +
      '- Gone [OBSOLETE]\n' +
      '- Plain item\n';
    const items = parsePlan(plan);
    expect(items[0]).toMatchObject({ lifecycle: 're-scope', parked: false, title: 'Rewrite me' });
    expect(items[1]).toMatchObject({ lifecycle: 'keep-core', parked: true, title: 'Later' });
    expect(items[2]).toMatchObject({ lifecycle: 'obsolete', parked: false, title: 'Gone' });
    expect(items[3]).toMatchObject({ lifecycle: null, parked: false, title: 'Plain item' });
  });
});

describe('selection holds a re-scope or parked item, and keeps an obsolete one out of play', () => {
  it('holds a re-scope item and says a human rewrites it', async () => {
    const { selectionOf } = await load('core.mjs');
    const selection = selectionOf(ticket({ lifecycle: 're-scope' }), {});
    expect(selection.eligible).toBe(false);
    expect(selection.causes).toEqual(['re-scope']);
    expect(selection.reasons.join(' ')).toMatch(/re-scope/);
    expect(selection.reasons.join(' ')).toMatch(/human/);
  });

  it('holds a parked item, and parked is the only cause even under keep-core', async () => {
    const { selectionOf } = await load('core.mjs');
    const parked = selectionOf(ticket({ parked: true }), {});
    expect(parked.eligible).toBe(false);
    expect(parked.causes).toEqual(['parked']);
    expect(parked.reasons.join(' ')).toMatch(/parked/);
    expect(selectionOf(ticket({ lifecycle: 'keep-core', parked: true }), {}).causes).toEqual([
      'parked',
    ]);
  });

  it('takes a keep-core item — the label is a statement, not a condition', async () => {
    const { selectionOf } = await load('core.mjs');
    const selection = selectionOf(ticket({ lifecycle: 'keep-core' }), {});
    expect(selection.eligible).toBe(true);
    expect(selection.causes).toEqual([]);
  });

  it('refuses an obsolete item and says a human closes it with a comment naming the evidence', async () => {
    const { selectionOf } = await load('core.mjs');
    const selection = selectionOf(ticket({ lifecycle: 'obsolete' }), {});
    expect(selection.eligible).toBe(false);
    expect(selection.causes).toEqual(['obsolete']);
    expect(selection.reasons.join(' ')).toMatch(/human/);
    expect(selection.reasons.join(' ')).toMatch(/clos/);
    expect(selection.reasons.join(' ')).toMatch(/comment/);
    expect(selection.reasons.join(' ')).toMatch(/evidence/);
  });

  it('holds re-scope and parked, but obsolete is out of play, and every holding cause is a skip cause', async () => {
    const { HOLDING_CAUSES, SKIP_CAUSES } = await load('core.mjs');
    for (const cause of ['re-scope', 'parked', 'obsolete']) expect(SKIP_CAUSES).toContain(cause);
    expect(HOLDING_CAUSES).toContain('re-scope');
    expect(HOLDING_CAUSES).toContain('parked');
    expect(HOLDING_CAUSES).not.toContain('obsolete');
    for (const cause of HOLDING_CAUSES as string[]) expect(SKIP_CAUSES).toContain(cause);
  });

  it('ends a re-scope pile as "nothing selectable" naming the rewrite, and a parked pile naming the un-park', async () => {
    const { selectNext, stopConditionOf } = await load('core.mjs');
    const reScope = selectNext([ticket({ lifecycle: 're-scope' })], {});
    expect(reScope.ticket).toBeNull();
    const reScopeStop = stopConditionOf({ candidates: 0, skipped: reScope.skipped });
    expect(reScopeStop.kind).toBe('nothing-selectable');
    expect(reScopeStop.why).toMatch(/human/);
    expect(reScopeStop.why).toMatch(/rewrit/);
    expect(reScopeStop.why).toMatch(/remove/);

    const parked = selectNext([ticket({ parked: true })], {});
    const parkedStop = stopConditionOf({ candidates: 0, skipped: parked.skipped });
    expect(parkedStop.kind).toBe('nothing-selectable');
    expect(parkedStop.why).toMatch(/un-?park/i);
  });

  it('ends an obsolete-only pile as "queue empty" — an obsolete item is parked, not held', async () => {
    const { selectNext, stopConditionOf } = await load('core.mjs');
    const result = selectNext([ticket({ lifecycle: 'obsolete' })], {});
    expect(result.ticket).toBeNull();
    const stop = stopConditionOf({ candidates: 0, skipped: result.skipped });
    expect(stop.kind).toBe('queue-empty');
    expect(stop.why).toMatch(/obsolete/);
  });
});

describe('hygiene names what the lifecycle labels leave in a bad state', () => {
  it('reports a legacy-backlog label still on an open item', async () => {
    const { hygieneOf } = await load('core.mjs');
    expect(hygieneOf(ticket({ labels: ['legacy-backlog'] }), {})).toMatchObject({
      kind: 'stale-legacy-backlog-label',
      id: 'T-1',
    });
    expect(hygieneOf(ticket({ labels: ['legacy-backlog'], state: 'closed' }), {})).toBeNull();
  });

  it('reports contradictory lifecycle labels and names them', async () => {
    const { hygieneOf, lifecycleOf } = await load('core.mjs');
    for (const labels of [
      ['obsolete', 'keep-core'],
      ['obsolete', 're-scope'],
      ['keep-core', 're-scope'],
    ]) {
      const finding = hygieneOf(ticket({ labels, ...lifecycleOf(labels) }), {});
      expect(finding, labels.join('+')).toMatchObject({ kind: 'contradictory-lifecycle-labels' });
      for (const label of labels) expect(finding.why, labels.join('+')).toContain(label);
    }
  });

  it('reports an open re-scope item as pending a human rewrite, after owner, legacy and contradiction', async () => {
    const { hygieneOf } = await load('core.mjs');
    const pending = hygieneOf(ticket({ labels: ['re-scope'], lifecycle: 're-scope' }), {});
    expect(pending).toMatchObject({ kind: 're-scope-pending' });
    expect(pending.why).toMatch(/human/);
    expect(pending.why).toMatch(/rewrit/);

    // Order: an earlier finding wins over a later one on the same item.
    const owned = ticket({
      labels: ['re-scope', 'legacy-backlog'],
      lifecycle: 're-scope',
      owner: 'rig-platform',
    });
    expect(hygieneOf(owned, { owner: 'create-agent-rig' })).toMatchObject({
      kind: 'owner-mismatch',
    });
    expect(
      hygieneOf(ticket({ labels: ['re-scope', 'legacy-backlog'], lifecycle: 're-scope' }), {}),
    ).toMatchObject({
      kind: 'stale-legacy-backlog-label',
    });
    expect(
      hygieneOf(ticket({ labels: ['keep-core', 're-scope'], lifecycle: 're-scope' }), {}),
    ).toMatchObject({ kind: 'contradictory-lifecycle-labels' });
  });

  it('has nothing to say about a keep-core item that is merely parked', async () => {
    const { hygieneOf } = await load('core.mjs');
    expect(
      hygieneOf(
        ticket({ labels: ['keep-core', 'parked'], lifecycle: 'keep-core', parked: true }),
        {},
      ),
    ).toBeNull();
  });
});

describe('the loop never applies obsolete — that verdict belongs to a human', () => {
  it('no adapter writes the obsolete label, and the contract has no lifecycle operation', async () => {
    const { ADAPTER_CONTRACT } = await load('core.mjs');
    for (const operation of ADAPTER_CONTRACT as string[]) {
      expect(operation).not.toMatch(/obsolete|lifecycle/i);
    }
    for (const file of ['jira.mjs', 'github-issues.mjs', 'plan-md.mjs']) {
      const source = await readFile(path.join(queueDir, file), 'utf8');
      expect(source, file).not.toMatch(/add:\s*['"]obsolete['"]/);
      expect(source, file).not.toMatch(/labels:\s*\[[^\]]*['"]obsolete['"]/);
    }
  });
});

describe('the CLI reads the markers out of a plan-md rig', () => {
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

  const rig = async (): Promise<string> => {
    const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(path.join(tmpdir(), 'lifecycle-cli-'));
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(
      path.join(dir, '.claude', 'queue.json'),
      JSON.stringify({ adapter: 'plan-md', options: {} }),
    );
    await writeFile(
      path.join(dir, 'PLAN.md'),
      '# P\n\n## Agent queue\n\n- Rewrite me [re-scope]\n- Later [keep-core] [parked]\n\n## Operator queue\n',
    );
    return path.join(dir, '.claude', 'queue.json');
  };

  it('`next` holds both items with their causes, and `hygiene` names the pending rewrite', async () => {
    const cfg = await rig();
    const next = await run(['next', '--config', cfg, '--json']);
    expect(next.code, next.stderr).toBe(0);
    const parsed = JSON.parse(next.stdout);
    expect(parsed.ticket).toBeNull();
    expect(parsed.stop.kind).toBe('nothing-selectable');
    expect(parsed.skipped.map((s: { causes: string[] }) => s.causes)).toEqual([
      ['re-scope'],
      ['parked'],
    ]);

    const hygiene = await run(['hygiene', '--config', cfg]);
    expect(hygiene.code, hygiene.stderr).toBe(0);
    expect(hygiene.stdout).toMatch(/\[re-scope-pending\] 1 —/);
  });
});

describe('the loop skill documents the vocabulary where selection is described', () => {
  it('§2 names every label and says closure as obsolete needs a comment naming the evidence', async () => {
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
    for (const label of ['keep-core', 're-scope', 'obsolete', 'parked', 'legacy-backlog']) {
      expect(section, label).toContain(label);
    }
    expect(section).toMatch(/obsolete[^.]*comment naming/i);
  });
});
