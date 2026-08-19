# Codex adapter: derived parity

Status: accepted for AR-113.

## Decision

Claude-shaped files remain the authoring surface. The generator derives the
Codex rulebook (`AGENTS.md`), skills (`.agents/`), custom agents and hook
wiring (`.codex/`); the generated files are checked for drift in the generator
repository and are materialised into a
generated project as its local, versioned operating system. A generated
project does not ship the generator's projector. Its Claude and Codex files are
versioned snapshots: a downstream project that deliberately changes one side
must either make the equivalent local change on the other side or take a newer
generated release. There is no downstream automatic drift check.

## Why

Two hand-maintained rulebooks inevitably diverge. Derivation keeps the generated
snapshots aligned while preserving native Codex formats. The adapter translates
the fields for which Codex has native controls and does not invent policy.

Claude agent `tools` allowlists have no equivalent custom-agent allowlist in the
documented Codex TOML schema. The adapter therefore uses those fields only to
choose `read-only` or `workspace-write` sandboxing; the exact Claude tool list is
not carried over. This is a known parity limit, not an implicit restriction.

## Risk and rollback

The main risks are generated-file drift, downstream edits to only one snapshot,
and unsupported Claude shapes. In the generator, the adapter fails loudly when
it cannot derive a portable hook command and its drift check catches stale
output. Generated projects rely on review for subsequent local parity. Rollback
is deleting the derived Codex files from the generated project and reverting the
generator change; Claude files remain usable.

Hook launch also depends on `git rev-parse --show-toplevel`, and that lookup has
two failure modes rather than one. Both are visible in `.codex/hooks.json`.

The mild one: if Git is absent or the session is outside a worktree, the
generated command exits before the hook runs and therefore cannot return the
blocking exit code — a fail-open boundary.

🔴 The sharp one, stated because a reader who only saw the first would infer
cover that is not there: **the root is resolved from the session's working
directory, which the agent controls, so the hook that runs is whichever file
sits at that path.** An agent that creates a repository of its own and works
from inside it supplies its own `.claude/hooks/*.mjs`. Measured on this branch:
the emitted `guard-bash` command exits 2 on a force-push payload from the real
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
resolves a root with no `.claude/hooks` in it, and the emitted command exits 1.
Measured: exit 2 from the rig root, **exit 1 from a nested repository**, exit 1
outside a worktree. Exit 1 is not the blocking code, so the hook layer is simply
gone, silently, for ordinary reasons.

So state it plainly: under Codex the hook layer holds when the session works from
the rig's own root and is absent otherwise, which is one layer less than under
Claude Code, where the harness sets the root. The layers behind it — review, the
test suite, CI — are unchanged, and they are what this rig relies on for the
Codex path.

## Schema and executable contracts

The emitted agent fields are `name`, `description`, `sandbox_mode`, and
`developer_instructions`, matching the documented Codex custom-agent TOML.
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
and can report rather than an error it threw. See `codex.test.ts` › "refuses,
rather than failing open, when apply_patch command is supplied as %s".
Hook output is the JSON `description` plus event arrays accepted by
`.codex/hooks.json`; command portability is carried by generated POSIX and
Windows commands. In this generated project, `.claude/settings.json` and
`.codex/hooks.json` are the two concrete hook-wiring snapshots to review.

`apply_patch` inspection also has aggregate, per-patch work bounds. In
particular, `MAX_PATCH_PATH_COMPONENTS` counts destination path components
across the whole patch, so the file capacity of one patch decreases as path
depth increases. When that bound is reached, split the edit into multiple
smaller patches.
