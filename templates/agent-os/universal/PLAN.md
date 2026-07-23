# __PROJECT_NAME__ — plan and work queues

Work in this project has a stated origin: one of the two queues below. An
agent session picks from the **Agent queue** (see the `loop` skill); anything
that needs a human decision waits in the **Operator queue**. An empty Agent
queue means the session ends — it is never an invitation to improvise.

Keep entries one line each, most valuable first. Delete done items — the
journal records history; the queues state only what is next.

## Agent queue

<!-- Tasks an agent may pick up autonomously (Tier 0/1 — see
     .claude/rules/autonomy.md). One line each, e.g.:
- add a GET /notes/:id route through every layer (TDD)
-->

## Operator queue

<!-- Decisions and Tier-2 work waiting on a human. State what is needed, e.g.:
- decide: retention policy before real data (RemovalPolicy flip)
-->

## Journal

<!-- One line per session, newest first: date-free, what moved, what blocked.
     Prune freely — this is an operational log, not an archive. -->
