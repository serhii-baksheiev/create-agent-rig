# The unattended-posture contract is one module, not two probes agreeing by accident

## Context

Preflight (RP-281, opt-in workflow layer) and the CLI's
`create-agent-rig doctor` (RP-282) both answer a version of the same
question — is it safe for this checkout to keep running unattended — and
until RP-280 they answered it from nothing shared at all. Each surface had
its own notion of which conditions mattered, no stable id for any of them,
and no way to compare one surface's answer against the other's. A condition
renamed in one surface's prose was not a condition renamed anywhere, because
nothing recorded that the two prose descriptions were ever naming the same
thing.

That also meant neither surface could say what it does not check. Some of
what "is this run's posture safe" depends on is not mechanically observable
at all from inside a hook or a script — whether the attached harness
actually loaded its hooks this session, whether Codex's own trust setting or
an editor's own trust prompt admitted them, which native OS sandbox
mode is in effect, whether the session's working directory is the checkout
the run directory was declared for. A probe that stays silent about ground
it cannot cover reads, to whoever runs it, exactly like a probe that checked
that ground and found it fine.

## Decision

`.claude/scripts/lib/posture.mjs` is the single source of the unattended
posture contract: one closed, frozen list of conditions, each with a stable
kebab-case id, a classification (`required` — a run stops; `advisory` — a
run cautions and continues; `not-observable` — this rig cannot mechanically
tell), which surface(s) report it, and which harness it applies to. It is
pure Core — zero imports, no I/O, no process access — so it carries no
assumption about how either surface gathers its evidence.

Preflight and doctor keep their own probes. Neither surface's job moves into
this module; what moves is the vocabulary they report against, and the two
pure functions that turn a reported outcome into that surface's answer
(`preflightVerdict` for the stop/caution/go decision, `doctorStatus` for the
per-condition fail/warn/ok line). A surface may name a `not-observable`
condition only with the outcome `unknown`, and an outcome other than exactly
`pass` is never read as a pass: there is no "it passed" for a thing nothing
looked at.

The CLI uses the package's own copy of this module, as it already does for
`.claude/scripts/unattended-flag.mjs`, rather than a second list. Any
documentation that explains what the contract covers points at this module
and the test that pins its shape, and never re-lists the condition ids —
the two would drift the moment an id changed in one and not the other, which
is the exact failure this decision exists to close.

## Consequences

Adding, renaming or reclassifying a condition is a contract change: it edits
one list in one file, and the test guarding that list
(`test/template/posture.test.ts`, absent in a generated rig) has to be
updated on purpose, not as a side effect of either surface's own probe code
changing. A surface that wants a new condition adds it here first, then
wires its own probe to report against it — the probe can be wrong about how
it checks a condition without ever being wrong about which conditions exist.

`not-observable` conditions stay visible as a reported limitation rather
than as the surfaces' own silent gaps. Anyone extending either surface's
probes inherits that: a condition this rig genuinely cannot check is named
as such, and nothing is tempted to approximate it into a `pass` just to
produce a tidier report.
