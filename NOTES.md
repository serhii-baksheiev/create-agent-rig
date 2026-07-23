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

- The drift test (`test/template/dogfood.test.ts`) caught intermediate edits to
  the composed files during setup — the mechanism earns its keep.
- `block-no-verify` and the pre-commit gate compose fine with the repo's own
  `.husky` hook path.
