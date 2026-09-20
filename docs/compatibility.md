# Compatibility: Claude Code × Codex × capability

What a generated rig can rely on, per harness and per platform, and the test
that holds each claim. `test/template/compatibility-matrix.test.ts` reads every
table below that has an `evidence` column: it refuses a status word outside the
vocabulary, a measured status with no test pointer, an unmeasured status with
no note, and any pointer whose test file is gone or no longer contains the
quoted test name.

## Status vocabulary

- **SUPPORTED** — the capability is enforced or delivered, and a test executes
  it.
- **DEGRADED** — it works with a stated loss, and a test executes what remains.
- **UNSUPPORTED** — it was asked for and cannot be provided on that harness or
  platform, and a test shows the refusal or the absence.
- **NOT-APPLICABLE** — the surface it would act on does not exist there (a
  Codex column for a Claude-only tool, a Linux column for a Windows-only
  command). Never used for something that exists and is unmeasured.
- **UNVERIFIED** — it may work, but no test executes it. Nothing is claimed.

A cell carries exactly one of these words; qualifications go in `notes`.

## Retained guards and hooks

The hooks shipped in `templates/agent-os/universal/.claude/hooks/`. Every
`PreToolUse` guard wired in `.claude/settings.json` or `.codex/hooks.json` has
an allowed and a denied fixture executed through the **wiring command string**
in `guard-acceptance.test.ts`, in the payload shape that harness sends (Codex
edits through `apply_patch`), or a reasoned exception there; that file's
correspondence block derives the wired set from the two wiring files, so a
newly wired guard with neither fails it, and it requires a row in this table
for each.

| capability                                                                            | Claude Code | Codex          | evidence                                                                                                                                                                                                                                                                                                                                                       | notes                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------- | ----------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guard-secret-file` (no credential value or filename lands through an edit)           | SUPPORTED   | SUPPORTED      | `guard-acceptance.test.ts` › "every retained PreToolUse guard, run through the shipped wiring of each harness that carries it"; `guard-secret-file.test.ts` › "blocks apply_patch when an added line carries a credential value"                                                                                                                               |                                                                                                                                                                                                |
| `guard-rulebook` (an unattended run stays inside its item's allow-list)               | SUPPORTED   | SUPPORTED      | `guard-acceptance.test.ts` › "guard-rulebook.mjs, run through the shipped wiring, on both harnesses"; `guard-rulebook.test.ts` › "blocks a Codex apply_patch that updates settings.json"                                                                                                                                                                       |                                                                                                                                                                                                |
| `block-no-verify` (pre-commit is never bypassed)                                      | SUPPORTED   | SUPPORTED      | `guard-acceptance.test.ts` › "every retained PreToolUse guard, run through the shipped wiring of each harness that carries it"; `hooks.test.ts` › "blocks git commit --no-verify"                                                                                                                                                                              |                                                                                                                                                                                                |
| `guard-bash` (the Never tier, made mechanical)                                        | SUPPORTED   | SUPPORTED      | `guard-acceptance.test.ts` › "every retained PreToolUse guard, run through the shipped wiring of each harness that carries it"; `hooks.test.ts` › "blocks a force-push that names a protected branch"                                                                                                                                                          |                                                                                                                                                                                                |
| `guard-subagent-model` (a pinned subagent's model is not overridden at the call site) | SUPPORTED   | NOT-APPLICABLE | `guard-acceptance.test.ts` › "every retained PreToolUse guard, run through the shipped wiring of each harness that carries it"; `subagent-routing-hooks.test.ts` › "blocks a call-site model on a project agent that pins one, and says to re-dispatch without it"                                                                                             | Codex has no `Agent` tool call site; `subagent-routing.test.ts` › "keeps both routing hooks out of the Codex projection" holds that it is not wired, and the acceptance case asserts the same. |
| `gate-stop-dod` (the Definition of Done as a `Stop` gate)                             | SUPPORTED   | SUPPORTED      | `hooks.test.ts` › "refuses the stop while a named DoD check fails" and › "registers the DoD stop gate and the rules injector"; `codex.test.ts` › "wires native Codex hooks with portable commands and apply_patch coverage"                                                                                                                                    | The hook is executed directly, not through the wiring string; the wiring is asserted separately. Inert until the project writes `dod-checks.json`.                                             |
| `inject-rules` (autonomy rules re-injected at `SessionStart`)                         | SUPPORTED   | SUPPORTED      | `hooks.test.ts` › "injects the autonomy rules into context on SessionStart" and › "registers the DoD stop gate and the rules injector"; `codex.test.ts` › "wires native Codex hooks with portable commands and apply_patch coverage"; `init.test.ts` › "the wired .codex/hooks.json SessionStart command emits a JSON envelope on a freshly installed project" | Also executed through the generated `.codex/hooks.json` wiring string itself (POSIX; `commandWindows` on Windows CI), as of RP-185 — not only invoked directly.                                |
| `warn-subagent-routing` (`SessionStart` advisory; never blocks)                       | SUPPORTED   | NOT-APPLICABLE | `subagent-routing-hooks.test.ts` › "warns on a Claude Code older than 2.1.251 and names the minimum"; `subagent-routing.test.ts` › "runs the routing check at session start, beside the rules injector"                                                                                                                                                        | It warns about Claude Code routing variables; the Codex projection does not carry it.                                                                                                          |

## Platforms

Every status in the table above was measured on Linux, in the pull-request
`ci` job. This table says what is and is not executed on Windows, where the two
harnesses run different command strings: Claude Code the same `command`, Codex
its `commandWindows` (a PowerShell script).

| capability                                                      | Linux          | Windows        | evidence                                                                                                                                                                                                                                      | notes                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------- | -------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| guards executed through the Claude Code wiring `command`        | SUPPORTED      | UNVERIFIED     | `guard-acceptance.test.ts` › "Claude Code wiring: allows the allowed fixture and blocks the denied one"                                                                                                                                       | Windows: the execution is skipped there (no POSIX shell), and no other test runs the Claude Code command string on Windows.                                                                                                                                                                                    |
| guards executed through the Codex POSIX `command`               | SUPPORTED      | NOT-APPLICABLE | `guard-acceptance.test.ts` › "Codex wiring: allows the allowed fixture and blocks the denied one, and declares a Windows command too"                                                                                                         | Codex runs `commandWindows`, not `command`, on Windows.                                                                                                                                                                                                                                                        |
| `guard-rulebook` executed through the Codex `commandWindows`    | NOT-APPLICABLE | SUPPORTED      | `codex.test.ts` › "anchors a nested-cwd Windows Codex rulebook edit to the canonical repository root"                                                                                                                                         | Linux runs `command`. The Windows case executes the refusal only; no allowed payload is run through `commandWindows`. It runs only in `e2e.yml`'s `windows-e2e` job (master pushes, nightly, release dispatch), never on a pull request: `root-ci.test.ts` › "keeps the Windows full suite off pull requests". |
| the other guards executed through the Codex `commandWindows`    | NOT-APPLICABLE | UNVERIFIED     | `codex.test.ts` › "wires native Codex hooks with portable commands and apply_patch coverage"                                                                                                                                                  | That test decodes each `commandWindows` and asserts its shape on every platform; nothing executes the others on Windows.                                                                                                                                                                                       |
| hook logic executed directly (`node <hook>.mjs`, fed a payload) | SUPPORTED      | SUPPORTED      | `hooks.test.ts` › "blocks git commit --no-verify"; `guard-secret-file.test.ts` › "blocks a Write to a credential path given absolutely, as the tool actually sends it"; `root-ci.test.ts` › "excludes no file by name on either Windows lane" | Windows: in the `windows-e2e` job only, not on pull requests; cases that need a capability Windows lacks skip through a named helper (`platform-skips.test.ts` › "every platform-conditional skip goes through a helper that carries a reason").                                                               |

## Skills, agents and rulebook delivery

| capability                            | Claude Code | Codex     | evidence                                                                                                                                                                                                   | notes                                                         |
| ------------------------------------- | ----------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| skills delivered as authored markdown | SUPPORTED   | SUPPORTED | `codex.test.ts` › "publishes every shared skill through the Codex repository skill location"                                                                                                               | Claude Code reads `.claude/skills/`, Codex `.agents/skills/`. |
| agent specs delivered                 | SUPPORTED   | SUPPORTED | `codex.test.ts` › "publishes every Claude agent as a project-scoped Codex custom agent"; `subagent-routing.test.ts` › "pins every Claude agent template to the model and effort its routing role declares" | Codex receives them projected to TOML under `.codex/agents/`. |
| rulebook prose (`CLAUDE.md` / rules)  | SUPPORTED   | SUPPORTED | `codex.test.ts` › "is in sync with its Claude Code sources"; `dogfood.test.ts` › "CLAUDE.md and .claude/ are in sync with templates/agent-os"                                                              | Codex receives the same text as `AGENTS.md`.                  |

## The optional external-subsystem contract

Harness-neutral: a contract between the rig's CLI and an optional external
subsystem (Memory), so one status column. Nothing in the core install depends
on it.

| capability                                                                                                  | status    | evidence                                                                                                                                                                                           | notes |
| ----------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `subsystems.json` declares one memory root, validated absolute and platform-shaped                          | SUPPORTED | `subsystems.test.ts` › "resolves exactly one manifest location per platform and refuses to guess when the root is unset" and › "refuses a relative memoryRoot"                                     |       |
| `--version --json` handshake, classified into ok / manifest-stale / unsupported-absent / integration-failed | SUPPORTED | `subsystems.test.ts` › "classifies an ok handshake and reports version + contractVersion" and › "classifies an ENOENT spawn as unsupported/absent"                                                 |       |
| a foreign **major** contract version is refused, never silently downgraded                                  | SUPPORTED | `subsystems.test.ts` › "classifies a foreign major contract version"                                                                                                                               |       |
| the rig's own `--version --json` and `memory doctor --json` surface                                         | SUPPORTED | `cli-version.test.ts` › "writes exactly one handshake JSON line to stdout and exits 0" and › "answers doctor --json with the absent-manifest payload and exit 0 when this machine has no manifest" |       |
| no path named in a classified result                                                                        | SUPPORTED | `subsystems.test.ts` › "never names a path in the classified result, for any handshake outcome"                                                                                                    |       |

## What this replaces

Up to 0.9 the repository carried `packages/cli/src/policy/` (a declaration
schema, registry, decision-record format, capability probe and per-harness
adapters), a child-process benchmark over it (`scripts/policy-benchmark*.mjs`)
and a session-messaging contract. None of it was reachable from a CLI command,
an installed hook or a sync script, and the benchmark measured the guards
through its own invocation path rather than through the wiring a project runs.
RP-178 deleted it; the consumer graph that justified each deletion, and the
closure of RP-157, RP-160 and RP-161 against that graph, are recorded on
pull request #227. The 0.9 evidence stays in git history.
