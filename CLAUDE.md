# create-agent-factory — repo rules

> Draft (phase 0). In phase 2 this file becomes the source material for
> `templates/agent-os/universal/`; in phase 5 it is replaced by a synced copy of that
> template (dogfooding).

## What this repo is

A CLI that scaffolds projects with two layers: `templates/agent-os/` (rules, gates,
hooks — stack-neutral) and `templates/skeleton/<target>/` (a coherent, runnable
project per target). See `PLAN.md` — its §2 decisions are locked.

## Commands

- `pnpm test` — build + all tests (unit + e2e)
- `pnpm test:unit` — fast unit tests only
- `pnpm lint` / `pnpm typecheck` / `pnpm format`
- `pnpm build` — compile the CLI to `packages/cli/dist`

## Rules

1. **TDD, always.** Failing test first, then the minimum implementation, then refactor.
   No implementation before its test exists and fails.
2. **Templates are real projects.** Never turn a template into fragments; never add a
   template engine. Generation is tree copy + token substitution only.
3. **The root toolchain never reaches into `templates/`.** Templates carry their own
   lint/test config and are exercised in place.
4. **Zero options** at the personal stage. Flexibility = subtraction. Do not add CLI
   flags, prompts, or config without data showing someone needs the choice.
5. **The CLI has zero runtime dependencies.** This keeps the `npx github:…` and
   tarball paths working; adding a runtime dep needs a strong reason.
6. **Provenance:** `agent-os/` content is authored fresh — never copied from a private
   work repository (PLAN.md §9).
7. **Scope discipline:** do not modify unrelated files; keep each change the smallest
   thing that satisfies its phase's DoD.

## Foot-guns

- The template's `@app/` scope is _valid on purpose_ — the template must run as-is.
  Don't "fix" it to a token.
- Tokens (`__PROJECT_NAME__`, `__PROJECT_SCOPE__`, `__REGION__`) may only appear where
  they don't break the template's own runnability (docs, comments, inert strings).
- `pnpm-lock.yaml` inside templates is intentional (reproducible template installs) —
  don't add it to ignore lists.
