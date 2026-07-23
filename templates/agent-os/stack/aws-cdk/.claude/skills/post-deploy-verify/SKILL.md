---
name: post-deploy-verify
description: Produce the post-deploy HEALTHY / REGRESSION verdict the autonomy rules act on. MUST run after every deploy — CI-green ≠ runtime-healthy. Read-only by construction.
context: fork
allowed-tools: Bash, Read, Grep
argument-hint: [stack-name]
---

You verify runtime health after a deploy and return a **verdict**, not a vibe.
You are read-only: you observe, you never fix. The autonomy rules
(`.claude/rules/autonomy.md`, "Post-deploy verification") consume your verdict.

## Steps — evidence for each, in order

1. **Stack freshness.** Confirm the deploy you are judging actually landed:
   `aws cloudformation describe-stacks --stack-name <stack>` — status is
   `CREATE_COMPLETE`/`UPDATE_COMPLETE` and `LastUpdatedTime` is *this* deploy,
   not a previous one. Judging a stale stack is the classic false-HEALTHY.
2. **Smoke the route.** POST a request through the API (the README's smoke
   command). Expect the documented success response (201 with a body).
3. **The async path.** Confirm the worker consumed the event this smoke
   produced: `aws logs filter-log-events` on the worker's log group for the
   processed-marker within the last few minutes.
4. **Queue discipline.** The DLQ is empty and its alarm is quiet:
   `aws sqs get-queue-attributes` (ApproximateNumberOfMessages = 0) and
   `aws cloudwatch describe-alarms` (state OK, not ALARM).
5. **Error noise.** Scan both functions' recent logs for new ERROR-level
   entries that did not exist before the deploy.

## Verdict — the only two answers

Report exactly one, with the evidence lines that justify it:

- `VERDICT: HEALTHY` — every step above passed.
- `VERDICT: REGRESSION` — anything failed or could not be verified. Name the
  failing step and the observed output verbatim. **The required next action is
  revert** (redeploy the previous revision) — diagnosis happens after the
  runtime is healthy again, never by fixing forward blind. Unverifiable ≠
  healthy: if you cannot see, the verdict is REGRESSION.

## Boundaries

- Read-only AWS calls (`describe*`, `get*`, `list*`, `filter-log-events`) plus
  the smoke request. Nothing that mutates state — the tool allowlist enforces
  this, and the rule stands even where the allowlist cannot reach.
- No re-running a failed smoke "until it passes" — a flaky smoke is a
  REGRESSION with flakiness as the named evidence.
