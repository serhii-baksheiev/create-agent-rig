# ADR-RP-400 — Adopt, Wrap, Extend, Build

⚠ **This record is not synced.** It is authored here and stays here, like
`native-first-review.md` beside it. It records how the generator decides to
grow, names tracker keys, and no shipped rulebook cites it. **Edit it in place.**

Status: accepted 2026-10-04 (RP-400, owner direction). It generalises the
review-specific rule in `native-first-review.md` to every specialized
capability.

## Decision

Before a specialized capability is implemented inside Rig, work down this
ladder and stop at the first rung that satisfies the requirement:

1. **Adopt.** Evaluate existing mature or open-source solutions for the
   capability.
2. **Wrap.** Prefer adopting one of them behind a thin Rig-owned integration
   boundary: wiring, configuration ownership, diagnostics and removal belong to
   Rig; the capability's behaviour stays upstream.
3. **Extend.** Adapt or extend the adopted solution only where a Rig-specific
   semantic requires it, and keep that delta small and named.
4. **Build.** Build a Rig-native implementation only when no existing solution
   can satisfy a documented architectural or behavioural requirement.

Rig's own responsibility does not move down this ladder: orchestration,
lifecycle, ownership, evidence, validation and revalidation, review
coordination, SHIP/HOLD verdicts, provenance and cross-harness behaviour are
the kernel Rig exists to provide. The ladder applies to specialized
capabilities that sit beside that kernel.

## Why — the example that prompted it

The 1.2 line built a Rig-native Mechanical TDD evidence contract (RP-302 and
its successors): applicability levels, a tracker marker, recorded RED and GREEN
observations and a ship-time verifier, all owned by Rig. The owner's scope
correction RP-398 removes it from the 1.2.0 release contract because its
proof state machine produced disproportionate release-tail complexity and was
not needed to prove the release's actual scope, Parallel Workflows. RP-399 then
integrates upstream Probity as an opt-in TDD enforcement provider in 1.2.1,
behind a thin Rig-owned boundary, instead.

The capability was built at rung 4 when rung 1 had a candidate. The lesson is
the ladder, not the product: the same evaluation applies to the next
specialized capability whichever upstream exists for it, and it can end at
rung 4 when the evaluation says so.

## What new work carries

A Jira item that proposes a new Rig-native subsystem or specialized capability
carries an **Existing alternatives considered** section, or equivalent
evidence linked from the item:

- the solutions evaluated;
- why adopting or wrapping them is insufficient;
- which Rig-specific requirement needs the custom implementation.

Ordinary implementation tickets — a bug fix, a refactor inside existing
boundaries, a change to a capability Rig already owns — need nothing new. This
is a question asked before building, not a form to fill.

## Not decided here

- Which Rig-native TDD evidence invariants, if any, are worth keeping beside an
  upstream provider: that comparison is deferred (RP-398 "Follow-up", RP-316).
- How external providers are generalised: the 1.5 composition work (RP-311,
  RP-316) may later normalise an integration, but an initial thin integration
  does not wait for it.
