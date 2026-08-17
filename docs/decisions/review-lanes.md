# Why the router's prose set and the gate sweep's inert set differ

The rule lives in `.claude/rules/workflow.md`, under "PR flow". This file
explains the one part of it that reads like an inconsistency and is not, so that
nobody "tidies" the two sets into agreement. It is not loaded into any session.

## The sets

Three different mechanisms each carry their own notion of "this file is only
words":

**The first two carve out the rulebook**, and only then differ; the third runs
*after* the sweep has already answered, so it sees only what survived:

| mechanism                | rulebook exemption                         | inert / prose after it                     | consequence                                         |
| ------------------------ | ------------------------------------------ | ------------------------------------------ | --------------------------------------------------- |
| the Tier-2 gate sweep    | `isRulebook` in `detect-missed-gate.mjs`   | `.md`, `.mdx`, non-provisioning test paths | does not escalate on the elevated-path ground alone |
| `decision-router.mjs`    | `isRulebookPath`, checked before extension | `.md`, `.txt`                              | may route to the `fast-path` prose lane             |
| the queue's elevated ration (`queue/state.mjs`) | none of its own — it classifies what `elevatedPathsIn` already returned, so only **rulebook** markdown ever reaches it | `.md` (`executesNothing`) | records `elevated-prose`, which does **not** space the next item |

The third row is the one added last, and its question is different again: not
"does this need the gate" nor "can a prose reviewer judge it alone", but **"can
a merge of this compound into a broken runtime overnight"**. That is why it
excludes `.mdx` where the sweep includes it — same reasoning as the router's,
one row below — and why it is `.md` only rather than the sweep's set. Its two
predicates live in `detect-missed-gate.mjs` side by side so *those two* cannot
drift; that is a statement about one file, **not** a rule that every markdown
test in the rig belongs there. The router's sets stay where they are, for the
reason this whole record exists.

**Neither row applies to a decision record, including this one.** Both
predicates recognise `CLAUDE.md` anywhere, everything under `.claude/`, and —
since these records were extracted — everything under `docs/decisions/`, through
the one shared `isDecisionRecord`. A change here escalates the sweep and takes
the `model` lane, exactly as the rule it explains would. The router's call is
not a redundant copy of the sweep's; deleting it silently drops this file to the
prose lane.

Without that exemption, declaring a path elevated was a no-op for every `.md`
under it — the defect that put it there — and it is why moving this rationale
out of `.claude/` needed a code change rather than only a declaration:
`isInert` is consulted first, so the declaration alone would have reported clean
over every record.

The **remaining** difference is the inert/prose column, and no set contains
another. That is deliberate, and every difference earns its keep. One more
asymmetry belongs to the router alone: it **folds case** before its rulebook
check, because there folding can only escalate, while a sweep that folded would
name a path the repository does not have.

## Why the sweep does not also take `.txt`

Widening the sweep to `.txt` would stop `requirements.txt` inside an elevated
directory from escalating. A dependency manifest is the opposite of inert — it
is one of the risk flags — and its extension happens to be `.txt`.

## Why neither the router nor the ration takes `.mdx`

Copying the sweep's `.mdx` into the router's prose set would put executable MDX
back on the prose lane. MDX carries components and imports; it is a program that
renders, not a document that is read. The ration reads it the same way and for
the same reason (`spacing-rations-mechanisms.md`): calling it prose there would
clear the spacing hold on a file this rig treats as a program, on the permissive
side.

## The shape of the mistake this prevents

Both edits look like clean-ups. Each removes an apparent inconsistency between
two lists that "obviously" mean the same thing, and each one silently downgrades
a real review. The lists mean different things because the questions differ:
"does this change need the elevated gate?" is not "can a prose reviewer judge
this alone?"
