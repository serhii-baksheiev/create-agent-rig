# Dogfooding log

Phase 5 of PLAN.md asks for honest data on the quality of the rules once the
tool's own repo runs under them. Recorded as encountered:

## Awkward, worth watching

1. **The universal CLAUDE.md assumes the generated layout.** Its "map" section
   describes `packages/core` / `services/*`, which this repo does not have. The
   sync had to grow an _addendum_ mechanism (`.claude/CLAUDE.addendum.md`) so a
   repo with a different shape can override the map while keeping the rulebook.
   If a second dogfooding repo needs the same trick, the map probably belongs in
   a separate composable file rather than inside the universal CLAUDE.md.

2. **`guard-core-purity` is inert here.** This repo has no `packages/core`, so
   the hook never fires (only `block-no-verify` does real work). Harmless, but
   it means "the hooks are active" is weaker evidence in this repo than in a
   generated project. The hook path pattern could become configurable per
   project if a real need appears — data first (PLAN.md §6 level 3 discipline).

3. **pnpm 11 `allowBuilds` + esbuild.** Approving esbuild's postinstall swaps
   its JS launcher for a raw binary that pnpm's node-based bin shim cannot
   execute (`SyntaxError: Invalid or unexpected token`). The template pins
   `allowBuilds: esbuild: false` with a comment. Surprising, easy to trip over
   when "fixing" the install warning.

4. **TypeScript 7 (native) vs typescript-eslint.** Fresh installs resolve
   `typescript@7`, which typescript-eslint (< 6.1 peer range) rejects — the
   root repo pins `typescript@~6.0`. The node-ts stack rules do not pin
   versions; the skeleton's lockfile is what protects generated projects.

## Confirmed working

- **Phase 6, the central claim:** `agent-os/universal` applied to the second
  target (`node-service`) with **zero edits** (`git diff` on the directory is
  empty across the phase). The stack seam (`node-ts` alone vs
  `node-ts + aws-cdk`) was enough; the only near-miss was the logger's
  `message` field colliding with a call-site field name — a template bug, not
  a rules bug.

- The drift test (`test/template/dogfood.test.ts`) caught intermediate edits to
  the composed files during setup — the mechanism earns its keep.
- `block-no-verify` and the pre-commit gate compose fine with the repo's own
  `.husky` hook path.

## Phase 8 — distribution audit (measured, not assumed)

- `npm pack` **strips `.gitignore` at every depth** → templates now store it as
  `gitignore` and the CLI maps it back on generation (the CRA trick).
- Nested `pnpm-lock.yaml`, `.claude/`, `.github/` **survive** packing — no
  rename needed for those (only the root lockfile is stripped).
- **Renaming the template's `.gitignore` removed npm's only reason to skip the
  template's `node_modules`** — 15 742 files silently entered the tarball until
  the pack-path e2e caught it. Each template now carries an `.npmignore`
  (with `node_modules/` explicitly) whose job is packing hygiene only; the CLI
  never copies `.npmignore` into generated projects.
- `writeFile` after content substitution dropped file modes; `copy-tree` now
  restores the source mode (`chmod`, immune to umask). Covered by a unit test.
- **Owner action still open (8.4):** claiming the npm name needs a registry
  publish from the owner's account. Note a discrepancy: the next-block plan
  says `create-agent-rig`, but PLAN.md §2 locked `create-agent-factory` —
  decide which name to claim before publishing.
