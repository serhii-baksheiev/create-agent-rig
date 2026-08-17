# Why the router's prose set and the gate sweep's inert set differ

The rule lives in `.claude/rules/workflow.md`, under "PR flow". This file
explains the one part of it that reads like an inconsistency and is not, so that
nobody "tidies" the two sets into agreement. It is not loaded into any session.

## The two sets

Two different mechanisms each carry their own notion of "this file is only
words":

| mechanism             | what it treats as inert                                                       | what it does with it                                |
| --------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| the Tier-2 gate sweep | `.md`, `.mdx` and non-provisioning test paths — **unless the path is rulebook** | does not escalate on the elevated-path ground alone |
| `decision-router.mjs` | `.md`, `.txt`                                                                 | may route to the `fast-path` prose lane             |

The sweep's rulebook exception is load-bearing and is **not** a third set to
reconcile: `isRulebook` in `detect-missed-gate.mjs` covers `CLAUDE.md` anywhere,
everything under a `.claude/` directory, and — since these records were
extracted — everything under `docs/decisions/`. So a merged PR rewriting the
autonomy tiers, the Never list, or the reasoning behind either still escalates.
Without the exception, declaring a path elevated was a no-op for every `.md`
under it, which is the defect that put it there.

That is also why moving this rationale out of `.claude/` needed a code change
rather than only a declaration: the declaration alone would have reported clean
over every record, because `isInert` is consulted first.


Neither set contains the other. That is deliberate, and both differences earn
their keep.

## Why the sweep does not also take `.txt`

Widening the sweep to `.txt` would stop `requirements.txt` inside an elevated
directory from escalating. A dependency manifest is the opposite of inert — it
is one of the risk flags — and its extension happens to be `.txt`.

## Why the router does not also take `.mdx`

Copying the sweep's `.mdx` into the router's prose set would put executable MDX
back on the prose lane. MDX carries components and imports; it is a program that
renders, not a document that is read.

## The shape of the mistake this prevents

Both edits look like clean-ups. Each removes an apparent inconsistency between
two lists that "obviously" mean the same thing, and each one silently downgrades
a real review. The lists mean different things because the questions differ:
"does this change need the elevated gate?" is not "can a prose reviewer judge
this alone?"
