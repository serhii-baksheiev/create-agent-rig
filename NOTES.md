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

## Phase 9 — composition safety (landed clean, no findings)

Strict policy shipped in commit `7df42f2`: before anything is copied,
`createProject` lists every layer (skeleton, universal, stack overlays) and
**refuses** generation on a path claimed twice; intended overwrites live in an
explicit `ALLOWED_OVERWRITES` set (empty today), never in copy order. The
per-target ownership map is asserted by `test/template/composition.test.ts`
(no collisions in either target; skeleton and agent-os fully disjoint). The
phase produced no surprises — which is why it originally had no entry here;
recorded now so the log has no numbering gap. Later briefs leaned on it: the
skills, the `cdk-diff-reviewer` agent and `apps/web` all passed the collision
check with zero adjustments.

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
- Brief §2b (extraction map) landed on top: the **`cdk-diff-reviewer` agent**
  (stack/aws-cdk, Tier A — the infra rules now gate deploys on it; reviews the
  synthesized diff, BLOCKERS then nits, read-only tools). The operational
  epistemics were carried where the commands were not: pr-ship gained
  "poll named checks by head SHA / scanner-only ≠ done" and "diff from
  origin, not local"; post-deploy-verify gained "UPDATE_COMPLETE alone is
  stale evidence" and "empty metric = no invocations, not healthy".
- **The quoted-prose false positive was real:** `block-no-verify` blocked
  `git commit -m "docs: explain why --no-verify is forbidden"`. The hook now
  strips quoted segments before matching (red test first), per §2b's guard
  finding. Tier C (`implementer`, `ro-debug`) and product-domain content
  stay un-extracted by design.
- Deferred per brief §5 (all gated on more phase-11 data): `@path` imports,
  `--resume`/session management, planning mode. `worktree-task`, `ro-debug`,
  `graph-recon` skills also wait.
- **Owner side task (brief §3):** audit the reference project's own five
  skills for `context: fork` + `allowed-tools` — outside this repo.

## Web brief (0.2.0) — the frontend as a boundary proof

- `apps/web` (identical in both targets, static export): one page, plain by
  design; the load-bearing scene is `src/lib/validate.ts` — the browser
  validates with the SAME `NewNoteSchema` the server trusts, and the
  shared-validation test pins web/core/`createNote` to identical verdicts on
  nine fixtures. `GET /notes` was added to both backends (a third,
  read-granted lambda in aws; a route + static serving in node-service — no
  second runtime) because "a list that reads them back" needs a read path.
- **The second mechanical boundary shipped:** `guard-web-boundary` refuses
  `@…/db`, `@…/api`, `@…/worker` and relative reaches into `packages/db` /
  `services` from `apps/web` — under any rewritten scope. Rule stated in
  `architecture.md`, wired in settings.json, tool-layer tested.
- **Turbopack (Next 16 default) cannot resolve NodeNext-style `./x.js` → x.ts
  in `transpilePackages`** — the web build runs `next build --webpack` with
  `resolve.extensionAlias`. The NodeNext convention of the packages stays.
- Next rewrites `next-env.d.ts` with a reference into `.next/` — the file is
  a build artifact here: git-ignored, npm-ignored, copy-tree-ignored (it broke
  clean-generation typecheck otherwise). Same for `.next/` and `out/`.
- `sharp` (via next) joins esbuild in `allowBuilds: false` — a static export
  never runs the image optimizer.
- The lockfile-free weekly run exists now (`template-freshness.yml`) — with
  Next in the templates it is the primary early-warning channel, per §6.
- **The un-dotted-gitignore trap has a git edition too:** the web-brief commit
  leaked ~250 files of `.next/`/`out/` into history, because the templates'
  `gitignore` files (stored un-dotted for npm's sake) are inert as _git_
  ignores in this repo — only the root `.gitignore` guards the subtree, and it
  did not know about Next artifacts. Caught by the owner reviewing commit
  size. Any new template artifact type now needs THREE ignores: the
  template's `gitignore` (for generated projects), its `.npmignore` (for the
  tarball), and the root `.gitignore` (for this repo).
- Excluded by design (§2): auth, UI kit, state manager, i18n/analytics,
  jsdom/component tests.

## CLI polish brief (0.1.x scope, landed on 0.2.0)

- **The final screen is now the governance report**, counted from the
  generated tree (rules/agents/hooks/skills — never hardcoded); calm tone, no
  fireworks, `pnpm check` as the last word. `--version` added; `--help`
  already read targets from the registry.
- **Non-TTY contract changed deliberately:** a non-interactive run without
  `--target` now fails fast naming the flag (previously: silent default).
  Interactive runs keep the picker with a default. Every e2e that exercised
  the implicit default now passes `--target` explicitly — CI scripts should
  be explicit; that is the tool's own pitch.
- Colours are three and semantic (accent/dim/red), hand-rolled ANSI — zero
  new dependencies; disabled off-TTY and under `NO_COLOR`/`--no-color`.
- `git init` + a "Pristine template" baseline commit (skippable with
  `--no-git`, never fatal; explicit committer identity so fresh machines
  work; `--no-verify` on the baseline shields it from the USER'S global
  hooks — the generated project's own gates do not exist yet).
- README restructured per §9.1 incl. the "deliberately does not" section and
  a static demo frame. **Owner action (§9.3):** an asciinema/GIF recording of
  `demo.sh` beats the static frame — record and link it when hosting exists.
- Updated web brief §2b landed too: the web layer's **test contract** is now
  stated in `architecture.md` (shared-validation + build + typecheck;
  component testing stays out until real need) — so "TDD without exception"
  cannot be read as demanding a jsdom stack.
- **Owner rule change absorbed:** commits/PRs carry NO AI attribution
  (universal CLAUDE.md top rule, synced into this repo's rulebook).

## Enforcement hooks + reach brief (post-0.1.0)

- **Two new hooks close stated rules mechanically.** `gate-stop-dod` (Stop
  event, exit 2 = prevent stop): the Definition of Done becomes a gate, but
  only when the tree is dirty, only from a per-stack `dod-checks.json`
  (universal ships the mechanism, node-ts ships `lint/typecheck/test`), and
  **never twice in a row** (`stop_hook_active`) — the anti-loop trap the brief
  flagged. Fails open on any error, so a crashed gate can't wedge a session.
  `inject-rules` (SessionStart): re-emits `autonomy.md` to stdout — one of the
  few events whose stdout reaches context — so the tiers/stop-rules survive
  compaction and resumes. Injected content is stateless (test asserts no
  dates/SHAs), since mid-session injections are replayed, not re-run.
- **Overclaim corrected (Part 2):** the purity guard is `PreToolUse`, so it is
  preventive on the normal path — but architecture.md/README now state the
  claim exactly (best-effort pre-write text scan; Edit sees the fragment not
  the whole file; review+tests back it) rather than inflating it. A tool that
  sells enforcement can't overstate its own.
- **Third axis — process vs architecture (§3):** `universal/layers.json`
  classifies every universal file exactly once (test-enforced completeness).
  Process = travels to any repo; architecture = assumes the generated shape.
  This is the prerequisite that makes `init` safe.
- **`agent-rig init` (§4):** installs ONLY the process layer into an existing
  repo — never the architecture rules (they'd reference a `packages/core`
  that isn't there). Refuses to clobber CLAUDE.md, never overwrites a file it
  didn't write, `--dry-run` plans without writing, `--force` for CLAUDE.md.
  The author's own existing repos can now use the tool — reach grows, template
  surface doesn't. (Plugin/marketplace transport noted, not built — evaluate
  when there's demand.)
- **Loop driver (§5):** the `loop` skill + a two-queue `PLAN.md` convention
  (Agent queue / Operator queue / Journal) ship in universal. The load-bearing
  stop condition — **queue empty → end, do not invent work** — is stated and
  tested. The autonomy tiers finally have something that runs the agent alone.
  Note: `PLAN.md` is a process-layer file, so `init` brings it too; sync skips
  it for THIS repo (owner-authored plan of record).
- Rejected per Part 4 (recorded so not re-litigated): prompt/agent hook
  handlers, TTS, meta-agent, append-only lessons loops, twelve-skill packs,
  wholesale `permissions.deny`. `agent-os` must be able to LOSE rules.

## PR-flow addendum (workflow.md)

- The autonomy tiers already said a human-review change opens a PR, but the
  template shipped no rule for _driving one to merge_. `workflow.md` now
  carries: branch discipline (one task/one branch, never the default —
  applies even before a remote), the gate order (local checks → reviewer
  fan-out → merge), the fan-out shape (code-reviewer always; security by
  touched paths; infra review names the stack agent), and the post-merge tail
  (post-deploy verdict → update PLAN.md).
- **The merge criterion is stated provider-neutrally** ("confirm the required
  check completed for THIS commit; a watcher can exit before checks even
  register") and names **no** command; the concrete `gh api …/check-runs`
  form lives in `stack/node-ts` (both targets ship it + GitHub Actions).
  Test enforces both: universal contains no `gh`, node-ts does.
- **Degrades honestly:** the PR flow section opens with "once the project has
  a remote and CI" — a day-one generated project has neither, and reads the
  branch discipline as the whole of it, not a broken instruction.
- **No flake registry shipped** (a fresh project has no CI history; an empty
  section invites filling — the stop rules already cover "red check = info").

### Deferred to the agent backlog — worktrees (NOT implemented)

Return trigger: **when unattended `loop` runs start overlapping with
hand-driven work.** Branch discipline (above) is the transferable core —
isolation of a unit of work; worktrees are one _implementation_ of it for the
parallel case, and a single-developer fresh project has no parallelism to
isolate. Add the rule only when the trigger fires — not before.

## CD brief (0.2.0) — deployment closes the merge→deploy→verify loop

- The chain was `rule → post-deploy-verify skill → nothing` (no deploy).
  Now both targets deploy, diverging exactly where they must:
  - **aws-serverless:** a real **dev** deploy workflow — `cdk deploy AppStack
WebStack` over **OIDC** (`id-token: write` + `configure-aws-credentials`
    `role-to-assume`), **zero static keys**. A starter multiplies whatever it
    ships, so it ships no long-lived credentials — that makes the template
    more correct than the project it was extracted from (§3).
  - **node-service:** a real `build:artifact` (esbuild bundle → `dist/server.mjs`
    - copied web `public/`) that **runs and boots** — a template test builds it
      and hits the live socket — and the workflow uploads `dist/` and ships it
      nowhere. Destination is the owner's choice, stated, not a `TODO` stub.
- **Degrades cleanly (§5):** the aws deploy job has a guard step — no
  `AWS_DEPLOY_ROLE_ARN` secret ⇒ it prints "deploy skipped: no credentials"
  and the downstream steps skip, job stays green. Enabling is _add a secret_,
  never _edit the workflow_ (secrets can't gate a job-level `if`, so the guard
  is a step). node-service needs no secret to build an artifact.
- **No production path in either target (§4):** the Never tier forbids an agent
  triggering a prod deploy, so shipping a prod workflow would contradict the
  rules day one. Production is documented as a human step in both READMEs.
- **`post-deploy-verify` scoped to what the skeleton provisions (§6):** the
  deploy job's conclusion is now the primary always-available signal; freshness
  cross-check + the one DLQ + function errors follow; and a vacuous metric is
  reported as **"no signal"** (= no invocations), never a pass — an empty
  result must not become the first meaningless HEALTHY.
- **Tool repo never deploys (DoD):** template deploy workflows live under
  `templates/skeleton/*/.github/` (GitHub only runs root workflows), the root
  workflows run `check` only, and the aws deploy is secret-gated anyway — a
  fork can't accidentally deploy. Test asserts root workflows carry no
  `cdk deploy` / `upload-artifact`.

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
