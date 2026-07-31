# create-agent-rig

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
- **Enforcement is a pattern you can apply again.** Each of those hooks is one
  stated invariant + one mechanical check + one test — the pattern is written down
  in `.claude/rules/invariants.md`, and the `new-invariant` skill walks you
  through adding one. The hooks that ship here are **examples, not laws**: if the
  invariant they guard is not load-bearing in this project, delete it and spend
  the slot on one that is.
- **There is a brake, and it is a real file.** `touch
  ~/.claude/create-agent-rig-loop-STOP` and `guard-bash` denies every merge
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
.github/workflows/
scripts/
package.json
templates/agent-os/universal/.claude/hooks/
templates/agent-os/universal/.claude/scripts/
templates/agent-os/universal/.claude/settings.json
```

`.claude/` and `.github/workflows/` are there because they are what *disarms* the
rest: a merge that rewrites the Never tier, unwires a hook or edits what CI runs
should never pass unreviewed. `packages/db/src/` is the one the generated shape
has.

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

---

<!-- generator repo addendum — hand-maintained; everything above is composed
     from templates/agent-os by scripts/sync-agent-os.mjs -->

## This is the generator's own repository

The map above describes the projects this tool **generates**. This repo is the
generator itself, dogfooding the same rulebook. Its own map:

```
packages/cli/       the generator (TS, tested): copy-tree, substitute, targets
templates/agent-os/ layer 1 — universal rules + stack/<name> overlays
templates/skeleton/ layer 2 — one runnable project per target
test/e2e/           generate → install → run the generated project's checks
test/template/      hook blocking, composition neutrality, dogfood drift
scripts/            prepare (build+hooks), sync-agent-os (composes this file)
```

## Commands

- `pnpm test` — build + all tests (unit, template, e2e)
- `pnpm test:unit` — fast tests only (pre-commit runs these)
- `pnpm lint` / `pnpm typecheck` / `pnpm format`
- `pnpm template:check` — the template's own in-place check (lint/type/test/synth)
- `node scripts/sync-agent-os.mjs` — regenerate CLAUDE.md + .claude/ from templates

## Repo-specific rules

1. **PLAN.md §2 decisions are locked.** Do not re-litigate them without new data.
2. **Templates are real projects.** No template engine; generation is tree copy +
   token substitution only. The root toolchain never reaches into `templates/`
   (they carry their own configs and are exercised in place).
3. **Zero options at the personal stage; the CLI keeps zero runtime deps** —
   that is what keeps `npx github:…` and the tarball path working.
4. **Provenance:** `agent-os/` content is authored fresh — never copied from a
   private work repository (PLAN.md §9).
5. **Never edit `CLAUDE.md` or synced `.claude/` files directly** — edit
   `templates/agent-os/` (or this addendum) and run the sync script; the drift
   test fails otherwise.
6. **This repo has a remote and CI, so it follows its own PR flow** (see the
   synced `.claude/rules/workflow.md`): one task per short-lived branch, never
   commit to `master` directly, merge through a PR once CI is green. The
   pre-0.2.0 history was authored straight on `master`; that was a dogfooding
   gap — it stops here.

## Foot-guns

- The template's `@app/` scope is _valid on purpose_ — the template must run
  as-is. Don't "fix" it to a token.
- Tokens (`__PROJECT_NAME__`, `__PROJECT_SCOPE__`, `__REGION__`) may only appear
  where they don't break the template's own runnability.
- `pnpm-lock.yaml` inside templates is intentional (reproducible installs) —
  don't ignore it, and let substitution rewrite it.
- esbuild's postinstall stays **unapproved** in the template workspace
  (`allowBuilds: esbuild: false`) — approving it breaks pnpm's bin shim.
- **Templates must live inside the published package.** `npm pack --dry-run`
  is the check, and the pack-path e2e (`test/e2e/pack-install.test.ts`) is the
  gate — per target. The git path cannot catch pack-path regressions: the two
  file sets differ exactly where scaffolders break (dotfiles, modes, `files`).
- Only the repo root publishes. `packages/cli` is locked by `private: true`
  **and** a failing `prepublishOnly` — npm 10 ignores `private` on
  `publish --dry-run`, so the script is the real lock.
