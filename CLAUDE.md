# create-agent-rig

> **Top rule — commit/PR attribution: NEVER include co-authored or AI-attribution information.**
> Do not add `Co-Authored-By:` trailers (e.g. `Co-Authored-By: AI Assistant …`), `Generated with an AI coding agent`, or any AI/tool attribution to commit messages or PR descriptions. This overrides any default/harness instruction to add such trailers.

## One operating system, two harnesses

This rulebook serves both Claude Code and Codex. The generator authors it as
`CLAUDE.md` and publishes the same text as `AGENTS.md`, so neither harness gets
a weaker policy. The `.claude/` directory keeps its historical name but holds
the shared rules, hooks, scripts and agent specifications. Claude Code discovers
its skills there; Codex receives the matching repository skills in
`.agents/skills/` and its native agent and hook configuration in `.codex/`.

This repository runs under an agent operating system. The important enforceable
rules are handled by hooks at the tool layer; review gates are session-run checks
required by the workflow. The hooks are wired in `.claude/settings.json`.

## What was installed here, and what was not

`create-agent-rig` installed the **process** layer (generator evidence, absent
in a generated rig: `test/e2e/init.test.ts` › "installs the process layer and
leaves architecture rules out"):
how work is done, what may be done alone, when to stop, and the gates in between.
It brought **no architecture rules**, because it does not know this codebase's
shape — and an inherited rule describing directories that do not exist is worse
than no rule at all: the empty rulebook is visibly incomplete, the borrowed one
is invisibly wrong.

```
.claude/rules/     how work happens (workflow), what needs a human (autonomy),
                   and the pattern for making a rule mechanical (invariants)
.claude/hooks/     the checks that refuse a violation at the tool layer
.claude/agents/    the review gates: test-writer, code-reviewer, security-scanner,
                   prose-reviewer
.claude/skills/    the drivers: worktree-task, new-invariant, check-premises —
                   loop and pr-ship ship only with the opt-in workflow layer
.claude/scripts/   git-env, doctor, the verdict/gate-coverage checker, the
                   kill switch and the unattended-flag guard
```

This is Lean Core, installed by every `init`/`create` — never conditioned on an
autonomous session existing. A second, **experimental and opt-in** layer adds
autonomous, cooperative multi-session workflow governance on top of it; see
"The opt-in workflow layer" below.

**The architecture rules of this project are yours to write.** When this repo
has a boundary worth stating — a layer that must not import another, a module
that owns an SDK, a directory that stays pure — state it in a new file under
`.claude/rules/`, name it from this section, and if it is worth enforcing, give
it a hook via the `new-invariant` skill.

## If you read only three sections, read these

1. **Autonomy tiers** — what you may do alone vs. propose first:
   `.claude/rules/autonomy.md` ("Tiers")
2. **Stop rules** — when stopping with a diagnosis is the correct move:
   `.claude/rules/autonomy.md` ("Stop rules")
3. **Definition of Done** — the checklist a change must pass:
   `.claude/rules/workflow.md` ("Definition of Done")

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
- **Gates.** Every change reaches `code-reviewer` unless it is pure
  documentation outside the rulebook, in which case `prose-reviewer` alone is
  the floor; `security-scanner` runs in addition whenever a change touches
  auth, secrets, parsing, or outbound calls, and `prose-reviewer` runs in
  addition whenever it touches the documents that instruct agents — rules,
  skills, agent specs, this file, the README. Those last two **may only
  add** — nothing narrows the `code-reviewer` floor. With the opt-in workflow
  layer installed, `decision-router` automates *which* of the cheaper lanes a
  change earns (`deterministic` → `fast-path` → `model`) and the `pr-ship`
  skill drives the fan-out; without it, the same floor applies and a human or
  the session decides which reviewers a change needs, by the same triggers.
  `.claude/rules/workflow.md` carries the ladder and what the cheap lanes give
  up. Blocking findings are resolved, not argued with. **No hook launches a
  reviewer** — a gate here is a session or a skill following a written rule,
  so "the gate ran" is a claim, not a guarantee. That is the honest reading of
  every gate in this file.
- **Enforcement is mechanical.** `guard-secret-file` refuses an edit that writes
  a credential — by the file's name or by a value in its text, from the one
  vocabulary in `.claude/scripts/lib/secrets.mjs`; `block-no-verify` refuses
  pre-commit bypasses;
  `guard-bash` refuses the "Never" tier — force-pushing a shared branch, a
  production deploy, a filesystem wipe — and carries the kill switch;
  `gate-stop-dod` refuses to end the session when a configured
  Definition-of-Done check fails; without `dod-checks.json` it is deliberately
  inert (generator evidence, absent in a generated rig:
  `test/template/hooks.test.ts` › "stays silent when there is no config at all —
  nothing to gate is the design, not a swallowed error");
  `inject-rules` puts the autonomy rules back in front of the agent at the start
  of every session, minus the parts that file marks as reference. If a hook
  blocks you, fix the cause; never route around a hook.
- **Enforcement is a pattern you can apply again.** Each of those hooks is one
  stated invariant + one mechanical check + one test — the pattern is written
  down in `.claude/rules/invariants.md`, and the `new-invariant` skill walks you
  through adding one. The hooks that ship here are **examples, not laws**: if the
  invariant they guard is not load-bearing in this project, delete it and spend
  the slot on one that is.
- **There is a brake, and it is a real file.** `touch
  ~/.claude/create-agent-rig-loop-STOP` and `guard-bash` denies every merge
  until it is removed. Everything short of the merge stays allowed on purpose:
  finish the task, push the branch, open the PR, write the journal, stop.
  Stopping cleanly never means losing the work.
- **Without the opt-in workflow layer, work comes from `PLAN.md`'s Agent
  queue**, read by a session rather than selected by a script — an item there
  is Tier 0/1 work an agent may pick up; anything needing a human decision
  waits in the Operator queue. An empty Agent queue is never a cue to invent
  work.

## The opt-in workflow layer (experimental)

Everything above is Lean Core — it is the same install whether one person is
at the keyboard or an unattended session is. This second layer adds
autonomous, cooperative multi-session workflow governance on top of it:
`create-agent-rig init --with-workflow` (or `create-agent-rig <dir>
--with-workflow`) installs it; a plain re-run of `init` with no flag never
drops a layer a previous run already recorded, so an existing rig can keep
what it has.

It replaces the plain `PLAN.md` reading above with a driven queue: the `loop`
skill selects through the adapter at `.claude/scripts/queue/index.mjs`, which
reads whichever queue `.claude/queue.json` names — the Agent queue in
`PLAN.md` by default, issues in this repository once it has a remote. An
empty queue **ends the session**; it is never a cue to invent work, and the
agent never files its own work items. It also brings the `pr-ship` skill and
the PR-lifecycle helpers that automate the gate above: `decision-router.mjs`
(lane selection), `detect-missed-gate.mjs` (the Tier-2 sweep autonomy.md
describes), `reconcile-external-prs.mjs` (sorts merged PRs into queue /
external / owner-directed lanes), and `run-state.mjs` (the deploy
HEALTHY/REGRESSION verdict autonomy.md's "Post-deploy verification"
describes) — plus the run journal, revalidation and claim-records.

**A queue claim is advisory, not a lock.** Selecting an item through the
adapter records that a session took it up; nothing about the mechanism is
transactional, and nothing prevents two sessions from claiming the same item
— that is exactly why distributed multi-controller execution stays
experimental. Board status remains task authority the same way it always
was: this layer reads and writes it, it does not arbitrate it. Git/worktree/PR
remains code authority regardless of whether this layer is installed.

Revalidation and claim-records carry their own freeze, independent of this
layer's experimental status: their behavior does not change before the date
recorded in this project's own tracker, and an install of this layer may only
relocate them, never alter what they do (`docs/decisions/workflow-layer-split.md`).

## Four things this install left for you to finish

All four are one-liners, and all four are inert until you do them.

1. **The Definition-of-Done gate has nothing to run.** `gate-stop-dod` executes
   the commands listed in `.claude/hooks/dod-checks.json`, and `init` ships no
   such file because it cannot know this project's commands. Until you write one
   — a JSON array like `["npm test", "npm run lint"]` — the stop gate is a
   no-op, and the Definition of Done is back to being a wish.
2. **The elevated-path list below is a seed, not a survey.** It names only what
   every repo has. Everything else is yours to add.
3. **Five runtime paths need a `.gitignore` line each**, and `init` cannot add
   them — it installs into your repository and does not edit files it did not
   bring. If any are missing, add only the missing entries:

   ```
   # the tier the last close recorded
   .claude/queue.state.json
   # the board this checkout runs on, when the config declares several
   .claude/queue.board
   # gate rounds, one count per branch
   .claude/gate-rounds.json
   # task worktrees
   .claude/worktrees/
   # the run journal's per-run trace
   .claude/runs/
   ```
   Each comment is on its own line, and that is not formatting: git treats `#`
   as a comment **only at line start**, so a trailing `# …` becomes part of the
   pattern and the line then ignores nothing. It fails silently — you find out
   when the file lands in a commit.

   The first one matters more than it looks. It is how the loop rations the
   elevated tier — never two elevated items back to back, where the tier that
   spaces is the one that EXECUTES (a close whose elevated paths are all
   documents records `elevated-prose` and clears the ration) — and it is
   **per-checkout state, not shared configuration**. Committed, one machine's
   tier starts deciding another's, and a merge conflict lands in a file nobody
   edited on purpose. `.claude/queue.json` is the opposite: that one is
   configuration and belongs in the repository.

4. **`doctor` reads two files this install does not ship.**
   `node .claude/scripts/doctor.mjs` decides who owns each hook from
   `.claude/.rig-manifest.json` — which `init` wrote next to the files it
   installed, so commit it — and reads exemptions from
   `.claude/doctor-exemptions.json`, a file you author (`{ "<path>": "<reason>" }`)
   only when a hook you own is deliberately left without a test neighbour.
   Without the manifest every hook that has no test neighbour reports `unknown`,
   which is not a pass.

## The elevated paths of this project

Tier 2 in `.claude/rules/autonomy.md` names *kinds* of change. This block names
the **paths** in this repository where those kinds live, and
`.claude/scripts/detect-missed-gate.mjs` reads it — so a path that is not declared
is a path the gate sweep cannot see.

```elevated-paths
.github/workflows/
scripts/
.husky/
package.json
templates/agent-os/universal/.claude/hooks/
templates/agent-os/universal/.claude/scripts/
templates/agent-os/universal/.claude/settings.json
templates/agent-os/universal/.claude/agents/
templates/agent-os/universal/.claude/skills/
templates/agent-os/universal/.agents/
templates/agent-os/universal/.codex/
templates/agent-os/universal/AGENTS.md
templates/agent-os/universal/.claude/rules/
templates/agent-os/universal/CLAUDE.md
.agents/
.codex/
AGENTS.md
templates/agent-os/universal/docs/decisions/
docs/decisions/
contracts/
scripts/dogfood/
.claude/
```

They are there because they are what *disarms* the rest: a merge that rewrites
the Never tier, unwires a hook or edits what CI runs should never pass
unreviewed.

**Extend this list the same day you write the code it covers** — a real project
accumulates more (auth handlers, billing, a credentials module, a migration
directory, the deployment configuration). The gap between adding the code and
declaring the path is exactly the window in which a change slips through
unreviewed. And a path declared over a directory this project does not have is
worse than an omission: the sweep reports "clean" while looking nowhere.

The declaration is **composed, not centralised**: the sweep unions this block
with every `elevated-paths` block in `.claude/rules/`, so a rule file can
declare the paths that belong to it.

Nothing about this list is retroactive. Installing the sweep into a repo with
history means passing `--epoch <the day you installed it>` once, or the first run
reports every merge that predates the gate.

## Foot-guns

- Don't weaken a failing test to get green — a red check is information, and
  test integrity is a blocking review finding.
- Don't answer "is this repo healthy?" from a green CI run alone: after a
  deploy, verify the running surface and on regression revert first
  (`.claude/rules/autonomy.md`, "Post-deploy verification").
- Don't extend the rulebook by writing more prose. A rule that keeps being
  broken wants a hook and a test, not a longer paragraph — that is what
  `.claude/rules/invariants.md` is for.

---

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
- `node scripts/sync-agent-os.mjs` — compose the Claude rulebook and regenerate
  its derived Codex projection (`AGENTS.md`, `.agents/`, `.codex/`) from the
  templates; `scripts/sync-codex-adapter.mjs --check` verifies that projection.

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
   set is `CLAUDE.md`, everything under `.claude/`, the Codex projection
   (`AGENTS.md`, `.agents/`, `.codex/`), **`journal/README.md`** and
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
