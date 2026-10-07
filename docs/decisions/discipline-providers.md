# Discipline providers — Probity and Superpowers beside the Rig loop

⚠ **This record is not synced.** It is authored here and stays here, like
`adopt-wrap-extend-build.md` beside it. It names Superpowers, which nothing a
rig receives may name (`test/template/no-vendored-plugins.test.ts` ›
"references neither Ruler nor Superpowers anywhere a rig receives"). **Edit it
in place.**

Status: accepted 2026-10-07 (RP-316, a delegated decision of the release
controller under the owner's standing delegation; recorded on RP-316).

## Decision

A discipline provider shapes how one step of work is done — a test-first rule
on a single tool call, a methodology skill a session follows. It never decides
which work happens next, who does it, or whether it ships. Those stay with the
Rig kernel (`adopt-wrap-extend-build.md`, "Rig's own responsibility does not
move down this ladder"): there is one loop, and when the opt-in workflow layer
runs it, the loop is the one authoritative scheduler. A provider is optional
and upstream-owned; a rig with neither provider is the minimal rig, unchanged.

No Rig gate reads a provider's output. The verdict and gate scripts name
neither provider — `test/template/discipline-providers.test.ts` › "%s names
neither provider — the loop stays the one scheduler" — so nothing a provider
observes can become a SHIP or HOLD on its own.

## Probity

Probity (`@nizos/probity` 1.10.1, RP-399) is the supported TDD enforcement
provider on both Claude Code and Codex. Rig wraps it and does not extend it:
`setup add probity` writes the declaration and the config, the `probity-gate`
hook hands each edit to the project-local launcher, and doctor reports the
wiring (`docs/command-contract.md`, `docs/compatibility.md`). The TDD rule
itself is Probity's.

A Probity block is the harness's own `permissionDecision: "deny"` for one tool
call, relayed as Probity wrote it — `test/template/probity-gate.test.ts` ›
"Claude Write: spawns the launcher with --agent claude-code and the exact
payload bytes, and relays its stdout verbatim". It refuses that call and
nothing else; it is never a Rig verdict, and a Rig verdict never waits on it.

No Probity evidence kind is defined. Probity 1.10.1 persists nothing by
default (`dist/bin.js` in the published package). Its only record is the opt-in `--debug <path>` JSONL, whose line shape
is undocumented upstream and whose `request` field is the full hook payload —
tool input and file contents — so attaching it would put source text and
whatever an edit carried into the committed `.rig/evidence/` record. The
generic `evidence-attach.mjs` path (RP-312) still accepts any producer's
artifact a session chooses to attach; Rig defines no Probity-specific kind
until upstream documents a bounded observation format.

## Superpowers

Superpowers is not part of the default/product profile
(`docs/compatibility.md`), and that does not change here. A user may install
it at user scope beside a rig; this record states how the two coexist.

- **Orthogonal skills** — brainstorming, systematic debugging,
  verification before completion, test-driven development as a methodology —
  sit beside an attended Rig session the way any personal skill does. Nothing
  exercised this combination live, so its status is UNVERIFIED.
- **Orchestration skills are unsupported inside a Rig loop run.**
  `subagent-driven-development` dispatches its own implementer and reviewer
  subagents and asks for continuous execution without pausing between tasks
  (Superpowers 6.4.2, `skills/subagent-driven-development/SKILL.md`);
  `dispatching-parallel-agents` and `executing-plans` dispatch or drive work
  the same way. Inside a Rig loop run that is a second scheduler beside the
  loop, and it bypasses the loop's stop rules and review fan-out.
- **The boundary is a rule, not a mechanism.** Superpowers 6.4.2 has no
  per-skill enable or disable, and its SessionStart hook (`hooks/hooks.json`)
  bootstraps `using-superpowers` in every session, so Rig cannot switch the
  orchestration skills off. A rig never installs or
  wires Superpowers; an operator who runs a Rig loop with it installed owns
  keeping those skills out of the run.
- **Harness limits.** Superpowers is a Claude Code plugin. Its repository
  carries a Codex plugin directory, but Codex support is unverified here.

## The TDD retrospective

Mechanical TDD evidence (RP-302 and its slices, `tdd-evidence.md`) was retired
by RP-398 in favour of Probity. RP-302 is not restored, and no part of its
proof state machine returns. The comparison the item asks for — the removed
experiment against Probity in an adversarial lab — is not measured here: the
lab is RP-320's scope. Until it runs, the Rig-specific invariants that remain
are the ones that never depended on a TDD mechanism: gate verdicts come only
from Rig's reviewers, and external evidence is advisory and bound to the head
it was attached at (`artifact-evidence.md`).
