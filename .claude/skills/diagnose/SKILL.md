---
name: diagnose
description: Use when a check is red or a run crashed and the cause is not obvious, or when a claimed defect or historical finding needs confirming before work is planned on it.
allowed-tools: Read, Grep, Glob, Bash, Task
---

# Diagnose before you fix

Stop guessing. A red check or a crashed run is never a thing to retry until
it goes green — that stop rule is already stated in
`.claude/rules/autonomy.md` ("Flaky ≠ retry"); this skill does not restate
it.

## Hand it to `failure-diagnostician`

Give the agent what it needs to reproduce, verbatim:

- for a failure — the exact failure output, the command that produced it,
  and the commit or branch where it failed;
- for a claim — the claim's own text, and where it came from (a queue item,
  a review comment, a prior finding).

Dispatch `failure-diagnostician`. Its method is its own —
`.claude/agents/failure-diagnostician.md` — not repeated here.

## Check the answer, then act on the word

Save its report to a file and run exactly:

```sh
node .claude/scripts/verdict.mjs check <report> failure-diagnostician
```

Exit 1 means it did not answer — that is no diagnosis, not a word to act on.

| Verdict | Action |
| --- | --- |
| `ROOT_CAUSE` / `STILL_LIVE` | the failing test first, through `test-writer` — the Red step in `.claude/rules/workflow.md` |
| `INCONCLUSIVE` / `INSUFFICIENT_EVIDENCE` | stop; escalate in the format `.claude/rules/autonomy.md` ("Escalation format") sets, carrying the verdict's blockers as what would decide the question |
| `ALREADY_FIXED` / `OBSOLETE` | close the item, citing the verdict's `evidence` |

This is a Core skill: it dispatches no opt-in-workflow-layer machinery, and
routes on the word alone.
