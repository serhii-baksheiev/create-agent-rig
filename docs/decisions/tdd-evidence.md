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

## Enforcement activation

RP-306 is the trust-root change that first installs structured RED recording
and the shipping verifier. Its selected-work baseline has neither mechanism,
so its earlier failing checks cannot truthfully be presented as portable TDD-2
evidence. Review RP-306 under the `pr-ship` contract present at its baseline,
with its observed test-first history, full checks and required reviewers. Its
PR verdict must state that no portable TDD-2 is asserted for RP-306 itself
and name its reviewed branch HEAD. After merge, record the exact enforcement
activation merge commit in the tracker and release ledger.
Every subsequent ticketed behavior change is subject to the new verifier.
There is no bootstrap exception in the installed verifier.

RP-370 is the second trust-root change, under the same rule: it adds the
same-baseline refinement transition to the recorder that must attest it.
Its RED and GREEN are recorded by the accepted pre-change recorder, never by
the repaired one, so no portable TDD-2 is self-attested by the repair; if its
production changes after that GREEN, its final head carries observed check
evidence, not a refreshed portable claim. Its PR verdict names the reviewed
HEAD and states this. After merge, record the activation merge commit in the
tracker and release ledger. From that commit on the repaired contract applies
to every ticketed change, with no inherited exemption.

## Recording a TDD-2 item

Before RED, the selected tracker item's description must contain exactly one
line of the form `rig:tdd-spec/v1 {"file":"test/example.test.ts","fullName":"the full test name"}`.
The file is repository-relative. This marker identifies the relevant
specification; it must match the structured Vitest identity, and the tracker
item must already carry it when the failed check runs. Keep `RIG_RUN_DIR`
set to the declared run directory for each command.

The 1.2 recorder attests the direct Node invocation of the installed Vitest
`vitest.mjs` module with `run`, `--reporter=json` and an `--outputFile` inside
the declared run directory. A JSON file produced by another command is not
Vitest evidence. Run the relevant failing test through `check-run.mjs` with
`--vitest-json red.json`, passing `--reporter=json --outputFile
"$RIG_RUN_DIR/red.json"` to that Vitest invocation. Then run
`node .claude/scripts/tdd-evidence.mjs record-red --ticket <item> --check
<red-check-name>`. The writer verifies the failed structured result and adds
bounded RED evidence to `.rig/claims/<item>.json`. After the implementation,
run the same relevant test and test-file content through `check-run.mjs` with
a new structured output name, then run `record-green` with its passing check
name. A completed TDD-2 chain may receive a fresh GREEN only when the current
HEAD is one direct merge of the current default-branch tip, that tip is a strict
descendant of the selected baseline and prior validated default tip, the merge
first parent reproduces the prior implementation boundary, the merge commit
equals the mechanical merge of its two parents (`git merge-tree --write-tree`,
refusing a conflict or an unsupported git the same way), and the working tree
carries no uncommitted production change on top of it — not that the
working-tree delta stays byte-identical to the prior boundary, which a clean
merge that also touches the item's own production file in a disjoint hunk
cannot satisfy even though it adds nothing beyond the merge:
`test/template/tdd-green-refresh-overlap.test.ts` (absent in a generated rig)
› "refreshes GREEN after a clean direct default merge that also changed the
item's own production file" and › "still refuses a merge commit that adds a
manual production edit to the item's own file".
When the terminal history entry is a validated prior
merged-default refresh, that reconstruction starts from its recorded default
tip; a validated stale-RED replacement leaves the selected baseline as the
first refresh's reconstruction base. The refreshed boundary starts at the
current default tip, so its production delta cannot attribute already-merged
default-branch work; it preserves the native RED and records the prior TDD-2
chain with a bounded, fingerprinted refresh transition. Commit the claim with
the work. The `pr-ship` verifier reads the claim
from branch `HEAD`, compares it with the current tracker and final Git diff,
and records compact evidence fingerprints in the run journal.
When the relevant specification is unchanged, a fresh GREEN may replace a
completed TDD-2 chain after an implementation refinement. With an `origin`
remote configured, the recorder reads the live default with one bounded query:
the branch origin advertises as `HEAD`, or else exactly one of
`refs/heads/master` and `refs/heads/main`, matched by exact name. It does not
alter a remote-tracking cache, and a missing or ambiguous answer refuses. With
no `origin` URL there is no live authority to ask, so the recorder uses the
default the claim baseline itself resolves from local refs, as before. These
three cases are pinned in `test/template/tdd-green-refinement-authority.test.ts` (absent in a generated rig)
› "records a merged-default refresh when origin's default branch is main",
› "does not treat a branch named x/refs/heads/master as a second default" and
› "records a merged-default refresh in a repository with no origin remote".
If the live default has advanced, a pre-import refinement
is eligible only when it remains uncommitted and the committed boundary still
matches the retained evidence. The replacement must have a different production
delta, retain the original RED and relevant test bytes, and append a bounded
same-baseline transition. The transition is pinned in
`test/template/tdd-green-same-baseline-refinement.test.ts` (absent in a generated rig)
› "records a fresh same-baseline GREEN after an owned source refinement while
retaining the prior evidence". After a validated merged-default refresh, a later
refinement's production delta is measured from that imported default rather than
from the selected baseline, so default-branch work is never attributed to the
item: `test/template/tdd-green-refinement-authority.test.ts` (absent in a generated rig)
› "keeps a later correction boundary relative to the validated merged default (%s correction)".
If the relevant test file changes, run the changed test while failing and call
`record-red` again before recording GREEN. The new RED must keep the same file
and full test name with a different file hash. The recorder keeps the prior
portable chain in `tddEvidenceHistory` and makes the newly observed RED
active, including when the prior chain had reached TDD-2. This transition is
pinned in `test/template/tdd-evidence-flow.test.ts` (absent in a generated rig)
› "replaces a stale RED with a newly observed RED for the changed test hash"
and › "replaces completed TDD-2 with a newly observed RED when the relevant test changes later".
The relevant-spec and runner checks are pinned in
`test/template/tdd-evidence-flow.test.ts` (absent in a generated rig) › "records an existing failing
check-run test only when SELECT carried its tracker-derived relevant spec"
and › "refuses a Vitest-shaped report written by an arbitrary node runner".
The portable handoff is pinned in `test/template/tdd-baseline-continuation.test.ts` (absent in a generated rig)
› "refreshes TDD-2 GREEN across two verified merged default advances without
attributing either production delta";
the refresh-authority refusals are pinned in
`test/template/tdd-baseline-refresh-authority.test.ts` (absent in a generated rig)
› "refuses a refresh that adds new production only in the direct merge commit",
› "refuses a sibling default that is descended from the selected baseline but not the prior validated default",
and › "refuses a refresh when tracked production changes after a clean direct default merge";
the compact shipping output is pinned in `test/template/tdd-durable-verdict.test.ts` (absent in a generated rig)
› "prints the exact portable RED, implementation-boundary, and GREEN
fingerprints on a TDD-2 PASS".

## Why

Observable evidence can be checked across controller and machine boundaries.
Narrative descriptions cannot prove ordering, test identity, or continuity.

## Rollback

Revert the portable schema, its documented decision, and any RP-306 consumer
together. Do not replace it with controller prose or an untracked journal.
