# PLAN — `create-agent-rig` (project generator: agent-os + skeleton)

> Working plan for Claude Code. Phases are incremental: each one ends in something **that works**, not a half-built layer. The decisions in §2 are locked — do not re-litigate them without new data.
>
> **Status (v0.3.0).** Phases 0–7 are all shipped, plus the factory extraction (§7.5, §7.6). **Published on npm** — `0.1.0` and `0.2.0` are live; `npx create-agent-rig` resolves from the registry, and the git path still works unchanged. Several briefs landed on top of the original plan — see §7.5. What remains for the owner: publishing `0.3.0` (§11) and a recorded demo. Detailed field notes and per-brief findings live in `NOTES.md`; this file is the map, `NOTES.md` is the log.

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
      index.ts                       — bin: create <dir> [--target --no-git --no-color --version] | init
      commands/create.ts             — generate: compose layers, substitute, git baseline
      commands/init.ts               — install the PROCESS layer into an existing repo
      lib/
        copy-tree.ts                 — tree copy + ignore list + mode preservation
        substitute.ts                — token + @app/ + gitignore→.gitignore substitution
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
- **Agents** — `test-writer` (writes the failing test, cannot implement), `code-reviewer` (blocking checklist, incl. a change that contradicts its queue item), `security-scanner` (auth/secrets/parsing/outbound triggers), `prose-reviewer` (the documents that instruct agents: overstated enforcement, dead references, rules that contradict each other, stale limits).
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

---

## 8. Verification strategy (as built)

The scaffolder is kept from rotting by:

1. **Templates tested in place** — each skeleton is a valid project; CI runs `pnpm check` per target (`template-aws-serverless`, `template-node-service` jobs).
2. **The generated project tested after generation** — the e2e suite generates cold and runs the generated project's own `check` (install → lint → typecheck → test → build → synth), for **both** targets, and via the **pack path** (tarball install), not only git.
3. **A per-target matrix** — both targets exercised in CI and e2e.
4. **A rules-composition check** — `universal` free of any provider mention (grep), `.claude/` assembled without path collisions, the layer-chain stated identically everywhere.
5. **Hook / gate tests** — every hook's blocking behaviour under test; the DoD stop-gate and rule-injection behaviour; the deploy workflows' OIDC/no-static-keys/degrade-cleanly invariants.
6. **A weekly lockfile-free run** — `template-freshness.yml` reinstalls each template without a lockfile and runs its checks (the primary early-warning channel now that Next is in the stack).

Test surface: 7 CLI unit files, 18 `test/template/*` files, 6 `test/e2e/*` files (503 tests). Items 1–2 are mandatory in CI.

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
- **npm registry publish** — done for `0.1.0` and `0.2.0`; `0.2.0` has been live since 2026-07-23. Each release is an owner action, because `npm publish` needs 2FA and is irreversible: an agent prepares the release and stops at that command. The release checklist lives in `CHANGELOG.md`.
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

- AR-12 [elevated]: declare `templates/agent-os/stack/aws-cdk/.claude/rules/` and `.../node-ts/.claude/rules/`. The aws-cdk one is the sharp case: that file carries its **own** `elevated-paths` block declaring `infra/`, so a merge deleting the block would silently un-declare infrastructure for every generated AWS project — and the sweep would report it clean. Found by review on AR-11, which did not ask for these two
- AR-5 [elevated]: prepare release 0.4.0 — CHANGELOG in the repo's convention (what a freshly generated project gets, and why), plus what the brief defers and on which entry condition; smoke `create` and `init` on a scratch project. **Stops at `npm publish`** — that is the owner action below. Genuinely depends on the items above, which a flat list cannot express: check they are merged before taking it

## Operator queue

Decisions and Tier-2 work waiting on a human. State what is needed, not what to do.

- ~~**decide: does the neutral `Ticket` shape gain a `body` field?**~~ — **decided by the owner's delegation: yes.** The alternative was two hygiene checks living inside each adapter, which is the same invariant implemented three times — and `invariants.md` says the copy nobody is looking at is the one that is wrong. `body` is nullable, because `plan-md` has none to give and an empty string would read as "checked, found nothing" rather than "cannot answer". The decision belongs in the shape's comment, not only here (AR-3b)
- **publish 0.4.0 to npm** — owner action by standing decision (§11): 2FA, irreversible; the agent prepares the release and stops at the command
- **AR-4 entry conditions** — port item 117 once it is merged in Flowa; port C-0…C-2 once the clarify gate has fired at least once. Shipping an unproven gate to other people's projects is worse than not having it
- **does the downstream project take the reverse port?** Out of the port brief's scope by construction. The fact that its copies of `guard-bash`, `detect-missed-gate` and the `loop` skill are behind this repo's is recorded in `NOTES.md` ("The port brief — and the drift that runs the other way"), which is where it stays whether or not this question is ever answered

## Journal

Newest first, date-free — order carries the sequence. Prune freely: this is
operational memory, not an archive. Fields per the template in
`templates/agent-os/universal/PLAN.md`; a field the session cannot observe stays
**visibly empty, never estimated**.

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
