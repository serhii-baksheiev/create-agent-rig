# create-agent-rig

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
- **Enforcement is mechanical.** `guard-core-purity` refuses impure edits to
  the core; `block-no-verify` refuses pre-commit bypasses. If a hook blocks
  you, fix the cause; never route around a hook.

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
