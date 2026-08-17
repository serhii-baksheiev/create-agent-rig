# Why the router's prose set and the gate sweep's inert set differ

The rule lives in `.claude/rules/workflow.md`, under "PR flow". This file
explains the one part of it that reads like an inconsistency and is not, so that
nobody "tidies" the two sets into agreement. It is not loaded into any session.

## The two sets

Two different mechanisms each carry their own notion of "this file is only
words":

| mechanism             | what it treats as inert                              | what it does with it                                |
| --------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| the Tier-2 gate sweep | `.md`, `.mdx`, and test paths that provision nothing | does not escalate on the elevated-path ground alone |
| `decision-router.mjs` | `.md`, `.txt`                                        | may route to the `fast-path` prose lane             |

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
