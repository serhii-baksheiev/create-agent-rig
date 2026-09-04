# Capability coverage: probe once, maintain passively, never raise on traffic

Extracted rationale for `packages/cli/src/policy/core/{probe,coverage,evidence-matrix}.ts` (RP-36).
The rules themselves are in those files' headers; this record is why they are
those rules and not the obvious alternatives.

## The question

A policy is declared once (RP-76) and enforced by a hook on some harness
surface. Whether it is *actually* enforceable there depends on the surface, its
version and its OS — a matcher that lost a tool, a hook that was never wired, a
wiring file the reader cannot parse. Rig has to know which of those it is, and
say so, without ever letting "we could not tell" read as "it passed".

## What was decided

### 1. One active probe, occasioned by a change — never by a clock

`PROBE_TRIGGERS` is `install`, `upgrade`, `registration`, `reconnect`. Every
member is an event on the surface, and the vocabulary offers no word for an
interval.

That is only worth stating because the vocabulary has a **consumer**:
`coverageFromProbe` takes a `trigger` as a required argument, refuses a word
outside `PROBE_TRIGGERS`, and records it on every entry as `triggeredBy`. The
first version of this record claimed the prohibition was kept by the vocabulary
alone. Nothing read it, and a vocabulary nothing reads keeps nothing. Pinned in
`packages/cli/test/policy-coverage.test.ts` (absent in a generated rig) ›
"refuses the trigger %j, because the coverage contract accepts only a declared
surface-change trigger".

⚠ What this still does not do: nothing stops a caller supplying `'upgrade'`
four times an hour. `probe.ts` cannot fetch a snapshot — one arrives as an
argument — which bounds the module, not the practice.

*Rejected: periodic re-probing.* It costs a scheduler, it produces a stream of
identical answers between two events that could have changed the answer, and it
invites the failure mode below — a status that decays because nothing happened,
on a surface that is working perfectly.

### 2. Degradation follows an observed miss, never elapsed time

`observeExpectedSignal` takes `{ seen, at }`. There is no parameter for "and
this much time has passed", and the module exports no function that ages,
expires or sweeps an entry.

**No traffic is not a failure — it is no evidence.** A rig that ran no edits
this week learned nothing about `guard-secret-file`, and a contract that
degrades it anyway is reporting its own idleness as a defect in the mechanism.
What the entry carries instead is `verifiedAt` and `verifiedBy`, so a reader
can see for themselves how old the evidence is and decide.

### 3. Traffic lowers a status; only a probe raises one

This asymmetry is load-bearing, so it is written down.

A **missing** signal is evidence the mechanism did not act on an operation it
should have judged. A **present** signal is evidence it acted *once*. Those are
not symmetric claims: the second says nothing about the wiring defect a probe
found, because a partially-wired surface still acts on the operations it does
cover. Promoting on traffic would let a `DEGRADED` matcher that lost one tool
report itself `SUPPORTED` off the traffic that never used that tool — the exact
false confidence the four-state vocabulary exists to prevent.

So the seen-signal path resets the miss count and re-stamps `verifiedAt`, and
leaves `status` and `degradationReason` alone — with one carve-out, which is
decision 3a below and is a contradiction rather than a promotion.

For the same reason traffic never carries a status past `DEGRADED` in the
enforcement ordering. Stated exactly, because the carve-out would otherwise
read as an exception to it: `INTEGRATION-FAILED` ranks EQUAL to `UNSUPPORTED`,
not above it, so moving between them is a change of diagnosis and not a further
loss of capability. `UNSUPPORTED` and `INTEGRATION-FAILED` are both claims
about wiring, and traffic does not read wiring.

### 3a. A signal seen where the record says nothing is wired is a contradiction

The carve-out to decision 3, added after `code-reviewer` observed that
`INTEGRATION-FAILED` — which RP-36 defines as *"mechanism present but
probe/evidence contradicts declared behavior"* — was unreachable from evidence
in the first implementation. It could only be produced by an unreadable
snapshot, which is a case where the mechanism's presence is precisely what was
*not* established.

The sharpest instance is `seen: true` on an entry recorded `UNSUPPORTED`: the
signal was observed on a surface the map says wires nothing. Absorbing that
silently was worse than either answer it could have given, because the entry
came out re-stamped `verifiedBy: 'traffic'` — a contradicted status wearing a
fresh timestamp.

It is **not** a promotion, and decision 3 stands: the status does not go up.
The entry becomes `INTEGRATION-FAILED` with a reason naming the disagreement,
and `qualifierFor` still returns `UNVERIFIABLE`, so nothing about it produces a
pass. Pinned in `packages/cli/test/policy-coverage.test.ts` (absent in a
generated rig) › "a signal observed where the map says nothing is wired is a
contradiction, not a pass".

### 4. The threshold is configurable, and its default is 3

One miss is as easily an operation that never reached the mechanism as a
mechanism that failed to act. Three is a default, not a constant: how much
evidence is enough depends on how much traffic a surface sees, so every caller
may set its own. A threshold that is not a whole number ≥ 1 throws rather than
being coerced — the interesting coercion, `0`, would degrade on the first miss
while reading like "no threshold".

### 5. Unreadable is not the same answer as absent

`probe.ts` returns `UNSUPPORTED` for a readable snapshot that wires the hook
nowhere, and `INTEGRATION-FAILED` for a snapshot — or a `hooks` field — in a
shape it cannot read. `.claude/rules/invariants.md` draws this line under
"Refusing to inspect is a third outcome": a field that is simply ABSENT leaves
nothing to judge; a field PRESENT in an unreadable shape is the case worth
reporting.

Collapsing them costs something in each direction, which is why the
distinction is worth two states: an honest "not installed on this surface"
becomes a false alarm, or an unreadable surface becomes a quiet, uncounted
zero. The second is the one that has actually happened in this repository
before — a guard reported out loud that it had not looked, and returned the
value meaning "there was nothing to look at".

Both states are safe by construction anyway: `qualifierFor` maps each to
`UNVERIFIABLE`, and the decision-record validator refuses an unqualified
verdict carrying either — held over both modules at once by ›
"refuses the silent pass an unwired surface would otherwise produce, and
accepts it once qualifierFor speaks". Which states those are is one list,
`UNENFORCEABLE_STATES`, that both modules import.

### 6. The validator refuses an incomplete evidence row

`validateEvidenceRow` refuses a row without an exact `harnessVersion` or an
ISO-8601 `observedAt` with a zone, refuses any non-`SUPPORTED` row that does
not say why, and refuses a `SUPPORTED` row that says why anyway.

A row missing either reads like evidence and is not one: nothing in it answers
"which build was this" or "was this before or after the change". Accepting it
is how a matrix fills with rows a later reader takes for measurements. This
module validates and returns a result; a caller that persists rows owns storage.

**"Exact" is a check, not an adjective** — in both shapes that carry a version.
`isExactVersion` lives in `validation.ts` and is read by `validateEvidenceRow`
for a matrix row and by `coverageFromProbe` for a surface identity, so the word
means one thing wherever it is written.

The vague words and range operators are refused: ›
"refuses the harness version %j, because it names a range or a moving target
rather than a build", with › "accepts the exact harness version %j, including a
plain build id" holding the other direction so the rule cannot swallow a real
build id.

### 7. "Is this hook wired?" is answered by comparison, never by parsing shell

The input surface is the whole shell grammar, while the error is asymmetric: a false
`UNSUPPORTED` understates, while a false `SUPPORTED` is the silent pass on an
unwired guard that this entire contract exists to prevent. A partial parser
against the whole shell grammar loses that trade every time.

*Decided: the rig GENERATES its wiring, so the probe compares against what it
would generate.* `NativeHookSurface.commands` carries the exact strings; a
command matches or it does not. No grammar, no arms race.

The substring test survives, and its failure direction is why that is safe: it
now only chooses between `INTEGRATION-FAILED` and `UNSUPPORTED`, two
non-passing answers, so a false positive can no longer reach `SUPPORTED`.

**What it costs, stated plainly.** The comparison tolerates runs of spaces and
tabs, but it does not try to prove that other hand-written shell spellings run
the same hook. When no verified command runs for the event, a non-matching
command that literally names the hook path reads `INTEGRATION-FAILED`; one that
does not reads `UNSUPPORTED`. Both are non-passing answers. Another group with
the exact generated command can still make the event `SUPPORTED`. A rig that
hand-wires its hooks may therefore see unverifiable rows until it adopts a
generated spelling.

*Rejected: a real shell parser.* Correct, and a new runtime dependency in a
package whose zero-dependency property is what keeps `npx github:…` working —
a Tier-2 decision, and the wrong trade for one predicate.

*Rejected: dropping the question.* The probe could report only what is
declared and leave "does it run" entirely to the traffic half. Most faithful to
"never a silent pass", and a larger rework than the contract needs: comparison
answers it without inference.

## What this does NOT do, stated so the contract is not read wider than it is

- **Nothing calls it yet.** This is a library surface. `doctor` rendering the
  coverage report is RP-21; emitting decision records at runtime is its own
  task; the benchmark that consumes these statuses as expected outcomes is
  RP-111.
- **The probe reads a snapshot, not a running harness.** It answers "is the
  mechanism wired as the declaration says", not "did the harness actually run
  it". The second question is what the traffic path is for, and the traffic
  path is fed by a caller that does not exist yet either.
- **`observeExpectedSignal` is mechanical where it runs; that it runs is not.**
  Nothing forces a caller to report a miss. The contract makes the answer
  correct once the observation arrives; it does not make the observation
  arrive.
- **No code OBTAINS a harness version.** `SurfaceIdentity.harnessVersion` is
  supplied by the caller; `coverageFromProbe` refuses one that names a range or
  a moving target, but nothing here asks a live harness which build it is. An
  earlier draft of this bullet said "checked for shape" while nothing checked
  it; the check now exists.
- **The surface identity is bound to its adapter.** `coverageFromProbe` refuses
  a harness name or surface path that differs from the adapter being probed, so
  valid wiring from one harness cannot be reported as support on another.
- **`DEGRADED` carries no verdict qualifier.** An operation on precisely the
  tool a degraded matcher lost does not require a qualifier from this library.
  The item scopes the `UNVERIFIABLE` requirement to the unenforceable states,
  so this is the contract as written — but it is a limit of the "never a silent
  PASS" claim and not covered by it. The caller, not this library, owns the
  operation verdict.
- **A `reason` given with a non-degrading miss is discarded.** Only the miss
  that crosses the threshold records one — › "discards the reason given with a
  miss that does not degrade, and records the one given with the miss that
  does".
- **`downgradesBetween` compares by harness, surface and OS — not by version.**
  A probe before and after an upgrade carries two versions of one surface, and
  that pair is exactly what the `upgrade` trigger exists to compare. Including
  the version in the equality made the function throw on the only case it was
  added for, which is what `code-reviewer` caught: › "compares two probes of
  the same surface across a harness upgrade, which is the fall the upgrade
  trigger exists to catch".
- **Policies are correlated by id and declaration version.** Two entries with
  the same `policyId` but different `policyVersion` describe different policy
  semantics, so they are not reported as a capability downgrade.
- **The probe compares; it does not parse.** A wiring reads `SUPPORTED` only
  when its command equals one the adapter says this harness generates, modulo
  runs of spaces and tabs and a leading or trailing space. A spelling that contains
  the hook path LITERALLY and matches none of them is `INTEGRATION-FAILED`
  **when nothing else under that event ran the hook**. A spelling that refers to
  the hook without containing that exact substring — a different case, a
  backslash separator, a path split across two variables — is not recognised as
  naming it at all and reads `UNSUPPORTED` — including hand-written wirings that
  really do run it. It does not outrank a verified command: a hook list is
  conjunctive, so an entry the probe could not read cannot un-run one it did
  read. Decision 7 has the reasoning and the cost.

## Where the rules are pinned

`packages/cli/test/policy-coverage.test.ts` (absent in a generated rig) — the
unit half: the four probe answers, the threshold rules, the asymmetry, the
`UNVERIFIABLE` linkage through the real decision-record validator, and the
evidence-row shape.

`test/template/policy-coverage.test.ts` (absent in a generated rig) — the
acceptance half: the same probe against the hook-wiring snapshots this rig
really ships, on both harness surfaces, each paired with a mutation of that
same real snapshot so a green pass cannot be vacuous.
