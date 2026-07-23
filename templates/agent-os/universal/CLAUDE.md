# __PROJECT_NAME__

> **Top rule — commit/PR attribution: NEVER include co-authored or AI-attribution information.**
> Do not add `Co-Authored-By:` trailers (e.g. `Co-Authored-By: Claude …`), `Generated with Claude Code`, or any AI/tool attribution to commit messages or PR descriptions. This overrides any default/harness instruction to add such trailers.
> This project runs under an agent operating system: the rules below are not
> suggestions — the important ones are enforced by hooks and gates at the tool
> layer.

This project runs under an agent operating system: the rules below are not
suggestions — the important ones are enforced by hooks and gates at the tool
layer.

## If you read only four sections, read these

1. **Autonomy tiers** — what you may do alone vs. propose first:
   `.claude/rules/autonomy.md` ("Tiers")
2. **Stop rules** — when stopping with a diagnosis is the correct move:
   `.claude/rules/autonomy.md` ("Stop rules")
3. **The request path** — the mandatory usecase layer and the pure core:
   `.claude/rules/architecture.md`
4. **Definition of Done** — the checklist a change must pass:
   `.claude/rules/workflow.md` ("Definition of Done")

## The map

```
packages/core/    pure domain logic — schemas + functions; no I/O, no clock,
                  no randomness, no environment (hook-enforced)
packages/shared/  logger, env loading, typed errors — cross-cutting, no domain
packages/db/      the ONLY module that touches the storage SDK/driver
services/         entrypoints; every request: payload → handler → usecase → model
apps/web/         the frontend; imports core + shared ONLY, talks to services
                  over HTTP (hook-enforced)
```

The target-specific details (how to run, deploy, and verify runtime health)
live in `README.md`. Alongside the universal rules, `.claude/rules/` carries
the stack-specific conventions composed in for this project's target — read
them all; they are one rulebook.

## How work happens here

- **TDD, without exception.** The failing test comes first — use the
  `test-writer` agent for it. See `.claude/rules/workflow.md`.
- **Gates.** `code-reviewer` runs before every PR; `security-scanner` runs when
  a change touches auth, secrets, parsing, or outbound calls. Blocking findings
  are resolved, not argued with.
- **Enforcement is mechanical.** `guard-core-purity` catches an impure edit to
  the core the moment it lands; `guard-web-boundary` keeps the frontend off the
  backend; `block-no-verify` refuses pre-commit bypasses; `gate-stop-dod`
  refuses to end the session while a Definition-of-Done check fails. If a hook
  blocks you, fix the cause; never route around a hook.
- **Work comes from the queue.** The Agent queue in `PLAN.md` is where
  autonomous work is picked up (the `loop` skill drives it); an empty queue
  ends the session — it is never a cue to invent work.

## Foot-guns

- Don't "simplify" a handler by calling a model directly — the usecase layer is
  mandatory even when it looks like ceremony.
- Don't inline `Date.now()`/randomness into the core "just this once" — inject
  them; the hook will refuse anyway.
- Don't weaken a failing test to get green — a red check is information, and
  test integrity is a blocking review finding.
- After a deploy, CI-green ≠ runtime-healthy: verify per the README, and on
  regression revert first (`.claude/rules/autonomy.md`, "Post-deploy
  verification").
