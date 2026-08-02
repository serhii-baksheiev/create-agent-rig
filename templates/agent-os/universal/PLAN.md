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

<!-- Template — copy the block, drop the fields that do not apply (`unblocked` is
     the exception: it is stated even when the answer is "nothing"):

### <one-line summary of the session>

- **done** — what landed, one line each, with the PR reference
- **escalated** — what stopped, and the diagnosis: what failed, what was tried,
  the current hypothesis, and the one question whose answer unblocks it
- **reviewed** — changes that went through a reviewer gate, and what it returned
- **stopped at** — which stop condition ended the session (or "checkpoint,
  still running")
- **unblocked** — what the session's closes released. **The field that is never
  dropped** — a missing line and an unpaid debt read identically from outside,
  and this is the only record of whether anyone looked. It has **three**
  answers and they do not substitute for each other: the items that were
  waiting, by name; "nothing was waiting", where the queue carries dependency
  links and none pointed here; and "this queue has no dependency links", where
  it cannot answer at all — a flat-list queue is **absent**, not satisfied, and
  writing "nothing was waiting" there claims a look that no query could perform
- **queue hygiene** — queue state the session found unreliable and **reported**:
  a stale marker, a dependency already satisfied, an item that describes work
  already done. Reported, never corrected in passing — quietly fixing the
  metadata destroys the evidence that the metadata is unreliable
- **cost** — the counts the session actually observed: reviewer subagents run,
  CI runs consumed (re-runs included — the cheapest signal that a task fought
  its tests), deploys triggered

     A field the session cannot observe stays **visibly empty — never estimated**.
     A plausible number will be believed, by the next reader and by the next run
     reasoning about its own budget. Leave the gap; it is information.
-->
