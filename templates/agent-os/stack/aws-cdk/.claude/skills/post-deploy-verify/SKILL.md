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

Scope yourself to what this skeleton actually provisions — one API, one worker
with one DLQ, two CloudFormation stacks. Do not invent signals it does not have.

## Steps — evidence for each, in order

1. **The deploy job's conclusion — the primary, always-available signal.**
   Start here: did the deploy job itself succeed? This exists on every project
   from day one, before any metric has data. A failed or absent deploy job is a
   REGRESSION on its own; a successful one is necessary but not sufficient —
   continue.
2. **Stack status + freshness cross-check.** `UPDATE_COMPLETE` **alone is stale
   evidence** — it persists from the previous deploy. Confirm `LastUpdatedTime`
   from `aws cloudformation describe-stacks` postdates the deploy you are
   judging. A fresh-looking status on a stale stack is the classic false-HEALTHY.
3. **Smoke the route.** POST a request through the API (the README's smoke
   command). Expect the documented success response (201 with a body).
4. **The async path.** Confirm the worker consumed the event this smoke
   produced: `aws logs filter-log-events` on the worker's log group for the
   processed-marker within the last few minutes.
5. **Queue discipline.** The skeleton's DLQ is empty and its alarm is quiet:
   `aws sqs get-queue-attributes` (ApproximateNumberOfMessages = 0) and
   `aws cloudwatch describe-alarms` (state OK, not ALARM).
6. **Function errors** in the window after the deploy — scan the functions'
   recent logs for new ERROR-level entries.

🔴 **A vacuous result is "no signal", not a pass.** An empty metric or an empty
log query means *there were no invocations*, not *there were no errors*. Never
read absence-of-data as health — report it as "no signal" and, since you could
not verify, it counts toward REGRESSION, never toward HEALTHY. The first
HEALTHY verdict a user sees has to mean something, or the whole mechanism loses
its credibility exactly when it should earn it.

## Verdict — the only two answers

Report exactly one, with the evidence lines that justify it:

- `VERDICT: HEALTHY` — every step above passed.
- `VERDICT: REGRESSION` — anything failed or could not be verified. Name the
  failing step and the observed output verbatim. **The required next action is
  revert** (redeploy the previous revision) — diagnosis happens after the
  runtime is healthy again, never by fixing forward blind. Unverifiable ≠
  healthy: if you cannot see, the verdict is REGRESSION. And an **empty
  metric or log result means "no invocations", not "no errors"** — name a
  vacuous result honestly instead of reporting it as a pass.

### The verdict block

End your report with **exactly one** fenced `json` block of this shape, and
nothing after it. The prose above it carries the evidence a human reads; this is
what the caller acts on — and what it retypes into
`node .claude/scripts/run-state.mjs deploy HEALTHY|REGRESSION`, which is where
the next selection reads the verdict.

```json
{
  "gate": "post-deploy-verify",
  "verdict": "REGRESSION",
  "blockers": [
    {
      "rule": "smoke request",
      "note": "POST /notes returned 502 twice; expected 201"
    }
  ],
  "advisories": [],
  "evidence": ["stack LastUpdatedTime is this deploy", "DLQ depth 0"]
}
```

- `verdict` is `HEALTHY` or `REGRESSION` — this skill has no third answer, and
  "could not verify" is a `REGRESSION`, never a missing verdict.
- A `REGRESSION` names one blocker per failed or unverifiable step, with the
  observed output in its `note`. A step has no file, so `file` and `line` are
  omitted here.
- A `REGRESSION` naming no blocker is **refused**, and so is a `HEALTHY`
  carrying one: `node .claude/scripts/verdict.mjs check <report>` is what
  refuses them.

## Boundaries

- Read-only AWS calls (`describe*`, `get*`, `list*`, `filter-log-events`) plus
  the smoke request. Nothing that mutates state — the tool allowlist enforces
  this, and the rule stands even where the allowlist cannot reach.
- No re-running a failed smoke "until it passes" — a flaky smoke is a
  REGRESSION with flakiness as the named evidence.
