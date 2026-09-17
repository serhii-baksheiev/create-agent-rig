# Compatibility: Claude Code × Codex × capability

RP-178. This is the executable replacement for the removed benchmark/evidence
framework (`packages/cli/src/policy/`, `scripts/policy-benchmark*.mjs`,
`contracts/session-messaging/`) — see "Consumer graph" below for why that
framework was dead code, not a working compatibility check.

Every row below is `SUPPORTED`, `DEGRADED` or `UNSUPPORTED` on each harness,
with a pointer to the test that holds it, in the form `file › "test name"`, or
an exact release-evidence pointer (a commit, a PR, a journal entry) when the
claim is about something already shipped and closed rather than something a
current test still exercises.

## Retained security guards

Each row names one guard shipped in
`templates/agent-os/universal/.claude/hooks/`. Coverage differs by row, and is
stated exactly rather than by one blanket claim:

- **Six of these** (`guard-core-purity`, `guard-web-boundary`,
  `guard-secret-file`, `guard-rulebook`, `block-no-verify`, `guard-bash`) are
  wired on `PreToolUse` identically in `.claude/settings.json` and
  `.codex/hooks.json`, and each has at least one allowed and one denied
  execution fixture invoked through the real wiring **command string** of
  both harnesses, in `test/template/guard-acceptance.test.ts`. That file also
  covers `guard-bash` and `guard-rulebook`'s own richer behaviour by pointer
  rather than by duplication — see the file-specific suites below.
- **`guard-subagent-model`** is also wired on `PreToolUse` (Claude Code only,
  matcher `Agent`), but its allow/deny fixtures live in
  `subagent-routing-hooks.test.ts`, invoked against the hook file directly
  rather than through the wiring string — the same pattern
  `guard-acceptance.test.ts`'s own header says it does not duplicate for
  `guard-bash`/`guard-rulebook`. `subagent-routing.test.ts` separately checks
  the wiring itself (that `Agent` is the only matcher carrying it, and that
  Codex's projection carries neither routing hook).
- **`gate-stop-dod`** is a `Stop` hook, not `PreToolUse`: its own fixture
  (a real `git status` plus `dod-checks.json`) is in `hooks.test.ts`.
- **`warn-subagent-routing`** is a `SessionStart` advisory, not a blocking
  guard: informational, not a fixture pair.

`test/template/guard-acceptance.test.ts` ›
"the PreToolUse wiring, this file's fixtures, and docs/compatibility.md name
the same guards" is the bidirectional check that keeps this table and that
file's `FIXTURES` from drifting apart as guards are added or removed: a wired
guard with neither a fixture nor a listed exception fails it, and so does a
fixture, exception, or table row naming something that turns out not to be
wired (or, for a table row, not to exist as a hook file at all). Its own
`ACCEPTANCE_EXCEPTIONS` list is what excuses `guard-subagent-model` from a
`guard-acceptance.test.ts` fixture.

| guard                                                                                    | Claude Code                   | Codex                                                         | test                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guard-core-purity` (domain core stays pure)                                             | SUPPORTED                     | SUPPORTED                                                     | `guard-acceptance.test.ts` › `guard-core-purity.mjs` describe block; logic detail in `hooks.test.ts` › "guard-core-purity hook (the genuinely blocking gate)"                                                                                                                                                                                         |
| `guard-web-boundary` (web imports core/shared only)                                      | SUPPORTED                     | SUPPORTED                                                     | `guard-acceptance.test.ts` › `guard-web-boundary.mjs`; `hooks.test.ts` › "guard-web-boundary hook (web imports core/shared only)"                                                                                                                                                                                                                     |
| `guard-secret-file` (no credential value or filename lands through an edit)              | SUPPORTED                     | SUPPORTED                                                     | `guard-acceptance.test.ts` › `guard-secret-file.mjs`; `guard-secret-file.test.ts`                                                                                                                                                                                                                                                                     |
| `guard-rulebook` (unattended run stays inside its item's allow-list)                     | SUPPORTED                     | SUPPORTED                                                     | `guard-acceptance.test.ts` › `guard-rulebook.mjs, run through the shipped wiring, on both harnesses`; full behaviour in `guard-rulebook.test.ts`                                                                                                                                                                                                      |
| `block-no-verify` (pre-commit is never bypassed)                                         | SUPPORTED                     | SUPPORTED                                                     | `guard-acceptance.test.ts` › `block-no-verify.mjs`; `hooks.test.ts` › "block-no-verify hook"                                                                                                                                                                                                                                                          |
| `guard-bash` (the Never tier, made mechanical)                                           | SUPPORTED                     | SUPPORTED                                                     | `guard-acceptance.test.ts` › `guard-bash.mjs`; full quoting/matching behaviour in `guard-bash.test.ts`                                                                                                                                                                                                                                                |
| `guard-subagent-model` (a pinned subagent's model cannot be overridden at the call site) | SUPPORTED                     | not applicable — Codex has no `Agent` tool call site to guard | `subagent-routing-hooks.test.ts` › "guard-subagent-model hook (a call-site model never overrides a pinned role)"; wiring checked by `subagent-routing.test.ts` › "wires the call-site model guard on the Agent tool and nowhere else" and › "keeps both routing hooks out of the Codex projection, which has no Agent tool and no Claude environment" |
| `gate-stop-dod` (the Definition of Done as a mechanical Stop gate)                       | SUPPORTED                     | SUPPORTED                                                     | `hooks.test.ts` › "gate-stop-dod hook (the Definition of Done as a mechanical gate)"; wiring presence in `hooks.test.ts` › "hook wiring (settings.json)" and the equivalent Codex assertions in `codex.test.ts`                                                                                                                                       |
| `warn-subagent-routing` (session-start advisory, not a blocking guard)                   | SUPPORTED, informational only | not applicable — no equivalent session-start hook             | `subagent-routing.test.ts` › "runs the routing check at session start, beside the rules injector"                                                                                                                                                                                                                                                     |

Row-by-row status reasoning: Codex has no `Agent` tool and no persistent
in-session environment the way Claude Code does, so a call-site model guard
and a session-start routing warning have nothing to attach to there — this is
declared `not applicable`, never `UNSUPPORTED`, because `UNSUPPORTED` in this
matrix means "the same capability was asked for and could not be enforced",
not "the surface it would enforce on does not exist on this harness".

## Subagent routing and effort pinning (the finer-grained capability rows)

`docs/capability-evidence.json` carries the finer-grained mechanism rows this
table does not restate (`subagent-model-pin`, `subagent-effort-pin`,
`unnamed-subagent-effort`, `call-site-model-guard`), each with its own
`SUPPORTED`/`DEGRADED`/`UNSUPPORTED` verdict, harness version, OS and evidence
pointer. Its shape is checked by a test-only validator
(`test/helpers/evidence-row.ts`) in `subagent-routing.test.ts` › "capability
evidence records what the Claude routing can and cannot pin". That JSON
predates and is unaffected by the RP-178 reduction — it never imported
`packages/cli/src/policy/`.

## Skills and agents delivery

| capability                            | Claude Code                       | Codex                                                 | test                                                                                                                                                           |
| ------------------------------------- | --------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| skills delivered as authored markdown | SUPPORTED (`.claude/skills/`)     | SUPPORTED (`.agents/`, skills only — no agent specs)  | `codex.test.ts` › "Codex adapter is generated from the Claude Code Agent OS"                                                                                   |
| agent specs delivered                 | SUPPORTED (`.claude/agents/*.md`) | SUPPORTED, projected to TOML (`.codex/agents/*.toml`) | `codex.test.ts` › "Codex adapter is generated from the Claude Code Agent OS"; `dogfood.test.ts` › "CLAUDE.md and .claude/ are in sync with templates/agent-os" |
| rulebook prose (`CLAUDE.md`/rules)    | SUPPORTED                         | SUPPORTED, projected to `AGENTS.md`                   | `scripts/sync-codex-adapter.mjs --check` (also run in CI)                                                                                                      |

## Hook wiring

| event                                    | Claude Code | Codex                                                    | test                                                                                                                                                            |
| ---------------------------------------- | ----------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PreToolUse` (the seven guards above)    | SUPPORTED   | SUPPORTED for six; `guard-subagent-model` is Claude-only | `guard-acceptance.test.ts`; `guard-subagent-model`'s own fixtures are in `subagent-routing-hooks.test.ts`                                                       |
| `Stop` (`gate-stop-dod`)                 | SUPPORTED   | SUPPORTED                                                | `hooks.test.ts` › "hook wiring (settings.json)"; Codex projection asserted in `codex.test.ts`                                                                   |
| `SessionStart` (`inject-rules`)          | SUPPORTED   | SUPPORTED                                                | `hooks.test.ts` › "hook wiring (settings.json)"; `codex.test.ts`                                                                                                |
| `SessionStart` (`warn-subagent-routing`) | SUPPORTED   | not applicable (see above)                               | `subagent-routing.test.ts` › "runs the routing check at session start, beside the rules injector" and › "keeps both routing hooks out of the Codex projection…" |

## The 0.9 external-subsystem contract

Harness-neutral: this is a contract between the generated project's CLI and an
external subsystem (Memory), not between the CLI and a coding harness, so it
carries one row rather than one per harness.

| capability                                                                                                  | status    | test                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subsystems.json` declares one memory root, validated absolute/platform-shaped                              | SUPPORTED | `packages/cli/test/subsystems.test.ts` › "resolves exactly one manifest location per platform and refuses to guess when the root is unset" and › "refuses a relative memoryRoot"                                                      |
| `--version --json` handshake, classified into ok / manifest-stale / unsupported-absent / integration-failed | SUPPORTED | `packages/cli/test/subsystems.test.ts` › "classifies an ok handshake and reports version + contractVersion" through › "classifies an ENOENT spawn as unsupported/absent"                                                              |
| a foreign **major** contract version exits 4 (never silently downgraded)                                    | SUPPORTED | `packages/cli/test/subsystems.test.ts` › "classifies a foreign major contract version"                                                                                                                                                |
| `codemie doctor --json` / CLI handshake surface                                                             | SUPPORTED | `packages/cli/test/cli-version.test.ts` › "writes exactly one handshake JSON line to stdout and exits 0" and › "answers doctor --json with the absent-manifest payload and exit 0 when this machine has no manifest"                  |
| bounded pass-through (no path named in a classified result)                                                 | SUPPORTED | `packages/cli/test/subsystems.test.ts` › "never names a path in the classified result, for any handshake outcome"                                                                                                                     |
| schema subset stays dependency-free (no ajv)                                                                | SUPPORTED | `test/template/json-schema-subset.test.ts`; consumed by `scripts/memory-conformance.mjs` and pinned against the real contract fixtures in `test/template/conformance-contract.test.ts` and `test/template/memory-conformance.test.ts` |

`contracts/conformance/v1/` is this contract's own fixture set and is
deliberately **not delivered** to a generated project —
`conformance-contract.test.ts` › "is not delivered to rigs: no template
carries a conformance contract" is what keeps that true.

## What this replaces, and why the replaced thing was not a compatibility check

`packages/cli/src/policy/` (RP-36/RP-76: a declaration schema, a registry, a
decision-record format, a capability probe/coverage/evidence-matrix, and
per-harness adapters) and its benchmark
(`scripts/policy-benchmark*.mjs`, `contracts/session-messaging/`) modelled a
**future** runtime policy engine. Its own module header said so plainly:
"Library surface only — nothing here is reached by the CLI commands yet."
Nothing in `packages/cli/src/commands/`, `packages/cli/src/index.ts`, or any
installed hook or script ever imported it. The benchmark spawned the shipped
guards above as child processes and measured their exit codes against a
synthetic, versioned corpus — a real measurement, but of a **parallel**
invocation path a generated project never runs, not of the wiring in
`.claude/settings.json` / `.codex/hooks.json` a project actually uses. The
guard-by-guard rows above test the real wiring directly, which is both a
smaller surface and a truer one.

Removed with it: `RP-157` (a validator returning an uncertified record by
reference), `RP-160` (`quote()`'s two unescaped fallback paths) and `RP-161`
(an array hole skipped by `forEach`) were all findings against
`packages/cli/src/policy/core/{declaration,decision-record,validation}.ts` —
code with the same "nothing calls it yet" caveat stated in each ticket's own
body. They are closed by deletion, not by a fix, because the code they found
had no reachable caller; see the consumer graph below. `RP-82` (a citation
count in `generator-neutrality.test.ts` that nothing rereads) and `RP-110` (a
CI diagnostic that measured bare `node` startup and read "healthy" on the
run it existed to diagnose) are unrelated to the policy package but share the
same defect shape — a claim with no mechanism keeping it true — and are fixed
in this same change: the count is dropped from the comment, and the CI step is
removed outright, per each ticket's own accepted resolution.

## Consumer graph (packages/cli/src/policy/\*\*, the benchmark, and their neighbours)

Built by grepping every source, script, template and workflow file in this
repository for an import of each module before deleting anything. `keep` /
`delete` states the RP-178 decision; the reason is the evidence.

| module                                                                                                                              | importers found                                                                                                                                                                                       | decision                                                                                                                                       | reason                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/policy/index.ts` (barrel)                                                                                         | `packages/cli/test/policy-coverage.test.ts`, `packages/cli/test/policy-declaration.test.ts`, `test/template/policy-coverage.test.ts`, `test/template/policy-declaration.test.ts` — its own tests only | delete                                                                                                                                         | zero non-test importers; not exported from `packages/cli/src/index.ts`                                                                                                                                                                                                                                                          |
| `policy/core/{vocabulary,declaration,registry,decision-record,probe,coverage,evidence-matrix,validation}.ts`                        | as above, plus `evidence-matrix.ts` from `test/template/concurrent-sessions.test.ts` and `test/template/subagent-routing.test.ts`                                                                     | delete (evidence-matrix's one useful property carried forward as `test/helpers/evidence-row.ts`, a test-only fixture-shape check, not shipped) | no shipped entry point ever imports the barrel or any of these directly; the two template tests needed only a structural shape check over hand-authored rows, not the full declaration/registry machinery                                                                                                                       |
| `policy/harness/{claude,codex,shared-hooks,index}.ts`                                                                               | none found outside the barrel                                                                                                                                                                         | delete                                                                                                                                         | zero importers of any kind, including tests                                                                                                                                                                                                                                                                                     |
| `policy/benchmark/corpus.ts`                                                                                                        | `scripts/policy-benchmark-snapshot.mjs`, `test/template/policy-benchmark.test.ts`                                                                                                                     | delete                                                                                                                                         | both are the benchmark itself                                                                                                                                                                                                                                                                                                   |
| `scripts/policy-benchmark.mjs`, `-controller.mjs`, `-worker.mjs`, `-runtime.mjs`, `-schema.mjs`, `-snapshot.mjs`, `-exit-trace.mjs` | each other, and `test/template/policy-benchmark*.test.ts`                                                                                                                                             | delete                                                                                                                                         | self-contained benchmark harness; not invoked from `package.json` scripts, CI, or any install/generation path                                                                                                                                                                                                                   |
| `contracts/session-messaging/v1/**` (schema + fixtures)                                                                             | `policy/benchmark/corpus.ts`, `test/template/session-messaging-schema.test.ts`                                                                                                                        | delete                                                                                                                                         | Agent Bus / session-messaging scenarios named explicitly for removal by RP-178; sole consumer is the deleted benchmark                                                                                                                                                                                                          |
| `docs/policy-benchmark.md`                                                                                                          | referenced from `CHANGELOG.md`'s already-published 0.9.0-line entry (historical, left as-is) and a doc-comment in `test/helpers/env.ts` (updated)                                                     | delete                                                                                                                                         | describes a mechanism no longer in the package; the 0.9.0 evidence stays in git history, per this repository's own convention                                                                                                                                                                                                   |
| `docs/session-messaging-contract-v0.md`, `test/template/session-messaging-contract.test.ts`                                         | each other; one analogy citation in `docs/command-contract.md` (fixed)                                                                                                                                | delete                                                                                                                                         | lead decision (review round 1): Agent Bus / session-messaging is outside the accepted 0.10.0 product boundary and the implementation it described is already deleted; the test asserted substrings of the doc's own Markdown, executing nothing, and leaving either live read as pending work — the design stays in git history |
| `guardProcessesMeasurable` (`test/helpers/env.ts`) and its tests in `test-env-helpers.test.ts`                                      | only its own tests; `guard-acceptance.test.ts` was never wired to it (it uses `posixShellAvailable`, a real caller)                                                                                   | delete                                                                                                                                         | unreferenced hosted-Windows benchmark residue once the benchmark's guard-spawning cases were gone; its comment also claimed `guard-acceptance.test.ts` called it, which was false                                                                                                                                               |
| `scripts/lib/json-schema-subset.mjs`                                                                                                | `scripts/memory-conformance.mjs`, `test/template/json-schema-subset.test.ts`, `test/template/conformance-contract.test.ts`, `test/template/memory-conformance.test.ts`                                | **keep**                                                                                                                                       | real, non-test caller: the shipped 0.9 external-subsystem contract validator                                                                                                                                                                                                                                                    |
| `scripts/memory-conformance.mjs`                                                                                                    | `package.json` (referenced by the conformance test fixtures), the contract test files above                                                                                                           | **keep**                                                                                                                                       | published 0.9 external-subsystem contract; must stay working per this ticket's own instruction                                                                                                                                                                                                                                  |
| `scripts/subagent-routing.mjs`                                                                                                      | `scripts/sync-codex-adapter.mjs`, `test/template/subagent-routing.test.ts`                                                                                                                            | **keep**                                                                                                                                       | real script: the one subagent-routing policy both harnesses derive from, invoked by the sync a generated project's build depends on                                                                                                                                                                                             |
| `packages/cli/src/lib/subsystems.ts`, `commands/memory.ts`, `commands/setup.ts`                                                     | shipped CLI commands, `packages/cli/test/subsystems.test.ts`, `packages/cli/test/cli-version.test.ts`                                                                                                 | **keep**                                                                                                                                       | the published 0.9 external-subsystem contract's CLI half                                                                                                                                                                                                                                                                        |

No module under `packages/cli/src/policy/**` survives; every module listed
`keep` above is outside that tree.

## Amendment note (not redesigning upgrade)

RP-178 was asked to check whether the manifest's ownership hashing operates on
raw bytes (required for a genuine `line-endings-only` verdict to stay distinct
from `pristine`) or on decoded text. **Finding, reported rather than fixed
here because `packages/cli/src/commands/upgrade.ts` and
`packages/cli/src/lib/manifest.ts` are RP-177's concurrent scope:**
`sha256()` (`packages/cli/src/lib/manifest.ts:48`) hashes whatever it is
handed, but every call site that hashes a file's on-disk content reads it with
`readFile(path, 'utf8')` first (`packages/cli/src/commands/create.ts:130`,
`packages/cli/src/commands/init.ts:216`) — a **decoded string**, not the raw
byte buffer. For a file that round-trips cleanly through UTF-8 (no BOM, no
invalid byte sequences) this happens to hash the same bytes it would raw,
which is almost every tracked file today; it stops being equivalent the
moment a file carries a BOM or a byte sequence that is not valid UTF-8, where
decode-then-rehash silently normalizes what "pristine" is checked against. Not
fixed in this change — it is out of RP-178's scope and inside RP-177's
concurrent edits to the same commands — but recorded here as the evidence the
lead asked for.
