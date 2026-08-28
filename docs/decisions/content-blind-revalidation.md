# Content-blind revalidation claims

Status: accepted

## Decision

SELECT, BEFORE_PR and BEFORE_CLOSE remain the only revalidation checkpoints.
They share one implementation and one durable baseline: a versioned JSON record
at `.rig/claims/<ticket>.json`.

The first successful SELECT creates the record and reports
`BASELINE_CREATED`. The task branch must add it to Git. An existing but
untracked record, or an absent tracked record, is `UNVERIFIABLE`; so is an
absent record on a resumed SELECT, BEFORE_PR or BEFORE_CLOSE. Each case stops
automatic progress. Pinned in the generator's
`test/template/content-blind-revalidation.test.ts` (absent in a generated rig)
› "creates a versioned content-blind claim and returns BASELINE_CREATED" and ›
"refuses a deleted tracked claim in a fresh run without take-up markers", plus
`test/template/queue-revalidation.test.ts` › "without a run directory it
creates the durable baseline but no run evidence".

The record contains SHA-256 fingerprint sets, not source content:

- `scope` covers stable ticket scope, dependency links and configured paired
  repository facts. Workflow-only status and labels are excluded so the rig's
  own claim transition cannot invalidate its baseline.
- `commentary` covers comment identifiers and count. It is observed at SELECT
  and BEFORE_PR and becomes hold-authoritative only at BEFORE_CLOSE.

Pinned in `test/template/content-blind-revalidation.test.ts` › "stays CURRENT
for marker-only movement and holds on changed scope", › "holds when the target
branch SHA moves without a tracker edit", and › "defers an added comment
through SELECT and BEFORE_PR, then holds at BEFORE_CLOSE".

`.rig/revalidation.json` is the versioned detection contract. Version 1 is a
pull model over run-state and journal evidence, with 24-hour accepted latency,
no push channel, and an explicit list of paired facts. Preflight stops when the
contract is absent or unsupported. Pinned in
`test/template/content-blind-revalidation.test.ts` › "accepts the default
pull/run-state+journal/24h/no-push contract".

`updatedAt` take-up markers remain in run state and revalidation events for
compatibility and attribution. They do not decide drift, baseline creation or
checkpoint action. `.claude/runs/<run-id>/` remains append-only evidence for a
particular run; it is not the cross-harness claim store. Pinned in
`test/template/queue-revalidation.test.ts` › "a moved marker stays
evidence-only while the tracked claim remains CURRENT".

Every blocking detection has a stable content-blind id. A typed outcome names
that id, records whether action was required and clears only its matching
run-level hold. The report joins by detection id across runs and retains the
legacy same-run sequence join for older evidence. Pinned in
`test/template/content-blind-revalidation.test.ts` › "reuses a stable detection
id for the same drift at the same checkpoint", › "journals a typed resolution
through the existing outcome command", › "derives false-HOLD from result !=
CURRENT and actionRequired false, only after resolution", and › "joins a typed
resolution to its detection across run directories".

## Why

Tracker timestamps conflate scope edits, comments and workflow transitions.
They caused false holds on the rig's own writes and cannot survive a harness or
run boundary as a durable semantic claim. Content-blind sets preserve privacy,
make each kind of drift explicit and keep the existing checkpoint chain as the
single authority.

## Rollback

Revert the mechanism, contract and claim records together. Do not restore
`updatedAt` as a second authority beside claims: two engines can disagree at a
checkpoint, which makes neither result safe to automate.
