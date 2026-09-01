# PLAN — `create-agent-rig` (project generator: agent-os + skeleton)

> Working plan for Claude Code. Phases are incremental: each one ends in something **that works**, not a half-built layer. The decisions in §2 are locked — do not re-litigate them without new data.
>
> **Status (0.7.0 published 1 Sep 2026; queue moved to Jira `AR` on 16 Aug 2026).** Phases 0–7 are all shipped, plus the factory extraction (§7.5, §7.6), the port brief (§7.7) and the upgrade brief (§7.8). **Published on npm** — `0.1.0` through `0.7.0` are live and 0.7.0 is `latest`, published from `gitHead` `6589db36` with `dist.shasum` `34c94881`. Step 8 in `CHANGELOG.md` — `npm publish` itself — is the owner's alone, because it needs 2FA and is irreversible, and it stayed so. Step 9's checks, smoking the published artifact, have been run against both targets and the `upgrade` path, with the evidence in `journal/2026-09.md`; `CHANGELOG.md` still marks step 9 an owner step, and reconciling those two is the owner's call rather than this file's. `npx create-agent-rig` resolves from the registry, and the git path still works unchanged. An installed rig is brought forward by `create-agent-rig upgrade` rather than by a procedure in a release note. Releases here ship **untagged** — a standing owner decision, since the owner publishes by hand; `CHANGELOG.md` step 7 records what that costs the released-hash table and AR-35 carries the fix. Detailed field notes and per-brief findings live in `NOTES.md`; this file is the map, `NOTES.md` is the log.

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
        PLAN.md                      — two-queue work convention (Agent / Operator)
        journal/README.md            — the journal convention: one file per month,
                                       journal/YYYY-MM.md, newest-on-top (AR-64)
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
  - `inject-rules` (SessionStart) — re-injects `autonomy.md` so the rules survive compaction/resume, minus the regions that file marks `inject:skip`; it reads no headings, so what is left out is authored in the rule file rather than inferred here.
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
- **npm registry publish** — done through `0.7.0`, the current `latest`. Each release is an owner action, because `npm publish` needs 2FA and is irreversible: an agent prepares the release and stops at that command. The release checklist lives in `CHANGELOG.md`.
- **A recorded demo** (asciinema/GIF of `demo.sh`) for the README — owner action; the static frame is in place.
- **`--with-*` options / a third target** — deliberately deferred; only unlock on real Phase-11 usage data (§6, §10). (The `worktree` rule is no longer parked — `worktree-task` shipped in 0.3.0.)
- **Side task (outside this repo):** audit the reference project's own skills for `context: fork` + `allowed-tools`.

---

## Agent queue

**Moved to Jira on 16 Aug 2026 — project `AR`, board 34**
(`https://sbaksheiev.atlassian.net/jira/software/projects/AR/boards/34/backlog`).
`.claude/queue.json` reads `{"adapter":"jira","options":{"project":"AR"}}`; this
section is deliberately empty and `parsePlan` must return zero from it. The
adapter needs `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` from the
environment, read per-invocation from a file **outside** the repository, never
an exported variable. The value in `queue.json` is written by a repo-specific
override in `compose()` (`scripts/sync-agent-os.mjs`) — an in-place edit is
drift, and exempting the file was the rejected alternative, because an exempted
file is one the drift check stops reading.

🔴 **Everything below this line is prose, and that is mechanical, not
stylistic.** `parsePlan` takes **any** `- ` or `* ` line in this section as a
work item — including an **indented** one, since the pattern is
`/^\s*[-*]\s+/`, which is how a sub-list once became work. It has no
notion of a note. So a fact written here as a bullet
becomes the next task a `plan-md` run is handed, silently and at `tier:
normal`. AR-64 cut this section to bullets, measured `parsePlan` → 3, and put
the facts back as paragraphs; the byte saving was never worth a queue that
hands out its own footnotes. Write additions here as paragraphs, and keep the
"cut to bullets" instruction for the Operator queue, which is never parsed for
items.

Three facts below survive from the prose this section used to carry (AR-64).
Everything else was cut because it is stated elsewhere: the tier marker as a
pre-filter is in `loop/SKILL.md` and `state.mjs`, blockers-from-links is in
`loop/SKILL.md`, and the Flowa provenance rule is `CLAUDE.md` rule 0. The
migration map went to `journal/2026-08.md` with the entry that describes the
move. Do not restore the rest; do not delete these three.

🔴 **The empty heading above stays.** A missing `## Agent queue` is
`queue-unreadable` and **exit 1**, not the `queue-empty` **exit 0** an empty
section gives — opposite verdicts. `plan-md.mjs` throws and `index.mjs` turns it
into that stop, so deleting a contentless heading is not tidying.

⚠ **`AR-n` names two different things.** Keys on board 34 are Jira issues;
`AR-3`, `AR-4`, `AR-12` and their neighbours in the port brief and in the
journal are the brief's own numbering, which predates this project. Every
brief-sense key now also exists as a real ticket, so a reader following a
citation lands on an unrelated issue **with no error**. Check which numbering a
citation is in before following it.

🔴 **`ready` is a human-facing hint that no selection path reads.** What keeps
`operator-queue` and `triage` out of selection is the adapter reading those
labels (`EXCLUDED_LABELS`, `jira.mjs`). Resting the split on `ready` would be
worse than useless: a JQL filter on `labels = ready` against a board that does
not carry it returns an empty set, and an empty set with nothing skipped is
`queue-empty` — exit 0, a "successful session", with 40 issues open.

## Operator queue

**Moved to Jira with the Agent queue** — label `operator-queue`, plus `triage`
for proposals. Open at migration: AR-35 (the 0.5.0 tag trap), AR-36 (0.5
decisions), AR-37 (watchers), AR-38 (rule the `loop` §9 self-contradiction on
where a close is written). AR-45 (the adapter switch) is done, so `proposeTriage`
now files a `triage`-labelled issue and the hand-carry step is gone.

Two rules survive from the prose this section used to carry (AR-64):

- 🔴 **The carried bullets below are not open items — they are the
  fingerprint's home under `plan-md`, and deleting one hand-performs the defect
  AR-48 is about.** The fingerprint is the only memory dedup has here; without
  the line, the next run files the same proposal again as a fresh `seen ×1`.
  They stay, marked `[carried → AR-n]` in that fixed form at the head of the
  line, until AR-48 moves the dedup base to the configured adapter.
- 🔴 **The `· fingerprint: … · seen ×N` tail is never edited by hand.** A line
  becomes a candidate only by matching that whole tail (`TAIL`, `plan-md.mjs`),
  and the comparison then runs on the fingerprint inside it. One character
  changed in either makes the next filing a duplicate. The `seen ×N` digit is
  the one part that survives tampering — the tail still matches and the
  fingerprint still compares equal, so the next filing increments from the
  falsified number instead. Quieter, not safer.

- [carried → AR-46] **proposal: Either scope the declaration so it does not reach spawned children of the test runner (declare it per-command rather than as a shell export), or have the harness strip RIG_RUN_DIR from the environment it passes to the CLI, the way withoutGitLocation() strips GIT_DIR for git spawns. Same family as the GIT_DIR incident: ambient environment reaching a child that was never meant to see it, and resolving to a wrong answer rather than an error. [triage]** — finding: journal: the queue left the file — `loop` §1 tells every run to export RIG_RUN_DIR, and the exported variable reached both the CLI a test spawns in a temp project (turning test/template/review-fixes.test.ts RED) and this run’s real decisions.jsonl, which took 14 fixture records at seq 5-18 · part: .claude/skills/loop/SKILL.md §1 (the RIG_RUN_DIR declaration) and the harness that spawns the queue CLI — the contamination path, not only the exit-1 symptom · proof: EITHER branch is checkable and the proposal is satisfied by one. STRIP: `RIG_RUN_DIR=<a real run dir> pnpm test:unit` is green AND leaves that directory unchanged — today it fails 1 of 868 (test/template/review-fixes.test.ts:494, "expected 1 to be +0") and appends 14 records. SCOPE: the skill no longer instructs a shell export, so a run following it verbatim finishes with `pnpm test:unit` green and its run directory carrying only records the run itself wrote — check the DIRECTORY, not the command, because under this branch the variable is never in the environment to begin with. Precondition for either check: `pnpm test:unit` in a shell that never exported the variable is green TODAY, so checking the bare command retires a live defect. · fingerprint: `journal-the-queue-left-the-file-loop-1-t:claude-skills-loop-skill-md-1-the-rig-ru:either-scope-the-declaration-so-it-does-` · seen ×1
- [carried → AR-47] **proposal: A third stop kind, or a qualifier on queue-empty, for the case where the configured adapter is not the one the project declares its work lives in. AR3-35 split `queue-empty` from `nothing-selectable` precisely because an operator cannot otherwise tell whether the queue needs refilling; this run hit a third case neither covers — the work exists and is unreachable — and reported it as genuinely out of work. [triage]** — finding: journal: the queue left the file — stopped at `queue-empty` with 45 issues open on the board, because the adapter that can read them is not switched yet (AR-45) · part: .claude/scripts/queue/core.mjs (stopConditionOf) + .claude/skills/loop/SKILL.md §3 · proof: A run configured with `plan-md` against a PLAN.md whose Agent queue section declares the work has moved elsewhere stops with a verdict naming the unreachable queue, not "queue empty … refilling the queue is the owner’s job". Today the two are indistinguishable from the stop line. · fingerprint: `journal-the-queue-left-the-file-stopped-:claude-scripts-queue-core-mjs-stopcondit:a-third-stop-kind-or-a-qualifier-on-queu` · seen ×1
- [carried → AR-48] **proposal: State, or handle, what dedup means once the queue a fingerprint was filed into is no longer the queue being read — `seen ×N` silently resets, so a proposal filed twenty times before the migration reappears as a fresh `seen ×1`, the failure the cap exists to prevent. Cover the second path too: the fingerprint is derived from finding/part/change, so editing any of those three in place leaves a slug that matches nothing and the next filing writes a duplicate. [triage]** — finding: journal: the queue left the file — the eight triage proposals migrated to Jira, so proposeTriage under plan-md can no longer find the fingerprints of proposals this repo has already filed; and hand-editing a filed bullet desynchronises its fingerprint from its own text, which this run did and the gate caught · part: .claude/scripts/queue/core.mjs (`duplicateOf` at :575, `fingerprintOf` at :557) as called from .claude/scripts/queue/plan-md.mjs:408 · proof: EITHER branch is checkable and the proposal is satisfied by one. HANDLE: filing a proposal whose fingerprint matches a migrated one increments a count or reports the collision instead of writing a fresh `seen ×1`; and editing a filed bullet’s prose either regenerates its fingerprint or is refused. STATE: plan-md cannot query Jira for a migrated fingerprint, so both limits are written into the dedup comment and a reader finds them there rather than inferring the reset from a count. · fingerprint: `journal-the-queue-left-the-file-the-eigh:claude-scripts-queue-core-mjs-duplicateo:state-or-handle-what-dedup-means-once-th` · seen ×1

## Where the journal is

`journal/YYYY-MM.md` — one file per month, newest-on-top inside each (AR-64).

It used to be a section here, and that section was 58 KB of a 102 KB file: two
thirds of the cost of opening this plan, paid by every session, for history that
almost none of them needed. The convention and the field list live in
`templates/agent-os/universal/journal/README.md`, which is also the copy a
generated project gets.

🔴 The heading here is deliberately **not** `## Journal`. A pointer under that
name still sends a session into this file to look, which is the cost the move
exists to remove.
