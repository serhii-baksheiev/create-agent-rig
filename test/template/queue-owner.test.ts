import { execFile } from 'node:child_process';
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

describe('plan-md reads the same fact out of an inline marker', () => {
  it('maps `[owner:<name>]` onto ticket.owner and strips it from the title', async () => {
    const { parsePlan } = await load('plan-md.mjs');
    const plan = '# P\n\n## Agent queue\n\n- Do the thing [owner:rig-platform]\n- Plain item\n';
    const items = parsePlan(plan);
    expect(items[0]).toMatchObject({ owner: 'rig-platform', title: 'Do the thing' });
    expect(items[1]).toMatchObject({ owner: null, title: 'Plain item' });
  });
});

describe('the CLI hands options.owner to selection and to hygiene', () => {
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

  const rig = async (owner: string | null): Promise<string> => {
    const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(path.join(tmpdir(), 'owner-cli-'));
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await mkdir(path.join(dir, '.rig'), { recursive: true });
    await writeFile(
      path.join(dir, '.rig', 'revalidation.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        detection: {
          mode: 'pull',
          sources: ['run-state', 'journal'],
          acceptedLatency: '24h',
          push: false,
        },
        pairedFacts: [],
      })}\n`,
    );
    await writeFile(
      path.join(dir, '.claude', 'queue.json'),
      JSON.stringify({ adapter: 'plan-md', options: owner === null ? {} : { owner } }),
    );
    await writeFile(
      path.join(dir, 'PLAN.md'),
      '# P\n\n## Agent queue\n\n- Foreign work [owner:rig-platform]\n\n## Operator queue\n',
    );
    return path.join(dir, '.claude', 'queue.json');
  };

  it('`next` holds the foreign item as owner, and `hygiene` names the mismatch', async () => {
    const cfg = await rig('create-agent-rig');
    const next = await run(['next', '--config', cfg, '--json']);
    expect(next.code, next.stderr).toBe(0);
    const parsed = JSON.parse(next.stdout);
    expect(parsed.ticket).toBeNull();
    expect(parsed.stop.kind).toBe('nothing-selectable');
    expect(parsed.skipped[0].causes).toEqual(['owner']);

    const hygiene = await run(['hygiene', '--config', cfg]);
    expect(hygiene.code, hygiene.stderr).toBe(0);
    // The tail discriminates the wiring: with `options.owner` unread, the line
    // would say "declares no owner" instead of naming this checkout.
    expect(hygiene.stdout).toMatch(
      /\[owner-mismatch\] 1 — owned by rig-platform, and this checkout is create-agent-rig/,
    );
  });

  it('`next` takes the item when the checkout is the owner it names', async () => {
    const cfg = await rig('rig-platform');
    const next = await run(['next', '--config', cfg, '--json']);
    expect(next.code, next.stderr).toBe(0);
    expect(JSON.parse(next.stdout).ticket?.title).toBe('Foreign work');
  });

  it('a checkout with no options.owner holds the marked item too, and hygiene says why', async () => {
    const cfg = await rig(null);
    const next = await run(['next', '--config', cfg, '--json']);
    expect(JSON.parse(next.stdout).skipped[0].causes).toEqual(['owner']);
    const hygiene = await run(['hygiene', '--config', cfg]);
    expect(hygiene.stdout).toMatch(
      /\[owner-mismatch\] 1 — owned by rig-platform, and this checkout declares no owner/,
    );
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
    // Per board, because each board spells this checkout's name its own way
    // (`owner-create-agent-rig` on AR, `owner-rig` on RP); the default board
    // is the one asserted, not whatever a local selector has switched to.
    expect(config.boards[config.board].owner).toBe('create-agent-rig');
  });
});
