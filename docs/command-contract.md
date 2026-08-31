# Command contract v1.0

Language: English

Status: proposed for RP-17. Owner acceptance is required before RP-18 and RP-19
build against it; until then this document states intent, not installed
behaviour. `## Open questions for acceptance` is the list acceptance has to
settle.

## Scope

This contract binds the published tool bins — the rig bin and the memory shim — and does not bind this repository's internal .claude/scripts/ fleet.

That sentence is a **labelled assumption**, and it is here because the item this
document answers never named the tools it binds. `check-premises` returned
`UNVERIFIABLE` on exactly that question. The assumption's support is RP-19,
which delivers the version handshake "in rig, the memory shim" — those two bins
and no others.

The carve-out matters because `.claude/scripts/` is not a neutral space: it
already spends exit 2 on meanings of its own, and carries an unattended signal
that is a file rather than a variable. Read as a description of that fleet, this
document would be false on arrival, and each such place would be a migration
rather than a specification. `## Conformance today` records the ones this change
measured; it is not an inventory of every difference, and no count is claimed.

What the contract covers, once accepted: subcommand names, documented flags,
exit codes, and the keys of the JSON payloads named here. Anything a bin does
that this document does not name is not contract, and may change without a
version bump.

## What this contract does not cite

- **`rp-jira-plan.md` §4** — the item's named source. It is in none of the three
  repositories, and an exact-name search of the accessible owner Drive on
  2026-08-27 found no match (`docs/identity-discovery.md`, "What the table does
  not cite"). The item's own text was used instead, and every claim it makes
  about this repository was checked against the code.
- **`[A4]`** — named by the item as the rig layer that rolls the conformance
  matrix out. It names nothing this repository defines: outside this document
  and its test, the token occurs nowhere. The matrix below is therefore
  specified without a rollout mechanism; whoever supplies `[A4]` binds it.
- **RP-57's schema** — the lifecycle state vocabulary below is contract now; its
  schema spelling is RP-57's, in another repository. This is the same split
  `docs/session-messaging-contract-v0.md` uses when it defers type spelling to
  RP-12.
- **The load selection budget's default and bounds.** The item's amendment (e)
  calls them contract-defined. This contract does not fix them, and saying so is
  the honest form: the numbers are declared by the first ticket that ships
  `load --json`, arriving as a minor bump. The same treatment `degradation[]`'s
  members get below, and it is on the acceptance list.
- **The doctor status set's coverage of this project's own doctor marks**, and
  **`degradation[]`'s members** — both on the acceptance list rather than
  settled here.

RP-18, RP-19, RP-52 and RP-57 are cited above and below as **tracker items**,
not as documents. Only RP-57 earns a carve-out, because this document defers a
spelling to it; the others are named to say who owns a piece of work, which
needs no citation.

## Exit codes

A conforming bin uses these five codes and no others.

| code | meaning                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| 0    | The operation succeeded — including the case where there was nothing to do.                                                   |
| 1    | The operation ran and failed.                                                                                                 |
| 2    | The invocation was wrong: an unknown subcommand, an unknown flag, a missing or malformed argument. Nothing was attempted.     |
| 3    | The command will not run as invoked. The JSON payload names which case it is and lists what is missing, one entry each.       |
| 4    | Contract major mismatch: the caller and the bin do not agree on a major version, so neither may guess at the other's payload. |

Emptiness is exit 0 plus a field in the JSON payload, never a distinct exit code.

The reason is that "nothing to do" is a successful answer to a question, and a
caller that has to distinguish success from emptiness by exit code cannot also
distinguish either from a failure. This is inherited from the queue's own
`queue-empty` versus `queue-unreadable` split, where the first carries success
and the second does not.

The line between 1 and 2 is whether anything was attempted. A bin that rejected
its arguments has done nothing and is safe to retry with different arguments; a
bin that exits 1 may have done part of the work, and the caller must read the
payload to know.

**Exit 3 has two occasions, and the payload says which.** One is an unmet
environment prerequisite — a variable that is not set, a command that is not on
the search path — and there the payload lists them. The other is a command that
would have to ask a question while `RIG_UNATTENDED` is set, where nothing is
missing from the environment at all: a lifecycle transition refusing to decide
unattended is the case this contract names. A refusal of the second kind reports
the refusal and an empty list, rather than inventing a prerequisite to fill it.
The discriminator is a `result` field, not the exit code.

## Output

Under --json, stdout carries exactly one JSON object and nothing else.

Every top-level payload this contract defines carries schemaVersion.

Human-readable rendering goes to stderr.

Records nested inside a payload — a doctor check, a missing-prerequisite entry —
carry no version of their own; the payload's covers them. Saying this explicitly
is what stops a conformance-matrix author guessing, and it is why the sentence
above says "top-level payload" rather than "object".

Those three rules exist together for one reason: a caller pipes stdout into a
parser, and anything else on that stream — a progress line, a warning, a second
object — turns a correct run into a parse error. Without `--json`, a bin may
render to stdout as it likes; the rule binds the machine mode only.

Schema evolution is **additive**. Unknown keys are tolerated rather than treated
as an error, so a bin may add a field in a minor version without breaking a
caller written against an earlier one. A foreign major is rejected outright: the
consumer refuses to interpret the payload at all — that is what exit 4 is for.

## The version handshake

Every conforming bin answers `--version --json` with an object carrying at least
`name`, `version` and `contractVersion`:

- `name` — the bin's own name, stable across versions.
- `version` — the release version of the bin, semver.
- `contractVersion` — the version of _this_ contract the bin implements, semver.

`version` and `contractVersion` move independently: a bin may ship many releases
against one contract version. The consumer compares majors of `contractVersion`
alone.

The handshake is the only invocation a consumer may make before it knows whether
the two agree, so it must never fail for a contract reason. A bin that cannot
answer the handshake is broken, not incompatible.

## Configuration

Precedence runs flags over environment variables over a configuration file.

A value present at a higher level is used; a value absent there falls through.
Nothing merges partially — precedence is per value, not per source.

**A credential is carved out of the flag level.** Its chain is the environment
variable, then the configured file, and nothing above them. A flag may name the path of a credential file, never its contents.
Without this carve-out the precedence rule above and the argv rule below
contradict each other, and an implementer resolves the contradiction in favour
of whichever section they read last. Nothing is lost by it: under
`RIG_UNATTENDED` a missing credential is exit 3 with the list, so no flag is
ever needed to supply one non-interactively.

The environment namespace is `RIG_*`. Only documented variables are read. A
conforming bin does not consult an environment variable this contract or the
bin's own `--help` does not name, so an operator can tell from the documentation
what the environment can change.

## Secrets

Secrets never appear in argv.

An argument vector is readable by every process on the host, is captured by
shell history, and is echoed into CI logs. A bin that needs a credential reads
it from an environment variable, or from a file whose path is configured.

No credential value appears in any JSON payload, in the human rendering, or in an error message.

A credential that is missing, malformed or rejected is reported by its variable
**name** and by what was observed about it — never by its value. This is the
rule the payload restrictions further down generalise: rule (h) restricts file
paths, and paths are not the only class of content a payload must not carry. The
reason it is stated here rather than left implied is that a rejected credential
is exactly the case an implementer wants to put in a `detail` field, and a
`detail` field goes to stdout, to stderr, and from there into whatever captures
them.

**The file's name is part of the rule, not an implementation detail.** It must be
one this project's credential vocabulary recognises — an `.env`-form name, or a
file under a `secrets/` or `credentials/` directory (`.claude/scripts/lib/secrets.mjs`,
`isCredentialPath`). A configured path with an ordinary name is invisible to
every layer that refuses a credential by name: measured, `jira.env` is
recognised while `jira.conf`, `jira.toml` and `credentials.json` are not. An
example that satisfies this: `~/.config/create-agent-rig/jira.env`.

An installer that writes such a file inside a repository must write its ignore
entry in the same change. ⚠ **The ignore entry is not sufficient on its own, and
this project already learned that.** It was half (a) of AR-49; half (b) — the
credential sweep over tracked content — exists because the ignore rule could not
close the gap by itself. A reader who takes the ignore entry as the whole lesson
skips the layer that actually works. Note also that the rule does not reach the
example path above at all: a file in the operator's home directory is outside
every repository, so no ignore entry applies to it and only the name rule and
the value rule protect it.

A fixture that needs the _shape_ of a credential assembles it at runtime rather
than writing it out, or the project's own credential sweep reports its test data
as a leak.

## Unattended operation: RIG_UNATTENDED

When `RIG_UNATTENDED` is set, the command never asks a question. It does not
prompt, it does not wait on a terminal, and it does not fall back to a default
for something the operator was supposed to decide. Missing input is exit 3 with
the list of what is missing, one entry per prerequisite, so the caller can
supply all of it in one go rather than discovering it one prompt at a time.

RIG_UNATTENDED is a command-surface variable and is unrelated to the unattended flag that arms guard-rulebook, which is a file.

The two mechanisms share a name and mean different things, which is why that
sentence is here. The flag `guard-rulebook` reads is a file on disk written by
the `loop` skill at claim time, and an exported `RIG_UNATTENDED=1` arms nothing
there — pinned in
`test/template/guard-rulebook.test.ts` › "only a flag arms it — an exported RIG_UNATTENDED=1 with no flag changes nothing",
which sets the variable in the hook's environment and shows the guard ignores
it. A bin implementing this contract reads the variable in its own process,
which is a different question from what a `PreToolUse` hook can see.

## Mutations

A command that changes anything outside its own process is a **mutating
command**, and it carries three obligations:

- **A declared side-effect list.** The documentation names what it writes,
  creates, deletes or sends. A side effect the documentation does not name is a
  defect, not a feature.
- **`--dry-run`.** The command performs none of its declared side effects and
  reports what it would have done, in the same payload shape the real run emits.
  A dry run that answers in a different shape is a second implementation of the
  command, and the two will disagree.
- **A declared idempotence property.** The documentation says whether running
  the command twice with the same inputs is equivalent to running it once. Both
  answers are acceptable; leaving it unsaid is not, because the caller's retry
  policy depends on it.

## Doctor

`doctor --json` answers with a list of check records built from these four
fields:

- `id` — a stable identifier for the check, safe to match on.
- `status` — one of a closed set.
- `detail` — what was observed.
- `fix` — what a human should do about it.

The status set is closed: ok, warn, fail.

`id`, `status` and `detail` are present on every record. `fix` is present when
`status` is `warn` or `fail`, and omitted otherwise — there is nothing for a
human to do about a check that passed, and an empty string would be a value a
consumer has to special-case.

A doctor run exits 0 when no record has status fail, and 1 when one does. `warn`
never changes the exit code.

`detail` and `fix` are human-facing prose. Consumers act on `status` only —
matching on the wording of `detail` couples a caller to a sentence nobody
promised to keep. `fix` is also the one field in any payload this contract
defines that may name a file path.

Contract mismatch is **not** a doctor finding. A consumer detects it through the
version handshake and exit 4, before it interprets any other payload. A doctor
that reported it would be answering a question the caller must already have
resolved in order to trust the answer.

## The memory command surface

The memory shim must implement the contract above. This section adds what is
specific to it.

### The foundation verb set

The foundation verb set is closed at these four entries:

- `--version --json` — the handshake.
- `doctor --json` — core checks only.
- `load --json` — the shim's selection behaviour with its counters, budget and
  degradation reporting.
- `--dry-run` on mutating commands.

Nothing else is contract at 1.0. A verb outside this set may exist and may be
useful, but a consumer that depends on one is not depending on the contract.

### The reserved semantic namespace

Record projection, lifecycle transitions and storage synchronisation are
**reserved** but unnamed: this document fixes neither their command names nor
their payload keys. The first consumer ticket that needs one adds it as a minor
bump, which the additive rule above already permits.

### Lifecycle states

The lifecycle state vocabulary is closed at these four states: candidate,
approved, rejected, superseded. The four words are contract now. Their schema
spelling — field name, representation, and which transitions are legal — belongs
to RP-57, and the promotion _behaviour_ to RP-52.

Lifecycle transition commands refuse under RIG_UNATTENDED and exit 3. A
promotion or a rejection is a judgement, and a run with nobody watching is
exactly the run that should not be making one. This is the second occasion for
exit 3 described above: nothing is missing, and the payload says so.

### Storage-tree ownership

Only the memory subsystem reads or mutates its storage tree. Every other party
goes through the command surface — consumers use the command surface and never
touch the files.

The rule buys the freedom to change the storage layout in a patch release. A
consumer that reads the tree directly turns every layout change into a breaking
one, silently, and the breakage surfaces in the consumer rather than in the
subsystem that caused it.

### The load selection budget

The selection budget is a per-invocation input, and never core-global configuration.
A budget that lives in shared configuration is a setting one caller changes and
another caller's behaviour follows. Per-invocation, a caller that wants more
asks for more.

Its default and bounds are contract, and **this version does not fix them** —
they arrive with the first ticket that ships `load --json`, as a minor bump.
Saying so is deliberate: the item's amendment (e) asks for contract-defined
numbers, and a document that repeated the requirement without supplying a number
would read as having satisfied it. Listed in `## What this contract does not
cite` and on the acceptance list.

### Payload rules specific to the shim

- No file paths appear in any JSON this contract defines, except in a `fix`
  field, which is an instruction to a human — the same single spelling of the
  rule as in `## Doctor`, and `fix` is a doctor-record field, so the two say the
  same thing. Together with the credential
  rule in `## Secrets`, this is the whole of what a payload may not carry: a
  path, and a credential value.
- `degradation[]` is a closed enum, in the sense that each version of this
  contract enumerates its members and a bin emits no member the version does not
  name. **Contract 1.0 enumerates none**, so a bin claiming `contractVersion`
  1.0 emits an empty list; the first minor that declares members is what makes a
  non-empty one legal, and the first ticket that ships `load --json` is what
  declares them. A consumer that nevertheless meets an unrecognised member
  treats it as an unspecified degradation rather than failing — the additive
  rule again. On the acceptance list, because reading (i) this way is a choice
  and the owner may want the members fixed here instead.

## Stability and versioning

What is covered: subcommand names, documented flags, exit codes, and the JSON
keys named in this document.

- Adding a subcommand, a flag, a JSON key or an enum member is a **minor** bump.
- Renaming or removing any of them is a **major** bump, and must be preceded by
  at least one minor release in which the old spelling still works and is
  documented as deprecated.

A change nobody can detect through the covered surface is a patch.

## Conformance matrix

Conformance is demonstrated by a golden matrix: one row per invocation, each row
naming the invocation, its expected exit code, and the schema its payload must
satisfy. The matrix is the executable form of this document — a claim here that
no row exercises is a claim nothing is holding.

The item names `[A4]` as the rig layer that rolls the matrix out. That referent
is absent (see above), so this document specifies the matrix's shape and leaves
its delivery to whoever supplies the layer.

## Conformance today

**Nothing in this repository implements this contract yet.** This section is the
honest half of the document: it records what was measured about the surfaces
this change touched, so that no reader takes a statement above as a description
of installed behaviour. Every row below names the test that pins it, and goes
red when its claim stops being true. It is what was measured, not an inventory:
a difference this section does not name is a difference nobody checked, and each
row's reach is the reach of its test and no wider.

- **The rig bin has no `--json` flag.** Pinned in
  `test/template/command-contract.test.ts` › "reports that the rig bin has no --json flag".
- **The rig bin names no `contractVersion` anywhere under `packages/cli/src`**,
  so nothing it prints in answer to `--version` is a handshake object. Pinned in
  `test/template/command-contract.test.ts` › "reports that the rig bin answers --version with no contract handshake".
- **The rig bin has no exit code outside 0 and 1** — no literal above 1 is
  returned, passed to `process.exit`, or assigned to `process.exitCode` anywhere
  under `packages/cli/src`. Pinned in
  `test/template/command-contract.test.ts` › "reports that the rig bin's only exit codes are 0 and 1".
- **No reader of `RIG_UNATTENDED` exists under `.claude/scripts/`,
  `.claude/hooks/` or `packages/cli/src/`.** Those three trees are the row's
  whole reach: the template copies under `templates/agent-os/` are not scanned,
  and neither is any extension but `.mjs` and `.ts`. Pinned in
  `test/template/command-contract.test.ts` › "reports that nothing in this repository reads RIG_UNATTENDED".
- **Exit 2 is already spoken for in the internal script fleet**, on meanings
  that are not this contract's: the queue CLI spends it twice over — gate rounds
  exhausted, and a revalidation hold — and the revalidation script spends it on
  the second. This is why `## Scope` carves that fleet out rather than claiming
  it. Pinned in
  `test/template/command-contract.test.ts` › "reports that exit 2 is already spoken for in the internal script fleet".
- **A third script pins the opposite convention outright.** In `verdict.mjs` the
  exit code says whether the report was usable, never what the verdict was — a
  well-formed `HOLD` exits 0. An exit-code table claiming to cover every command
  here would have to carve that one out by name. The behaviour is pinned in
  `test/template/verdict.test.ts` › "exits 0 on a well-formed HOLD — a refused change is not a broken check",
  and that pointer is itself kept alive by
  `test/template/command-contract.test.ts` › "reports the third script that pins the opposite exit convention".
- 🔴 **Doctor answers two marks this contract's status set has no slot for.**
  Alongside its pass and fail marks it answers `unknown` and `exempt`. Its
  argument about `unknown` is that a probe which could not run must never be
  read as a **pass** — "could not look" is not "it is fine". It does resolve an
  `unknown` to a caution-level run verdict, so the objection is to the pass and
  not to the warning. That behaviour is pinned for the template copy of the
  script in
  `test/template/doctor.test.ts` › "an unknown-ownership hook without a test is unknown, and the run is CAUTION not GO",
  and for this repository's own copy in
  `test/template/command-contract.test.ts` › "reports the doctor marks the contract's status set has no slot for",
  which calls `verdictOf` rather than reading its source. `exempt` has no verdict
  of its own to call — `verdictOf` branches on `FAIL` and `unknown` only — so
  that half of the row is a source read, and would stay green if the mark were
  removed from `auditHooks` while its name survived in a comment. This is the
  first item on the acceptance list.

## Open questions for acceptance

Three things this document deliberately does not settle. Each is a choice the
owner makes at acceptance, and each is written here rather than resolved
quietly, because a specification that guesses is worse than one that asks.

1. **Doctor's two extra marks.** The project's own doctor answers `unknown` and
   `exempt`; the status set above has three members and no slot for either.
   Three exits: add the two statuses in a 1.1 minor; require a conforming doctor
   to report an unrunnable check as `fail`; or map `exempt` to `ok` with the
   exemption named in `detail`.
2. **`degradation[]`'s members.** This document reads amendment (i) as "closed
   per version, empty at 1.0". The alternative is to enumerate the members here
   and make the field usable at 1.0.
3. **The load selection budget's default and bounds.** Deferred to the first
   ticket that ships `load --json`. The alternative is to fix the numbers here,
   which is what a literal reading of amendment (e) asks for.

## Fixtures

Examples, one per shape the contract names. They are illustrative payloads, not
a schema — the conformance matrix above is where a schema belongs.

The version handshake:

```json
{
  "schemaVersion": 1,
  "name": "rig",
  "version": "0.6.2",
  "contractVersion": "1.0"
}
```

A successful run with nothing to do — exit 0, and the emptiness is a field:

```json
{
  "schemaVersion": 1,
  "result": "ok",
  "empty": true,
  "reason": "queue-empty",
  "items": []
}
```

Environment prerequisites unmet — exit 3, first occasion, and the payload lists
them:

```json
{
  "schemaVersion": 1,
  "result": "prerequisites-unmet",
  "missing": [
    { "kind": "environment", "name": "RIG_HOME", "detail": "not set" },
    { "kind": "command", "name": "git", "detail": "not on the search path" }
  ]
}
```

A lifecycle transition refusing to decide unattended — exit 3, second occasion,
and nothing is missing:

```json
{
  "schemaVersion": 1,
  "result": "refused-unattended",
  "refused": "lifecycle transition",
  "missing": []
}
```

A doctor run with one failing check — exit 1. `fix` is present on the failing
record and omitted on the passing one, and it is the one field allowed to name a
path:

```json
{
  "schemaVersion": 1,
  "status": "fail",
  "checks": [
    {
      "id": "hook-test-neighbour",
      "status": "fail",
      "detail": "an owned hook has no test beside it",
      "fix": "copy .claude/skills/new-invariant/guard-invariant.example.test.mjs next to the hook"
    },
    {
      "id": "manifest-present",
      "status": "ok",
      "detail": "the install manifest was read"
    }
  ]
}
```

A memory load reporting its counters and its budget. `degradation` is empty
because contract 1.0 enumerates no members; a later minor that declares them is
what makes a non-empty list legal:

```json
{
  "schemaVersion": 1,
  "result": "ok",
  "counters": { "eligible": 41, "injected": 12, "budgetSkipped": 28, "invalid": 1 },
  "budget": { "limitBytes": 65536, "usedBytes": 51204 },
  "degradation": []
}
```
