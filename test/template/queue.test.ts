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
});

describe('stop conditions — the loop is bounded by health and queue depth', () => {
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
