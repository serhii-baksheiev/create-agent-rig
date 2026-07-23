# create-agent-factory

Scaffold a project that ships with an **agent operating system** — not just
code. One command produces a runnable skeleton _plus_ the governance layer that
makes agentic development safe: autonomy tiers, mechanically enforced
invariants, subagent gates, stop rules, and a post-deploy verdict.

```sh
npx github:<user>/create-agent-factory my-app          # aws-serverless (default)
npx github:<user>/create-agent-factory my-svc --target node-service
```

## Why this exists

A monorepo scaffolder is a commodity. The rare part is the **operating system
for agents** that comes with it:

- **Autonomy tiers** — what an agent merges alone, what waits for review, what
  needs a human decision first, and what is _never_ allowed
  (`.claude/rules/autonomy.md`).
- **Mechanical enforcement, not prompt wishes** — a `PreToolUse` hook refuses
  impure edits to the domain core at the tool layer, and another refuses
  `--no-verify`. An agent cannot talk its way past them.
- **Subagent gates** — `test-writer` (the failing test comes first, and the
  agent writing it _cannot_ write implementation), `code-reviewer` (blocking
  checklist before every PR), `security-scanner` (auth/secrets/outbound
  triggers).
- **Stop rules by work-state** — three consecutive red runs → stop with a
  diagnosis; flaky ≠ re-run until green; invariant conflict → surface, don't
  pick a side.
- **Post-deploy verdict** — CI-green ≠ runtime-healthy; verify, and on
  regression revert first, never fix-forward blind.

## The 2-minute demo

```sh
./demo.sh
```

generate → the generated project's own gates pass → **an attempted core-purity
violation is refused by the hook, live** → the service starts, a smoke request
travels every layer, the worker drains the queue, the DLQ stays empty.

## Two layers, physically separate

```
templates/agent-os/universal/   stack-neutral rules, agents, hooks (no provider named — enforced by test)
templates/agent-os/stack/       node-ts, aws-cdk overlays, composed per target
templates/skeleton/<target>/    a coherent, runnable project per target — never fragments
```

Targets are **coherent alternatives, not a parameterized abstraction**:

| Target           | Shape                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `aws-serverless` | DynamoDB single-table, SQS + DLQ + alarm, two Lambdas, HTTP API, CDK with least-privilege IAM             |
| `node-service`   | `node:http` server, JSON-file store behind the same model boundary, spool-directory queue, worker process |

Both prove the same architecture: pure core (hook-enforced), mandatory usecase
layer, single-owner storage module, queue with DLQ discipline. Flexibility is
**subtraction**: the generated project is yours — delete what you don't need.

## How it stays honest

- Every template is a **real project, tested in place** — its own
  lint/typecheck/test/synth run in CI on every push.
- Every e2e run **generates a project cold and runs the generated project's own
  full check suite** (install → lint → typecheck → test → synth).
- A grep-test keeps `universal/` free of any provider mention; the second
  target was added **without editing universal at all**.
- The hook-blocking behavior itself is under test: a synthetic violating tool
  call must be refused with exit 2.
- This repo **dogfoods its own rules**: `CLAUDE.md` and `.claude/` are composed
  from `templates/agent-os` by `scripts/sync-agent-os.mjs`, and drift fails the
  suite. Field notes live in `NOTES.md`.

## Generation model

Tree copy + token substitution — no template engine, so the template never
stops being a runnable project. Tokens: `__PROJECT_NAME__`,
`__PROJECT_SCOPE__`, `__REGION__`, plus the _valid_ placeholder scope `@app/`
rewritten to `@<your-app>/`.

## Development

```sh
pnpm install
pnpm test            # build + unit + template + e2e (generates real projects)
pnpm test:unit       # the fast loop (pre-commit)
pnpm template:check  # the templates' own in-place checks
```

The plan of record is `PLAN.md`; its §2 decisions are locked.
