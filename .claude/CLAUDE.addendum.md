<!-- generator repo addendum — hand-maintained; everything above is composed
     from templates/agent-os by scripts/sync-agent-os.mjs -->

## This is the generator's own repository

The map above describes the projects this tool **generates**. This repo is the
generator itself, dogfooding the same rulebook. Its own map:

```
packages/cli/       the generator (TS, tested): copy-tree, substitute, targets
templates/agent-os/ layer 1 — universal rules, stack/<name> overlays, and
                    init/ (overrides `init` applies when the rig goes into an
                    existing repo whose shape we know nothing about)
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

0. **The process layer only travels one way: outward.** `guard-bash`,
   `detect-missed-gate` and the `loop` skill here are ahead of the copies in the
   project this rulebook was extracted for — by hundreds of lines of checks and a
   whole section of the loop's own procedure. "Synchronising" them from a
   downstream copy is a regression, not an update, and no port brief may bring
   one back. Ideas travel in; files do not. (`NOTES.md`, "the drift that runs the
   other way".)
1. **PLAN.md §2 decisions are locked.** Do not re-litigate them without new data.
2. **Templates are real projects.** No template engine; generation is tree copy +
   token substitution only. The root toolchain never reaches into `templates/`
   (they carry their own configs and are exercised in place).
3. **Zero options at the personal stage; the CLI keeps zero runtime deps** —
   that is what keeps `npx github:…` and the tarball path working.
4. **Provenance:** `agent-os/` content is authored fresh — never copied from a
   private work repository (PLAN.md §9).
5. **Never edit a synced file directly** — edit `templates/agent-os/` (or this
   addendum) and run the sync script; the drift test fails otherwise. The synced
   set is `CLAUDE.md`, everything under `.claude/`, **`journal/README.md`** and
   **`docs/decisions/`** — the two synced payload paths living outside
   `.claude/` (AR-64 and AR-63 respectively). Both sit in the repo root among
   files this repo does own — `journal/YYYY-MM.md` next to the one, nothing yet
   next to the other — so they are the natural things to edit in place, and an
   edit there is lost at the next sync. The month files themselves are this
   repo's own and are never synced.
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
- **`templates/agent-os/` never uses `__PROJECT_SCOPE__` or `@app/`** — those two
  substitute to the same text as `__PROJECT_NAME__`, so `upgrade` cannot reverse
  them, and a file it cannot reverse is a permanent conflict on every rig that
  installed it. `__PROJECT_NAME__` and `__REGION__` are fine there. A template
  test pins this; the reversal and its limits live in `lib/substitute.ts`.
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
