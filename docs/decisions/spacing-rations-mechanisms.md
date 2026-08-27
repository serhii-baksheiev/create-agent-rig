# Why the elevated ration counts mechanisms and not documents

The rule lives in the `loop` skill, section 2; the code is
`.claude/scripts/queue/state.mjs` (which tier a close records) and
`.claude/scripts/queue/core.mjs` (which tiers clear the ration). This file
explains why the elevated tier splits in two, why only one half spaces the next
item, and why an unrecognised tier holds. It is not loaded into any session.

## What the ration was bought for

The rule's own sentence names it: _one **unreviewed** schema or permissions
change is recoverable; a chain of them compounding overnight is not._ Two words
in it do the work. **Unreviewed** — the risk is an unattended run stacking
changes nobody read. **Compounding** — the second change lands on top of what the
first one did, so the damage is not additive but multiplied.

A rulebook document satisfies neither. It is reviewed on the model lane by two
cold readers, and it compounds into nothing overnight because no runtime
executes it. Yet in any repository whose rulebook lives under a declared
elevated path — every rig, by construction — a `.md` close recorded the same
`elevated` as a migration and held the next item exactly as hard.

Two measurements on this repository forced the change, and they are different
facts — the second is the mechanism's own report, the first is not:

- The `loop` run of 2026-08-17 hit `nothing-selectable` with **56 takeable items
  held, 53 of them by spacing** — the count `queue/index.mjs next` printed, so
  this one is the ration speaking. It holds on the item's **marker**, which is
  what those 53 carried. ⚠ Not reproducible from this repository: the queue is
  tracker-backed and the run's own record is under the gitignored
  `.claude/runs/`, so this figure is a report, not a check anyone can re-run.
- Earlier, the AR-63 run recorded (journal, 2026-08) that of 58 selectable items
  **56 were elevated in fact — by declared path** — 31 of them marked so and 25
  marked `normal` while their own bodies named an elevated path. That is a
  measurement of the queue, not of the ration: it says the pressure is not going
  to ease, because a rig's rulebook lives under a declared path by construction.

Together: the ration was not pacing the project, it was halting it, and the halt
was indistinguishable from the rule working.

## The split, and where it does NOT apply

`recordCompletedTier` classifies the elevated paths a close actually crossed:

| what the close crossed | tier recorded | effect on the next elevated item |
| --- | --- | --- |
| every elevated path is a document | `elevated-prose` | clears the ration |
| any elevated path is not | `elevated-mechanism` | spaces it |
| no elevated path at all | `normal` | clears the ration |

⚠ **"Elevated path" is the sweep's answer, not the diff's.** `elevatedPathsIn`
drops inert paths *before* this classification runs, and a non-rulebook `.md` is
inert — so `scripts/notes.md` under a declared directory records `normal`, not
`elevated-prose`. In practice the only markdown that ever reaches the split is
**rulebook** markdown: `CLAUDE.md` anywhere, everything under `.claude/`, and the
decision records. That is pre-existing sweep behaviour, restated here because the
table above reads more broadly than the code behaves.

The predicate is `executesNothing` — **`.md` only** — and it lives in
`detect-missed-gate.mjs` beside the sweep's own markdown test so the two cannot
drift apart.

**They are different tests on purpose, and `.mdx` is where they part.** The
sweep asks *does this need a reviewer* and calls both flavours inert. The ration
asks *can a merge of this compound overnight*, and MDX carries components and
imports — it is a program that renders, not a document that is read, which is why
`decision-router.mjs` already sends it down the code lane
(`review-lanes.md`). Calling it prose here would clear the spacing hold on a file
this same rig treats as a program, on the permissive side.

Two questions, two predicates, **one file** — that pairing is why they cannot
drift. It is not a rule that every markdown test in the rig belongs there:
`decision-router.mjs` keeps its own sets on purpose, and `review-lanes.md` — now
with a row for this ration — exists to stop anyone consolidating them.

**The known soft spot: a skill's `SKILL.md` is prose by this test**, and some
skills carry shell snippets an agent copies and runs. The ruling is that skills
stay prose for rationing — they are reviewed like the rules they are, and
rewriting a procedure is not the chain of unreviewed compounding changes the
ration was bought to stop. It is still the weakest ground the "no runtime
executes it" justification stands on, and the first place to look if the ration
turns out too loose.

**A mixed diff is a mechanism close.** The half that runs decides. Reading the
tier off the first path, or off "most of them are documents", would ship a ration
any diff can opt out of by also touching a `.md`.

The split is read by **exactly one** consumer: the ration. `elevated-prose` is
still an elevated change wherever it is *reviewed* — the model lane, the cold
readers, the `human-review` label, the gate sweep — and `recordCompletedTier`
still reports every elevated path it found, unchanged. Narrowing the ration must
not narrow the report: a prose merge that stopped listing its rulebook files
would look clean to the sweep that exists to catch exactly those merges.

## Unknown holds; absent does not

`core.mjs` releases on `normal`, on `elevated-prose`, and on an **absent** tier —
`null`/`undefined`, which is the honest statement that nothing has closed yet and
what a fresh checkout says. Everything else holds: the legacy `'elevated'` an
older state file carries, a word in the wrong case, a value that is not a string.

The tempting implementation is `tier === 'elevated-mechanism'`. It is wrong in
the one direction that matters: every unrecognised value would read as "nothing
elevated closed" and hand out the next elevated item — un-rationing the queue
silently, on state files this project itself wrote last week. The whole seam
exists because a filter whose input nobody supplies is indistinguishable from a
filter that agrees with you.

The legacy word stays *readable* for the same reason it must not be *permissive*:
a checkout that upgrades mid-run still has one on disk, and refusing it outright
would exit 1 on the next selection. `loadState` accepts four words and refuses
the rest — **for the state file only**. Selection falls back to a tier left in
`queue.json`, and `loadConfig` validates nothing but JSON syntax, so a word like
`banana` in the config reaches `selectNext` unrefused — measured: the CLI exits 0
with no refusal, and then **holds** the elevated item with `causes: ["spacing"]`.
It holds because `core.mjs` is the layer that reads every unrecognised value
restrictively — the same layer that holds when `selectNext` is called directly.

## A board switch does not reset repository risk

`lastCompletedTier` is intentionally checkout-global, not board-scoped. Boards
partition ownership and selection; they do not partition the repository a merge
changes. If switching the selector chose a fresh tier slot, a run could land an
unreviewed mechanism from one board, switch to an independent queue, and land a
second mechanism in the same checkout — exactly the back-to-back chain the
ration exists to stop.

The selector therefore changes only the adapter options. The tier stays in the
one `.claude/queue.state.json` paired with the checkout's config, and the next
selection reads it whichever board is active. This is pinned in the generator's
`test/template/queue-board.test.ts` (absent in a generated rig) › "keeps
completed-tier spacing repository-global when the active board switches".

## What this does not fix

The livelock where *every* remaining item is elevated-by-mechanism still exists —
narrowed, not closed. Its operator-only remedy is filed and **not built**: no
such command exists in this repository today, so a run that hits the livelock
stops and says so rather than clearing its own tier. Spacing is also still per
checkout, so a second worktree does not get its own allowance.
