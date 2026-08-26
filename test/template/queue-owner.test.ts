import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * AR-132 — a queue item names the repository it belongs to, and a checkout
 * that is not that repository holds it rather than taking it.
 *
 * Measured: AR-129 and AR-130 were Rig Platform items sitting in this
 * repository's Jira project. Both were selected as normal spacers and both
 * escalated PREMISE FALSE at the first premise check, consecutively — two
 * escalations in a row, which is a run-level stop, spent on work that was never
 * this checkout's to do.
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
  ...over,
});

describe('the owner marker is one label, read the same way by every tracker', () => {
  it('reads `owner-<name>` out of the labels, and null when there is none', async () => {
    const { ownerOfLabels } = await load('core.mjs');
    expect(ownerOfLabels(['elevated', 'owner-create-agent-rig'])).toBe('create-agent-rig');
    expect(ownerOfLabels(['owner-rig-platform'])).toBe('rig-platform');
    expect(ownerOfLabels(['elevated'])).toBeNull();
    expect(ownerOfLabels([])).toBeNull();
    expect(ownerOfLabels(undefined)).toBeNull();
    // A bare `owner-` names nobody and is read as no marker, not as owner "".
    expect(ownerOfLabels(['owner-'])).toBeNull();
  });

  it('jira maps the label onto ticket.owner', async () => {
    const { toTicket } = await load('jira.mjs');
    const issue = (labels: string[]) => ({
      key: 'AR-1',
      fields: { summary: 's', labels, status: { statusCategory: { key: 'new' } }, issuelinks: [] },
    });
    expect(toTicket(issue(['owner-rig-platform'])).owner).toBe('rig-platform');
    expect(toTicket(issue([])).owner).toBeNull();
  });

  it('github-issues maps the label onto ticket.owner', async () => {
    const { toTicket } = await load('github-issues.mjs');
    const issue = (labels: string[]) => ({
      number: 7,
      title: 's',
      state: 'OPEN',
      labels: labels.map((name) => ({ name })),
      body: '',
      url: 'https://example.invalid/7',
      createdAt: '2026-08-01T00:00:00Z',
    });
    expect(toTicket(issue(['owner-rig-platform'])).owner).toBe('rig-platform');
    expect(toTicket(issue([])).owner).toBeNull();
  });
});

describe('selection holds an item another repository owns', () => {
  it('takes an item with no owner marker — absence means unconditional, not missing data', async () => {
    const { selectionOf } = await load('core.mjs');
    expect(selectionOf(ticket(), { owner: 'create-agent-rig' }).eligible).toBe(true);
    expect(selectionOf(ticket(), { owner: null }).eligible).toBe(true);
  });

  it('takes an item whose owner is this checkout', async () => {
    const { selectionOf } = await load('core.mjs');
    expect(
      selectionOf(ticket({ owner: 'create-agent-rig' }), { owner: 'create-agent-rig' }).eligible,
    ).toBe(true);
  });

  it('holds an item whose owner is another repository, with the cause named', async () => {
    const { selectionOf } = await load('core.mjs');
    const selection = selectionOf(ticket({ owner: 'rig-platform' }), { owner: 'create-agent-rig' });
    expect(selection.eligible).toBe(false);
    expect(selection.causes).toEqual(['owner']);
    expect(selection.reasons.join(' ')).toMatch(/rig-platform/);
    expect(selection.reasons.join(' ')).toMatch(/create-agent-rig/);
  });

  it('holds an owned item when this checkout declares no owner — could not confirm is not a match', async () => {
    const { selectionOf } = await load('core.mjs');
    const selection = selectionOf(ticket({ owner: 'rig-platform' }), { owner: null });
    expect(selection.eligible).toBe(false);
    expect(selection.causes).toEqual(['owner']);
    expect(selection.reasons.join(' ')).toMatch(/declares no owner/);
  });

  it('is a holding cause, so a queue of foreign items ends as "nothing selectable", not "empty"', async () => {
    const { HOLDING_CAUSES, SKIP_CAUSES, selectNext, stopConditionOf } = await load('core.mjs');
    expect(SKIP_CAUSES).toContain('owner');
    expect(HOLDING_CAUSES).toContain('owner');
    const result = selectNext([ticket({ owner: 'rig-platform' })], { owner: 'create-agent-rig' });
    expect(result.ticket).toBeNull();
    const stop = stopConditionOf({ candidates: 0, skipped: result.skipped });
    expect(stop.kind).toBe('nothing-selectable');
    expect(stop.why).toMatch(/owner/);
  });
});

describe('hygiene names the item another repository owns', () => {
  it('reports owner-mismatch for a foreign item and nothing for a matching or unmarked one', async () => {
    const { hygieneOf } = await load('core.mjs');
    const finding = hygieneOf(ticket({ owner: 'rig-platform' }), { owner: 'create-agent-rig' });
    expect(finding).toMatchObject({ kind: 'owner-mismatch', id: 'T-1' });
    expect(finding.why).toMatch(/rig-platform/);
    expect(
      hygieneOf(ticket({ owner: 'create-agent-rig' }), { owner: 'create-agent-rig' }),
    ).toBeNull();
    expect(hygieneOf(ticket(), { owner: 'create-agent-rig' })).toBeNull();
  });

  it('reports an owned item as unconfirmable when this checkout declares no owner', async () => {
    const { hygieneOf } = await load('core.mjs');
    expect(hygieneOf(ticket({ owner: 'rig-platform' }), { owner: null })).toMatchObject({
      kind: 'owner-mismatch',
    });
  });
});

describe('this repository declares itself as the owner its queue items name', () => {
  it('composes options.owner into .claude/queue.json', async () => {
    const { readFile } = await import('node:fs/promises');
    const config = JSON.parse(await readFile(path.join(repoRoot, '.claude', 'queue.json'), 'utf8'));
    expect(config.options.owner).toBe('create-agent-rig');
  });
});
