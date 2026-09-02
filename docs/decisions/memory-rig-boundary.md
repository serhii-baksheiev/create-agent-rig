# ADR-RP-002 — the Memory ↔ Rig boundary

⚠ **This record is not synced.** Most files in this directory are composed from
`templates/agent-os/universal/docs/decisions/` by `scripts/sync-agent-os.mjs`
and travel into every generated project — and `CLAUDE.md` rule 5 says an edit
to a synced file is lost at the next sync. This one is authored here and stays
here: it rules on this product's own subsystem boundary and names tracker keys,
so no shipped rulebook cites it, which is what
`test/template/decision-records.test.ts` refuses in the template layer. **Edit
it in place.** The precedent is `cost-ceiling-over-growth-ratio.md` beside it.

Status: accepted. The rulings R1–R7 are recorded on RP-75 as comment `15643`,
which attributes them to Architecture Review **passes 1–3**; the pass-2
sections below come from the item's own description, which cites **pass 2**.
Both provenance lines are the tracker's, not this repository's, and neither is
checkable here — nor is the word "verbatim" below, for the same reason. What a
reader here can check is that the rulings keep their numbering R1…R7 and are
quoted as blocks rather than folded into prose.

🔴 **Read this first: almost nothing here is enforced in this repository
today.** This record is a *forward contract*. `packages/` in this repo contains
exactly one entry, `packages/cli`; there is no `packages/memory`, and the
structural test R1 requires has no second side to compare against yet. What the
rulings below govern is the work RP-57, RP-18, RP-19 (0.9.0) and RP-58, RP-95,
RP-24 (0.10.0) will do — **board state as of 2026-09-02**, which this
repository cannot confirm and a reader should re-check on the tracker. A reader
who takes the rulings as descriptions of present code will be wrong about every
mechanism they name. Where something *is* already
written down, this record cites it rather than restating it — see "What already
exists" at the end.

## Why this record exists

Memory is a subsystem the Rig Platform ships as one product, and the question
that keeps recurring is not *where the code lives* but *what may depend on
what*. Two repositories, one product, and a user's durable data in the middle of
it. Answered per-ticket, that question gets a different answer each time — so it
is answered once, here, and the tickets implement this rather than re-deriving
it.

The one sentence the rest of this record elaborates:

> Memory is part of the Rig Platform **product** — one install, one CI, one
> release train — without being part of Rig Core's **implementation**.
> Repository co-location is composition; an `import` would be coupling. The
> structural test is what keeps the two apart.

## The rulings, R1–R7

Carried verbatim from the Architecture Review — RP-75, comment `15643`,
2026-09-02, in the tracker rather than here — because the tickets that implement them cite them by
number and a paraphrase would fork the fact. ⚠ A reader inside this repository
cannot check that word "verbatim": the source is a tracker comment, not a file
here. What is checkable is that nothing below has been renumbered or
abbreviated, and that the ruling text is quoted rather than summarised.

**R1 — Implementation coupling.** Rig Core (`packages/cli`) has no source-level
or runtime API dependency on Memory. A structural test enforces: no
import/require across `packages/cli` ↔ `packages/memory`; no path literal into
the other package in non-test source; `packages/memory` builds and tests green
with `packages/cli` absent. The only permitted cross-package read is
`packages/cli` tests reading `packages/memory/contract/**` as data.
`packages/memory` has no dependency of any kind on `packages/cli`; root
workspace scripts orchestrate CI only. The Rig distribution may declare Memory
as `optionalDependencies`; if so, `setup` derives the manifest entry from that
resolved copy, exactly one Memory installation is active, and compatibility is
established by the `{name, version, contractVersion}` handshake at every call —
never by a package version range.

🔴 **R1's `optionalDependencies` clause collides with a rule of this
repository, and this record does not resolve it.** `CLAUDE.md` rule 3 states
that the CLI keeps **zero runtime dependencies**, and gives the reason: it is
what keeps the `npx github:…` and tarball paths working. `README.md` states the
same as a property of the published package, and the root `package.json`
carries neither a `dependencies` nor an `optionalDependencies` field. R1 says
the distribution *may* declare Memory as an optional dependency. Those two
cannot both be followed.

This record does not resolve the collision — two rules of this project genuinely
collide, and the resolution belongs in the rules rather than in the history of
one pull request. It does take the non-destructive side while the owner decides,
and says so rather than leaving the gap silent: **treat R1's clause as blocked
by rule 3 until an owner rules.** Concretely, a session implementing RP-24 —
whose job R7 gives as verifying the distribution model — proceeds with
everything else in RP-24 and simply does not exercise the permission; it does
not need to stop, and it must not add the dependency, because that would land on
exactly the install paths rule 3 names and quietly falsify the README.

**R2 — Incubation.** `claude-config/shared-memory` — implementation, contract,
schemas, fixtures as one unit — is an incubation location and is vacated before
the first non-owner installation. This does not decide the eventual location of
the Claude/Codex harness adapters. Memory storage is user data, is never
incubated anywhere, and is never part of a product repository or a project
working tree.

**R3 — Preferred destination.** `create-agent-rig/packages/memory`. RP-58 fixes
the destination at the start of 0.10.0 on 0.9 evidence. Named reversal
triggers: a named second maintainer requiring independent ownership; a second
Memory implementation requiring an independent lifecycle; an external adopter
requiring an independent release cadence. Absent one, the workspace destination
executes (RP-95). Leaving `claude-config` before the first non-owner install is
not reversible; only the exact destination is, until RP-58.

**R4 — Timeout and command safety.** Timeout duration and its degradation
mapping belong to the consumer. The Memory contract defines no latency number.
It does define: every command is kill-safe (observable state after termination
at any instant is pre-state or post-state); `load` performs no network I/O;
`publish` is idempotent.

**R5 — Canonical identity.** Identity is the normalized Git remote URL
(scheme-insensitive where equivalent; host case-normalized; embedded
credentials and `user@` stripped; default ports stripped; `.git` and trailing
slash stripped; SSH `:` ≡ `/`). Remote selection deterministic (`origin`, else
first in documented order) and recorded. Root commit is provenance:
`firstSeenRootCommit` per namespace, stamped per record. On divergence:
`identity.status = diverged`, visible in `load` and `doctor`, subsystem
`DEGRADED` / `identity-diverged`; reads and writes continue with provenance;
nothing silent, no new namespace. No remote → `unresolved` → `UNSUPPORTED`, no
namespace. Threat model: canonical identity is not a security identity; a
working-tree owner can set any remote; deliberate local spoofing is an accepted
risk inside this ADR's cooperative-developer boundary; the cross-machine
variant — a poisoned candidate arriving through sync — is the security case for
human-gated promotion (RP-52). Memory never executes repository-provided
content; repository content never travels on argv; malformed present output is
a fault, never absence.

**R6 — Manifest.** Installation metadata, not a service registry. One writer
(`setup`; `upgrade` re-runs derivation); one scope (machine/user,
`~/.config/create-agent-rig/`); one entry per subsystem (executable location +
declared contract requirement); no project-local normal-path edits; no search
path, no fallback chain, no PATH scan; `doctor` validates existence and
handshake (`INTEGRATION-FAILED` / `manifest-stale` otherwise). Rig Core and
harness adapters read the same entry. They are peer consumers at runtime;
installation of executable, manifest and adapter registrations is owned by
`setup`; uninstall removes registrations and manifest, never storage.

⚠ **R6 is about a Memory manifest that does not exist yet, not about the rig's
own.** This repository already has `.claude/.rig-manifest.json`, written by
`create`, `init` and `upgrade` and read by `doctor` — project-local, committed,
and untouched by this record. R6's "no project-local normal-path edits" governs
the machine-scoped subsystem manifest it describes; read together with the
warning at the top of this file, it rules on nothing that exists here today.

**R7 — Sequencing.** 0.9.0 establishes the seam (RP-57 both backends + D-1/D-2
+ location-independence + kill-safety + network-free `load`; RP-18; RP-19).
0.10.0 runs RP-58 → RP-95 → RP-24; RP-95 Blocks RP-24, Relates RP-22; RP-24
verifies the distribution model and is not evidence for choosing it. RP-13's
pinned-ref fetch is the 0.9.0 mechanism. RP-78 may decide a packaging channel,
never a repository move.

## The canonical data model is authority-neutral

Canonical Memory is immutable logical record bodies plus append-only lifecycle
events. **Physical layout is not part of the executable contract.**

1. One logical record per stable surrogate `recordId`; body immutable after
   publish; `contentHash` identifies content.
2. Lifecycle is append-only events, and current state is their deterministic
   fold.
3. Supersession is explicit: the new record references `supersedes`, the old
   record receives a superseded event.
4. A full store read reconstructs complete logical state with no external
   input.
5. Physical layout carries an independent `storageLayoutVersion`; changing
   layout requires a migration plus an export/import round-trip proving
   identical logical state.
6. Derived projection or index data never lives in the canonical repository.
7. A Git authority implementation uses text/diffable units and avoids one
   global write hotspot — but that is implementation-specific, not a rule of
   the model.

## The authority contract

**Git is the first authority implementation, not the Memory architecture.** The
rules that survive a backend swap:

1. Exactly one authority per scope is the sole writer of approved transitions
   for that scope.
2. Approval is serialized, human-attributed and auditable; contradictory
   transitions cannot both be silently accepted.
3. Record and event IDs contain no authority coordinate — no commit, path,
   branch, row or URL.
4. Sync is idempotent and incremental against an opaque, node-local,
   authority-specific cursor.
5. Conflicts are surfaced, never auto-resolved.
6. The authority stores canonical records and events only, never derived
   projections.

Git pilot behaviour — protected `main`, PR merge, per-author candidates — is an
implementation of this contract rather than an ADR invariant. A future API
authority must preserve IDs and pass the same authority-neutral fixtures.

## Identity, so a backend can be replaced

- `recordId` and `eventId` are surrogate, creation-time IDs, independent of
  authority, path and content.
- Natural uniqueness is `(projectRemote, sourceKey)` over live records. The
  same `contentHash` is idempotent; new content creates a new record plus a
  supersession.
- `projectRemote` is immutable and stores the normalized remote observed at
  creation.
- Canonical grouping (`projectId`) is resolved at read time through an alias
  map, never persisted into every record.
- `author` is the platform-assigned user identity. A Git commit author or SHA
  is a provenance assertion only.
- Authority is node configuration (`scope → authority`), never a record or
  event body.
- Scope is lifecycle state, not a mutable envelope field.
- Export and import of records plus events must preserve identical logical
  state **and** identical IDs.

## Semantic retrieval is never authoritative

Retrieval is a discovery aid. **No gate, verdict, promotion or policy outcome
may depend on a similarity score, a rank position, or the presence or absence
of a semantic match.** Retrieval may propose candidate records and nothing
more.

Any record that influences governance must be identified by `recordId`, read
from canonical storage, evaluated deterministically, and listed in the decision
evidence. The decision must replay to the same outcome from the same explicit
`recordId` list **with retrieval disabled**. No semantic match is not evidence
of absence.

This is the same rule the policy layer already applies to capability states:
"could not check" is never "checked and fine"
(`packages/cli/src/policy/core/decision-record.ts`, the never-silent-pass rule).

## Projections and embeddings

The canonical envelope is embedding-neutral. SQLite, FTS5 and vectors are
derived, rebuildable and deletable, and are never synced as canonical data. An
optional retrieval policy may later become authority data (`modelId`, version,
dimension, normalization, chunking) without central vectors. A missing local
model means semantic recall is unsupported while lexical recall may remain
supported; a stale or mixed index is degraded.

## Network boundary

No Memory network path except an explicit `sync` or `publish`. `load` stays
network-free. A future `recall` must be local: no embedding API call hidden
inside Memory.

## What 0.10 does not do

No SQLite, FTS, vector, embedding, recall or service rewrite in 0.10.
Team-capability work influences the schema and the authority-neutral boundaries
only. **RP-8 performs the data migration; RP-95 performs the implementation
relocation** — two tickets, two concerns, in that order.

## What already exists, and is cited rather than restated

Three documents in this repository already cover ground these rulings touch.
They are the source for their own subject; this record adds the boundary, not a
second copy.

- `docs/identity-discovery.md` — the six-axis identity table across bus, memory
  and rig, with citations into all three repositories. R5 lands on its
  *project* row.
- `docs/command-contract.md` — scoped by an owner ruling to the published tool
  bins, explicitly not `.claude/scripts/`. It is the contract R4's `publish`
  obligation meets: its "declared idempotence property" requires the
  documentation to say whether re-running a command repeats its effect. ⚠ It
  covers **none** of R4's other three parts — timeout ownership, kill-safety
  and the network-free `load` — and the words do not appear in it at all, so
  those three are stated here first and have no contract behind them yet.
- `.claude/rules/invariants.md` — "one mechanism, one implementation", which is
  why the two above are cited here instead of summarised.

## Risk, and how this is undone

The risk this record accepts is that a forward contract written before its
subject exists can be wrong about what the implementation needs. That is why R3
names three reversal triggers and RP-58 re-decides the destination on 0.9
evidence rather than on this document.

Rollback is per-ruling and cheap while nothing is built: amend the section here
and re-point the ticket, because nothing in this repository imports, reads or
executes this file.

Two rulings carry a deadline rather than a decision, and each states its own:
R2 vacates the incubation location **before the first non-owner installation**,
and R3 keeps only the exact destination reversible, and only **until RP-58** —
leaving `claude-config` is irreversible from the moment it happens.
