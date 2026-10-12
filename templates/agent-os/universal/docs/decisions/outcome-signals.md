# Outcome signals describe agent work; they never score it

## Context

A rig already keeps durable evidence of how its work went: gate verdicts,
gate rounds, claims, merges, escalations, continuations, dispatch usage. The
tempting next step is an analytics layer — throughput dashboards, quality
scores, people metrics. Each of those needs conventions this generator does
not own, and a number read without its definition is how a description turns
into a judgement.

## Decision

Outcome Evidence reports a fixed set of signals Rig can ground in its own
mechanics, each defined once in `.claude/scripts/lib/outcome-signals.mjs`:

| signal | signalVersion |
| --- | --- |
| `first-shipping-verdict` | 2 |
| `gate-rounds` | 2 |
| `claim-to-merge` | 1 |
| `interventions` | 2 |
| `continuation` | 1 |
| `tokens-per-ship` | 2 |

The module carries each signal's definition, evidence source, eligible
population, what `unknown` means for it, its known limits, the dimensions a
comparison must agree on, and the only dimensions a report may group it by.
This table and the module are pinned against each other in both directions.
A signal whose meaning changes takes a new `signalVersion`; the name alone
never carries a meaning across versions.

**Unknown is not zero.** Missing evidence is `unknown`, never zero. An unknown
value is excluded from the signal, with its count shown next to the eligible
population, so a reader sees how much the figure stands on.

**Comparisons are descriptive.** A baseline and a current value are each a
named run set, never an implicit calendar window. They are compared only when
the repository, the `signalVersion`, the population semantics and the lane
composition agree, and, where the signal lists it, the harness. A
signalVersion mismatch is `not comparable`, and so are incompatible
populations or lanes. Insufficient coverage is reported as `insufficient`. A
numeric delta is descriptive: it reads as better or worse only when the
repository configures a direction for that signal.

**Claim-to-merge is total wall time.** It includes waiting on CI and on
reviews. It is not active engineering time, and subtracting presumed pauses
does not make it so. A workflow without an authoritative merge endpoint is
excluded from the signal rather than forced into it.

**Signal-specific limits.** The first shipping verdict depends on the review
lane, and a successor or re-filed item starts its own "first". Gate rounds
count distinct reviewed heads: a fan-out recorded again at the same head
corrects the reviewer set rather than starting a round, so this signal and
`token-report.mjs`, which counts each fan-out record, can differ for one item
(the generator's `test/template/evidence-query.test.ts`, absent in a generated
rig, › "gate-rounds counts distinct fan-out heads and never reports 0 for an item without fan-out").
Interventions cover
recorded escalations and delegated decisions; tracker-specific conventions
stay outside. A continuation that is still open is unresolved, not a failed
recovery. Tokens per SHIP is conditional on trustworthy dispatch usage
evidence and is reported per harness only.

**No person is grouped, scored, ranked or compared.** No signal key and no
comparison or grouping dimension names a person — the generator's
`test/template/outcome-signals.test.ts` (absent in a generated rig) › "never groups, scores, ranks, or compares humans — no SIGNALS key or dimension value names a person".
That test reads the module's keys and dimension values; it does not read free
text, and it cannot see a report that groups by something outside `groupBy`.

## Consequences

- A new signal, or a changed meaning, is a change to the module and to this
  table together.
- Parallel activity may be reported as a descriptive count, never as a rate.
- Dashboards, rankings, DORA reimplementation and quality verdicts derived
  from these signals are out of scope.
