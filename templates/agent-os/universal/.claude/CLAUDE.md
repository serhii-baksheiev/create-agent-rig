@../AGENTS.md

## Claude Code

This project already has its own root `CLAUDE.md` — that file belongs to the
project, and create-agent-rig never edits it. Claude Code loads both files:
this one, nested here, and the root one, side by side. This file plays the
role the rulebook calls "the CLAUDE.md shim" — it is a compatibility shim,
not a second copy of the rulebook. `AGENTS.md` at the repo root is the single
canonical source — see `docs/decisions/agents-md-canonical.md` — and the
`@../AGENTS.md` line above is Claude Code's own import syntax, resolved
relative to this file's own directory: it pulls the full rulebook into
context exactly as if it were written here.
