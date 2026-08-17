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

The measurement that forced the change: on this repository, 56 of 58 selectable
items were held, 53 of them by spacing. That is not pacing the project, it is
halting it, and the halt was indistinguishable from the rule working.

## The split, and where it does NOT apply

`recordCompletedTier` classifies the elevated paths a close actually crossed:

| what the close crossed | tier recorded | effect on the next elevated item |
| --- | --- | --- |
| every elevated path is a document | `elevated-prose` | clears the ration |
| any elevated path is not | `elevated-mechanism` | spaces it |
| no elevated path at all | `normal` | clears the ration |

"Document" is `isDocument` — `/\.mdx?$/`, imported from `detect-missed-gate.mjs`
rather than restated, because two notions of the word would disagree and the copy
nobody looks at would be the wrong one (`invariants.md`).

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
would exit 1 on the next selection. `index.mjs` accepts four words and refuses
the rest before selection runs; `core.mjs` is the second layer, and the one that
holds when `selectNext` is called directly.

## What this does not fix

The livelock where *every* remaining item is elevated-by-mechanism still exists —
narrowed, not closed, and its operator-only remedy (`reset-tier`) is a separate
item. Spacing is also still per checkout, so a second worktree does not get its
own allowance.
