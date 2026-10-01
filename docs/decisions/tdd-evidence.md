# Mechanical TDD evidence

Status: accepted

## Decision

Rig classifies TDD applicability from deterministic changed-path evidence and
attributable tracker metadata. Controller prose, including a controller-written
waiver, is never authority. A tracker adapter may pass a separately authenticated
and attributed `trustedTrackerDecision`; the pure contract helper does not infer
trust from a record's `verified` field or any other self-report.

`TDD-0` is an authoritative not-applicable verdict. Documentation and test-only
changes qualify by path. A pure refactor qualifies only when the same non-empty
set of structured GREEN tests, identified by `(file, full test name, test-file
SHA-256)`, passes before and after. A final behavior-changing production diff
invalidates that exemption. Ordinary behavior changes require `TDD-2`; tracker
metadata may require `TDD-3` for safety, guard, or release-critical work.
`TDD-1` records exactly one intermediate, observed relevant RED and no later
stage; it does not authorise shipment. `TDD-0` carries no execution stages.

The portable schema is designed to extend the existing
`.rig/claims/<item>.json` record when RP-306 adds the writer. It is rooted at
`BASELINE_CREATED.headSha`. For `TDD-2` it
records the structured RED test, implementation boundary, and GREEN test; RED
and GREEN must be the same specification and test-file hash. A changed test
file invalidates the prior RED. RED and GREEN bind the independently observed
check outcome (`fail` or `pass`) and its SHA-256 result fingerprint. The
implementation boundary binds a SHA-256 implementation-delta fingerprint.
Each stage fingerprint covers these fields and canonical bounded evidence. For
comparable observations in one run, stage sequence numbers must increase.
`TDD-3` additionally requires an exact-test, independently observed `fail`
non-vacuity result. RP-308 will run that proof after removing only the relevant
implementation delta in an isolated worktree.

The portable schema permits references and fingerprints only: item identity,
baseline object id, bounded run/sequence references, structured test identity,
and canonical fingerprints. Canonicalization bounds depth, entries, string
size, and encoded evidence size. It rejects raw terminal output, prompts,
transcripts, secrets, arbitrary paths, and unknown fields. The local run journal
keeps raw detail. RP-306 will write the tracked claim for continuation, refuse
missing portable history at `pr-ship`, and put compact fingerprints in PR and
tracker verdicts rather than copying journal records.

RP-305 supplies the deterministic contract only. RP-306 derives it from
`check-run` and the journal, writes claim evidence, and enforces TDD-2 at
`pr-ship`. This decision adds no production-write lock.

## Why

Observable evidence can be checked across controller and machine boundaries.
Narrative descriptions cannot prove ordering, test identity, or continuity.

## Rollback

Revert the portable schema, its documented decision, and any RP-306 consumer
together. Do not replace it with controller prose or an untracked journal.
