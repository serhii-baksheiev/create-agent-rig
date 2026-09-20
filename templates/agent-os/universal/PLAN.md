# __PROJECT_NAME__ — plan and work queues

This file itself ships with Core — every rig has it, `--layer workflow` or
not. **What reads it automatically is workflow-layer only** (`init --layer
workflow`): with that layer, an agent session picks from the **Agent queue**
through the `loop` skill, and anything that needs a human decision waits in
the **Operator queue** — an empty Agent queue means the session ends, never
an invitation to improvise. **Without the workflow layer, this file is
manual**: a place to note or look up planned work by hand, read by a session
only when asked to, never selected from automatically.

Keep entries one line each, most valuable first. Delete done items — the
journal (workflow layer only, below) records history; the queues state only
what is next.

## Agent queue

<!-- Tasks an agent may pick up autonomously (Tier 0/1 — see
     .claude/rules/autonomy.md). One line each, e.g.:
- add a GET /notes/:id route through every layer (TDD)
-->

## Operator queue

<!-- Decisions and Tier-2 work waiting on a human. State what is needed, e.g.:
- decide: retention policy before real data (RemovalPolicy flip)
-->
## Where the journal is (workflow layer only)

`journal/README.md` and the `journal/YYYY-MM.md` files it describes ship with
the opt-in workflow layer (`init --layer workflow`) — a Core-only rig has
neither. Where they exist: one journal file per month, newest-on-top inside
each; the convention and the field list are in `journal/README.md`.

The heading here is deliberately **not** `## Journal`: a pointer under that name
still sends a session into this file to look, and keeping this file small is the
point. `plan-md.mjs` (workflow layer) resolves the two queue headings above by
name and is not affected either way.
