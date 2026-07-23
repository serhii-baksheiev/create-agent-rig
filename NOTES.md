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
  publish from the owner's account. _(Historical: the original locked name
  `create-agent-factory` turned out taken on npm; renamed repo-wide to
  `create-agent-rig` on 2026-07-23 — re-checked free that day. First publish
  claims it.)_

## Publish brief (2026-07-23) — closing findings

- **npm 10.9 ignores `"private": true` on `npm publish --dry-run`** (measured:
  it happily printed `+ @create-agent-rig/cli@0.1.0`). The brief's red test
  as written cannot pass; the real lock is a failing `prepublishOnly` script
  in `packages/cli`, with `private` kept as belt. Test asserts the BLOCKED
  refusal.
- **Cross-target bleed (§9) confirmed and wider than the brief:** `cdk.out`
  sat in node-service's `gitignore` _and_ its `eslint.config.mjs`; `var/` had
  leaked the other way into aws-serverless's `.npmignore`. All pruned;
  `cross-target.test.ts` now asserts foreign markers per target.
- Pack-path e2e now runs the generated project's full `check` for **both**
  targets from the tarball (aws-serverless incl. synth was the unverified
  half). LICENSE + keywords added; `repository` field stays open until the
  hosting decision (PLAN.md §11).

## agent-os v2 (0.2.0) — skills land

- The gap was real: `autonomy.md` stated the post-deploy verdict rule while
  the generated project had nothing to run. v2 ships exactly two skills —
  `post-deploy-verify` (stack/aws-cdk: stack freshness → smoke → async path →
  DLQ/alarm → binary HEALTHY/REGRESSION, `context: fork`, read-only
  `allowed-tools`) and `pr-ship` (universal: checks → reviewer fan-out → DoD
  walk → SHIP/HOLD with named blockers). The seam held: skills split
  universal/stack the same way rules do, and node-service correctly does NOT
  receive `post-deploy-verify` (no deploy step — asserted by test).
- Two rule additions: review-context isolation now carries its _rationale_
  (workflow.md), and session staleness joined the stop-rule family
  (autonomy.md).
- Deferred per brief §5 (all gated on more phase-11 data): `@path` imports,
  `--resume`/session management, planning mode. `worktree-task`, `ro-debug`,
  `graph-recon` skills also wait.
- **Owner side task (brief §3):** audit the reference project's own five
  skills for `context: fork` + `allowed-tools` — outside this repo.

## Phase 11 — first-use field notes (data, not opinions)

Session: generated a `node-service` project and did real work in it under its
own rulebook — `GET /notes/:id` end to end (usecase + handler + route +
integration tests), strict TDD, 52 → 56 tests green. Recorded per the four
questions of the next-block plan:

**Edited immediately after generation:** nothing. `install → check` was green
as generated; no placeholder, config or name needed touching.

**Rules that got in the way:**

- "usecase mandatory even for a trivial read" — `getNoteUsecase` is a one-line
  pass-through. Real friction, but _stated_ friction: architecture.md
  explicitly claims the uniformity is worth this ceremony. No change proposed.
- No hook interfered (the work never touched `packages/core`).

**What was missing:**

- A second route turns `server.ts` into a growing if-chain with a hand-rolled
  path-param regex. Fine at 2 routes; at 3+ a minimal router will be wanted.
  → _candidate_, needs a second real project to confirm.
- The handler boilerplate (json(), try/catch, AppError mapping) is duplicated
  between the two handlers (~20 lines). → _candidate_ for a tiny local helper
  in `services/api`; not shared/, it is transport-specific.
- The other way around: `JsonFileNoteStore.get` already existed — the model
  layer was ahead of the skeleton's minimal surface, which is what made the
  read feature cheap. Keep shipping models slightly "ahead".

**🔴 Did `universal` need edits for this project?** No. The seam held again.

## Phase 12 — the verdict on the data

The phase-11 list contains **zero** items that clear the plan's own bar for
action: no level-3 option was wanted (nothing needed detaching), no third
target shape appeared, no rule correction was justified. The two "missing"
entries are single-observation candidates (N=1) — acting on them now is
exactly the trap §6 guards against. **Decision: no changes in phase 12**;
the router and handler-helper candidates wait for a second real project to
confirm or kill them. Every future change in this area must cite a line above.

## Phase 10 — the layer-chain decision

Dropping the separate _service_ layer (PLAN.md §5.1 says
`… usecase → service → model`) is ruled a **deliberate simplification**, not a
slip: in the minimal skeleton every usecase is one pure domain function plus
one model call, and a pass-through service would be ceremony. The canonical
chain everywhere is `payload → handler → usecase → model`;
`architecture.md` now says explicitly when a service layer earns its place.
`test/template/consistency.test.ts` fails on any restatement that differs.
