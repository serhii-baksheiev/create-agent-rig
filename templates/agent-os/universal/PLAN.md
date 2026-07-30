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

Newest first, date-free — order carries the sequence. Prune freely: this is
operational memory, not an archive. An unattended run writes an entry at every
stop **and** at checkpoints along the way, because a run that dies unexpectedly
must not take its history with it.

The fields exist so an entry can be visibly **incomplete**. A journal with no
stated shape decays into a diary that reads fine and proves nothing.

<!-- Template — copy the block, drop the fields that do not apply:

### <one-line summary of the session>

- **done** — what landed, one line each, with the PR reference
- **escalated** — what stopped, and the diagnosis: what failed, what was tried,
  the current hypothesis, and the one question whose answer unblocks it
- **reviewed** — changes that went through a reviewer gate, and what it returned
- **stopped at** — which stop condition ended the session (or "checkpoint,
  still running")
- **queue hygiene** — queue items fixed in passing: stale state, a dependency
  that was already satisfied, an item that describes work already done
- **cost** — the counts the session actually observed: reviewer subagents run,
  CI runs consumed (re-runs included — the cheapest signal that a task fought
  its tests), deploys triggered

     A field the session cannot observe stays **visibly empty — never estimated**.
     A plausible number will be believed, by the next reader and by the next run
     reasoning about its own budget. Leave the gap; it is information.
-->
