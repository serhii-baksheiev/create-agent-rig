import { execFile } from 'node:child_process';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
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

// Every git this file spawns gets an explicit environment, and the list of what
// leaves is the ONE the shipped scripts export — a hand-rolled second copy here
// is the same defect `invariants.md` names ("one mechanism, one implementation").
// The scar: under pre-commit an inherited relative `GIT_INDEX_FILE` killed these
// tests with `fatal: .git/index: index file open failed: Not a directory`, while
// `pnpm test` from a shell was green.
const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(universal, '.claude', 'scripts', 'preflight.mjs')).href
)) as { withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };

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

// --- measuring SCALING, because a wall-clock budget measures the runner ---------
//
// 🔴 Two tests below guard the same defect — the quadratic whitespace shape this
// queue layer has now grown four times — and both of them used to assert an
// ABSOLUTE budget over ONE untimed sample: `expect(elapsed).toBeLessThan(250)`.
// That is not a measurement of the code, and CI proved it. Run 31956613905 failed
// the fold test with `run 1: expected 328.73197700000014 to be less than 250` on
// an implementation that was, and still is, correct: the real work is **~0.1 ms**
// per call, so ~99.9% of that 328 ms was a scheduler or GC pause landing inside
// the single sample the test happened to take. Its sibling case on the same
// runner passed. A budget 800× the real cost sounds generous and is in fact a
// coin toss, because the thing it is really bounding is how busy the machine is.
//
// What these tests actually claim is a claim about GROWTH, so that is what is
// asserted now: cost at 4× the input, over cost at the input. Linear work cannot
// exceed 4×; the quadratic spelling measures ~16× (verified below, against a
// deliberately reintroduced defect). Two sizes, one ratio, no clock budget.
//
// **The statistic is the FASTEST call, not the average or the median**, and that
// is the load-bearing choice. Timing noise is one-sided — a pause can only ever
// add — so the fastest of several calls is the closest reading of the code's own
// cost, while a mean is a reading of the runner's mood. It is not a stylistic
// preference: replaying this exact procedure 200 times under a 16-way CPU
// saturation, a median of 5 produced a ratio of **129** on healthy code (three
// paused samples are enough to move a median), where the fastest of 9 stayed at
// **1.39** for the fold and **4.32** for the hygiene checks across 450 saturated
// measurements each.

/** Timed calls per size. Only the fastest counts; the rest buy the odds. */
const TIMED_CALLS = 9;

/**
 * The ceiling on one size's sampling: past this, stop taking samples.
 *
 * Nothing healthy comes near it. A warm call plus a full set of 9 costs 0.9 ms
 * for the fold, and 24 ms / 97 ms for the two `hygieneOf` sizes on their
 * expensive bracket shape — that shape, not the fold, is what this number has to
 * clear.
 *
 * 🔴 **Two limits, because `invariants.md` asks a guard to state what it cannot
 * do rather than let a reader infer cover that is not there.**
 *
 * - **Truncation is not uniformly safe.** Cutting the sample set short can only
 *   raise the fastest reading. On the `4n` side that raises the ratio, toward a
 *   false red, which is the harmless direction. On the `n` side it *lowers* the
 *   ratio — toward a MISSED defect. The window is narrow (a call must exceed
 *   ~222 ms to truncate the set at all, yet stay under `catastropheMs` to reach
 *   the second reading), but narrow is not the same as absent, so it is written
 *   down rather than described as failing safe.
 * - **It bounds sampling, not the test.** The untimed warm call below is outside
 *   the budget, and the deadline is checked only after a call returns, so the
 *   real bound is `SAMPLE_BUDGET_MS` plus up to two full calls at this size. For
 *   a defect worse than quadratic those two calls are themselves unbounded, and
 *   `catastropheMs` cannot help — it reads a number the warm call has already
 *   paid for. **And nothing else in this process bounds it either** — the
 *   `timeout` on the two tests below is not a ceiling and must not be read as
 *   one. Vitest cannot preempt a synchronously blocking body, and these bodies
 *   are one `await load(…)` followed by an unbroken synchronous stretch, so the
 *   timer fires only once that stretch has finished: measured, a 3,000 ms busy
 *   loop under `{ timeout: 300 }` ran the full 3.00 s and *then* reported the
 *   timeout. The overrun scales with the defect, not with the number. What the
 *   timeout buys is that an eventual return is reported as a named failure
 *   rather than a mystery — and it costs the ratio, which is lost the moment the
 *   deadline decides the message. The real wall-clock ceiling here is the CI
 *   job's.
 */
const SAMPLE_BUDGET_MS = 2_000;

/**
 * How much work one timed sample must contain, in milliseconds.
 *
 * 🔴 **The fix for a flake this file's own guard produced.** "Fastest of nine"
 * defeats a pause that lands in *some* samples; it cannot defeat a scheduler
 * quantum that covers *all* of them, and at 21 µs per call all nine fit inside
 * one. Measured on the cheapest shape (`hygieneOf` on an unterminated link):
 * healthy growth is 3.84–3.95 over twelve isolated repeats, but under the full
 * 38-file parallel suite one run in roughly seven read `n = 0.024 ms,
 * 4n = 0.207 ms` — a ratio of **8.73** against a bound of 8, with `n` normal
 * and only the second reading inflated. Nothing was wrong with the code.
 *
 * Raising the bound would have been the wrong repair: it treats a measurement
 * defect as a tolerance. The measurement is what was too small, so a sample now
 * batches enough calls to be worth about a millisecond, and a quantum can no
 * longer swallow one whole. The per-call cost is the batch divided by its size,
 * so the ratio still compares like with like even though the two sizes need
 * different batches.
 */
const SAMPLE_TARGET_MS = 1;

/** Ceiling on batch size, so a subject that is cheap AND slow cannot run away. */
const MAX_BATCH = 4_096;

/**
 * The cost of one `call()` in milliseconds — the fastest of `TIMED_CALLS`
 * batches, divided by the batch size.
 *
 * Floored at one microsecond — a reading of exactly 0 would make every ratio
 * `Infinity` and print a failure message carrying no measurement at all. With
 * batching this is now unreachable by construction rather than by luck of the
 * subject's cost.
 */
const millisPerCall = (call: () => void): number => {
  call(); // warm the JIT and compile any lazily-built regex, untimed

  // Calibrate: one probe says how many calls make a sample worth measuring.
  const probeStart = performance.now();
  call();
  const probe = Math.max(performance.now() - probeStart, 0.0005);
  const batch = Math.min(MAX_BATCH, Math.max(1, Math.ceil(SAMPLE_TARGET_MS / probe)));

  let fastest = Infinity;
  const deadline = performance.now() + SAMPLE_BUDGET_MS;
  for (let i = 0; i < TIMED_CALLS; i += 1) {
    const started = performance.now();
    for (let k = 0; k < batch; k += 1) call();
    fastest = Math.min(fastest, performance.now() - started);
    if (performance.now() >= deadline) break;
  }
  return Math.max(fastest / batch, 0.000001);
};

interface ScalingBounds {
  /** The smaller input size, in characters. The larger one is always 4×. */
  n: number;
  /**
   * The most the cost may grow for 4× the input. Chosen per subject, from its
   * own measurements — the two differ because only one of them pays for I/O.
   *
   * 🔴 What a bound of this size does NOT detect, so "stays linear" is not read
   * as "detects any superlinearity": over a 4× spread, a bound of 8 admits
   * anything up to n^1.5 and a bound of 6 up to n^1.29, which means `n log n`
   * (≈4.6 at these sizes) passes silently. That is a limit of comparing two
   * sizes, not a regression — the absolute budget it replaced was blind to the
   * same growth, and to quadratic terms ~22–350× larger besides.
   */
  maxRatio: number;
  /** A cost at `n` this far above the real one is a catastrophe, not a pause. */
  catastropheMs: number;
}

/**
 * Assert that `prepare(size)`'s call costs at most `maxRatio`× as much on 4× the
 * input — one mechanism for both subjects, per `invariants.md`.
 *
 * `prepare` builds the input OUTSIDE the timed call, so `' '.repeat(n)` is never
 * charged to the code under test.
 *
 * The catastrophe ceiling runs BEFORE the 4× measurement on purpose. A defect
 * worse than quadratic would make that second measurement take minutes, and a
 * vitest timeout reports nothing about what was measured; this fails first, with
 * the numbers in the message.
 */
const staysLinear = (
  what: string,
  prepare: (size: number) => () => void,
  { n, maxRatio, catastropheMs }: ScalingBounds,
): void => {
  const atN = millisPerCall(prepare(n));
  expect(
    atN,
    `${what}: ${n} characters cost ${atN.toFixed(3)}ms in the fastest of ` +
      `${TIMED_CALLS} calls, over the ${catastropheMs}ms catastrophe ceiling. ` +
      `That is far past anything a pause explains, so the ${n * 4}-character ` +
      'measurement is skipped rather than left to run for minutes.',
  ).toBeLessThan(catastropheMs);

  const at4N = millisPerCall(prepare(n * 4));
  const ratio = at4N / atN;
  expect(
    ratio,
    `${what}: 4× the input cost ${ratio.toFixed(2)}× the time — ` +
      `${at4N.toFixed(3)}ms at ${n * 4} characters against ${atN.toFixed(3)}ms at ` +
      `${n}, each the fastest of ${TIMED_CALLS} calls. Expected under ` +
      `${maxRatio}×: linear work cannot exceed 4×, and the quadratic whitespace ` +
      'shape this guards against measures ~16×.',
  ).toBeLessThan(maxRatio);
};

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
  //
  // Bounds GROWTH, not milliseconds — see "measuring SCALING" at the top of this
  // file for the CI failure that retired the absolute budget. This subject sets
  // its own numbers rather than borrowing the fold's, because it is pure: with no
  // constant I/O to dilute it, healthy growth sits AT the linear 4.0 (measured
  // 3.96–4.32 over 450 samples under CPU saturation) rather than the fold's ~1.4,
  // so 8 is the bound that still separates it from the quadratic 16.05.
  //
  // 🔴 The sizes are 8k and 32k, where the old fixtures were 65k and 20k — so
  // this NO LONGER measures a body at the tracker's 64k cap, and the name says
  // 'as it grows' rather than 'at the tracker size limit' for that reason. A
  // name is a coverage claim, and this one had to move with the fixtures.
  // Shrinking them buys sensitivity rather than spending it: a ratio bound at
  // these sizes fires on a quadratic term ~35× smaller than the retired 250 ms
  // budget caught at 20k on this same shape. What it costs is the tail — a
  // defect that only turns superlinear ABOVE 32k is now invisible here, and the
  // reproduced link defect measures 16.07× at these sizes — a second, separate
  // run of the same reproduction as the 16.05× above, not a different
  // measurement — so nothing known
  // lives in that gap.
  it('stays linear on a body as it grows', { timeout: 60_000 }, async () => {
    const { hygieneOf } = await load('core.mjs');
    const shapes: Array<[string, (size: number) => string]> = [
      // the unterminated link is the quadratic shape, and it goes first so a
      // regression is reported before the slower shapes are measured
      ['an unterminated link', (size) => `[x](${' '.repeat(size)}`],
      ['a dependency line before a run of spaces', (size) => `blocked by${' '.repeat(size)}`],
      ['a run of open brackets', (size) => `${'['.repeat(size)}x`],
    ];

    for (const [shape, body] of shapes) {
      staysLinear(
        `hygieneOf on ${shape}`,
        (size) => {
          const item = ticket({ body: body(size) });
          return () => hygieneOf(item);
        },
        { n: 8_192, maxRatio: 8, catastropheMs: 500 },
      );
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
    expect(selection.causes).toEqual(['closed', 'triage', 'blocked', 'trigger-human']);
    // one tag per reason it pushed, and the set stays closed under repetition
    expect(selection.causes).toHaveLength(selection.reasons.length);
    expect(new Set(selection.causes as string[]).size).toBe((selection.causes as string[]).length);
  });

  it('draws every cause from the closed vocabulary, never from free text', async () => {
    const { selectionOf } = await load('core.mjs');
    // 🔴 `trigger` was ONE tag for the two rows below, and the two rows clear by
    // different acts — see "one tag, two mechanisms" in the stop-condition block.
    // A tag the caller COUNTS has to name the mechanism, or a counter grouping by
    // it groups two remedies into one number.
    const VOCABULARY = [
      'closed',
      'in-progress',
      'triage',
      'escalated',
      'blocked',
      'trigger-auto',
      'trigger-human',
    ];
    const cases: Array<[string, Partial<Ticket>]> = [
      ['closed', { state: 'closed' }],
      ['in-progress', { state: 'in-progress' }],
      ['triage', { triage: true }],
      ['escalated', { labels: ['escalated'] }],
      ['blocked', { blockedBy: [{ id: '2', resolved: false }] }],
      ['trigger-human', { trigger: 'human' }],
      ['trigger-auto', { trigger: 'auto' }],
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

// AR3-36: the ration above has never fired between tasks in this repository.
// `selectNext` reads `lastCompletedTier` and `index.mjs` passes it, but
// `.claude/queue.json` has carried only `{"adapter":"plan-md"}` since its first
// commit and NOTHING writes that field — so the filter has been called with
// `null` every time. A filter whose input nobody supplies is indistinguishable
// from a filter that agrees with you, and neither a green suite nor a reading of
// `core.mjs` shows it.
//
// 🔴 **The state does NOT live in `.claude/queue.json`.** That file is composed
// from `templates/agent-os/universal/` and `test/template/dogfood.test.ts` runs
// `sync-agent-os.mjs --check` over it, so a close that writes a field into it
// fails the drift check — observed, not predicted:
//
//     agent-os drift detected in:
//       - .claude/queue.json
//
// The config is a GENERATED file; per-run state cannot live in a generated file.
// So the tier goes in a state file of its own, `.claude/queue.state.json`, which
// the CLI merges over the config when it selects.
//
// The close step is the writer, and it records **the tier the change turned out
// to be, computed from the diff's paths** — not the item's `[elevated]` marker.
// `autonomy.md`: "the tier is decided by what the change touches, not by what
// the task said it would touch". The marker stays advisory; a marker that
// disagrees with the paths is queue hygiene for a human, not an input here.
describe('the close step records the tier the change turned out to be', () => {
  /** What a generated project declares, near enough — never this repo's own list. */
  const DECLARED = ['packages/db/src/', '.claude/', '.github/workflows/'];

  /**
   * A throwaway project root the gate sweep can read: its own `CLAUDE.md` carries
   * the declaration, its `.claude/queue.json` is the (untouched) config, and
   * `.claude/queue.state.json` is where the tier is expected to land.
   *
   * 🔴 Every path here is inside a `mkdtemp` dir. This repository's real
   * `.claude/queue.json` is TRACKED **and generated** — a test that wrote to it
   * would both commit a session's leftover state and fail the drift check.
   */
  const withProject = async (
    config: Record<string, unknown> = { adapter: 'plan-md' },
    declared: string[] = DECLARED,
  ): Promise<{ dir: string; configPath: string; statePath: string }> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tier-'));
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(
      path.join(dir, 'CLAUDE.md'),
      `# P\n\n\`\`\`elevated-paths\n${declared.join('\n')}\n\`\`\`\n`,
    );
    const configPath = path.join(dir, '.claude', 'queue.json');
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    return { dir, configPath, statePath: path.join(dir, '.claude', 'queue.state.json') };
  };

  const jsonAt = async (file: string): Promise<Record<string, unknown>> =>
    JSON.parse(await read(file)) as Record<string, unknown>;

  it('records elevated in the state file when the change crossed a declared path', async () => {
    const { recordCompletedTier } = await load('state.mjs');
    const { dir, statePath } = await withProject();

    // No `statePath` given: the default is the project's own
    // `.claude/queue.state.json`, which is what the close step will call with.
    recordCompletedTier({ changedFiles: ['packages/db/src/schema.ts'], projectRoot: dir });

    expect((await jsonAt(statePath)).lastCompletedTier).toBe('elevated');
  });

  it('records normal when no changed file falls under a declared path', async () => {
    const { recordCompletedTier } = await load('state.mjs');
    const { dir, statePath } = await withProject();

    recordCompletedTier({
      changedFiles: ['services/api/src/handler.ts', 'packages/core/src/todo.ts'],
      projectRoot: dir,
      statePath,
    });

    expect((await jsonAt(statePath)).lastCompletedTier).toBe('normal');
  });

  // 🔴 The regression the drift check caught, pinned so the next change cannot
  // put it back. `.claude/queue.json` is composed from the template; a close that
  // edits it makes every closing PR carry a diff to a generated file and turns
  // `sync-agent-os.mjs --check` red.
  it('leaves the queue config byte-identical, because the config is generated', async () => {
    const { recordCompletedTier } = await load('state.mjs');
    const { dir, configPath, statePath } = await withProject({
      adapter: 'github-issues',
      options: { repo: 'owner/name' },
      triggersFired: { '7': true },
    });
    const before = await read(configPath);

    recordCompletedTier({
      changedFiles: ['packages/db/src/schema.ts'],
      projectRoot: dir,
      statePath,
    });

    expect(await read(configPath)).toBe(before);
    expect(await jsonAt(configPath)).not.toHaveProperty('lastCompletedTier');
  });

  it('keeps the state file to state, not a second copy of the config', async () => {
    const { recordCompletedTier } = await load('state.mjs');
    const { dir, statePath } = await withProject({
      adapter: 'github-issues',
      options: { repo: 'owner/name' },
    });

    recordCompletedTier({
      changedFiles: ['packages/db/src/schema.ts'],
      projectRoot: dir,
      statePath,
    });

    // A state file that carried `adapter` would be a config the sync does not
    // know about: two files answering "which queue is this" and no rule for which
    // wins. The state answers exactly one question.
    const state = await jsonAt(statePath);
    expect(state.lastCompletedTier).toBe('elevated');
    expect(state).not.toHaveProperty('adapter');
    expect(state).not.toHaveProperty('options');
  });

  it('overwrites the tier the previous close left behind', async () => {
    const { recordCompletedTier } = await load('state.mjs');
    // The ration is spacing, not history: only the LAST completed tier decides,
    // so a stale `elevated` that never clears would hold the queue forever.
    const { dir, statePath } = await withProject();
    await writeFile(statePath, `${JSON.stringify({ lastCompletedTier: 'elevated' })}\n`);

    recordCompletedTier({
      changedFiles: ['services/api/src/handler.ts'],
      projectRoot: dir,
      statePath,
    });

    expect((await jsonAt(statePath)).lastCompletedTier).toBe('normal');
  });

  it('reports the tier it wrote and the paths that earned it', async () => {
    const { recordCompletedTier } = await load('state.mjs');
    const { dir, statePath } = await withProject();

    const elevated = recordCompletedTier({
      changedFiles: ['README.md', '.github/workflows/ci.yml', 'packages/db/src/schema.ts'],
      projectRoot: dir,
      statePath,
    });

    // A close that cannot say WHY it wrote `elevated` cannot journal it, and an
    // unexplained tier is the same unfalsifiable claim this item exists to remove.
    expect(elevated.tier).toBe('elevated');
    expect(elevated.elevatedPaths).toEqual([
      '.github/workflows/ci.yml',
      'packages/db/src/schema.ts',
    ]);

    const normal = recordCompletedTier({
      changedFiles: ['services/api/src/handler.ts'],
      projectRoot: dir,
      statePath,
    });
    expect(normal.tier).toBe('normal');
    // `[]` and not `undefined`: "nothing matched" and "nothing was looked at"
    // are opposite facts, and a journal line cannot tell them apart from absence.
    expect(normal.elevatedPaths).toEqual([]);
  });

  // 🔴 The absence case, and it is the whole reason this module refuses instead
  // of defaulting. `normal` is the permissive answer — it lets the next elevated
  // item straight through — so inferring it from "I was given no files" hands the
  // ration back exactly the blind spot AR3-36 is closing, one layer over.
  const noFiles: Array<[string, Record<string, unknown>]> = [
    ['an empty list', { changedFiles: [] }],
    ['no list at all', {}],
    ['a null list', { changedFiles: null }],
    ['something that is not a list', { changedFiles: 'packages/db/src/schema.ts' }],
  ];

  it.each(noFiles)('refuses to write a tier for %s of changed files', async (_kind, over) => {
    const { recordCompletedTier } = await load('state.mjs');
    const { dir, statePath } = await withProject();

    expect(() => recordCompletedTier({ projectRoot: dir, statePath, ...over })).toThrow(
      /changed file/i,
    );

    // and it refuses without leaving a state file behind: an absent file means
    // "nothing has closed yet", which is a true statement here.
    await expect(read(statePath)).rejects.toThrow();
  });

  it('refuses when nothing in the project declares an elevated path at all', async () => {
    const { recordCompletedTier } = await load('state.mjs');
    const dir = await mkdtemp(path.join(tmpdir(), 'tier-'));
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(path.join(dir, 'CLAUDE.md'), '# P\n\nno declaration here.\n');
    const statePath = path.join(dir, '.claude', 'queue.state.json');

    // `readDeclaredPaths` returns `null` rather than `[]` for precisely this, and
    // the difference is load-bearing: with no declaration, "no path matched" means
    // "nothing was checked". Writing `normal` there is a gate declared over a
    // directory that does not exist — it reports clean while looking nowhere.
    expect(() =>
      recordCompletedTier({
        changedFiles: ['packages/db/src/schema.ts'],
        projectRoot: dir,
        statePath,
      }),
    ).toThrow(/elevated[- ]paths|declare/i);
    await expect(read(statePath)).rejects.toThrow();
  });

  it('treats a plain document under a declared path as inert, exactly as the sweep does', async () => {
    const { recordCompletedTier } = await load('state.mjs');
    const { dir, statePath } = await withProject();

    const result = recordCompletedTier({
      changedFiles: ['packages/db/src/NOTES.md'],
      projectRoot: dir,
      statePath,
    });

    expect(result.tier).toBe('normal');
    expect(result.elevatedPaths).toEqual([]);
  });

  it('treats a rulebook under a declared path as an elevated change', async () => {
    const { recordCompletedTier } = await load('state.mjs');
    const { dir, statePath } = await withProject();

    // A `.md` is inert EXCEPT the rulebook — a merge that rewrites the Never list
    // or unwires a hook is the elevated change the whole tier exists for.
    const result = recordCompletedTier({
      changedFiles: ['.claude/rules/autonomy.md'],
      projectRoot: dir,
      statePath,
    });

    expect(result.tier).toBe('elevated');
    expect(result.elevatedPaths).toEqual(['.claude/rules/autonomy.md']);
  });

  it('computes the tier from the same declaration the gate sweep reads', async () => {
    const { recordCompletedTier } = await load('state.mjs');
    const { elevatedPathsIn, readDeclaredPaths } = await load('../detect-missed-gate.mjs');
    const { dir, statePath } = await withProject();
    const changedFiles = [
      'services/api/src/handler.ts',
      '.claude/rules/autonomy.md',
      'packages/db/src/NOTES.md',
      './packages/db/src/schema.ts',
    ];

    const result = recordCompletedTier({ changedFiles, projectRoot: dir, statePath });

    // Delegated, never re-derived. Inertness, the rulebook exception, path
    // normalisation and the union over every declaring layer are one mechanism;
    // a second implementation of them here would disagree with the sweep, and the
    // copy nobody is looking at is the one that would be wrong.
    expect(result.elevatedPaths).toEqual(elevatedPathsIn(changedFiles, readDeclaredPaths(dir)));
    expect(result.elevatedPaths).toEqual([
      '.claude/rules/autonomy.md',
      'packages/db/src/schema.ts',
    ]);
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
      skipped: [...heldBy('spacing', 8), ...heldBy('trigger-auto', 1)],
    });
    expect(String(stop.why)).toMatch(/\b9\b/); // the count of held items
    expect(names(String(stop.why), 8, 'spacing'), String(stop.why)).toBe(true);
    expect(names(String(stop.why), 1, 'trigger-auto'), String(stop.why)).toBe(true);
  });

  it('orders the breakdown by how many are held, then by tag — never by arrival', async () => {
    const { stopConditionOf } = await load('core.mjs');
    const stop = stopConditionOf({
      candidates: 0,
      // deliberately arriving in the opposite order to the one it must print in
      skipped: [...heldBy('spacing', 1), ...heldBy('trigger-auto', 3), ...heldBy('blocked', 3)],
    });
    const at = (tag: string) => String(stop.why).toLowerCase().indexOf(tag);
    expect(
      Math.min(at('blocked'), at('trigger-auto'), at('spacing')),
      String(stop.why),
    ).toBeGreaterThan(-1);
    expect(at('blocked')).toBeLessThan(at('trigger-auto')); // tied at 3, so tag ascending
    expect(at('trigger-auto')).toBeLessThan(at('spacing')); // 3 before 1
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
    // 🔴 `trigger` was one entry and is now two, because it was one tag over two
    // mechanisms with different remedies (see "one tag, two mechanisms" below).
    // Both stay on the HELD side: a `trigger-human` item is real, takeable work,
    // so reporting it as `queue-empty` would tell the owner to refill a queue
    // that is full — the refill-versus-wait inversion this split exists to remove.
    expect(HOLDING_CAUSES).toEqual([
      'blocked',
      'in-progress',
      'spacing',
      'trigger-auto',
      'trigger-human',
    ]);
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
    // 🔴 This was ONE entry — `trigger: /declare|declares/i` — and it is exactly
    // why three revisions of this clause each fixed one sub-case and left the
    // other wrong: one loose word matched a line that named either remedy, so a
    // line naming only the recording command passed while being useless to the
    // half of the pile it did not describe. Two entries, each the remedy for
    // exactly one mechanism, and the check below runs each against a queue held
    // by that tag alone.
    //
    // The auto entry pins the command AS IT IS RUN — interpreter and path — which
    // is how every other occurrence in this layer writes it
    // (`.claude/skills/loop/SKILL.md:134`). A bare `run-state.mjs …` is not a
    // thing an operator can paste.
    'trigger-auto': /node \.claude\/scripts\/run-state\.mjs trigger\b/,
    // What actually frees one: a human changing the item's own marker. Same
    // wording the loop skill already uses, so the two cannot drift apart.
    'trigger-human': /marker|hand(?:s|ed) it over/i,
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

  // --- one tag, two mechanisms -------------------------------------------------
  //
  // `prose-reviewer` found the same clause wrong three rounds running, and the
  // third time diagnosed it as structural rather than editorial: `selectionOf`
  // emitted the cause `trigger` from TWO branches with DIFFERENT remedies.
  //
  //   trigger-auto  — held until `triggersFired[id] === true`; the human declares
  //                   it and the declaration is RECORDED, or the next selection
  //                   holds the item again.
  //   trigger-human — held UNCONDITIONALLY. `triggersFired` is never consulted on
  //                   that path; the only thing that frees it is a human changing
  //                   the item's own marker.
  //
  // One tag collapsed both into `N held by trigger`, so the stop line named one
  // remedy for two mechanisms. Measured end to end on the shipped module: an
  // operator holding a `trigger-human` item runs the command the line names, gets
  // `run state: triggersFired = {"1":true}` and exit 0, then gets back a stop line
  // IDENTICAL to the one before — indefinitely. Under `plan-md` the id is a list
  // POSITION, so that useless record also arms whatever occupies the slot next.
  //
  // 🔴 Why these tests drive real tickets rather than `heldBy`. The check above
  // this one asserted its remedy against a synthetic `heldBy('trigger', 2)`
  // record — a tag chosen by the test, carrying no mechanism — so it could not
  // tell the two apart and no revision of the clause could fail it. The tag has
  // to come from `selectionOf` deciding about a ticket, or the test is checking
  // its own fixture.

  /** The stop line a REAL queue produces, end to end: tickets → selection → stop. */
  const stopLineFor = async (tickets: Ticket[], triggersFired: Record<string, boolean> = {}) => {
    const { selectNext, stopConditionOf } = await load('core.mjs');
    const { candidates, skipped } = selectNext(tickets, { triggersFired });
    const stop = stopConditionOf({ candidates, skipped });
    return { stop, why: String(stop?.why ?? '') };
  };

  /** Named once so a "remedy" and its "must not appear" are the same string. */
  const RECORDING_COMMAND = REMEDY_FOR['trigger-auto']!;
  const HUMAN_MARKER = REMEDY_FOR['trigger-human']!;
  /** Deliberately looser than the remedy: the bare form the clause used to print. */
  const ANY_RECORDING_COMMAND = /run-state\.mjs trigger/i;

  it('names the recording command, in the form an operator can run, for a queue held by a trigger-auto item', async () => {
    const { stop, why } = await stopLineFor([ticket({ id: '1', trigger: 'auto' })]);
    expect(stop?.kind).toBe('nothing-selectable');
    expect(why, 'the trigger-auto remedy').toMatch(RECORDING_COMMAND);
  });

  it('offers no recording command to a queue held by a trigger-human item', async () => {
    const { stop, why } = await stopLineFor([ticket({ id: '1', trigger: 'human' })]);
    expect(stop?.kind).toBe('nothing-selectable');
    // The command is a NO-OP for this item (pinned two tests down). A line that
    // names it hands the operator an action that changes nothing and returns the
    // same line — which is the whole defect, not a wording preference.
    expect(why, 'sends a trigger-human hold to the recording command').not.toMatch(
      ANY_RECORDING_COMMAND,
    );
  });

  it('says what does free a trigger-human item, so the line is not merely silent about it', async () => {
    const { why } = await stopLineFor([ticket({ id: '1', trigger: 'human' })]);
    // Not naming the wrong remedy is half the fix; an operator still has to be
    // told the item waits on a human changing its own marker.
    expect(why, 'the trigger-human remedy').toMatch(HUMAN_MARKER);
  });

  it('offers no human-marker remedy to a queue held by a trigger-auto item', async () => {
    const { why } = await stopLineFor([ticket({ id: '1', trigger: 'auto' })]);
    // The symmetric half, and the one that rules out the other candidate fix: a
    // single sentence naming BOTH remedies passes every test above and still
    // tells this operator to go find a human for an item a recorded declaration
    // releases. The remedy has to follow the pile, not be printed unconditionally.
    expect(why, 'sends a trigger-auto hold to a human').not.toMatch(HUMAN_MARKER);
  });

  it('names both remedies when a queue holds a trigger-auto and a trigger-human item together', async () => {
    const { why } = await stopLineFor([
      ticket({ id: '1', trigger: 'auto' }),
      ticket({ id: '2', trigger: 'human' }),
    ]);
    // Neither one is the whole story here, so neither may be presented as it.
    expect(why, 'the trigger-auto remedy').toMatch(RECORDING_COMMAND);
    expect(why, 'the trigger-human remedy').toMatch(HUMAN_MARKER);
  });

  it('counts the two trigger kinds under separate tags, never as one trigger pile', async () => {
    const { why } = await stopLineFor([
      ticket({ id: '1', trigger: 'auto' }),
      ticket({ id: '2', trigger: 'human' }),
    ]);
    expect(names(why, 1, 'trigger-auto'), why).toBe(true);
    expect(names(why, 1, 'trigger-human'), why).toBe(true);
    // `2 held by trigger` is the collapsed count the operator cannot act on: it
    // is two items and two different acts, reported as one number.
    expect(why, 'the two mechanisms are counted as one pile').not.toMatch(/held by trigger(?!-)/i);
  });

  it('holds a trigger-human item back just the same after its trigger is recorded', async () => {
    const { selectionOf } = await load('core.mjs');
    const human = ticket({ id: '1', trigger: 'human' });
    // The ground truth every test above rests on, pinned so a "fix" cannot make
    // the line honest by making the record work — `triggersFired` must stay
    // unconsulted on this path, or "never self-taken" becomes self-takeable by
    // one CLI call.
    expect(selectionOf(human, { triggersFired: { '1': true } }).eligible).toBe(false);
    const before = await stopLineFor([human], {});
    const after = await stopLineFor([human], { '1': true });
    expect(after.stop?.kind).toBe('nothing-selectable');
    expect(after.why, 'the recorded declaration changed the stop line').toBe(before.why);
  });

  // --- which side wins when ONE record carries both ----------------------------
  //
  // The `code-reviewer` gate on the second half of AR3-35: every test above builds
  // a SINGLE-cause record, so nothing pins the precedence — the reviewer inverted
  // it in `core.mjs` and all 103 tests still passed. And the precedence is not a
  // corner case: it decides the exact record the split was written for.
  //
  // An escalated item never carries `escalated` alone. The loop escalates it and
  // **leaves it claimed** (`.claude/skills/loop/SKILL.md:242`); `escalate` only
  // adds the label (`github-issues.mjs:171-175`, `jira.mjs:263-276`) and only
  // `close` removes `in-progress` (`github-issues.mjs:157`), which is what maps to
  // `state: 'in-progress'` (`github-issues.mjs:62-67`, `jira.mjs:92`). So
  // `selectionOf` emits `['in-progress','escalated']` for every escalated item on
  // both tracker adapters.
  //
  // 🔴 PARKED DOMINATES. A parked cause means the item does not return to play
  // without a human, and that outranks any condition that would clear on its own.
  // Read the other way round, a queue of nothing but escalated items reports
  // "held by in-progress — wait for the other session to finish" about items no
  // session is on, and `queue-empty` is unreachable from the first escalation
  // onwards — the refill-versus-wait inversion again, one layer down.

  /** One skip record carrying exactly the causes given — the multi-cause shape. */
  const skipWith = (id: string, causes: string[]) => ({
    id,
    reason: `skipped: ${causes.join('; ')}`,
    causes,
  });

  /**
   * A parked-only queue must offer NONE of the remedies a held line offers.
   *
   * Drawn from `REMEDY_FOR` rather than written out again: that map is already
   * pinned to exactly `HOLDING_CAUSES` by the test above, so this cannot drift
   * into checking a phrase the held line no longer uses. Deliberately not a bare
   * /wait/ — "those wait on a human" is the parked line's own honest wording, and
   * banning it would drive the implementation to mangle good prose.
   */
  const expectNoHoldingRemedy = (why: string, label: string) => {
    for (const [cause, remedy] of Object.entries(REMEDY_FOR)) {
      expect(why, `${label}: offers the ${cause} remedy`).not.toMatch(remedy);
    }
  };

  it('calls an escalated item that is still claimed parked, not held back', async () => {
    const { stopConditionOf } = await load('core.mjs');
    const stop = stopConditionOf({
      candidates: 0,
      skipped: [skipWith('7', ['in-progress', 'escalated'])],
    });
    expect(stop?.kind).toBe('queue-empty');
    expect(stop?.success).toBe(true);
  });

  it('offers no wait-it-out remedy for a queue of nothing but escalated items', async () => {
    const { stopConditionOf } = await load('core.mjs');
    const stop = stopConditionOf({
      candidates: 0,
      skipped: [skipWith('7', ['in-progress', 'escalated'])],
    });
    // The kind alone would pass an implementation that kept the held prose; this
    // is the half that fails if the precedence is inverted OR simply removed.
    expectNoHoldingRemedy(String(stop.why), 'a queue of nothing but escalated items');
    expect(String(stop.why)).toMatch(/never invent|not an invitation|do not invent/i);
  });

  it('lets a parked cause outrank a holding one whichever order the record carries them in', async () => {
    const { stopConditionOf } = await load('core.mjs');
    const pairs: string[][] = [
      ['in-progress', 'escalated'],
      ['escalated', 'in-progress'],
      ['blocked', 'escalated'],
      ['spacing', 'triage'],
    ];
    for (const causes of pairs) {
      const stop = stopConditionOf({ candidates: 0, skipped: [skipWith('7', causes)] });
      expect(stop?.kind, causes.join('+')).toBe('queue-empty');
      expectNoHoldingRemedy(String(stop.why), causes.join('+'));
    }
  });

  it('still reports held back when a parked record sits beside a genuinely held one', async () => {
    const { stopConditionOf } = await load('core.mjs');
    // Precedence is per RECORD, not per queue: one item nobody can take does not
    // hide another item that a normal landing really would release.
    const stop = stopConditionOf({
      candidates: 0,
      skipped: [skipWith('7', ['in-progress', 'escalated']), ...heldBy('spacing', 2)],
    });
    expect(stop?.kind).toBe('nothing-selectable');
    expect(names(String(stop.why), 2, 'spacing'), String(stop.why)).toBe(true);
    expect(names(String(stop.why), 1, 'parked'), String(stop.why)).toBe(true);
  });

  it('counts a skip it cannot classify as held back, never as parked', async () => {
    const { stopConditionOf } = await load('core.mjs');
    // `core.mjs` claims this in a comment and nothing tested it. Unclassified must
    // read as the answer that STOPS rather than the one that declares the queue
    // drained: an owner told to refill a queue that is actually full acts on a
    // lie, and a filter that grew a new tag is exactly where that lie comes from.
    const unclassified: Array<Record<string, unknown>> = [
      { id: 'a', reason: 'a filter nobody tagged', causes: ['not-a-real-cause'] },
      { id: 'b', reason: 'a filter that tagged nothing', causes: [] },
      { id: 'c', reason: 'a record from before causes existed' },
    ];
    for (const skip of unclassified) {
      const stop = stopConditionOf({ candidates: 0, skipped: [skip] });
      expect(stop?.kind, JSON.stringify(skip)).toBe('nothing-selectable');
    }
  });

  it('names the causes the parked pile actually carries, with their counts', async () => {
    const { stopConditionOf } = await load('core.mjs');
    const stop = stopConditionOf({
      candidates: 0,
      skipped: [...parked('escalated', 2), ...parked('triage', 1)],
    });
    expect(stop?.kind).toBe('queue-empty');
    // "escalated, in triage or closed" is a fixed list: it names the same three
    // whatever the pile holds, so it tells the owner nothing about which one to go
    // and clear. Two escalations and one proposal need two different human acts.
    expect(names(String(stop.why), 2, 'escalated'), String(stop.why)).toBe(true);
    expect(names(String(stop.why), 1, 'triage'), String(stop.why)).toBe(true);
  });

  it('never names a parked cause the pile does not carry', async () => {
    const { stopConditionOf } = await load('core.mjs');
    const stop = stopConditionOf({
      candidates: 0,
      skipped: [...parked('escalated', 2), ...parked('triage', 1)],
    });
    // `closed` is unreachable in practice — every adapter drops closed items
    // before `selectNext` (`github-issues.mjs:138`, `jira.mjs:201`, and plan-md
    // removes the line). A line that names it is describing a pile the owner can
    // never be looking at, while staying silent about the two real ones.
    expect(String(stop.why), 'names a parked cause the pile does not carry').not.toMatch(
      /\bclosed\b/i,
    );
  });

  it('carries the real escalated shape from the ticket through to the stop line', async () => {
    const { selectionOf, selectNext, stopConditionOf } = await load('core.mjs');
    // What `github-issues.mjs` and `jira.mjs` hand up for an item this loop
    // escalated: the label is added, the claim is deliberately left in place.
    const escalated = ticket({
      id: '7',
      state: 'in-progress',
      labels: ['in-progress', 'escalated'],
    });

    expect(selectionOf(escalated).causes).toEqual(['in-progress', 'escalated']);

    const result = selectNext([escalated], {});
    expect(result.candidates).toBe(0);
    expect((result.skipped as Array<{ causes: string[] }>).map((s) => s.causes)).toEqual([
      ['in-progress', 'escalated'],
    ]);

    const stop = stopConditionOf({ candidates: result.candidates, skipped: result.skipped });
    expect(stop?.kind).toBe('queue-empty');
    expectNoHoldingRemedy(String(stop.why), 'the escalated shape end to end');
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
  //
  // Bounds GROWTH, not milliseconds: this is the test CI failed at 328ms on ~0.1ms
  // of real work, and the whole diagnosis is at the top of this file.
  // The sizes are 4k/16k rather than the old 65k: a scaling claim needs a PAIR of
  // sizes, not the biggest one, and the pair already separates healthy 1.39 from
  // quadratic 16.5 while keeping a red run legible in seconds instead of minutes.
  //
  // 🔴 **Count two detectors here, not three.** All three original shapes are
  // kept, but the trailing-newline one CANNOT fail on the defect described
  // above: a newline after the run is what makes that spelling fast ("0s the
  // moment a newline appears after the run"), so it measures ~1.0× broken and
  // ~1.13× healthy. Against the known defect it contributes nothing, and it is
  // here as a detector of the opposite polarity — a future defect that is slow
  // precisely WHEN a line terminator follows the run. That is worth keeping and
  // is not what the shape's history suggests, so it is stated rather than left
  // for a reader to count coverage they do not have.
  //
  // One measurement bias, known and left alone: the three shapes share one plan
  // file, so the `4n` reading scans a few more bullets than the `n` reading did.
  // It pushes the ratio UP — toward a false red, the harmless direction — and
  // measures as nil (1.10–1.32 against a bound of 6). A fresh plan per size
  // would remove the term and cost more machinery than the term is worth.
  it('folds a field onto one line in linear time', { timeout: 60_000 }, async () => {
    const { proposeTriage } = await load('plan-md.mjs');
    const planPath = await withPlan();
    const shapes: Array<[string, (size: number) => string]> = [
      ['a run of spaces', (size) => ' '.repeat(size)],
      ['a run of tabs before a non-space', (size) => `${'\t'.repeat(size)}x`],
      ['a run of spaces before a newline', (size) => `${' '.repeat(size)}\n`],
    ];
    let nonce = 0;

    for (const [shape, whitespace] of shapes) {
      staysLinear(
        `proposeTriage folding ${shape}`,
        (size) => {
          const run = whitespace(size);
          return () => {
            nonce += 1;
            // Only a NEW proposal is folded — an increment rewrites a counter and
            // never builds a bullet — so every call carries its own fingerprint,
            // and this checks that rather than trusting it. A deduped call would
            // time the wrong code path and report a flat, meaningless ratio.
            const result = proposeTriage(
              { finding: `fold ${nonce} ${run}`, part: 'p', change: 'c', proof: 'pr' },
              { planPath },
            );
            if (!result.filed) throw new Error('deduped, so nothing was folded');
          };
        },
        { n: 4_096, maxRatio: 6, catastropheMs: 500 },
      );
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

  // AR3-36 end to end, and this fixture IS the item. A test asserting that a
  // field was written proves the writer runs, not that the ration fires — the
  // same existence-shaped proof that let `lastCompletedTier` sit unwritten
  // through every green run since the first commit. So the close writes the
  // state file, and the CLI is then asked for work the way a session asks.
  //
  // 🔴 **Where the CLI looks for the state, and why it is derived from
  // `--config`.** The state file is the config path with `.json` swapped for
  // `.state.json` — in a real project `.claude/queue.json` → `.claude/queue.state.json`,
  // which is exactly the default `recordCompletedTier` writes to. It is NOT
  // resolved from the script's own location the way `projectRoot` is: this
  // repository's own state file is gitignored and may exist on any machine, and a
  // CLI that read it while a test pointed `--config` at a temp dir would let a
  // developer's leftover tier decide the run. Config and state travel as a pair.

  /** A project whose whole Agent queue is elevated — this repository's own shape. */
  const allElevated = async (
    config: Record<string, unknown> = { adapter: 'plan-md' },
  ): Promise<{ dir: string; configPath: string; statePath: string }> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'queue-'));
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(
      path.join(dir, 'PLAN.md'),
      '# P\n\n## Agent queue\n\n- rotate the key [elevated]\n- migrate the store [elevated]\n\n## Journal\n',
    );
    await writeFile(
      path.join(dir, 'CLAUDE.md'),
      '# P\n\n```elevated-paths\npackages/db/src/\n.claude/\n```\n',
    );
    const configPath = path.join(dir, '.claude', 'queue.json');
    await writeFile(configPath, JSON.stringify(config));
    return { dir, configPath, statePath: path.join(dir, '.claude', 'queue.state.json') };
  };

  it('holds an all-elevated queue back once a close has recorded an elevated change', async () => {
    const { recordCompletedTier } = await load('state.mjs');
    const { dir, configPath } = await allElevated();
    const configBefore = await read(configPath);

    recordCompletedTier({ changedFiles: ['packages/db/src/schema.ts'], projectRoot: dir });

    const result = await run(['next', '--json', '--config', configPath], dir);

    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.out) as {
      ticket: Ticket | null;
      skipped: Array<{ id: string; reason: string; causes: string[] }>;
      stop: { kind: string; why: string } | null;
    };
    // Observed before this item: the CLI hands `rotate the key` straight back,
    // because nothing ever wrote the value the ration reads.
    expect(parsed.ticket).toBeNull();
    expect(parsed.skipped.map((s) => s.causes)).toEqual([['spacing'], ['spacing']]);
    for (const skip of parsed.skipped) expect(skip.reason).toMatch(/back to back|spacing/i);
    expect(parsed.stop?.kind).toBe('nothing-selectable');
    // …and the ration fired WITHOUT the close touching the generated config.
    // Without this line the whole fixture passes against a close that writes
    // into `.claude/queue.json` — the design the drift check rejected.
    expect(await read(configPath)).toBe(configBefore);
  });

  it('hands an elevated item straight back once a close has recorded a normal change', async () => {
    const { recordCompletedTier } = await load('state.mjs');
    const { dir, configPath, statePath } = await allElevated();
    // Seeded held-back, so this proves the record CLEARED the ration rather than
    // proving that nothing was written at all — the two look identical from an
    // empty starting state, and only one of them is the behaviour wanted.
    await writeFile(statePath, `${JSON.stringify({ lastCompletedTier: 'elevated' })}\n`);

    recordCompletedTier({ changedFiles: ['services/api/src/handler.ts'], projectRoot: dir });

    const result = await run(['next', '--json', '--config', configPath], dir);

    // The other direction, so a constant that always says `elevated` cannot pass:
    // spacing rations elevated work, it does not stop it.
    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.out) as { ticket: Ticket | null };
    expect(parsed.ticket?.title).toBe('rotate the key');
  });

  it('selects normally when no item has closed yet and there is no state file', async () => {
    const { dir, configPath, statePath } = await allElevated();

    // A missing state file is the normal state of a fresh checkout, not an error:
    // nothing has closed, so nothing is being rationed against. Refusing here
    // would make a clone unable to take its first item.
    await expect(read(statePath)).rejects.toThrow();
    const result = await run(['next', '--json', '--config', configPath], dir);

    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.out) as { ticket: Ticket | null };
    expect(parsed.ticket?.title).toBe('rotate the key');
  });

  it('lets the recorded state outrank a tier left behind in the config', async () => {
    // The config is a generated file; if a `lastCompletedTier` is ever in one —
    // a hand edit, an older rig, a merge — the state file is the live value and
    // wins. Two sources disagreeing silently is how the ration goes quiet again.
    const { dir, configPath, statePath } = await allElevated({
      adapter: 'plan-md',
      lastCompletedTier: 'normal',
    });
    await writeFile(statePath, `${JSON.stringify({ lastCompletedTier: 'elevated' })}\n`);

    const result = await run(['next', '--json', '--config', configPath], dir);

    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.out) as { ticket: Ticket | null; stop: { kind: string } };
    expect(parsed.ticket).toBeNull();
    expect(parsed.stop?.kind).toBe('nothing-selectable');
  });

  it('still reads the config for everything the state does not carry', async () => {
    // The state is merged OVER the config, not swapped for it: `adapter` and
    // `options` still come from the config, so a project whose queue lives
    // somewhere other than PLAN.md keeps working once a close has recorded a tier.
    const { dir, configPath, statePath } = await allElevated({
      adapter: 'plan-md',
      options: { planPath: 'docs/QUEUE.md' },
    });
    await mkdir(path.join(dir, 'docs'), { recursive: true });
    await writeFile(
      path.join(dir, 'docs', 'QUEUE.md'),
      '# P\n\n## Agent queue\n\n- take the elsewhere item\n\n## Journal\n',
    );
    await writeFile(statePath, `${JSON.stringify({ lastCompletedTier: 'normal' })}\n`);

    const result = await run(['next', '--json', '--config', configPath], dir);

    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.out) as { ticket: Ticket | null };
    expect(parsed.ticket?.title).toBe('take the elsewhere item');
  });

  // 🔴 Refuse, do not shrug. A state file that exists and does not parse leaves
  // the tier UNKNOWN, and the silent reading of unknown is `null` — the
  // permissive value that lets the next elevated item through. That is the exact
  // failure AR3-36 exists to end, so it may not be how a corrupt file behaves.
  // `loadConfig` already takes this line for the config, and the recovery here is
  // cheaper still: the file is per-checkout scratch, so deleting it is safe and
  // the message has to say so.
  it('refuses to select on a state file that exists and does not parse', async () => {
    const { dir, configPath, statePath } = await allElevated();
    await writeFile(statePath, '{"lastCompletedTier": "elevated",}\n');

    const result = await run(['next', '--json', '--config', configPath], dir);

    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/queue\.state\.json/);
    expect(result.out).toMatch(/json/i);
    expect(result.out).toMatch(/delete|remove/i);
  });

  it('reads the state beside whichever config it was pointed at', async () => {
    // The pairing rule, pinned on a non-default config name so the implementation
    // cannot satisfy it by hardcoding `.claude/queue.state.json`.
    const { dir } = await allElevated();
    await mkdir(path.join(dir, 'nest'), { recursive: true });
    const configPath = path.join(dir, 'nest', 'custom.json');
    await writeFile(configPath, JSON.stringify({ adapter: 'plan-md' }));
    await writeFile(
      path.join(dir, 'nest', 'custom.state.json'),
      `${JSON.stringify({ lastCompletedTier: 'elevated' })}\n`,
    );

    const result = await run(['next', '--json', '--config', configPath], dir);

    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.out) as { ticket: Ticket | null; stop: { kind: string } };
    expect(parsed.ticket).toBeNull();
    expect(parsed.stop?.kind).toBe('nothing-selectable');
  });

  // 🔴 The refusal above guards JSON SYNTAX only, and syntax is the one way a
  // state file goes wrong that nobody has ever produced by hand. Every other way
  // is permissive: `core.mjs` compares the tier with `===`, so anything that is
  // not exactly `'elevated'` reads as "no elevated item closed", which is the
  // value the whole seam exists to stop being guessed. Probed against this CLI on
  // an all-elevated queue, each row below handed out `rotate the key`.
  const WRONG_SHAPES: Array<[string, string]> = [
    ['a tier in the wrong case', '{"lastCompletedTier":"Elevated"}'],
    ['a tier outside the vocabulary', '{"lastCompletedTier":"tier-2"}'],
    ['a tier that is not a string at all', '{"lastCompletedTier":2}'],
    ['a bare string where the object belongs', '"elevated"'],
    ['an array where the object belongs', '["elevated"]'],
    ['a number where the object belongs', '123'],
    ['null where the object belongs', 'null'],
  ];

  it.each(WRONG_SHAPES)('refuses to select on a state file that is %s', async (_kind, body) => {
    const { dir, configPath, statePath } = await allElevated();
    await writeFile(statePath, `${body}\n`);

    const result = await run(['next', '--json', '--config', configPath], dir);

    expect(result.code, result.out).toBe(1);
    // the refusal has to name the file, because the recovery is to delete it
    expect(result.out).toMatch(/queue\.state\.json/);
    // …and it is the crafted refusal, not a deref that happened to throw. `null`
    // exits 1 today too — with a raw TypeError stack, which tells the operator
    // nothing about which file to delete.
    expect(result.out).not.toMatch(/TypeError|\bat .*index\.mjs/);
    // the fact under all of it: no elevated item was handed out
    expect(result.out).not.toMatch(/rotate the key|migrate the store/);
  });

  it('selects on a state object that simply has no tier yet', async () => {
    // The boundary in the other direction, so "refuse everything" cannot pass:
    // an object with no `lastCompletedTier` is a state file that exists and says
    // nothing has closed — true after a write that recorded some later field.
    const { dir, configPath, statePath } = await allElevated();
    await writeFile(statePath, '{}\n');

    const result = await run(['next', '--json', '--config', configPath], dir);

    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.out) as { ticket: Ticket | null };
    expect(parsed.ticket?.title).toBe('rotate the key');
  });

  // 🔴 Finding A, end to end: "the file is not there" and "the file is there and
  // I could not read it" are opposite facts, and the bare `catch` reads both as
  // the first one — silently, with the permissive tier.
  it('refuses to select when the state path exists but cannot be read', async () => {
    const { dir, configPath, statePath } = await allElevated();
    // A directory at the state path: EISDIR, which is what a container run under
    // another uid, a stray `mkdir`, or a synced folder leaves behind.
    await mkdir(statePath, { recursive: true });

    const result = await run(['next', '--json', '--config', configPath], dir);

    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/queue\.state\.json/);
    expect(result.out).not.toMatch(/rotate the key|migrate the store/);
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

// 🔴 `loadState` is where the reader decides what "nothing has closed yet" means,
// and its own docstring states the rule the code does not keep: *missing* is not
// an error, *present and unreadable* is. Today the read is wrapped in a bare
// `catch` that answers `{}` to every failure — a permission error, a directory at
// the path, a file owned by another uid — so the tier reads `null`, which is the
// permissive value. The parse branch below it keeps the promise; the read branch
// silently breaks it.
describe('reading the state — only a truly absent file means "nothing has closed"', () => {
  /**
   * The refusal a call produced, or a sentence saying it produced none.
   *
   * A returned `{}` is the defect itself, so it must read as a failure with the
   * value in it rather than as a missing exception.
   */
  const refusalOf = (call: () => unknown): string => {
    try {
      return `no refusal — returned ${JSON.stringify(call())}`;
    } catch (error) {
      return String((error as Error)?.message ?? error);
    }
  };

  const scratch = async (): Promise<string> => mkdtemp(path.join(tmpdir(), 'state-'));

  it('reads an absent state file as an empty state, because a fresh checkout has none', async () => {
    const { loadState } = await load('index.mjs');
    const dir = await scratch();
    // The one case that may stay silent: nothing has closed here yet.
    expect(loadState(path.join(dir, '.claude', 'queue.state.json'))).toEqual({});
  });

  it('reads a state path whose parent is not a directory as absent too', async () => {
    const { loadState } = await load('index.mjs');
    const dir = await scratch();
    await writeFile(path.join(dir, 'notadir'), 'x\n');
    // ENOTDIR: the whole path cannot exist, so no state was ever written there.
    expect(loadState(path.join(dir, 'notadir', 'queue.state.json'))).toEqual({});
  });

  it('refuses a state file it is not allowed to read instead of reading it as absent', async () => {
    const { loadState } = await load('index.mjs');
    const dir = await scratch();
    const statePath = path.join(dir, 'queue.state.json');
    await writeFile(statePath, `${JSON.stringify({ lastCompletedTier: 'elevated' })}\n`);
    await chmod(statePath, 0o000);
    // Stated as a precondition, not assumed: a run that could read it anyway
    // (root) is not exercising this behaviour and must say so rather than pass.
    await expect(readFile(statePath, 'utf8')).rejects.toThrow(/EACCES|EPERM/);

    expect(refusalOf(() => loadState(statePath))).toContain(statePath);
  });

  it('refuses a directory sitting where the state file belongs', async () => {
    const { loadState } = await load('index.mjs');
    const dir = await scratch();
    const statePath = path.join(dir, 'queue.state.json');
    await mkdir(statePath);

    expect(refusalOf(() => loadState(statePath))).toContain(statePath);
  });

  // 🔴 The shape check belongs to the reader and not to the selector: `core.mjs`
  // compares with `===`, so every value below is silently equal to "no elevated
  // item has closed". A tier that cannot be trusted has to stop the run, exactly
  // as an unparseable one does.
  const REFUSED: Array<[string, string]> = [
    ['a tier in the wrong case', '{"lastCompletedTier":"Elevated"}'],
    ['a tier outside the closed vocabulary', '{"lastCompletedTier":"tier-2"}'],
    ['a tier that is not a string', '{"lastCompletedTier":7}'],
    ['a bare string', '"elevated"'],
    ['an array', '["elevated"]'],
    ['a number', '123'],
    ['a JSON null', 'null'],
  ];

  it.each(REFUSED)('refuses a state file holding %s', async (_kind, body) => {
    const { loadState } = await load('index.mjs');
    const dir = await scratch();
    const statePath = path.join(dir, 'queue.state.json');
    await writeFile(statePath, `${body}\n`);

    const message = refusalOf(() => loadState(statePath));
    expect(message).toContain(statePath);
    // a crafted refusal, not whatever the first dereference happened to throw
    expect(message).not.toMatch(/Cannot read propert|is not a function/i);
  });

  const ACCEPTED: Array<[string, string, unknown]> = [
    ['the elevated tier', '{"lastCompletedTier":"elevated"}', 'elevated'],
    ['the normal tier', '{"lastCompletedTier":"normal"}', 'normal'],
    ['an object that carries no tier at all', '{}', undefined],
  ];

  it.each(ACCEPTED)('accepts a state file holding %s', async (_kind, body, tier) => {
    const { loadState } = await load('index.mjs');
    const dir = await scratch();
    const statePath = path.join(dir, 'queue.state.json');
    await writeFile(statePath, `${body}\n`);

    expect((loadState(statePath) as { lastCompletedTier?: unknown }).lastCompletedTier).toBe(tier);
  });
});

// 🔴 The writer and the reader must agree about WHICH CHECKOUT they are in, and
// today they do not. The close snippet passes `projectRoot: process.cwd()` and the
// writer resolves the state file from that; the CLI resolves the project root from
// the script's own location. Both answers are "the worktree" when a task runs in
// one — which `worktree-task` prescribes for exactly the unattended runs this
// ration exists for — and `git worktree remove` then deletes the recorded tier.
// Reproduced: the next selection rations on `null` and hands out a second elevated
// item, which is the defect AR3-36 exists to close.
//
// The state file belongs to the checkout, not to the worktree: one repository has
// one "what closed last", because the ration is over the repository's own history
// of merges. `git rev-parse --path-format=absolute --git-common-dir` answers
// `<main>/.git` from anywhere inside either, and its parent is the root.
describe('the queue state belongs to the checkout, so a worktree writes where the checkout reads', () => {
  // 🔴 The location variables are stripped, through the SHARED sanitiser rather
  // than a copy of its rule. A git hook exports `GIT_INDEX_FILE` and `GIT_DIR`
  // as paths RELATIVE to the repository it fired in, so a child `git` run with a
  // different cwd resolves them against the wrong root: under pre-commit these
  // tests died on `fatal: .git/index: index file open failed: Not a directory`
  // while `pnpm test` from a shell was green. This repo has the scar already —
  // NOTES.md's GIT_DIR incident, 19 junk commits across two branches.
  const cleanEnv = withoutGitLocation();

  const git = (args: string[], cwd: string): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile('git', args, { cwd, env: cleanEnv }, (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args.join(' ')} failed: ${stderr || stdout}`));
        else resolve(stdout.trim());
      });
    });

  const runScript = (
    script: string,
    args: string[],
    cwd: string,
  ): Promise<{ code: number; out: string }> =>
    new Promise((resolve) => {
      // Same reason as `git` above: the script shells out to git itself, so an
      // inherited GIT_DIR would point it at the repository the hook fired in.
      execFile(
        process.execPath,
        [script, ...args],
        { cwd, env: cleanEnv },
        (error, stdout, stderr) => {
          resolve({
            code: error ? ((error as { code?: number }).code ?? 1) : 0,
            out: stdout + stderr,
          });
        },
      );
    });

  const loadFrom = (file: string) => import(pathToFileURL(file).href);
  const queueScript = (root: string, file: string) =>
    path.join(root, '.claude', 'scripts', 'queue', file);
  const stateFile = (root: string) => path.join(root, '.claude', 'queue.state.json');

  /**
   * A real checkout with a linked worktree, shaped like a generated project: the
   * queue scripts are IN the tree (as they are in a rig), so the CLI's own
   * location is inside whichever checkout it was started from — which is the
   * whole point of the fixture.
   */
  const checkoutWithWorktree = async (): Promise<{ main: string; worktree: string }> => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'checkout-')));
    const main = path.join(dir, 'main');
    await mkdir(main, { recursive: true });
    await git(['init', '-b', 'main'], main);
    await cp(path.join(universal, '.claude', 'scripts'), path.join(main, '.claude', 'scripts'), {
      recursive: true,
    });
    await writeFile(
      path.join(main, 'PLAN.md'),
      '# P\n\n## Agent queue\n\n- rotate the key [elevated]\n- migrate the store [elevated]\n\n## Journal\n',
    );
    await writeFile(
      path.join(main, 'CLAUDE.md'),
      '# P\n\n```elevated-paths\npackages/db/src/\n.claude/\n```\n',
    );
    await writeFile(path.join(main, '.claude', 'queue.json'), '{"adapter":"plan-md"}\n');
    await git(['add', '-A'], main);
    await git(
      ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-m', 'seed'],
      main,
    );
    const worktree = path.join(main, '.claude', 'worktrees', 'task-1');
    await git(['worktree', 'add', '-b', 'task-1', worktree], main);
    return { main, worktree };
  };

  it('records a close made inside a worktree into the main checkout', async () => {
    const { main, worktree } = await checkoutWithWorktree();
    const { recordCompletedTier } = await loadFrom(queueScript(worktree, 'state.mjs'));

    // Exactly what the close snippet does from a task worktree: `process.cwd()`.
    recordCompletedTier({ changedFiles: ['packages/db/src/schema.ts'], projectRoot: worktree });

    expect(JSON.parse(await read(stateFile(main))).lastCompletedTier).toBe('elevated');
    // and nothing is left in the worktree, which is about to be deleted
    await expect(read(stateFile(worktree))).rejects.toThrow();
  }, 20_000);

  it('still holds the ration after the worktree that recorded the tier has been removed', async () => {
    const { main, worktree } = await checkoutWithWorktree();
    const { recordCompletedTier } = await loadFrom(queueScript(worktree, 'state.mjs'));
    recordCompletedTier({ changedFiles: ['packages/db/src/schema.ts'], projectRoot: worktree });

    // The lifecycle `worktree-task` prescribes: the worktree goes away after
    // the merge. Observed before this item: the recorded tier went with it.
    await git(['worktree', 'remove', '--force', worktree], main);

    const result = await runScript(queueScript(main, 'index.mjs'), ['next', '--json'], main);

    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.out) as {
      ticket: Ticket | null;
      stop: { kind: string } | null;
    };
    expect(parsed.ticket).toBeNull();
    expect(parsed.stop?.kind).toBe('nothing-selectable');
  }, 20_000);

  it('reads the tier the main checkout recorded when the next task runs in a worktree', async () => {
    const { main, worktree } = await checkoutWithWorktree();
    const { recordCompletedTier } = await loadFrom(queueScript(main, 'state.mjs'));
    recordCompletedTier({ changedFiles: ['packages/db/src/schema.ts'], projectRoot: main });

    // The other direction, and the one an unattended loop hits every time: the
    // CLI is started from inside the fresh worktree, which has no state of its
    // own and never will.
    const result = await runScript(
      queueScript(worktree, 'index.mjs'),
      ['next', '--json'],
      worktree,
    );

    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.out) as {
      ticket: Ticket | null;
      stop: { kind: string } | null;
    };
    expect(parsed.ticket).toBeNull();
    expect(parsed.stop?.kind).toBe('nothing-selectable');
  }, 20_000);

  it('writes exactly where an explicit statePath says, even from inside a worktree', async () => {
    const { main, worktree } = await checkoutWithWorktree();
    const { recordCompletedTier } = await loadFrom(queueScript(worktree, 'state.mjs'));
    const explicit = path.join(worktree, 'scratch.state.json');

    // The escape hatch is not re-resolved: a caller that names a path gets that
    // path, which is what keeps a test (or a temp config) off the real state.
    recordCompletedTier({
      changedFiles: ['packages/db/src/schema.ts'],
      projectRoot: worktree,
      statePath: explicit,
    });

    expect(JSON.parse(await read(explicit)).lastCompletedTier).toBe('elevated');
    await expect(read(stateFile(main))).rejects.toThrow();
  }, 20_000);

  it('reads the state beside an explicit --config and never the checkout it is standing in', async () => {
    const { main, worktree } = await checkoutWithWorktree();
    const { recordCompletedTier } = await loadFrom(queueScript(main, 'state.mjs'));
    recordCompletedTier({ changedFiles: ['packages/db/src/schema.ts'], projectRoot: main });
    // A config of its own, with no state file beside it: the pair is the config
    // the caller named, so the checkout's own recorded tier must not leak in.
    const configPath = path.join(worktree, 'nest', 'custom.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, '{"adapter":"plan-md"}\n');

    const result = await runScript(
      queueScript(worktree, 'index.mjs'),
      ['next', '--json', '--config', configPath],
      worktree,
    );

    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.out) as { ticket: Ticket | null };
    expect(parsed.ticket?.title).toBe('rotate the key');
  }, 20_000);

  // `mainCheckoutRoot` is now the single resolver BOTH sides go through — the
  // writer in `state.mjs` and the reader in `index.mjs` — and every test above
  // reaches it only through one of them. Its own contract needs pinning
  // directly, failures included: a resolver that answers `startDir` for a reason
  // it never names is a resolver that quietly writes the tier into the worktree
  // again, and the next selection rations on `null`.
  describe('mainCheckoutRoot — the one answer to "which checkout is this"', () => {
    type Resolver = (startDir: string) => string;
    const resolver = async (): Promise<Resolver> =>
      (await load('checkout.mjs')).mainCheckoutRoot as Resolver;

    const scratch = async (prefix: string): Promise<string> =>
      realpath(await mkdtemp(path.join(tmpdir(), prefix)));

    /**
     * A `git` on PATH that answers however the test needs — the only portable way
     * to construct a git failure that is NOT "there is no repository here",
     * short of owning a directory git refuses to read.
     *
     * `null` installs no binary at all, which is the "git is not installed" case.
     * PATH is restored in `finally`: every other test in this file spawns git.
     */
    const withStubGit = async (script: string | null, body: () => void): Promise<void> => {
      const bin = await scratch('stub-git-');
      if (script !== null) {
        await writeFile(path.join(bin, 'git'), script);
        await chmod(path.join(bin, 'git'), 0o755);
      }
      const original = process.env['PATH'];
      process.env['PATH'] = bin;
      try {
        body();
      } finally {
        if (original === undefined) delete process.env['PATH'];
        else process.env['PATH'] = original;
      }
    };

    it('answers the checkout root when asked from the checkout itself', async () => {
      const { main } = await checkoutWithWorktree();
      expect((await resolver())(main)).toBe(main);
    }, 20_000);

    it('answers the MAIN checkout root when asked from a linked worktree', async () => {
      const { main, worktree } = await checkoutWithWorktree();
      expect((await resolver())(worktree)).toBe(main);
    }, 20_000);

    it('answers the same from a subdirectory of either', async () => {
      const { main, worktree } = await checkoutWithWorktree();
      const resolve = await resolver();
      expect(resolve(path.join(main, '.claude'))).toBe(main);
      expect(resolve(path.join(worktree, '.claude'))).toBe(main);
    }, 20_000);

    // The permissive answer is right for exactly one failure — a queue works
    // fine in a plain directory — and the docstring promises only this one.
    it('falls back to the directory it was given when nothing above it is a repository', async () => {
      const plain = await scratch('plain-');
      expect((await resolver())(plain)).toBe(plain);
    });

    /**
     * A `git` that translates its own messages, the way the real one does.
     *
     * It answers by locale rather than always in French on purpose: a fix that
     * forces the child's message locale passes this, and a fix that teaches the
     * classifier one more language still fails it — the second is the one that
     * breaks again on the next translation.
     *
     * The stub stands in for an installed locale because no runner is
     * guaranteed to have one. CI runs under C, which is exactly why CI cannot
     * see this defect at all.
     */
    const localisedGit =
      '#!/bin/sh\n' +
      'case "${LC_ALL:-${LC_MESSAGES:-${LANG:-C}}}" in\n' +
      '  C|POSIX) echo "fatal: not a git repository (or any of the parent directories): .git" >&2 ;;\n' +
      '  *) echo "fatal : ni ceci ni aucun de ses répertoires parents n\'est un dépôt git : .git" >&2 ;;\n' +
      'esac\n' +
      'exit 128\n';

    // The same fallback, asked in another language. `withoutGitLocation` keeps
    // `LC_ALL`/`LANG` deliberately — it strips repository *location* and
    // nothing else — so the child speaks whatever the developer's shell speaks,
    // and a classifier reading git's English text stops recognising the one
    // failure it is allowed to be permissive about. Measured on git 2.47.1:
    //   fr_FR.UTF-8  fatal : ni ceci ni aucun de ses répertoires parents n'est
    //                un dépôt git : .git
    //   ru_RU.UTF-8  fatal: не найден git репозиторий (или один из родительских
    //                каталогов): .git
    // Every `next` without `--config` goes through here, so the cost is a hard
    // refusal from the queue CLI for anyone whose shell is not English.
    it('falls back whatever language git refuses in', async () => {
      const plain = await scratch('translated-');
      const resolve = await resolver();
      const saved: Record<string, string | undefined> = {
        LC_ALL: process.env['LC_ALL'],
        LANGUAGE: process.env['LANGUAGE'],
      };
      process.env['LC_ALL'] = 'fr_FR.UTF-8';
      process.env['LANGUAGE'] = 'fr';
      try {
        await withStubGit(localisedGit, () => {
          expect(resolve(plain)).toBe(plain);
        });
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });

    it('falls back when git is not installed at all', async () => {
      const anywhere = await scratch('no-git-');
      const resolve = await resolver();
      await withStubGit(null, () => {
        expect(resolve(anywhere)).toBe(anywhere);
      });
    });

    // The other failures are not "you are not in a repository": a broken binary,
    // a git too old for `--path-format`, a checkout git refuses to read. Each is
    // a question that could not be answered, and answering it anyway — with the
    // stderr discarded — is how the tier ends up written to the wrong file with
    // nothing on stdout to say so.
    it('refuses to answer when git failed for a reason other than "no repository here"', async () => {
      const dir = await scratch('dubious-');
      const resolve = await resolver();
      await withStubGit(
        '#!/bin/sh\n' +
          'echo "fatal: detected dubious ownership in repository at \'/work\'" >&2\n' +
          'exit 128\n',
        () => {
          expect(() => resolve(dir)).toThrow(/dubious ownership/i);
        },
      );
    });

    /**
     * The environment the child git actually received, name → value.
     *
     * 🔴 **It refuses a capture that measured nothing, and that guard is the
     * helper's job rather than a nicety.** Every assertion below is a lookup in
     * this map, so an empty dump makes "the locating variables were withheld"
     * pass while no git was ever spawned. That vacuous pass happened here, and
     * it was caught only because a sibling test read the same dump and failed
     * — a sibling test is not a guard, and deleting or renaming it brings the
     * vacuum straight back.
     *
     * `capture` is a parameter for one reason: so the refusal itself can be
     * tested. Callers leave it alone.
     */
    const envHandedToGit = async (
      capture: (file: string) => string = (file) =>
        // 🔴 `/usr/bin/env` by absolute path. PATH is the stub directory and
        // nothing else, so a bare `env` is not found and the dump stays empty.
        `/usr/bin/env > ${JSON.stringify(file)}`,
    ): Promise<Map<string, string>> => {
      const dir = await scratch('child-env-');
      const dump = path.join(dir, 'env.txt');
      const resolve = await resolver();
      const injected: Record<string, string> = {
        // these CONFIGURE git — how a container or CI injects `safe.directory`
        GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: dir,
        // and these LOCATE a repository, which is the whole hazard
        GIT_DIR: '/elsewhere/.git',
        GIT_WORK_TREE: '/elsewhere',
        GIT_INDEX_FILE: '.git/index',
        // the developer's shell, which decides which language git answers in
        LC_ALL: 'fr_FR.UTF-8',
        LANGUAGE: 'fr',
      };
      Object.assign(process.env, injected);
      try {
        await withStubGit(
          `#!/bin/sh\n${capture(dump)}\n` +
            `printf '%s\\n' ${JSON.stringify(path.join(dir, '.git'))}\n`,
          () => {
            resolve(dir);
          },
        );
      } finally {
        for (const key of Object.keys(injected)) delete process.env[key];
      }
      const received = new Map<string, string>();
      for (const line of (await read(dump)).split('\n')) {
        const at = line.indexOf('=');
        if (at > 0) received.set(line.slice(0, at), line.slice(at + 1));
      }
      if (!received.has('PATH') || received.size < 4) {
        throw new Error(
          `the child-environment probe captured nothing usable (${received.size} entries): ` +
            'every assertion built on it would pass vacuously',
        );
      }
      return received;
    };

    /** The environment the child git actually received, by name. */
    const namesHandedToGit = async (): Promise<Set<string>> =>
      new Set((await envHandedToGit()).keys());

    it('the child-environment probe refuses a capture that measured nothing', async () => {
      await expect(envHandedToGit((file) => `: > ${JSON.stringify(file)}`)).rejects.toThrow(
        /captured nothing usable/i,
      );
    });

    // Pinned at the process boundary because the behavioural test above admits
    // two fixes and only one of them survives the next translation: force the
    // child's message locale, or teach the classifier French. `LC_ALL` is the
    // variable that has to carry it — the caller's own `LC_ALL` would override
    // anything narrower.
    it('asks git for its failures in a language it can classify', async () => {
      expect((await envHandedToGit()).get('LC_ALL')).toBe('C');
    });

    it('hands git the variables that configure it', async () => {
      const received = await namesHandedToGit();
      for (const key of [
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_VALUE_0',
      ]) {
        expect(
          received.has(key),
          `${key} must survive: it configures git, it locates nothing`,
        ).toBe(true);
      }
    });

    it('withholds every variable that locates a repository', async () => {
      const received = await namesHandedToGit();
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
        expect(received.has(key), `${key} must not reach the child`).toBe(false);
      }
    });
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

  it('gives the close step the call that records the tier, not just the instruction', async () => {
    // The writer and the reader have to land together. A module nothing invokes
    // records nothing, and this seam's whole defect was a field with a reader
    // and no writer — shipping the writer unwired would rebuild it one layer up.
    // §6 already proves the shape: `proposeTriage` is a write op the CLI refuses
    // to expose, so the skill carries the `import` snippet instead.
    const content = await skill();
    expect(content).toMatch(/state\.mjs/);
    expect(content).toMatch(/recordCompletedTier/);
    // and it must say where the file list comes from — a call with no argument
    // is the refusal case, not a working example
    expect(content).toMatch(/--name-only/);
  });

  // AR-62 follow-up: the documented call and the code it calls disagreed. The
  // reset in `state.mjs` is `if (runDir) updateState(runDir, {…, escalations: 0})`
  // — it happens ONLY when a run directory is passed — while §9's command, the
  // one a session copies verbatim, passed `{changedFiles, projectRoot}` alone and
  // §3 claimed "the close step clears the streak". A run following the skill
  // literally therefore never cleared it: after two escalations every later
  // selection returns `repeated escalation` however many tasks landed in between.
  // The suite was blind to it because every behavioural test passes `runDir` by
  // hand.
  it('passes a run directory in the documented close call, so the streak really is cleared', async () => {
    const content = await skill();
    // The technique is `run-journal.test.ts`'s ("names the run-end call in an
    // executable block"): a SENTENCE about `runDir` is not a caller, and a grep
    // for the word anywhere in the file would pass on the paragraph that
    // describes the bug. Only a block a run can run counts.
    const blocks = [...content.matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gm)].map(
      (fence) => fence[1] ?? '',
    );
    const calls = blocks.flatMap((block) =>
      [...block.matchAll(/recordCompletedTier\(\s*\{([\s\S]*?)\}\s*\)/g)].map((call) => ({
        block,
        args: call[1] ?? '',
      })),
    );

    expect(calls.length, 'the close call appears in no executable block').toBeGreaterThan(0);
    for (const { block, args } of calls) {
      // EVERY documented invocation, not merely one of them: a second snippet
      // without the argument is the same defect, and it is the one a session
      // would copy next.
      expect(args, 'the documented close call passes no run directory').toMatch(/runDir/);
      // …and it is the run's OWN directory, the variable the loop declares in
      // preflight — a path the snippet invented would reset a state file no
      // selection reads.
      expect(block, 'the close call names a run directory the run never declared').toMatch(
        /RIG_RUN_DIR/,
      );
    }
  });

  it('gives the declared budget the command that records it, not just a field name', async () => {
    const content = await skill();
    const blocks = [...content.matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gm)].map(
      (fence) => fence[1] ?? '',
    );

    // §4 tells a session to write its declared budget down "somewhere the run can
    // re-read", and the only stop input it feeds is `budgetExhausted` at the top
    // level of the run state. Described as a field, it gets hand-written into a
    // shape nothing reads; given as a command, it lands where the reader looks —
    // the same pairing the deploy verdict already has.
    expect(
      blocks.filter((block) => /run-state\.mjs\s+budget\s+exhausted/.test(block)),
      'no executable block records the budget the skill tells the run to declare',
    ).not.toHaveLength(0);
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

  // AR3-36, in its own test rather than a line in the list above: a module the
  // manifest does not name is a module composition DROPS, and the seam would
  // then ship a reader in every generated project with no writer anywhere —
  // which is the state this item exists to end.
  it('layers.json carries the close step that writes the tier', async () => {
    const manifest = JSON.parse(await read(universal, 'layers.json')) as Record<string, string[]>;
    expect(manifest['process']).toContain('.claude/scripts/queue/state.mjs');
  });

  // The same failure one level down, and a worse one: `checkout.mjs` is imported
  // by BOTH the writer and the reader, so a manifest that drops it ships every
  // generated project an `index.mjs` and a `state.mjs` importing a file that is
  // not there — the queue CLI fails to load at all, on the first `next`.
  it('layers.json carries the resolver the writer and the reader both import', async () => {
    const manifest = JSON.parse(await read(universal, 'layers.json')) as Record<string, string[]>;
    expect(manifest['process']).toContain('.claude/scripts/queue/checkout.mjs');
  });

  // and the general form, so the next module extracted out of this seam cannot
  // be forgotten the same way
  //
  // 🔴 It could not see the form it exists for. The regex matched `from './x.mjs'`
  // and nothing else, while every module extracted out of this seam since — the
  // run state, the run journal, the git environment, the gate sweep — is reached
  // as `from '../x.mjs'` or `await import('../x.mjs')`. The by-name tests above
  // happen to cover today's four, which is exactly how a general check goes on
  // reporting "clean" while looking at nothing: its claim about itself was wider
  // than the check.
  it('composes every module the queue seam imports, at whatever depth and in whichever form', async () => {
    const manifest = JSON.parse(await read(universal, 'layers.json')) as Record<string, string[]>;
    const composed = new Set(Object.values(manifest).flat());
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const file of (await readdir(queueDir)).filter((name) => name.endsWith('.mjs'))) {
      // Static `from '…'` and dynamic `import('…')` alike: the CLI reaches for
      // the run journal and the run state dynamically, and a module that is
      // absent at runtime fails a generated project just as hard either way.
      for (const match of (await read(queueDir, file)).matchAll(
        /(?:from|import)\s*\(?\s*'(\.{1,2}\/[A-Za-z0-9._\-/]+\.mjs)'/g,
      )) {
        const target = path.posix.normalize(`.claude/scripts/queue/${match[1] ?? ''}`);
        seen.add(target);
        if (!composed.has(target)) missing.push(`${file} -> ${target}`);
      }
    }
    expect(missing, 'imported but not composed — generation would drop it').toEqual([]);
    // …and the sweep really did look at the form its own subjects use, rather
    // than passing because it matched nothing at all. A green check that scanned
    // zero imports is the state this widening exists to end.
    expect(seen, 'the sweep never matched an import out of the queue directory').toContain(
      '.claude/scripts/run-state.mjs',
    );
    expect(seen).toContain('.claude/scripts/queue/core.mjs');
  });

  // The other half of the same decision, and the one the drift check taught:
  // the CONFIG is composed and the STATE is not. Composing the state file would
  // ship a generated file that every close rewrites — which is precisely the
  // `sync-agent-os.mjs --check` failure that sent this design back.
  it('composes the queue config and never the queue state', async () => {
    const manifest = JSON.parse(await read(universal, 'layers.json')) as Record<string, string[]>;
    expect(manifest['process']).toContain('.claude/queue.json');
    for (const layer of Object.keys(manifest)) {
      expect(manifest[layer], layer).not.toContain('.claude/queue.state.json');
    }
  });
});

// 🔴 The state file is per-checkout runtime state: it changes on every close,
// it is written by whichever session closed last, and it means nothing in
// another checkout. Committing it would put a merge conflict on the critical
// path of every task and let a stale tier arrive by `git pull`.
//
// `.claude/worktrees/` is the precedent in both places — the root `.gitignore`
// here, and each skeleton's un-dotted `gitignore` for generated projects.
describe("the queue's own state is per-checkout, so it is never committed", () => {
  const ignored = (file: string): Promise<boolean> =>
    new Promise((resolve) => {
      // `check-ignore` consults the index, so an inherited GIT_INDEX_FILE aims it
      // at another repository — the variable that already killed these tests once.
      execFile(
        'git',
        ['check-ignore', '-q', file],
        { cwd: repoRoot, env: withoutGitLocation() },
        (error) => resolve(!error),
      );
    });

  it('this repository ignores the state file while keeping the config tracked', async () => {
    await expect(ignored('.claude/queue.state.json')).resolves.toBe(true);
    // and the config stays tracked: it is generated content, not scratch state
    await expect(ignored('.claude/queue.json')).resolves.toBe(false);
  });

  // The agent-os layer ships no `.gitignore` of its own, so a generated project's
  // entry can only come from its skeleton — the same file that already carries
  // `.claude/worktrees/`, stored un-dotted because `npm publish` strips the
  // dotted form.
  it.each(['node-service', 'aws-serverless'])(
    'a generated %s project ignores the state file too',
    async (target) => {
      const content = await read(repoRoot, 'templates', 'skeleton', target, 'gitignore');
      expect(content).toContain('.claude/queue.state.json');
    },
  );
});

// The third place the same invariant is expressed, and the only one with no
// file behind it: `init` installs into a repository it did not create, so it
// cannot edit that repository's `.gitignore` — it hands the reader a block to
// paste. A pasted block that ignores nothing is the worst of both outcomes: the
// document reads as finished and the next `git add -A` stages the state file.
//
// 🔴 Assert it BEHAVIOURALLY, and extract the block rather than restating it.
// The bug here is invisible to any assertion on the markdown: git honours `#` as
// a comment only at the START of a line, so a trailing `# why` is part of the
// pattern. Reproduced with the block as written — `git check-ignore -q
// .claude/queue.state.json` exits 1, and `git status --short` shows `?? .claude/`.
describe('the ignore block the init doc tells a reader to paste', () => {
  /** The block, dedented exactly as pasting it out of the fence would give it. */
  const pastedBlock = async (): Promise<string> => {
    const doc = await read(repoRoot, 'templates', 'agent-os', 'init', 'CLAUDE.md');
    const fenced = [...doc.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
      .map((match) => match[1] ?? '')
      .filter((body) => body.includes('.claude/queue.state.json'));
    expect(fenced, 'the doc must still show the reader one block to paste').toHaveLength(1);
    const lines = (fenced[0] ?? '').replace(/\n$/, '').split('\n');
    const indent = lines
      .filter((line) => line.trim())
      .reduce((least, line) => Math.min(least, line.length - line.trimStart().length), Infinity);
    return lines.map((line) => line.slice(indent)).join('\n');
  };

  const git = (args: string[], cwd: string): Promise<number> =>
    new Promise((resolve) => {
      execFile('git', args, { cwd, env: withoutGitLocation() }, (error) =>
        resolve(error ? ((error as { code?: number }).code ?? 1) : 0),
      );
    });

  /** A scratch repository with the block pasted in and both paths present. */
  const repoWithPastedBlock = async (): Promise<string> => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'ignore-block-')));
    expect(await git(['init', '-b', 'main'], dir)).toBe(0);
    await writeFile(path.join(dir, '.gitignore'), `${await pastedBlock()}\n`);
    await mkdir(path.join(dir, '.claude', 'worktrees', 'task-1'), { recursive: true });
    await writeFile(path.join(dir, '.claude', 'queue.state.json'), '{}\n');
    return dir;
  };

  it('ignores the state file once pasted into a .gitignore', async () => {
    const dir = await repoWithPastedBlock();
    // `check-ignore -q`: 0 = ignored, 1 = tracked-in-waiting
    expect(await git(['check-ignore', '-q', '.claude/queue.state.json'], dir)).toBe(0);
  }, 20_000);

  it('ignores the worktrees directory once pasted', async () => {
    const dir = await repoWithPastedBlock();
    expect(await git(['check-ignore', '-q', '.claude/worktrees/task-1'], dir)).toBe(0);
  }, 20_000);
});

// AR-62: the same defect as AR3-36, one field over — and four times.
//
// `stopConditionOf` destructures `killSwitch`, `budgetExhausted`,
// `consecutiveEscalations` and `lastDeployVerdict` and branches on every one of
// them (`core.mjs:462-470`, branches at `:481, :491, :501, :511`). It has exactly
// two non-test callers, `index.mjs:271-273` (`{candidates, skipped}`) and
// `index.mjs:240` (`{queueReadable:false}`), and NEITHER passes any of the four.
// So all four hold their defaults on every selection this rig has ever made: the
// escalation counter is 0, the budget is never exhausted, the deploy verdict is
// always null. The values are "remembered" by the session — and a session's
// memory is lost at compaction, which is precisely the point in a long run where
// a repeated-escalation guard is worth having.
//
// 🔴 **Which file, and why it is NOT `.claude/queue.state.json`.** That file
// already exists and is per-CHECKOUT by design: `lastCompletedTier` rations the
// elevated tier ACROSS runs, so it must outlive any one of them (`state.mjs`,
// `mainCheckoutRoot`). These four are the opposite lifetime — "two escalations in
// a row" means in THIS run, a declared budget belongs to THIS run, and a
// `REGRESSION` verdict persisted per-checkout would stop every future run
// forever with nothing to clear it. Two concurrent runs in one checkout would
// also share one escalation counter and stop each other. So run state lives in
// `.claude/runs/<id>/state.json`, keyed by the run directory the loop already
// declares as `RIG_RUN_DIR` — the item's own title and its `readState(runDir)` /
// `updateState(runDir, patch)` shape. The per-checkout file keeps its one field.
/** The state a run accumulates; every field is optional until something records it. */
type RunStateFile = Record<string, unknown>;

/**
 * Both calls are `await`ed at every call site, so nothing here pins the module to
 * a synchronous or an asynchronous implementation — that choice belongs to the
 * Green step, exactly as it does for the run journal beside it.
 */
interface RunState {
  readState(runDir: string): RunStateFile | Promise<RunStateFile>;
  updateState(runDir: string, patch: RunStateFile): unknown;
}

const loadRunState = async (): Promise<RunState> =>
  (await import(
    pathToFileURL(path.join(universal, '.claude', 'scripts', 'run-state.mjs')).href
  )) as RunState;

/** A run directory the loop declared — no module here owns the run-id convention. */
const newRunDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'run-'));

describe('the run state is a file, so a compaction cannot lose it', () => {
  it('reads a run that has recorded nothing yet as an empty state', async () => {
    const { readState } = await loadRunState();
    const runDir = await newRunDir();

    // A fresh run directory has no `state.json`, and that is the normal first
    // second of every run — never an error.
    expect(await readState(runDir)).toEqual({});
  });

  // 🔴 The trap `state.mjs` is already sitting on, one file over. Its writer is
  // `writeFileSync(file, JSON.stringify({ lastCompletedTier: tier }))` — a
  // WHOLE-FILE overwrite — so a run-state writer copied from that shape would
  // erase every field it was not asked to write, silently, and the escalation
  // counter would be back to being remembered rather than recorded.
  it('merges a patch into what an earlier write left behind', async () => {
    const { readState, updateState } = await loadRunState();
    const runDir = await newRunDir();

    await updateState(runDir, { budget: { declared: 12, used: 4 } });
    await updateState(runDir, { escalations: 1 });

    expect(await readState(runDir)).toMatchObject({
      budget: { declared: 12, used: 4 },
      escalations: 1,
    });
  });

  it('writes the state where the run directory says, and nowhere else', async () => {
    const { updateState } = await loadRunState();
    const runDir = await newRunDir();

    await updateState(runDir, { escalations: 2 });

    // The path is the item's, spelled out: `.claude/runs/<id>/state.json`. The CLI
    // reads it from `RIG_RUN_DIR`, so a writer that put it anywhere else would
    // produce a reader and a writer that never meet.
    expect(JSON.parse(await read(runDir, 'state.json'))).toMatchObject({ escalations: 2 });
  });

  // 🔴 `readState`'s own type guard, which nothing pinned. `code-reviewer` deleted
  // the `typeof … && !Array.isArray(…)` line and the whole suite stayed green —
  // "a check with no test is a guess" (`invariants.md`), and this one is load-bearing
  // for every caller: `JSON.parse` hands back whatever the file happens to hold,
  // and each of these parses cleanly.
  //
  // `null` is the row that bites hardest and it is why this is not a style test:
  // without the guard `readState(runDir).escalations` throws a raw TypeError out
  // of `recordEscalation`, i.e. out of `escalate`, i.e. out of a tracker
  // escalation that has already posted its comment.
  it.each([
    ['a bare array', '[1, 2]'],
    ['an array of state-shaped objects', '[{"escalations": 5}]'],
    ['a bare string', '"nope"'],
    ['a bare number', '123'],
    ['a literal null', 'null'],
  ])('reads a state file holding %s as an empty state', async (_case, text) => {
    const { readState } = await loadRunState();
    const runDir = await newRunDir();
    await writeFile(path.join(runDir, 'state.json'), `${text}\n`);

    // Empty, and specifically an OBJECT that is empty: every caller dereferences
    // the result immediately, so "not an object" has to be converted here rather
    // than defended against at each of the four call sites.
    expect(await readState(runDir)).toEqual({});
  });
});

// AR-62: hoisted out of the describe below so the escalation, deploy-verdict and
// trigger blocks that follow drive the same CLI through the same fixture. The
// bodies are unchanged; `runCli` only grew a `runNode` underneath it, because the
// deploy verdict is written by a SECOND script (`run-state.mjs`) and the pairing
// this item exists for is "that script writes, this one reads".
const runNode = (
  script: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; out: string }> =>
  new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { cwd, env }, (error, stdout, stderr) => {
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        stdout,
        out: stdout + stderr,
      });
    });
  });

const runCli = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  runNode(path.join(queueDir, 'index.mjs'), args, cwd, env);

/**
 * A project with takeable work, a declared run directory, and an explicit
 * `--config` so the pair (config, per-checkout state) resolves inside the temp
 * tree. Without `--config` the CLI derives both from its OWN location — this
 * repository's real, gitignored `.claude/queue.state.json` — and a developer's
 * leftover tier would decide the run.
 *
 * `plan` is `null` for the case that needs the adapter to be unable to answer.
 * `config` carries the extra keys a case needs written INTO the generated file.
 */
const runProject = async (
  plan: string | null = '# P\n\n## Agent queue\n\n- add a route\n\n## Journal\n',
  config: Record<string, unknown> = {},
): Promise<{ dir: string; configPath: string; runDir: string; env: NodeJS.ProcessEnv }> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'run-state-'));
  await mkdir(path.join(dir, '.claude'), { recursive: true });
  if (plan !== null) await writeFile(path.join(dir, 'PLAN.md'), plan);
  const configPath = path.join(dir, '.claude', 'queue.json');
  await writeFile(configPath, JSON.stringify({ adapter: 'plan-md', ...config }));
  const runDir = await mkdtemp(path.join(tmpdir(), 'run-'));
  return {
    dir,
    configPath,
    runDir,
    env: { ...withoutGitLocation(), RIG_RUN_DIR: runDir },
  };
};

/** The run's own state file, hand-written: this pins the on-disk contract. */
const writeRunState = (runDir: string, state: Record<string, unknown>) =>
  writeFile(path.join(runDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);

/** What the run recorded, read back off disk. */
const runStateOf = async (runDir: string): Promise<Record<string, unknown>> =>
  JSON.parse(await read(runDir, 'state.json')) as Record<string, unknown>;

/**
 * Run `body` with both standard streams captured — hand-written, like every
 * other double here.
 *
 * The two streams are asserted SEPARATELY because they are not interchangeable:
 * `queue/index.mjs next --json` writes a document to stdout, and a recorder that
 * reported its failure there would land a stray line in the middle of the JSON
 * its caller parses.
 *
 * AR-62 round 2: hoisted out of the escalation describe below, unchanged, because
 * the run-state write path now has its own block that needs the same capture —
 * and two copies of "how this suite captures stderr" is the drift
 * `invariants.md` names.
 */
const withCapturedOutput = async <T>(
  body: () => Promise<T>,
): Promise<{ result: T; stderr: string; stdout: string }> => {
  const captured = { stderr: '', stdout: '' };
  const realErr = process.stderr.write;
  const realOut = process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    captured.stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: unknown) => {
    captured.stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await body();
    return { result, ...captured };
  } finally {
    process.stderr.write = realErr;
    process.stdout.write = realOut;
  }
};

// The Proof line of the item, at the CLI, because that is where the four fields
// have to arrive: `index.mjs next` reads the run's state and calls
// `stopConditionOf` with real values instead of defaults.
describe('the queue CLI stops the run on what the run state records', () => {
  it('stops the run when the state records two escalations in a row', async () => {
    const { dir, configPath, runDir, env } = await runProject();
    await writeRunState(runDir, { escalations: 2 });

    const result = await runCli(['next', '--config', configPath], dir, env);

    // Verbatim from the item's proof line, and it is the rendered form the
    // operator sees: `renderNext` prints the kind with its dashes as spaces and
    // appends the marker for a stop that is not a success.
    expect(result.out).toContain('queue: repeated escalation (needs attention)');
    // …and no item was handed out, which is the whole of "the run stops".
    expect(result.out).not.toMatch(/add a route/);
  });

  // 🔴 The half that cannot be faked by computing the stop after the selection:
  // a run that already hit two walls must not touch the tracker at all. Here the
  // adapter CANNOT answer — there is no PLAN.md, and `plan-md.listEligible`
  // reads it with `readFileSync` — so any call at all turns into
  // `queue-unreadable`. That is the tripwire: the message tells you which one ran.
  it('reports the repeated escalation without consulting the queue at all', async () => {
    const { dir, configPath, runDir, env } = await runProject(null);
    await writeRunState(runDir, { escalations: 2 });

    const result = await runCli(['next', '--config', configPath], dir, env);

    expect(result.out).toContain('queue: repeated escalation (needs attention)');
    expect(result.out).not.toMatch(/unreadable|ENOENT|no such file/i);
  });

  it('lets a regression verdict outrank a run that is also out of escalations', async () => {
    const { dir, configPath, runDir, env } = await runProject();
    await writeRunState(runDir, { escalations: 2, lastDeployVerdict: 'REGRESSION' });

    const result = await runCli(['next', '--config', configPath], dir, env);

    // Severity order is `stopConditionOf`'s and is already pinned there; what is
    // new is that BOTH values now reach it, so the order it applies is the order
    // the operator actually gets. A regression reported as an escalation would
    // send the run to re-read its own history instead of to the revert.
    expect(result.out).toContain('queue: runtime regression (needs attention)');
    expect(result.out).not.toContain('repeated escalation');
  });

  it('selects normally when the run has recorded no state yet', async () => {
    const { dir, configPath, runDir, env } = await runProject();

    // The declaration is there and the file is not: nothing has escalated, no
    // budget was declared, nothing was deployed. Today's behaviour, unchanged —
    // refusing here would make the first selection of every run impossible.
    await expect(read(runDir, 'state.json')).rejects.toThrow();
    const result = await runCli(['next', '--json', '--config', configPath], dir, env);

    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ticket: Ticket | null; stop: unknown };
    expect(parsed.ticket?.title).toBe('add a route');
    expect(parsed.stop).toBeNull();
  });

  it('selects normally when the run declared no directory at all', async () => {
    const { dir, configPath } = await runProject();
    const env = withoutGitLocation();
    delete env['RIG_RUN_DIR'];

    // A run outside the loop skill — a human at a prompt — has no run directory,
    // and the four fields are then simply unknown. Unknown reads as their
    // defaults, which is exactly what every selection does today.
    const result = await runCli(['next', '--json', '--config', configPath], dir, env);

    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ticket: Ticket | null; stop: unknown };
    expect(parsed.ticket?.title).toBe('add a route');
    expect(parsed.stop).toBeNull();
  });

  // --- the exit code, which is the only thing an unattended wrapper reads ------
  //
  // 🔴 `stopConditionOf` already decides this and the CLI already honours it on
  // the queue path: `budget`, `queue-empty` and `nothing-selectable` are
  // `success: true` and exit 0 ("says the queue is empty in a way that reads as
  // success"), `queue-unreadable` is not and exits 1. The run-level block added
  // above them exits 1 for EVERY kind, so a run that stopped exactly where it
  // said it would — its declared budget — reports itself as a failure. Two stops
  // from one rule, disagreeing about what they mean, and the code reviewer's
  // mutation of `exit(1)` → `exit(0)` changed nothing red.
  const stoppedBy = (state: Record<string, unknown>, extra: string[] = []) =>
    runProject().then(async ({ dir, configPath, runDir, env }) => {
      await writeRunState(runDir, state);
      return runCli(['next', ...extra, '--config', configPath], dir, env);
    });

  it('reads a budget stop as success, exactly as it reads an empty queue', async () => {
    const result = await stoppedBy({ budgetExhausted: true });

    expect(result.out).toContain('queue: budget');
    // `renderNext` already agrees — it appends the marker only to a stop that is
    // not a success — so an exit code of 1 beside an unmarked line is the CLI
    // contradicting itself in the same two lines of output.
    expect(result.out).not.toContain('needs attention');
    expect(result.code, result.out).toBe(0);
  });

  it('reads a repeated escalation as the failure it is', async () => {
    const result = await stoppedBy({ escalations: 2 });

    expect(result.out).toContain('queue: repeated escalation (needs attention)');
    expect(result.code, result.out).not.toBe(0);
  });

  it('reads a regression verdict as the failure it is', async () => {
    const result = await stoppedBy({ lastDeployVerdict: 'REGRESSION' });

    expect(result.out).toContain('queue: runtime regression (needs attention)');
    expect(result.code, result.out).not.toBe(0);
  });

  it('says the same thing in --json as it says in its exit code', async () => {
    const result = await stoppedBy({ budgetExhausted: true }, ['--json']);

    // One verdict, two channels: a wrapper that reads the code and a human that
    // reads the payload must not come to opposite conclusions about the same run.
    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.stdout) as { stop: { kind: string; success: boolean } };
    expect(parsed.stop.kind).toBe('budget');
    expect(parsed.stop.success).toBe(true);
  });
});

// 🔴 The write path is hardened and the read path is not, so the hardening buys
// nothing. `recordEscalation` refuses a count that is not an integer
// (`Number.isInteger`); the deploy CLI refuses any word outside its two-word
// vocabulary — and then `index.mjs` passes the parsed JSON to `stopConditionOf`
// raw, where `>=` and `===` do the rest. `{} >= 2` is `NaN >= 2`, and no object is
// ever `=== 'REGRESSION'`, so a value that is merely WRONG reads as "nothing was
// recorded" and the run takes work on top of it. `run-state.mjs` documents the
// file as hand-editable, so no attacker is required — a session that wrote the
// field by hand instead of through the CLI is the whole of it.
//
// The bound matters as much as the fix: refusing an honest absence would make the
// first selection of every run impossible, so both directions are pinned here.
describe('a run-state value the reader cannot make sense of never reads as "no stop"', () => {
  const selectionWith = async (state: unknown): Promise<{ code: number; out: string }> => {
    const { dir, configPath, runDir, env } = await runProject();
    // Written as text rather than through `updateState`: the point is a file a
    // hand — or an older version of this rig — could have left behind.
    await writeFile(path.join(runDir, 'state.json'), `${JSON.stringify(state)}\n`);
    return runCli(['next', '--config', configPath], dir, env);
  };

  /** Each row: a well-formed JSON value that silently disables the stop it feeds. */
  const UNREADABLE: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a count that is an object', { escalations: {} }, /escalations/],
    // 🔴 AR-62 round 2. The five rows below are the ones `stopInputsOf`'s own
    // comment says it refuses — "an object or a boolean cannot mean a count at
    // all" — and which it in fact COERCES, measured:
    //
    //   {"escalations": true}  → consecutiveEscalations: 1   (not refused)
    //   {"escalations": false} → 0    ← reads as "no escalations"
    //   {"escalations": ""}    → 0    ← same
    //   {"escalations": " "}   → 0    ← same
    //   {"escalations": []}    → 0    ← same
    //
    // Four of the five are the dangerous direction exactly: a present,
    // uninterpretable value silently disabling the stop it was written to
    // enforce. `Number()` is not the guard here — it is the hole, because it
    // maps four distinct kinds of nonsense onto the one value that means "carry
    // on". The rule the fix implements: coerce where any coercion fails SAFE,
    // refuse where it fails dangerous. `budgetExhausted: Boolean(…)` passes that
    // test (every present value stops); a count read through `Number()` does not.
    ['a count written as `true`', { escalations: true }, /escalations/],
    ['a count written as `false`', { escalations: false }, /escalations/],
    ['a count written as an empty string', { escalations: '' }, /escalations/],
    ['a count that is nothing but whitespace', { escalations: ' ' }, /escalations/],
    ['a count written as an empty array', { escalations: [] }, /escalations/],
    // Not new behaviour — `count < 0` already refuses this — but an UNTESTED
    // branch: `code-reviewer` deleted the `count < 0` half and the suite stayed
    // green, because a negative count and a zero count agree about everything
    // except the refusal. "A check with no test is a guess" (`invariants.md`).
    ['a count below zero', { escalations: -1 }, /escalations/],
    // The same value down the OTHER branch, and that is the whole point of the
    // row: `-1` takes the number path, `"-1"` takes the string path, and the two
    // `>= 0` guards are separate lines of code. Deleting either one leaves the
    // other's row green, so one row cannot stand for both.
    ['a count below zero written as a string', { escalations: '-1' }, /escalations/],
    // 🔴 AR-62 round 3 — the array branch, which is the single source of three
    // defects and has no writer at all: `recordEscalation` stores an integer, the
    // CLI stores the other three fields, and no adapter stores an array. Measured
    // on this commit:
    //
    //   {"escalations": [null]} → consecutiveEscalations: 0   ← selects work
    //   {"escalations": [3]}    → 3, via a recursion nothing needs
    //
    // The first is the exact shape `stopInputsOf`'s own comment says it exists to
    // refuse — a present value silently disabling the stop — arrived at by a
    // branch written to preserve a `Number(x.join())` coercion that was itself an
    // artifact. Both rows below MOVE from the accepting side of this file: an
    // array is now uninterpretable like any other value the reader cannot act on,
    // which is a strengthening in the safe direction, not a relaxation.
    ['a count wrapped in an array', { escalations: [3] }, /escalations/],
    ['a count of nothing wrapped in an array', { escalations: [null] }, /escalations/],
    [
      'a verdict that is an object',
      { lastDeployVerdict: { toString: 'REGRESSION' } },
      /lastDeployVerdict/,
    ],
    [
      'a verdict one typo away from the vocabulary',
      { lastDeployVerdict: 'REGRESSED' },
      /lastDeployVerdict/,
    ],
  ];

  it.each(UNREADABLE)(
    'hands out no work when the state carries %s',
    async (_case, state, named) => {
      const result = await selectionWith(state);

      // The security property, stated at the level that matters and no lower: the
      // run does not receive an item. Whether the answer is a refusal or a stop
      // condition belongs to the Green step — reading it as "nothing recorded"
      // does not, because that is the one answer that lets the run keep going.
      expect(result.out, 'an item was handed out').not.toMatch(/add a route/);
      expect(result.code, result.out).not.toBe(0);
      // …and it names the value it could not read, or the operator is left with a
      // run that stopped for no stated reason and a state file that looks fine.
      expect(result.out).toMatch(named);
    },
  );

  it('hands out no work when the verdict is stored in the wrong case', async () => {
    // The write path normalises `regression` to `REGRESSION` precisely because
    // `stopConditionOf` compares with `===` — which means a lowercase word on
    // disk is a verdict that was recorded outside that CLI, and reading it as no
    // deploy at all is the single outcome `autonomy.md` calls never-fix-forward.
    const result = await selectionWith({ lastDeployVerdict: 'regression' });

    expect(result.out, 'an item was handed out').not.toMatch(/add a route/);
    expect(result.code, result.out).not.toBe(0);
  });

  // The other direction, and it is what keeps the fix from becoming a run that
  // cannot start. An absence is a defined state, and `null` is its honest
  // spelling — `loadState` allows exactly that for `lastCompletedTier` one file
  // over, for the same reason.
  //
  // The last row is the asymmetry with `escalations: false` above, and it is
  // deliberate rather than an inconsistency to tidy away: `budgetExhausted` is a
  // FLAG, so `false` is its honest spelling of "not exhausted" and coercing it
  // costs nothing — every other present value still stops. `escalations` is a
  // COUNT, and no boolean is an honest spelling of one. Same principle, opposite
  // answer, because the safe direction differs.
  it.each([
    ['records nothing at all', {}],
    ['records a count of zero', { escalations: 0 }],
    ['spells the count as an explicit null', { escalations: null }],
    ['spells the verdict as an explicit null', { lastDeployVerdict: null }],
    ['records a budget that is not exhausted', { budgetExhausted: false }],
  ])('still selects work when the state %s', async (_case, state) => {
    const result = await selectionWith(state);

    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('add a route');
  });

  // and the rows that already stop, pinned so the normalisation cannot quietly
  // relax them. A guard copied verbatim from `recordEscalation`
  // (`Number.isInteger(v) ? v : 0`) would read the count below as zero and hand
  // out work to a run that had escalated five times — the fix undoing the stop it
  // was written to protect.
  //
  // The one-element-array row that used to sit here has MOVED to the refusal
  // table above. `[3]` still hands out no work either way, so what changed is the
  // reason the operator is given: a stop that names an escalation streak the run
  // never had, versus a refusal that names the field it could not read.
  it.each([
    ['a count written as a string', { escalations: '5' }, /repeated escalation/],
    ['a budget flag written as the string "false"', { budgetExhausted: 'false' }, /queue: budget/],
  ])('keeps stopping on %s', async (_case, state, kind) => {
    const result = await selectionWith(state);

    expect(result.out).toMatch(kind);
    expect(result.out, 'an item was handed out').not.toMatch(/add a route/);
  });
});

// The same decision, taken one layer down where every row is legible at once.
// The CLI block above proves the consequence that matters (no item is handed
// out); this one is the table of what each value MEANS, because "is `[]` a count
// of zero, or a value nobody can read?" is a question about `stopInputsOf`, and
// answering it through a subprocess makes the answer hard to find.
describe('stopInputsOf decides every count deliberately, and coerces only where that is safe', () => {
  interface StopInputs {
    consecutiveEscalations: number;
    lastDeployVerdict: string | null;
    budgetExhausted: boolean;
  }

  const stopInputsOf = async (): Promise<(state?: unknown) => StopInputs> => {
    const module = (await loadRunState()) as unknown as Record<string, unknown>;
    const found = module['stopInputsOf'];
    expect(found, 'run-state.mjs must export stopInputsOf').toBeTypeOf('function');
    return found as (state?: unknown) => StopInputs;
  };

  /**
   * A chain of single-element arrays, `depth` links long, with a plain count at
   * the bottom. Built with a loop rather than a literal because the depths that
   * matter here are not writable by hand.
   */
  const arrayNestedDeep = (depth: number): unknown => {
    let value: unknown = 3;
    for (let i = 0; i < depth; i += 1) value = [value];
    return value;
  };

  // 🔴 Every row is a value the docstring already claims to refuse, or one whose
  // only coercion lands on "no stop". A refusal is the whole answer: the caller
  // turns it into a run that does not select, which is the safe half of a state
  // file nobody can read.
  it.each<[string, unknown]>([
    ['a boolean true', true],
    ['a boolean false', false],
    ['an empty string', ''],
    ['a string of whitespace', ' '],
    ['an empty array', []],
    ['an object', {}],
    ['a negative count', -1],
    // The string path's own `>= 0`. `-1` above never reaches it — that row is
    // decided by `typeof value === 'number'` two lines earlier — so deleting the
    // string guard leaves this file green with a below-zero count accepted.
    ['a negative count written as a string', '-1'],
    // 🔴 The `Number.isInteger` half of the same two guards, and the value is
    // BELOW the threshold on purpose. Relaxing either one to `Number.isFinite`
    // looks safe read at `2.5` — a fractional count still fires the stop, only
    // earlier — and is not: `1.5` would read as one-and-a-half escalations, which
    // is under two, so the run selects work on a value nobody can act on. That is
    // the `-1` case exactly, wearing a decimal point. Both branches, because
    // `Number.isInteger` is written twice and either copy can go alone.
    ['a fractional count', 1.5],
    ['a fractional count written as a string', '1.5'],
    // 🔴 AR-62 round 3 — the four array rows. The first two MOVE here from the
    // accepting table below; the array branch that accepted them is being
    // deleted, so an array joins every other value the reader cannot act on. It
    // has no writer — `recordEscalation` writes an integer and `recordCompletedTier`
    // writes `escalations: 0` (`queue/state.mjs:143`), the CLI writes the other
    // three fields, and no adapter writes an array — and it is the single source
    // of the three defects each row names. The enumeration is the part a future
    // reader audits against, so it names every writer of this field, not the
    // interesting ones.
    ['a count wrapped in an array', [3]],
    // Nesting was accepted to any depth, because the branch recursed. No number
    // of brackets makes a value more count-like than the value inside them.
    ['a count wrapped in two arrays', [[3]]],
    // The dangerous one, and the reason the branch is going rather than being
    // patched: a PRESENT value that read as `0` and let the run select work,
    // which is verbatim the case the whole function was written to refuse.
    ['nothing at all wrapped in an array', [null]],
    // Refused today only by `value.length === 1`, which nothing pinned —
    // `code-reviewer` weakened it to `>= 1` and the suite stayed green. The row
    // survives the deletion (an array refuses on being an array), so it guards
    // the behaviour rather than the line that currently produces it.
    ['two counts in an array', [1, 2]],
    // The recursion was bounded by the input's own nesting and nothing else, so a
    // deep enough chain overflowed the stack. It fails CLOSED — the CLI catches
    // it and exits 1 with no item — so it is not a bypass; what the operator
    // loses is the field name, getting `Maximum call stack size exceeded` where
    // every other refusal says which field to fix. 10_000 is comfortably past the
    // measured limit of ~7_900 for the recursion this replaces.
    ['a count nested ten thousand arrays deep', arrayNestedDeep(10_000)],
  ])('refuses an escalation count written as %s', async (_case, escalations) => {
    const read = await stopInputsOf();

    // Named, not merely refused: the operator's state file looks fine to them,
    // so an error that does not say `escalations` sends them to the wrong file.
    expect(() => read({ escalations })).toThrow(/escalations/);
  });

  // The bound, and it is what keeps the refusal from making a run unstartable. A
  // guard that also refused these would be the AR-62 defect in a fix's clothes:
  // the count would become unwritable by hand and unreadable after a hand-edit,
  // and the operator's next move is to delete the file.
  //
  // The one-element-array row that used to sit here has MOVED to the refusal
  // table above, and the move is the point of this round: every row left is a
  // shape a hand-edit or a writer actually produces, and none of them needs a
  // recursive read.
  it.each<[string, unknown, number]>([
    ['a plain number', 2, 2],
    ['a hand edit that reached for a string', '5', 5],
    ['an explicit zero', 0, 0],
    ['an explicit null, which is how absence is spelled', null, 0],
  ])('reads an escalation count given as %s', async (_case, escalations, expected) => {
    const read = await stopInputsOf();

    expect(read({ escalations }).consecutiveEscalations).toBe(expected);
  });

  it('reads a state that records no count at all as none', async () => {
    const read = await stopInputsOf();

    // `null` and absent are the same fact — nothing has escalated — and that is
    // the first second of every run. The `null` row above and this one together
    // are the null-vs-absent decision, written down rather than inferred.
    expect(read({}).consecutiveEscalations).toBe(0);
    expect(read().consecutiveEscalations).toBe(0);
  });
});

// The writer at the other end. `recordCompletedTier` is the close step, and it is
// already a whole-file overwrite of the per-checkout state — so the moment it also
// writes the run's state, it is one line away from erasing the counters this item
// exists to persist.
describe('the close step writes the run state without erasing the rest of it', () => {
  /** A project the tier computation can read: a declaration and a state path. */
  const withProject = async (): Promise<{ dir: string; statePath: string }> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'close-'));
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(
      path.join(dir, 'CLAUDE.md'),
      '# P\n\n```elevated-paths\npackages/db/src/\n.claude/\n```\n',
    );
    return { dir, statePath: path.join(dir, '.claude', 'queue.state.json') };
  };

  // `runStateOf` is the module-scope one now — the escalation block below reads
  // the same file and two copies of "where the run state lives" is the drift
  // `invariants.md` names.

  it('breaks the escalation streak the run was carrying', async () => {
    const { recordCompletedTier } = await load('state.mjs');
    const { updateState } = await loadRunState();
    const { dir, statePath } = await withProject();
    const runDir = await newRunDir();
    await updateState(runDir, { escalations: 1 });

    recordCompletedTier({
      changedFiles: ['services/api/src/handler.ts'],
      projectRoot: dir,
      statePath,
      runDir,
    });

    // "Consecutive" is the whole meaning of the counter: a task that closed is a
    // task that did not hit a wall, so the streak is over. A counter that only
    // ever rises stops the run on two escalations that were an hour and three
    // successful tasks apart.
    expect(await runStateOf(runDir)).toMatchObject({ escalations: 0 });
  });

  // The other side of that `if (runDir)`, pinned because it is what makes the
  // documented command load-bearing rather than decorative. A close that named
  // no run directory records nothing about the run — which is right (an attended
  // session outside the loop has no run to write to), and is exactly why the
  // omission is invisible: nothing throws, nothing warns, and the streak simply
  // never breaks. So the fix belongs in the CALL the skill documents, not in a
  // module reaching for a run directory it was not given.
  it('leaves the escalation streak untouched when the close names no run directory', async () => {
    const { recordCompletedTier } = await load('state.mjs');
    const { updateState } = await loadRunState();
    const { dir, statePath } = await withProject();
    const runDir = await newRunDir();
    await updateState(runDir, { escalations: 1 });

    recordCompletedTier({
      changedFiles: ['services/api/src/handler.ts'],
      projectRoot: dir,
      statePath,
    });

    expect(await runStateOf(runDir)).toEqual({ escalations: 1 });
  });

  // 🔴 The whole-file-overwrite trap, pinned on a field the close does NOT own —
  // `escalations` alone cannot pin it, because a close legitimately sets that to
  // 0 and an erased field reads back as 0 too. The two are indistinguishable, and
  // a test that could not tell them apart would let the close silently drop the
  // budget and the deploy verdict while looking green.
  it('leaves the run-state fields it does not own exactly as it found them', async () => {
    const { recordCompletedTier } = await load('state.mjs');
    const { updateState } = await loadRunState();
    const { dir, statePath } = await withProject();
    const runDir = await newRunDir();
    await updateState(runDir, {
      escalations: 1,
      budget: { declared: 12, used: 7 },
      triggersFired: { '7': true },
    });

    recordCompletedTier({
      changedFiles: ['services/api/src/handler.ts'],
      projectRoot: dir,
      statePath,
      runDir,
    });

    expect(await runStateOf(runDir)).toMatchObject({
      budget: { declared: 12, used: 7 },
      triggersFired: { '7': true },
    });
  });

  it('still records the tier in the per-checkout state, which outlives the run', async () => {
    const { recordCompletedTier } = await load('state.mjs');
    const { dir, statePath } = await withProject();
    const runDir = await newRunDir();

    recordCompletedTier({
      changedFiles: ['packages/db/src/schema.ts'],
      projectRoot: dir,
      statePath,
      runDir,
    });

    // Two files, two lifetimes, and the elevated ration keeps the one it had: it
    // spaces elevated work across RUNS, so moving it into a per-run file would
    // hand the next run a clean slate and let a second elevated item straight
    // through — the AR3-36 defect, restored by tidying.
    expect(JSON.parse(await read(statePath))).toMatchObject({ lastCompletedTier: 'elevated' });
    // and the run's own trace carries it too, per the state shape the item names
    expect(await runStateOf(runDir)).toMatchObject({ lastCompletedTier: 'elevated' });
  });
});

// AR-62, the other half of the counter. `recordCompletedTier` now writes
// `escalations: 0` on a close, and `index.mjs` reads `escalations` before it
// touches the queue — so the run-level stop that guards against grinding a
// systemic wall is wired at both the reset and the read. NOTHING RAISES IT. The
// number can only ever be 0, `stopConditionOf`'s `>= 2` branch is unreachable in
// production, and the suite is green either way: a stop condition whose input has
// a writer for zero and no writer for one is the AR3-36 defect exactly, one field
// over from where AR-62 already found it twice.
//
// The writer is `escalate` — the operation the loop calls when a task hits a wall
// (`.claude/skills/loop/SKILL.md` §5) — on all three adapters.
//
// 🔴 **One implementation, not three.** Three copies of read-count-add-one in
// three adapters is what `invariants.md` refuses in as many words ("if two files
// enforce the same invariant, they will disagree — and the one nobody is looking
// at is the one that is wrong"). The count lives in `run-state.mjs`, which already
// owns the file; the adapters call it.
describe('an escalation is recorded rather than remembered', () => {
  const ADAPTER_FILES = ['plan-md.mjs', 'github-issues.mjs', 'jira.mjs'];

  /** The three names `jira.mjs` refuses to run without. Never real credentials. */
  const JIRA_ENV = {
    JIRA_BASE_URL: 'https://example.invalid',
    JIRA_EMAIL: 'a@b.c',
    JIRA_API_TOKEN: 'x',
  };

  /** Set some environment variables for the duration of `body`, then put them back. */
  const withEnv = async <T>(
    vars: Record<string, string | undefined>,
    body: () => T | Promise<T>,
  ): Promise<T> => {
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(vars)) {
      saved[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return await body();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  /**
   * A `gh` on PATH that succeeds silently — `github-issues.escalate` shells out
   * twice before it can record anything, and this test is about the recording.
   * Prepended rather than replacing PATH: `/bin/sh` still has to be findable.
   */
  const withStubGh = async <T>(body: () => T | Promise<T>): Promise<T> => {
    const bin = await realpath(await mkdtemp(path.join(tmpdir(), 'stub-gh-')));
    await writeFile(path.join(bin, 'gh'), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(bin, 'gh'), 0o755);
    return withEnv({ PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}` }, body);
  };

  /**
   * Escalate one item on one adapter, with only that adapter's TRACKER call
   * stubbed out — hand-written structural stubs, per the stack rules.
   *
   * The run directory travels in `process.env` for all three; for `jira.mjs` it
   * also rides in the `env` option, whose default is `process.env`, so the test
   * pins the behaviour without dictating which of the two the adapter reads.
   */
  const escalateOn = async (adapterFile: string): Promise<Record<string, unknown>> => {
    const { escalate } = (await load(adapterFile)) as {
      escalate: (
        ticket: { id: string; title: string },
        diagnosis: string,
        options?: Record<string, unknown>,
      ) => unknown;
    };
    const item = { id: '1', title: 'add a route' };
    const diagnosis = 'three strikes on the parser, and no new hypothesis to try';

    if (adapterFile === 'jira.mjs') {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve({}),
        })) as unknown as typeof globalThis.fetch;
      try {
        return (await escalate(item, diagnosis, {
          env: { ...process.env, ...JIRA_ENV },
        })) as Record<string, unknown>;
      } finally {
        globalThis.fetch = realFetch;
      }
    }
    if (adapterFile === 'github-issues.mjs') {
      return (await withStubGh(() => escalate(item, diagnosis))) as Record<string, unknown>;
    }
    return (await escalate(item, diagnosis)) as Record<string, unknown>;
  };

  it.each(ADAPTER_FILES)('%s counts the first wall a run hits', async (file) => {
    const runDir = await newRunDir();

    await withEnv({ RIG_RUN_DIR: runDir }, () => escalateOn(file));

    // Absent state is the normal first second of a run, so the first escalation
    // has to count from nothing rather than needing a file to already be there.
    expect(await runStateOf(runDir)).toMatchObject({ escalations: 1 });
  });

  it.each(ADAPTER_FILES)('%s raises the count to the two that end the run', async (file) => {
    const { updateState } = await loadRunState();
    const runDir = await newRunDir();
    await updateState(runDir, { escalations: 1 });

    await withEnv({ RIG_RUN_DIR: runDir }, () => escalateOn(file));

    expect(await runStateOf(runDir)).toMatchObject({ escalations: 2 });
  });

  it.each(ADAPTER_FILES)('%s still escalates when the run declared no directory', async (file) => {
    // A human at a prompt, or any session outside the `loop` skill, has no run
    // directory — and an item that hit a wall must still be escalated. Recording
    // nowhere is the right answer there; refusing to escalate is not.
    const result = await withEnv({ RIG_RUN_DIR: undefined }, () => escalateOn(file));

    expect(result, file).toBeTruthy();
  });

  it('leaves plan-md refusing exactly as it did, and counts the escalation anyway', async () => {
    const runDir = await newRunDir();

    const result = await withEnv({ RIG_RUN_DIR: runDir }, () => escalateOn('plan-md.mjs'));

    // A flat list has no per-item state, so the adapter cannot mark the item and
    // says so — that contract is the session's instruction to move the line by
    // hand, and it is unchanged. But the RUN still hit a wall: the streak that
    // stops a run is about this run's tasks, not about what the tracker accepted.
    expect(result['ok']).toBe(false);
    expect(String(result['why'])).toMatch(/Operator queue/);
    expect(await runStateOf(runDir)).toMatchObject({ escalations: 1 });
  });

  // The pairing, because a counter nothing reads is the same defect as a counter
  // nothing writes: two escalations through the adapter, and the next selection
  // refuses to hand out work.
  it('ends the run after two escalations, through the CLI that reads the count', async () => {
    const { dir, configPath, runDir, env } = await runProject();

    await withEnv({ RIG_RUN_DIR: runDir }, async () => {
      await escalateOn('plan-md.mjs');
      await escalateOn('plan-md.mjs');
    });
    const result = await runCli(['next', '--config', configPath], dir, env);

    expect(result.out).toContain('queue: repeated escalation (needs attention)');
    expect(result.out).not.toMatch(/add a route/);
  });

  it('lets a completed task clear the streak the escalations built', async () => {
    const { dir, configPath, runDir, env } = await runProject();
    const { recordCompletedTier } = await load('state.mjs');
    await writeFile(
      path.join(dir, 'CLAUDE.md'),
      '# P\n\n```elevated-paths\npackages/db/src/\n```\n',
    );

    await withEnv({ RIG_RUN_DIR: runDir }, () => escalateOn('plan-md.mjs'));
    recordCompletedTier({
      changedFiles: ['services/api/src/handler.ts'],
      projectRoot: dir,
      statePath: path.join(dir, '.claude', 'queue.state.json'),
      runDir,
    });
    await withEnv({ RIG_RUN_DIR: runDir }, () => escalateOn('plan-md.mjs'));

    // "Two in a row" is the whole claim. One escalation, a task that closed, then
    // another escalation is one strike — a counter that only ever rises would end
    // the run on two walls an hour and three successful tasks apart.
    expect(await runStateOf(runDir)).toMatchObject({ escalations: 1 });
    const result = await runCli(['next', '--config', configPath], dir, env);
    expect(result.out).not.toContain('repeated escalation');
  });

  // --- a run directory that cannot be recorded into ---------------------------
  //
  // 🔴 Both reviewers reproduced this, and the ORDER inside `escalate` is what
  // makes it expensive: `github-issues.escalate` posts the diagnosis comment and
  // applies the `escalated` label BEFORE it calls the recorder, and `jira.escalate`
  // does the same over HTTP. So a stale `RIG_RUN_DIR` — an export that outlived
  // its run, a run directory that was cleaned up, a worktree where the loop's
  // `mkdir -p` never ran — turns a fully-successful tracker escalation into a
  // thrown ENOENT, and the natural response to a thrown escalation (run it again)
  // posts the diagnosis on the item a second time.
  //
  //   RIG_RUN_DIR=/tmp/does-not-exist  → ENOENT … open '…/state.json.<pid>.tmp'
  //   RIG_RUN_DIR unwritable           → EACCES … open '…/state.json.<pid>.tmp'
  //
  // The recorder's own docstring already states the contract it breaks here — "a
  // recorder that refused there would push callers into not calling it" — and
  // `readState` beside it already models the tolerant half. Recording is
  // best-effort; escalating an item that hit a wall is not.
  const MISSING_RUN_DIR = path.join(tmpdir(), 'run-dir-that-was-never-created');

  /**
   * A run directory this process may read but never write — the EACCES half,
   * which a missing directory cannot stand in for: here the state file EXISTS and
   * has a count in it, so "records nothing" and "loses what was there" are
   * distinguishable.
   */
  const withUnwritableRunDir = async <T>(
    body: (runDir: string) => Promise<T>,
    seed: Record<string, unknown> | null = null,
  ): Promise<T> => {
    const runDir = await newRunDir();
    if (seed) await writeRunState(runDir, seed);
    await chmod(runDir, 0o500);
    try {
      return await body(runDir);
    } finally {
      // Restored whatever happened, or the temp tree cannot be cleaned up.
      await chmod(runDir, 0o700);
    }
  };

  describe('a run directory it cannot record into never undoes a tracker escalation', () => {
    it.each(ADAPTER_FILES)('%s escalates when the run directory is not there', async (file) => {
      const runDir = await newRunDir();
      // The same call twice with only the run directory changed: what the caller
      // gets back must not depend on whether the recording landed. Compared
      // against the adapter's OWN usual answer rather than a shape spelled out
      // here, because the three differ (`plan-md` answers `ok: false` by design).
      const usual = await withEnv({ RIG_RUN_DIR: runDir }, () => escalateOn(file));

      const { result } = await withCapturedOutput(() =>
        withEnv({ RIG_RUN_DIR: MISSING_RUN_DIR }, () => escalateOn(file)),
      );

      expect(result, `${file} threw, or answered differently`).toEqual(usual);
    });

    it.each(ADAPTER_FILES)('%s escalates when the run directory is unwritable', async (file) => {
      const runDir = await newRunDir();
      const usual = await withEnv({ RIG_RUN_DIR: runDir }, () => escalateOn(file));

      const { result } = await withUnwritableRunDir((blocked) =>
        withCapturedOutput(() => withEnv({ RIG_RUN_DIR: blocked }, () => escalateOn(file))),
      );

      expect(result, `${file} threw, or answered differently`).toEqual(usual);
    });

    it('says on stderr that the count went unrecorded, when the directory is missing', async () => {
      const { stderr, stdout } = await withCapturedOutput(() =>
        withEnv({ RIG_RUN_DIR: MISSING_RUN_DIR }, () => escalateOn('plan-md.mjs')),
      );

      // Not silence. Swallowing the write trades a thrown exception for a lie:
      // the run believes its streak is being counted, and the stop that ends a
      // run grinding a systemic wall then never fires. `invariants.md` names this
      // exact trade — a guard that fails open must still say that it failed.
      expect(stderr, 'the failed write was swallowed').not.toBe('');
      // It names the directory, because the fix is one `mkdir` or one corrected
      // variable away and the operator has to know which.
      expect(stderr).toContain(MISSING_RUN_DIR);
      expect(stderr, 'the line does not say what went unrecorded').toMatch(/escalation/i);
      expect(stderr, 'the line does not say why the write failed').toMatch(/ENOENT|no such file/i);
      expect(stdout, 'a caller parsing stdout would get this line in its JSON').toBe('');
    });

    it('says on stderr that the count went unrecorded, when the directory is unwritable', async () => {
      const { stderr } = await withUnwritableRunDir((blocked) =>
        withCapturedOutput(() =>
          withEnv({ RIG_RUN_DIR: blocked }, () => escalateOn('plan-md.mjs')),
        ),
      );

      expect(stderr, 'the failed write was swallowed').not.toBe('');
      // The two failures ask for different fixes — create the directory, or fix
      // its permissions — so a message that flattened them into one would send
      // half the operators to the wrong place.
      expect(stderr, 'the line does not say why the write failed').toMatch(/EACCES|permission/i);
    });

    it('conjures no run directory to record into', async () => {
      await withCapturedOutput(() =>
        withEnv({ RIG_RUN_DIR: MISSING_RUN_DIR }, () => escalateOn('plan-md.mjs')),
      );

      // Creating it would make this module a second owner of the run-id
      // convention its own header disclaims — and would put a run's trace
      // wherever a stale export happened to point.
      await expect(readdir(MISSING_RUN_DIR)).rejects.toThrow();
    });

    it('leaves the count it could not raise exactly as it found it', async () => {
      const after = await withUnwritableRunDir(
        async (blocked) => {
          await withCapturedOutput(() =>
            withEnv({ RIG_RUN_DIR: blocked }, () => escalateOn('plan-md.mjs')),
          );
          return { state: await runStateOf(blocked), entries: await readdir(blocked) };
        },
        { escalations: 1 },
      );

      expect(after.state).toEqual({ escalations: 1 });
      // and no half-written temp file left behind for the next reader to trip
      // over.
      //
      // ⚠ The claim this comment used to make — "write-then-rename either lands
      // whole or leaves nothing" — is true HERE and false in general, so it has
      // been narrowed to what this case actually shows. Under EACCES the open
      // fails and there is nothing to clean up; when the open SUCCEEDS and the
      // rename fails, today's code leaves the temp file behind forever. That
      // second case is pinned in its own block below, and stating it as a general
      // property here was cover the code never had.
      expect(after.entries).toEqual(['state.json']);
    });
  });

  // 🔴 One implementation, not three — pinned by behaviour AND by shape, because
  // three adapters that each pass these tests with their own copy would satisfy
  // every assertion above while being exactly the defect.
  describe('the count has one owner', () => {
    /** The single escalation-recording export of `run-state.mjs`, whatever it is called. */
    const recorder = async (): Promise<(runDir?: string) => number | Promise<number>> => {
      const module = (await loadRunState()) as unknown as Record<string, unknown>;
      const found = Object.entries(module).filter(
        ([name, value]) => typeof value === 'function' && /escalat/i.test(name),
      );
      expect(
        found.map(([name]) => name),
        'run-state.mjs must export exactly one escalation recorder',
      ).toHaveLength(1);
      return found[0]![1] as (runDir?: string) => number | Promise<number>;
    };

    it('exports one escalation recorder for the three adapters to share', async () => {
      await expect(recorder()).resolves.toBeTypeOf('function');
    });

    it('hands back the count it just recorded, so the caller can journal it', async () => {
      const record = await recorder();
      const runDir = await newRunDir();

      // The caller needs the number: the loop's journal entry names the streak,
      // and re-reading the file to find out what it just wrote is a second
      // reader of the same fact.
      expect(await record(runDir)).toBe(1);
      expect(await record(runDir)).toBe(2);
    });

    it('reads a count it cannot make sense of as none, never as NaN', async () => {
      const record = await recorder();
      const runDir = await newRunDir();
      await writeRunState(runDir, { escalations: 'two' });

      // `NaN >= 2` is false, so one junk value would disable the only guard
      // against grinding a systemic wall — silently, for the rest of the run.
      expect(await record(runDir)).toBe(1);
      expect(await runStateOf(runDir)).toMatchObject({ escalations: 1 });
    });

    it('records nothing, and refuses nothing, when there is no run directory', async () => {
      const record = await recorder();

      // `0` and not `null`: `index.mjs` feeds this straight into a `>=` test, and
      // "unknown" has no meaning there — an undeclared run has escalated 0 times.
      expect(await record(undefined)).toBe(0);
      expect(await record('')).toBe(0);
    });

    it('records nothing, and refuses nothing, when the run directory is not there', async () => {
      const record = await recorder();

      // The docstring's contract held for the empty string only. A path that is
      // merely WRONG threw — and it threw from inside `escalate`, after the
      // tracker had already been written to. "No run directory" and "a run
      // directory that is gone" are the same fact to this recorder: nothing to
      // record into.
      const { result } = await withCapturedOutput(() => Promise.resolve(record(MISSING_RUN_DIR)));

      expect(result).toBe(0);
    });

    it('hands back the count that is really on disk when it could not write', async () => {
      const record = await recorder();

      const counted = await withUnwritableRunDir(
        (blocked) => withCapturedOutput(() => Promise.resolve(record(blocked))),
        { escalations: 1 },
      );

      // Not 2. The caller journals this number, so a recorder that returned the
      // count it MEANT to write would put a streak in the journal that the state
      // file does not carry — the next selection reads 1 and the journal says 2,
      // and the run's own trace is the thing that stops being evidence.
      expect(counted.result).toBe(1);
    });

    it.each(ADAPTER_FILES)('%s calls the recorder instead of carrying its own', async (file) => {
      const source = await read(queueDir, file);

      expect(source, `${file} does not reach run-state.mjs`).toMatch(/run-state\.mjs/);
      // The on-disk shape belongs to ONE module. An adapter that spells the file
      // name has re-derived the path, and the copy nobody looks at is the one
      // that will be wrong the day the layout moves.
      expect(source, `${file} re-derives the run state file itself`).not.toMatch(/state\.json/);
    });

    // 🔴 AR-62 round 2, from `code-reviewer`'s Q5: the three adapters all follow
    // a rule that is written down NOWHERE — **the count rises only after the
    // tracker has been mutated; where an adapter mutates no tracker, it rises
    // unconditionally.** It is not a style preference. `recordEscalation` is
    // deliberately the one call in this layer that swallows a failed write, and
    // the docstring's justification is positional: "two of the three adapters run
    // this AFTER the tracker is already mutated". An adapter that recorded FIRST
    // would collect the tolerance without the fact that earns it — the count
    // would claim an escalation the tracker never received, and the run would
    // stop two walls early on a comment that was never posted.
    //
    // A fourth adapter's author reads three files and copies whichever they open
    // first. This is the rule, at the only place it can be checked.
    const escalateBodyOf = (source: string, file: string): string => {
      const start = source.indexOf('export const escalate');
      expect(start, `${file} has no escalate export`).toBeGreaterThan(-1);
      const rest = source.indexOf('\nexport ', start + 1);
      return source.slice(start, rest === -1 ? undefined : rest);
    };

    /** How each adapter writes to its tracker — the call the count must follow. */
    const TRACKER_WRITE: Record<string, RegExp> = {
      'github-issues.mjs': /ghText\(/g,
      'jira.mjs': /await (?:request|comment)\(/g,
    };

    /** The last tracker write, and the recording, by position in one function. */
    const orderIn = (body: string, write: RegExp): { lastWrite: number; recorded: number } => ({
      lastWrite: [...body.matchAll(write)].map((m) => m.index).at(-1) ?? -1,
      recorded: body.indexOf('recordEscalation('),
    });

    it.each(Object.keys(TRACKER_WRITE))(
      '%s counts the escalation only after the tracker has taken it',
      async (file) => {
        const body = escalateBodyOf(await read(queueDir, file), file);
        const { lastWrite, recorded } = orderIn(body, TRACKER_WRITE[file]!);

        expect(lastWrite, `${file}: no tracker write found in escalate`).toBeGreaterThan(-1);
        expect(recorded, `${file}: escalate does not record`).toBeGreaterThan(-1);
        expect(
          recorded,
          `${file} records the escalation before it reaches the tracker`,
        ).toBeGreaterThan(lastWrite);
      },
    );

    it('spots an adapter that records before it writes to its tracker', async () => {
      // The check above is a source scan, and a source scan that matches nothing
      // passes everything. So it is pointed at a body shaped like the mistake it
      // exists to catch — `invariants.md`, "a check with no test is a guess".
      const violating = [
        'export const escalate = (ticket, diagnosis, { env = process.env } = {}) => {',
        '  recordEscalation(env.RIG_RUN_DIR);',
        "  ghText(['issue', 'comment', ticket.id, '--body', diagnosis]);",
        '  return { ok: true };',
        '};',
      ].join('\n');

      const { lastWrite, recorded } = orderIn(
        escalateBodyOf(violating, 'a fourth adapter'),
        TRACKER_WRITE['github-issues.mjs']!,
      );

      expect(recorded).toBeLessThan(lastWrite);
    });

    it('leaves plan-md recording first, because it has no tracker to write to', async () => {
      const body = escalateBodyOf(await read(queueDir, 'plan-md.mjs'), 'plan-md.mjs');

      // The other half of the rule, and the reason it is stated as "only after
      // the tracker has been mutated" rather than "last": a flat list has no
      // per-item state, so `plan-md.escalate` mutates nothing and there is no
      // later fact for the count to wait on. The day it grows a write, the rule
      // above applies to it too — this assertion is what notices.
      expect(body, 'plan-md.escalate now writes something; it needs the order rule').not.toMatch(
        /writeFileSync|readFileSync|await /,
      );
      expect(body).toMatch(/recordEscalation\(/);
    });
  });
});

// 🔴 AR-62 round 2. `security-scanner` reported this, the ticket's gate record
// says the fix was taken, and the fix was NOT taken: `updateState` still writes
// its temp file with a bare `writeFileSync(tmp, …)`, which follows a symlink.
// Measured on this branch, with a symlink planted at the temp name:
//
//   decoy now: "{\n  \"escalations\": 3\n}\n"
//   state.json is symlink: true
//
// Two losses in one write. The run's state is written into a file outside the run
// directory — chosen by whoever planted the link — and the rename then makes
// `state.json` ITSELF that symlink, so every later write in the run goes there
// too, and every read comes back from there. A stop input that an outside file
// can supply is a stop input that can be set to "no stop".
//
// The temp name is `state.json.<pid>.tmp` and this block spells it out on
// purpose: the guarantee under test is "a path already at the temp name is never
// written through", and a test that could not name the path could not plant one.
// A change of convention makes these fail loudly, which is the correct outcome.
//
// The second half is `code-reviewer`'s A7, and it is the same call from the other
// side: when the open SUCCEEDS and the rename fails, the temp file is left behind
// forever. Nothing ever cleans it, and the next writer with the same pid in the
// same run directory then finds the name occupied.
describe('the run state never writes through a path it did not create', () => {
  /** The path `updateState` writes before it renames. Deliberately hardcoded. */
  const tempStatePathIn = (runDir: string) => path.join(runDir, `state.json.${process.pid}.tmp`);

  /** A run directory with something already sitting at that temp name. */
  const withOccupiedTempName = async (
    plant: (tempPath: string) => Promise<void>,
  ): Promise<string> => {
    const runDir = await newRunDir();
    await plant(tempStatePathIn(runDir));
    return runDir;
  };

  /**
   * Call `body` and hand back a promise either way.
   *
   * `updateState` is synchronous today and the interface at the top of this file
   * deliberately does not pin that, so a bare `Promise.resolve(updateState(…))`
   * would let a synchronous throw escape before there is a promise to reject.
   * Nothing here should pin the Green step to one or the other.
   */
  const attempt = async (body: () => unknown): Promise<unknown> => body();

  /** A file outside the run directory, which nothing here is allowed to touch. */
  const decoyOutside = async (): Promise<string> => {
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'outside-'));
    const file = path.join(elsewhere, 'not-the-run-state.json');
    await writeFile(file, 'ORIGINAL\n');
    return file;
  };

  it('leaves the file a planted symlink points at exactly as it was', async () => {
    const { updateState } = await loadRunState();
    const decoy = await decoyOutside();
    const runDir = await withOccupiedTempName((tempPath) => symlink(decoy, tempPath));

    // The write is expected to refuse; what this test is about is where the bytes
    // did NOT go, so the refusal is caught rather than asserted here.
    await attempt(() => updateState(runDir, { escalations: 3 })).catch(() => undefined);

    expect(await read(decoy), 'the run state was written through the symlink').toBe('ORIGINAL\n');
  });

  it('never lets the state file become a symlink someone else planted', async () => {
    const { updateState } = await loadRunState();
    const decoy = await decoyOutside();
    const runDir = await withOccupiedTempName((tempPath) => symlink(decoy, tempPath));

    await attempt(() => updateState(runDir, { escalations: 3 })).catch(() => undefined);

    // The rename is what makes this permanent: one planted link, and the run's
    // whole state — the escalation count, the deploy verdict, the budget — lives
    // outside the run directory for the rest of the run.
    await expect(
      stat(path.join(runDir, 'state.json')),
      'a state file was created over an occupied temp name',
    ).rejects.toThrow();
  });

  it('refuses rather than clobbering a plain file already at the temp name', async () => {
    const { updateState } = await loadRunState();
    const runDir = await withOccupiedTempName((tempPath) =>
      writeFile(tempPath, 'SOMEONE ELSE WAS HERE\n'),
    );

    await attempt(() => updateState(runDir, { escalations: 3 })).catch(() => undefined);

    // Existence, not symlink-ness, is the condition: a guard that only checked
    // for a link would still race, and refusing every occupied name costs
    // nothing in a directory that belongs to exactly one run.
    expect(await read(tempStatePathIn(runDir))).toBe('SOMEONE ELSE WAS HERE\n');
  });

  it('reports the refusal instead of reporting a state it did not write', async () => {
    const { updateState } = await loadRunState();
    const runDir = await withOccupiedTempName((tempPath) => writeFile(tempPath, 'x\n'));

    // `run-state.mjs`'s own rule: reading is permissive, writing refuses. A write
    // that returned the merged object it never stored would hand the caller a
    // count to journal that the next selection cannot see.
    await expect(attempt(() => updateState(runDir, { escalations: 3 }))).rejects.toThrow();
  });

  it('leaves the state file readable only by the run that owns it', async () => {
    const { updateState } = await loadRunState();
    const runDir = await newRunDir();

    await updateState(runDir, { escalations: 1 });

    // The run's state names the tickets it is working and the walls it hit. On a
    // shared host the default 0644 puts that in front of every account; the same
    // write that stops following symlinks narrows it, and neither half is worth
    // shipping alone.
    const mode = (await stat(path.join(runDir, 'state.json'))).mode & 0o777;
    expect(mode & 0o077, `state.json is mode ${mode.toString(8)}`).toBe(0);
  });

  it('is not a symlink itself once an ordinary write has landed', async () => {
    const { updateState } = await loadRunState();
    const runDir = await newRunDir();

    await updateState(runDir, { escalations: 1 });

    // The other direction of the two tests above: the ordinary path still
    // produces a real file with the real contents, so the fix cannot be "never
    // write anything".
    expect((await lstat(path.join(runDir, 'state.json'))).isSymbolicLink()).toBe(false);
    expect(await runStateOf(runDir)).toEqual({ escalations: 1 });
  });

  // --- A7: the open succeeded, the rename did not ------------------------------
  //
  // Forced with a DIRECTORY at `state.json`: the temp write succeeds, and
  // `renameSync` then fails with EISDIR. That is the one ordering the EACCES case
  // already under test cannot produce, and it is the one that leaks.
  const withUnrenameableState = async (runDir: string) =>
    mkdir(path.join(runDir, 'state.json'), { recursive: true });

  it('leaves no temp file behind when the rename it wrote for fails', async () => {
    const { updateState } = await loadRunState();
    const runDir = await newRunDir();
    await withUnrenameableState(runDir);

    await attempt(() => updateState(runDir, { escalations: 1 })).catch(() => undefined);

    // A leaked `state.json.<pid>.tmp` is not cosmetic here: nothing in this rig
    // ever removes it, and the `wx` open that closes the symlink hole above turns
    // the leftover into a run directory that can never be written to again.
    expect(await readdir(runDir)).toEqual(['state.json']);
  });

  it('still reports the failed rename rather than returning a state it lost', async () => {
    const { updateState } = await loadRunState();
    const runDir = await newRunDir();
    await withUnrenameableState(runDir);

    await expect(attempt(() => updateState(runDir, { escalations: 1 }))).rejects.toThrow();
  });

  // --- and the one caller that must survive all of it --------------------------
  //
  // `recordEscalation` runs AFTER the tracker has been commented and labelled, so
  // it swallows a failed write by design. These two pin that the refusals above
  // arrive there as the tolerated case they already handle, rather than as a
  // thrown error that turns a successful escalation into a retry — and a retry
  // double-posts the diagnosis onto the item.
  it('counts an escalation it could not record without throwing at the adapter', async () => {
    const { recordEscalation } = (await loadRunState()) as unknown as {
      recordEscalation: (runDir?: string) => number | Promise<number>;
    };
    const runDir = await withOccupiedTempName((tempPath) => writeFile(tempPath, 'x\n'));
    await writeRunState(runDir, { escalations: 1 });

    const { result, stderr, stdout } = await withCapturedOutput(() =>
      attempt(() => recordEscalation(runDir)),
    );

    // The count on disk, not the count it meant to write: the caller journals
    // this number, and a journal claiming a streak the state file does not carry
    // is the run's own trace ceasing to be evidence.
    expect(result).toBe(1);
    expect(stderr, 'the failed write was swallowed silently').toMatch(/escalation/i);
    expect(stdout, 'a caller parsing stdout would get this line in its JSON').toBe('');
    expect(await runStateOf(runDir)).toEqual({ escalations: 1 });
  });

  it('leaves no temp file behind at the adapter either', async () => {
    const { recordEscalation } = (await loadRunState()) as unknown as {
      recordEscalation: (runDir?: string) => number | Promise<number>;
    };
    const runDir = await newRunDir();
    await withUnrenameableState(runDir);

    await withCapturedOutput(() => attempt(() => recordEscalation(runDir)));

    expect(await readdir(runDir)).toEqual(['state.json']);
  });
});

// AR-62: "`post-deploy-verify`'s verdict is recorded by a one-line CLI". The
// verdict is the one stop input that is produced OUTSIDE the queue's own code —
// a human or a skill looks at a deployed surface and reaches a binary conclusion
// (`autonomy.md`, "Post-deploy verification") — so it needs an entry point that
// is one line of shell, or it goes on being remembered.
//
// 🔴 The pairing is the point. A writer with no reader is a file nobody consults;
// this block asserts the write AND the `queue next` that stops because of it.
describe('the deploy verdict is recorded by a CLI the next selection reads', () => {
  const runStateScript = path.join(universal, '.claude', 'scripts', 'run-state.mjs');
  const recordVerdict = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
    runNode(runStateScript, args, cwd, env);

  it('writes a REGRESSION verdict where the queue CLI looks for it', async () => {
    const { dir, runDir, env } = await runProject();

    const written = await recordVerdict(['deploy', 'REGRESSION'], dir, env);

    expect(written.code, written.out).toBe(0);
    expect(await runStateOf(runDir)).toMatchObject({ lastDeployVerdict: 'REGRESSION' });
  });

  it('stops the very next selection on the verdict it just recorded', async () => {
    const { dir, configPath, env } = await runProject();

    await recordVerdict(['deploy', 'REGRESSION'], dir, env);
    const result = await runCli(['next', '--config', configPath], dir, env);

    // Verbatim from the item's proof line: one line of shell, and the run stops.
    expect(result.out).toContain('queue: runtime regression (needs attention)');
    expect(result.out).not.toMatch(/add a route/);
  });

  it('records a healthy verdict and lets the run carry on', async () => {
    const { dir, configPath, runDir, env } = await runProject();

    const written = await recordVerdict(['deploy', 'HEALTHY'], dir, env);

    expect(written.code, written.out).toBe(0);
    expect(await runStateOf(runDir)).toMatchObject({ lastDeployVerdict: 'HEALTHY' });
    const result = await runCli(['next', '--json', '--config', configPath], dir, env);
    expect(result.code, result.out).toBe(0);
    expect((JSON.parse(result.stdout) as { ticket: Ticket | null }).ticket?.title).toBe(
      'add a route',
    );
  });

  it('lets a later healthy verdict clear the regression that stopped the run', async () => {
    const { dir, configPath, runDir, env } = await runProject();

    await recordVerdict(['deploy', 'REGRESSION'], dir, env);
    await recordVerdict(['deploy', 'HEALTHY'], dir, env);

    expect(await runStateOf(runDir)).toMatchObject({ lastDeployVerdict: 'HEALTHY' });
    const result = await runCli(['next', '--json', '--config', configPath], dir, env);

    // The field is `lastDeployVerdict`, and "last" is the whole of it: the answer
    // to a regression is to revert and deploy again, so a verdict with nothing
    // that clears it would end the run at its first bad deploy with no way back —
    // and the operator would reach for hand-editing the state file instead.
    expect(result.code, result.out).toBe(0);
    expect((JSON.parse(result.stdout) as { ticket: Ticket | null }).ticket?.title).toBe(
      'add a route',
    );
  });

  it('normalises the verdict to the one spelling the stop condition compares against', async () => {
    const { dir, runDir, env } = await runProject();

    await recordVerdict(['deploy', 'regression'], dir, env);

    // `stopConditionOf` compares with `===` against `'REGRESSION'` exactly, so a
    // verdict stored as typed would be a verdict that matches nothing. Case is
    // not a typo of meaning — the operator who types it lowercase meant it — but
    // the value on disk has to be canonical, or the file lies to its only reader.
    expect(await runStateOf(runDir)).toMatchObject({ lastDeployVerdict: 'REGRESSION' });
  });

  it('leaves the rest of the run state alone when it records a verdict', async () => {
    const { dir, runDir, env } = await runProject();
    await writeRunState(runDir, { escalations: 1, budget: { declared: 12, used: 7 } });

    await recordVerdict(['deploy', 'REGRESSION'], dir, env);

    // The same whole-file-overwrite trap the close step is pinned against. A
    // verdict that erased the escalation streak would silently un-stop a run.
    expect(await runStateOf(runDir)).toMatchObject({
      escalations: 1,
      budget: { declared: 12, used: 7 },
      lastDeployVerdict: 'REGRESSION',
    });
  });

  // --- what it refuses, and why refusing is the safe direction here -----------
  //
  // Reading is permissive on purpose (`readState` turns a corrupt file into `{}`)
  // because an absent input is a defined state. WRITING is the opposite: a write
  // that lands nowhere, or lands a word nothing compares equal to, leaves the
  // operator believing a verdict was recorded when the run will select work as if
  // the deploy never happened. There is no defined meaning for that, so it fails
  // loudly instead.

  /** The refusals: each must exit non-zero, say why, and write nothing at all. */
  const REFUSALS: Array<[string, string[], RegExp]> = [
    ['a verdict outside the vocabulary', ['deploy', 'REGRESSED'], /REGRESSION|HEALTHY/],
    ['a verdict that is only a typo away', ['deploy', 'REGRESSIONN'], /REGRESSION|HEALTHY/],
    ['no verdict at all', ['deploy'], /REGRESSION|HEALTHY/],
    ['an empty verdict', ['deploy', ''], /REGRESSION|HEALTHY/],
    ['a command it does not have', ['frobnicate'], /deploy/],
    ['no command at all', [], /deploy/],
  ];

  it.each(REFUSALS)('refuses %s', async (_case, args, message) => {
    const { dir, runDir, env } = await runProject();
    await writeRunState(runDir, { escalations: 1 });

    const written = await recordVerdict(args, dir, env);

    expect(written.code, `exited 0 for: ${args.join(' ')}`).not.toBe(0);
    expect(written.out).toMatch(message);
    // and it refuses without writing: a half-recorded verdict is the thing the
    // refusal exists to prevent, so the state is exactly as it was found.
    expect(await runStateOf(runDir)).toEqual({ escalations: 1 });
  });

  it('refuses when the run declared no directory to record into', async () => {
    const { dir } = await runProject();
    const env = withoutGitLocation();
    delete env['RIG_RUN_DIR'];

    const written = await recordVerdict(['deploy', 'REGRESSION'], dir, env);

    // Unlike a READ, which treats "no run directory" as "nothing recorded yet",
    // a write has nowhere to go. Exiting 0 here would tell the operator the
    // regression was filed while the next selection hands out new work on top of
    // it — the single outcome `autonomy.md` calls out as never fix-forward.
    expect(written.code, written.out).not.toBe(0);
    expect(written.out).toMatch(/RIG_RUN_DIR/);
  });
});

// AR-62 follow-up: `budgetExhausted` is the one stop input left with a reader and
// no writer — the AR3-36 defect, one field over, for the third time.
//
// `index.mjs:282` feeds `runState.budgetExhausted` into `stopConditionOf`, whose
// `budget` branch (`core.mjs:511`) is live. NOTHING SETS IT. `run-state.mjs`'s CLI
// says so in its own refusal message — "This CLI has one: `deploy …`" — so a
// session that follows §4 of the loop skill and `preflight.mjs:32` ("a budget is
// declared … written down somewhere the run can re-read") writes a `budget`
// object that no reader consults, and the stop it believes it armed can never
// fire. A declared budget then holds exactly as well as the session's memory of
// it, which is to say: until the first compaction.
//
// The verdict CLI beside it is the shape to mirror — one line of shell, refusing
// rather than writing a value the stop condition cannot match.
describe('an exhausted budget is recorded by the same CLI the deploy verdict is', () => {
  const runStateScript = path.join(universal, '.claude', 'scripts', 'run-state.mjs');
  const recordBudget = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
    runNode(runStateScript, args, cwd, env);

  it('writes the exhausted flag where the queue CLI looks for it', async () => {
    const { dir, runDir, env } = await runProject();

    const written = await recordBudget(['budget', 'exhausted'], dir, env);

    expect(written.code, written.out).toBe(0);
    // 🔴 The TOP-LEVEL field, spelled the way its only reader reads it. §4 of the
    // skill described a `budget` object that `stopConditionOf` reads
    // `budgetExhausted` out of — it does not, and a flag written one level down
    // is a flag nothing consults.
    expect(await runStateOf(runDir)).toMatchObject({ budgetExhausted: true });
  });

  it('stops the very next selection on the budget it just recorded', async () => {
    const { dir, configPath, env } = await runProject();

    await recordBudget(['budget', 'exhausted'], dir, env);
    const result = await runCli(['next', '--config', configPath], dir, env);

    expect(result.out).toContain('queue: budget');
    expect(result.out).not.toMatch(/add a route/);
    // A budget stop is `success: true` in `stopConditionOf` — a run that stopped
    // where it said it would is a clean stop, and `renderNext` appends the
    // needs-attention marker only to the other kind. An operator who reads this
    // as a failure goes looking for a defect that is not there.
    expect(result.out).not.toContain('needs attention');
  });

  it('leaves the rest of the run state alone when it records the budget', async () => {
    const { dir, runDir, env } = await runProject();
    await writeRunState(runDir, { escalations: 1, lastDeployVerdict: 'HEALTHY' });

    await recordBudget(['budget', 'exhausted'], dir, env);

    // The same whole-file-overwrite trap the close step and the verdict are
    // already pinned against: a budget that erased the escalation streak would
    // silently un-stop a run that had hit two walls.
    expect(await runStateOf(runDir)).toMatchObject({
      escalations: 1,
      lastDeployVerdict: 'HEALTHY',
      budgetExhausted: true,
    });
  });

  it('takes the word in any case, exactly as the verdict beside it does', async () => {
    const { dir, runDir, env } = await runProject();

    const written = await recordBudget(['budget', 'EXHAUSTED'], dir, env);

    // One CLI, one convention. `deploy regression` is normalised rather than
    // refused because case is not a typo of meaning; a sibling command that
    // refused the same operator's shift key would be a foot-gun made of nothing.
    expect(written.code, written.out).toBe(0);
    expect(await runStateOf(runDir)).toMatchObject({ budgetExhausted: true });
  });

  it('names both of its commands when it is handed neither', async () => {
    const { dir, env } = await runProject();

    const written = await recordBudget(['frobnicate'], dir, env);

    expect(written.code, written.out).not.toBe(0);
    // The refusal is the CLI's own index, and today it states "This CLI has one".
    // A second command that does not appear there is a command nobody finds.
    expect(written.out).toMatch(/deploy/);
    expect(written.out).toMatch(/budget/);
  });

  // --- the vocabulary, and the word that is deliberately absent from it -------
  //
  // 🔴 DECISION: `budget` has NO clearing word, and the asymmetry with `deploy`
  // is the point rather than an oversight.
  //
  // `lastDeployVerdict` is about the LAST deploy, and "last" is re-decidable by
  // definition: the answer to a regression is to revert and deploy again, in the
  // same run, so without `HEALTHY` one bad deploy would end every later selection
  // with no way back. A budget is not that shape. It is a per-RUN declaration
  // (`run-state.mjs`'s header: "a declared budget belongs to this run"), spend
  // only accumulates, and nothing a run does later refunds it — so "un-exhaust
  // it" describes no event that can occur. The remedy is already there and it is
  // cheaper: a new run gets a new run directory and therefore a clean state.
  //
  // The cost of adding one anyway is specific: `budget` is the single stop a run
  // can lift on its own authority, and §4 exists precisely because a run
  // reasoning about its own budget will believe a number it wrote. A word that
  // un-declares the stop is a word that will be used to keep going.
  const REFUSALS: Array<[string, string[]]> = [
    ['a word outside the vocabulary', ['budget', 'spent']],
    ['no word at all', ['budget']],
    ['an empty word', ['budget', '']],
    ['a word that would un-exhaust it', ['budget', 'available']],
    ['the verdict CLI’s clearing word, borrowed', ['budget', 'HEALTHY']],
    ['a word that reads like a reset', ['budget', 'reset']],
  ];

  it.each(REFUSALS)('refuses %s', async (_case, args) => {
    const { dir, runDir, env } = await runProject();
    await writeRunState(runDir, { escalations: 1 });

    const written = await recordBudget(args, dir, env);

    expect(written.code, `exited 0 for: ${args.join(' ')}`).not.toBe(0);
    // It says which word it wanted, so the operator's next attempt is the right
    // one rather than a second guess.
    expect(written.out).toMatch(/exhausted/i);
    // and it refuses without writing: a half-recorded budget is the thing the
    // refusal exists to prevent, so the state is exactly as it was found.
    expect(await runStateOf(runDir)).toEqual({ escalations: 1 });
  });

  it('has no word that lifts a budget stop once the run has declared it', async () => {
    const { dir, configPath, runDir, env } = await runProject();
    const declared = await recordBudget(['budget', 'exhausted'], dir, env);
    expect(declared.code, declared.out).toBe(0);

    for (const word of ['available', 'remaining', 'ok', 'healthy', 'reset', 'false']) {
      const written = await recordBudget(['budget', word], dir, env);
      expect(written.code, `\`budget ${word}\` was accepted`).not.toBe(0);
    }

    // The flag is still set and the run is still stopped — which is the whole
    // claim: within one run, exhausted is one-way.
    expect(await runStateOf(runDir)).toMatchObject({ budgetExhausted: true });
    const result = await runCli(['next', '--config', configPath], dir, env);
    expect(result.out).toContain('queue: budget');
  });

  it('refuses when the run declared no directory to record into', async () => {
    const { dir } = await runProject();
    const env = withoutGitLocation();
    delete env['RIG_RUN_DIR'];

    const written = await recordBudget(['budget', 'exhausted'], dir, env);

    // Same reasoning as the verdict: a write has nowhere to go, and exiting 0
    // would tell the session its budget was filed while the next selection hands
    // out another task on top of it.
    expect(written.code, written.out).not.toBe(0);
    expect(written.out).toMatch(/RIG_RUN_DIR/);
  });
});

// AR-62: "`triggersFired` moves out of `queue.json` into state". Today
// `index.mjs:321` reads `config.triggersFired`, and `.claude/queue.json` is
// COMPOSED by `scripts/sync-agent-os.mjs` and drift-checked — so declaring that a
// trigger fired means editing a generated file, which `dogfood.test.ts` then
// fails. The same trap the tier fell into (AR3-36), on the one field still in it.
//
// 🔴 Nothing in this repository or in `templates/` writes `config.triggersFired`:
// the shipped config is `{"adapter":"plan-md"}` and this repo's is the jira
// override. So the migration has no data to move — but a rig that hand-added one
// would silently stop firing its triggers, and an auto-trigger item that stops
// being selectable leaves no message anywhere. The config therefore stays
// readable as a FALLBACK, exactly as `lastCompletedTier` did when it moved out
// (`index.mjs:320`), and the run state wins.
describe('a fired trigger is declared in the run state, not in the generated config', () => {
  const AUTO_ITEM =
    '# P\n\n## Agent queue\n\n- scale the worker pool [trigger-auto]\n\n## Journal\n';

  const selectionFrom = async (project: {
    dir: string;
    configPath: string;
    env: NodeJS.ProcessEnv;
  }): Promise<{ ticket: Ticket | null; stop: { kind: string } | null }> => {
    const result = await runCli(
      ['next', '--json', '--config', project.configPath],
      project.dir,
      project.env,
    );
    return JSON.parse(result.stdout) as { ticket: Ticket | null; stop: { kind: string } | null };
  };

  it('takes an auto-trigger item once the run state says its trigger fired', async () => {
    const project = await runProject(AUTO_ITEM);
    await writeRunState(project.runDir, { triggersFired: { '1': true } });

    expect((await selectionFrom(project)).ticket?.title).toBe('scale the worker pool');
  });

  it('holds the item back while nothing has declared the trigger', async () => {
    const project = await runProject(AUTO_ITEM);

    const selection = await selectionFrom(project);

    // Unverified must read as "not fired", never as "unknown, so go ahead" — the
    // trigger is the item's own precondition.
    expect(selection.ticket).toBeNull();
    expect(selection.stop?.kind).toBe('nothing-selectable');
  });

  it('still honours a declaration left in the queue config, so an existing rig keeps firing', async () => {
    const project = await runProject(AUTO_ITEM, { triggersFired: { '1': true } });

    // No run state at all: the config is the only answer there is, and dropping
    // it outright would stop a hand-configured trigger with nothing printed.
    await expect(read(project.runDir, 'state.json')).rejects.toThrow();
    expect((await selectionFrom(project)).ticket?.title).toBe('scale the worker pool');
  });

  it('replaces the config declaration rather than merging with it', async () => {
    const project = await runProject(AUTO_ITEM, { triggersFired: { '1': true } });
    await writeRunState(project.runDir, { triggersFired: {} });

    // A run that declared its triggers has said which ones fired IN THIS RUN, and
    // a per-key merge would make a stale config entry undeclarable — there would
    // be no way to say "not this time" short of editing the generated file, which
    // is the thing this field is moving out of.
    expect((await selectionFrom(project)).ticket).toBeNull();

    const other = await runProject(AUTO_ITEM, { triggersFired: { '1': true } });
    await writeRunState(other.runDir, { triggersFired: { '2': true } });
    expect((await selectionFrom(other)).ticket).toBeNull();
  });
});

// AR-62 follow-up, and the same shape a third time: the READER moved and the
// WRITER did not. `index.mjs` now prefers `runState.triggersFired` over
// `config.triggersFired` — and nothing in this repository or its templates writes
// the run-state field. No CLI command, no documented edit. So the move that took
// the declaration out of the generated `queue.json` left the only remaining way
// to fire a trigger inside the generated file it was moving out of, and a
// `trigger-auto` item that stops being selectable announces itself nowhere.
//
// The deploy verdict and the budget flag are the shape to mirror: one line of
// shell, merged into the state, refusing rather than writing where nothing reads.
describe('a fired trigger is recorded by the same CLI the verdict and the budget are', () => {
  const runStateScript = path.join(universal, '.claude', 'scripts', 'run-state.mjs');
  const fireTrigger = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
    runNode(runStateScript, args, cwd, env);

  const AUTO_ITEM =
    '# P\n\n## Agent queue\n\n- scale the worker pool [trigger-auto]\n\n## Journal\n';

  it('writes the fired trigger where the queue CLI looks for it', async () => {
    const { dir, runDir, env } = await runProject(AUTO_ITEM);

    const written = await fireTrigger(['trigger', '1'], dir, env);

    expect(written.code, written.out).toBe(0);
    // Keyed by the item's id, `true` — the shape `selectNext` already reads and
    // the one the existing hand-written fixtures use.
    expect(await runStateOf(runDir)).toMatchObject({ triggersFired: { '1': true } });
  });

  it('makes the auto-trigger item selectable on the very next selection', async () => {
    const { dir, configPath, env } = await runProject(AUTO_ITEM);

    await fireTrigger(['trigger', '1'], dir, env);
    const result = await runCli(['next', '--json', '--config', configPath], dir, env);

    // The pairing, which is the whole item: a writer whose value the reader does
    // not consult is the defect being closed, not the fix for it.
    expect(result.code, result.out).toBe(0);
    expect((JSON.parse(result.stdout) as { ticket: Ticket | null }).ticket?.title).toBe(
      'scale the worker pool',
    );
  });

  it('adds to the triggers already fired rather than replacing them', async () => {
    const { dir, runDir, env } = await runProject(AUTO_ITEM);
    await writeRunState(runDir, { triggersFired: { '2': true } });

    await fireTrigger(['trigger', '1'], dir, env);

    // 🔴 The one place a MERGE is right, and it is the opposite of the choice
    // `index.mjs` makes against the config. A run declares its triggers one at a
    // time, as each is verified; a writer that replaced the map would un-fire
    // every earlier declaration on each new one, and the item that stopped being
    // selectable would say nothing about why.
    expect(await runStateOf(runDir)).toMatchObject({
      triggersFired: { '1': true, '2': true },
    });
  });

  it('leaves the rest of the run state alone when it records a trigger', async () => {
    const { dir, runDir, env } = await runProject(AUTO_ITEM);
    await writeRunState(runDir, { escalations: 1, lastDeployVerdict: 'HEALTHY' });

    await fireTrigger(['trigger', '1'], dir, env);

    // The same whole-file-overwrite trap the close step, the verdict and the
    // budget are each pinned against: a trigger that erased the escalation streak
    // would silently un-stop a run that had hit two walls.
    expect(await runStateOf(runDir)).toMatchObject({
      escalations: 1,
      lastDeployVerdict: 'HEALTHY',
      triggersFired: { '1': true },
    });
  });

  it('refuses when it is handed no item to fire the trigger for', async () => {
    const { dir, runDir, env } = await runProject(AUTO_ITEM);
    await writeRunState(runDir, { triggersFired: { '2': true } });

    const written = await fireTrigger(['trigger'], dir, env);

    // A bare `trigger` has no defensible meaning, and the two candidate readings
    // are opposites — "fire nothing" is a no-op that exits 0 while the session
    // believes it declared something, and "fire everything" hands the run every
    // conditional item in the queue. It refuses instead, and writes nothing.
    expect(written.code, written.out).not.toBe(0);
    expect(written.out).toMatch(/item|id/i);
    expect(await runStateOf(runDir)).toEqual({ triggersFired: { '2': true } });
  });

  it('refuses when the run declared no directory to record into', async () => {
    const { dir } = await runProject(AUTO_ITEM);
    const env = withoutGitLocation();
    delete env['RIG_RUN_DIR'];

    const written = await fireTrigger(['trigger', '1'], dir, env);

    // Same reasoning as its two siblings: a write has nowhere to go, and exiting
    // 0 would tell the session its trigger was declared while the next selection
    // holds the item back — an item silently not offered, which is the failure
    // mode with no message anywhere.
    expect(written.code, written.out).not.toBe(0);
    expect(written.out).toMatch(/RIG_RUN_DIR/);
  });

  it('names all three of its commands when it is handed none of them', async () => {
    const { dir, env } = await runProject(AUTO_ITEM);

    const written = await fireTrigger(['frobnicate'], dir, env);

    expect(written.code, written.out).not.toBe(0);
    // The refusal is this CLI's own index — a command that does not appear in it
    // is a command nobody finds, and the session goes back to hand-editing the
    // state file this writer exists to replace.
    expect(written.out).toMatch(/deploy/);
    expect(written.out).toMatch(/budget/);
    expect(written.out).toMatch(/trigger/);
  });

  it('is the command the loop skill tells a run to use, in a block it can run', async () => {
    const content = await read(universal, '.claude', 'skills', 'loop', 'SKILL.md');
    const blocks = [...content.matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gm)].map(
      (fence) => fence[1] ?? '',
    );

    // §2 already says a fired trigger "is recorded in the run state, keyed by the
    // item's id" — described, not commanded. A field described in prose gets
    // hand-written into a shape nothing reads; a command lands where the reader
    // looks. The same pairing the deploy verdict and the budget already have, and
    // a sentence is not a caller: only an executable block counts.
    expect(
      blocks.filter((block) => /run-state\.mjs\s+trigger\b/.test(block)),
      'no executable block records the trigger the skill tells the run to verify',
    ).not.toHaveLength(0);
  });
});

// A module the manifest does not name is a module composition DROPS — and this one
// is imported by the CLI, so a generated project would ship a `queue next` that
// crashes on its first run. The same test exists for `state.mjs` and
// `checkout.mjs` above, for the same reason and after the same near-miss.
describe('composition carries the run state module', () => {
  it('layers.json names the module the queue CLI reads the run state through', async () => {
    const manifest = JSON.parse(await read(universal, 'layers.json')) as Record<string, string[]>;
    expect(manifest['process']).toContain('.claude/scripts/run-state.mjs');
  });
});
