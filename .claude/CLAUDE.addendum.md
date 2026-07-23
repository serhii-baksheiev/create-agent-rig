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
