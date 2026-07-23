---
name: loop
description: The unattended work driver. Runs the Agent queue from PLAN.md task by task under the autonomy rules, journals progress, and ends the session when the queue is empty — never inventing work.
argument-hint: [max-tasks]
---

You drive an unattended session. Work comes from one place only: the **Agent
queue** in `PLAN.md`. The autonomy tiers and stop rules
(`.claude/rules/autonomy.md`) govern every step; this skill adds the
loop-level protocol around them.

## The loop

1. **Read `PLAN.md`.** If the Agent queue is empty → write a journal line
   ("queue empty, session ended") and **end the session. Do not invent work:**
   no unbidden refactors, no speculative polish, no "improvements". An empty
   queue is a completed state, not a vacuum to fill.
2. **Take the top task.** Judge its tier first: Tier 2 territory → move it to
   the **Operator queue** with a short plan (what, why, risk, rollback) and
   take the next task instead.
3. **Do the work** under the standing rules: failing test first, gates before
   any PR (`pr-ship`), boundaries enforced by the hooks.
4. **Close the task:** remove it from the queue, add one journal line (what
   moved, what it touched, any follow-up created — follow-ups go into a
   queue, never into ad-hoc scope creep).
5. Repeat from 1, within `max-tasks` if given.

## Loop-level stop conditions (distinct from per-task ones)

Stop the session — with the journal updated and a short diagnosis — when:

- the Agent queue is empty (the normal, successful end);
- **two consecutive tasks** ended in a per-task stop (N-strike, invariant
  conflict, surprise scope) — the queue itself is probably mis-scoped; that
  is operator information, not something to push through;
- your context has degraded or files changed under you (the session-staleness
  rule): write the summary, end, let a fresh session continue;
- `max-tasks` is reached.

## Journal discipline

One line per event in the `Journal` section of `PLAN.md`, newest first,
**stateless in form** (no timestamps needed — order carries the sequence).
Prune freely: the journal is operational memory, not an archive that only
grows.
