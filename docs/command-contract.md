# Command contract v1.0

Language: English

Status: accepted for RP-17 by owner acceptance (create-agent-rig PR #159), with
every field the item requires fixed; `## What acceptance settled` records the
five entries this document carried and what closed each. RP-18 built the memory
shim against it in claude-config, and RP-19 built the rig bin's handshake and
its `memory` consumer surface against it here; `## Conformance today` records
what of it this repository now implements, row by row.

## Scope

This contract binds the published tool bins — the rig bin and the memory shim — and does not bind this repository's internal .claude/scripts/ fleet.

That sentence is an **owner ruling**, recorded on RP-17 on 2026-08-31: the
contract binds the public platform bins, and internal Agent-OS scripts keep
their existing conventions unless a separate ticket migrates them. It was
carried as an open assumption for one round of this work — the item never named
the tools it binds, and `check-premises` returned `UNVERIFIABLE` on exactly that
question — and the ruling closed it. What made the reading a plausible one in
the first place was RP-19, which delivers the version handshake "in rig, the
memory shim" — those two bins and no others.

The carve-out matters because `.claude/scripts/` is not a neutral space: it
already spends exit 2 on meanings of its own, and carries an unattended signal
that is a file rather than a variable. Read as a description of that fleet, this
document would be false on arrival, and each such place would be a migration
rather than a specification. `## Conformance today` records the ones this change
measured; it is not an inventory of every difference, and no count is claimed.
Because those scripts are outside the contract, a difference recorded there is
a measured fact about an unbound tool — not a violation, and not a thing this
document is asking anyone to change.

What the contract covers, once accepted, is enumerated once — in
`## Stability and versioning`, which is also where the bump rules for changing
it live. Restating the list here is how two spellings of one fact drift, and the
one nobody is reading is the one that is wrong. Anything a bin does that the
document does not name is not contract, and may change without a version bump.

## What this contract does not cite

- **`rp-jira-plan.md` §4** — the item's named source. It is in none of the three
  repositories, and an exact-name search of the accessible owner Drive on
  2026-08-27 found no match (`docs/identity-discovery.md`, "What the table does
  not cite"). The item's own text was used instead, and every claim it makes
  about this repository was checked against the code.
- **`[A4]`** — named by the item as the rig layer that rolls the conformance
  matrix out. When this document was written it named nothing this repository
  defined, and the matrix was specified without a rollout mechanism. RP-13
  supplied the layer: the repository contract under `contracts/conformance/v1/`
  and `scripts/memory-conformance.mjs`, as `## Conformance matrix` records. The
  token itself still occurs nowhere else in this repository; it is the item's
  name for that layer, not a path.
- **RP-57's schema** — the lifecycle state vocabulary below is contract now; its
  schema spelling is RP-57's, in another repository.
- **RP-57's account of budget semantics.** Amendment (e)'s default and bounds are
  fixed below, by measurement and by the owner ruling of 2026-08-31
  respectively. RP-57 still owns the wider behavioural account — determinism,
  counter semantics, the harness input surface — and it is parked behind the
  Memory MVP behaviour freeze, so nothing of it is cited here.

RP-18, RP-19, RP-52, RP-57 and RP-69 are cited above and below as **tracker items**,
not as documents. Only RP-57 earns a carve-out, because this document defers a
spelling to it; the others are named to say who owns a piece of work, which
needs no citation.

## What holds each statement here

This document mixes four kinds of statement, and they are not backed the same
way. Reading them as one kind is how a specification gets trusted for the wrong
reason — a reader who takes an owner ruling for a measurement will not re-measure
it, and a reader who takes unpinned prose for a pinned sentence will edit it
freely — so they are separated once, here.

- **Held verbatim by the suite.** `test/template/command-contract.test.ts` holds
  a named set of sentences and structures: the exit-code table's leading cells,
  the closed value domains, the fixtures' shapes, the reach clauses in
  `## Conformance today`, the `## Output` rules, the stability bump rules, and
  the sentences this document must not let drift into two spellings. Where a
  sentence is held, its wording is load-bearing — change it and the suite goes
  red.
- **Accepted specification, and owner rulings.** `## Scope` and the load
  budget's allowed range, both settled by owner ruling on RP-17 on
  **2026-08-31**; the doctor `fix` presence rule, settled toward the item's own
  words rather than by a ruling. `## What acceptance settled` names what closed
  each. These are true because they were decided, not because anything measured
  them: a test can hold that this document records the decision it was given,
  and nothing here can hold that the decision was right.
- **Measured correspondence.** `## Conformance today`'s rows, and every
  `claude-config@b1bfb6e` citation in `## The memory command surface`. Each was
  read against code once. The conformance rows carry a test that re-reads the
  repository fact behind the row, on the terms that section states; the
  cross-repository citations name their revision, carry no test at all, and say
  so at their own point of use.
- **Normative prose the suite does not hold.** The exit-code table's row
  _meanings_ — the suite holds the set of leading cells, and each row's meaning
  survives its own inversion — and the payload rule that no file path appears in
  any JSON this contract defines. Prose in this category is contract all the
  same; what stands behind it is review and this document being read, not an
  assertion.

🔴 **Those four lists are examples, not an index, and absence from them is not a
licence to reword a sentence.** What decides the category is whether an
assertion names the sentence, and the only way to know is to look. This is not
hypothetical: the first draft of this very section put the `## Output` rules and
the stability bump rules in the last category, and every one of them is in fact
held verbatim. Three reviewers caught it independently, which is why the warning
is here rather than in a commit message.

🔴 **The suite does not pin every normative sentence here, and no reading of it
should suggest otherwise.** The measurement, taken on head `a78d9fb7` by a
reviewer sweeping the document rather than working from a list: it inverted
**64** claims in this document into their opposites and ran the suite against
each, and **48** of the 64 stayed green. The rounds before it had grown the
assertion count by closing the inversions a reviewer had named, which closes
those and leaves the rest, so each round finds **further** ones — not
necessarily more of them: the three rounds returned 6, then 2, then 4 blockers.
The method does not converge on completeness, and it was stopped rather than run
a fourth time. The sweep was recorded on the pull request that carried this
change and in that run's own journal directory, which `.gitignore` keeps out of
the repository — so the figures above are the whole of the record a reader has
here, and the method is stated so it can be re-measured rather than believed.

A mechanism that would hold every normative sentence — a total correspondence
check between a document like this one and its suite — is **RP-69**, and it is
not a condition of this document being accepted. RP-17 asks for the contract and
its fixtures; the four kinds above are what stands behind each part of it.

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

The discriminator is a `result` field, not the exit code, and **its values are
contract**: on exit 3 the closed set is `prerequisites-unmet` and
`refused-unattended`. Naming them is not decoration: left unenumerated, two
conforming bins could discriminate the same two occasions with different words
and neither would be wrong, which is the same as having no discriminator. This
set is one of the **value domains** `## Stability and versioning` closes, so
adding a third value is a minor bump and removing one is a major.

**A missing prerequisite names the variable, never the file.** Rule (h) forbids
a file path in every field but a doctor `fix` hint, and an exit-3 payload has no
such field — so an implementer who wants to tell the operator which credential
file is absent has nowhere legal to put the path, and will reach for `detail` if
this is not said. It is not said as a restriction on helpfulness: the path of a
credential file is the one piece of information that turns a payload into a map
to the credential. The entry names the environment variable and the observation;
where to put the file is the human-facing documentation's job.

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

A closed stdout or stderr (a reader that hung up early) never turns into an
`EPIPE` stack trace or a corrupted exit code: the rig bin swallows `EPIPE`
without touching `process.exitCode`, so whatever verdict the run already
reached survives (RP-22 round 4). Measured on non-Windows only — the tests
in that file are `skipUnless`-gated off Windows, so this guarantee is not
verified on Windows pipes. Pinned in `packages/cli/test/integrations-cli.test.ts`'s
`EPIPE on a closed stdout exits quietly, without corrupting the real exit
code (RP-22 round 4, blocker 1)` describe block.

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
a name `isCredentialPath` returns `true` for (`.claude/scripts/lib/secrets.mjs`).
🔴 **Check the name against that function; do not infer the set from a
description of it, this sentence included.** A configured path with a name the
function refuses is invisible to every layer that refuses a credential by name.

Two of its exclusions are deliberate and are exactly where a plausible name
falls out of the set, so they are named here rather than left to be discovered:
the placeholder suffixes `.example`, `.sample` and `.template` are not
recognised, and neither is `<stem>.env.<suffix>` for a suffix the module does
not name. Measured: `jira.env` is recognised, while `jira.env.qa`,
`jira.env.template`, `jira.conf`, `jira.toml` and `credentials.json` are not — so
a credential under one of those names is refused by nothing that reads a name,
neither the edit-time guard nor the sweep's path arm. An example that satisfies
the rule: `~/.config/create-agent-rig/jira.env`. The names in this paragraph are pinned in
`test/template/command-contract.test.ts` › "states a credential-file name rule the vocabulary actually agrees with".

An installer that writes such a file inside a repository must write its ignore
entry in the same change. ⚠ **The ignore entry is not sufficient on its own, and
this project already learned that.** It was half (a) of AR-49; half (b) exists
because the ignore rule could not close the gap by itself, and half (b) is more
than one thing: the shared credential vocabulary, the `guard-secret-file` hook
that refuses an edit through it, and the sweep over tracked content. A reader
who takes the ignore entry as the whole lesson skips the layers that actually
work. Note also that the rule does not reach the example path above at all: a
file in the operator's home directory is outside every repository, so no ignore
entry applies to it and only the name rule and the value rule protect it.

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

`ok` means the check ran and passed. A check that could not run is therefore
never `ok` — it is a `warn` or a `fail`, and which of the two is the bin's call
under the exit rule below. There is no fourth mark for "could not look": the set
is three words, and the one answer the meaning of `ok` forbids is the one that
reads an unrunnable check as a pass.

All four fields are present on every record. `fix` is an empty string when the
check has nothing for a human to do — the item names a four-field record, and
this document already takes that same shape decision once, for `degradation` in
`## The memory command surface`: one shape a consumer reads, rather than two it
has to tell apart. The cost is a field that is empty on a passing check, and it
is paid by nobody, because the rule below restricts consumers to `status` alone
and a consumer therefore never reads `fix` at all.

The payload carries the records under `checks`, and a `status` of its own, which
is the worst status any record carries. It is a convenience, not a second source
of truth: a consumer that disagrees with it should trust the records.

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

### Rig aggregate diagnosis

`create-agent-rig doctor [--json]` uses the record shape above. It reads the
installation manifest and owned bytes, distinguishes line-ending drift from
content drift, and checks the intended integration wiring. The rolling Codex
target hash takes precedence over its original installation hash. Optional
unselected integrations do not fail the installation. A selected provider with
no harness selection produces a warning and does not start upstream diagnosis.

MCP observations distinguish `wired`, `absent`, `drifted`, `foreign`, and
`unreadable`. A launcher found on the machine is only `observed`; Basic Memory
runtime remains `unverified`. Connectivity and trust are `not-observed`.
No diagnosis installs, removes, or applies a provider plan.

For selected Spec Kit, diagnosis calls the pinned official status command
through `uvx --offline --no-config --no-python-downloads`. It may use uv's
machine cache but cannot download a missing runtime. Unavailable status is a
warning; authoritative upstream errors fail the check. The repository and
integration intent remain unchanged.

Guard diagnosis compares both harnesses' installed hook entries and the guard
dependencies with this package, then runs allowed/denied fixtures against
package-owned guards in a disposable directory. It never executes commands
read from repository configuration. This verifies installation and guard
behavior; it does not assert that a running harness has loaded its hooks.
For the optional workflow layer, diagnosis checks installed script bytes,
including the frozen revalidation and claim-record mechanisms. It does not
query Jira or change the external RP-26 freeze decision, which remains
unobserved in the report. `packages/cli/test/doctor-guards.test.ts` pins
"fails a modified installed guard without executing repository code";
`packages/cli/test/doctor-workflow.test.ts` pins "passes an intact selected
workflow layer and preserves its frozen mechanism bytes".

The aggregate command also inspects the machine-scoped custom Memory manifest.
It checks the child's version handshake before requesting its doctor response.
An incompatible child is unusable and its doctor is never invoked. This is a
diagnosis of a dependency; callers of either executable must still resolve
their own contract handshake first. The existing `memory doctor` and
`memory load` pass-through commands retain their exit-4 compatibility boundary.
Provider output and private machine paths are not copied into aggregate records.

Evidence: `packages/cli/test/doctor.test.ts` pins "fails unreadable owned MCP
configuration without exposing its contents" and "distinguishes line-ending-only
drift from pristine owned bytes". `packages/cli/test/integrations-verify.test.ts`
pins "reports a manually changed Codex file as drift without writing a replacement
config". `packages/cli/test/spec-kit-doctor.test.ts` pins "diagnoses the intended
harnesses using only pinned offline official status";
`packages/cli/test/memory-doctor.test.ts` pins "fails a foreign contract before
running Memory doctor".
`packages/cli/test/cli-version.test.ts` pins "routes doctor --json to read-only
aggregate diagnosis instead of creating a directory".

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

The default is **8192 bytes**. The unit is UTF-8 bytes of a record's body — the
text after the front matter — summed across the records one invocation injects
for one project tree, and the count starts at zero on every invocation. A record
whose body does not fit the remainder is skipped and counted, never truncated,
and selection stops once the running total reaches the budget.

The number is measured, not chosen. Both shipped Memory MVP backends carry it as
the constant `INJECTION_BUDGET_BYTES` — `shared-memory/load.sh:14` and
`shared-memory/load.ps1:5`; that repository's `README.md:124` states it to a
reader as the 8 KB cap a session's injected event bodies are held to, and its
`docs/decisions/mvp-completion.md:90-93` records the same figure beside a dated
measurement of a real tree. It is also a number the owner has decided about once
already: `PLAN.md:264` records the decision of **2026-08-23**, taken against
measurements over four real memory trees, _not_ to raise it — on the ground that
the records compete for a reason a larger budget does not fix. Every citation in
this paragraph is `claude-config@b1bfb6e`.

**The allowed range is 0 to 8192 inclusive**, and the input is an integer count
of those same bytes. Owner ruling on RP-17, 2026-08-31:

- Omitted, the budget is the default: 8192.
- `0` is valid, and it means inject no record bodies for this invocation.
- A value that is negative, not an integer, or above 8192 is an **invocation
  error**: exit 2, nothing attempted, per the exit-code table above.
- An out-of-range value is **never silently clamped**. A clamp answers a
  caller's mistake with a different run that looks like the one it asked for,
  and the caller has no way to tell — which is the whole of why exit 2 exists.

The ceiling is the default on purpose: a per-invocation input may **lower** the
cap and may not raise it, so no invocation can put more into a session's
context than the backends already permit. Raising the maximum later is a
widening of a closed value domain, which `## Stability and versioning` makes a
**minor** bump — and lowering it, or lowering the default, is a narrowing, which
that same rule makes a **major** one. Either direction wants new evidence rather
than a new preference.

⚠ **The ceiling is a decision, not a reading.** No implementation enforces any
bound at all, and that is visible in the lines already cited rather than in a
probe: each backend assigns its working budget straight from the constant and
validates nothing — `load.sh:14-15` and `load.ps1:5-6`, same revision — so there
is no code path anywhere today that refuses a value for being out of range. 8192
is a **maximum** because the ruling reused the measured default as one, and a
reader who assumed the backends already refuse a larger value would be wrong.

**Nothing implements this input today, and RP-17 does not ask anything to.** In
both backends the budget is a compile-time constant with no override, and the
ruling leaves them alone: this is a specification, and RP-18's memory shim is
what delivers the surface.

⚠ **Cross-repository evidence, disclosed once for the whole section.** Every claim and every
`claude-config` citation in this section — the budget constant above, and the
counter line and dedup ordering behind `degradation[]` below — was read in that
repository at revision `b1bfb6e`, and **this repository's suite cannot pin any
of it**. What the suite pins is that this document says what it says. The
provenance is the file, line and revision at each point of use, for a reader who
wants it re-measured.

### Payload rules specific to the shim

- No file paths appear in any JSON this contract defines, except in a `fix`
  field, which is an instruction to a human — the same single spelling of the
  rule as in `## Doctor`, and `fix` is a doctor-record field, so the two say the
  same thing. Together with the credential
  rule in `## Secrets`, this is the whole of what a payload may not carry: a
  path, and a credential value.
- `degradation[]` is a closed enum, in the sense that each version of this
  contract enumerates its members and a bin emits no member the version does not
  name. **Contract 1.0 enumerates two**, and neither is a word chosen here —
  they are the two degradations both shipped Memory MVP backends already count,
  in those backends' own spelling from the counter line they write to stderr
  (`shared-memory/load.sh:56-57` and `load.ps1:53` in `claude-config@b1bfb6e`,
  which print `budget-skipped=` and `invalid=` among five counters):
  - `budget-skipped` — at least one eligible record was not injected, because
    its body did not fit the budget remaining.
  - `invalid` — at least one record failed validation and was never considered.

  A third degradation is measured and is deliberately **not** a member: a record
  dropped because its `sourceKey` was already seen is invisible to every one of
  the five counters, the loop skipping it before the eligible count is reached —
  `load.sh:37-40` `continue`s ahead of the `eligible` increment at `:45`, and
  `load.ps1:37` ahead of `$eligible++` at `:42`, same revision. No conforming
  bin could report it without a runtime change, and an enum member nothing can
  emit is a promise nobody keeps. Adding it is a minor bump — a widening — on
  the day a backend can observe it.

  The key is **present** either way: a `load --json` payload always carries
  `degradation`, empty when there was none, so a consumer reads one shape rather
  than two. A consumer that nevertheless meets an unrecognised member treats it
  as an unspecified degradation rather than failing — the additive rule again.

## Stability and versioning

What is covered: subcommand names, documented flags, exit codes, the JSON keys
named in this document, and the **value domains** this document closes — the
exit-3 `result` set, the doctor `status` set, the lifecycle states,
`degradation[]`'s members, and the load budget's allowed range. A closed value
set belongs on the surface for the same reason a key does: a caller writes code
against it, and a caller broken by a change cannot be told the change was
invisible.

- Adding a subcommand, a flag, a JSON key or an enum member is a **minor** bump.
- **Widening a closed value domain is a minor bump too** — a third exit-3
  `result`, a fifth lifecycle state, a raised budget maximum. Nothing a caller
  already sends or already reads stops working.
- Renaming or removing any of them is a **major** bump, and must be preceded by
  at least one minor release in which the old spelling still works and is
  documented as deprecated.
- **Narrowing a closed value domain is a major bump**, on that same rule — a
  removed enum member, a lowered budget maximum, a lowered default. It breaks
  the caller that was sending or reading the value that went away, and the
  deprecation minor is owed there exactly as it is for a renamed flag.

A change nobody can detect through the covered surface is a patch. That residual
is the reason the value domains are named above rather than left implied: read
without them, a raised budget maximum is undetectable and therefore a patch,
which is the opposite of the answer the surface should give.

## Conformance matrix

Conformance is demonstrated by a golden matrix: one row per invocation, each row
naming the invocation, its expected exit code, and the schema its payload must
satisfy. The matrix is the executable form of this document — a claim here that
no row exercises is a claim nothing is holding.

The item names `[A4]` as the rig layer that rolls the matrix out. That referent
was absent when this document was written (see above); RP-13 supplied it, at
the scope the owner fixed on 2026-09-13: a repository contract, not a payload.
The schemas of this document's handshake, `doctor --json` and `load --json`
live under `contracts/conformance/v1/` — nothing under `templates/` carries
them, so no rig receives them (`test/template/conformance-contract.test.ts` ›
"is not delivered to rigs: no template carries a conformance contract") — and
the matrix's executable form is `scripts/memory-conformance.mjs`, run offline
against a Memory checkout the caller names with `--from`. The authoritative run
is the private claude-config workflow, which checks this repository out at an
exact SHA and points the runner at its own tree; this repository's CI runs only
the offline tests. Rows and ids: `test/template/memory-conformance.test.ts` ›
"passes every row against a well-formed local fixture root and names both SHAs
and the verifier digest"; one failing row fails the whole, and the consumer's
exit-4 refusal is a row of its own: › "fails memory-handshake, and the rig
refuses setup with exit 4, when the backend answers a foreign contract major".

## Conformance today

**This repository implements exactly the parts of this contract the rows below
name, and nothing else.** As of RP-19 the rig bin answers the version handshake
and consumes the memory shim through it (`memory <doctor|load>`); the memory
shim itself lives in claude-config. This section is the honest half of the
document: it records what was measured about the surfaces each change touched,
so that no reader takes a statement above as a description of installed
behaviour where no row backs it.

Every row below names a test, and that test holds the repository fact the row
was built on — not the row's wording about it: invert a row into an overclaim
and its named test stays green. What a named test buys the reader is therefore a
**re-measurement and not a proof-read**: the fact was true of this repository
when the test last ran, and the test goes red the day the repository changes
underneath the row. Each row's reach is the reach of its test and no wider — so
every row whose test
reaches less far than the row sounds states that reach at the point of use, and
four of them do. It is what was measured, not an inventory: a difference this
section does not name is a difference nobody checked. And because `## Scope`
puts the internal script fleet outside this contract, a row about that fleet
records a fact, not a fault.

- **The rig bin declares a `--json` flag and answers `--version --json` with
  the handshake object** (RP-19): `{"schemaVersion":1,"name":"create-agent-rig",
"version":<package version>,"contractVersion":"1.0"}`. That it is one line and
  nothing else on stdout is pinned by `packages/cli/test/cli-version.test.ts` ›
  "writes exactly one handshake JSON line to stdout and exits 0", not by this
  row's test. `--json` is read on `--version` only; `memory` answers its own
  status lines in machine JSON whether or not the flag is present, and `create`,
  `init`, `setup` and `upgrade` speak prose. Reach: the test reads `index.ts`
  alone and recognises one spelling — a `parseArgs` option named `json`; a flag
  added by a hand-rolled argv scan, or declared in another module under
  `packages/cli/src`, is invisible to it. Pinned in
  `test/template/command-contract.test.ts` › "reports that the rig bin declares a --json flag and answers the version handshake (RP-19)".
- **The rig bin answers the version handshake, and names `contractVersion` in
  exactly three modules** — `packages/cli/src/lib/version.ts` (its own
  `RIG_CONTRACT_VERSION` and `rigHandshake()`), `packages/cli/src/lib/subsystems.ts`
  (the consumer classification `setup` and `memory` share, RP-147) and
  `packages/cli/src/commands/memory.ts` (the foreign-major refusal payload).
  A fourth namer, or a missing one, makes the row stale. Pinned in
  `test/template/command-contract.test.ts` › "reports that the rig bin answers the version handshake in exactly three modules (RP-19)".
- **The rig bin's exit codes outside 0 and 1 are `setup`'s 4, `memory`'s 4,
  3 and 2, and `doctor`'s usage exit 2** — the contract-major refusal the consumer owns, carried as
  `exitCode: 4` in `packages/cli/src/commands/setup.ts` and in
  `packages/cli/src/commands/memory.ts`; `memory`'s unmet-prerequisite 3
  (`prerequisites-unmet` with the unset variable in `missing`, when no
  configuration root — `APPDATA` on Windows, `HOME` elsewhere — exists to find
  the manifest under); and `memory`'s invalid-invocation 2 (no verb, or a verb
  outside `doctor`/`load`), each returned by `index.ts` through the command's
  result. `setup` still answers the same missing root with 1, as it did before
  RP-19 — a measured difference, not a rule. No other literal above 1 is
  returned, passed to `process.exit`, or assigned to `process.exitCode`
  anywhere under `packages/cli/src`. Pinned in
  `test/template/command-contract.test.ts` › "reports the rig bin's documented setup, memory and doctor exit codes".
- **No reader of `RIG_UNATTENDED` exists under `.claude/scripts/`,
  `.claude/hooks/` or `packages/cli/src/`.** Reach: those three trees and no
  others — the template copies under `templates/agent-os/` are not scanned, and
  neither is any extension but `.mjs` and `.ts`. Pinned in
  `test/template/command-contract.test.ts` › "reports that nothing in this repository reads RIG_UNATTENDED".
- **Exit 2 is already spoken for in the internal script fleet**, on meanings
  that are not this contract's: the queue CLI spends it twice over — gate rounds
  exhausted, and a revalidation hold — and the revalidation script spends it on
  the second. This is why `## Scope` carves that fleet out rather than claiming
  it. Reach: the test counts occurrences of an exit-2 call, not distinct
  meanings, so the "twice over" clause rests on reading those two call sites and
  not on the count. Pinned in
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
  which calls `verdictOf` rather than reading its source. Reach: `exempt` has no
  verdict of its own to call — `verdictOf` branches on `FAIL` and `unknown` only
  — so that half of the row is a source read, and would stay green if the mark
  were removed from `auditHooks` while its name survived in a comment. This was
  the first item on the acceptance list until the owner ruling of 2026-08-31
  settled it: `.claude/scripts/doctor.mjs` is part of the internal fleet, so it
  is **outside this contract's scope** and its two extra marks are a measured
  difference of a tool the contract does not bind. What the objection behind the
  row is really about — that a probe which could not run must never be read as a
  pass — is answered in `## Doctor` by what `ok` means, and needs no fourth
  status to say it.

## What acceptance settled

**Nothing in this document is left for acceptance to settle.** This section
carried five entries across three gate rounds — four numbered questions and the
scope assumption that preceded them; all five are closed, and
each is recorded here with the ruling or the evidence that closed it rather than
deleted, because a question that vanishes is indistinguishable from one that was
never asked.

- **Which tools the contract binds** — the question `check-premises` returned
  `UNVERIFIABLE` on. Settled by owner ruling on RP-17, **2026-08-31**: the public
  platform bins, and not the internal `.claude/scripts/` fleet. `## Scope` states
  it, and one consequence runs through `## Conformance today` — a row about that
  fleet records a measured fact about an unbound tool, not a fault.
- **Doctor's two extra marks** — settled by the same ruling, which removes the
  subject: `.claude/scripts/doctor.mjs` is in the fleet this contract does not
  bind, so its `unknown` and `exempt` are not a conformance target. The
  substantive half is answered in `## Doctor` by what the word means — `ok` is a
  check that ran and passed, so no conforming doctor may report an unrunnable
  check as one, and no fourth status is needed to say so.
- **`degradation[]`'s members** — settled by measurement, and enumerated at 1.0
  in `## The memory command surface`: `budget-skipped` and `invalid`, the two
  degradations both shipped backends already count, in those backends' own
  spelling. The third that is measured but unobservable — a record dropped
  because its `sourceKey` was already seen — is named there as excluded, with
  the reason.
- **The doctor `fix` presence rule** — settled toward the item's own words
  rather than this document's reading of them. The item names a four-field
  record, so all four are present and `fix` is empty when there is nothing to
  do, which is the shape rule this document already applies to `degradation`.
- **The load selection budget's default and bounds**, amendment (e). The default
  is a measurement: 8192 bytes, the constant both shipped backends carry. The
  allowed range is an owner ruling on RP-17, **2026-08-31**: 0 to 8192 inclusive,
  integer, out-of-range refused with exit 2 and never clamped, the ceiling being
  the default so an invocation may lower the cap and not raise it. Both halves
  are in `## The memory command surface`, next to the cited lines that show the
  ceiling is a decision rather than something a backend already enforces. An
  earlier draft rested that point on a sandbox probe with no test, no command
  and no revision behind it; the conclusion rests on `load.sh:14-15` and
  `load.ps1:5-6` instead.

## uninstall (RP-181)

`uninstall [dir] [--dry-run] [--yes] [--detach] [--json]` removes what a rig
installed from `dir` (default: the current directory) — file by file, against
the evidence the manifest carries and nothing else. It is not a member of the
foundation verb set above, and it does not use that set's five-code exit
table: like `create`, `init` and `upgrade`, it exits 0 on success (including
"nothing to do") and 1 on a refusal or a partial failure. `## Conformance
today`'s row on `create`, `init`, `setup` and `upgrade` speaking prose
predates this command and is unchanged by it — `uninstall` speaks prose too,
and additionally answers `--json` the way `--version --json` does: one JSON
object, nothing else on stdout, `schemaVersion` at the top level, additive
evolution.

`### Payload rules specific to the shim`'s "no file paths" rule is, as its own
heading says, specific to the shim — the concern behind it is a payload
travelling somewhere a path could point at a credential. `uninstall`'s own
payload rule is different and looser: its paths are ordinary
repository-relative rule-file paths, already fully visible in the plain-prose
plan `upgrade` prints today, so `planned`, `removed`, `absent`, `preserved`,
`notes` (round 4, blocker 2 — the CLAUDE.md/AGENTS.md pair disclosure),
`completed`, `remaining` and `error` may all name one. Recognised
structurally, the way a doctor record is, by the field that makes a payload
this shape: `command: "uninstall"` — never by a bare `removed` or `preserved`
key alone. Pinned in `test/template/command-contract.test.ts` › "exempts
uninstall's own path fields only on its own payload, never by field name
alone".

Ownership hashes compare exact bytes, never a decoded string (ADR-RP-003):
the file on disk is read and hashed as bytes, so a binary file is compared
correctly and a CRLF/LF classification (below) is only ever attempted on
bytes that round-trip through UTF-8 without loss.

Before any per-path decision, the manifest as a whole is checked and can
refuse the WHOLE run before anything is touched — never a per-path
`preserved`, because a manifest is committed and therefore untrusted input:

- any path (in `files`) that genuinely ESCAPES `dir` lexically — `..`, an
  absolute path, or anything else that fails the same containment `upgrade`
  applies on write. A path with more path segments than any path this
  release installs (pinned by measurement, not by a guessed number:
  `packages/cli/test/safe-path.test.ts` › "caps a path at more segments than
  any path this release's own install set ships, measured not guessed")
  deliberately does NOT take this branch, even though `resolveInside` itself
  refuses it the identical way it refuses an escape: such a path can never
  have been one this release owns regardless (checked below, and always
  true, since nothing this release installs comes anywhere near that deep),
  so it is reported the same honest, per-path `preserved` way as any other
  unowned path — the escape check right below it still aborts the whole run
  for a path that genuinely leaves `dir`, unweakened; a too-deep path is
  refused by never reaching that check at all, and is never read, hashed, or
  written either way. The two checks are independent safety nets, not
  substitutes for each other. (Before this was measured and separated out, a
  17-segment manifest key aborted the whole run — including a `--dry-run`
  the operator could not then even preview — through a message that read
  "resolves outside `dir`", which was simply false for a path that never left
  it lexically at all.)
- any path with a segment that NORMALISES to `.git` — case folded, a Windows
  alternate-data-stream suffix (`name::$DATA`) stripped, then trailing dots
  and spaces stripped, the two characters Windows itself silently drops when
  it resolves a segment on disk — at ANY depth, not only as the first
  segment, so `.GIT/hooks/pre-commit`, `.git./x`, `.git /x`,
  `.git::$DATA/x` and `.claude/worktrees/w/.git/x` are refused exactly as
  `.git/x` is. A manifest pairing such a path with its true on-disk hash
  would otherwise make a confirmed run delete the repository's own git
  state;
- the same path listed under both `files` and `kept` — nothing this tool
  ever writes produces that overlap (`planUpgrade` drops a `kept` path the
  moment a release vouches for it as one of `files`), so a manifest that has
  it is corrupt or hand-edited, and resolving the ambiguity silently (by
  picking a winner) is exactly how a path ends up removed on one line of the
  plan while the same plan reports it `preserved` on another.

The manifest itself is read this same untrusting way before any of that: not
through a plain lexical path, but through the identical per-segment
`regularFileStatus` check every manifest-owned path gets below, so a
symlinked `.claude` can neither make this command trust a manifest that
actually lives outside the repository nor make it silently report
`noManifest` for one that is only reachable through the link — either case
refuses with an error naming the ancestor.

Per manifest path, in order: a path with more segments than
{@link MAX_PATH_SEGMENTS} (`safe-path.ts`) is `preserved`, reason naming the
limit — checked BEFORE the path is resolved on disk at all, so it never
reaches the escape check above and never aborts the run on that path's
account (see the bullet above for why that is the right call, not a
weakening). Then: a path that is not one of the EXACT paths this
release actually installs (derived from the same install set `init`/`upgrade`
use — every layer `layers.json` names, RP-180, not only the layer(s) a given
rig actually chose; which layer(s) THIS rig has is a `manifest.files`/`kept`
question, answered per path below, never a hand-written list, and never
merely a top-level directory such paths sit under) is `preserved`, reason
`not a path this release installs` —
drawing the boundary at a top-level segment rather than the exact path would
let a manifest pair almost anything under an owned directory (`.claude/`,
`.rig/`, `docs/`, `journal/`) with its true hash and have it removed, and it
is also what makes a path spelled with a Windows alternate-data-stream suffix
(`name::$DATA`) fall to this branch: the suffixed string is simply a
different, unowned path, with no need for this command to know anything
about ADS semantics. Absent on disk is `absent`. **Any ancestor directory
down to the file itself that is a symlink — or any other non-regular entry —
is `preserved`, reason `not a regular file inside the repository — a symlink,
a directory (or other non-file entry) sitting where a plain file belongs, or
an ancestor whose real path leaves the repository`; this branch is checked
before any read, so a symlinked ancestor is never followed to reach the file
and is left untouched either way.** The reason deliberately does not say
"(symlink)" the way it once did — the SAME `'unsafe'` verdict also covers a
plain directory sitting where the manifest expects a file, and a segment
whose `realpath` escapes the repository regardless of how `lstat` classifies
it, and naming a kind the code has not actually confirmed was the same
mistake a hook-protection reason string made elsewhere on this page
(security-lens advisory, RP-181 cycle 5). A hook file
(`.claude/hooks/*.mjs`) that a wiring file this run is preserving as
`wiring-modified` still references is `preserved`, reason `still referenced
by <wiring path>, which was preserved as edited — removing this file would
leave it pointing at nothing` — computed as a pass over the wiring files
before the main per-path decision, because a wiring path sorts AFTER the hook
files it references and a single alphabetical pass would otherwise decide a
hook's own verdict before its wiring file's preserved status was known. Only
once all of the above pass: bytes matching the recorded hash exactly is
`remove`; bytes matching only after normalising line endings (CRLF/LF,
checked both directions against the one recorded hash — this command holds no
other record of the original bytes) is `preserved` with reason
`line-endings-only`; any other mismatch is `preserved` with reason
`modified`. A path under `manifest.kept` is always `preserved`, reason
`user-owned (kept by init)`. `.claude/settings.json` and `.codex/hooks.json`
use whole-file ownership only — no line-ending leniency, no `kept` check — so
a hash match is `remove` and anything else is `preserved` with reason
`wiring-modified — remove the rig's hook entries by hand`, naming the hook
files the current wiring still references.

`remove` is the plan's answer, not a guarantee: a `remove`-verdict path whose
bytes no longer match the plan's recorded hash when `applyUninstall` actually
reaches it — the confirmation prompt is exactly the window an edit can happen
in — is skipped, never deleted, and reported in `--json`'s `preserved` array
with reason `CHANGED_SINCE_PLANNING_REASON` ("changed since planning — its
bytes no longer match what was planned to be removed"); the run keeps going
with the rest. This is a different response from a SYMLINK appearing in the
same window (`regularFileStatus`'s own re-check, immediately before the same
call): that aborts the whole run, because it is the one shape suspicious
enough that continuing is the wrong default, while an ordinary content edit
is not.

Every ancestor check above — `regularFileStatus`'s per-segment walk and its
equivalent for the parent-cleanup below — makes TWO independent checks at
every segment, not one. The first is classification: an intermediate segment
is refused unless it is BOTH a real directory and not a symlink
(`info.isSymbolicLink() || !info.isDirectory()`), and the final segment
unless it is a plain file and not a symlink. The second, separate check does
not read that classification at all: `realpath` is resolved on that same
segment and the result must still fall inside the repository root. This
second check is what makes the containment guarantee hold BY CONSTRUCTION for
any reparse-point kind, including one `lstat` does not report as a symlink at
all — `realpath` resolves the actual target regardless of how the entry
classifies itself, so a segment whose real target lands outside the
repository is refused whatever tag produced it.

⚠ **What is, and is not, measured for a Windows directory junction
specifically.** This repository's own development environment cannot create
one. `packages/cli/test/uninstall.test.ts`'s junction tests, gated by
`onlyOnWindows` and run only in the `windows-e2e` CI lane, measure that
Node/libuv reports a junction through `Stats.isSymbolicLink()` on Windows the
same way a real symlink is (the same behaviour this repository's own
ancestor-escape fixtures already rely on elsewhere — e.g.
`test/template/content-blind-revalidation.test.ts`'s
`process.platform === 'win32' ? 'junction' : 'dir'` pattern) — that is, they
exercise the FIRST (classification) check. They do not exercise the
`realpath` check, and no claim is made that they do: that check needs no
junction-specific measurement, because its containment property follows from
what `realpath` does on any platform, independent of how the segment it is
given happens to be classified.

No manifest on disk is success with nothing to do (`planned`, `removed`,
`absent` and `preserved` all empty, `manifestRemoved: false`), which is also
part of what makes a repeat run idempotent. A manifest that exists but will
not parse is refused outright: nothing is removed, exit 1.

Removing anything is destructive, so it asks first: `--yes` on the command
line answers up front, an interactive terminal is asked (`Remove these
files?`, mirroring `upgrade`'s own `promptConfirm` and exit codes), and a
non-interactive run without `--yes` refuses — exit 1, nothing removed, a
message naming `--yes`. `--json` never prompts, on principle: it is read by a
script, and a script blocking on a TTY question is a hang, not a safeguard, so
without `--yes` it gets the same refusal, reported in its own payload
(`manifestRemoved: false`, `error` naming `--yes`) instead of a stderr
sentence. `--dry-run` needs no consent at all — it performs no removal
regardless of `--yes`. `--detach` asks the identical way — it changes what
happens to the manifest once cleanup finishes, not whether removing anything
still needs a yes.

`--json` keeps that one-object promise even for an error this command did not
compose itself — a permission or filesystem failure (`EACCES`, `ENOTDIR`) hit
while planning, not only its own refusals (a bad manifest, `.git`, a consent
refusal). Such a failure is reported the same way: `manifestRemoved: false`
and `error` carrying the underlying message, exit 1, never a stack trace with
no payload at all. Without `--json`, an error of this second kind is still
the unexpected-error diagnostic every other command here uses (a full trace),
because that is the more useful answer for a human reading the terminal
directly.

`removed` is always what was **actually** deleted from disk — empty on a
`--dry-run`, a consent refusal, or a plan that itself failed to compute, and
on a partial failure the SUBSET that finished, never every `remove`-verdict
path the plan named. `planned` is the plan's own answer regardless of outcome
— every `remove`-verdict path, whether or not this run went on to remove it —
so a caller can always tell "what would this have done" from "what did it
do"; on `--dry-run` the two necessarily differ (`planned` non-empty, `removed`
empty).

The manifest is deleted last, and only once every `remove` action succeeded
**and — outside `--detach` — nothing in the plan is `preserved`, nor turned
out changed since planning.** A `preserved` action means the rig still owns
bytes it did not remove — an edit, a CRLF checkout, wiring left in place, a
hook a preserved wiring file still calls, a path outside the current install
set, a file caught changed at apply time — and deleting the manifest anyway
would discard the only evidence naming what it still owns, blinding a later
`upgrade`. This holds even when every removal that WAS planned succeeded:
nothing was removed at all (e.g. every file preserved by a CRLF checkout)
keeps the manifest exactly as a partial failure does. On an actual failure
the run stops where it is, keeps the manifest, and the payload carries
`completed` (what finished), `remaining` (what a re-run still owes, including
the path that failed) and `error`. `remaining` names the manifest itself too,
appended last, whenever a clean re-run really would go on to delete it — that
is, whenever nothing in the plan is `preserved` (or `--detach` was given,
which always intends to); when something else IS preserved and this is not a
detach, the manifest is never deleted regardless of this run's outcome, and
`remaining` does not name it, since it is not something a re-run would
actually do.

### The manifest's own digest, and `--detach`

The manifest's raw bytes are hashed at plan time and carried as
`plan.manifestHash`. `applyUninstall` re-verifies it against that recorded
value at two checkpoints, using the identical symlink-safe read every other
manifest access gets:

1. **Before the first removal.** A plan built from bytes that no longer exist
   authorises nothing — on a mismatch here, NOTHING is removed at all, not
   even a file a fresh plan would still agree to remove, and the payload
   carries `error` naming the manifest, `completed: []`, `manifestRemoved:
false`.
2. **Immediately before the manifest's own deletion.** This is the window
   every per-file removal before it could have used. On a mismatch here the
   manifest is kept — never deleted — and the result is an honest partial one:
   `completed` names every file that really was removed, `remaining` names
   only the manifest, `error` names the mismatch.

`--json`'s payload states the run's end state in one word, `outcome`. **One
rule, no exceptions:** present on every completed run that is not a
`--dry-run`, and absent on every `--dry-run` — including `noManifest`, where
"nothing installed, nothing to do" only becomes an end state once a real
(non-dry) run has acted, or declined to act, on it. Also absent whenever
`error` is set — a hard failure is its own signal, not one of the three:

| `outcome`     | when                                                                                                                                                | manifest                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `uninstalled` | not `--dry-run`; nothing in the plan was `preserved`, and nothing was caught changed since planning (also the `noManifest` case)                    | removed                                     |
| `partial`     | not `--dry-run`; something was `preserved`, caught changed since planning, or a hook was protected only at apply time, and `--detach` was not given | kept                                        |
| `detached`    | not `--dry-run`; `--detach` was given                                                                                                               | removed, regardless of what was `preserved` |
| _(absent)_    | `--dry-run` — the plan was only shown, nothing was decided yet, whether or not a manifest exists                                                    | unchanged — nothing was touched             |

A hook file (`.claude/hooks/*.mjs`) a wiring file still calls is preserved
even when that protection is discovered only at APPLY time, not at plan
time: `planUninstall`'s own per-file pass can only see the wiring file's
state as it was when planning ran, so a wiring file still pristine then but
edited — or replaced with a symlink — in the confirmation-prompt window is
re-checked again, immediately before the first hook removal, using the SAME
protection logic against current disk state.

**Protection is not limited to the hook files a wiring file names directly.**
A directly-wired hook (`.claude/hooks/guard-bash.mjs`) is not
self-contained — it imports its own dependencies, some under
`.claude/hooks/lib/` and some across into `.claude/scripts/`
(`stop-flag.mjs`, `unattended-flag.mjs`, `lib/shell-tools.mjs`, …), and every
one of those is itself an owned path a manifest can mark `remove` on its own
account. Protecting only the directly-named hook and deleting what it
imports leaves that hook dying at module resolution with exit 1 on every
call the moment the wiring file's own protection kicks in — and since a
`PreToolUse` hook that exits non-2 is non-blocking, the tool call proceeds
anyway. So a protected hook's relative `.mjs` imports are walked to a fixed
point, and everything found that this release owns is protected too, the
same way and under the same wiring path.

🔴 **This is MODULE-IMPORT protection specifically, not "everything a hook
needs to keep working."** A hook that reads another path at RUNTIME rather
than importing it — `inject-rules.mjs` reading `.claude/rules/`,
`guard-subagent-model.mjs` reading `.claude/agents/` for a pinned-model
override — is not covered by this walk, and this page does not claim it is:
those paths are ordinary manifest entries, protected or removed on their own
merits exactly as before this feature existed. Pinned, not merely asserted
(`.claude/rules/invariants.md`, "State the limits — and test them" — a
"Measured:" sentence with no test behind it is indistinguishable from a
guess a month later): `test/template/hooks.test.ts` › "exits 0 and injects
nothing when .claude/rules/ itself is missing entirely — the runtime-read
gap the import walk does not cover" runs `inject-rules.mjs` against a planted
tree with no `.claude/rules/` directory at all and confirms exit 0, empty
stdout; `test/template/subagent-routing-hooks.test.ts` › "allows a call-site
model override once .claude/agents/ itself is gone — the runtime-read gap
the import walk does not cover" runs `guard-subagent-model.mjs` against the
identical pinned-agent payload with and without `.claude/agents/` present
and confirms the same dispatch goes from blocked (exit 2) to allowed (exit
0). Both are existing, unrelated gaps this feature neither creates nor
closes — the three Never-tier guards this feature's own motivating case
names (`guard-bash`/`block-no-verify`/`guard-secret-file`) import every
module they need rather than reading one at runtime, which is exactly why
they stay self-contained and still block once this walk protects their
imports.

Every real READ this walk performs is gated by the same symlink-safe
{@link regularFileStatus} check every other read on this page gets — not the
purely lexical containment `onDisk` alone provides. A hook file swapped for a
symlink to an unbounded or blocking special file, with the wiring that
references it also modified, would otherwise make the walk's own `readFile`
hang or exhaust the heap — reachable from nothing worse than `git clone`ing a
hostile branch, before consent, since a symlink survives `git add`/commit as
mode `120000`. The file stays protected either way (it was recorded before
the read is attempted) — walked or not — the same "protecting too many is
the safe direction" doctrine below covers exactly this case too.

**An unreadable file also loses the ability to name what IT imports — and the
walk protects the conservative superset rather than losing those too.** An
earlier version of this stopped at "the symlinked file itself stays
protected", on the reasoning that every dependency the walk needs to reach
through `.claude/scripts/` is also imported by at least one OTHER,
ordinarily-readable hook. That reasoning was checked against the shipped
import graph and found false: `.claude/scripts/lib/secrets.mjs` has exactly
ONE seeder (`guard-secret-file.mjs`), and `.claude/scripts/unattended-flag.mjs`
has exactly one (`guard-rulebook.mjs`). Symlinking that one seeder — with the
wiring referencing it also preserved — used to drop the dependency's
protection entirely, measured end to end through a real `git commit` and a
fresh `git clone`: the credential guard (`guard-secret-file.mjs`) went from
blocking a credential write (exit 2) to dying at module resolution
(`ERR_MODULE_NOT_FOUND`, exit 1, non-blocking for `PreToolUse`) once
`secrets.mjs` was gone, wiring still in place, still claiming to enforce it.
So an unreadable file now protects every owned `.mjs` path outright — the
same move the `unsafe`-wiring branch below already makes one level up —
rather than only the file itself. Pinned by
`packages/cli/test/uninstall.test.ts` › "protects a dependency with only ONE
seeder even when that exact seeder is symlinked — the credential guard's own
import" and its `guard-rulebook.mjs`/`unattended-flag.mjs` sibling.

⚠ **The sweep triggers on `regularFileStatus` returning `'unsafe'`
specifically — never on `'absent'`, and that distinction is load-bearing.**
An earlier version swept on any non-`'ok'` status, absence included:
measured cost, deleting one ordinary hook file by hand (`block-no-verify.mjs`,
with the wiring still naming it and that wiring itself preserved) turned 83
planned removals into 40 planned / 43 preserved — an operator who simply
turned a hook off, or whose `kept` `.claude/settings.json` names a hook from
other tooling entirely (an ordinary thing for a file they own), could no
longer complete a plain `uninstall` without `--detach` (code-lens and
security-lens review, RP-181). Nothing is gained by sweeping on absence
either: a file that is not there has no imports that can fail to resolve,
because the module that would make them is itself gone — the sweep's whole
justification (a file we cannot READ might import something we cannot
discover) does not apply to a file that does not exist. Pinned by
`packages/cli/test/uninstall.test.ts` › "deleting a hook file (not symlinking
it) never triggers the superset sweep — an ordinary \"turned this hook off\"
leaves the rest of the plan alone".

⚠ **A file the sweep catches is reported honestly as unconfirmed, not as a
traced reference.** See the fifth wording below.

Bounded, but precisely: every REAL read happens at most once per owned path
— a visited set is checked before reading, and only an import target already
among the ~80 paths this release installs is ever opened, so a path this
release does not ship is never read regardless of what a hostile file
claims to import. The walk's transient queue length is a different question
from read count, and is bounded by the number of import-shaped matches
across files actually read, not by the size of the owned-path set — an
irrelevant distinction at this release's real scale, pinned rather than
merely asserted (`.claude/rules/invariants.md`, "State the limits — and test
them") by `packages/cli/test/uninstall.test.ts` › "processes 400,000
duplicate import matches to the same owned dependency in bounded time",
stated here only so the claim matches what the code does rather than
rounding up to "bounded by `|ownedPaths|`" in both places at once.

A wiring file this command cannot safely READ at that point (itself a
symlink, or reached through one) protects every hook path this release owns
— matched structurally (any `.mjs` file under `.claude/hooks/`, at any
depth, not only the top level), and then walked the identical way — not a
computed subset: this command has no safe way to learn which hooks an unsafe
entry actually references without reading through it, and protecting too
many is the safe direction; protecting too few is the bug this closes.

**A `kept` wiring file protects its hooks too, exactly as a `files` one
does — this was not always true.** `init` records a pre-existing
`.claude/settings.json` under `kept`, never `files`, when the repository
already had one (the ordinary "starts from an existing repository" path).
`planUninstall`'s own `kept` loop preserves such a path UNCONDITIONALLY, with
no hash to compare — there is no "pristine, about to be removed" case for it
to fall into, ever. The walk treats it accordingly: a `kept` wiring path's
CURRENT hook references are always protected, never skipped on a hash match
that does not exist for this purpose.

⚠ **Known gap, pre-existing and not changed by this feature, the opposite
lever from the three kinds above:** a wiring path named in NEITHER `files`
nor `kept` at all is untracked, and `trackingFor`'s `{ tracked: false }`
short-circuit means it protects nothing while ALSO never being removed
itself — a manifest simply omitting `.codex/hooks.json`, for instance, still
deletes the 6 hooks it wires while leaving that file on disk still
referencing them, reported `outcome: "uninstalled"` (security-lens review,
RP-181). Recorded here as a known limitation rather than chased in this
change: every real `init`/`upgrade` run always records a wiring path in one
of the two, so reaching this requires a manifest already missing an entry a
real run never omits.

⚠ **A second known gap, judged materially weaker than the hole this whole
apply-time re-check exists to close, and deliberately left as a documented
limitation rather than chased in this change (security-lens review, RP-181,
cycle 8):** if a hook an EDITED (not `kept`) wiring file names is genuinely
ABSENT at plan time, its single-seeded dependency (if it has one) is never
swept — correctly, since an absent file has nothing to protect a dependency
on behalf of — and gets an ordinary `remove` verdict. If the hook then
REAPPEARS, rewired (a symlink, or a legitimate working file), in the
confirmation-prompt window before apply, nothing re-examines it: the
apply-time re-check only re-derives protection for a wiring path that was
ITSELF a plan-time `remove` verdict, and an edited wiring file never is one.
The dependency is removed on schedule. This needs write access to the
working tree in the narrow window between the plan being shown and `--yes`
being answered — materially weaker than the hole this feature closes, which
needed only a symlink committed and surviving a fresh `git clone`, no
post-plan write access at all. Closing it would mean re-deriving apply-time
protection for every wiring path unconditionally rather than only ones
already known to be plan-time `remove` verdicts — a wider change than this
cycle's fix earns.

The same END STATE needs no window and no second writer, and the comparison
above does not bound it: delete a wired hook by hand, run `uninstall --yes`
(the hook's single-seeded dependency is removed, correctly, since the hook
that needed it is gone), then restore the hook from git. The restored hook
fails at module resolution and exits 1, which a `PreToolUse` hook's caller
reads as non-blocking, while the preserved wiring still names it. The run
reports the hook under the wiring file's `still referenced:` list and under
`absent`, and its dependency under `removed`; nothing in the report connects
the three. Restoring a hook after an uninstall means restoring what it
imports too.

A hook is reported in `--json`'s `preserved` array with one of FIVE reason
wordings, decided by `protectedFileReason` from whichever evidence for its
protection actually exists — a genuine import trace beats mere caution
beats a bare direct reference — and, for a directly-named hook, WHY the
wiring file protecting it is itself preserved (its `WiringPreservedKind` —
`'edited'`, `'kept'`, or `'unsafe'`, decided once per wiring path from the
exact same distinction `planUninstall`/`applyUninstall` already compute,
never assumed):

- **Edited** — a `files`-tracked wiring file whose current bytes no longer
  match the recorded hash: `still referenced by <wiring path>, which was
preserved as edited — removing this file would leave it pointing at
nothing`.
- **Kept** — a `kept` wiring file `init` found already in place and never
  took ownership of, so it was never "edited" by anyone this command has
  evidence about: `still referenced by <wiring path>, which init found
already in place and never took ownership of — removing this file would
leave it pointing at nothing`.
- **Unsafe** — the wiring file itself could not be safely read (a symlink,
  or reached through one), so its content was never compared to anything:
  `still referenced by <wiring path>, which could not be safely read (itself
a symlink, or reached through one) — removing this file would leave it
pointing at nothing`.
- **Imported** — a file reached only through another protected file's own
  import, regardless of that file's own `WiringPreservedKind` —
  `.claude/scripts/lib/secrets.mjs` is never mentioned by
  `.claude/settings.json` at ALL, only `.claude/hooks/guard-secret-file.mjs`
  is — gets a wording that names the immediate importer instead:
  `imported by <importer>, itself needed — directly or through further
imports — by the still-preserved <wiring path>, which is why it survives
too. Removing this file would leave <importer> unable to load`, so an
  operator grepping the wiring file for the path they actually care about is
  not left empty-handed.
- **Unverified** — a path the conservative superset sweep protected without
  ever tracing it, because SOME other file the walk needed to read to keep
  tracing could not be read at all: `protected because <unreadable file>
could not be read, so every file this release installs is being kept rather
than risk removing one it needs`. Deliberately its own wording rather than
  reusing Edited/Kept/Unsafe's "still referenced by" sentence — that sentence
  claims a specific, confirmed connection this file does not have. Reusing
  it made the wording that sounds MOST certain describe the files the
  command is LEAST sure about: in one reproduced run, of 84 owned paths
  under one preserved wiring file, roughly 7 were genuinely referenced by it
  and roughly 30 were swept in by this precaution alone — including a TEST
  FIXTURE
  (`.agents/skills/new-invariant/guard-invariant.example.test.mjs`) no hook
  could ever import — all reported with the identical, fully-confident
  "still referenced by … edited" sentence (UX-lens and code-lens review,
  RP-181).

The first three exist because reusing the "edited" wording for a `kept` or
`unsafe` wiring file told two contradictory stories about the same
repository state in one report — `.claude/settings.json` → "user-owned (kept
by init)", two lines away `guard-bash.mjs` → "preserved as **edited**",
about a file nobody edited. None of the five wordings claims the immediate
importer is itself directly named by the wiring file — only that the wiring
file needs it, directly or transitively — which stays true at any import
depth, including a dependency reached three hops down
(`.claude/hooks/lib/edit-input.mjs` imports `.claude/scripts/git-env.mjs`,
and neither is named in `.claude/settings.json` at all). A reader who needs
the next hop finds it on the importer's OWN `preserved` entry. And the
Unverified wording never claims a connection at all — it names the file
whose own unreadability triggered the sweep, not a file this one supposedly
needs, which is the one honest thing left to say about a path the walk
never actually traced.

**`--detach`** performs the identical safe cleanup — every check on this page
applies exactly the same, including the two manifest-digest checkpoints and
the apply-time hook re-check — and then removes the manifest anyway, even
when something in the plan is `preserved` or was caught changed (or
protected) at apply time. It never deletes a path this command would not
otherwise have deleted on its own: `--detach` changes only whether the
manifest survives a run that left something behind, never the per-path
safety decisions above. There is no `--force` in this command, now or
planned: nothing safety refuses to remove becomes removable by a flag. Every
preserved, changed-since-planning, and apply-time-protected path is still
reported in `preserved`, which under `--detach` doubles as the handover list
— what the rig is leaving for the user to own from here.

Removing a manifest-owned file also removes any parent directory that becomes
empty as a result, walking up from that file and never past `dir` itself — with
one named exception: `.rig/` is never removed, empty or not, because it holds
evidence (claims, run state) this command has no ownership evidence for and
therefore never inspects. The one manifest-owned path this repository's own
`init` writes under `.rig/` (`.rig/revalidation.json`) is removed like any
other file when its hash matches; the directory itself is not. This walk is
symlink-safe the same way the removal itself is: each ancestor directory is
checked one path SEGMENT at a time before it is read or emptied, never as one
joined path handed to a single `lstat` — the OS resolves every intermediate
segment of a multi-component path transparently and only leaves the FINAL one
unfollowed, so a single `lstat` on the whole path would silently walk through
an ancestor swapped for a symlink after the file's own removal to reach
whatever it points at. The manifest's own removal gets the identical
per-segment re-check — folded into the two digest checkpoints above, which
both read the manifest through `regularFileStatus` before comparing bytes —
for the same reason every other removal is re-checked rather than trusted
from the plan.

⚠ **Every re-check above narrows the window an attacker can exploit; none of
them close it to zero.** Every check-then-act sequence over a filesystem —
`regularFileStatus`'s recheck before each file removal, the per-file hash
recheck immediately after it, the manifest-digest checkpoints, `upgrade`'s
own equivalents — has an unavoidable instant between the check succeeding and
the act (`unlink`, `readFile`) that immediately follows it, in which a
concurrent process with write access to the same tree could still swap
something in. Nothing in this command (or in `upgrade`) closes that instant;
each check instead closes a SPECIFIC, larger hole that would otherwise be
open the whole time between planning and applying, not the residual instant
around its own act:

- the per-segment ancestor walk closes a single `lstat` on a multi-segment
  path being resolved through an INTERMEDIATE symlink the OS itself is
  willing to follow;
- the per-file hash recheck closes the whole confirmation-prompt window for a
  plain content edit, which `regularFileStatus`'s type-only recheck cannot see
  at all;
- the two manifest-digest checkpoints close that same window for the
  manifest's own bytes, at the two points — before anything starts, and
  immediately before its own deletion — where trusting a stale value would
  otherwise authorise or discard evidence for a plan that no longer describes
  reality.

Implementation: `packages/cli/src/commands/uninstall.ts` (`planUninstall`,
`applyUninstall`), wired in `packages/cli/src/index.ts`. A successful removal
prints a reminder that the change is unstaged (`git add -A`, then commit) —
`uninstall` itself never touches git history. Pinned in
`packages/cli/test/uninstall.test.ts` and `test/e2e/uninstall.test.ts`.

## setup integrations (RP-22)

Basic Memory is an optional wiring-only preview. Its `uvx basic-memory mcp`
stdio entry is project wiring, not an installation, update, data lifecycle, or
cross-machine synchronization feature. Removing it preserves provider storage.
The doctor distinguishes launcher observation from unverified runtime and does
not infer connectivity or trust. It may coexist with the machine-scoped custom
Memory subsystem; setup reports that coexistence without connecting the two.

The integration commands use a single repository intent file,
`.rig/integrations.json`, with `schemaVersion: 1`. Legacy
`setup --memory-root` retains its machine-scoped registration and version
handshake. Separate integration receipts and `setup verify` are retired;
aggregated verification belongs to the forthcoming `doctor` surface.

```sh
create-agent-rig setup
create-agent-rig setup list --json
create-agent-rig setup add figma-mcp --harness claude-code --yes --json
create-agent-rig setup apply figma-mcp --dry-run --json
create-agent-rig setup apply figma-mcp --yes --json
create-agent-rig setup remove figma-mcp --yes --json
```

Figma and Atlassian MCP can be selected for Claude Code and Codex. Claude's
project `.mcp.json` is owned entry by entry. Codex is rendered as a whole file
from the installed release baseline plus every intended Rig MCP provider; Rig
does not parse or merge TOML.

For the public ownership and consent contract, see
`packages/cli/test/integrations-intent.test.ts`. It exercises the command
against real temporary repositories: entry hashes in intent, foreign entry
preservation, ownership-bounded removal, noninteractive consent, and changes
between the displayed plan and apply.

A Claude target records `targets["claude-code"].entryHash`, the SHA-256 of
the JSON serialization of its server entry. The provider's intended harnesses
remain in `harnesses`. The file stores no runtime observations, timestamps,
credentials, provider data or executable instructions.

Codex records one rolling `targets.codex.fileHash`, the SHA-256 of the whole
`.codex/config.toml` Rig last wrote. The first write requires the file to match
the installed release manifest's recorded baseline. Later writes require that
rolling hash; a manual edit refuses without writing and prints the compiled
provider TOML fragment, never the user's file contents. Repeated `setup add`
extends the selected harnesses. `setup apply --yes` may restore a missing previously owned Codex
file, while `setup add` refuses it. Upgrade reports a deleted Codex file and
does not restore it.

These Codex guarantees are pinned in `packages/cli/test/integrations-codex.test.ts`:
"renders both intended Codex providers from the init release baseline, rolls
one root file hash, and does not rewrite the release manifest";
"refuses a manual TOML edit with the compiled managed Figma fragment and never
echoes user config"; and "refuses an add after a previously owned Codex config
is deleted, while explicit apply restores it after consent". The last case
also checks upgrade's deleted-file verdict and unchanged intent.

Dry-run describes work without applying it. JSON mode never prompts; mutation
requires `--yes`. An interactive call obtains consent for the planned
configuration. All planned file preimages are re-read after consent, before
writing; a changed preimage refuses the operation.

An existing foreign MCP entry, including one identical to the official
endpoint, is not adopted as Rig-owned. Removal requires the recorded entry
hash to match the current entry. Other servers and root configuration fields
remain outside that ownership.

Wiring is not evidence of authorization, connectivity or trust. Authorization
stays with the provider and harness. The integration declaration accepts
provider selection and ownership baselines, never repository-supplied
commands, URLs, headers or environment values.

The human wizard selects a supported provider and Claude Code, Codex, or both,
then delegates to the same deterministic command and consent prompt. It never
inserts `--yes`. Noninteractive and JSON calls use the deterministic verbs.

Spec Kit is upstream-managed. `setup add spec-kit --harness claude-code
--harness codex` plans the official pinned `uvx --from
git+https://github.com/github/spec-kit@v1.0.8 specify` route, requiring local
`uv`, `uvx`, and `git`. The plan explains downloads and uv cache effects;
Rig does not modify global tool installations. Initial setup requires a clean
repository. Existing external installations require explicit `--adopt` and a
clean worktree. Repeated add checks authoritative status and installs only a
missing harness; it never repeats initial init.

`setup apply spec-kit` delegates `integration upgrade` for the selected
harnesses. `setup remove spec-kit` delegates `integration uninstall`. Neither
passes `--force`. Successful final status is required before writing or retiring
intent. The pinned upstream removes its integration manifest after the last
uninstall; only that precise empty-state status is accepted after successful
uninstall commands. Other partial/failing outcomes retain intent and direct
the caller to adoption/status recovery.

Rig does not copy, hash, or delete `.specify`, Spec Kit skills, or upstream
manifests. Those files remain upstream-owned and are excluded from Rig's
release manifest. Provider execution uses bounded output, deadlines and
process-tree cleanup; unconfirmed cleanup refuses success. Normal tests use
isolated fake upstream executables; real network acceptance is a separate
release check.

Executable evidence:

- `packages/cli/test/setup-wizard.test.ts` › "routes a Spec Kit both-harness
  selection through deterministic add rather than a guide".
- `packages/cli/test/spec-kit.test.ts` › "initializes a clean repository once,
  then adds only a missing harness on a later add", › "requires explicit
  adoption before touching an external .specify payload", and › "treats the
  upstream missing integration state as successful after removing the final
  requested harness".
- `packages/cli/test/spec-kit-command.test.ts` › "persists one pinned selected
  intent only after the official lifecycle succeeds, without claiming upstream
  files" and › "reports the bounded upstream status and recovery reason after
  partial setup without recording intent".
- `packages/cli/test/provider-spawn.test.ts` › "returns only after a deadline
  kills a live child and grandchild on this platform".

## Fixtures

Examples, one per shape the contract names. They are illustrative payloads, not
a schema — the conformance matrix above is where a schema belongs.

The version handshake:

```json
{
  "schemaVersion": 1,
  "name": "create-agent-rig",
  "version": "0.9.0",
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

A doctor run with one failing check — exit 1. All four fields are on both
records; `fix` carries the remedy on the failing one and is empty on the passing
one, and it is the one field allowed to name a path:

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
      "detail": "the install manifest was read",
      "fix": ""
    }
  ]
}
```

A memory load reporting its counters and its budget. The numbers are a real
reading rather than a plausible-looking one — the 2026-08-21 measurement of the
`memory/claude-config` tree recorded in that repository's
`docs/decisions/mvp-completion.md` — so the limit is the contract default and
the degradation list is what those counters oblige:

```json
{
  "schemaVersion": 1,
  "result": "ok",
  "counters": { "eligible": 7, "injected": 4, "budgetSkipped": 3, "invalid": 0 },
  "budget": { "limitBytes": 8192, "usedBytes": 7681 },
  "degradation": ["budget-skipped"]
}
```

`uninstall --yes --json`, one file preserved for each of the three ordinary
reasons this command reports, and two removed. Every removal that was PLANNED
succeeded — `removed` equals `planned` — but the manifest is kept anyway: it
still names bytes the rig did not remove, so deleting it would blind a later
`upgrade` to every one of them:

```json
{
  "schemaVersion": 1,
  "command": "uninstall",
  "dryRun": false,
  "planned": [".claude/hooks/block-no-verify.mjs", ".claude/settings.json"],
  "removed": [".claude/hooks/block-no-verify.mjs", ".claude/settings.json"],
  "absent": [],
  "preserved": [
    { "path": ".claude/rules/invariants.md", "reason": "modified" },
    { "path": ".claude/rules/workflow.md", "reason": "line-endings-only" },
    { "path": "CLAUDE.md", "reason": "user-owned (kept by init)" }
  ],
  "notes": [],
  "manifestRemoved": false,
  "outcome": "partial"
}
```

The same two files, on a pristine rig with nothing else installed — nothing
preserved, so this time the manifest is removed too:

```json
{
  "schemaVersion": 1,
  "command": "uninstall",
  "dryRun": false,
  "planned": [".claude/hooks/block-no-verify.mjs", ".claude/settings.json"],
  "removed": [".claude/hooks/block-no-verify.mjs", ".claude/settings.json"],
  "absent": [],
  "preserved": [],
  "notes": [],
  "manifestRemoved": true,
  "outcome": "uninstalled"
}
```

The first run had it failed partway through instead, on the second file —
exit 1, the manifest kept, `removed` now the SUBSET that actually finished
before the error rather than the full `planned` list, and no `outcome` at
all: a hard failure is its own signal, not one of the three end states:

```json
{
  "schemaVersion": 1,
  "command": "uninstall",
  "dryRun": false,
  "planned": [".claude/hooks/block-no-verify.mjs", ".claude/settings.json"],
  "removed": [".claude/hooks/block-no-verify.mjs"],
  "absent": [],
  "preserved": [
    { "path": ".claude/rules/invariants.md", "reason": "modified" },
    { "path": ".claude/rules/workflow.md", "reason": "line-endings-only" },
    { "path": "CLAUDE.md", "reason": "user-owned (kept by init)" }
  ],
  "notes": [],
  "manifestRemoved": false,
  "completed": [".claude/hooks/block-no-verify.mjs"],
  "remaining": [".claude/settings.json"],
  "error": "EPERM: operation not permitted, unlink '.claude/settings.json'"
}
```

`uninstall --yes --detach --json` over the same preserved file as the first
fixture: the manifest is removed anyway, `outcome` says so, and the preserved
path is the handover list — the one thing left for the user to own:

```json
{
  "schemaVersion": 1,
  "command": "uninstall",
  "dryRun": false,
  "planned": [".claude/hooks/block-no-verify.mjs", ".claude/settings.json"],
  "removed": [".claude/hooks/block-no-verify.mjs", ".claude/settings.json"],
  "absent": [],
  "preserved": [{ "path": ".claude/rules/invariants.md", "reason": "modified" }],
  "notes": [],
  "manifestRemoved": true,
  "outcome": "detached"
}
```

`uninstall --yes --json` removing the held-back copy of a CLAUDE.md/AGENTS.md
pair (round 4, blocker 2): CLAUDE.md is a clean `remove` (re-vouched, rig-owned
bytes), but AGENTS.md is not — preserved as the user's own edit — so removing
CLAUDE.md would leave no readable rulebook copy at all, and `notes` says so
instead of a bare `- CLAUDE.md` line. `notes` is present, and empty, on every
run that earns none of these — never omitted:

```json
{
  "schemaVersion": 1,
  "command": "uninstall",
  "dryRun": false,
  "planned": ["CLAUDE.md"],
  "removed": ["CLAUDE.md"],
  "absent": [],
  "preserved": [{ "path": "AGENTS.md", "reason": "modified" }],
  "notes": [
    {
      "path": "CLAUDE.md",
      "note": "this is the rig's own CLAUDE.md — removing it leaves AGENTS.md, which stays as yours (modified), as the only rulebook copy"
    }
  ],
  "manifestRemoved": false,
  "outcome": "partial"
}
```
