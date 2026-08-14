import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Extraction brief §4: `loop-driver` is the most valuable artifact in the source
// tree and the only one that cannot be copied — its selection logic assumes one
// tracker. The rig needs a SEAM. Everything above the seam (filters, blocker
// resolution, tier filter, sort, stop conditions) is domain-free and ports as
// written; below it, an adapter per tracker.
//
// 🔴 Two invariants must survive the port or the layer is unsafe:
//   1. blockers resolve from LINKS, never from labels;
//   2. the agent never creates its own queue items.
// Both get their own describe block below.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const queueDir = path.join(universal, '.claude', 'scripts', 'queue');
const load = (file: string) => import(pathToFileURL(path.join(queueDir, file)).href);
const read = (...parts: string[]) => readFile(path.join(...parts), 'utf8');

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
  /** The item's text. `null` where the adapter has none — never `''`. */
  body?: string | null;
}

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: '1',
  title: 'add a route',
  state: 'open',
  labels: [],
  tier: 'normal',
  blockedBy: [],
  blocks: [],
  priority: 999,
  createdAt: '2026-07-01T00:00:00Z',
  triage: false,
  trigger: null,
  ...over,
});

describe('the seam is declared, so a second tracker is an adapter and not a rewrite', () => {
  it('every adapter implements the same named operations', async () => {
    const { ADAPTER_CONTRACT } = await load('core.mjs');
    expect(ADAPTER_CONTRACT).toEqual(
      expect.arrayContaining([
        'listEligible',
        'resolveBlockers',
        'claim',
        'close',
        'comment',
        'escalate',
        'proposeTriage',
      ]),
    );
  });

  it.each(['plan-md.mjs', 'github-issues.mjs'])('%s satisfies the contract', async (file) => {
    const { ADAPTER_CONTRACT } = await load('core.mjs');
    const adapter = await load(file);
    for (const operation of ADAPTER_CONTRACT as string[]) {
      expect(typeof adapter[operation], `${file}.${operation}`).toBe('function');
    }
    expect(typeof adapter.name).toBe('string');
  });

  it('the registry resolves adapters by name and refuses an unknown one', async () => {
    const { resolveAdapter } = await load('index.mjs');
    expect((await resolveAdapter('plan-md')).name).toBe('plan-md');
    expect((await resolveAdapter('github-issues')).name).toBe('github-issues');
    await expect(resolveAdapter('does-not-exist')).rejects.toThrow(/unknown queue adapter/i);
  });
});

describe('🔴 invariant 1 — blockers resolve from links, never from labels', () => {
  it('takes a ticket whose blockers are all resolved even when it still reads "blocked"', async () => {
    const { selectionOf } = await load('core.mjs');
    // Nothing updates a dependent's label when its blocker lands, and in
    // continuous mode the loop is what closed the blocker — a label-driven loop
    // stalls on work it just unblocked itself.
    const stale = ticket({ labels: ['blocked'], blockedBy: [{ id: '2', resolved: true }] });
    expect(selectionOf(stale).eligible).toBe(true);
  });

  it('refuses a ticket with an open blocker even when it reads "ready"', async () => {
    const { selectionOf } = await load('core.mjs');
    const lying = ticket({ labels: ['ready'], blockedBy: [{ id: '2', resolved: false }] });
    const selection = selectionOf(lying);
    expect(selection.eligible).toBe(false);
    expect(selection.reasons.join(' ')).toMatch(/blocke/i);
  });

  it('reports a stale label as queue hygiene rather than silently fixing it', async () => {
    const { hygieneOf } = await load('core.mjs');
    const stale = ticket({ labels: ['blocked'], blockedBy: [{ id: '2', resolved: true }] });
    expect(hygieneOf(stale)).toMatchObject({ kind: 'stale-blocked-label' });

    const lying = ticket({ labels: ['ready'], blockedBy: [{ id: '2', resolved: false }] });
    expect(hygieneOf(lying)).toMatchObject({ kind: 'stale-ready-label' });

    // a "blocked" label with no links at all is a data bug, not a dependency
    const orphan = ticket({ labels: ['blocked'], blockedBy: [] });
    expect(hygieneOf(orphan)).toMatchObject({ kind: 'stale-blocked-label' });

    expect(hygieneOf(ticket())).toBeNull();
  });

  // The three checks the port brief asked for. Each one is a finding a human
  // fixes, never something the loop corrects silently — quietly repairing the
  // metadata destroys the evidence that the metadata is unreliable.
  it('reports a parent that says it was split up and is still open', async () => {
    const { hygieneOf } = await load('core.mjs');
    const resolved = [
      { id: '2', resolved: true },
      { id: '3', resolved: true },
    ];
    expect(hygieneOf(ticket({ body: 'Split into #2 and #3.', blockedBy: resolved }))).toMatchObject(
      { kind: 'split-parent-left-open' },
    );

    // 🔴 The healthy case, and the reason this check reads the body at all:
    // "every dependency resolved and still open" is EVERY multi-dependency item
    // from the moment its last blocker lands — including one the queue is about
    // to hand out. A check that fires on those gets muted.
    expect(hygieneOf(ticket({ blockedBy: resolved }))).toBeNull();
    expect(hygieneOf(ticket({ body: 'Ordinary work.', blockedBy: resolved }))).toBeNull();
    // and a split parent with a part still open is legitimately waiting
    expect(
      hygieneOf(
        ticket({
          body: 'Split into #2 and #3.',
          blockedBy: [
            { id: '2', resolved: true },
            { id: '3', resolved: false },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('reports a dependency line whose blocker no link carries', async () => {
    const { hygieneOf } = await load('core.mjs');
    expect(hygieneOf(ticket({ body: 'Blocked by #7', blockedBy: [] }))).toMatchObject({
      kind: 'body-claims-unlinked-blocker',
    });
    // the same line WITH the link is simply a documented dependency
    expect(
      hygieneOf(ticket({ body: 'Blocked by #7', blockedBy: [{ id: '7', resolved: false }] })),
    ).toBeNull();

    // 🔴 Prose that mentions blocking without asserting one. The unanchored
    // version fired on both of these and then printed a `why` claiming a live
    // blocker the body had just denied — a finding that says the opposite of
    // the text is worse than no finding.
    expect(hygieneOf(ticket({ body: 'This was blocked by #7 last week; #7 landed.' }))).toBeNull();
    expect(hygieneOf(ticket({ body: 'Note: nothing is blocked by this item.' }))).toBeNull();
  });

  it('reports a document link that is broken on its face', async () => {
    const { hygieneOf } = await load('core.mjs');
    expect(hygieneOf(ticket({ body: 'See the [design doc]() before starting.' }))).toMatchObject({
      kind: 'broken-document-link',
    });
    expect(hygieneOf(ticket({ body: 'See [the spec](TODO).' }))).toMatchObject({
      kind: 'broken-document-link',
    });
    // a real link is not a finding, and neither is prose with no link at all
    expect(hygieneOf(ticket({ body: 'See [the spec](docs/spec.md).' }))).toBeNull();
    expect(hygieneOf(ticket({ body: 'Discussed in the design review.' }))).toBeNull();
  });

  // 🔴 The test the sibling adapter's 13-second incident never got, which is
  // why this file reintroduced the same defect one directory away. The body is
  // attacker-written on any public tracker, and this function runs per item on
  // every selection.
  it('stays linear on a body at the tracker size limit', async () => {
    const { hygieneOf } = await load('core.mjs');
    const cases = [
      `[x](${' '.repeat(65_000)}`, // an unterminated link: the quadratic shape
      `blocked by${' '.repeat(65_000)}`,
      `${'['.repeat(20_000)}x`,
    ];
    for (const body of cases) {
      const started = performance.now();
      hygieneOf(ticket({ body }));
      expect(performance.now() - started, body.slice(0, 12)).toBeLessThan(250);
    }
  });

  it('says nothing about a body no adapter can supply', async () => {
    const { hygieneOf } = await load('core.mjs');
    // plan-md has no per-item body: `null` must read as "cannot answer", never
    // as "checked, found nothing"
    expect(hygieneOf(ticket({ body: null }))).toBeNull();
    expect(hygieneOf(ticket())).toBeNull();
  });

  it('re-resolves per selection rather than trusting a cached list', async () => {
    const skill = await read(universal, '.claude', 'skills', 'loop', 'SKILL.md');
    expect(skill).toMatch(/never a cached|fresh|re-resolve/i);
  });
});

describe('🔴 invariant 2 — the agent never creates its own queue items', () => {
  it('excludes triage items from selection, twice over', async () => {
    const { selectionOf } = await load('core.mjs');
    // Belt and braces on purpose: excluding a proposal only by the ABSENCE of a
    // ready marker means one careless hand adding it closes the loop's feedback
    // path into its own input.
    expect(selectionOf(ticket({ triage: true })).eligible).toBe(false);
    expect(selectionOf(ticket({ triage: true, labels: ['ready'] })).eligible).toBe(false);
  });

  it('a proposal is forced into triage and never made selectable', async () => {
    for (const file of ['plan-md.mjs', 'github-issues.mjs']) {
      const adapter = await load(file);
      const proposal = adapter.triageItemFor({
        finding: 'stop condition: two escalations in a row',
        part: '.claude/skills/loop/SKILL.md',
        change: 'name the wall in the journal entry',
        proof: 'the next run cites the wall instead of re-hitting it',
      });
      expect(proposal.labels, file).toContain('triage');
      expect(proposal.labels, file).not.toContain('ready');
      expect(proposal.selectable, file).toBe(false);
    }
  });

  it('a proposal missing any of its four parts is not ready to file', async () => {
    const adapter = await load('plan-md.mjs');
    expect(() => adapter.triageItemFor({ finding: 'x' })).toThrow(/part|change|proof/i);
  });

  it('carries a stable fingerprint so twenty identical stops file one item', async () => {
    const adapter = await load('plan-md.mjs');
    const input = {
      finding: 'queue empty',
      part: 'PLAN.md',
      change: 'seed the queue',
      proof: 'the next run has work',
    };
    const first = adapter.triageItemFor(input);
    const second = adapter.triageItemFor({ ...input });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.body).toContain(first.fingerprint);
    expect(adapter.triageItemFor({ ...input, part: 'other' }).fingerprint).not.toBe(
      first.fingerprint,
    );
  });

  it('no adapter exposes a way to create work', async () => {
    for (const file of ['plan-md.mjs', 'github-issues.mjs']) {
      const adapter = await load(file);
      const exported = Object.keys(adapter);
      expect(exported, file).not.toContain('create');
      expect(exported, file).not.toContain('createTicket');
    }
  });
});

describe('selection — the filters run IN ORDER, then the sort', () => {
  it('skips work already in progress or finished', async () => {
    const { selectionOf } = await load('core.mjs');
    expect(selectionOf(ticket({ state: 'in-progress' })).eligible).toBe(false);
    expect(selectionOf(ticket({ state: 'closed' })).eligible).toBe(false);
  });

  it('skips an escalated item — it must not be re-selected by the next query', async () => {
    const { selectionOf } = await load('core.mjs');
    expect(selectionOf(ticket({ labels: ['escalated'] })).eligible).toBe(false);
  });

  it('treats a missing trigger label as unconditional, not as missing data', async () => {
    const { selectionOf } = await load('core.mjs');
    expect(selectionOf(ticket({ trigger: null })).eligible).toBe(true);
  });

  it('never self-takes a human-declared trigger', async () => {
    const { selectionOf } = await load('core.mjs');
    const selection = selectionOf(ticket({ trigger: 'human' }));
    expect(selection.eligible).toBe(false);
    expect(selection.reasons.join(' ')).toMatch(/human/i);
  });

  it('takes an auto-trigger item only when the trigger is verified as fired', async () => {
    const { selectionOf } = await load('core.mjs');
    const auto = ticket({ trigger: 'auto' });
    expect(selectionOf(auto, { triggersFired: {} }).eligible).toBe(false);
    expect(selectionOf(auto, { triggersFired: { '1': false } }).eligible).toBe(false);
    expect(selectionOf(auto, { triggersFired: { '1': true } }).eligible).toBe(true);
  });

  // AR3-35: a `reason` is a sentence for a human; a `cause` is a tag the caller
  // can COUNT. "nothing is left" and "everything left is held back by a filter"
  // ask the owner for opposite actions — refill versus wait and interleave — and
  // the breakdown that tells them apart cannot be read back out of prose.
  it('tags each rejection with a cause, in filter order and without repeating one', async () => {
    const { selectionOf } = await load('core.mjs');
    const selection = selectionOf(
      ticket({
        state: 'closed',
        triage: true,
        blockedBy: [{ id: '2', resolved: false }],
        trigger: 'human',
      }),
    );
    expect(selection.causes).toEqual(['closed', 'triage', 'blocked', 'trigger']);
    // one tag per reason it pushed, and the set stays closed under repetition
    expect(selection.causes).toHaveLength(selection.reasons.length);
    expect(new Set(selection.causes as string[]).size).toBe((selection.causes as string[]).length);
  });

  it('draws every cause from the closed vocabulary, never from free text', async () => {
    const { selectionOf } = await load('core.mjs');
    const VOCABULARY = ['closed', 'in-progress', 'triage', 'escalated', 'blocked', 'trigger'];
    const cases: Array<[string, Partial<Ticket>]> = [
      ['closed', { state: 'closed' }],
      ['in-progress', { state: 'in-progress' }],
      ['triage', { triage: true }],
      ['escalated', { labels: ['escalated'] }],
      ['blocked', { blockedBy: [{ id: '2', resolved: false }] }],
      ['trigger', { trigger: 'human' }],
      ['trigger', { trigger: 'auto' }],
    ];
    for (const [cause, over] of cases) {
      const selection = selectionOf(ticket(over));
      expect(selection.causes, cause).toEqual([cause]);
      for (const tag of selection.causes as string[]) expect(VOCABULARY, cause).toContain(tag);
    }
  });

  it('carries an empty cause list for an item it takes', async () => {
    const { selectionOf } = await load('core.mjs');
    const selection = selectionOf(ticket());
    expect(selection.eligible).toBe(true);
    // `[]` and not `undefined`: a counter must never have to ask which it got
    expect(selection.causes).toEqual([]);
  });

  it('sorts an item that unblocks others ahead of a merely higher priority one', async () => {
    const { sortCandidates } = await load('core.mjs');
    const ordered = sortCandidates([
      ticket({ id: 'a', priority: 1 }),
      ticket({ id: 'b', priority: 9, blocks: ['c'] }),
      ticket({ id: 'c', priority: 5 }),
    ]) as Ticket[];
    // unblocking the queue keeps the loop fed, which is the point of running it
    expect(ordered.map((t) => t.id)).toEqual(['b', 'a', 'c']);
  });

  it('breaks a priority tie by creation order, so selection is deterministic', async () => {
    const { sortCandidates } = await load('core.mjs');
    const ordered = sortCandidates([
      ticket({ id: 'new', priority: 3, createdAt: '2026-07-10T00:00:00Z' }),
      ticket({ id: 'old', priority: 3, createdAt: '2026-07-01T00:00:00Z' }),
    ]) as Ticket[];
    expect(ordered.map((t) => t.id)).toEqual(['old', 'new']);
  });
});

describe('the elevated tier is rationed by spacing, not by a count', () => {
  it('refuses two elevated items back to back', async () => {
    const { selectNext } = await load('core.mjs');
    const elevated = ticket({ id: 'e2', tier: 'elevated' });
    const result = selectNext([elevated], { lastCompletedTier: 'elevated' });
    expect(result.ticket).toBeNull();
    expect(result.skipped[0].reason).toMatch(/back to back|consecutive|spacing/i);
  });

  it('lets an elevated item through once a normal one has landed', async () => {
    const { selectNext } = await load('core.mjs');
    const result = selectNext([ticket({ id: 'e2', tier: 'elevated' })], {
      lastCompletedTier: 'normal',
    });
    expect(result.ticket?.id).toBe('e2');
  });

  it('prefers an eligible normal item over a blocked-by-spacing elevated one', async () => {
    const { selectNext } = await load('core.mjs');
    const result = selectNext(
      [ticket({ id: 'e', tier: 'elevated', priority: 1 }), ticket({ id: 'n', priority: 5 })],
      { lastCompletedTier: 'elevated' },
    );
    expect(result.ticket?.id).toBe('n');
  });

  it('records why every skipped item was skipped — an unexplained skip is a bug report', async () => {
    const { selectNext } = await load('core.mjs');
    const result = selectNext(
      [
        ticket({ id: 'x', triage: true }),
        ticket({ id: 'y', blockedBy: [{ id: 'z', resolved: false }] }),
      ],
      {},
    );
    expect(result.ticket).toBeNull();
    expect(result.skipped).toHaveLength(2);
    for (const skip of result.skipped) expect(skip.reason).toBeTruthy();
  });

  // AR3-35: the spacing skip is the one the tier ration invents here — no filter
  // in `selectionOf` produced it — so it needs its own tag, or the commonest
  // hold in this repo's queue is the one the breakdown cannot name.
  it('tags the back-to-back skip as spacing', async () => {
    const { selectNext } = await load('core.mjs');
    const result = selectNext([ticket({ id: 'e2', tier: 'elevated' })], {
      lastCompletedTier: 'elevated',
    });
    expect((result.skipped as Array<{ causes: string[] }>).map((s) => s.causes)).toEqual([
      ['spacing'],
    ]);
  });

  it("carries each skipped item's causes beside its id and its reason", async () => {
    const { selectNext } = await load('core.mjs');
    const result = selectNext(
      [
        ticket({ id: 'x', triage: true }),
        ticket({ id: 'y', blockedBy: [{ id: 'z', resolved: false }] }),
      ],
      {},
    );
    const skipped = result.skipped as Array<{ id: string; reason: string; causes: string[] }>;
    expect(skipped.map((s) => s.causes)).toEqual([['triage'], ['blocked']]);
    for (const skip of skipped) expect(skip.reason, skip.id).toBeTruthy();
  });
});

describe('stop conditions — the loop is bounded by health and queue depth', () => {
  // AR3-35, from this repo's own queue: `selectNext(8 × elevated,
  // {lastCompletedTier:'elevated'})` returned `candidates: 0, skipped: 8` and the
  // stop condition read `queue-empty` with eight items open. `candidates === 0`
  // answers two questions with one number, and the two demand OPPOSITE operator
  // actions: refill the queue, versus wait and interleave normal work.

  /** `count` skip records held by one cause — the shape `selectNext` emits. */
  const heldBy = (cause: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `${cause}-${i}`,
      reason: `held by ${cause}`,
      causes: [cause],
    }));

  /**
   * Is this count named together with this tag? Either order, no format pinned:
   * what is load-bearing is that the number and the cause appear as one claim,
   * not that the sentence is worded a particular way.
   */
  const names = (why: string, count: number, tag: string): boolean =>
    new RegExp(String.raw`\b${count}\b[^0-9]{0,32}\b${tag}\b`, 'i').test(why) ||
    new RegExp(String.raw`\b${tag}\b[^0-9]{0,32}\b${count}\b`, 'i').test(why);

  it('reports a queue whose every item was filtered out as held back, not as empty', async () => {
    const { stopConditionOf } = await load('core.mjs');
    const stop = stopConditionOf({ candidates: 0, skipped: heldBy('spacing', 1) });
    expect(stop?.kind).toBe('nothing-selectable');
    // still a legitimate end of session — the queue is healthy, just not takeable
    expect(stop?.success).toBe(true);
  });

  it('names how many items are held and by what, so the owner knows which action to take', async () => {
    const { stopConditionOf } = await load('core.mjs');
    const stop = stopConditionOf({
      candidates: 0,
      skipped: [...heldBy('spacing', 8), ...heldBy('trigger', 1)],
    });
    expect(String(stop.why)).toMatch(/\b9\b/); // the count of held items
    expect(names(String(stop.why), 8, 'spacing'), String(stop.why)).toBe(true);
    expect(names(String(stop.why), 1, 'trigger'), String(stop.why)).toBe(true);
  });

  it('orders the breakdown by how many are held, then by tag — never by arrival', async () => {
    const { stopConditionOf } = await load('core.mjs');
    const stop = stopConditionOf({
      candidates: 0,
      // deliberately arriving in the opposite order to the one it must print in
      skipped: [...heldBy('spacing', 1), ...heldBy('trigger', 3), ...heldBy('blocked', 3)],
    });
    const at = (tag: string) => String(stop.why).toLowerCase().indexOf(tag);
    expect(Math.min(at('blocked'), at('trigger'), at('spacing')), String(stop.why)).toBeGreaterThan(
      -1,
    );
    expect(at('blocked')).toBeLessThan(at('trigger')); // tied at 3, so tag ascending
    expect(at('trigger')).toBeLessThan(at('spacing')); // 3 before 1
  });

  it('treats a missing skipped list as nothing held back at all', async () => {
    const { stopConditionOf } = await load('core.mjs');
    // The parameter is new, and every existing caller omits it: absent must read
    // as "nothing was filtered", never as "unknown".
    expect(stopConditionOf({ candidates: 0 })?.kind).toBe('queue-empty');
    expect(stopConditionOf({ candidates: 0, skipped: [] })?.kind).toBe('queue-empty');
  });

  it('says nothing at all while an item is still selectable, however many were held', async () => {
    const { stopConditionOf } = await load('core.mjs');
    expect(stopConditionOf({ candidates: 1, skipped: heldBy('spacing', 8) })).toBeNull();
  });

  it('keeps every graver condition ahead of a queue held back by its filters', async () => {
    const { stopConditionOf } = await load('core.mjs');
    const skipped = heldBy('spacing', 8);
    const graver: Array<[string, Record<string, unknown>]> = [
      ['queue-unreadable', { queueReadable: false }],
      ['runtime-regression', { lastDeployVerdict: 'REGRESSION' }],
      ['kill-switch', { killSwitch: true }],
      ['repeated-escalation', { consecutiveEscalations: 2 }],
      ['budget', { budgetExhausted: true }],
    ];
    for (const [kind, over] of graver) {
      expect(stopConditionOf({ candidates: 0, skipped, ...over })?.kind, kind).toBe(kind);
    }
  });

  it('an empty filtered queue ends the session and is a success', async () => {
    const { stopConditionOf } = await load('core.mjs');
    const stop = stopConditionOf({ candidates: 0 });
    expect(stop?.kind).toBe('queue-empty');
    expect(stop?.success).toBe(true);
    expect(stop?.why).toMatch(/never invent|not an invitation|do not invent/i);
  });

  it('an unhealthy deployed surface stops the run before the next task', async () => {
    const { stopConditionOf } = await load('core.mjs');
    const stop = stopConditionOf({ candidates: 5, lastDeployVerdict: 'REGRESSION' });
    expect(stop?.kind).toBe('runtime-regression');
    expect(stop?.success).toBe(false);
    expect(stop?.why).toMatch(/revert/i);
  });

  it('two escalations in a row is systemic, so it stops the whole run', async () => {
    const { stopConditionOf } = await load('core.mjs');
    expect(stopConditionOf({ candidates: 5, consecutiveEscalations: 1 })).toBeNull();
    expect(stopConditionOf({ candidates: 5, consecutiveEscalations: 2 })?.kind).toBe(
      'repeated-escalation',
    );
  });

  it('the kill switch stops at the task boundary, not by abandoning work', async () => {
    const { stopConditionOf } = await load('core.mjs');
    const stop = stopConditionOf({ candidates: 5, killSwitch: true });
    expect(stop?.kind).toBe('kill-switch');
    expect(stop?.why).toMatch(/finish|push|journal/i);
  });

  it('a budget that cannot fit another task stops now rather than half-way through one', async () => {
    const { stopConditionOf } = await load('core.mjs');
    expect(stopConditionOf({ candidates: 5, budgetExhausted: true })?.kind).toBe('budget');
  });

  it('checks the conditions in severity order — a regression outranks an empty queue', async () => {
    const { stopConditionOf } = await load('core.mjs');
    expect(stopConditionOf({ candidates: 0, lastDeployVerdict: 'REGRESSION' })?.kind).toBe(
      'runtime-regression',
    );
  });

  // --- not every skip is a HOLD ------------------------------------------------
  //
  // The `prose-reviewer` gate on the first half of AR3-35: `skipped.length > 0`
  // treats all seven causes as one thing, and they are two things.
  //
  //   HELD  — a takeable item behind a condition that clears with NO new work:
  //           `spacing`, `blocked`, `in-progress`, `trigger`. Wait and interleave.
  //   PARKED — not work in the queue at all: `closed`, `triage`, `escalated`.
  //           They wait on a human, and on two of the three adapters they
  //           ACCUMULATE: `github-issues.mjs:171-175` leaves an escalated issue
  //           open and only labels it, `proposeTriage` files an open `triage`
  //           issue at every stop, and `listEligible` filters only `CLOSED`.
  //
  // So from the first stop that escalates or files a proposal, `skipped` is never
  // empty again — and `queue-empty` becomes UNREACHABLE. The owner is never told
  // to refill: the exact refill-versus-wait inversion AR3-35 exists to remove,
  // pointing the other way.

  /**
   * `count` skip records carrying a PARKED cause. Same shape as `heldBy` — and
   * that is the point: nothing in a record says which side of the split it is on,
   * so the split has to be a property of the cause vocabulary itself.
   */
  const parked = (cause: string, count: number) =>
    heldBy(cause, count).map((skip) => ({ ...skip, reason: `parked: ${cause}` }));

  it('splits every skip cause into exactly one of held-back and parked', async () => {
    const { SKIP_CAUSES, HOLDING_CAUSES } = await load('core.mjs');
    // The subset that holds a TAKEABLE item back — the four a stop line can
    // honestly tell the owner to wait out.
    expect(HOLDING_CAUSES).toEqual(['blocked', 'in-progress', 'spacing', 'trigger']);
    expect(Object.isFrozen(HOLDING_CAUSES)).toBe(true);

    // A partition, not merely a subset: a cause added to the vocabulary later
    // must land on one side or the other, never fall through unclassified into
    // whichever branch the `if` happens to reach first.
    const holding = new Set(HOLDING_CAUSES as string[]);
    expect(holding.size).toBe((HOLDING_CAUSES as string[]).length);
    for (const cause of HOLDING_CAUSES as string[]) expect(SKIP_CAUSES, cause).toContain(cause);
    expect((SKIP_CAUSES as string[]).filter((cause) => !holding.has(cause))).toEqual([
      'closed',
      'triage',
      'escalated',
    ]);
  });

  it('reports a queue whose every skipped item is parked as empty, not as held back', async () => {
    const { stopConditionOf } = await load('core.mjs');
    // An escalated item and a filed proposal are not work waiting on time; the
    // queue really is out of takeable work, and the owner's action is to refill.
    const stop = stopConditionOf({
      candidates: 0,
      skipped: [...parked('escalated', 4), ...parked('triage', 2)],
    });
    expect(stop?.kind).toBe('queue-empty');
    expect(stop?.success).toBe(true);
    expect(stop?.why).toMatch(/never invent|not an invitation|do not invent/i);
  });

  it('names the parked pile when it reports an empty queue, so it cannot grow unseen', async () => {
    const { stopConditionOf } = await load('core.mjs');
    const stop = stopConditionOf({
      candidates: 0,
      skipped: [...parked('escalated', 4), ...parked('triage', 2)],
    });
    // Six open items the owner never hears about is how a pile of escalations
    // hides behind the word "empty" — and they wait on a HUMAN, not on time,
    // which is the one thing "refill the queue" does not say.
    expect(names(String(stop.why), 6, 'parked'), String(stop.why)).toBe(true);
    expect(String(stop.why)).toMatch(/human|owner/i);
  });

  it('counts held and parked items separately when a queue carries both', async () => {
    const { stopConditionOf } = await load('core.mjs');
    const stop = stopConditionOf({
      candidates: 0,
      skipped: [...heldBy('spacing', 3), ...parked('escalated', 5)],
    });
    expect(stop?.kind).toBe('nothing-selectable');
    expect(names(String(stop.why), 3, 'spacing'), String(stop.why)).toBe(true);
    expect(names(String(stop.why), 5, 'parked'), String(stop.why)).toBe(true);
    // 🔴 And the two are never one number. `8` is the sum of a count that clears
    // by waiting and a count that clears only when a human acts; a line that
    // prints it tells the owner to wait for five items that will never move.
    expect(String(stop.why), 'the held and parked counts are summed').not.toMatch(/\b8\b/);
  });

  // The remedy has to cover every holding cause the line actually reports —
  // `in-progress` included, which the first half named nowhere. The map fails
  // both ways: a holding cause with no phrase, and a phrase with no prose.
  const REMEDY_FOR: Record<string, RegExp> = {
    blocked: /blocker|its item closes/i,
    'in-progress': /another session|the other session|finishes|releases/i,
    spacing: /normal item|interleave/i,
    trigger: /declare|declares/i,
  };

  it('names a remedy for every cause that can hold an item back', async () => {
    const { stopConditionOf, HOLDING_CAUSES } = await load('core.mjs');
    expect(Object.keys(REMEDY_FOR).sort()).toEqual([...(HOLDING_CAUSES as string[])].sort());
    for (const cause of HOLDING_CAUSES as string[]) {
      const stop = stopConditionOf({ candidates: 0, skipped: heldBy(cause, 2) });
      expect(stop?.kind, cause).toBe('nothing-selectable');
      // "wait and interleave" is only advice if the line says what is being
      // waited FOR — an owner told to interleave a normal item cannot clear a
      // task another session is holding.
      expect(String(stop.why), cause).toMatch(REMEDY_FOR[cause]!);
    }
  });
});

describe('plan-md adapter — the zero-setup default', () => {
  const planWith = (body: string) =>
    `# P — plan\n\n## Agent queue\n\n${body}\n\n## Operator queue\n\n## Journal\n`;

  it('reads the Agent queue and nothing else', async () => {
    const { parsePlan } = await load('plan-md.mjs');
    const plan = `# P\n\n## Agent queue\n\n- add a route\n- fix the parser\n\n## Operator queue\n\n- decide: retention\n\n## Journal\n\n- something happened\n`;
    const tickets = parsePlan(plan) as Ticket[];
    expect(tickets.map((t) => t.title)).toEqual(['add a route', 'fix the parser']);
  });

  it('ignores the commented-out example block a fresh project ships with', async () => {
    const { parsePlan } = await load('plan-md.mjs');
    const plan = planWith('<!-- Tasks an agent may pick up, e.g.:\n- add a GET route (TDD)\n-->');
    expect(parsePlan(plan)).toEqual([]);
  });

  it('reads inline markers: tier, trigger and triage', async () => {
    const { parsePlan } = await load('plan-md.mjs');
    const tickets = parsePlan(
      planWith(
        [
          '- rotate the signing key [elevated]',
          '- scale the worker pool [trigger-auto]',
          '- run a security pass [trigger-human]',
          '- proposal: name the wall in the journal [triage]',
        ].join('\n'),
      ),
    ) as Ticket[];
    expect(tickets[0]!.tier).toBe('elevated');
    expect(tickets[1]!.trigger).toBe('auto');
    expect(tickets[2]!.trigger).toBe('human');
    expect(tickets[3]!.triage).toBe(true);
  });

  it('preserves queue order as priority, so the file itself is the ranking', async () => {
    const { parsePlan } = await load('plan-md.mjs');
    const tickets = parsePlan(planWith('- first\n- second\n- third')) as Ticket[];
    expect(tickets.map((t) => t.priority)).toEqual([0, 1, 2]);
  });

  it('states its own limit: a flat list carries no dependency links', async () => {
    const source = await read(queueDir, 'plan-md.mjs');
    expect(source).toMatch(/no (dependency )?link|cannot express a dependency/i);
    const { parsePlan } = await load('plan-md.mjs');
    expect((parsePlan(planWith('- one')) as Ticket[])[0]!.blockedBy).toEqual([]);
  });

  it('closing an item removes its line — a queue states what is next, not what is done', async () => {
    const { closeInPlan } = await load('plan-md.mjs');
    const plan = planWith('- keep me\n- remove me');
    const next = closeInPlan(plan, '2') as string; // ids are 1-based positions
    expect(next).toContain('- keep me');
    expect(next).not.toContain('- remove me');
    // and closing the first one leaves the second
    expect(closeInPlan(plan, '1') as string).toContain('- remove me');
  });
});

describe('plan-md files a triage proposal instead of instructing a human to file it', () => {
  // WHY this exists (AR2-2): the triage channel is only worth having if it
  // WRITES. `github-issues` files for real and was used twice on its first day —
  // its first real write caught a render defect 21 tests had missed. `plan-md`
  // returned `{ok: false, why: 'add it yourself'}` and produced ONE triage ticket
  // in the loop's entire history: an instruction nobody executes is a dead
  // channel, and a dead channel is indistinguishable from a loop with nothing to
  // say.
  //
  // 🔴 And it must file without ever becoming a source of its own work. A
  // proposal is not work: it lands in the **Operator queue**, never the Agent
  // queue, and promotion is a human act (invariant 2, above). The Agent-queue
  // assertion below is the load-bearing one — everything else here is about the
  // channel being alive; that one is about it being safe.

  const PLAN = [
    '# P — plan',
    '',
    '## Agent queue',
    '',
    '- add a route',
    '- rotate the signing key [elevated]',
    '',
    '## Operator queue',
    '',
    '- decide: retention window',
    '',
    '## Journal',
    '',
  ].join('\n');

  /** A fresh temp copy — the repo's real PLAN.md is never the fixture. */
  const withPlan = async (plan: string = PLAN): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'triage-'));
    const planPath = path.join(dir, 'PLAN.md');
    await writeFile(planPath, plan);
    return planPath;
  };

  /** The lines under a `## <heading>` section, up to the next heading. One pass. */
  const sectionOf = (plan: string, heading: string): string => {
    const wanted = new RegExp(`^##\\s+${heading}\\s*$`, 'i');
    const lines = plan.split('\n');
    const start = lines.findIndex((line) => wanted.test(line));
    if (start === -1) return '';
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^##\s+/.test(lines[i]!)) {
        end = i;
        break;
      }
    }
    return lines.slice(start + 1, end).join('\n');
  };

  const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

  // Neither fixture carries a digit, so a digit found near the proposal is the
  // implementation's counter and nothing else.
  const queueEmpty = {
    finding: 'stop condition: queue empty on every run this session',
    part: 'PLAN.md',
    change: 'seed the Agent queue with the next slice of work',
    proof: 'the next run selects an item instead of stopping',
  };
  const other = {
    finding: 'the loop re-read the whole rulebook for every task',
    part: '.claude/skills/loop/SKILL.md',
    change: 'name the wall in the journal entry',
    proof: 'the next run cites the wall instead of re-hitting it',
  };

  it('writes the proposal into the Operator queue and reports that it filed it', async () => {
    const { proposeTriage, triageItemFor } = await load('plan-md.mjs');
    const planPath = await withPlan();

    const result = proposeTriage(queueEmpty, { planPath });

    expect(result.ok).toBe(true);
    expect(result.filed).toBeTruthy();
    const operator = sectionOf(await read(planPath), 'Operator queue');
    expect(operator).toContain(triageItemFor(queueEmpty).fingerprint);
  });

  it('🔴 leaves the Agent queue byte-identical — the loop never files its own work', async () => {
    const { proposeTriage, parsePlan } = await load('plan-md.mjs');
    const planPath = await withPlan();
    const before = await read(planPath);

    proposeTriage(queueEmpty, { planPath });

    const after = await read(planPath);
    expect(sectionOf(after, 'Agent queue')).toBe(sectionOf(before, 'Agent queue'));
    expect((parsePlan(after) as Ticket[]).map((t) => t.title)).toEqual(
      (parsePlan(before) as Ticket[]).map((t) => t.title),
    );
  });

  it('files something the selection path cannot reach', async () => {
    const { proposeTriage, listEligible } = await load('plan-md.mjs');
    const { selectNext } = await load('core.mjs');
    const planPath = await withPlan();

    proposeTriage(queueEmpty, { planPath });

    // The real selection path, not a string assertion: what matters is that no
    // run can be handed this item, however the line ends up formatted.
    const tickets = listEligible({ planPath }) as Ticket[];
    const selected = selectNext(tickets, {}) as { ticket: Ticket | null };
    for (const ticket of tickets) expect(ticket.title).not.toContain(queueEmpty.change);
    expect(selected.ticket?.title ?? '').not.toContain(queueEmpty.change);
  });

  it('increments the proposal already on file rather than filing it twice', async () => {
    const { proposeTriage, triageItemFor } = await load('plan-md.mjs');
    const planPath = await withPlan();
    const { fingerprint } = triageItemFor(queueEmpty);

    proposeTriage(queueEmpty, { planPath });
    const second = proposeTriage({ ...queueEmpty }, { planPath });

    expect(second.ok).toBe(true);
    expect(second.incremented).toBeTruthy();
    const operator = sectionOf(await read(planPath), 'Operator queue');
    expect(occurrences(operator, fingerprint)).toBe(1);
    expect(operator).toMatch(/\b2\b/); // the count rose, and it is visible in the file
  });

  it('turns twenty identical stops into one proposal counted twenty times', async () => {
    const { proposeTriage, triageItemFor } = await load('plan-md.mjs');
    const planPath = await withPlan();
    const { fingerprint } = triageItemFor(queueEmpty);

    // The stated reason the fingerprint exists: under a scheduler against a
    // finite queue, "queue empty" is the most common stop of all.
    for (let i = 0; i < 20; i += 1) proposeTriage(queueEmpty, { planPath });

    const operator = sectionOf(await read(planPath), 'Operator queue');
    expect(occurrences(operator, fingerprint)).toBe(1);
    expect(operator).toMatch(/\b20\b/);
  });

  it('files a second, separate item for a different proposal', async () => {
    const { proposeTriage, triageItemFor } = await load('plan-md.mjs');
    const planPath = await withPlan();

    proposeTriage(queueEmpty, { planPath });
    const second = proposeTriage(other, { planPath });

    expect(second.ok).toBe(true);
    expect(second.filed).toBeTruthy();
    const operator = sectionOf(await read(planPath), 'Operator queue');
    expect(occurrences(operator, triageItemFor(queueEmpty).fingerprint)).toBe(1);
    expect(occurrences(operator, triageItemFor(other).fingerprint)).toBe(1);
  });

  it('refuses an incomplete proposal without leaving a half-formed item behind', async () => {
    const { proposeTriage } = await load('plan-md.mjs');
    const planPath = await withPlan();
    const before = await read(planPath);

    expect(() => proposeTriage({ finding: 'x' }, { planPath })).toThrow(/part|change|proof/i);

    expect(await read(planPath)).toBe(before);
  });

  // --- what the loop writes about ITSELF is the hardest text to write back ------
  //
  // Every proposal above is prose about something else. The findings this channel
  // exists for are about the loop, so its own vocabulary — "seen ×N" among it —
  // lands inside the finding, the change and the proof. Cost of finding these
  // three: a code review that re-ran the adapter by hand; 21 green tests did not
  // see any of them, because every fixture above was written to carry no digit.

  interface Proposal {
    finding: string;
    part: string;
    change: string;
    proof: string;
  }

  /** A proposal about the counter — so the counter's own syntax is in its title. */
  const aboutTheCounter: Proposal = {
    finding: 'the repeat count renders with a multiplication sign nobody can grep',
    part: 'PLAN.md',
    change: 'render seen ×2 as "twice"',
    proof: 'the next run reads "twice" in the filed bullet',
  };

  /** The same hazard one field over: the count sits in the finding, not the title. */
  const countInTheFinding: Proposal = {
    finding: 'the same stop arrived seen ×7 times before anyone looked at it',
    part: '.claude/skills/loop/SKILL.md',
    change: 'name the repeat count in the journal entry',
    proof: 'the next run cites the count instead of re-deriving it',
  };

  const carriesItsOwnCount: Array<[string, Proposal]> = [
    ['change', aboutTheCounter],
    ['finding', countInTheFinding],
  ];

  const fieldsOf = (proposal: Proposal): string[] => [
    proposal.finding,
    proposal.part,
    proposal.change,
    proposal.proof,
  ];

  /**
   * The count the FILE holds — read after masking out the prose the proposal
   * itself submitted. Without the mask a digit the agent wrote is
   * indistinguishable from the one the adapter maintains, and that confusion is
   * the whole defect these tests pin.
   */
  const counterIn = (section: string, proposal: Proposal, fingerprint: string): number | null => {
    // Matched on the proposal's own `proof` AS WELL AS the fingerprint, and the
    // reason is the defect this file exists to pin: a proposal's prose may quote
    // another proposal's fingerprint, so "the first line containing the
    // fingerprint" reads the quoter's line rather than the bullet the adapter
    // wrote for this proposal. The helper made the same mistake the code did.
    const line = section
      .split('\n')
      .find((candidate) => candidate.includes(fingerprint) && candidate.includes(proposal.proof));
    if (line === undefined) return null;
    let rest = line;
    for (const own of fieldsOf(proposal)) rest = rest.split(own).join(' ');
    const match = /seen\s*×?\s*(\d+)/.exec(rest);
    return match ? Number(match[1]) : null;
  };

  it.each(carriesItsOwnCount)(
    'counts a repeat of a proposal whose %s says "seen ×N", without rewriting that text',
    async (_field, proposal) => {
      const { proposeTriage } = await load('plan-md.mjs');
      const { fingerprintOf } = await load('core.mjs');
      const fingerprint = fingerprintOf(proposal) as string;
      const planPath = await withPlan();

      proposeTriage(proposal, { planPath });
      proposeTriage({ ...proposal }, { planPath });

      const operator = sectionOf(await read(planPath), 'Operator queue');
      // Byte-for-byte, deliberately: a recorded finding is reported, never
      // silently corrected (`core.mjs:131`). A counter that edits the sentence it
      // is counting destroys the evidence the channel exists to carry.
      for (const own of fieldsOf(proposal)) expect(operator, own).toContain(own);
      expect(counterIn(operator, proposal, fingerprint)).toBe(2);
    },
  );

  it.each(carriesItsOwnCount)(
    'reports a `seen` the file agrees with when the proposal\'s %s says "seen ×N"',
    async (_field, proposal) => {
      const { proposeTriage } = await load('plan-md.mjs');
      const { fingerprintOf } = await load('core.mjs');
      const fingerprint = fingerprintOf(proposal) as string;
      const planPath = await withPlan();

      proposeTriage(proposal, { planPath });
      const second = proposeTriage({ ...proposal }, { planPath });

      // Two filings is two — and agreement alone would not say so: when the
      // counter rewrites the digit inside the proposal's own prose, the returned
      // number and the number left in the file are the SAME wrong number. The
      // count is what ends up quoted in the journal, so it is pinned to the fact.
      expect(second.seen).toBe(2);
      const operator = sectionOf(await read(planPath), 'Operator queue');
      expect(counterIn(operator, proposal, fingerprint)).toBe(second.seen);
    },
  );

  // --- the increment must land on a line the agent wrote ------------------------
  //
  // The other two adapters ask their tracker for `label:triage` before deduping
  // (`github-issues.mjs:218`, `jira.mjs:317`). plan-md has no label, so the
  // candidate set is a choice — and "every line under the heading" is the widest
  // one available. The Operator queue is the human's page: it holds decisions,
  // rejections and commented-out examples, and a fingerprint quoted in any of
  // them is not a filed proposal.

  const quotesAFingerprint: Array<[string, (fingerprint: string) => string]> = [
    [
      'a human WONTFIX quoting the fingerprint',
      (fingerprint) =>
        `- WONTFIX — we discussed \`${fingerprint}\` in March and decided against it`,
    ],
    [
      'a commented-out example quoting the fingerprint',
      (f) => `<!-- example: fingerprint ${f} -->`,
    ],
  ];

  it.each(quotesAFingerprint)(
    'still files the proposal when the Operator queue already holds %s',
    async (_kind, lineFor) => {
      const { proposeTriage } = await load('plan-md.mjs');
      const { fingerprintOf } = await load('core.mjs');
      const fingerprint = fingerprintOf(queueEmpty) as string;
      const humanLine = lineFor(fingerprint);
      const planPath = await withPlan(
        PLAN.replace('- decide: retention window', `- decide: retention window\n${humanLine}`),
      );

      const result = proposeTriage(queueEmpty, { planPath });

      // Not a formatting assertion: the proof text appears nowhere but in a bullet
      // the adapter wrote, so a line carrying it is the proposal being on file.
      const operator = sectionOf(await read(planPath), 'Operator queue');
      const filed = operator
        .split('\n')
        .filter((line) => line.includes(fingerprint) && line.includes(queueEmpty.proof));
      expect(filed).toHaveLength(1);
      expect(result.filed).toBeTruthy();
    },
  );

  it.each(quotesAFingerprint)('leaves %s exactly as the human wrote it', async (_kind, lineFor) => {
    const { proposeTriage } = await load('plan-md.mjs');
    const { fingerprintOf } = await load('core.mjs');
    const humanLine = lineFor(fingerprintOf(queueEmpty) as string);
    const planPath = await withPlan(
      PLAN.replace('- decide: retention window', `- decide: retention window\n${humanLine}`),
    );

    proposeTriage(queueEmpty, { planPath });

    // Byte-for-byte: appending ` · seen ×2` to somebody's rejection turns their
    // decision into a counter for a proposal they never filed.
    expect((await read(planPath)).split('\n')).toContain(humanLine);
  });

  // --- nowhere safe to land --------------------------------------------------
  //
  // The refusal branch had no test at all. It is the one branch where the failure
  // mode is the invariant itself: a proposal with nowhere unselectable to go must
  // NOT fall back to the Agent queue.

  const NO_OPERATOR_QUEUE = ['# P — plan', '', '## Agent queue', '', '- add a route', ''].join(
    '\n',
  );

  it('refuses when there is no Operator queue heading, and names the heading it wanted', async () => {
    const { proposeTriage } = await load('plan-md.mjs');
    const planPath = await withPlan(NO_OPERATOR_QUEUE);

    const result = proposeTriage(queueEmpty, { planPath });

    expect(result.ok).toBe(false);
    expect(result.why).toMatch(/Operator queue/);
  });

  it('🔴 writes nothing at all when there is no Operator queue heading', async () => {
    const { proposeTriage } = await load('plan-md.mjs');
    const planPath = await withPlan(NO_OPERATOR_QUEUE);
    const before = await read(planPath);

    proposeTriage(queueEmpty, { planPath });

    // No partial write, and above all nothing appended to the Agent queue —
    // "there was nowhere unselectable to file it" can never resolve to "file it
    // somewhere selectable" (invariant 2).
    expect(await read(planPath)).toBe(before);
  });

  // --- one proposal is one LINE, whatever the proposal says ---------------------
  //
  // A second review round, re-running the adapter by hand, found the four fields
  // are interpolated into ONE string that is then spliced into a `string[]` and
  // joined with '\n' — so a newline in any of them writes real lines into the
  // file, and `validateProposal` only checks truthiness. Not an exotic input:
  // `autonomy.md` tells an escalating run to report "verbatim errors, not
  // summaries", so a pasted stack trace in `finding` is the EXPECTED case.
  //
  // Neither test below pins how the newline is neutralised — collapsing it,
  // escaping it, or refusing the proposal outright are all legitimate. They pin
  // the two things that broke: one filed proposal is one line, and nothing a
  // proposal contains can reach the Agent queue.

  /** A verbatim error, pasted whole — headings, bullets and all. */
  const verbatimError: Proposal = {
    finding: [
      'the run stopped on a verbatim error:',
      '## Agent queue',
      '- at proposeTriage (plan-md.mjs)',
    ].join('\n'),
    part: 'PLAN.md',
    change: 'quote the failing frame in the journal entry',
    proof: 'the next run cites the frame instead of re-deriving it',
  };

  it('files a proposal carrying a pasted stack trace as exactly one line, counted once', async () => {
    const { proposeTriage } = await load('plan-md.mjs');
    const { fingerprintOf } = await load('core.mjs');
    const fingerprint = fingerprintOf(verbatimError) as string;
    const planPath = await withPlan();
    const before = await read(planPath);

    const first = proposeTriage(verbatimError, { planPath });
    proposeTriage({ ...verbatimError }, { planPath });
    const after = await read(planPath);

    // Refusing a proposal that cannot be rendered on one line is a legitimate
    // answer — but then it refuses every time and writes nothing at all.
    if (first.ok === false) {
      expect(proposeTriage({ ...verbatimError }, { planPath }).ok).toBe(false);
      expect(after).toBe(before);
      return;
    }

    // Observed instead: three filings produced THREE bullets each reading
    // `seen ×1`. The injected `##` truncates the Operator range on the next
    // read, so the `fingerprint … seen ×N` tail — which lands on a later
    // physical line than the bullet started on — is never a candidate, and
    // dedupe is broken permanently for this proposal.
    expect(after.split('\n').length - before.split('\n').length).toBe(1);
    const operator = sectionOf(after, 'Operator queue');
    expect(operator.split('\n').filter((line) => line.includes(fingerprint))).toHaveLength(1);
    expect(counterIn(operator, verbatimError, fingerprint)).toBe(2);
  });

  /** The heading order is a human's choice, and this one is not exotic either. */
  const OPERATOR_BEFORE_AGENT = [
    '# P — plan',
    '',
    '## Operator queue',
    '',
    '- decide: retention window',
    '',
    '## Agent queue',
    '',
    '- add a route',
    '- rotate the signing key [elevated]',
    '',
    '## Journal',
    '',
  ].join('\n');

  it('🔴 cannot hand a run its own proposal when the Operator queue comes first', async () => {
    const { proposeTriage, listEligible } = await load('plan-md.mjs');
    const { selectNext } = await load('core.mjs');
    const planPath = await withPlan(OPERATOR_BEFORE_AGENT);
    const before = (listEligible({ planPath }) as Ticket[]).map((t) => t.title);
    expect(before).toEqual(['add a route', 'rotate the signing key']);

    proposeTriage(verbatimError, { planPath });

    // The load-bearing one, through the REAL selection path. Observed: the
    // injected heading became the first `## Agent queue` in the file, and
    // selection returned the proposal's own tail as ordinary work — the
    // `[triage]` marker having stayed behind on the earlier physical line.
    const after = listEligible({ planPath }) as Ticket[];
    expect(after.map((t) => t.title)).toEqual(before);
    const selected = (selectNext(after, {}) as { ticket: Ticket | null }).ticket;
    expect(selected?.title ?? '').not.toContain(verbatimError.proof);
  });

  // --- a fingerprint quoted in prose is not a filed proposal --------------------
  //
  // Also from the second review round. Candidates are now restricted to lines the
  // adapter wrote, but the WHOLE bullet is handed to `duplicateOf`, which matches
  // by substring — so the adapter's own free text is still in the search space,
  // and a proposal ABOUT the deduper quotes fingerprints for a living.

  /** The proposal whose fingerprint the other one quotes. */
  const dedupeIsBySubstring: Proposal = {
    finding: 'dedupe is by substring',
    part: 'core.mjs',
    change: 'anchor it',
    proof: 'the next run files a second bullet instead of counting the first',
  };

  /** Filed first, and it names the other one's fingerprint in its finding. */
  const quoting = (fingerprint: string): Proposal => ({
    finding: `the deduper matched ${fingerprint} by accident`,
    part: '.claude/scripts/queue/core.mjs',
    change: 'restrict the dedupe search to the fields this adapter wrote',
    proof: 'a proposal quoting a fingerprint no longer swallows its bullet',
  });

  /** The bullet the adapter wrote FOR this proposal — its own proof text is only there. */
  const bulletsFor = (operator: string, proposal: Proposal, fingerprint: string): string[] =>
    operator
      .split('\n')
      .filter((line) => line.includes(proposal.proof) && line.includes(fingerprint));

  // 🔴 The same quadratic shape as `hygieneOf`'s test above, in the same file,
  // found by the third review round on this function: an unbounded `\s*` in
  // front of `[\r\n]+` — a subset of `\s` — re-splits a whitespace run at every
  // offset. Measured before the fix: 6,659 ms on 65k spaces, 102,801 ms on 256k,
  // and 0 ms the moment a single newline appears anywhere after the run, which
  // is why every injection fixture missed it. `core.mjs` calls this the third
  // occurrence of the shape and says remembering it once was evidently not
  // enough; this is the fourth, so it gets the same bar the sibling has.
  it('folds a field onto one line in linear time', async () => {
    const { proposeTriage } = await load('plan-md.mjs');
    const planPath = await withPlan();
    const runs = [' '.repeat(65_000), '\t'.repeat(65_000) + 'x', ' '.repeat(65_000) + '\n'];

    for (const [i, run] of runs.entries()) {
      const started = performance.now();
      proposeTriage(
        { finding: `f${i}${run}`, part: 'p', change: `c${i}`, proof: 'pr' },
        { planPath },
      );
      expect(performance.now() - started, `run ${i}`).toBeLessThan(250);
    }
  });

  // The fold is wider than "newlines are folded": interior tabs and multi-space
  // runs collapse too. Every other fixture here is single-spaced, so nothing
  // pinned that — and the byte-for-byte assertions elsewhere in this block read
  // as if verbatim preservation were guaranteed. It is guaranteed only for
  // single-spaced text, and the docblock now says so; this is the test that
  // keeps the two in step.
  it('collapses interior whitespace runs, not only line breaks', async () => {
    const { proposeTriage } = await load('plan-md.mjs');
    const { fingerprintOf } = await load('core.mjs');
    const spaced = {
      finding: 'the\t\tcolumns   drifted',
      part: 'PLAN.md',
      change: 'fold the field',
      proof: 'one space survives',
    };
    const planPath = await withPlan();

    const first = proposeTriage(spaced, { planPath });
    const operator = sectionOf(await read(planPath), 'Operator queue');

    expect(first.ok).toBe(true);
    expect(operator).toContain('the columns drifted');
    expect(operator).not.toContain('the\t\tcolumns');
    // and the fold cannot reach dedupe: the fingerprint is computed on the raw
    // proposal, before any folding, so a refiling still increments in place
    proposeTriage({ ...spaced }, { planPath });
    const again = sectionOf(await read(planPath), 'Operator queue');
    expect(again.split('the columns drifted')).toHaveLength(2); // one bullet, not two
    expect(counterIn(again, spaced, fingerprintOf(spaced) as string)).toBe(2);
  });

  it('files a proposal whose fingerprint an earlier proposal quotes, on its own bullet', async () => {
    const { proposeTriage } = await load('plan-md.mjs');
    const { fingerprintOf } = await load('core.mjs');
    const quotedFingerprint = fingerprintOf(dedupeIsBySubstring) as string;
    const quoter = quoting(quotedFingerprint);
    const quoterFingerprint = fingerprintOf(quoter) as string;
    const planPath = await withPlan();

    proposeTriage(quoter, { planPath });
    proposeTriage(dedupeIsBySubstring, { planPath });
    proposeTriage({ ...dedupeIsBySubstring }, { planPath });

    // Observed: the quoted proposal's bullet was never written at all, while the
    // quoter's counter climbed to ×3 — a human's record of one finding turned
    // into the tally of a different one.
    const operator = sectionOf(await read(planPath), 'Operator queue');
    expect(bulletsFor(operator, quoter, quoterFingerprint)).toHaveLength(1);
    expect(bulletsFor(operator, dedupeIsBySubstring, quotedFingerprint)).toHaveLength(1);
    expect(counterIn(operator, quoter, quoterFingerprint)).toBe(1);
    expect(counterIn(operator, dedupeIsBySubstring, quotedFingerprint)).toBe(2);
  });

  it("reports filing, not incrementing, when the only match is somebody else's prose", async () => {
    const { proposeTriage } = await load('plan-md.mjs');
    const { fingerprintOf } = await load('core.mjs');
    const quoter = quoting(fingerprintOf(dedupeIsBySubstring) as string);
    const planPath = await withPlan();

    proposeTriage(quoter, { planPath });
    const filed = proposeTriage(dedupeIsBySubstring, { planPath });

    // Observed: `{ ok: true, seen: 2, incremented: '…' }` on a first filing —
    // the caller is told a bullet was incremented that does not exist, and that
    // claim is what ends up quoted in the journal.
    expect(filed.filed).toBeTruthy();
    expect(filed.incremented).toBeFalsy();
    expect(filed.seen).toBe(1);
  });
});

describe('github-issues adapter', () => {
  const issue = (over: Record<string, unknown> = {}) => ({
    number: 12,
    title: 'add a route',
    body: '',
    state: 'OPEN',
    labels: [],
    url: 'https://example.invalid/issues/12',
    createdAt: '2026-07-01T00:00:00Z',
    ...over,
  });

  it('maps an issue onto the neutral ticket shape', async () => {
    const { toTicket } = await load('github-issues.mjs');
    const t = toTicket(issue()) as Ticket;
    expect(t).toMatchObject({ id: '12', title: 'add a route', state: 'open', tier: 'normal' });
  });

  it('derives tier, trigger, triage and in-progress from labels', async () => {
    const { toTicket } = await load('github-issues.mjs');
    expect((toTicket(issue({ labels: [{ name: 'human-review' }] })) as Ticket).tier).toBe(
      'elevated',
    );
    expect((toTicket(issue({ labels: [{ name: 'trigger-auto' }] })) as Ticket).trigger).toBe(
      'auto',
    );
    expect((toTicket(issue({ labels: [{ name: 'triage' }] })) as Ticket).triage).toBe(true);
    expect((toTicket(issue({ labels: [{ name: 'in-progress' }] })) as Ticket).state).toBe(
      'in-progress',
    );
  });

  it('reads dependencies from the body as links to the blockers themselves', async () => {
    const { toTicket } = await load('github-issues.mjs');
    // Not a label: the reference names the blocker, and the blocker's own state
    // decides. That is what keeps invariant 1 true here.
    const t = toTicket(issue({ body: 'Some context.\n\nBlocked by #7\nDepends on #9\n' }), {
      '7': 'CLOSED',
      '9': 'OPEN',
    }) as Ticket;
    expect(t.blockedBy).toEqual([
      { id: '7', resolved: true },
      { id: '9', resolved: false },
    ]);
  });

  it('treats a blocker whose state is unknown as unresolved', async () => {
    const { toTicket } = await load('github-issues.mjs');
    // "I could not look" must never resolve to "it is fine".
    const t = toTicket(issue({ body: 'Blocked by #7' }), {}) as Ticket;
    expect(t.blockedBy).toEqual([{ id: '7', resolved: false }]);
  });

  it('reads priority from a label and falls back to the lowest', async () => {
    const { toTicket } = await load('github-issues.mjs');
    expect((toTicket(issue({ labels: [{ name: 'priority:2' }] })) as Ticket).priority).toBe(2);
    expect((toTicket(issue({ labels: [{ name: 'P1' }] })) as Ticket).priority).toBe(1);
    expect((toTicket(issue()) as Ticket).priority).toBe(999);
  });

  it('collects the ids this issue blocks, so the sort can prefer it', async () => {
    const { blocksIndex } = await load('github-issues.mjs');
    const index = blocksIndex([
      issue({ number: 1, body: 'Blocked by #3' }),
      issue({ number: 2, body: 'Depends on #3' }),
    ]);
    expect(index['3']).toEqual(['1', '2']);
  });
});

describe('preflight — the checks that have already cost a run', () => {
  it('reports which items it checked AND which it did not', async () => {
    const { report } = await load('../preflight.mjs');
    const result = report({
      killSwitch: { ok: true, detail: 'absent' },
      defaultBranchFresh: { ok: true, detail: 'up to date' },
      lastDeploy: { ok: 'unknown', detail: 'no deploy workflow found' },
    });
    // A silent script would let a GO on three items read as a pass on all of them.
    expect(result.unchecked.length).toBeGreaterThan(0);
    expect(result.rendered).toMatch(/not checked|unchecked|still yours/i);
  });

  it('never turns an unknown into a pass', async () => {
    const { verdictOf } = await load('../preflight.mjs');
    expect(verdictOf({ killSwitch: { ok: 'unknown' } })).toBe('CAUTION');
    expect(verdictOf({ killSwitch: { ok: true }, defaultBranchFresh: { ok: 'unknown' } })).toBe(
      'CAUTION',
    );
  });

  it('a set kill switch or a failed last deploy is STOP, not CAUTION', async () => {
    const { verdictOf } = await load('../preflight.mjs');
    expect(verdictOf({ killSwitch: { ok: false } })).toBe('STOP');
    expect(verdictOf({ killSwitch: { ok: true }, lastDeploy: { ok: false } })).toBe('STOP');
  });

  it('all clear is GO', async () => {
    const { verdictOf } = await load('../preflight.mjs');
    expect(
      verdictOf({
        killSwitch: { ok: true },
        defaultBranchFresh: { ok: true },
        lastDeploy: { ok: true },
      }),
    ).toBe('GO');
  });
});

describe('the queue CLI', () => {
  function run(args: string[], cwd: string): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [path.join(queueDir, 'index.mjs'), ...args],
        { cwd },
        (error, stdout, stderr) => {
          resolve({
            code: error ? ((error as { code?: number }).code ?? 1) : 0,
            out: stdout + stderr,
          });
        },
      );
    });
  }

  it('lists the next selectable item from PLAN.md with no configuration at all', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'queue-'));
    await writeFile(
      path.join(dir, 'PLAN.md'),
      '# P\n\n## Agent queue\n\n- add a route\n- rotate the key [elevated]\n\n## Journal\n',
    );
    const result = await run(['next', '--json'], dir);
    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.out) as { ticket: Ticket | null };
    expect(parsed.ticket?.title).toBe('add a route');
  });

  it('says the queue is empty in a way that reads as success', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'queue-'));
    await writeFile(path.join(dir, 'PLAN.md'), '# P\n\n## Agent queue\n\n## Journal\n');
    const result = await run(['next'], dir);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/queue empty/i);
    expect(result.out).toMatch(/do not invent|not an invitation|never invent/i);
  });

  // AR3-35 end to end: the data the diagnosis needs is already computed one line
  // above the call — `stopConditionOf({ candidates: 0 })` throws away the very
  // records it would have to read. This is the run the owner actually sees.
  it('reports an all-elevated queue after an elevated item as held back, not as empty', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'queue-'));
    await writeFile(
      path.join(dir, 'PLAN.md'),
      '# P\n\n## Agent queue\n\n- rotate the key [elevated]\n- migrate the store [elevated]\n\n## Journal\n',
    );
    const configPath = path.join(dir, '.claude-queue.json');
    await writeFile(configPath, JSON.stringify({ lastCompletedTier: 'elevated' }));

    const result = await run(['next', '--json', '--config', configPath], dir);

    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.out) as {
      stop: { kind: string; why: string } | null;
      skipped: Array<{ id: string; causes: string[] }>;
    };
    expect(parsed.skipped).toHaveLength(2);
    expect(parsed.stop?.kind).toBe('nothing-selectable');
    // and the line names the real records, which is the only way it could
    expect(parsed.stop?.why).toMatch(/\b2\b/);
    expect(parsed.stop?.why).toMatch(/spacing/i);
  });

  it('refuses an unknown adapter loudly instead of falling back to a guess', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'queue-'));
    await writeFile(path.join(dir, 'PLAN.md'), '# P\n\n## Agent queue\n\n- x\n');
    await writeFile(path.join(dir, '.claude-queue.json'), '{"adapter":"nope"}');
    const result = await run(['next', '--config', path.join(dir, '.claude-queue.json')], dir);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/unknown queue adapter/i);
  });
});

describe('the loop skill drives the seam, not one tracker', () => {
  const skill = () => read(universal, '.claude', 'skills', 'loop', 'SKILL.md');

  it('reads the queue through the adapter and names no tracker as mandatory', async () => {
    const content = await skill();
    expect(content).toMatch(/queue\/index\.mjs|scripts\/queue/);
    expect(content).toMatch(/adapter/i);
  });

  it('still refuses to invent work when the queue is empty', async () => {
    const content = await skill();
    expect(content).toMatch(/queue.*empty/i);
    expect(content).toMatch(/do not invent work/i);
  });

  it('states the unreadable-queue stop: never fall back to memory for a queue', async () => {
    const content = await skill();
    expect(content).toMatch(/unreadable|cannot read the queue/i);
    expect(content).toMatch(/never fall back|do not fall back/i);
  });

  // AR3-35: adding a member to a closed set is only safe if something walks the
  // list. The phrases below are how the skill names each kind today; the test
  // fails both ways — a kind with no phrase, and a phrase with no prose.
  const NAMED_IN_PROSE: Record<string, RegExp> = {
    'queue-unreadable': /queue unreadable|unreadable queue/i,
    'runtime-regression': /runtime regression/i,
    'kill-switch': /kill switch/i,
    'repeated-escalation': /two escalations in a row/i,
    budget: /budget/i,
    'nothing-selectable': /nothing[- ]selectable/i,
    'queue-empty': /queue empty/i,
  };

  it('enumerates every stop condition the core can return, the held-back one included', async () => {
    const { stopConditionOf } = await load('core.mjs');
    const content = await skill();
    const kinds = [
      stopConditionOf({ queueReadable: false }),
      stopConditionOf({ candidates: 5, lastDeployVerdict: 'REGRESSION' }),
      stopConditionOf({ candidates: 5, killSwitch: true }),
      stopConditionOf({ candidates: 5, consecutiveEscalations: 2 }),
      stopConditionOf({ candidates: 5, budgetExhausted: true }),
      stopConditionOf({
        candidates: 0,
        skipped: [{ id: '1', reason: 'held by spacing', causes: ['spacing'] }],
      }),
      stopConditionOf({ candidates: 0 }),
    ].map((stop) => (stop as { kind: string }).kind);

    expect(new Set(kinds).size, kinds.join(', ')).toBe(kinds.length);
    for (const kind of kinds) {
      const phrase = NAMED_IN_PROSE[kind];
      expect(
        phrase,
        `${kind} is a stop condition the skill's list does not account for`,
      ).toBeTruthy();
      expect(content, kind).toMatch(phrase!);
    }
  });

  it('keeps proposals in triage and the patching with the human', async () => {
    const content = await skill();
    expect(content).toMatch(/triage/i);
    expect(content).toMatch(/proposes|proposal/i);
    expect(content).toMatch(/owner|human/i);
    // three is a cap that forces a choice; padding poisons the channel
    expect(content).toMatch(/at most three|three proposals|zero is/i);
  });

  it('names the outcome state vocabulary, including the honest failing one', async () => {
    const content = await skill();
    for (const state of ['clean-pass', 'documented-stall', 'incomplete']) {
      expect(content, state).toContain(state);
    }
    // a documented stall is a success and reading it as failure breaks the rule
    expect(content).toMatch(/documented-stall.*success|success.*documented-stall/is);
  });

  it('forbids hand-feeding a stage what an earlier stage should have supplied', async () => {
    const content = await skill();
    expect(content).toMatch(/hand-feed|do not answer it|the stall is the finding/i);
  });

  it('journals at checkpoints, not only at the end', async () => {
    const content = await skill();
    expect(content).toMatch(/checkpoint/i);
  });
});

describe('composition', () => {
  it('layers.json classifies the queue seam as process', async () => {
    const manifest = JSON.parse(await read(universal, 'layers.json')) as Record<string, string[]>;
    for (const file of [
      '.claude/scripts/queue/core.mjs',
      '.claude/scripts/queue/plan-md.mjs',
      '.claude/scripts/queue/github-issues.mjs',
      '.claude/scripts/queue/index.mjs',
      '.claude/scripts/preflight.mjs',
    ]) {
      expect(manifest['process'], file).toContain(file);
    }
  });
});
