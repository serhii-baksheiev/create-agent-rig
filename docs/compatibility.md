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

| capability                                                                            | Claude Code | Codex          | evidence                                                                                                                                                                                                                                                           | notes                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------- | ----------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guard-secret-file` (no credential value or filename lands through an edit)           | SUPPORTED   | SUPPORTED      | `guard-acceptance.test.ts` › "every retained PreToolUse guard, run through the shipped wiring of each harness that carries it"; `guard-secret-file.test.ts` › "blocks apply_patch when an added line carries a credential value"                                   |                                                                                                                                                                                                |
| `guard-rulebook` (an unattended run stays inside its item's allow-list)               | SUPPORTED   | SUPPORTED      | `guard-acceptance.test.ts` › "guard-rulebook.mjs, run through the shipped wiring, on both harnesses"; `guard-rulebook.test.ts` › "blocks a Codex apply_patch that updates settings.json"                                                                           |                                                                                                                                                                                                |
| `block-no-verify` (pre-commit is never bypassed)                                      | SUPPORTED   | SUPPORTED      | `guard-acceptance.test.ts` › "every retained PreToolUse guard, run through the shipped wiring of each harness that carries it"; `hooks.test.ts` › "blocks git commit --no-verify"                                                                                  |                                                                                                                                                                                                |
| `guard-bash` (the Never tier, made mechanical)                                        | SUPPORTED   | SUPPORTED      | `guard-acceptance.test.ts` › "every retained PreToolUse guard, run through the shipped wiring of each harness that carries it"; `hooks.test.ts` › "blocks a force-push that names a protected branch"                                                              |                                                                                                                                                                                                |
| `guard-subagent-model` (a pinned subagent's model is not overridden at the call site) | SUPPORTED   | NOT-APPLICABLE | `guard-acceptance.test.ts` › "every retained PreToolUse guard, run through the shipped wiring of each harness that carries it"; `subagent-routing-hooks.test.ts` › "blocks a call-site model on a project agent that pins one, and says to re-dispatch without it" | Codex has no `Agent` tool call site; `subagent-routing.test.ts` › "keeps both routing hooks out of the Codex projection" holds that it is not wired, and the acceptance case asserts the same. |
| `gate-stop-dod` (the Definition of Done as a `Stop` gate)                             | SUPPORTED   | SUPPORTED      | `hooks.test.ts` › "refuses the stop while a named DoD check fails" and › "registers the DoD stop gate and the rules injector"; `codex.test.ts` › "wires native Codex hooks with portable commands and apply_patch coverage"                                        | The hook is executed directly, not through the wiring string; the wiring is asserted separately. Inert until the project writes `dod-checks.json`.                                             |
| `inject-rules` (autonomy rules re-injected at `SessionStart`)                         | SUPPORTED   | SUPPORTED      | `hooks.test.ts` › "injects the autonomy rules into context on SessionStart" and › "registers the DoD stop gate and the rules injector"; `codex.test.ts` › "wires native Codex hooks with portable commands and apply_patch coverage"                               | Executed directly, not through the wiring string.                                                                                                                                              |
| `warn-subagent-routing` (`SessionStart` advisory; never blocks)                       | SUPPORTED   | NOT-APPLICABLE | `subagent-routing-hooks.test.ts` › "warns on a Claude Code older than 2.1.251 and names the minimum"; `subagent-routing.test.ts` › "runs the routing check at session start, beside the rules injector"                                                            | It warns about Claude Code routing variables; the Codex projection does not carry it.                                                                                                          |

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

## Native plugins and generated fallback

RP-179 asked whether Rig's guard/skill/agent delivery should move to each
provider's native plugin mechanism instead of the generated repository files
`init`/`upgrade` already install. What was evaluated, and why the answer is
"not this release", is recorded in
`docs/decisions/plugin-capability-matrix.md` (generator-only, not synced —
its own banner says why). This table is the mechanically-checked half of that
record: every claim below either executes, or says in `notes` why it does not.

| capability                                                                                                                                                                       | Claude Code    | Codex          | evidence                                                                                                                                                                                                                                                                        | notes                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| guard/skill/agent delivery as installed repository files that `.claude/.rig-manifest.json` owns and `upgrade` reconciles, rather than a native plugin                            | SUPPORTED      | SUPPORTED      | `test/e2e/upgrade.test.ts` › "delivers a file the release changed, and keeps the one the user edited"; `codex.test.ts` › "publishes every shared skill through the Codex repository skill location" and › "publishes every Claude agent as a project-scoped Codex custom agent" | Acceptance #2: nothing in this delivery path can silently overwrite a repository-owned or user-owned file — an edit is reported as `conflict` (or, for generated wiring, `wiring`) and handed over, never replaced.                                                                                                                                                                      |
| the Codex projection's generated output (`AGENTS.md`, `.codex/agents/*.toml`, `.agents/skills/**`) goes through the same upgrade verdict machinery as every other installed file | NOT-APPLICABLE | SUPPORTED      | `upgrade-codex-projection.test.ts` › "%s: unchanged upgrades cleanly" and › "%s: an edit is reported as a conflict, never silently overwritten" and › "%s: a deletion stays deleted"                                                                                            | Acceptance #3. Claude Code's own installed files are the row above; this row is the Codex projection's output specifically, parametrized over `AGENTS.md`, `.codex/agents/test-writer.toml` and `.agents/skills/loop/SKILL.md`.                                                                                                                                                          |
| deterministic byte-for-byte projection from one source (`scripts/sync-codex-adapter.mjs`)                                                                                        | NOT-APPLICABLE | SUPPORTED      | `codex.test.ts` › "is in sync with its Claude Code sources"                                                                                                                                                                                                                     | `--check` runs in CI on every push (part of `pnpm test`); a drifted projection fails the build before it reaches a rig. Acceptance #1 and #3 ("deterministic").                                                                                                                                                                                                                          |
| Claude Code project-scoped, non-interactive native plugin installation (`enabledPlugins` + `extraKnownMarketplaces`, `claude plugin install … --yes`)                            | UNVERIFIED     | NOT-APPLICABLE |                                                                                                                                                                                                                                                                                 | Real and scriptable — verified directly against https://code.claude.com/docs/en/plugins-reference and https://code.claude.com/docs/en/plugin-marketplaces (2026-09-20) — but not adopted this release; see the decision record. Codex has no equivalent surface.                                                                                                                         |
| non-interactive, scriptable plugin installation                                                                                                                                  | NOT-APPLICABLE | UNVERIFIED     |                                                                                                                                                                                                                                                                                 | Only interactive `codex /plugins` is documented (https://learn.chatgpt.com/docs/plugins, verified directly 2026-09-20); no config-driven or scriptable install path was found. This is why Codex's guard/skill/agent delivery is file-based rather than a fallback of last resort — it is the documented, sanctioned mechanism (https://learn.chatgpt.com/docs/build-skills for skills). |

The same decision covers vendoring and dependency hygiene — a single status
column, like the external-subsystem contract above, because these are product
choices rather than per-harness capabilities. Checked by artifact **shape**,
not by a product's name — the owner's ruling on round 2: a name check proves
only that a word is absent from the text it scans, not that no unnamed or
differently-branded payload arrived. `docs/decisions/plugin-capability-matrix.md`
("Ruler and Superpowers", "No third-party payload, checked by shape") records
what this replaced and why.

| capability                                                                                       | status    | evidence                                                                                                                                                                                                             | notes                                                                                                                                         |
| ------------------------------------------------------------------------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| every published path matches an allowlisted root — no unexpected third-party payload, by shape   | SUPPORTED | `package-contents.test.ts` › "publishes only paths under the declared roots — an unexpected path fails by shape, not by name"                                                                                        | Acceptance #5, #6, #7. Subsumes the old name-based Ruler/Superpowers check: an unnamed vendor drop fails this the same way a named one would. |
| `templates/` source tree carries no vendored, bundled, or plugin-catalog-shaped path (pre-build) | SUPPORTED | `no-vendored-plugins.test.ts` › "carries no vendored, bundled, or plugin-catalog-shaped path"                                                                                                                        | Same predicate as the row above, checked earlier and faster, before a build even runs.                                                        |
| no vendor, cache, or dependency-install-shaped directory in the published tarball                | SUPPORTED | `package-contents.test.ts` › "carries no vendor, cache, or dependency-install-shaped directory — a second, independent proof of the same property"                                                                   | Acceptance #5. Independent of the allowlist row above — same property, proved a second way.                                                   |
| the CLI's own compiled output is the only thing under `packages/cli/dist/`                       | SUPPORTED | `package-contents.test.ts` › "ships only compiled CLI output under packages/cli/dist — every path there is a plain .js file, nothing else"                                                                           | No leaked TypeScript source, source map, or a second tool's bundle beside the compiler's own output.                                          |
| zero runtime dependencies, in both manifests that could declare one                              | SUPPORTED | `package-contents.test.ts` › "declares no runtime `dependencies` in the published package.json" and › "declares no runtime `dependencies` in packages/cli/package.json, the manifest the CLI is actually built from" | Acceptance #5. The second manifest is checked because a dependency declared only there would not appear as a literal path in the tarball.     |

RP-179's scope also asks that a future `doctor` receipt record provider/plugin
identity and observed version. **Nothing here builds one, and RP-179 does not
hand that promise to RP-22 either** — the owner ruled that RP-22 does not
inherit a "plugin-first delivery" mandate; what RP-22 owns is stated in
`docs/decisions/plugin-capability-matrix.md` ("What RP-22 owns"). This
repository has no installation-mode vocabulary yet — no enum, no schema, no
type — for such a receipt to join: `PLAN.md` uses "native-plugin" as plain
English (§1, §7), not as a defined value, and RP-22's own ticket text proposes
candidate words (`external-installer`, `native-plugin`, `hosted-service`,
`external-executable`) that are prose in a ticket, not that vocabulary
either. This section is the evidence RP-22 will classify, not the
classification.

The scope bullet "remove tracked duplicate projections from templates when
replacement evidence exists" has no target either: the replacement it names
would be a native import, which Codex does not offer, so the committed
projection stays and the bullet is recorded as unmet rather than done.

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
