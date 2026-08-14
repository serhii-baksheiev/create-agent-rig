# PLAN — `create-agent-rig` (project generator: agent-os + skeleton)

> Working plan for Claude Code. Phases are incremental: each one ends in something **that works**, not a half-built layer. The decisions in §2 are locked — do not re-litigate them without new data.
>
> **Status (0.4.0, published).** Phases 0–7 are all shipped, plus the factory extraction (§7.5, §7.6), the port brief (§7.7) and the upgrade brief (§7.8). **Published on npm** — `0.1.0` through `0.4.0` are live and `0.4.0` is `latest`; `npx create-agent-rig` resolves from the registry, and the git path still works unchanged. An installed rig is brought forward by `create-agent-rig upgrade` rather than by a procedure in a release note. `0.4.0` shipped **untagged** by the owner's decision, which the Operator queue carries as a live cost for 0.5.0. Detailed field notes and per-brief findings live in `NOTES.md`; this file is the map, `NOTES.md` is the log.

---

## 1. What this is and who it is for

A CLI that scaffolds a new project with (a) an **agent operating system** — rules, gates, subagents, hooks, skills, DoD — and (b) a **code skeleton** for the chosen target.

**Users, by stage:**

1. **Now — the author.** Single user → zero options, edit anything in place.
2. **Later — 2–3 colleagues.**
3. **Possibly — an internal showcase at work** (conditional; see §7 Phase 7).

**What is valuable here (and what is not).** A monorepo scaffolder is a commodity — any team builds one in a week. The rare part is the **agent operating system**: autonomy tiers, mechanically enforced invariants (hooks), subagent gates, skills that produce verdicts, post-deploy verification, stop rules. The showcase (and the portfolio value) rests on that layer; the skeleton is the stand it sits on — the smallest thing that makes the rules visible in action.

---

## 2. Locked decisions

| Decision | Rationale |
| --- | --- |
| **Two layers — `agent-os/` + `skeleton/` — physically separated from day one** | Their portability differs **by nature**: rules are stack-neutral, a skeleton is shaped by its target. Splitting later costs more |
| **Cloud-agnostic = several coherent targets, NOT one parameterized skeleton** | An abstraction over DynamoDB/SQS/Cognito yields either a lowest-common-denominator or a leaky facade (usually both). A new target is a new directory, not a new abstraction layer |
| **Templates are real, runnable projects** — never fragments | The only defence against rot: the template is exercised by its own tests **in place** |
| **Generation = tree copy + token substitution.** No template engine | Transparent, diffable, and it keeps the template runnable |
| **Zero options at the personal stage** | The axes of variation are unknown (N=1). An option without data is maintenance without benefit |
| **Primary flexibility mechanism = subtraction** | Deleting what you don't need requires zero design and zero maintenance |
| **`agent-os/` is authored fresh, as a statement of the approach** | Not copy-pasted out of a private work repository — see §9 |
| **The tool's own repo runs under its own `agent-os`** | Dogfooding: if the rules are awkward, you find out first. Since the repo has a remote + CI, it also follows its own PR flow (branch per task, merge via PR) |
| **Package name `create-agent-rig`, unscoped** | npm convention: a `create-*` package is invoked as `npx create-agent-rig my-app` with **no install** (the `create-react-app` pattern). A scoped name breaks the short `npx` form — keep it unscoped. (`create-agent-factory`, the earlier name, was taken on npm.) |
| **Distribution: git first, registry once it is used** | `npx github:<user>/create-agent-rig my-app` works with no registry at all, which is what made the personal stage cheap. The registry followed once the tool left this machine — **both paths are supported and both are tested** (the pack-path e2e is the gate; the git path cannot catch pack-path regressions) |

---

## 3. Repository layout (as built)

```
create-agent-rig/                    — root package: the publishable unit (bin → dist)
  packages/cli/                      — the generator (TS, tested; private inner package)
    src/
      index.ts                       — bin: create <dir> [--target --no-git --no-color --version] | init | upgrade
      commands/create.ts             — generate: compose layers, substitute, git baseline
      commands/init.ts               — install the PROCESS layer into an existing repo
      commands/upgrade.ts            — refresh an installed rig: replace what it wrote, report the rest
      lib/
        copy-tree.ts                 — tree copy + ignore list + mode preservation
        substitute.ts                — token + @app/ + gitignore→.gitignore substitution (and its inverse)
        manifest.ts                  — .claude/.rig-manifest.json: what was installed, and its hashes
        history.ts                   — the shipped hash table of released versions (bootstrap)
        install-set.ts               — the agent-os layer as files: rel, source, content
        targets.ts                   — target registry (aws-serverless, node-service)
        composition.ts               — layer-collision policy (disjoint paths)
        prompts.ts                   — interactive target selection (TTY only)
        colors.ts                    — 3-colour semantic palette (NO_COLOR aware)
        summary.ts                   — governance final screen, counted from the tree
      templates.ts                   — resolve paths into templates/
    test/                            — composition, copy-tree, create, init, prompts, substitute
  templates/
    agent-os/
      universal/                     — stack-neutral (process + architecture)
        CLAUDE.md                    — the map
        PLAN.md                      — two-queue work convention (Agent / Operator / Journal)
        layers.json                  — classifies every universal file: process | architecture | meta
        .claude/
          rules/                     — architecture.md, workflow.md, autonomy.md, invariants.md
          agents/                    — test-writer, code-reviewer, security-scanner,
                                       prose-reviewer
          hooks/                     — guard-core-purity, guard-web-boundary, block-no-verify,
                                       guard-bash (Never tier + kill switch),
                                       gate-stop-dod (Stop), inject-rules (SessionStart)
          scripts/                   — stop-flag (the brake, one implementation),
                                       detect-missed-gate, reconcile-external-prs, preflight,
                                       queue/{core,plan-md,github-issues,jira,index}
          skills/                    — pr-ship, loop, worktree-task, new-invariant,
                                       check-premises
          queue.json                 — which queue adapter this project uses
          settings.json              — wires the hooks (PreToolUse ×4, Stop, SessionStart)
      stack/
        node-ts/.claude/             — rules/node-ts.md + hooks/dod-checks.json (DoD gate config)
        aws-cdk/.claude/             — rules/aws-cdk.md (+ its own elevated-paths block),
                                       agents/cdk-diff-reviewer,
                                       skills/{post-deploy-verify,ro-debug}
    skeleton/
      aws-serverless/                — packages/{core,db,shared}, services/{api,worker},
                                       apps/web, infra/{app-stack,web-stack}, .github/workflows/{ci,deploy}
      node-service/                  — same layers, no cloud; serves the web bundle;
                                       scripts/build-artifact.mjs, .github/workflows/{ci,deploy}
  test/
    e2e/                             — generate → install → run the generated project's checks
    template/                        — hook blocking, composition, consistency, packaging, deploy, …
  scripts/
    prepare.mjs                      — build the CLI on install (git/tarball paths)
    sync-agent-os.mjs                — compose this repo's CLAUDE.md + .claude/ from templates
  CLAUDE.md, .claude/                — this repo's own agent-os (generated by the sync script)
  NOTES.md                           — the running log: field notes + per-brief findings
```

---

## 4. Layer 1 — `agent-os/` (as built)

`universal/` is stack-neutral and split on a **second axis** (see `layers.json`):

- **process** — travels to any repo: TDD, gates, autonomy tiers, stop rules, DoD, PR flow, the `pr-ship`/`loop` skills, the `gate-stop-dod`/`inject-rules`/`block-no-verify` hooks;
- **architecture** — assumes the generated shape: core purity, mandatory usecase, import boundaries, the `guard-core-purity`/`guard-web-boundary` hooks, `architecture.md`;
- **meta** — `CLAUDE.md`, `settings.json`.

This split is what makes `agent-rig init` (§6) safe — it installs only the process layer into an existing repo.

**What ships in `universal/`:**

- **Rules** — `autonomy.md` (tiers: self-merge / human-review / never; stop rules incl. N-strike, flaky≠retry, invariant conflict, session-staleness; post-deploy verdict), `workflow.md` (TDD, branch discipline, PR flow, review-context isolation, DoD), `architecture.md` (layers, mandatory usecase, core purity, the web boundary).
- **Agents** — `test-writer` (writes the failing test, cannot implement), `code-reviewer` (blocking checklist, incl. a change that contradicts its queue item), `security-scanner` (auth/secrets/parsing/outbound triggers), `prose-reviewer` (the documents that instruct agents: overstated enforcement, dead references, rules that contradict each other, stale limits, domain that must not travel).
- **Hooks** — six, wired in `settings.json`:
  - `guard-core-purity` (PreToolUse) — refuses I/O/clock/randomness/env in `packages/core`;
  - `guard-web-boundary` (PreToolUse) — refuses `db`/service imports from `apps/web`;
  - `block-no-verify` (PreToolUse) — refuses pre-commit bypass (quote-aware,
    including a `-n` inside a combined short-flag cluster);
  - `guard-bash` (PreToolUse) — the part of the Never tier a text scan can
    decide, plus the kill switch; the file states exactly what it does not see;
  - `gate-stop-dod` (Stop) — refuses to end the session while a DoD check fails (anti-loop via `stop_hook_active`, fails open);
  - `inject-rules` (SessionStart) — re-injects `autonomy.md` so the rules survive compaction/resume.
- **Skills** — `pr-ship` (pre-merge gate → SHIP/HOLD), `loop` (unattended driver
  over the queue adapter; "queue empty → end, do not invent work"),
  `worktree-task` (isolation when a second session may run), `new-invariant`
  (the generator for the hook+rule+test pattern), `check-premises` (the item's
  claims about the code, checked before the failing test).
- **Scripts** — the two gate sweeps that run *outside* any session
  (`detect-missed-gate`, `reconcile-external-prs`), `preflight`, the queue seam
  (`queue/core.mjs` pure + three adapters), and `stop-flag.mjs` — the kill
  switch, with exactly one implementation because two disagreed.

**Stack layers:** `node-ts` (TS/vitest conventions, the merge-criterion command, the `dod-checks.json` the Stop gate runs) and `aws-cdk` (IAM/DLQ/single-table rules, the `cdk-diff-reviewer` deploy-gate agent, the `post-deploy-verify` skill).

**Split criterion:** a rule is universal if it can be applied without knowing where the project is hosted; process vs architecture is whether it can be applied without knowing the project's *shape*.

---

## 5. Layer 2 — `skeleton/<target>/` (as built)

Each target is a **coherent, self-contained, working** project. No code is shared between targets: duplication here is **cheaper** than abstraction.

### 5.1 `aws-serverless` (default target)

The smallest project that proves the architecture — every layer visible, every gate able to fire:

- `packages/core/` — pure: zod schemas + `createNote()` (no I/O; hook-defended);
- `packages/shared/` — logger, `loadEnv(zod)`, typed errors;
- `packages/db/` — `NoteModel`, the single place that touches the DynamoDB SDK;
- `services/api/` — **two** routes through every layer: `POST /notes` and `GET /notes` (payload → handler → usecase → model);
- `services/worker/` — one SQS consumer + DLQ + alarm;
- `apps/web/` — a static Next export that imports the **same** core schema the server trusts (client + server validation through one function);
- `infra/` — CDK: `AppStack` (table, queue+DLQ+alarm, **three** lambdas, HTTP API with CORS, least-privilege IAM) + `WebStack` (S3 + CloudFront for the static bundle);
- `.github/workflows/` — `ci.yml` (lint/typecheck/test/build/synth) + `deploy.yml` (**dev** deploy via OIDC, no static keys, skips cleanly with no credentials);
- tests at every layer (core exhaustively).

**Request path:** `payload → handler → usecase → model`. The separate *service* layer from the early draft was deliberately dropped — in the minimal skeleton a usecase is one domain function plus one model call, and a pass-through service is ceremony. `architecture.md` says when a service layer would earn its place; a consistency test keeps the chain stated identically everywhere.

**What it demonstrates:** the mandatory usecase layer, core purity (and the hook that defends it), the web import boundary (and its hook), DLQ discipline, least-privilege IAM, OIDC deploy, TDD.

### 5.2 `node-service` (second target)

The same layers with no cloud: a `node:http` server (which also serves the built web bundle — no second runtime), a `JsonFileNoteStore` behind the same model boundary, a spool-directory queue with a retry budget → DLQ dir + ALARM log line, the worker as a process. Its "deploy" is `scripts/build-artifact.mjs` — an esbuild bundle (`dist/`) that runs and boots, shipped nowhere (destination is the owner's choice). agent-os composition: `universal` + `node-ts` (no `aws-cdk`, so no `post-deploy-verify`).

### 5.3 Substitution mechanism

- The template uses a **valid** placeholder scope `@app/` so it runs as-is; the CLI rewrites `@app/` → `@<scope>/`.
- Tokens: `__PROJECT_NAME__`, `__PROJECT_SCOPE__`, `__REGION__` — the set is small and documented.
- Dotfile trick: templates store `gitignore` un-dotted (npm strips `.gitignore` from tarballs); the CLI maps `gitignore` → `.gitignore` on generation.
- Substitution applies to file **contents and file names**; file **modes** are preserved; binary files are copied untouched.

---

## 6. Flexibility model (staged)

| Level | Mechanism | Status |
| --- | --- | --- |
| **1. Subtraction** | The generated project is yours — delete what you don't need | Always the default |
| **2. Target selection** | `--target aws-serverless \| node-service` — coherent alternatives, registry + interactive picker | **Done** |
| **3. Optional modules** | `--with-<feature>` inside a target | Still gated on Phase 11 data — **not built** |
| **(reach) `agent-rig init`** | Install the process layer into an *existing* repo (dry-run, never clobbers CLAUDE.md) | **Done** — grows where the tool applies without growing template surface |
| **(reach) `agent-rig upgrade`** | Bring an installed rig to this version: replace what the rig wrote and nobody edited, report everything else | **Done (0.4.0)** — no auto-merge, by decision: a rig the loop obeys must never change meaning silently |

🔴 Level 3 is allowed **only** for genuinely detachable capabilities and **only** after real usage shows someone needs the choice. Until then: subtraction. No `--with-*` option exists yet, by design.

---

## 7. Phases — all shipped

| Phase | What | State |
| --- | --- | --- |
| **0** | Bootstrap: pnpm workspace, TS, vitest, eslint/prettier, pre-commit, CI, draft CLAUDE.md | ✅ |
| **1** | Walking-skeleton CLI: copy-tree, substitute, create, bin; e2e (temp dir + tarball + git install) | ✅ |
| **2** | `agent-os/universal`: CLAUDE.md map, rules, gate agents, blocking hooks, DoD/PR — authored fresh; the hook demonstrably blocks a violation | ✅ |
| **3** | `skeleton/aws-serverless`: all layers + tests + CDK + CI; anti-rot (tested in place AND after generation) | ✅ |
| **4** | universal ↔ stack seam: `node-ts` + `aws-cdk`; CLI composes `.claude/`; universal is provider-free (grep test) | ✅ |
| **5** | Dogfooding: this repo's CLAUDE.md + .claude/ are composed from `templates/agent-os` by `sync-agent-os.mjs`; drift fails the suite | ✅ |
| **6** | Second target `node-service`; `--target` + interactive; **universal applied with zero edits** — the seam held | ✅ |
| **7** | Showcase: `demo.sh` (generate → gates → hook blocks live → run), governance README | ✅ (registry publish + recorded demo remain — §11) |

### 7.5 Beyond the plan (landed in 0.2.0)

Work driven by later briefs, each closing a rule the template already stated (detail in `NOTES.md`):

- **Distribution hardening** — file-mode preservation, the `gitignore`→`.gitignore` trick, per-template `.npmignore`, a pack-path e2e (both targets), the inner package locked against publication, full manifest (LICENSE, keywords).
- **agent-os v2** — skills (`pr-ship`, `post-deploy-verify`), the `cdk-diff-reviewer` agent, review-context isolation + session-staleness rules, the quote-aware `block-no-verify` fix.
- **Web frontend** — `apps/web` (static Next, plain by design) proving core purity as physics; the `guard-web-boundary` hook; `GET /notes`; `WebStack` (S3+CloudFront); the shared-validation test.
- **CLI polish** — the governance final screen (counted from the tree), `--version`, non-TTY correctness, the colour palette, `git init` baseline, the restructured README.
- **Enforcement hooks + reach** — `gate-stop-dod` (Stop), `inject-rules` (SessionStart), the process/architecture seam (`layers.json`), `agent-rig init`, the `loop` skill + two-queue `PLAN.md`.
- **PR flow** — branch discipline + the provider-neutral merge criterion in `workflow.md` (concrete command in `stack/node-ts`).
- **CD** — dev deploy workflows (aws-serverless: OIDC `cdk deploy`; node-service: artifact build), `post-deploy-verify` scoped to what the skeleton provisions.

### 7.6 The factory extraction (landed in 0.3.0)

Seven increments from `agent-rig-extraction-brief.md`, which asked what could move
out of a real project's `.claude/` so a scaffolded project arrives with a working
autonomous loop rather than an empty directory. Its thesis — **extract mechanisms,
not rules** — is what shaped every decision below.

- **Tier A mechanisms** — `guard-bash` (the Never tier made mechanical, plus the
  kill switch as a real file), the `worktree-task` skill, a journal template with
  named fields. Shipped unconditionally rather than behind the brief's proposed
  `--with-factory` flag: §2 locks zero options and §10 forbids `--with-*`, so
  flexibility stays subtraction.
- **The gate sweeps** — `detect-missed-gate` and `reconcile-external-prs`, ported
  first because extracting a process without the mechanisms that detect its drift
  exports the hole. The elevated-path declaration is **composed** from `CLAUDE.md`
  plus every `.claude/rules/*.md`, so a stack layer declares the paths that only
  exist in its shape.
- **The invariant pattern** (`rules/invariants.md` + the `new-invariant` skill) —
  the brief's central point: the reusable thing is one pattern (stated invariant,
  mechanical check, test for the check), not any one rule. The hooks that ship are
  labelled examples, deletable.
- **The queue seam** — a pure `core.mjs` above it (filters, blocker resolution,
  tier ration, sort, stop conditions) and three adapters below (`plan-md` by
  default, `github-issues`, `jira`). `plan-md` is the default rather than the
  brief's GitHub Issues: a freshly generated project has no remote, and a loop
  that cannot read its queue on day one never runs.
- **The two invariants the brief marks load-bearing**, each tested from both
  directions: blockers resolve from **links, never labels**; and the agent never
  creates its own queue items (proposals land in `triage`, excluded twice over).
- **`aws-cdk` extras** — the `ro-debug` skill and the transferable AWS knowledge
  folded into the existing one-page rulebook rather than three new rule files.

**Two review passes, seven reviewers, on the extraction itself.** The first
returned HOLD on a forgeable gate verdict (a PR body could suppress its own
finding), a queue write that deleted the wrong line, and writes that threw on
success. The second, over the fixes, returned HOLD again — on a kill switch fixed
in one file and left open in its sibling, and on a guard that could be stalled
into failing open. Both rounds are in the history; the lessons that generalise are
now rules in `invariants.md` (state your limits *and test them*; match a rule's
precision to the cost of a false positive; one mechanism, one implementation).

### 7.7 The port brief (landed in 0.3.2)

Process work carried **into** this repo from the project the rulebook was
extracted for: a premise check before the failing test, a fourth reviewer for the
prose layer, a sixth blocking item for `code-reviewer`, and three queue-hygiene
checks (which forced the `Ticket.body` decision — nullable, in the neutral shape,
so one pure function serves three adapters).

Two things are worth keeping from how it went.

**For one layer the direction is inverted.** `guard-bash`, `detect-missed-gate`
and the `loop` skill here are ahead of the downstream copies by hundreds of lines
of checks. That rule now lives in the repo-specific rules rather than only in a
journal: ideas travel in, files do not.

**The expensive findings were all in code already believed to be working** — an
inherited `GIT_DIR` writing a generated project's baseline commit into the
caller's repository, a gate sweep blind to this repository's own rulebook, a
quadratic regex reintroduced beside its own documented fix, a hygiene check
firing on the queue's healthiest items. Nine reviewer passes over seven PRs; seven of
the nine returned HOLD, and only one PR cleared its gate on the first pass. None of those defects was in what the
brief asked for; all of them were found by a gate or by running the thing for
real.

### 7.8 The upgrade brief (landed in 0.4.0)

An installed rig could not be brought forward: `init` adds what is missing and
keeps what is there, so a file a release **changed** never arrived. 0.3.2 shipped
with six of them listed in the CHANGELOG and a manual procedure, which is a
maintenance cost per release per user, growing.

`upgrade` replaces what the rig wrote and nobody touched, and **reports**
everything else — no merge, no patching. The mechanism is an install manifest
(hashes of what was written) plus a table of every released version's hashes
generated from the git tags, which is what makes rigs installed before the
manifest existed upgradable at all.

Three things worth keeping from how it went.

**The reviewers found the whole security surface, and the author had not looked
for it.** The manifest is meant to be committed, so it arrives through a pull
request like any other file — and its values were substituted into paths. Both
findings came with working exploits: a write outside the repository, and an
arbitrary directory read exfiltrated into it. The lesson is not "validate input";
it is that a file designed to be committed is **input from whoever committed it**.

**A command that writes into somebody's repository has to earn every write.**
Three separate defects were the same shape: one existing file was enough to
call a directory a rig (an unrequested 30-file install into any repo with a
`CLAUDE.md`); an absent file with no manifest was treated as new (restoring
rules an owner had deliberately deleted — the ones `invariants.md` tells them to
delete); and `--dry-run` promised wiring it structurally could not print.

**The brief's own justification was wrong in one place, and saying so was the
fix.** U-1 asked for a write-back because a stale blocker would stall selection.
It cannot: blocked state is re-resolved from the blocker on every query. The
paragraph shipped anyway, with the true reason — whether anyone *looked* is the
one thing no query can answer — and with the action changed from an edit to a
report, because editing is what the hygiene rule forbids.

---

## 8. Verification strategy (as built)

The scaffolder is kept from rotting by:

1. **Templates tested in place** — each skeleton is a valid project; CI runs `pnpm check` per target (`template-aws-serverless`, `template-node-service` jobs).
2. **The generated project tested after generation** — the e2e suite generates cold and runs the generated project's own `check` (install → lint → typecheck → test → build → synth), for **both** targets, and via the **pack path** (tarball install), not only git.
3. **A per-target matrix** — both targets exercised in CI and e2e.
4. **A rules-composition check** — `universal` free of any provider mention (grep), `.claude/` assembled without path collisions, the layer-chain stated identically everywhere.
5. **Hook / gate tests** — every hook's blocking behaviour under test; the DoD stop-gate and rule-injection behaviour; the deploy workflows' OIDC/no-static-keys/degrade-cleanly invariants.
6. **A weekly lockfile-free run** — `template-freshness.yml` reinstalls each template without a lockfile and runs its checks (the primary early-warning channel now that Next is in the stack).

Test surface: 9 CLI unit files, 20 `test/template/*` files, 6 `test/e2e/*` files (579 tests). Items 1–2 are mandatory in CI.

---

## 9. 🔴 Provenance constraint for `agent-os/`

`agent-os/` is written as an **independent statement of the approach**: tiers, stop rules, gate structure, DoD — these are a method, and a method can be articulated from scratch. **Do not** copy files out of a private work repository.

In practice: open an empty file and write the rule in your own words rather than `cp`. This also has a side benefit — a rule rewritten deliberately usually comes out cleaner than the original.

---

## 10. What not to do

| Don't | Why |
| --- | --- |
| Build a "cloud-agnostic storage/queue" abstraction | Lowest-common-denominator or leaky facade. Portability comes from coherent targets |
| Add `--with-*` options before Phase 11 data exists | The axes of variation are unknown; every flag is maintenance without benefit in every target |
| Clone an existing product into the skeleton | The skeleton proves the architecture; it does not reproduce features. A big skeleton is a big maintenance bill |
| Use a template engine (handlebars/ejs) | It breaks "the template is a working project"; token substitution is enough |
| Copy `agent-os` from the work repository | See §9 |
| Make a second **cloud** the next target | Expensive, and it proves the seam no better than `node-service` |
| Let `agent-os` only ever grow | It must be able to **lose** rules too — no append-only "lessons" file, no twelve-skill packs. Restraint is the default |

---

## 11. Open questions / owner actions

- ~~Tool name~~ — **decided: `create-agent-rig`, unscoped.**
- ~~Second target~~ — **decided: `node-service`** (plus a static web frontend in both targets).
- ~~Repository hosting~~ — **decided: `github.com/serhii-baksheiev/create-agent-rig`** (remote + CI live).
- **npm registry publish** — done through `0.4.0`, which is the current `latest`. Each release is an owner action, because `npm publish` needs 2FA and is irreversible: an agent prepares the release and stops at that command. The release checklist lives in `CHANGELOG.md`.
- **A recorded demo** (asciinema/GIF of `demo.sh`) for the README — owner action; the static frame is in place.
- **`--with-*` options / a third target** — deliberately deferred; only unlock on real Phase-11 usage data (§6, §10). (The `worktree` rule is no longer parked — `worktree-task` shipped in 0.3.0.)
- **Side task (outside this repo):** audit the reference project's own skills for `context: fork` + `allowed-tools`.

---

## Agent queue

Work an agent may take autonomously (Tier 0/1 — `.claude/rules/autonomy.md`).
One line each, most valuable first; delete a line when it lands. This repo runs
the `plan-md` adapter (`.claude/queue.json`), so **this heading is load-bearing**
— renaming it makes the queue unreadable rather than empty.

Current contents decompose the Flowa→rig port brief (`AR`, v2 of 2026-08-01) — an
owner-supplied document that lives outside this repository, so an item citing an
`AR-n` the queue does not list (`AR-3`'s other two checks, `AR-4`) points into it
and is stated in full where it matters below. The brief's 🔴 rule governs every
one of them: **nothing here brings a Flowa copy of `guard-bash`,
`detect-missed-gate` or the `loop` skill into this repo** — the versions here are
the older-and-larger ones, and "syncing" them backwards is a regression of
hundreds of lines of checks.

The `[elevated]` marker is not decoration: it is what lets `selectNext` space
elevated work apart (`queue/core.mjs`), and an item known to touch a path in
`CLAUDE.md` → `elevated-paths` declares it up front rather than re-tiering
mid-work.


The `AR3-n` block decomposes the Flowa→rig port brief **v4** (2026-08-14,
`rig-port-brief-v4-2026-08-14.md`), written after a full two-sided inventory. It
**supersedes the AR2 block** of brief v3 — AR2-2…AR2-7 are folded in and
renumbered, and **AR2-1 is NOT here**: it stays escalated in the Operator queue
exactly as the run left it. v2's 🔴 rule stands unchanged.

🔴 **Read this before taking anything from the block: an all-elevated queue
used to report itself as EMPTY.** ✅ **That half is fixed** — AR3-35 (#42) split
the verdict, so a queue held back now stops as `nothing-selectable` and names
how many items are held and by what. The block is not in that shape anyway —
**7 of its 33 items are marked `[elevated]`** (AR3-2, AR3-3, AR3-6, AR3-14,
AR3-15, AR3-16, AR3-36), so **by marker** there is normal work to interleave
with, which is what the rule below asks for. ⚠ **By declared path there is
none** — the other 26 all name artefacts under `.claude/hooks/`, `scripts/`,
`skills/`, `rules/`, `agents/` or `settings.json` in the template tree, every
one of them declared elevated in `CLAUDE.md`. Which of the two the ration
should read is AR3-36's open question, and it is the owner's. ⚠ **The ration
itself is still unwired either way:** nothing
writes `config.lastCompletedTier`, so spacing has never fired between tasks and
the interleaving below is upheld by the session reading it, not by the filter.
AR3-36 is the fix and is first in the block. The original measurement stands as
the record of what the day the seam is wired would have looked like —
`selectNext(8 × elevated, {lastCompletedTier:'elevated'})` returned
`candidates: 0, skipped: 8`, and the stop condition then read `queue-empty`
with eight items open. The markers are not
negotiable (understating a tier is a failure recorded twice here). **Interleave
normal work deliberately**, and note that brief §3's sequencing is a *dependency*
order, not a *take* order. The two rulings this needs are in the Operator queue.

v4 §4 is not decoration — five things this repo does better are named there so a
port does not regress them (`context: fork` on `check-premises`, the queue seam,
`upgrade`+manifest, the generative `new-invariant`, and 🔴 **the human journal,
which already exists here**: every journal item below adds beside `## Journal`
and its `cost` block, replacing none of it). Every item lands **above** the queue
seam, never beside it. §7a of the brief carries ten corrections that ride INSIDE
these items — read them before taking AR3-1/2/4/6/7/13.

- AR3-36 [elevated]: **wire the tier-spacing seam — take this next.** The close step writes the closed item's tier where `selectNext` reads it (`config.lastCompletedTier`). 🔴 **A defect, not a gap:** the filter exists and is correct, but `.claude/queue.json` has carried only `{"adapter":"plan-md"}` since the first commit, so it has been called with `null` every time and **tier spacing has never fired between tasks in this repository** — the rule has been kept by whichever session read it, which is exactly the guarantee a mechanical filter exists to replace. Same family as `stage-guard`'s `red` that never blocked (AR3-3) and a reviewer regex that could not match its own required reviewer: *a filter whose input nobody supplies is indistinguishable from a filter that agrees with you*, and neither a green suite nor a reading of `core.mjs` shows it. **Proof must be behavioural, not structural** — a test asserting the field is written is the existence test v4 keeps rejecting. **Scope:** the writer and the reader must land together, so this is one change, not two. It edits `templates/agent-os/universal/.claude/skills/` and `.../scripts/` (both declared) — never the synced `.claude/` copies, which is why the marker is `[elevated]`; the tier reason is the template tree, not the copy.

  🔴 **One thing must be decided before the failing test, and this item does NOT decide it: which tier does the close step write?** `plan-md.mjs:110` derives `tier` from the `[elevated]` marker and from nothing else, while `autonomy.md` says *"the tier is decided by what the change touches, not by what the task said it would touch"* and `loop` §2 calls the marker *"a pre-filter, not the authority"*. The two readings need different code and only one of them has a red fixture:

  - **the marker** — mechanical, already on the ticket. But then the observation the brief calls red is not red: AR3-35 carried no marker, so a correctly wired filter would *also* have offered `AR3-2` next. Under this reading the seam is real and the cited evidence for it is not, and a new red fixture is needed.
  - **what the change turned out to touch** — matches the stated rule, and `detect-missed-gate.mjs` already computes exactly this from `elevatedPathsIn`, so it is mechanical too, not a judgement. Under this reading AR3-35 *was* elevated (its diff crossed `templates/agent-os/universal/.claude/scripts/`; #42 carries `human-review`), the cited observation is genuinely red, and the marker becomes advisory.

  ⚠ **The second reading has a consequence the owner should price before choosing it:** by declared paths, 26 of the 33 items in this block are marked `normal` while every artefact they name sits under a declared elevated path, so there would be **no normal work in this block at all** — the ration would have nothing to interleave with and would stop the run the first time it fired. That is queue hygiene, reported and deliberately not corrected in passing; the marker audit is in the journal. Provenance: the loop's own `triage` proposal, promoted by the owner in brief v4 §10, moved here unchanged in substance
- AR3-2 [elevated]: `doctor` — the harness audits itself, shipping with the test-neighbour requirement covering `.husky/` and `.claude/hooks/` from day one; exemptions are an explicit file list with reasons. Rides §7a's budget-source correction: every declared budget names where its number comes from. ⚠ **Known before the first minute, raised by the owner rather than discovered mid-work:** in a GENERATED project the hooks arrive without test neighbours BY DESIGN — `invariants.md` says so — so a literal reading flags all six hooks on every rig's first run, and the only silence is an exemption list swallowing the whole directory, which makes the requirement vacuous exactly where this item thinks it matters. 🔴 The resolution is in that same paragraph and needs no invention: the exemption *"holds only while they are untouched. The moment you edit one, its test is yours."* So the check is **"every hook the project OWNS has a test"**, and ownership is mechanically observable via `.rig-manifest.json` — matching hash → shipped and tested upstream, not a finding; modified or absent from the manifest → authored here, finding; no manifest (pre-0.4.0 rig) → reports `unknown`, never a pass. That makes this item a customer of the manifest, which v4 §4 lists as a strength Flowa has no analogue for. Narrower fallback if the owner prefers: scope hook coverage to the generator repo and drop it from what generated projects install
- AR3-3 [elevated]: `stage-guard`, the **fixed** shape only (its v3 entry condition is MET — upstream's fix landed and was verified in the shipped code) — root resolves from the work (absolute `file_path` → payload `cwd` → env last; a relative path ignored on purpose), the walk finds the nearest project ROOT not the nearest stage file (nested worktrees would adopt a stale `red`), paths made repo-relative before classification, correspondence tests rather than existence ones. Upstream's `red` never blocked one real edit from the day it shipped, under 24 green tests that all fed relative paths
- AR3-4: the run journal — per-run dir, gate verdicts to `decisions.jsonl`, the rest to `events.jsonl`, append-only, with the run-end marker from day one. Lands with a caller: a journal nothing calls records nothing. It does NOT replace `## Journal` — it is the trace behind it
- AR3-5: `decision-router` — the dispatcher in ascending order of cost (deterministic → fast-path → model), risk flags escalating ahead of all three, one journal line per verdict at every gate. **Not covered by `pr-ship`**: that is the merge-time gate that always runs the expensive path; this decides whether the expensive path is warranted, and there is no cheap lane for docs/no-code work today
- AR3-6 [elevated]: the rules wave — TDD-hatch-is-about-the-criterion (→ `workflow.md`), live-run-once-before-merge (→ `pr-ship`), every-PR-write-confirmed-by-re-read with the measured-unstable exit code (→ `pr-ship`), recon-comment-is-a-snapshot with the SHA-immutable vs silently-stale boundary (→ `loop`). ✅ The fifth (jsdom) is **NOT taken at all** — owner's ruling: it does not ship as a rule. Read standalone it invites a component layer that `architecture.md` deliberately excludes; if the caution is wanted it is ONE causal clause inside that existing exclusion paragraph, with no new home and no tier change. Provenance seals it: the rule is upstream-shaped (that repo has a web app with jsdom tests; generated projects deliberately have no such layer)
- AR3-7: the queue reads comments — an item is its description AND its comments, a superseding comment wins and the run names what it said; `jira` fetches with comments, `github-issues` reads the thread, `plan-md` returns null on the `body` precedent
- AR3-9: the proposals rule in the `loop` skill — a run that notices a seam it cannot fix **files** rather than narrates. Without it AR3-8 exists and stays empty
- AR3-10: `queue-hygiene` as a sweep that runs OUTSIDE any session, reports and never relabels — board anomalies are invisible from inside a run
- AR3-11: `validate-evals` + `evals.json` per skill — rides with AR3-2
- AR3-12: `check-toolchain` — is this checkout's toolchain usable at all; matters more in a generated project, since a fresh scaffold is where a half-installed toolchain hides
- AR3-13: `spend-report` — token accounting; last, because AR3-4 is what makes it meaningful. Rides §7a's ceiling correction (a ceiling redeclared per segment never bound)
- AR3-14 [elevated]: personal-paths validator — no tracked file carries `/Users/<name>/` or `/home/<name>/`; exemptions an explicit FILE list, never "except docs". Matters more here than upstream: a scaffold lands on machines whose paths nobody controls. Red fixture required
- AR3-15 [elevated]: harness frontmatter validator — `name` equals the directory/file name as ONE correspondence test, and `description` a non-empty INLINE scalar (a block scalar breaks every consumer reading it as one line, and `description` decides whether a skill triggers at all)
- AR3-16 [elevated]: CI supply-chain assert — every `uses:` ends in a 40-hex SHA, plus a pre-emptive guard on `workflow_run` checkout of `head_branch`. Parse the workflow structure, do NOT grep the line: upstream's first grep produced 3 false hits from `uses:` in comments and an echo string
- AR3-17: `permissions.deny` mirroring the Never tier — the hook stays enforcement and source of truth; `deny` is the belt that survives the hook failing, erroring or never being registered. A pair with a correspondence test
- AR3-18: script the live-vs-dead half of the stray-worktree rule — **this repo's own measured pain** (NOTES.md, the `GIT_DIR` incident: 19 junk commits across two branches)
- AR3-19: "verified locally" names its tools — into the DoD line beside AR3-6
- AR3-20: the enum↔copy correspondence pattern — lands as an **example invariant** for `new-invariant`, not bespoke code
- AR3-21: `prose-reviewer` gains one checklist line — a document stating a partition of a total must foot
- AR3-22: `worktree-task` gains four incident-bought sections — dependency install as an OWNED step with a toolchain check distinguishing `no-node-modules` from **`unresolvable`** (a live `.bin` symlink with the package gone made three hook tests fail *as though the hook logic had regressed*); 🔴 **a test run's exit code is not evidence — the reported count is** (`pnpm test` exits 1, `| tail -1` exits 0, and `| grep 'Test Files'` returns the right code only because the grep MISSES); declaring the stage; and the branch carrying the queue key, with recon before the first test
- AR3-23: the `loop` skill gains seven subsections — a stop with an unclosed item writes a resumption comment first; seam findings (instrument the edges, not the nodes); the second lane for externally-originated merges; a six-word human-gate status; the two things a run cannot see about itself; labelled assumptions and how they clear; and before `Done`, write findings back into the items this one blocked
- AR3-24: **token accounting with its paths** — the client writes every turn's usage into transcripts under `~/.claude/projects/`, subagents included. 🔴 The projection turns **every separator AND every dot** into a dash, so a task under `.claude/worktrees/<name>` lives at `…-repo--claude-worktrees-<name>`; a projection handling only the separator looks right against the primary checkout and silently finds nothing for every session the loop actually ran. Attribution by BRANCH not commit. Four counters plus API calls. Degrade loudly: an unparseable line is counted and reported, a missing file reported unreadable, neither folded into a zero. 🔴 Its home is **`## Journal`'s existing `cost` block** — the figures land beside "N reviewer subagents; M check runs", which is the line upstream's journal said could not be filled
- AR3-25: the run-directory convention shared by AR3-4 and AR3-24 — `.claude/runs/<run-id>/`, per-run, **gitignored** (unlike a committed evidence dir). The journal module owns no run-id policy and no rotation. 🔴 The machine trace answers what the run decided and on what basis, never whether that was right
- AR3-26: closed vocabularies and why — a typo'd gate id makes the journal unqueryable, which is the exact failure a journal prevents. The clock is INJECTED into every builder, and a label change must carry both `before` AND `after`
- AR3-27: `preflight` as a seven-item shape — the mechanical ones are scripted **because those already produced wrong diagnoses**; the rest stay a read list, NAMED in the output so silence is not mistaken for a full pass. Exit 0 whatever it finds
- AR3-28: split the upstream `core.md`-class rules instead of dropping them as "domain" — portable: no clock/no randomness, additive-optional schema evolution, the pure layer is UI-string-free, effects as the only I/O escape hatch, the loop guard, capabilities over interpreter conditionals; from conventions: no hard-coded strings for fixed sets and the annotation rule
- AR3-29: `test-writer` gains four measured rules — an artifact outside the runner's projects is still testable (`node --test` sibling); a fact in two artifacts gets ONE correspondence test; 🔴 a fake is something to ASSERT AGAINST (*a stubbed `draw: () => {}` let 41 green tests report success, and deleting the real method as a mutation check left 13 of 14 tests in that file green*); and when the subject is EXTERNAL state the report NAMES the live call it cannot make
- AR3-30: one clause out of the upstream reviewer — a factual claim in the queue item that the diff CONTRADICTS is stop-and-report, never a silent work-around and never an edit of the item to match. `check-premises` covers intake; this is the same check after the code exists
- AR3-31: `pr-ship` gains the local gate with its traps — one test process at a time, the FULL suite, the repo's own tooling tests separately, and 🔴 format-check is a PER-PUSH gate; run it from the task worktree or the formatter judges other sessions' in-progress files
- AR3-32: 🔴 the four-state rule for any third-party check — `success` is the only pass; `neutral` means read the check's BODY; ABSENT is never a pass. *Measured: on 2 of 7 PRs the app posted no status at all, and a gate that silently does not run is indistinguishable from one that passed.* Timing 1 s–6 m 50 s, so the boundary is an EVENT, not a wall-clock guess
- AR3-33: the gate's exit-code semantics where a router resolves the review gate — 🔴 `defer` is the PASS and 0 never appears; never chain on `&&`
- AR3-34: evidence is written WHILE the runs are in front of you; the validator checks FORM only (a `fail 0` summary is rejected); the no-code hatch carries a REASON. 🔴 The half no machine can check is stated rather than hidden

## Operator queue

Decisions and Tier-2 work waiting on a human. State what is needed, not what to do.

- ~~🔴 **the queue is now entirely `[elevated]`, and the loop reports that as an empty queue**~~ — **BOTH HALVES RULED, AND (b) IS NOW DELIVERED (#42).** (a) closed by the AR3 block's stated interleaving rule, markers unchanged; (b) ruled YES by the owner, queued as AR3-35, and landed: `stopConditionOf` gained `nothing-selectable`, whose line names how many items are held and by which cause. **One refinement the work forced, recorded rather than folded in silently:** the item's literal mapping was `skipped > 0` → the distinct kind, but the gate showed that counting `escalated`/`triage` items as "the queue is full, wait" makes `queue-empty` unreachable on `github-issues`/`jira` — the loop's own escalations and proposals stay open there forever. So the split is by **cause**, not by count: only the four causes that clear without new work (`blocked`, `in-progress`, `spacing`, `trigger`) mean held; the other three are parked, reported as their own number beside the verdict, and a queue whose every skip is parked is genuinely empty. Original finding kept below for its measurement.
- 🔴 *(original)* **the queue is now entirely `[elevated]`, and the loop reports that as an empty queue.** Correcting AR2-4/6/7's markers (below) made all eight open items elevated, and `selectNext` refuses an elevated item when the last completed one was elevated — correct spacing, but with no normal item anywhere the run drains exactly one item and stops. Simulated against the real module, not inferred: `selectNext(8×elevated, {lastCompletedTier:'elevated'})` → `ticket: null, candidates: 0, skipped: 8`, and `stopConditionOf({candidates:0})` → `kind: 'queue-empty'`, *"no item survives the filters … do not invent work"*. So a session ends reporting an empty queue with eight items open. Two things need a ruling, and they are separable: ~~**(a)** whether to interleave normal work so the queue drains~~ — **(a) is answered by the v4 composition: interleaving is now a stated rule of the block above, and the markers stay as they are, since understating a tier is the failure this repo already recorded twice**; **(b)** remains live — whether `stopConditionOf` should distinguish "nothing left" from "everything left is spaced out", because today the operator cannot tell those apart from the stop line and only one of them means the queue needs refilling
- ~~**decide (was AR2-3): which document gets the jsdom rule**~~ — **RULED: none. It does not ship as a rule at all** (owner, 14 Aug). Standalone it invites a component layer `architecture.md` deliberately excludes; the caution, if wanted, is one causal clause inside that exclusion paragraph. The finding that produced this ruling follows.
- *(original finding)* **which document gets the jsdom rule.** ⚠ **The brief now agrees with this finding and no longer names a target** — v4 records it as a defect the brief itself authored, twice (v3 and v4), and carries the content question rather than a path. The item routes it to "`stack/node-ts` web rules", and that section does not exist — `templates/agent-os/stack/node-ts/.claude/rules/node-ts.md` is 57 lines with no `web`, `jsdom`, `DOM` or `browser` in it. The web rules live in `templates/agent-os/universal/.claude/rules/architecture.md`. **The tier half of this question is now closed: AR-12 landed, so both candidate homes are declared elevated and the choice no longer changes the gate.** What remains is where the rule belongs and whether it is wanted at all. The rule's content needs a ruling too: `architecture.md` already puts component-level DOM testing deliberately out of scope, so "jsdom implements the DOM, not layout" reads either as reinforcing that exclusion or as licence to adopt jsdom
- ~~🔴 **AR2-1 escalated: what is the evidence key under `plan-md`?**~~ — **RULED (C) by the owner, 14 Aug: `plan-md` yields NULL.** The deciding argument came from this repo, one field over: the adapter already returns `body: null` because *null means "cannot answer" while an empty string would read as "checked, found nothing"*. Identity is the same case — a flat list has none and says so. The gate takes its no-key branch here; the full gate arrives with a tracker-backed adapter, and the price is stated rather than hidden: **this repo's CI is not the evidence gate's first home.** (B)/(D) were rejected because both re-key an item when its wording changes — and items are re-worded far more often than closed, while an orphaned evidence file is SILENT, the exact failure evidence exists to prevent; (A) because it makes the read path write to this file. The measurement that made the question decidable follows.
- 🔴 *(the finding)* **AR2-1 is escalated out of the Agent queue: decide what the evidence key is under `plan-md`, the adapter this repo runs.** The item says the key "comes from the queue adapter, never a hard-coded tracker regex" — true for `jira` (issue key) and `github-issues` (issue number), false for the default: `plan-md.mjs:89` derives `id: String(items.length + 1)`, a positional index, and `closeInPlan` deletes the closed line so every id below it shifts. **This stopped being a prediction and became an observation when AR-12 closed:** every remaining id shifted by one in that single edit — AR2-1 went 2→1, AR2-4 went 5→4, AR2-7 went 8→7. An `evidence/5.json` filed for AR2-4 yesterday names a different item today, so the gate cannot be built on this key here. Either `plan-md` gains a stable derived id (the brief says "`plan-md` items get a derived stable id" without saying derived from what — the raw title's first token is the obvious candidate, and it is the owner's call, not a run's), or the gate is specified as tracker-backed only and this repo's CI cannot be its first home. **v4 §6 call 4 now carries this question with four costed options — (A) an explicit marker written into the line, (B) a content hash, (C) no invented id and the gate is tracker-backed only, (D) this entry's first-token proposal — and records that this run measured the shift rather than predicting it.** **Escalated rather than re-aimed on purpose:** a run that rewrites an item into what it should have said has authored work for itself
- ~~**stage-guard's entry condition (port brief v3)**~~ — **MET; folded into v4 as AR3-3** (the fix landed upstream with the resolution form chosen and correspondence tests, and was verified in the shipped code). ⚠ The condition was met a day before the brief was revisited: a deferral with a condition needs a watcher, recorded in v4 §6. Original text: Flowa's SCRUM-394 must land — the fix for the hook reading its stage file in the main checkout while `--set` from a worktree writes another — together with the chosen resolution form and the promise↔read pair test. When it does, the owner supplies the next brief line; until then the piece is named in v3's "does NOT ship" list and nothing here should reference it as available
- ~~**decide: does the neutral `Ticket` shape gain a `body` field?**~~ — **decided by the owner's delegation: yes.** The alternative was two hygiene checks living inside each adapter, which is the same invariant implemented three times — and `invariants.md` says the copy nobody is looking at is the one that is wrong. `body` is nullable, because `plan-md` has none to give and an empty string would read as "checked, found nothing" rather than "cannot answer". The decision belongs in the shape's comment, not only here (AR-3b)
- ~~**publish 0.3.2 to npm**~~ — **done by the owner**; `npm view create-agent-rig` lists it as `latest`. It is what every rig in the wild is running, and therefore what `upgrade` bootstraps from
- ~~**publish 0.4.0 to npm**~~ — **done by the owner**; `latest` is 0.4.0. Verified against the published artifacts, not the working tree: `npx create-agent-rig@0.4.0` generates a `node-service` project whose own `pnpm check` passes (72 tests) and whose `.rig-manifest.json` records 36 agent-os files and no skeleton; and a rig installed by `npx create-agent-rig@0.3.2 init`, then edited in one file and stripped of one hook, upgrades correctly — the two files 0.4.0 changed are offered, the edit is kept as the user's with a path to the new version, and the deleted hook is reported rather than restored
- 🔴 **0.4.0 shipped untagged by the owner's decision, and `v0.4.0` on the remote points at 8dedfc7** — the abandoned preparation that became 0.3.2. The decision was taken with a cost stated; **that cost was overstated and the accurate one is smaller, so it is corrected here rather than repeated**. `git diff 8dedfc7 v0.3.2 -- templates/agent-os` is empty, and `buildHistory` deduplicates, so the stale tag injects **no wrong hash on any path** and can never produce a false "untouched" verdict. What it does at 0.5.0 preparation (`releasedTags` takes every `v*` tag below the version being prepared) is narrower and still real: the table will **name a version whose bytes it does not carry** — `0.4.0` labelling 0.3.2's content — and the two files 0.4.0 genuinely changed (`loop/SKILL.md`, `PLAN.md`) will be **absent from every version in it**. Nobody on 0.4.0 is affected: every 0.4.0 install writes a manifest, and the manifest is consulted before the table
- **whoever prepares 0.5.0 inherits one trap, and it is not the obvious one.** Deleting the stale ref and doing nothing else is **worse than leaving it**: `hash-history.test.ts` asserts the table's versions equal the CHANGELOG's releases below the current version, and the CHANGELOG carries `## 0.4.0` — so with the ref gone and nothing retagged the check fails with "stale table — run: build-hash-history", which names the wrong cause and cannot be satisfied by running it. Only two things actually resolve it: **tag the real release commit** (`e7fcf6b`, or the merge `c77c6c3`) after the owner deletes the stale ref, or teach the table to record a released version that has no tag. Nothing today checks that a version tag points at the commit that bumped to it, and that check is the durable fix — it must **fail loudly**, never silently drop the tag, or it reinstates the same gap one layer down
- **decide (0.5): does `upgrade` refresh a `settings.json` it can prove it wrote?** Today it never replaces that file — the U brief said so, and it is the right default while the file is a merge target for the user's own hooks. But with a manifest the ambiguity is gone for the unmodified case, and the cost of leaving it is the exact 0.3.1 failure: a release that adds a hook delivers the file and not its wiring. The command prints the entries to merge and says it will not do it for you
- **decide (0.5): what happens to `init --force` now that `upgrade` exists?** Open question 3 of the U brief, non-blocking. `--force` replaces `CLAUDE.md` and nothing else; `upgrade` covers the case it was standing in for
- **AR-4 entry conditions** — half discharged. The write-back discipline's condition fired (merged and in use where it came from) and it landed as U-1: the journal's `unblocked` field plus the §9 bullet. **C-0…C-2 stay out** — the clarify gate still has not fired anywhere, and shipping an unproven gate to other people's projects is worse than not having it
- **tell the users, and set a date to collect what they say** — 0.3.2 adds two gates that fire during ordinary work, which is exactly the kind of change that is either load-bearing or an irritation, and only a user can say which. The agent cannot send this
- **does the downstream project take the reverse port?** Out of the port brief's scope by construction. The fact that its copies of `guard-bash`, `detect-missed-gate` and the `loop` skill are behind this repo's is recorded in `NOTES.md` ("The port brief — and the drift that runs the other way"), which is where it stays whether or not this question is ever answered
- **proposal: 6 step 2 says which half the adapter does and which half the session does: under plan-md neither claim nor escalate writes anything, and the move to the Operator queue is the sessions edit — stated in the step rather than only in the adapters return value [triage]** — finding: journal: prose-reviewer on #42 — SKILL.md 6 step 2 (mark it escalated and leave it claimed) is not performable under plan-md · part: .claude/skills/loop/SKILL.md · proof: a run under plan-md that escalates an item leaves it out of the Agent queue, and the next `queue/index.mjs next` does not hand the escalated item back · fingerprint: `journal-prose-reviewer-on-42-skill-md-6-:claude-skills-loop-skill-md:6-step-2-says-which-half-the-adapter-doe` · seen ×1
- **proposal: export the existing printable() from core.mjs — it is module-private at core.mjs:306 today — and apply it to the ticket title and id in renderNext (index.mjs:77) and to skip.reason (index.mjs:80). Export rather than re-declare: invariants.md One mechanism, one implementation. Under github-issues or jira anyone who can open an issue controls the title string, so ANSI escapes and control bytes reach the operators terminal unfiltered [triage]** — finding: journal: security-scanner on #42 — index.mjs:77 interpolates result.ticket.title raw into terminal output · part: .claude/scripts/queue/core.mjs (export) + .claude/scripts/queue/index.mjs (apply) · proof: an issue titled with a \x1b[2J prefix renders as visible text in `queue/index.mjs next`, and the terminal is not cleared · fingerprint: `journal-security-scanner-on-42-index-mjs:claude-scripts-queue-core-mjs-export-cla:export-the-existing-printable-from-core-` · seen ×1

## Journal

Newest first, date-free — order carries the sequence. Prune freely: this is
operational memory, not an archive. Fields per the template in
`templates/agent-os/universal/PLAN.md`; a field the session cannot observe stays
**visibly empty, never estimated**.

### one item, five gate rounds — the stop line was wrong in a way the item did not know about

- **done** — AR3-35 (#42, `human-review`): `stopConditionOf` gained
  `nothing-selectable`, so "the queue is empty" and "everything left is held
  back" stop reading alike. Every rejection now carries a cause tag from a
  closed vocabulary, and the split that decides the verdict is by **cause**, not
  by whether anything was skipped: `blocked`/`in-progress`/`spacing`/`trigger`
  hold takeable work and clear on their own; `closed`/`triage`/`escalated` are
  parked, reported as their own count beside the verdict, never summed with the
  held count. 🔴 **A parked cause outranks a holding one on the same record** —
  the escalated item is left claimed on purpose, so it arrives as
  `['in-progress','escalated']`, and letting the holding cause win reproduced
  the original defect one label over
- **reviewed** — five `pr-ship` rounds, eight reviewer passes. Rounds 1–4
  returned **eight blocking findings**; round 5 was clean. Two of them were the
  same defect found twice from opposite directions: `prose-reviewer` found the
  first fix made `queue-empty` unreachable on the tracker adapters, and after
  the fix for that, `code-reviewer` found it still unreachable because
  `escalate` leaves the item claimed. Four were claims about the mechanism that
  the mechanism did not support — **all four written by this session**, three of
  them while fixing a finding about a claim the mechanism did not support
- **escalated** — nothing
- **stopped at** — **budget**. One item was the honest capacity of this run
  after five gate rounds, and the next selectable item is `[elevated]` — which
  spacing forbids straight after this one. The queue is not empty: 32 items
  remain, and the run says so rather than reporting the drain it did not do
- **post-merge verdict** — healthy, checked against the merged `master` rather
  than the branch: `queue/index.mjs next` selects and exits 0, `hygiene` reports
  33 items with nothing stale, and the three endings were driven through the
  real module (`nothing-selectable` on spacing, `queue-empty` on an all-parked
  queue, both counts named separately when a queue carries each)
- **unblocked** — **this queue has no dependency links** (`plan-md` is a flat
  list — absent, not satisfied). What the close settles is written on the
  Operator item it answers: half (b) of the empty-queue deadlock, with the
  by-cause refinement recorded there rather than edited into AR3-35's text
- **queue hygiene** — clean (33 items, nothing stale). Two findings about the
  queue rather than in it. Closing AR3-35 shifted every id below it again — the
  defect AR2-1 was escalated for, still unresolved. And 🔴 **the spacing ration
  has never fired across tasks in this repo**: `selectNext` reads
  `config.lastCompletedTier`, `.claude/queue.json` carries only `adapter`, and
  nothing writes it — so immediately after this elevated item closed, the CLI
  offered `AR3-2 [elevated]`. The rule was honoured by the session reading it,
  which is precisely the guarantee a mechanical filter is supposed to replace.
  Reported, not corrected in passing; filed as a proposal
- 🔴 **invariant conflict, surfaced rather than silently resolved** — `loop`
  SKILL.md §9 collides with itself on where a close is written, and this run is
  an instance of it. Its opening says the close goes in "with the merged PR
  linked, immediately after the post-merge verdict", which cannot happen inside
  the PR being merged; its closing paragraph says a `PLAN.md` fact edit —
  naming "an Operator-queue item it unblocked" — lands "**in the same PR that
  changed the fact**, never a docs-only follow-up". This run took the first
  reading and said so on #42; a run taking the second would have put the
  Operator edit in #42 and then had no way to write the close. Per the stop
  rules the resolution belongs in the rule and to the owner, not in one PR's
  history — so it is recorded here and **not** spent as one of the three
  proposals, which are capped for a different purpose
- 🔴 **marker audit, reported and NOT corrected** — taking AR3-36 in forced a
  pass over every marker in the block, and the two authorities disagree
  wholesale. `plan-md.mjs:110` derives `tier` from the `[elevated]` marker
  alone; `autonomy.md` says the tier is decided by what the change touches. By
  marker, 7 of 33 are elevated. **By declared path, 26 of the remaining 26
  are** — AR3-4/5/7/10/12/13/18/24/25/27 name scripts, AR3-9/11/20/22/23/31
  skills, AR3-19/28 rules, AR3-21/29/30 agents, AR3-17 `settings.json`, and
  AR3-26/32/33/34 straddle two of those. AR3-35 is the measured case: marked
  `normal`, its diff crossed `templates/agent-os/universal/.claude/scripts/`,
  and #42 carries `human-review`. Left exactly as the owner wrote them —
  quietly relabelling 26 items would destroy the evidence that the markers are
  unreliable, which is the one thing this audit is for
- **proposals filed** — three, all `ok: true` into the Operator queue: the
  `lastCompletedTier` seam above; `printable()` on the ticket title in
  `renderNext` (`security-scanner`, #42); and §6 step 2 naming which half of an
  escalation the adapter does and which the session does (`prose-reviewer`, #42)
- **cost** — 8 reviewer subagents, 3 test-writer, 1 check-premises; 4 check runs
  on the merged head commit (`ci`, two template jobs, one scanner), 0 re-runs;
  0 deploys
- **the honest note** — the item promised "a deliberate edit plus a line in the
  test that walks the list; the red fixture is trivial", and `check-premises`
  passed it. It was not wrong about the code; it was wrong about the size, and
  nothing in the intake could have caught that — the cost lived in a property
  of the *queue's own data* (that the loop manufactures parked records) which no
  reading of `stopConditionOf` would surface. Second, and worse: the gate found
  four false claims about the mechanism in prose this session wrote, and three
  of those arrived in commits whose stated purpose was to fix exactly that
  failure. The reviewers caught every one; nothing in the authoring loop did

### AR-12 landed, and the next item's premise failed in front of the run that closed it

- **done** — AR-12 (#36, `human-review`): both stack rulebooks declared, with the
  test asking coverage of the sweep's own `elevatedPathsIn` rather than
  re-implementing a prefix match — a path can be declared and still dropped as
  inert, which is how `.md` rulebooks were once invisible to this gate. Verified
  on the sweep: a merge touching either rulebook without the label now
  classifies `missed-gate`, with it `null`
- **reviewed** — two passes, no blocking code findings; prose returned two
  blockers, both claims the mechanism contradicted. The sharper one was
  pre-existing and inherited: the paragraph under the block named `.claude/` and
  `packages/db/src/` as declared, and in this repo's composition neither is — a
  reader would conclude edits under `.claude/` are swept by path. Corrected in
  the template, so every rig composed after it says something true
- **escalated** — **AR2-1, on a false premise, and the evidence arrived
  unprompted.** The item specifies `evidence/<key>.json` keyed by the queue
  adapter; under `plan-md` the id is positional, and closing AR-12 shifted every
  remaining id by one in that single edit (AR2-1 2→1, AR2-4 5→4, AR2-7 8→7). The
  gate cannot be built on that key here. Moved to the Operator queue rather than
  re-aimed: an item rewritten into what it should have said is work the agent
  authored for itself
- **stopped at** — this checkpoint; the run continues on AR2-2
- **post-release verdict** — not applicable; nothing deployed or published
- **unblocked** — this queue has no dependency links (`plan-md` is a flat list —
  absent, not satisfied). What AR-12 settled is recorded on the item it settled:
  the jsdom-rule decision no longer turns on which side of the elevated line the
  two candidate files sit
- **queue hygiene** — clean (7 items at the checkpoint, nothing stale)
- **cost** — 3 reviewer subagents, 1 test-writer; 4 check runs on the merged PR's
  head commit; 0 deploys
- **the honest note** — the elevated-spacing rule says never take two elevated
  items back to back, and after AR-12 every remaining item is elevated, so the
  loop's own selection would stop here. It is continuing on the owner's explicit
  instruction, which makes this **owner-directed work rather than loop-selected**
  — and that distinction is the whole reason the rule is not simply being
  ignored. The rule needs a ruling, and it has one recorded above; until then
  every such PR says on its face that spacing was overridden by instruction

### the v3 brief taken in, and a flake that turned out to be the harness racing itself

- **done** — the AR2 block carried into the Agent queue (#34), spliced rather
  than written over the file, so the history shows the 16 added lines instead of
  a whole-file replacement. Split in two commits on purpose: the delivered text,
  then what review changed. And #33, which was not the task: the pre-PR gate went
  red on `test/e2e/upgrade.test.ts`, and the cause was three e2e suites each
  running `npm pack` at the repo root in parallel — `pack` runs `prepare`, which
  `tsc`-rewrites `packages/cli/dist`, which `files` also tells `pack` to read. A
  tarball could carry a half-written CLI. One `globalSetup` packs once now, and
  `test/template/e2e-pack.test.ts` holds that line
- **reviewed** — four reviewer passes. Both passes on the queue text returned
  HOLD and agreed on the sharpest finding independently: AR2-4/6/7 named work
  under declared elevated paths and were queued `normal`. The pass on the race
  fix returned clean, having re-verified the two claims it was asked not to take
  on trust — that `globalSetup` completes before any `beforeAll`, and that
  `git-install.test.ts` builds in npm's clone rather than in `packages/cli/dist`
  (measured by mtime across its 62-second run)
- **escalated** — nothing
- **stopped at** — the run ended here, deliberately: both PRs merged, master
  synced, no work in flight
- **post-release verdict** — **not applicable; nothing was deployed or
  published.** Both changes are repository-internal
- **unblocked** — nothing; this queue has no dependency links
- **queue hygiene** — clean throughout (8 items, nothing stale). One finding
  about the queue rather than in it: with AR2-4/6/7's markers corrected, all
  eight open items are elevated, and `selectNext` then refuses the second one —
  so a run drains a single item and stops reporting `queue-empty` with eight
  items open. Simulated against the real module and filed as an Operator
  decision rather than silently worked around by understating a tier
- **cost** — 4 reviewer subagents, 1 test-writer; 8 check runs across the two
  merged PRs' head commits; 0 deploys
- **the honest note** — the red suite was found by the gate, not by the session:
  it had been running `pnpm test:unit` at each commit, which is green on this
  defect by construction, and the full suite only ran because `pr-ship` step 2
  demands it. A gate caught what the working rhythm was structurally unable to
  see. Second, smaller: the first full-suite run was piped through `tail`, so its
  exit code was `tail`'s and the failure was visible only in the text — the later
  runs set `pipefail`

### the upgrade brief, and the first release you can take without a procedure

- **done** — the U brief in full. `upgrade` with the install manifest and the
  generated released-hash table (#29); the `loop` write-back as a required
  journal field (#30); 0.4.0 numbered back onto ordinary semver, with the policy
  stated once in the CHANGELOG header rather than argued in an essay. The 0.3.2
  section keeps its six-file procedure as the record of what it asked, under a
  note that says not to follow it on 0.4.0
- **reviewed** — six reviewer passes over two PRs; **every one returned HOLD**,
  and the second prose pass on a rewritten paragraph found two more. Two of the
  findings were working exploits (a write outside the repository and an
  arbitrary read exfiltrated into it, both through a manifest that is meant to
  be committed); three were the same shape of "this command writes too
  eagerly"; one was a rule whose stated justification the code contradicted
- **escalated** — nothing
- **stopped at** — the release stopped at `npm publish` (§11) and the owner took
  it from there; `latest` is 0.4.0. It also stopped, earlier and for good, at
  the tag: the remote still carries a `v0.4.0` from the abandoned 0.4.0 that
  became 0.3.2, deleting a published ref is not the agent's to do, and the owner
  chose to ship untagged with the cost stated. That cost is now an Operator item
  rather than a footnote — it comes due at 0.5.0, not now
- **post-release verdict** — healthy, checked against the published artifacts
  rather than the tree: a generated `node-service` project passes its own
  `pnpm check` (72 tests), and a 0.3.2-installed rig upgrades with the edit kept
  and the deliberate deletion respected
- **unblocked** — **this queue has no dependency links** (`plan-md` is a flat
  list — absent, not satisfied). What the closes settled is recorded on the
  items themselves: AR-13 was what `upgrade` implements, and the AR-4 entry
  conditions are now half discharged with `C-0…C-2` still explicitly out
- **queue hygiene** — one stale Operator item found and reported: "publish
  0.3.2 to npm" was still open, while `npm view create-agent-rig time` puts the
  publish at 09:18 UTC the same morning. Hours, not days — the lane is
  responsive, the item just outlived its own completion
- **cost** — 6 reviewer subagents; 8 check runs, being the 4 on each of the two
  merged PRs' head commits (14 with the merge commits, from 4 workflow runs);
  0 deploys. The release PR's own runs are not in that count
- **the honest note** — the failing test came first everywhere, but on two files
  it was not *watched* fail before the implementation existed; the Red was
  reconstructed afterwards (against `master`'s copy for the skill, and by a
  reviewer's mutation run). That is weaker evidence than the rule asks for, and
  it is written down rather than smoothed over

### the port brief closed, 0.3.2 prepared

- **done** — every agent-takeable item of the port brief is merged: the premise
  check (#19), the two reviewers (#21), the git-environment fix (#22), the gate
  sweep's blindness to this repository (#23), three queue-hygiene checks with the
  `Ticket.body` decision (#24), the sweep's vocabulary and declarations (#25),
  three stale claims (#26). 0.3.2 is prepared here: both manifests bumped, the
  CHANGELOG written in the repo's convention with a "deferred, and on what
  condition" section, `create` and `init` smoked on scratch projects, and
  `npm pack --dry-run` confirming the new skill and agent travel in the tarball
- **reviewed** — nine reviewer passes across seven PRs; **seven of the nine
  returned HOLD**, and exactly one PR (#25) cleared its gate on the first and
  only pass. The findings that mattered were never in what
  the brief asked for: a `GIT_DIR` inherited through a git hook writing into the
  outer repository (and flipping it to bare); a gate sweep anchored to the
  repository root and therefore blind to a generator's own rulebook; a
  quadratic-backtracking regex reintroduced one directory from where the same
  defect was fixed and documented; a hygiene check that fired on the healthiest
  items in the queue; and a comment "correction" that replaced a stale claim with
  a false one
- **escalated** — nothing
- **stopped at** — the brief's queue is empty apart from AR-12, which review
  produced. That is the intended ending: an empty queue ends a session and is
  never a cue to invent work
- **queue hygiene** — four of the items worked this session were filed by
  reviewers, not by the brief. The `--dry-run` nit the brief carried was false
  and is recorded as such rather than quietly dropped
- **cost** — 9 reviewer subagents, ~30 CI check runs across 7 PRs, 0 deploys
- **the honest note** — this session caused one defect of its own (19 junk
  commits and a repository flipped to bare, all local, all reverted). Half of
  them came from the ordinary path — a `git commit` inside a worktree, which is
  what will hit any user of the `worktree-task` skill — and half from setting
  `GIT_DIR` by hand to confirm the diagnosis. The fix that followed was the most
  valuable thing in the release

### the gate sweep could not see this repository, and now names its own misses

- **done** — #22 (the git-environment defect, four call sites) merged; AR-9
  lands here: `isRulebook` recognises a rulebook wherever it sits, and the two
  gate directories are declared now that declaring them buys something
- **reviewed** — `code-reviewer` on #22: HOLD on two (an unpinned change in an
  elevated path, and the tier record), both closed; its advisories produced the
  sweep test that would have found all four call sites in one pass
- **stopped at** — checkpoint, still running
- **queue hygiene** — AR-2 was still listed after shipping in #21; closed here.
  🔴 **The sweep now reports three findings, and all three
  are this session's merges** (#19, #21, #22). They are not gate misses: every
  one ran `code-reviewer`, #21 also ran `prose-reviewer`, and each verdict is
  written in its PR body — though not in a form this sweep recognises, since it
  looks for a passing word and `pr-ship` says SHIP. What is missing is the
  `human-review` label, deliberately —
  it asserts a human read the diff, and it is the one signal
  `detect-missed-gate` treats as unfakeable *because* an agent cannot apply it
  honestly. The owner delegated merge authority, which is a different act from
  reading the diff. So the findings stand, correctly, until the owner labels
  them or decides they do not need it. Recording this here is the other half of
  the rule that a miss which turned out harmless is still written down
- **cost** — 8 reviewer subagents across the session, 20 CI check runs, 0 deploys
- **note on the fix's own honesty** — the finding line used to end "no reviewer
  verdict recorded anywhere". The sweep reads a label and scans for a reviewer
  name beside a passing word; a verdict phrased any other way is invisible to
  it. It now says what it actually checked

### the premise check shipped, and the session tripped the defect it then filed

- **done** — #18 (the queues) and #19 (the `check-premises` skill, wired into
  `loop`, installed by `init`, named in both maps) are merged; `ci` and both
  template jobs concluded `success` for each head commit before the merge
- **reviewed** — `code-reviewer` twice on #19: HOLD on four findings (init's map
  did not name the skill it installs; the loop pointed at an escalation list that
  did not recognise the case; the verdict vocabulary was the contract and the
  untested part; the test comment carried an outside project name and a tracker
  key into the block asserting neither travels), then SHIP with each fix
  confirmed red against the pre-fix commit. `code-reviewer` once on #18: HOLD on
  two, both fixed
- **escalated** — nothing
- **stopped at** — checkpoint, still running
- **queue hygiene** — 🔴 **#19 is Tier 2 and carries no `human-review` label, on
  purpose.** It reached `templates/agent-os/init/` mid-work; the gate was run and
  its verdict is on the PR, but the label asserts a human read the diff, and an
  agent applying it to its own PR converts the sweep's one non-forgeable signal
  into a forgeable one. The owner authorised the merge without reading the diff,
  which is a different act. **This entry is therefore the only record, not half
  of one:** the sweep reports nothing at all —
  `detect-missed-gate.mjs --since 2026-08-01` → "2 merged PR(s) swept — no
  findings". Its `isRulebook` exempts `CLAUDE.md` and `.claude/` **at the
  repository root**, and a generator keeps its rulebook under
  `templates/agent-os/**`, so every declared elevated path in this repo that
  holds `.md` files is dropped as inert before the prefix test runs. Filed as
  AR-9; found by the reviewer, on the sentence that claimed the opposite
- **cost** — 3 reviewer subagents (2 on #19, 1 on #18), 8 CI check runs across
  two PRs, 0 deploys
- **the defect this session caused, in full** — 19 junk commits landed on two
  local branches: 18 titled "Pristine template" plus one "clean". They arrived by
  two different routes, and the distinction matters. Nine came from an ordinary
  `git commit` inside a linked worktree — the pre-commit hook ran the suite with
  the absolute `GIT_DIR` git hands its hooks, and the CLI's baseline commit
  inherited it. Nine more came from this session then setting `GIT_DIR`
  explicitly to confirm the diagnosis. Only the second route was deliberate; the
  first is the one that will hit anyone using the `worktree-task` skill this repo
  ships. Both branches were reset, `master` was never touched, nothing was
  pushed. Filed as AR-8, at the top of the queue

### queues added to this repo's own PLAN.md, brief decomposed

- **done** — this repo dogfooded the `plan-md` adapter without having a `## Agent
  queue` heading at all; the adapter would have thrown `queue-unreadable` on the
  first `loop` run here. Both queues and this journal now exist, filled from the
  owner-supplied port brief
- **reviewed** — `code-reviewer` on this change: HOLD, two blocking findings, both
  fixed here — a queued item asserting `--dry-run` was missing from `USAGE` when
  `packages/cli/src/index.ts` has documented it since `init` shipped, and two
  items known to touch elevated paths queued without the `[elevated]` marker
- **stopped at** — checkpoint, still running
- **queue hygiene** — the missing heading above is the first finding. The second:
  the brief this queue was filled from carried a false premise into an item, and
  the reviewer caught it one line below the item that adds a premise-checking
  skill. The check being built is the check that was missing
- **cost** — 1 reviewer subagent, 0 CI runs, 0 deploys (this session's counts at
  the checkpoint; the merge adds at least one CI run)
