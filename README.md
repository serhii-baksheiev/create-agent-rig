# create-agent-rig

Scaffold a project that ships with an **agent operating system** — rules,
gates, and hooks that hold the architecture mechanically, not by prose.

```sh
npx create-agent-rig my-app
```

## What you get

**A system of boundaries, each held by tooling.** An agent (or a human using
one) cannot talk its way past them:

- **`guard-core-purity`** — refuses any edit that puts I/O, clock, randomness,
  or environment access into the pure domain core;
- **`guard-web-boundary`** — refuses `db`/service imports from the frontend;
  the web talks to the backend over HTTP only;
- **`block-no-verify`** — refuses bypassing pre-commit checks (and knows the
  difference between using the flag and merely mentioning it in a message).

Around the hooks, the operating system: **autonomy tiers** (what an agent does
alone / after review / never), **stop rules** (three strikes, flaky ≠ retry,
session staleness), **subagent gates** (`test-writer`, `code-reviewer`,
`security-scanner`, `cdk-diff-reviewer`), **skills** (`pr-ship` pre-merge
gate; `post-deploy-verify` with its binary HEALTHY/REGRESSION verdict), and a
one-page `CLAUDE.md` map a fresh session orients by.

The skeleton around it is real and runnable — pure core shared by server _and_
browser (one schema validates on both sides of the wire), a mandatory usecase
layer, a queue with DLQ discipline, tests at every layer.

## Targets

| Target           | One line                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `aws-serverless` | DynamoDB single-table, SQS + DLQ + alarm, three Lambdas behind an HTTP API, static web via S3 + CloudFront, CDK with least-privilege IAM  |
| `node-service`   | `node:http` server that also serves the web bundle, JSON-file store behind the same model boundary, spool-directory queue, worker process |

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

generate → the generated project's own gates pass → **an attempted core-purity
violation is refused live by the hook** → the service runs, a smoke request
travels every layer, the worker drains the queue, the DLQ stays empty:

```
== 3/4 an agent tries to put I/O and clock access into the pure core… ==
BLOCKED — packages/core is a pure module and this change breaks its purity:
  - imports "node:fs/promises" — the core may import only its own modules and: zod
  - reads the clock — take a timestamp as an argument
Move the impure part behind the usecase layer or into an adapter.
…and the guard-core-purity hook REFUSED the edit at the tool layer (exit 2). ✔
```

## Requirements

- Node ≥ 20 (pnpm recommended for the generated workspace)

## How it stays honest

Every template is a real project tested in place on every push; every e2e run
generates a project cold and runs the generated project's own full checks
(install → lint → typecheck → test → build → synth); a grep-test keeps the
universal rules free of any provider mention; the hook-blocking behavior
itself is under test; and a weekly lockfile-free run catches upstream breakage
early. This repo dogfoods its own rulebook — `CLAUDE.md` and `.claude/` are
composed from the templates, and drift fails the suite.

Development: `pnpm test` (full), `pnpm test:unit` (fast loop),
`pnpm template:check` (templates in place). The plan of record is `PLAN.md`.
