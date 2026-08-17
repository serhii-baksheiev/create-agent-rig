# Why the run's stop conditions are a file, not a memory

The rule lives in the `loop` skill, section 3 ("What keeps the loop running,
and what stops it"). This file records why the state was moved out of the
session, and why only one of the two written verdicts can be taken back. It is
not loaded into any session.

## The defect the file fixed

`escalations` and `lastDeployVerdict` now live in `<RIG_RUN_DIR>/state.json`,
written by `run-state.mjs`.

Before that existed, the CLI called `stopConditionOf` with the queue counts
alone. Every state-dependent branch therefore held its **default** on every real
selection — the runtime-regression stop, the two-escalations stop, the budget
stop. None of them could fire. The rules were enforced only by whichever session
happened to remember them.

Compaction is exactly the moment a long unattended run stops remembering, and a
long unattended run is the only situation these stops exist for. So the stops
were reliably absent precisely where they were needed.

## Why the escalation count has two writers, and both must be the documented one

- It **rises** through the adapter's `escalate()`. Hand-labelling an item
  escalated marks the item and counts nothing, so the run grinds past the wall.
- It **resets** through the close step's `recordCompletedTier`, and only when
  that call is passed `runDir` — see `docs/decisions/closing-a-task.md`.

Both halves fail quietly when done the undocumented way, and they fail in
opposite directions: one never stops a broken run, the other stops a healthy one.

## Why only the deploy verdict can be taken back

The asymmetry is deliberate.

`HEALTHY` names a **real later event** — the revert landed and the runtime was
re-verified. Without a way to record it, one bad deploy would end every later
selection in the run, however thoroughly it was fixed.

Spend only accumulates. Un-exhausting a budget would name no event at all — only
a decision to keep going, taken by the very run that declared the stop. That is
the shape of a stop condition a run can talk itself out of, which is not a stop
condition.

A new run starts from a clean state. That is the way back from both.
