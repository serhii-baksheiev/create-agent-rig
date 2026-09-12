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
- **`high` for every gate, and escalation is a policy change.** A dispatch has no way
  to set a subagent's effort — the `per-dispatch-effort` row below — so raising a
  gate's effort is an edit to its definition, and nothing here invents a per-call knob.

## How Claude Code resolves a pin, and what voids one

Claude Code's changelog states two of the rules:

- A subagent's model comes from the per-dispatch `model` first, then the
  definition's `model:`, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the parent session —
  and that order holds from **2.1.251**. Before it the environment variable overrode
  definitions, so the unnamed default this rig sets would replace every gate's pin.
  That is why 2.1.251 is the minimum version the session-start check enforces; it is
  the release that makes the MODEL pins outrank the shipped default, and nothing more
  is claimed for it — the `effort:` field and the `Agent` tool name the guard matches
  were observed working on 2.1.269 and 2.1.270 only.
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, added in 2.1.257, applies one model to every
  subagent and ignores each definition's `model:`.

The rest is measured. Each row is a live run whose subagent transcript was read
by a script, never the subagent's own report; the rows are the generator's
`docs/capability-evidence.json` (absent in a generated rig), keyed by `mechanism`
and `surface`:

- `subagent-model-pin` and `subagent-effort-pin` hold under a driver on another model
  and effort (surface `.claude/agents/test-writer.md`);
- `subagent-model-pin` does not hold with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, and
  `subagent-effort-pin` does not hold with `CLAUDE_CODE_EFFORT_LEVEL=low` — each
  variable replaced only the pin it names;
- `subagent-model-pin` does not hold against a call-site `model` when no guard
  refuses the dispatch;
- `unnamed-subagent-model` holds and `unnamed-subagent-effort` is unsupported: a
  subagent with no definition ran on the shipped default at the session's effort.

Two mechanisms follow, both in `.claude/hooks/`. `guard-subagent-model` refuses a
per-dispatch `model` for an agent whose definition pins one (`call-site-model-guard`).
`warn-subagent-routing` warns at session start when either variable is set, when
Claude Code is older than 2.1.251, or when its version cannot be read from `AI_AGENT`
(`claude-code-version-signal`); it never blocks, because the variables are the
operator's to set and the warning makes their cost visible instead of taking the
decision. Pinned in `subagent-routing-hooks.test.ts` (absent in a generated rig)
› "blocks a call-site model on a project agent that pins one, and says to re-dispatch without it"
and › "warns when %s is set, and never blocks the session".

Neither hook is wired for Codex, which has no dispatch hook and no Claude
environment: `subagent-routing.test.ts` (absent in a generated rig) ›
"keeps both routing hooks out of the Codex projection, which has no Agent tool and no Claude environment".

## What this does not do

- **The effort of a subagent with no definition is not pinned.** It runs at the
  session's effort (`unnamed-subagent-effort`). That is recorded as unsupported, not
  worked around.
- **A definition says what was asked for; only the transcript says what ran.** A
  verdict does not yet carry the model and effort it was produced on.
- **The guard's notion of a role is "a project agent whose definition pins a model".**
  In a generated project the definitions are the policy (next section), so an agent
  a project adds with a pin is a role, and a role whose definition is changed to
  `model: inherit` has stopped being one — by that project's reviewed decision.
- **The built-in agents get no definitions here.** A general-purpose subagent follows
  the unnamed default like any subagent without a definition.
- **The warning is a warning.** A session started with `CLAUDE_CODE_EFFORT_LEVEL` set
  still runs every gate — at that level.

## Changing a role in this project

The item this record implements asked that a project lower a default by editing
"its policy", with "the test following". Here that is realised as follows, and the
difference from a literal reading is deliberate:

- **The agent definitions are this project's policy.** It receives no copy of the
  generator's role table and no routing check: a second copy beside the definitions,
  with no projector here to keep the two aligned, is the drift `rules/invariants.md`
  forbids ("one mechanism, one implementation"), and the Codex half already shipped
  that way.
- **To move a role**, edit `model:` / `effort:` in `.claude/agents/<role>.md` and the
  matching `.codex/agents/<role>.toml` in one reviewed change; both trees are
  elevated paths.
- **The test that follows the table lives in the generator**, where the expected
  values are read from the table rather than restated.
- **`upgrade` reports the edited agent file as yours and leaves it alone**, while an
  agent file nobody edited is replaced by the release's pinned one —
  `subagent-routing-install.test.ts` (absent in a generated rig) ›
  "replaces an untouched pre-pin agent with the pinned one" and ›
  "reports a pre-pin agent the user edited as a conflict and leaves its bytes alone".

## In the generator

`templates/agent-os/subagent-routing.json` is the one table.
`scripts/sync-codex-adapter.mjs --check` loads it through `scripts/subagent-routing.mjs`,
derives the Codex profiles from it, and refuses a Claude agent without `model` or
`effort`, a value that differs from its role, a role without an agent or an agent
without a role, an effort the pinned model does not support, an unknown field in
either harness's mapping, and shipped settings that miss the unnamed default or set
either voiding variable —
`subagent-routing.test.ts` (absent in a generated rig) › "refuses a routing policy with %s"
and › "refuses a Claude agent template whose model disagrees with the routing policy".

## Risk and rollback

A pinned model can be unavailable to an account. In the generator the recovery is
changing the table; in a project it is changing the definitions as above — never a
per-call override. Rollback in a project is deleting the `model:` / `effort:` lines,
the `env` entry, and the two hooks with their wiring; every gate then inherits the
session again.
