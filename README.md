# create-agent-rig

Scaffold a project that ships with an **agent operating system** — rules,
gates, and hooks that hold the architecture mechanically, not by prose.

```sh
npx create-agent-rig my-app                        # choose a target interactively
npx create-agent-rig my-app --target node-service  # or name it up front
```

Two coherent targets — `aws-serverless` (the default) and `node-service`. On a
terminal the CLI prompts; in CI it wants `--target` explicitly. `--no-git`
skips the initial baseline commit; `--no-color` (and `NO_COLOR`) plainens the
output.

Already have a repo? Install just the **process layer** into it — no
architecture assumptions, no skeleton:

```sh
npx create-agent-rig init            # rules, gates, stop rules into the current repo
npx create-agent-rig init --dry-run  # print the plan, write nothing
```

`init` drops in the autonomy tiers, stop rules, workflow, and the enforcement
hooks, and refuses to clobber an existing `CLAUDE.md`.

## What you get

**A system of boundaries, each held by tooling.** An agent (or a human using
one) cannot talk its way past them — each guard is a pre-write scan that stops
the normal path cold (review and tests back it; the claim is stated exactly,
never inflated). The hooks live in `.claude/hooks/` and are wired in
`.claude/settings.json`:

- **`guard-core-purity`** — refuses any edit that puts I/O, clock, randomness,
  environment access, or a non-allowlisted import into the pure domain core;
- **`guard-web-boundary`** — refuses `db`/service imports from the frontend;
  the web talks to the backend over HTTP only;
- **`block-no-verify`** — refuses bypassing pre-commit checks (and knows the
  difference between using the `--no-verify`/`-n` flag and merely mentioning it
  in a message);
- **`gate-stop-dod`** — refuses to end the session while a Definition-of-Done
  check is red; it fails open (a missing or corrupt config never makes the
  session unquittable) and never blocks twice in a row;
- **`inject-rules`** — re-injects the autonomy rules at session start, so they
  survive compaction and resumes.

Around the hooks, the operating system: **autonomy tiers** (what an agent does
alone / after review / never), **stop rules** (three strikes, flaky ≠ retry,
session staleness), **subagent gates** (`test-writer`, `code-reviewer`,
`security-scanner`, and `cdk-diff-reviewer` on the AWS target), **skills**
(`pr-ship` pre-merge gate; `loop` queue driver; `post-deploy-verify` with its
binary HEALTHY/REGRESSION verdict on the AWS target), and a one-page
`CLAUDE.md` map a fresh session orients by.

The skeleton around it is real and runnable — pure core shared by server _and_
browser (one schema validates on both sides of the wire), a mandatory usecase
layer (`payload → handler → usecase → model`), a queue with DLQ discipline,
tests at every layer.

## Targets

| Target           | One line                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws-serverless` | DynamoDB single-table, SQS + DLQ + CloudWatch alarm, three Lambdas (POST/GET `/notes` behind an HTTP API, plus an SQS worker), static web on S3 + CloudFront, CDK with least-privilege IAM grants |
| `node-service`   | `node:http` server that also serves the built web bundle, atomic JSON-file store behind the same model boundary, spool-directory queue + DLQ, worker process                                      |

Coherent alternatives, not a parameterized abstraction. Flexibility is
**subtraction**: the generated project is yours — delete what you don't need.

## What it deliberately does not do

No authentication. No design system or UI kit. No state manager. No i18n,
analytics, or error tracking. No third cloud. No component-testing apparatus.

Each of these is application surface, not an architecture proof — and every
addition is permanent maintenance in every target. The frontend is plain on
purpose: scaffolding gets replaced without friction; a finished-looking UI
gets fought. If you need one of these, add it — the project is yours.

## The 2-minute demo

```sh
./demo.sh   # from a clone of this repo
```

generates the `node-service` target → the generated project's own gates pass →
**an attempted core-purity violation is refused live by the hook** → the
service runs, a smoke request travels every layer, the worker drains the queue,
the DLQ stays empty:

```
== 3/4 an agent tries to put I/O and clock access into the pure core… ==
BLOCKED — packages/core is a pure module and this change breaks its purity:
  - imports "node:fs/promises" — the core may import only its own modules and: zod
  - reads the clock — take a timestamp as an argument
Move the impure part behind the usecase layer or into an adapter.
…and the guard-core-purity hook REFUSED the edit at the tool layer (exit 2). ✔
```

## Requirements

- Node ≥ 20 (pnpm recommended for the generated workspace). The CLI itself
  carries zero runtime dependencies — the `npx github:…`, tarball, and
  published-package paths all work.

## How it stays honest

Every template is a real project, installed with a frozen lockfile and run in
place on every push. Every e2e run generates a project cold and runs the
generated project's own checks (install → lint → typecheck → test, plus
`cdk synth` on the AWS target); the pack-path and git-path installs are both
under test, because that is exactly where scaffolders break. A grep-test keeps
the universal rules free of any provider mention; the hook-blocking behavior
itself is under test; and a weekly lockfile-free run resolves each template's
dependencies fresh to catch upstream breakage early. This repo dogfoods its own
rulebook — `CLAUDE.md` and `.claude/` are composed from the templates, and
drift fails the suite.

Development: `pnpm test` (full), `pnpm test:unit` (fast loop),
`pnpm template:check` (templates in place). The plan of record is `PLAN.md`.
