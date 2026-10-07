# External artifacts become Rig evidence, never Rig verdicts

## Context

Work in a rig produces artifacts that other tools make: a CI test report, a
security scan, a browser trace, a QA tool's assessment. Before RP-312 they
reached the gates only through prose — a PR body, a comment — that a later
session could not read back or bind to the commit it was about.

Two tempting answers were rejected. A store per provider would give every
integration its own format and its own idea of "passed", and the gates would
end up reading several. Letting a producer's own `pass` or `fail` stand as a
gate result would move the decision about a change out of Rig into whichever
tool happened to run.

## Decision

External artifacts are normalized into the evidence path Rig already has, not
into a provider-specific store. `.claude/scripts/evidence-attach.mjs` is the
one entry point. It journals an `artifact-evidence` event in the run and
appends the same descriptor to `.rig/evidence/<ticket>.jsonl` — an item-owned
record written through `lib/item-records.mjs`, the mechanism the delegated
decisions in `.rig/decisions/` use. One store, one append, one bounded read.

**The descriptor (schema version 1):**

| field | meaning |
| --- | --- |
| `kind` | what the artifact is (`test-report`, `browser-trace`, …) |
| `subject` | what it is about: `{ kind, id, version? }` |
| `authorityClass` | what kind of source produced it (`automated`, `human`, …) — provenance, not a grant; a Rig verdict word is refused |
| `producer` | the tool or person that produced it |
| `ref` | where it is: a repo-relative path, or a bounded remote reference |
| `sha256` | the digest of a local artifact's bytes; `null` for a remote one |
| `item` | the queue item it belongs to |
| `headSha` | the commit it was produced against |
| `producedAt` | when it was attached |
| `advisory` | optional: the producer's own `{ decision: pass \| concerns \| fail, summary? }` |

`subject` is the stable identity of what the evidence is about; `item` binds
it to the 1.x queue the gates read today.

**Local artifacts are hashed, remote ones are referenced.** A file inside the
project is hashed (SHA-256) through its open handle in bounded chunks and
recorded by its repo-relative path; a symlink, a path outside the project, a
credential path or an oversize file is refused. A remote or PR-hosted artifact
is recorded as a bounded reference only, with no digest, and a reference that
carries a credential-shaped value is refused rather than stored. Free-text
fields go through the same redaction as every other journaled field.

**Current-head staleness.** Evidence is bound to the `headSha` it was attached
at. `lib/gate-coverage.mjs` splits a run's journaled evidence into `current`
(attached at exactly the commit asked about) and `stale` (any other head), and
`verdict.mjs coverage` prints the counts: evidence bound to another head does
not count as current, and new evidence has to be attached at the new head.

**Degradation.** An unavailable provider or evidence source is not a failure
by itself. Evidence only matters where an existing applicability rule
requires its category; where none does, its absence changes nothing.

**Advisory only.** A producer's `pass`, `concerns` or `fail` is evidence and
never becomes a Rig SHIP or HOLD. An advisory `pass` cannot satisfy a gate Rig
requires, and an advisory `fail` does not by itself turn a valid Rig verdict
into HOLD; only Rig's own gates and policy decide that.

**The identity boundary.** That last rule is not a provider policy: it is what
keeps Rig the execution and evidence kernel. The descriptor is the deliberate
seam to the outside ecosystem. The first producer-specific exception — one
tool whose `fail` blocks, or whose `pass` counts as review — would move the
ownership of decisions into Rig on that tool's terms, so it needs a separate
architecture decision that changes Rig's ownership model, never an incremental
schema extension.

## Non-goals

- No new journal and no new database: the run journal and the item-owned
  record are the whole of it.
- No artifact-to-deployment provenance chain; the descriptor's `subject` and
  `sha256` leave room to export to an attestation format later.
- No QA-specific layer and no provider plugin API.

## Consequences

Producers integrate by calling one command with one descriptor. The `loop`
skill commits `.rig/evidence/<ticket>.jsonl` with the item's branch, as it does
`.rig/decisions/`, and once committed a later session or another clone reads
the item's evidence back with `list`. The
evidence never edits the run's gate record, so coverage stays decided by
Rig's own reviewers and checks.
