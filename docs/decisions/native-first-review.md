# ADR-RP-241 — native-first review, differentiate on the delta

⚠ **This record is not synced.** It is authored here and stays here, like
`agent-roles-1.0.md` and `memory-rig-boundary.md` beside it. It records how the
generator decides to grow its review behaviour, names tracker keys, and no
shipped rulebook cites it. **Edit it in place.**

Status: accepted for 1.1 (RP-241, epic RP-219). The companion rule — upstream
findings are evidence, never the verdict — is RP-240 and lives in the `pr-ship`
skill, because that is where a session meets such findings.

## Decision

Before Rig's review behaviour is expanded in 1.x:

1. revalidate what Claude Code offers natively and through its official plugins;
2. revalidate what Codex offers natively;
3. name the exact Rig-specific governance delta the change would add;
4. prefer upstream evidence over cloning generic review behaviour into Rig;
5. keep the one cross-harness Rig verdict contract.

For 1.1 that means **no change to the review subsystem**: `code-reviewer`,
`security-scanner` and `prose-reviewer`, the lane router, the verdict shape, the
`headSha` binding and the coverage check stay as they are. Rig does not copy
multi-perspective fan-out, confidence scoring, history agents or plugin
orchestration from upstream without a measured need.

## What was checked, on 2026-09-24

- **Claude Code 2.1.281** ships a built-in `/security-review` command. The
  official plugin marketplace (`anthropics/claude-plugins-official`) offers
  `code-review` and `pr-review-toolkit`. Either is a Claude Code plugin: a
  contributor driving the same repository from Codex gets nothing from it.
- **Codex 0.156.1** ships `codex review` (`--base`, `--commit`, `--uncommitted`).
  Its help lists no structured-output option: the result is prose for a person.
- Neither produces a verdict bound to a commit that the other harness can check,
  and neither knows an item's text, the autonomy tiers, the independent-oracle
  rule or the rulebook's own claims.

## Why

Upstream tools are strong at generic bug and security discovery and improve
without Rig doing anything. What they do not provide is what Rig's gate is for:
the same obligation on both harnesses before a merge, a verdict tied to the exact
head, and the checks only a reader of this repository's rules can make.
Rebuilding generic discovery inside Rig would duplicate the part upstream does
well and add nothing to the part only Rig does.

## Revisit when

- Codex exposes structured review findings a session can call and read;
- plugin availability becomes something a repository can declare for both
  harnesses;
- the RP-231 pilot shows generic correctness or security findings dominate Rig's
  blockers, and upstream catches them no worse on both harnesses;
- keeping duplicate generic review logic becomes a measured cost.

A thinner, governance-only Rig reviewer is considered only after one of these,
and only if Claude/Codex parity survives it.

## Non-goals

No plugin abstraction, no reviewer framework, no code change, and no review path
that exists for one harness only.
