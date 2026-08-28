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
"refuses to resume from an existing claim until Git tracks it", › "refuses a
deleted tracked claim in a fresh run without take-up markers", and › "refuses
to recreate a deleted untracked baseline with a %s" (parameterized over a
readable and a corrupt prior journal), plus
`test/template/queue-revalidation.test.ts` › "without a run directory it
creates the durable baseline but no run evidence".

The record contains SHA-256 fingerprint sets, not source content:

- `scope` covers stable ticket scope, dependency links and configured paired
  repository facts. Workflow-only status and labels are excluded so the rig's
  own claim transition cannot invalidate its baseline.
- `commentary` covers comment identifiers and count. It is observed at SELECT
  and BEFORE_PR and becomes hold-authoritative only at BEFORE_CLOSE.

Pinned in the generator suite (absent in a generated rig),
`test/template/content-blind-revalidation.test.ts` › "stays CURRENT
for marker-only movement and holds on changed scope", › "holds when the target
branch SHA moves without a tracker edit", and › "defers an added comment
through SELECT and BEFORE_PR, then holds at BEFORE_CLOSE".

`.rig/revalidation.json` is the versioned detection contract. Version 1 is a
pull model over run-state and journal evidence, with 24-hour accepted latency,
no push channel, and an explicit list of paired facts. Preflight stops when the
contract is absent or unsupported. Pinned in the generator suite (absent in a
generated rig),
`test/template/content-blind-revalidation.test.ts` › "preflight hard-refuses a
%s contract as no-detection-contract" and › "accepts the default
pull/run-state+journal/24h/no-push contract".

`updatedAt` take-up markers remain in run state and revalidation events for
compatibility and attribution. They do not decide drift, baseline creation or
checkpoint action. `.claude/runs/<run-id>/decisions.jsonl` and `events.jsonl`
remain append-only evidence for a particular run; the sibling `state.json` is a
mutable stop-state cache, and none of them is the cross-harness claim store.
Pinned in the generator suite (absent in a generated rig),
`test/template/queue-revalidation.test.ts` › "a moved marker stays
evidence-only while the tracked claim remains CURRENT". First sight versus
resume is reconstructed from SELECT events in the current and bounded sibling
run journals. An unreadable bounded journal cannot prove first sight and
therefore cannot authorise recreation of a missing claim. Neither can a scan
truncated by its entry or candidate cap: incompleteness is explicit and fails
closed rather than turning subset absence into first sight.

Every blocking detection has a stable content-blind id. A typed outcome names
that id, records whether action was required and clears only its matching
run-level hold. An outcome without a boolean `actionRequired` or legacy
`actionChanged` verdict is malformed and resolves nothing. Filesystem failures
are reduced to stable logical evidence before they enter a detection id, so
identical failures have identical ids across harness
checkouts. The report joins by detection id across runs and retains the
legacy same-run sequence join for older evidence. Pinned in the generator suite
(absent in a generated rig),
`test/template/content-blind-revalidation.test.ts` › "reuses a stable detection
id for the same drift at the same checkpoint", › "journals a typed resolution
through the existing outcome command", › "derives false-HOLD from result !=
CURRENT and actionRequired false, only after resolution", and › "joins a typed
resolution to its detection across run directories".

The run-state hold is a cache of that append-only evidence, not a deletion
escape hatch. Before selection, the same temporal resolver used by the report
reconstructs the newest unresolved blocking detection from the current run
journal when `state.json` has no hold. Revalidation-hold writers use the same
fail-closed state reader as selection, so a corrupt, symlinked or oversized
state file cannot be replaced while it may conceal another stop input. Contract
reads stay anchored to an opened file descriptor and reject identity changes
during validation. Existing claim bytes are read through a bounded no-follow
descriptor and compared with the tracked Git object; first-baseline creation is
anchored to the validated claim-directory working directory so a pathname swap
cannot redirect the write outside the repository.
The directory's real path and filesystem identity are carried into the writer
and checked again with the persisted bytes before SELECT reports
`BASELINE_CREATED`; redirecting it elsewhere inside the repository is refused
too. Jira commentary declares whether its returned IDs cover `comment.total`;
an incomplete set is `UNVERIFIABLE`, never a hash of unseen IDs. GitHub CLI's
unpaginated `comments(first: 100)` window has no total beside it, so exactly 100
returned comments is also `UNVERIFIABLE`; fewer than the cap proves completion.
Pinned in the generator's
`test/template/content-blind-revalidation.test.ts` (absent in a generated rig)
› "stops with %s when the unresolved journal result is %s", › "%s refuses a
present %s state instead of replacing unknown stop inputs", › "does not accept
an external contract swapped in after containment validation", › "rejects a
tracked claim %s only in the worktree", and › "does not write a baseline outside
after the claim directory passes containment", plus › "keeps a detection
unresolved with %s state when its typed outcome has no boolean verdict", › "uses
the same id for the same missing-contract condition in two absolute roots", ›
"returns UNVERIFIABLE when the %s truncates prior SELECT evidence", › "refuses
SELECT when comment.total exceeds the returned comment ids", › "refuses SELECT
when the transport returns exactly its 100-comment window without a total", and
› "does not write through an in-repository claim-directory symlink swapped after
validation".

BEFORE_CLOSE proves the tracker state it observed; the later tracker transition
is a separate API operation. Without a tracker-supplied conditional transition
or transaction token, this mechanism cannot make those two remote operations
atomic. A future adapter may consume such a native primitive, but this decision
does not invent one or treat `updatedAt` as a substitute authority.

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
