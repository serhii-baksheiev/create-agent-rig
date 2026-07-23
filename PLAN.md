# PLAN — `create-agent-rig` (project generator: agent-os + skeleton)

> Working plan for Claude Code. Phases are incremental: each one ends in something **that works**, not a half-built layer. The decisions in §2 are locked — do not re-litigate them without new data.

---

## 1. What this is and who it is for

A CLI that scaffolds a new project with (a) an **agent operating system** — rules, gates, subagents, hooks, DoD — and (b) a **code skeleton** for the chosen target.

**Users, by stage:**

1. **Now — the author.** Single user → zero options, edit anything in place.
2. **Later — 2–3 colleagues.**
3. **Possibly — an internal showcase at work** (conditional; see §7 Phase 7).

**What is valuable here (and what is not).** A monorepo scaffolder is a commodity — any team builds one in a week. The rare part is the **agent operating system**: autonomy tiers, mechanically enforced invariants, subagent gates, post-deploy verification, stop rules. The showcase (and the portfolio value) rests on that layer; the skeleton is the stand it sits on — the smallest thing that makes the rules visible in action.

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
| **The tool's own repo runs under its own `agent-os`** | Dogfooding: if the rules are awkward, you find out first |
| **Package name `create-agent-rig`, unscoped** | npm convention: a `create-*` package is invoked as `npx create-agent-rig my-app` with **no install** (the `create-react-app` pattern). A scoped name (`@scope/create-agent-rig`) breaks the short `npx` form — keep it unscoped |
| **Distribution: git first, registry later** | `npx github:<user>/create-agent-rig my-app` works with no registry at all — enough for the personal stage. Publishing is only needed once other people use it (phase 7) |

---

## 3. Repository layout

```
create-agent-rig/
  packages/
    cli/                          — the generator itself (TS, tested)
      src/
        index.ts                  — entry (bin)
        commands/create.ts
        lib/
          copy-tree.ts            — tree copy with ignore filters
          substitute.ts           — token substitution (contents + file names)
          targets.ts              — target registry
          prompts.ts              — interactive mode (phase 6+)
        templates.ts              — resolve paths into templates/
      test/
  templates/
    agent-os/
      universal/                  — stack-neutral
        CLAUDE.md
        .claude/
          agents/                 — test-writer, code-reviewer, security-scanner
          hooks/                  — mechanism + one genuinely blocking hook
          rules/
            architecture.md       — layers, boundaries, mandatory usecase
            workflow.md           — TDD, branches, PR, DoD
            autonomy.md           — tiers, stop rules, escalation
      stack/
        node-ts/                  — TS conventions, vitest, style
        aws-cdk/                  — infra rules, db rules (single-table etc.)
    skeleton/
      aws-serverless/             — a coherent, working project
      node-service/               — second target (phase 6)
  test/
    e2e/                          — generate into a temp dir + run the generated project's tests
  CLAUDE.md                       — rules for this repo itself (dogfooding)
```

---

## 4. Layer 1 — `agent-os/`

**What belongs in `universal/` (stack-neutral):**

- **Autonomy tiers** — what the agent merges on its own; what goes to a human; what is a hard "never".
- **Stop rules by work-state** — N-strike (≥3 consecutive red CI runs → stop with a diagnosis), per-task budget, "flaky ≠ re-run until green", invariant conflict → stop.
- **Subagent gates** — `test-writer` (writes the failing test before any implementation), `code-reviewer` (blocks the PR on checklist hits), `security-scanner` (triggers on auth / secrets / outbound calls).
- **Hooks** — the mechanism plus at least one **genuinely blocking** hook (module-boundary violation, or bypassing pre-commit). This is the demonstration that an invariant is enforced by tooling, not by a wish in a prompt.
- **DoD checklist** and **PR policy**.
- **Post-deploy verification** — the rule "CI-green ≠ runtime-healthy", with the verdict: regression → revert, never fix-forward blind. *(Stated stack-neutrally: "verify runtime health by whatever means the target provides".)*

**What does NOT belong in `universal/`:** anything naming a concrete provider, SDK, or storage schema → move it to `stack/<name>/`.

**Split criterion:** a rule is universal if it can be applied without knowing where the project is hosted.

---

## 5. Layer 2 — `skeleton/<target>/`

Each target is a **coherent, self-contained, working** project. No code is shared between targets: duplication here is **cheaper** than abstraction.

### 5.1 `aws-serverless` (first target)

**🔴 The smallest project that proves the architecture — NOT a clone of an existing product.** Exactly enough that every layer is visible and the gates actually fire:

- `packages/core/` — a pure module (zero I/O, no clock, no randomness): one domain function + a zod schema;
- `packages/db/` — one model; the single place that touches the storage SDK;
- `packages/shared/` — logger, `loadEnv(zod)`, typed errors;
- `services/api/` — **one** HTTP route through every layer: payload (zod) → handler → usecase → service → model;
- `services/worker/` — **one** queue consumer + DLQ + alarm;
- `infra/` — a CDK stack with least-privilege IAM;
- tests at every layer (the core exhaustively); CI: lint + test + synth.

**What it demonstrates:** the mandatory usecase layer, core purity (and the hook that defends it), DLQ discipline, TDD.

### 5.2 Substitution mechanism

- The template uses a **valid** placeholder scope `@app/` so it runs as-is; the CLI rewrites `@app/` → `@<scope>/`.
- Tokens: `__PROJECT_NAME__`, `__PROJECT_SCOPE__`, `__REGION__` — keep the token set **small** and documented.
- Substitution applies to file **contents and file names**.
- Binary files are copied untouched.

---

## 6. Flexibility model (staged, not all at once)

| Level | Mechanism | When |
| --- | --- | --- |
| **1. Subtraction** | The generated project is yours — delete what you don't need | From phase 3 (always the default) |
| **2. Target selection** | `--target aws-serverless \| node-service` — coherent alternatives | Phase 6 |
| **3. Optional modules** | `--with-<feature>` inside a target | Phase 7, **data-gated only** |

🔴 Level 3 is allowed **only** for genuinely detachable capabilities and **only** after real usage shows someone needs the choice. Until then: subtraction.

---

## 7. Phases

### Phase 0 — Bootstrap the tool's repository

- pnpm workspace, TS, vitest, eslint + prettier, husky / pre-commit;
- CI: lint + typecheck + test;
- its own `CLAUDE.md` (draft — it becomes the source for `agent-os/universal` in phase 2).

**DoD:** green CI on an empty repo; `pnpm test` passes.

---

### Phase 1 — Walking skeleton of the CLI

End-to-end generation over a **trivial** tree (a `package.json` plus one file) — the generation architecture matters here, not the payload.

- `bin` + argument parsing: `create <dir>`;
- `copy-tree` (ignore list: `node_modules`, `dist`, local artifacts);
- `substitute` (contents + file names);
- errors: target directory exists and is non-empty → a clear refusal.

**🔴 An e2e test starts here:** generate into a temp directory → assert structure and substitution. This is the foundation of §8.

**DoD:** `pnpm test` green including e2e; a local tarball install (`npm pack` → `npx <tarball> myapp`) produces the expected tree; `npx github:<user>/create-agent-rig myapp` produces the same tree (the personal-stage distribution path — no registry needed).

**Note on what "done" means for the user-facing goal:** this phase makes the *mechanism* work, but the output is still a trivial tree. The expected end result — `npx create-agent-rig my-app` producing a real, runnable project — lands at the end of **phase 3**.

---

### Phase 2 — `agent-os/universal`

**The core of the value.** Authored **fresh** as a statement of the approach (§9), not by copying.

- The template's `CLAUDE.md`: the map, an "if you read only four sections" pointer, architecture, autonomy boundaries, foot-guns;
- `rules/architecture.md`, `rules/workflow.md`, `rules/autonomy.md`;
- `agents/`: `test-writer`, `code-reviewer`, `security-scanner` — with triggers and scope boundaries;
- `hooks/`: the mechanism + **one genuinely blocking** hook;
- DoD checklist + PR policy.

**DoD:**

- the generated project contains a working `.claude/`;
- 🔴 **the hook demonstrably blocks a violation** (test: an attempted boundary breach is refused at the tool layer);
- a fresh Claude Code session in the generated project can orient itself without outside explanation.

---

### Phase 3 — `skeleton/aws-serverless`

A minimal but **real** project (§5.1).

- All layers + tests + CDK + CI;
- the generated project's README: how to run it, how to deploy it, where the boundaries are.

**🔴 Anti-rot invariant:** the template is exercised by tests **in place** (it is a valid project), and separately after generation.

**DoD:**

- inside the template directory: `pnpm test`, `pnpm lint`, `cdk synth` — all green;
- after generation: the same, green, in the generated project;
- the phase-1 e2e is extended: generate → install → run the generated project's tests → `synth`.

---

### Phase 4 — Split `agent-os/universal` ↔ `stack/`

The first target exists — draw the seam **before** adding a second one.

- Move AWS/DynamoDB/CDK specifics out of `universal/` into `stack/aws-cdk/`;
- move TS/vitest conventions into `stack/node-ts/`;
- the CLI assembles `.claude/` as a **composition**: `universal` + `stack/<selected>`.

**DoD:** `universal/` contains no mention of any provider or SDK; the generated project receives a correct composition of rules; composition tests are green.

---

### Phase 5 — Dogfooding + quarantine

- The tool's repository switches to its **own** `agent-os/universal` + `stack/node-ts`;
- record what turned out to be awkward — this is the first honest data on the quality of the rules.

**DoD:** the tool repo's `CLAUDE.md` is generated from / synced with `templates/agent-os/` rather than living as a separate copy; drift is caught by a test.

---

### Phase 6 — Second target (portability proof)

**Recommendation: `node-service`** — a plain Node service (container / local run), no cloud. Reasons: it is the cheapest proof of the seam, and it is likely closer to the next personal projects (tools, daemons) than a second cloud would be.

- `--target <name>`, a target registry, interactive selection when the flag is absent;
- `skeleton/node-service/`: the same layers without AWS — an HTTP server, in-memory/file storage behind the same "model" boundary, the worker as a process;
- `agent-os` composition: `universal` + `node-ts` (no `aws-cdk`).

**🔴 This is where the central claim gets tested:** did `universal` apply **without edits**? If it had to be edited, the seam is wrong — fix the seam, don't bend the rule to fit the target.

**DoD:** both targets generate and pass their own tests; `universal` was not modified for the sake of the second target; the per-target e2e matrix is green.

---

### Phase 7 — Showcase / portfolio layer *(conditional on audience, not on value)*

- **A 2-minute demo script:** generate → tests green → **an attempted invariant violation is blocked by the hook** → run/deploy. The blocking scene is the strongest one.
- README with the governance narrative: autonomy tiers, mandatory gates, stop rules, the post-deploy verdict.
- (optional) publish to an internal or public registry.

**Note:** the audience for this phase is conditional (internal presentation vs. public repo / portfolio), but the artifact serves both. Do not decide the audience now — it does not affect the architecture of phases 0–6.

**DoD:** the demo reproduces from scratch on a clean machine, following the README, within the stated time.

---

## 8. Verification strategy (cross-cutting, from phase 1)

The only thing that keeps a scaffolder from rotting:

1. **The template is tested in place** — it is a valid project, its CI runs it;
2. **The generated project is tested after generation** — `install → test → lint → synth`;
3. **A per-target matrix** — from phase 6;
4. **A rules-composition check** — `universal` free of stack specifics (grep), `.claude/` assembled correctly;
5. **A blocking-hook test** — the violation is refused.

Items 1–2 are **mandatory** in CI: without them the template stops building within a couple of months and you learn about it from a user.

---

## 9. 🔴 Provenance constraint for `agent-os/`

`agent-os/` is written as an **independent statement of the approach**: tiers, stop rules, gate structure, DoD — these are a method, and a method can be articulated from scratch. **Do not** copy files out of a private work repository.

In practice: open an empty file and write the rule in your own words rather than `cp`. This also has a side benefit — a rule rewritten deliberately usually comes out cleaner than the original.

---

## 10. What not to do

| Don't | Why |
| --- | --- |
| Build a "cloud-agnostic storage/queue" abstraction | Lowest-common-denominator or leaky facade. Portability comes from coherent targets |
| Add options before phase 6–7 | The axes of variation are unknown; every flag is maintenance without benefit |
| Clone an existing product into the skeleton | The skeleton proves the architecture; it does not reproduce features. A big skeleton is a big maintenance bill |
| Use a template engine (handlebars/ejs) | It breaks "the template is a working project"; token substitution is enough |
| Copy `agent-os` from the work repository | See §9 |
| Make a second **cloud** the second target | Expensive, and it proves the seam no better than `node-service` |

---

## 11. Open questions for the owner

- ~~Tool name~~ — **decided: `create-agent-rig`, unscoped** (see §2).
- **Second target** — is `node-service` right, or should it be another shape (a CLI tool? a frontend app?).
- **Registry** — private / internal / public (affects phase 7, not before).
- **Repository hosting** — where it lives (affects CI and §9).
