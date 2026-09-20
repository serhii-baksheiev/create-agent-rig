<!-- generator repo addendum — hand-maintained; everything above is composed
     from templates/agent-os by scripts/sync-agent-os.mjs -->

## This is the generator's own repository

The map above describes the projects this tool **generates**. This repo is the
generator itself, dogfooding the same rulebook. Its own map:

```
packages/cli/       the generator (TS, tested): the create, init, upgrade,
                    setup and memory commands over copy-tree, substitute
                    and the ownership manifest (RP-178 removed the unused
                    policy/ library)
templates/agent-os/ the one payload the package ships: universal rules only
                    (RP-177 retired the per-target stack overlays and the
                    init-only override layer — there is one flavour, and
                    `create` installs it the same way `init` does)
test/e2e/           generate → install → run the generated repo's checks
test/template/      hook blocking, stack neutrality, dogfood drift
scripts/            prepare (build+hooks), sync-agent-os (composes this file),
                    dogfood/ (this repo's own node-ts overlay — RP-177)
```

## Commands

- `pnpm test` — build + all tests (unit, template, e2e)
- `pnpm test:unit` — fast tests only (pre-commit runs these, after the sweep below)
- `node scripts/validate-no-secrets.mjs` — the credential sweep over every tracked
  file; `--staged` is what pre-commit runs FIRST, before lint/typecheck/test, and
  `--self-test` proves the scanner still detects each shape it claims
- `pnpm lint` / `pnpm typecheck` / `pnpm format`
- `node scripts/sync-agent-os.mjs` — compose the canonical `AGENTS.md` rulebook
  (and the `CLAUDE.md` shim) plus `.claude/` from the templates, and regenerate
  the derived Codex projection (`.agents/`, `.codex/`) from the Claude-shaped
  sources; `scripts/sync-codex-adapter.mjs --check` verifies that projection.
  `AGENTS.md` is authored, not derived, since RP-186
  (`docs/decisions/agents-md-canonical.md`).

## Repo-specific rules

0. **The process layer only travels one way: outward.** `guard-bash`,
   `detect-missed-gate` and the `loop` skill here are ahead of the copies in the
   project this rulebook was extracted for — by hundreds of lines of checks and a
   whole section of the loop's own procedure. "Synchronising" them from a
   downstream copy is a regression, not an update, and no port brief may bring
   one back. Ideas travel in; files do not. (`NOTES.md`, "the drift that runs the
   other way".)
1. **PLAN.md §2 decisions are locked.** Do not re-litigate them without new data.
2. **The template is real, generator-neutral content.** No template engine;
   generation is tree copy + token substitution only. `templates/` is
   excluded from the root lint/typecheck (`eslint.config.mjs`'s `ignores`) —
   its `.mjs` hooks and scripts are plain JS the root toolchain does not
   compile — and it is validated by content instead: `test/template/`
   asserts what the tree says, `test/e2e/` generates from it and spawns the
   built CLI against the result.
3. **Zero options at the personal stage; the CLI keeps zero runtime deps** —
   that is what keeps `npx github:…` and the tarball path working.
4. **Provenance:** `agent-os/` content is authored fresh — never copied from a
   private work repository (PLAN.md §2).
5. **Never edit a synced file directly** — edit `templates/agent-os/universal`,
   `scripts/dogfood/` (this repo's own node-ts overlay, RP-177), or this
   addendum, and run the sync script; the drift test fails otherwise. The synced
   correspondence is pinned in `test/template/dogfood.test.ts` › "CLAUDE.md and
   .claude/ are in sync with templates/agent-os". The synced
   set is `CLAUDE.md`, `AGENTS.md` (the canonical rulebook, authored — not
   derived — since RP-186), everything under `.claude/`, the Codex projection
   (`.agents/`, `.codex/`), **`journal/README.md`** and
   **`docs/decisions/`**. The last two payload paths sit outside either harness's
   configuration tree (AR-64 and AR-63 respectively). Both live in the repo root
   among files this repo does own — `journal/YYYY-MM.md` next to the one, nothing
   yet next to the other — so they are the natural things to edit in place, and
   an edit there is lost at the next sync. The month files themselves are this
   repo's own and are never synced.
6. **This repo has a remote and CI, so it follows its own PR flow** (see the
   synced `.claude/rules/workflow.md`): one task per short-lived branch, never
   commit to `master` directly, merge through a PR once CI is green. The
   pre-0.2.0 history was authored straight on `master`; that was a dogfooding
   gap — it stops here.

## Foot-guns

- **`__PROJECT_NAME__` is the only substitution token.** Do not restore
  `__PROJECT_SCOPE__`, `__REGION__`, `@app/`, or filename substitution. Old
  manifests still carry `scope` and `region` for schema compatibility, but the
  universal payload never renders them and upgrade never rewrites application
  files left behind by a pre-0.10 rig.
- **Templates must live inside the published package.** `npm pack --dry-run`
  is the check, and the pack-path e2e (`test/e2e/pack-install.test.ts`) is the
  gate. The git path cannot catch pack-path regressions: the two file sets
  differ exactly where scaffolders break (dotfiles, modes, `files`).
- Only the repo root publishes. `packages/cli` is locked by `private: true`
  **and** a failing `prepublishOnly` — npm 10 ignores `private` on
  `publish --dry-run`, so the script is the real lock.
