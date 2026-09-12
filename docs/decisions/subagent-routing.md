# Subagent routing: every gate pins its model and effort

Status: accepted for RP-173 (Claude Code). The Codex half, RP-166, is recorded in
`codex-adapter.md`; both harnesses are generated from one role table.

## Decision

Each named subagent this rig ships pins the model and the effort it reads with:

| Role | Claude Code | Codex |
| --- | --- | --- |
| `code-reviewer`, `security-scanner`, a stack's infrastructure reviewer | `claude-opus-5`, `high` | `gpt-5.6-sol`, `high` |
| `test-writer`, `prose-reviewer` | `claude-sonnet-5`, `high` | `gpt-5.6-terra`, `high` |
| a subagent with no definition | `claude-sonnet-5`; effort follows the session | `gpt-5.6-terra`, `medium` |

In this project the pins are the files themselves: `model:` and `effort:` in
`.claude/agents/<role>.md`, `model` and `model_reasoning_effort` in
`.codex/agents/<role>.toml`, `env.CLAUDE_CODE_SUBAGENT_MODEL` in
`.claude/settings.json`, and the `[agents]` defaults in `.codex/config.toml`.

The driver session's own model and effort are not pinned. They belong to whoever
starts the session.

## Why

A gate that inherits the driver's model returns a verdict whose meaning changes
whenever the driver does. Pinning makes the reader behind a SHIP a property of the
rulebook rather than of how a session happened to be launched.

- **Full model IDs, not aliases.** An alias moves when a new model ships, and every
  verdict would change meaning without a diff. Moving a role to another model is a
  policy change.
- **The larger model reads correctness, security and infrastructure; the smaller one
  does bounded, frequent work** — the same split as the Codex tiers.
- **`high` for every gate, and escalation is a policy change.** The `Agent` tool of
  Claude Code 2.1.269 takes a `model` and no effort, so there is no per-call way to
  raise a gate's effort, and none is invented here.

## How Claude Code resolves a pin, and what voids one

From Claude Code's changelog and documentation:

- A subagent's model comes from the per-dispatch `model` first, then the
  definition's `model:`, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the parent session.
  That order holds from **2.1.251**; before it the environment variable overrode
  definitions, which would put every gate on the unnamed default. 2.1.251 is
  therefore the minimum version.
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` (added in 2.1.257) applies one model to every
  subagent and ignores each definition's `model:`.

Measured on Claude Code 2.1.269, with each subagent's own transcript as the record
of what ran (the rows are the generator's `docs/capability-evidence.json`, absent in
a generated rig):

- a definition's model and `effort: high` held under a driver on another model at
  `medium`;
- with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, `code-reviewer` ran on `claude-sonnet-5`
  — its effort pin still held;
- with `CLAUDE_CODE_EFFORT_LEVEL=low`, `code-reviewer` ran at `low` — its model pin
  still held;
- a subagent with no definition ran on `claude-sonnet-5` at the session's effort;
- a per-dispatch `model` replaced a definition's `model:`.

Two mechanisms follow, both in `.claude/hooks/`. `guard-subagent-model` refuses a
per-dispatch `model` for an agent whose definition pins one. `warn-subagent-routing`
warns at session start when either variable is set, or when the Claude Code version
is older than 2.1.251 or cannot be read; it never blocks, because the variables are
the operator's to set, and the warning makes their cost visible instead of taking
the decision. Pinned in `subagent-routing-hooks.test.ts` (absent in a generated rig)
› "blocks a call-site model on a project agent that pins one, and says to re-dispatch without it"
and › "warns when %s is set, and never blocks the session".

Neither hook is wired for Codex, which has no dispatch hook and no Claude
environment: `subagent-routing.test.ts` (absent in a generated rig) ›
"keeps both routing hooks out of the Codex projection, which has no Agent tool and no Claude environment".

## What this does not do

- **The effort of a subagent with no definition is not pinned.** No setting or
  variable sets it; it runs at the session's effort. That is recorded as
  unsupported, not worked around.
- **A definition says what was asked for; only the transcript says what ran.** A
  verdict does not yet carry the model and effort it was produced on.
- **The built-in agents get no definitions here.** A general-purpose subagent follows
  the unnamed default like any subagent without a definition.
- **The warning is a warning.** A session started with `CLAUDE_CODE_EFFORT_LEVEL` set
  still runs every gate — at that effort.

## Changing a role in this project

This project carries no role table and no routing check: its agent definitions are
its policy. To move a role, edit `model:` / `effort:` in `.claude/agents/<role>.md`
and the matching `.codex/agents/<role>.toml` in one reviewed change; both trees are
elevated paths. `upgrade` then reports the edited agent file as yours and leaves it
alone, while an agent file nobody edited is replaced by the release's pinned one —
`subagent-routing-install.test.ts` (absent in a generated rig) ›
"replaces an untouched pre-pin agent with the pinned one" and ›
"reports a pre-pin agent the user edited as a conflict and leaves its bytes alone".

## In the generator

`templates/agent-os/subagent-routing.json` is the one table.
`scripts/sync-codex-adapter.mjs --check` loads it through `scripts/subagent-routing.mjs`,
derives the Codex profiles from it, and refuses a Claude agent without `model` or
`effort`, a value that differs from its role, a role without an agent or an agent
without a role, an effort the pinned model does not support, and shipped settings
that miss the unnamed default or set either voiding variable —
`subagent-routing.test.ts` (absent in a generated rig) › "refuses a routing policy with %s"
and › "refuses a Claude agent template whose model disagrees with the routing policy".

## Risk and rollback

A pinned model can be unavailable to an account. The recovery is changing the
table — in this project, the definitions — never a per-call override. Rollback in a
project is deleting the `model:` / `effort:` lines, the `env` entry, and the two
hooks with their wiring; every gate then inherits the session again.
