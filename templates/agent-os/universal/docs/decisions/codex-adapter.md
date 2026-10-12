# Codex adapter: derived parity

Status: accepted for AR-113; subagent routing extended for RP-166.

## Decision

Claude-shaped files remain the authoring surface for skills, custom agents and
hook wiring. The generator derives the Codex skills (`.agents/`), custom
agents and hook wiring (`.codex/`) from them; the generated files are checked
for drift in the generator repository and are materialised into a generated
project as its local, versioned operating system. The rulebook itself is the
one exception, since RP-186: `AGENTS.md` is the canonical, authored,
provider-neutral source — not derived from `CLAUDE.md` — and `CLAUDE.md` is a
short, separately authored compatibility shim (`@AGENTS.md` import plus
Claude-Code-specific notes; see `docs/decisions/agents-md-canonical.md`). A
generated project does not ship the generator's projector for the derived
files. Its Claude and Codex files are versioned snapshots: a downstream
project that deliberately changes one side must either make the equivalent
local change on the other side or take a newer generated release. There is no
downstream automatic drift check.

## Why

Two hand-maintained rulebooks inevitably diverge. Derivation keeps the generated
snapshots aligned while preserving native Codex formats. The adapter translates
the fields for which Codex has native controls. Subagent routing — each role's
model and effort, for both harnesses — is declared once in the generator's
`templates/agent-os/subagent-routing.json` (rationale:
`docs/decisions/subagent-routing.md`). The Codex profiles are derived from that
table, and the projector refuses a missing or orphaned agent profile. It also
refuses duplicate source-agent names across layers, since one profile name
cannot route two definitions.

Frequent bounded work (`test-writer`, `implementation-agent`, `prose-reviewer`) uses `gpt-5.6-terra`;
correctness, security, and infrastructure gates use `gpt-6-sol`. Every named
gate uses `high` reasoning effort. Unnamed subagents inherit repository defaults
of `gpt-5.6-terra` and `medium` from `.codex/config.toml`. `xhigh` is not a
continuous-loop default; using it for a named role requires an intentional
profile-policy change (or a separate escalation profile), because named-profile
fields take precedence over spawn and repository defaults. Concurrency remains
a machine/session decision rather than repository policy.

Claude agent `tools` allowlists have no equivalent custom-agent allowlist in the
documented Codex TOML schema. The adapter therefore uses those fields only to
choose `read-only` or `workspace-write` sandboxing; the exact Claude tool list is
not carried over. This is a known parity limit, not an implicit restriction.

## Risk and rollback

The main risks are generated-file drift, downstream edits to only one snapshot,
unsupported Claude shapes, and a pinned model being unavailable in a user's
workspace. In the generator, recovery is to update the central routing table to
an available model or use a separate supported escalation profile — the Codex
profiles are regenerated from it, while the Claude agent definitions are checked
against it and are edited to match in the same change. A generated
project has no copy of that table: there, recovery is editing the role's
definitions on both harnesses in one reviewed change, and `upgrade` then reports
those files as the project's own instead of replacing them
(`docs/decisions/subagent-routing.md`). In the generator, the adapter fails loudly when
it cannot derive a portable hook command and its drift check catches stale
output. Generated projects rely on review for subsequent local parity. Rollback
is deleting the derived Codex files from the generated project and reverting the
generator change; Claude files remain usable.

Hook launch also depends on `git rev-parse --show-toplevel`, and that lookup has
three failure modes rather than one. All three are visible in `.codex/hooks.json`.

The slow one: the POSIX `command` puts no bound of its own on that lookup, so
a `git rev-parse` that stalls — an `include.path` naming a FIFO is enough —
keeps the hook waiting until the `timeout` the same entry declares expires;
the Windows wrapper below turns a stalled stage into a block instead. Pinned
in the generator's `test/template/codex.test.ts` (absent in a generated rig) ›
"the POSIX Codex command puts no bound of its own on the root lookup: a
stalled git rev-parse keeps the hook waiting".

The mild one applies to the POSIX command: if Git is absent or the session is
outside a worktree, it exits before the hook runs and cannot return the blocking
exit code — a fail-open boundary. The bounded Windows guard wrappers refuse a
failed root lookup or a missing hook through the structured denial described
below.

🔴 The sharp one, stated because a reader who only saw the first would infer
cover that is not there: **the root is resolved from the session's working
directory, which the agent controls, so the hook that runs is whichever file
sits at that path.** An agent that creates a repository of its own and works
from inside it supplies its own `.claude/hooks/*.mjs`. Measured with the POSIX
command: the emitted `guard-bash` command exits 2 on a force-push payload from the real
repository root, and exits 0 from an agent-created repository holding a no-op
hook of the same name. That is guard *substitution*, not merely fail-open.

It is documented rather than fixed, deliberately, and the reasoning is worth
keeping because the obvious alternatives are worse. Codex provides no
project-root variable for repo-local hooks — the equivalent of Claude Code's
`$CLAUDE_PROJECT_DIR` does not exist, and the [official hooks
documentation](https://learn.chatgpt.com/docs/hooks) *recommends* resolving from
the Git root for exactly this case, with commands run in the session `cwd`. So
this adapter follows the documented pattern rather than inventing one. Pinning an
absolute path at install time would diverge from that pattern and break a rig
that is moved, copied or checked out as a worktree, and it would buy protection
only against an agent that deliberately builds a decoy repository — the
"determined evasion" `.claude/rules/invariants.md` puts outside every guard's
threat model: *the guard targets drift, not an adversary.*

What this costs is worth naming, and the first draft of this paragraph understated
it. "Drift-resistant, not adversary-resistant" is wrong: **no adversary is
required.** A session whose cwd sits inside any repository that is not this one —
a vendored dependency with its own `.git`, a fixture repo, a scratch `git init` —
resolves a root with no `.claude/hooks` in it, and the POSIX command exits 1.
Measured with that command: exit 2 from the rig root, **exit 1 from a nested repository**, exit 1
outside a worktree. Exit 1 is not the blocking code, so the hook layer is simply
gone, silently, for ordinary reasons.

Under Codex the POSIX hook layer holds when the session works from the rig's
own root and is absent otherwise. The bounded Windows guard wrappers refuse a
missing hook, but resolving a different repository with its own hook still
permits substitution. Claude Code sets the project root. Review, the test suite
and CI remain the layers behind these documented boundaries.

## Schema and executable contracts

The emitted agent fields are `name`, `description`, `model`,
`model_reasoning_effort`, `sandbox_mode`, and `developer_instructions`, matching
the documented Codex custom-agent TOML. Named-agent fields take precedence over
the repository defaults in `.codex/config.toml`; the defaults cover only agents
without their own model or effort assignment.
For hooks, the [official Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
documents `tool_input.command` for both `Bash` and `apply_patch` and requires a
string `command` when a hook replaces that input. The same document is what makes
the `Bash`-only tool-name gate in `guard-bash` and `block-no-verify` correct
rather than narrow: Codex's canonical matcher name for its shell/exec tool **is**
`Bash`, and its editing tool is `apply_patch`, which also matches the `Edit` and
`Write` aliases. Recorded here because it is an external fact no test in this
repository can pin, and a reader who assumes otherwise will widen those gates to
names the platform never sends. The guards therefore accept
that documented string form. A command that is ABSENT still fails open — a
payload the hook does not understand — while one that is present and is not a
shape the normalizer reads is REFUSED, because that is a condition it detects
and can report rather than an error it threw. See the generator's
`codex.test.ts` (absent in a generated rig) › "refuses, rather than failing
open, when apply_patch command is supplied as %s".
Hook output is the JSON `description` plus event arrays accepted by
`.codex/hooks.json`; command portability is carried by generated POSIX and
Windows commands. In this generated project, `.claude/settings.json` and
`.codex/hooks.json` are the two concrete hook-wiring snapshots to review.

`apply_patch` inspection also has aggregate, per-patch work bounds. In
particular, `MAX_PATCH_PATH_COMPONENTS` counts destination path components
across the whole patch, so the file capacity of one patch decreases as path
depth increases. When that bound is reached, split the edit into multiple
smaller patches.

## Windows wrapper stage bounds (RP-266)

On Windows, the four guard hooks that gate an edit or a shell command
(`guard-secret-file`, `guard-rulebook`, `block-no-verify`, `guard-bash`) run
inside a generated wrapper that bounds every stage of its own work —
resolving the repository root, copying stdin to the guard, and waiting on the
guard itself. Once any one stage's bound is crossed, the wrapper kills that
stage's whole process tree and emits a structured PreToolUse denial, naming the
stage that expired in its stderr message, unconditionally — never silently falling
through to a harness default that would treat the hang as an allow (see
generator's `test/template/codex.test.ts` (absent in a generated rig) ›
"bounds every Windows wrapper stage for %s, kills the process tree on expiry,
and names the timed-out stage (RP-266)" and › "wraps every kill in %s's
wrapper so it cannot throw, and reports the timeout unconditionally once a
bound expired (RP-266 follow-up)"). `$env:RIG_CODEX_WRAPPER_TIMEOUT_MS` is a
test-only override: it can only LOWER a stage's own bound, selected through
`[Math]::Min(...)` against that stage's named default, and a malformed or
absent value leaves every stage at its real production default rather than
raising one or throwing (see generator's `test/template/codex.test.ts`
(absent in a generated rig) › "lets a test-only RIG_CODEX_WRAPPER_TIMEOUT_MS
override lower %s's per-stage bounds through Math.Min alone, and never raise
them (RP-266 follow-up)").

The Windows projection translates a guard's blocking exit 2 into stdout JSON
`hookSpecificOutput` with `hookEventName: "PreToolUse"` and
`permissionDecision: "deny"`, then exits 0. The reason identifies the Rig
refusal; the guard's detailed diagnostic remains on stderr. This translation
also covers wrapper failures and expired stage bounds. An outer PowerShell
`-Command` can turn a nested process's exit 2 into exit 1, which Codex treats as
a failed hook without a denial. Explicit JSON with exit 0 preserves refusal
through that launch chain (RP-498). Direct guard invocation and Claude Code
retain their exit-2 contract; lifecycle hooks are unchanged. The generator's
`test/template/codex-refusal-contract.test.ts` (absent in a generated rig) ›
"returns exit 0 plus a structured deny for guards and bounded wrapper failures, while safe controls and lifecycle hooks retain their contracts"
exercises the outer PowerShell launch, safe controls and these failure paths;
the same file › "runs SessionStart and an inert Stop hook through the outer PowerShell host"
pins the lifecycle controls. Hook activation still requires
normal Codex trust; deterministic wrapper tests do not prove live activation.
