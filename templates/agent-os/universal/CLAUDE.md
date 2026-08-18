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
- **Check the premises at both ends.** A queue item is a claim about the code, and
  nothing downstream re-reads the file it was wrong about — the `check-premises`
  skill runs between taking the item and the failing test, and a false load-bearing
  claim stops the task instead of quietly re-aiming it. It runs **again before the
  gate**, on the prose the task itself wrote: a behaviour claim with nothing behind
  it is `UNMEASURED`, and it is deleted or turned into a pointer to its test rather
  than left for a reviewer to find.
- **One task, one branch — and merge via PR.** Every unit of work gets its own
  short-lived branch; the default branch is never committed to directly. Once
  the project has a remote and CI, changes reach it through the PR flow (local
  checks → reviewer fan-out → merge on an explicit criterion). See
  `.claude/rules/workflow.md` ("Branches and commits", "PR flow"). When another
  session may touch this repo at the same time, the branch lives in its own
  worktree — the `worktree-task` skill has the lifecycle and the cleanup.
- **Gates.** Every PR is routed before it is reviewed — the
  `decision-router` picks the cheapest lane the change earns
  (`deterministic` → `fast-path` → `model`), and risk flags escalate ahead of
  all three. `code-reviewer` runs on the `model` lane, which is **everything the
  two cheap lanes did not claim** — code, a rulebook document, an unclassifiable
  path, a derived artifact git does not report as drift, or anything a risk flag
  escalated;
  `security-scanner` when a change touches auth, secrets, parsing, or outbound
  calls; `prose-reviewer` when it touches the documents that instruct agents —
  rules, skills, agent specs, decision records, this file, the README. Those last two are
  **lane-independent and may only add** — the lane is a floor, never a ceiling.
  `.claude/rules/workflow.md` carries the ladder and what the cheap lanes give
  up. Blocking findings are resolved, not argued with, and the
  `pr-ship` skill drives the fan-out. **No hook launches them** — a gate here is
  a session following a written rule, so "the gate ran" is a claim, not a
  guarantee. The mechanical enforcement below is a different thing, and the
  difference is worth keeping straight.
- **Enforcement is mechanical.** `guard-core-purity` catches an impure edit to
  the core the moment it lands; `guard-web-boundary` keeps the frontend off the
  backend; `guard-secret-file` refuses an edit that writes a credential — by the
  file's name or by a value in its text, from the one vocabulary in
  `.claude/scripts/lib/secrets.mjs`; `block-no-verify` refuses pre-commit
  bypasses; `guard-bash` refuses
  the "Never" tier — force-pushing a shared branch, a production deploy, a
  filesystem wipe — and carries the kill switch; `gate-stop-dod` refuses to end
  the session while a Definition-of-Done check fails. If a hook blocks you, fix
  the cause; never route around a hook.
- **Enforcement is a pattern you can apply again.** Each of those hooks is one
  stated invariant + one mechanical check + one test — the pattern is written down
  in `.claude/rules/invariants.md`, and the `new-invariant` skill walks you
  through adding one. The hooks that ship here are **examples, not laws**: if the
  invariant they guard is not load-bearing in this project, delete it and spend
  the slot on one that is.
- **There is a brake, and it is a real file.** `touch
  ~/.claude/__PROJECT_NAME__-loop-STOP` and `guard-bash` denies every merge
  until it is removed. Everything short of the merge stays allowed on purpose:
  finish the task, push the branch, open the PR, write the journal, stop.
  Stopping cleanly never means losing the work.
- **Work comes from the queue, through an adapter.** The `loop` skill selects via
  `.claude/scripts/queue/index.mjs`, which reads whichever queue
  `.claude/queue.json` names — the Agent queue in `PLAN.md` by default, issues in
  this repository once it has a remote. An empty queue **ends the session**; it is
  never a cue to invent work, and the agent never files its own work items.

## The elevated paths of this project

Tier 2 in `.claude/rules/autonomy.md` names *kinds* of change. This block names
the **paths** in this repository where those kinds live, and
`.claude/scripts/detect-missed-gate.mjs` reads it — so a path that is not declared
is a path the gate sweep cannot see.

```elevated-paths
packages/db/src/
.claude/
docs/decisions/
.github/workflows/
```

The entries that earn their place first are the ones that *disarm* the rest —
wherever this project keeps its rulebook, its hooks and its CI definition. A
merge that rewrites the Never tier, unwires a hook or edits what CI runs should
never pass unreviewed. The rest of the block is whatever this particular shape
has, so read the list above rather than this paragraph: the two are maintained
separately, and a project that re-composes the block leaves prose describing
somebody else's repository.

**They are a seed, not a law — the list is yours to extend.** It is what every
generated shape has; a real project accumulates more (auth handlers, billing, a
credentials module, a migration directory). Add a path the same day you add the
code, because the gap between the two is exactly the window in which a change
slips through unreviewed.

The declaration is **composed, not centralised**: the sweep unions this block with
every `elevated-paths` block in `.claude/rules/`, so a stack layer declares the
paths that only exist in its shape. A gate declared over a directory this project
does not have would report "clean" while looking nowhere.

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
