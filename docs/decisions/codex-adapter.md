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

Hook launch also depends on `git rev-parse --show-toplevel`. If Git is absent or
the session is outside a worktree, the generated command exits before the hook
runs and therefore cannot return the blocking exit code. This is a known
fail-open boundary of the portable root lookup visible in `.codex/hooks.json`.

## Schema and executable contracts

The emitted agent fields are `name`, `description`, `sandbox_mode`, and
`developer_instructions`, matching the documented Codex custom-agent TOML.
For hooks, the [official Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
documents `tool_input.command` for both `Bash` and `apply_patch` and requires a
string `command` when a hook replaces that input. The guards therefore accept
that documented string form and fail open on unsupported command shapes.
Hook output is the JSON `description` plus event arrays accepted by
`.codex/hooks.json`; command portability is carried by generated POSIX and
Windows commands. In this generated project, `.claude/settings.json` and
`.codex/hooks.json` are the two concrete hook-wiring snapshots to review.

`apply_patch` inspection also has aggregate, per-patch work bounds. In
particular, `MAX_PATCH_PATH_COMPONENTS` counts destination path components
across the whole patch, so the file capacity of one patch decreases as path
depth increases. When that bound is reached, split the edit into multiple
smaller patches.
