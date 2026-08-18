# Codex adapter: derived parity

Status: accepted for AR-113.

## Decision

Claude-shaped files remain the authoring surface. The generator derives the
Codex rulebook (`AGENTS.md`), skills (`.agents/`), custom agents and hook
wiring (`.codex/`) with `scripts/sync-codex-adapter.mjs`; the generated files
are checked for drift in the generator repository and are materialised into a
generated project as its local, versioned operating system. A generated
project does not need to ship the generator's projector: changing its Claude
files is an explicit local change and must update the corresponding Codex
files in the same commit.

## Why

Two hand-maintained rulebooks inevitably diverge. Derivation keeps the two
harnesses equivalent while preserving native Codex formats. The adapter only
translates the documented frontmatter fields and hook commands; it does not
invent policy.

## Risk and rollback

The main risk is generated-file drift or an unsupported Claude hook shape. The
adapter fails loudly when it cannot derive a portable command, and the
generator's adapter drift test catches stale output. Rollback is deleting the
derived Codex files from the generated project and reverting the generator
change; Claude files remain usable.

## Schema and executable contracts

The emitted agent fields are `name`, `description`, `sandbox_mode`, and
`developer_instructions`, matching the Codex agent TOML consumed by this
repository. Hook output is the JSON `description` plus event arrays accepted by
`.codex/hooks.json`; command portability is enforced by the generated POSIX
and Windows commands. The source formats and generated paths are pinned by
`scripts/sync-codex-adapter.mjs` and `test/template/codex.test.ts`.
