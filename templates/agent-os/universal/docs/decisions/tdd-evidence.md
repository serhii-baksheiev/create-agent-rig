# Mechanical TDD evidence

Status: accepted

## Decision

Rig classifies TDD applicability from deterministic changed-path evidence and
attributable tracker metadata. The first helper argument is controller-provided
work state: controller prose, waivers, and refactor evidence in it are never
authority. The second argument is reserved for a verified consumer; the pure
helper cannot authenticate its caller or prove provenance. RP-306 must
authenticate Jira and `check-run` sources before passing an attributable Jira
decision (`system`, issue, comment, actor, current decision-content fingerprint)
or refactor evidence. The helper does not infer trust from a record's `verified`
field or any other self-report.

`changedPaths` and `finalBehaviorPaths` are also inputs to the pure helper, not
proof of a Git diff. RP-306 derives both from the selected work's Git evidence
before calling it; controller-provided path lists do not establish provenance.

`TDD-0` is an authoritative not-applicable verdict. Documentation and test-only
changes qualify by path. A pure refactor qualifies only when the verified second
argument carries a non-empty compact test-set count and fingerprint, matching
before/after observed passing GREEN checkpoints and the item baseline. RP-306 verifies
that the compact test-set fingerprint represents the complete structured set of
`(file, full test name, test-file SHA-256)` results before passing it. A final
behavior-changing production diff invalidates that exemption. Ordinary behavior
changes require `TDD-2`; tracker metadata may require `TDD-3` for safety, guard,
or release-critical work.
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
Every stage after RED contains the exact predecessor stage fingerprint, and its
own fingerprint covers that link, the item ticket, the baseline head, and
canonical bounded evidence. This forms a structural RED → boundary → GREEN
chain across controller handoffs.
For every pair of stages observed in the same run, sequence numbers must
increase, even when a different controller appears between them. `TDD-3`
additionally requires an exact-test, independently observed `fail` non-vacuity
result linked to GREEN. RP-308 will run that proof after removing only the
relevant implementation delta in an isolated worktree.

The portable schema permits references and fingerprints only: item identity,
baseline object id, bounded run/sequence references, structured test identity,
and canonical fingerprints. Canonicalization bounds depth, entries, string
size, and encoded evidence size, and orders object keys by code unit rather
than locale so fingerprints match across machines. It rejects raw terminal output, prompts,
transcripts, secrets, arbitrary paths, and unknown fields. The local run journal
keeps raw detail. TDD-0 owner waivers bind a canonical Jira decision fingerprint
(including RP-306's fingerprint of the current Jira decision content) to the
item; trusted refactor exemptions bind a canonical compact proof to the same
item and baseline. RP-306 will write the tracked claim for continuation, refuse
missing portable history at `pr-ship`, authenticate and persist Jira and
`check-run` provenance, verify current Jira content, complete test sets and
cross-run chronology, and put compact fingerprints in PR and tracker verdicts
rather than copying journal records.

Portable validation also scans bounded, structurally valid string leaves with
the shared `findSecretValues` vocabulary and reports only a redacted
credential-shaped-content verdict. That scanner detects its documented shapes,
not every possible credential; schema validation cannot certify unknown
credential patterns. RP-306 must apply its existing redaction and field
selection at the producer before persistence for values the shared scanner
cannot recognize.

RP-305 supplies the deterministic contract only. RP-306 derives it from
`check-run` and the journal, writes claim evidence, and enforces TDD-2 at
`pr-ship`. This decision adds no production-write lock.

## Why

Observable evidence can be checked across controller and machine boundaries.
Narrative descriptions cannot prove ordering, test identity, or continuity.

## Rollback

Revert the portable schema, its documented decision, and any RP-306 consumer
together. Do not replace it with controller prose or an untracked journal.
