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
- **One task, one branch — and merge via PR.** Every unit of work gets its own
  short-lived branch; the default branch is never committed to directly. Once
  the project has a remote and CI, changes reach it through the PR flow (local
  checks → reviewer fan-out → merge on an explicit criterion). See
  `.claude/rules/workflow.md` ("Branches and commits", "PR flow"). When another
  session may touch this repo at the same time, the branch lives in its own
  worktree — the `worktree-task` skill has the lifecycle and the cleanup.
- **Gates.** `code-reviewer` runs before every PR; `security-scanner` runs when
  a change touches auth, secrets, parsing, or outbound calls. Blocking findings
  are resolved, not argued with. The `pr-ship` skill drives the gate.
- **Enforcement is mechanical.** `guard-core-purity` catches an impure edit to
  the core the moment it lands; `guard-web-boundary` keeps the frontend off the
  backend; `block-no-verify` refuses pre-commit bypasses; `guard-bash` refuses
  the "Never" tier — force-pushing a shared branch, a production deploy, a
  filesystem wipe — and carries the kill switch; `gate-stop-dod` refuses to end
  the session while a Definition-of-Done check fails. If a hook blocks you, fix
  the cause; never route around a hook.
- **There is a brake, and it is a real file.** `touch
  ~/.claude/__PROJECT_NAME__-loop-STOP` and `guard-bash` denies every merge
  until it is removed. Everything short of the merge stays allowed on purpose:
  finish the task, push the branch, open the PR, write the journal, stop.
  Stopping cleanly never means losing the work.
- **Work comes from the queue.** The Agent queue in `PLAN.md` is where
  autonomous work is picked up (the `loop` skill drives it); an empty queue
  ends the session — it is never a cue to invent work.

## The elevated paths of this project

Tier 2 in `.claude/rules/autonomy.md` names *kinds* of change. This block names
the **paths** in this repository where those kinds live. It is the one place the
list exists: `.claude/scripts/detect-missed-gate.mjs` reads it, so a path that is
not here is a path the gate sweep cannot see.

```elevated-paths
infra/
packages/db/src/
```

**These two are a seed, not a law — the list is yours to extend.** They are what
the generated skeleton has; a real project accumulates more (auth handlers,
billing, a credentials module, a migration directory). Add a path the same day
you add the code, because the gap between the two is exactly the window in which
a change slips through unreviewed.

Nothing about this list is retroactive. Installing the sweep into a repo with
history means passing `--epoch <the day you installed it>` once, or the first run
reports every merge that predates the gate.

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
