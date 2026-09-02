# Why the queue's cost guards bound a cost and not a growth ratio

⚠ **This record is not synced.** Most files in this directory are composed
from `templates/agent-os/universal/docs/decisions/` by `scripts/sync-agent-os.mjs`
and travel into every generated project; the exceptions are this record and
`memory-rig-boundary.md`, which carries the same banner for the same reason.
This one is authored here and stays
here: the guard it explains is `test/template/queue.test.ts`, a test of the
**generator**, and no rule in the shipped rulebook cites it. Editing it in the
template directory would make it a record no generated rulebook points at, which
`test/template/decision-records.test.ts` refuses on purpose. Edit it in place.

The guard is the pair of cost tests in `test/template/queue.test.ts` over
`hygieneOf` (`.claude/scripts/queue/core.mjs`) and `oneLine`
(`.claude/scripts/queue/plan-md.mjs`). This file records the trade the third
repair of that apparatus made, because the AR-95 item that ordered the repair told
us not to relax the axis we ended up relaxing, and a decision that large should
not be discoverable only by reading a diff.

## What the apparatus is for

Both functions run on attacker-writable text — an issue body on a public tracker,
a proposal's field — once per item per selection. Both have grown the same
quadratic regex shape four times: an unbounded whitespace quantifier in front of
a class that is a subset of whitespace, which re-splits a whitespace run at every
offset. Restored today it measures **1,678–2,299 ms** per call on a 32k body,
against **0.02–0.09 ms** healthy. The guard exists to make that class impossible
to reintroduce quietly.

## Three failures, and what each one proved

1. **An absolute millisecond budget over one untimed sample** —
   `expect(elapsed).toBeLessThan(250)`. CI run 31956613905 failed at **328.73 ms**
   on correct code doing ~0.1 ms of work: ~99.9% of the reading was a scheduler
   pause landing inside the single sample. Proved that one sample is not a
   measurement.
2. **A growth ratio, `cost(4n)/cost(n)`, bounded at 8.** CI run 32004364990 failed
   on `master` at **8.07×** on a tree that had passed the identical measurement
   twice on its PR and five times locally. Load arriving *between* the two
   measurements makes every sample of the large side dear. Proved that a ratio can
   be poisoned through its denominator.
3. **The repair for (2) — interleave the sides, take the cheapest of three pairs.**
   Measured against a genuinely quadratic subject, it passed at **2.15×** against
   the same bound of 8; a median of the pairs gives 2.21× and fails the same way.
   Noise in a denominator *shrinks* a ratio, so a minimum selects exactly the pair
   where the defect is masked. Proved the decisive thing: the repair converted a
   loud failure into a **silent** one.

That third measurement is why the ratio was deleted rather than tuned. It is also
evidence the AR-95 item did not have when it was written.

## Two more attempts, and why the answer ended up being subtraction

4. **Per-shape absolute ceilings, measured by the fastest of nine adaptively
   batched samples.** This worked — 25 consecutive green runs, 5 of them under 8
   saturating processes — but it cost a probe, a sizing helper, a resizer, an
   in-sample deadline, a collapsed-batch diagnostic and ~400 lines of comments
   carrying several dozen measured figures. Every review round found something in
   it, and never once in the code being guarded: a precondition that fired before
   the ceiling on real defects and advised widening the measurement; a docblock
   stale by 10–200×; a margin quoted at ~78× that measured 13.5×; a fixture that
   made the reading depend on how fast the machine was. Raising one constant from 1
   to 100 falsified about ten sentences at once.
5. **The deletion.** Each mechanism was a new surface, and each figure in a comment
   was a promise that expired the next time a constant moved. `invariants.md` names
   the exit: *prefer deleting a rule to adding one — subtraction cannot introduce
   this class of defect; addition routinely does.*

## The decision

**One coarse ceiling, and the fastest of three raw calls as the statistic.**

    healthy       0.02–9.6 ms per call
    catastrophic  1,678–2,299 ms per call
    ceiling       1,000 ms

The two states this guard has ever needed to separate are two orders of magnitude
apart, so a single number in the gap needs no batching, no sizing, no distribution
and no table. Noise cannot manufacture a pass — a pause only ever adds time, so a
reading under the ceiling bounds the truth — and a false red needs ~990 ms of stall
inside all three timed calls.

One ceiling rather than one per shape, even though the shapes are 110× apart in
honest cost (`hygieneOf`'s bracket run is 9.6 ms where its whitespace shapes are
0.087 ms): at a ceiling of 1,000 ms even the dearest healthy shape is 100× clear,
so per-shape numbers bought precision this bound does not need — and each of them
was a figure that could go stale.

**Nothing here is measured at test time except one duration against one constant.**
That is the property that ends the repair cycle, and it is worth more than the
precision it gives up.

## What it costs, stated plainly

**Sensitivity on the superlinear axis, by four orders of magnitude.** The retired
ratio fired once a superlinear term reached parity with the linear one — about
**+0.09 ms**. This ceiling fires at **+1,000 ms**. So `n log n`, `n^1.5`, and any
quadratic term short of catastrophic all pass silently.

**And that is the axis AR-95 told us not to relax.** Its words: *"Do not simply
bump 8 to 10 — that is the move that would have been made twice before and is why
this is here a third time."* A bump from 8 to 10 is a 1.25× relaxation of the same
sensitivity this change relaxes by ~10,000×. The item named two directions — widen
the ratio from a measured distribution, or stop timing and count operations — and
this is neither. **This is the decision the item did not authorise, taken
deliberately and recorded here rather than left in a diff**; the owner chose it on
17 Aug, after the fourth repair produced a finding on every review round without
ever finding one in the guarded code.

The trade is taken anyway, for one reason: **the ratio's sensitivity was not real.**
Measurement (3) shows it passing a genuinely quadratic subject at 2.15×. A guard
that is sensitive in principle and silently blind in practice is worse than a
coarse guard that fails loudly, because only the second one can be trusted when it
is green.

## Why the blind spot is empty today, and how we would know it stopped being

Both guarded functions are one bounded quantifier over one class. A backtracking
blow-up there rescans the whole run, so the cost is `n²` × engine step ≈ seconds at
32k — never tens or hundreds of milliseconds. Landing under the ceiling needs an
effective quadratic window well short of the input, which a single quantifier over a
homogeneous 32k run cannot produce. Verified by mutation: every regex mutation measured on these
two functions is either linear (~4× growth, ≤10 ms) or catastrophic
(1,678–2,299 ms). The one mutation that looked superlinear in an earlier review —
unbounding the quantifiers in `BLOCKER_IN_BODY` — measured `0.0472 / 0.1879 /
0.7564 ms` at 8k/32k/128k against a baseline of `0.0220 / 0.0842 / 0.3422 ms`:
cleanly linear, a 2.2× constant factor, which neither the old ratio nor the new
ceiling would have caught.

So the gap is empty **because of what these two functions are**, not because
superlinear-but-cheap defects are impossible. Two things would end that:

- **a hand-written loop** over the body in either module, which can be quadratic
  with a small constant;
- **a regex with a bounded inner window** (`{0,4000}`-style) around an ambiguous
  split, which caps the blow-up inside the gap.

## The revision trigger

If a defect of this class is ever found **inside** the gap — superlinear and under
the ceiling — the answer is **not** a lower ceiling. Lowering it walks straight back
into the flake band that produced failures 1 through 3, and the mechanisms that made
a tight bound survivable are exactly what failure 4 cost too much to keep.

The answer is to stop timing: assert the *shape* deterministically — no unbounded
quantifier in front of a class that is a subset of the previous one, no nested
ambiguous split — which is decidable from the source, costs nothing, and cannot
flake. That is AR-95's direction 2, deferred rather than rejected, and it is the only
remaining move that makes this guard finer without making it fragile again.

**It has no ticket.** The loop may not file its own work, so it lives here and in
this paragraph only. If the gap ever matters, this is the thing to build.

## What the guards do NOT claim

- **The public path is not bounded by them.** The fold guard measures `oneLine`
  directly, because measuring through `proposeTriage` measured the plan file it
  rewrites per call: the plan grew as the measurement ran (3,737 calls, 431 KB),
  the reading inflated ~11×, and a *faster* machine produced a *dearer* reading —
  the runner-dependence the whole apparatus exists to escape, re-entered through
  the fixture. A defect in the plan I/O itself needs its own guard.
- **The tail above 32k is not measured.** The fixtures are 32k where the tracker's
  body cap is 64k, so a defect that only turns superlinear above 32k is invisible.
  Nothing known lives there: the one defect this class has produced is already four
  orders of magnitude over the ceiling at 32k.
