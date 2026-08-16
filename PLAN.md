# PLAN — `create-agent-rig` (project generator: agent-os + skeleton)

> Working plan for Claude Code. Phases are incremental: each one ends in something **that works**, not a half-built layer. The decisions in §2 are locked — do not re-litigate them without new data.
>
> **Status (0.4.0, published; queue moved to Jira `AR` on 16 Aug 2026).** Phases 0–7 are all shipped, plus the factory extraction (§7.5, §7.6), the port brief (§7.7) and the upgrade brief (§7.8). **Published on npm** — `0.1.0` through `0.4.0` are live and `0.4.0` is `latest`; `npx create-agent-rig` resolves from the registry, and the git path still works unchanged. An installed rig is brought forward by `create-agent-rig upgrade` rather than by a procedure in a release note. `0.4.0` shipped **untagged** by the owner's decision, which the Operator queue carries as a live cost for 0.5.0. Detailed field notes and per-brief findings live in `NOTES.md`; this file is the map, `NOTES.md` is the log.

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

**Moved to Jira on 16 Aug 2026 — project `AR`, board 34
(`https://sbaksheiev.atlassian.net/jira/software/projects/AR/boards/34/backlog`).**
This file no longer holds work items; the split rule at the top of the document
now reads literally — a fact belongs here, a unit of work belongs in a ticket.
The switch to the `jira` adapter is **not** a one-line edit and is filed as
AR-45 (Operator + elevated): `.claude/queue.json` is composed from
`templates/agent-os/universal/.claude/queue.json`, so editing it in place fails
the drift check — the same mechanism that sent AR3-36's runtime value to
`.claude/queue.state.json` — and the adapter needs `JIRA_BASE_URL` /
`JIRA_EMAIL` / `JIRA_API_TOKEN` in the environment plus `options.project`
(`AR`), none of which is set today. Ruled (owner, 16 Aug): the ADAPTER is
fixed, not the board — `jira.mjs` **will** read the tier from the `elevated`
label and **will** exclude `operator-queue`/`triage` by label itself; no
`human-review` marker on Jira (it would mean something else than on GitHub),
no jql gymnastics. Both clauses are future on purpose: today `jira.mjs:94`
reads the tier from `human-review` and its default query excludes `triage`
alone, which is the defect AR-45 exists to close. Until AR-45 lands the
loop runs `plan-md` against an empty section and stops `queue-empty`. When it
lands, the AR2-1 question closes for this repo: the evidence key is the issue
key, so the evidence gate's full path is finally reachable here (see AR-34).

🔴 **The heading above stays, and it is load-bearing** — `plan-md.mjs` throws
*"has no `## Agent queue` heading … a structural problem in the file, not an
empty queue"*, which `index.mjs` turns into `queue-unreadable` and **exit 1**,
not the `queue-empty` exit 0 this section promises. An empty section and a
missing one are opposite verdicts, so deleting the now-contentless heading is
not tidying. Nothing else in this repository states that condition.

⚠ **`AR-n` now names two different things, and the sentence that used to
disambiguate them left with the items.** Keys on board 34 are Jira issues;
`AR-3`, `AR-4`, `AR-12`, `AR-13` and their neighbours in the **brief** and in
the journal below are the port brief's own numbering, which predates the
project and does not map onto it. Every brief-sense key now also exists as a
real ticket, so a reader resolving one gets an unrelated issue and no error.
Brief-sense keys are not rewritten here — the journal is a record — so check
which numbering a citation is in before following it.

**Under `plan-md` this section is deliberately EMPTY** — no bullet below this
line is a work item, and `parsePlan` must return zero. A run on the `plan-md`
adapter therefore stops `queue-empty` here, which is the honest reading until
the adapter switch below lands (AR-45); it must not fall back to inventing
work from prose. The paragraphs that follow are conventions, written as
prose on purpose so the adapter cannot mistake them for items.

Conventions on the board (they mirror what this section used to encode).
**Labels:** `agent-queue` = the old Agent queue; `operator-queue` = the old
Operator queue (decisions, Tier-2, watchers); `triage` = proposals filed by a
run, unselectable until a human promotes them. 🔴 **What keeps those two out
of selection is the exclusion in the ruling above — the adapter reading their
own label — and NOT a `ready` marker.** `ready` is a human-facing hint that no
selection path reads. What occurs exactly once in the queue layer is the
**label check** — `grep -rn "'ready'" .claude/scripts/queue/` returns one line,
`core.mjs:206`, inside `hygieneOf`, which only *reports* a `stale-ready-label`.
The bare word returns nine (`grep -rn ready .claude/scripts/queue/ | grep -v
already`); of the other eight, two are the rest of that same `hygieneOf`
return (`core.mjs:208`, `:210`) and six are comments — one of which,
`core.mjs:582`, is the ordinary English word and not the label at all. Two of
the six, `jira.mjs:280` and
`github-issues.mjs:182`, describe the absence of a `ready` marker as part of
what keeps a proposal out of selection, which is looser than the mechanism and
is why this paragraph exists.
Resting the split on it would be worse than useless: an adapter filtering on
`labels = ready` against a board that does not carry it returns an empty set,
and an empty set with nothing skipped is `queue-empty` — exit 0, a successful
session, with 40 issues open. That is the "all-elevated queue reported itself
as EMPTY" failure again, in the one shape `nothing-selectable` cannot catch.
`blocked` is derived from `Blocks` links,
never from the label (`invariants.md`); `elevated` is the marker, and per
AR3-37's ruling (AR-1) it is **advisory** — the candidate tier is
`max(marker, tier derived from the paths the item names)`, and a marker that
disagrees with its derived tier is hygiene to report, never a value to relabel.
**Order:** key order is the migration order, which is the take order this
section carried — AR-1 (AR3-37) first, then AR-2…AR-34 in the block's own
sequence, AR-44 (AR3-41) last. The `elevated` marker sits on exactly ten:
AR-1, AR-2, AR-3, AR-4, AR-5, AR-6, AR-7, AR-14, AR-15, AR-16 — the same ten
lines that carried `[elevated]` here, not a contiguous range. Brief §3
sequencing stays a *dependency* order, not a *take* order; the spacing rule
is mechanical on both sides (writer: AR3-36; candidate filter: AR-1 when it
lands). **Provenance:** every description opens with its tier by marker AND by
declared path, and names the brief item and the upstream Flowa key it was
measured on; v2's 🔴 rule stands unchanged — **nothing brings a Flowa copy of
`guard-bash`, `detect-missed-gate` or the `loop` skill into this repo**.
**Completeness:** nothing was dropped — 34 agent items → AR-1…AR-34 and
AR-44; the Operator queue's live entries → AR-35…AR-38; its eight triage
proposals → AR-39…AR-43 (grouped by part where two findings share a file;
fingerprints preserved verbatim so `file-triage` dedup still matches); the
adapter switch itself → AR-45. Rulings already taken (AR2-1 = NULL under
plan-md, jsdom = no rule, the AR3-37 shape, the AR3-36 state file) live in the
tickets they govern; the crossed-out history that used to sit here is git
history now. ⚠ **Not in `NOTES.md`** — that file carries none of the four
(grep: zero hits for `AR2-1`, `AR3-36`, `AR3-37`, `queue.state.json`), and a
pointer that resolves to nothing is worse than no pointer. Two are recoverable
in-repo despite the tracker: the AR3-36 state-file ruling is quoted verbatim,
with the drift output it was measured against, in
`test/template/queue.test.ts:470-480`, and the AR3-37 shape is restated above.

## Operator queue

**Moved to Jira with the Agent queue — label `operator-queue`, plus
`triage` for proposals.** Open at migration: AR-35 (the 0.5.0 tag trap —
owner deletes/retags, then the tag↔bump-commit check is agent work),
AR-36 (0.5 decisions: `upgrade` on a provably-written `settings.json`;
`init --force`), AR-37 (watchers: AR-4 C-0…C-2 entry condition; tell the
users and set a feedback date; the downstream reverse port), AR-38 (rule the
`loop` §9 self-contradiction on where a close is written — under `jira` half
of it dissolves, say so in the rule), AR-45 (the adapter switch itself).
Proposals in `triage`: AR-39…AR-43. ⚠ Under `plan-md`, `proposeTriage` still
appends to THIS heading — until AR-45 lands, a proposal filed by a run lands
here as a bullet and must be carried to Jira by hand; that is a known cost of
the interim, not a place to leave items.

## Journal

Newest first, date-free — order carries the sequence. Prune freely: this is
operational memory, not an archive. Fields per the template in
`templates/agent-os/universal/PLAN.md`; a field the session cannot observe stays
**visibly empty, never estimated**.

### seven rounds, six routing escapes, and each one found by a different means

- **done** — AR3-5 (#50, **no `human-review` label**): `decision-router` — the
  dispatcher in front of `pr-ship`. Three lanes in ascending cost
  (`deterministic` → `fast-path` → `model`), risk flags evaluated ahead of all
  three, one journal line per gate verdict including the skipped ones. It runs
  no reviewer and decides nothing about whether a review passed; it decides
  whether the expensive path is warranted, which is the thing that did not
  exist — a typo fix in a README bought the same fan-out as a rewrite of the
  storage layer
- **reviewed** — **seven rounds, twenty-one reviewer passes.** Not every gate
  held every round: `security-scanner` cleared its items in round two and
  returned "ship it, the rest is tail" in round six, and the *last* round is the
  one where all three converged on a single finding — which was mine.
  ⚠ **The blocking-findings count is deliberately not given as one number.**
  Two honest tallies of the commit messages disagree (33 counting only bullets
  labelled blocking; 36 taking PR #50's own "thirty-one" for five rounds and
  adding rounds six and seven), and the machine trace this run wrote
  (`.claude/runs/20260816-044453/`, 18 records, gitignored) records **routing
  verdicts, not review rounds** — so it cannot settle it. A number nothing
  observed does not go in
- 🔴 **Six of the findings were routing escapes** — a change reaching a lane
  cheaper than its content deserved — and the shape worth keeping is **how they
  were found**: reading the diff (a rename dropped its source path, defeating
  all three risk flags at once); running the mechanism (`.mdx` compiles to an ES
  module, so a one-file diff adding `import { execSync }` routed to `fast-path`
  while the router printed "the change carries no code"; and separately
  `git mv CLAUDE.md claude.md` put the rulebook in the prose lane for good);
  executing a prose claim rather than reading it (`test/golden/expected.txt`
  classified as prose, so a deleted golden file got `prose-reviewer` as the
  whole gate); differentially routing against the previous commit (74,151 pairs
  in round five, 586,000 cases in round six — the second caught a lane I had
  given back); and a test going red while I fixed something else
- 🔴 **And the lens that found nothing is itself the finding: fuzzing 41,496
  single-file routes plus this repo's own 299 tracked files caught zero
  escapes**, in the same round two other lenses caught three. Breadth over one
  input shape does not probe a classifier whose defects live at the boundary
  between two rules
- 🔴 **the shape worth keeping** — **my own fixes opened the next round's
  defect in five consecutive rounds**: 2→3, 3→4, 4→5, 5→6 and 6→7. Round two's
  fix caused round three's blocker (`deterministic` learned to require a status,
  the file moved to a new counter, and `fast-path` never read it — so adding a
  `.generated.` filename beside one `.md` edit was a one-line way to drop
  `code-reviewer`). Round three's landed in the module and not in the twin
  document, twice. Round five's moved `integration/` out of the test directories
  to stop over-escalating docs and took the fixture fix with it — **both sides
  of that choice were made in this branch and both were wrong**, which is what
  finally produced the right answer: the extension decides, not the directory
  name. And round six's rewrite of limit 5 fixed the half it had missed by
  deleting the half it had right, which is the single finding all three gates
  converged on in round seven
- 🔴 **and I wrote vacuous tests twice, while fixing vacuous tests.** A reviewer
  proved three round-four guards had no test that would notice their removal —
  deleting each left 88 tests green. Two of the four tests I then wrote for
  round six went wrong, and precisely one was vacuous: the empty-argv-token test
  ran in a temp directory with no git repository, so `gitFiles` failed and exit 1
  arrived for the wrong reason — it passed under the very mutation it was
  written to catch. The other was **real, and I nearly recorded it as vacuous**,
  because my first mutation of it unfolded only one of the two sides it guards.
  Both errors point the same way: a mutation that does not actually remove the
  behaviour proves nothing, in either direction.
  **Every guard in the final state is mutation-verified red**, in both
  directions where the choice has two
- **escalated** — nothing
- **stopped at** — **budget, and later than it should have been.** The stop rule
  never fired mechanically because every round found real defects, so "no
  progress" was never true. But the pattern was visible by round four —
  my-fix-opens-the-next-defect, three times — and that was the moment to ship
  with the design finding filed rather than keep grinding. Rounds five through
  seven found real things and were still the wrong call. The owner asked the
  question directly ("почему так много раундов?"), which is how it got named
- **post-merge verdict** — healthy, checked on merged `master`: the router
  routes the merge commit itself to `model` with `elevated-path` and
  `security-surface`, `queue next` selects and journals, `hygiene` reports 35
  items and nothing stale, and the tier recorded from the merge's own diff came
  back `elevated` — six files under six declared prefixes
- **unblocked** — **this queue has no dependency links** (`plan-md` is a flat
  list — absent, not satisfied). No open item names AR3-5 in its text, so
  nothing here is released by this close and a reader has nothing further to
  check
- 🔴 **queue hygiene** — AR3-5 carried no `[elevated]` marker and the merge
  recorded `elevated` from six files under six declared prefixes. That is the
  26-item divergence AR3-37 is filed about, measured again on a live merge.
  Reported, not relabelled
- 🔴 **the gate miss, recorded because a miss that turned out harmless is still
  recorded.** The diff crossed six declared elevated paths and **no
  `human-review` label was applied**, deliberately: the label attests *"a human
  reviewed this PR"* and no human did. The authority this run held is a session
  instruction from the owner removing merge limits — which per AR3-40 is not an
  artifact the next reader can check, so it is named as what it is rather than
  dressed up as a label. `detect-missed-gate` will flag this merge and the
  finding is correct
- ⚠ **and the last commit was not re-reviewed by a cold context.** The final
  round's single blocking finding was fixed after the reviewers reported, and
  `5bebae4` was verified by me — mutation, full suite, CI — rather than by a
  fresh reader. That is a real gap in the isolation `workflow.md` calls load-bearing,
  stated rather than glossed
- **proposals filed** — three, into the Operator queue
- **cost** — 21 reviewer subagents (7 code, 7 prose, 7 security), 1 test-writer,
  1 check-premises; **8 pushed SHAs carrying the full check set** (`ci`, two
  template jobs, one scanner) — 8 `ci` runs, 32 check runs, **0 re-runs**; 0
  deploys. The docs branch closing this item adds one more of each
- **the honest note** — the finding that outlasts the PR is a design property,
  not a bug backlog: **a path-based classifier for how much review a change
  deserves has an unbounded tail of special cases**, and each fix opens a seam
  where it meets the previous one. Two of the six escapes were reopenings of a
  defect an earlier round had declared closed. The lanes are deliberately narrow
  and every unknown resolves expensively, so the tail costs tokens rather than
  review — but a reader deciding whether to extend this module should know the
  shape before adding the next entry

### sixteen blockers, nine of them my own claims about a mechanism I had not run

- **done** — AR3-4 (#48, `human-review`): the run journal — gate verdicts to
  `decisions.jsonl`, everything else to `events.jsonl`, append-only, under a
  per-run directory the run declares through `RIG_RUN_DIR`. It lands with two
  callers, which is the half the shape it was ported from never had: selection
  records its `item-selection` verdict, and the `loop` skill's stop step writes
  the run-end marker. The ordering is asserted rather than described — a
  run-wide `seq`, refused on a gap or a reversal, on write and on read
- **reviewed** — two `pr-ship` rounds, five reviewer passes. **Sixteen blocking
  findings; nine were claims I wrote about a mechanism I had not run.** The
  reviewers ran them: `endRun` exported and called from nowhere, so the marker
  existed as an API and never as behaviour; `RIG_RUN_DIR` declared in §7 while
  its only call site fires in §2, so a run reading the skill in order exports it
  after every selection has already happened; a journal failure exiting *before*
  the selection printed, so one collision between two sessions made `queue next`
  exit 1 against that directory forever — and, after that fix, the same defect
  through the write door, because `appendFileSync` was the one unwrapped fs call
- 🔴 **the shape worth keeping** — three of the sixteen were the item's own
  doctrine failing on the item itself. "A journal nothing calls records nothing"
  is the sentence in the module header, and the marker shipped with no caller.
  Writing the rule did not make me follow it; running the mechanism did
- **escalated** — nothing. Two questions went to the owner rather than being
  answered in-run, which is what the `loop` skill's §8 requires, and both came
  back as rulings in the port brief (v4, 2026-08-14) — an artifact written
  outside this branch. AR3-40 asks that such a ruling be **quoted**, not just
  named, so: on the rider, *"RULED: the human journal, `## Journal` in
  `PLAN.md` — not AR3-4's machine journal … The loop built the ordering
  assertion on the machine journal instead … and **said so honestly** in its
  test header rather than silently calling the ticket satisfied — correct
  instinct, wrong target"*; and on the label, *"RULED: the run does not
  self-apply `human-review`, even with a token that technically could … that
  capability is not authorization to use it"*. ⚠ **Both rulings carry brief-side
  item numbers (AR3-41 for the human journal's own check, AR3-42 for the label)
  and NEITHER is in this queue** — taking a brief item into the queue is the
  owner's act, not a closing run's. Until that happens the numbers resolve in
  the brief only, and the quotes above are what a reader here can check. The
  owner applied the label
- **stopped at** — **budget**. One item, two gate rounds, five reviewer passes.
  The queue is not empty: 35 items remain
- **post-merge verdict** — healthy, checked on merged `master` rather than on
  the branch: `queue next` selects and writes its `item-selection` record into a
  declared run directory, `hygiene` reports nothing stale, and the tier recorded
  from the merge's own diff came back `elevated` — four files, under three of
  the declared prefixes
- **unblocked** — **this queue has no dependency links** (`plan-md` is a flat
  list — absent, not satisfied). One item names this one in its own text and is
  the whole of what a reader can check: AR3-13, *"last, because AR3-4 is what
  makes it meaningful"*. AR3-24 is **not** released by this close — it names the
  human journal's `cost` block as its home, not this trace — and AR3-25 still
  owns the run-id convention this module deliberately does not
- 🔴 **queue hygiene** — AR3-4 was marked `normal` and the merge recorded
  `elevated` from four files under three declared prefixes. That is the 26-item
  divergence AR3-37 is
  filed about, measured once more on a live merge rather than predicted.
  Reported, not relabelled. Second finding, from the merge itself: `gh pr edit
  --add-label` fails in this repository on a Projects-classic deprecation that
  has nothing to do with labels, so the one mechanism `autonomy.md` treats as
  the sole suppressing evidence is reached through a command that refuses for an
  unrelated reason. `gh api …/labels` works
- **proposals filed** — three, all `ok: true` into the Operator queue: the
  `queue-unreadable` stop that the journal never records; a fixture asserting
  "it printed something", which a stack trace satisfies; and the two
  correspondence tests this task added, whose comments claim more than they
  check
- **cost** — 5 reviewer subagents (2 code, 2 prose, 1 security), 2 test-writer,
  1 check-premises; **four pushed SHAs, each carrying the full check set** (`ci`,
  two template jobs, one scanner) — 4 `ci` runs, 16 check runs, 0 re-runs; 0
  deploys
- **the honest note** — the brief's §7a was named as required reading for this
  item and the brief lives outside the repository, unreadable from the session.
  The run stopped and asked rather than reconstructing the correction from what
  it "already knew" — and the correction, once supplied, was load-bearing:
  SCRUM-87 turned out to belong to a different artifact entirely. Had the run
  answered its own question, it would have shipped a paraphrase of the rider and
  called the ticket satisfied

### the ration fires for the first time, and seven of thirteen blockers were my own prose

- **done** — AR3-36 (#45, `human-review`): the close step records the tier, so
  the elevated spacing fires between tasks for the first time in this
  repository. `selectNext` had always read `config.lastCompletedTier` and
  **nothing had ever written it**, so the filter ran on `null` every time and
  the rule was upheld only by whichever session read it. The tier is computed
  from the closing diff's paths through the gate sweep's own
  `elevatedPathsIn`, never from the item's marker. Verified on itself: closing
  AR3-36 recorded `elevated` from 8 paths, and the next selection held the 7
  marked-elevated items and handed out AR3-4
- **reviewed** — four `pr-ship` rounds, nine reviewer passes. **Thirteen
  blocking findings; seven were claims I wrote about a mechanism I had not
  run.** The reviewers ran it: git under `fr_FR`, a real pre-commit hook in a
  linked worktree, `execFileSync` with a clipped `maxBuffer`, a spawn injected
  into a document. Round 4 was the first with no finding about behaviour
- **escalated** — nothing. One scope change went to the owner rather than being
  re-aimed in-session (§8): the item named `config.lastCompletedTier`, which is
  composed from the template layer, so a runtime value there fails the drift
  check and would be an `upgrade` conflict in every generated rig. Ruled, and
  the state moved beside the config
- **stopped at** — **budget**. One item, four gate rounds. The queue is not
  empty: 32 items remain
- **post-merge verdict** — healthy, checked on merged `master` rather than the
  branch: the tier recorded through the shipped snippet, `next` selects, and
  `hygiene` reports 32 items with nothing stale
- **unblocked** — **this queue has no dependency links** (`plan-md` is a flat
  list — absent, not satisfied). What the close settles is written on the item
  and on the block preamble: the ration is wired, and the half that is not is
  named there
- 🔴 **queue hygiene** — the marker audit from the previous entry stands
  unchanged and uncorrected. It now matters more, not less: the ration filters
  **candidates** on the marker while recording the **path** tier, so the 26
  items marked `normal` whose artefacts sit under declared elevated paths will
  be handed out after an elevated close. Reported, not relabelled
- **cost** — 9 reviewer subagents, 4 test-writer, 1 check-premises; 4 check runs
  on the merged head, 0 re-runs; 0 deploys
- 🔴 **the honest note** — the gate caught a test that was measuring nothing: a
  stub `git` wrote `env > dump` while `PATH` held only the stub, so the dump
  stayed empty and the sibling assertion ("the locating variables are withheld")
  passed **because the file was empty**. A false red beside a false green, and
  the green half is the dangerous one — it certified a protection it never
  observed. That is this item's own defect one level up: a check whose input
  nobody supplies is indistinguishable from a check that agrees with you. Three
  times the stop gate, not the session, was what noticed the work was not done

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
- 🔴 **`plan-md` has no nesting — a sub-list becomes work** — writing AR3-36
  with two indented sub-bullets made `parsePlan` return **35** tickets for a
  33-item queue: the two sub-bullets parsed as items of their own, titled
  `**the marker** — mechanical…`. Caught by running `hygiene` after the edit
  rather than by reading the file, which looked correct. The adapter's flat-list
  limit is documented for *dependency links*; that it also forbids nesting in an
  item's own body is not, and the failure is silent in the direction that
  matters — it manufactures work nobody wrote. The item was rewritten as one
  paragraph; the adapter is untouched
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
