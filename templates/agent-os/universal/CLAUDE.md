@AGENTS.md

## Claude Code

This file is a compatibility shim, not a second copy of the rulebook.
`AGENTS.md` next to it is the single canonical source — see
`docs/decisions/agents-md-canonical.md` — and the `@AGENTS.md` line above is
Claude Code's own import syntax: it pulls the full rulebook into context
exactly as if it were written here.

The shim exists because Claude Code's native `AGENTS.md` reading is not
always active — it depends on the Claude Code version and configuration in
use — so this file guarantees the rulebook loads either way. It is **not**
a claim that Claude Code always reads `AGENTS.md` on its own.

Add Claude-Code-only instructions below this line — provider-specific
wiring stays in `.claude/settings.json`, `.claude/agents/` and the other
provider-specific files the rulebook already names. Do not restate
rulebook content here, and do not remove the import above.
