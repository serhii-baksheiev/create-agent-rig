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
hooks — **wired**, in a `.claude/settings.json` that names exactly the hooks it
installed — plus a `CLAUDE.md` that describes that rig rather than the generated
monorepo. It refuses to clobber an existing `CLAUDE.md`; if the repo already has
a `.claude/settings.json`, it keeps it and prints the entries to merge, because a
hook nothing calls is not enforcement.

Two things it deliberately leaves to you, and says so in the installed
`CLAUDE.md`: the Definition-of-Done gate has no `dod-checks.json` (it cannot know
your commands), and the elevated-path list names only what every repo has.

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
- **`guard-bash`** — refuses the part of the "Never" tier a text scan can decide:
  a force-push or `--delete` naming a shared branch, a push that names the default
  branch, `gh workflow run`/`gh api …/dispatches` against a production workflow,
  and `rm` on a catastrophic target. It **parses** the command rather than
  pattern-matching it, so a commit message mentioning a forbidden flag is prose,
  not a bypass — and the file states exactly what it does **not** inspect
  (`cdk deploy`, `find -delete`, a bare `git push`, and more);
- **`gate-stop-dod`** — refuses to end the session while a Definition-of-Done
  check is red; it fails open (a missing or corrupt config never makes the
  session unquittable) and never blocks twice in a row;
- **`inject-rules`** — re-injects the autonomy rules at session start, so they
  survive compaction and resumes.

**A brake that is a real file.** `touch ~/.claude/<project>-loop-STOP` and no
merge lands until it is removed — enforced at the tool layer, so it holds even if
nothing reads the rule. Everything short of the merge stays allowed on purpose:
finish the task, push the branch, open the PR, write the journal. Stopping
cleanly must not mean losing work.

**Two sweeps meant to run outside any session** — nothing schedules them for you;
that is deliberate, because a check a run performs on itself is one a hurried run
skips. `detect-missed-gate` finds merges
that crossed an elevated path with no recorded reviewer verdict;
`reconcile-external-prs` accounts for work that reached the default branch outside
the queue. They exist because the one failure a run cannot report is its own
missed gate — the run that skipped it is exactly the run that will not mention it.

**A queue behind an adapter.** The `loop` driver selects through
`.claude/scripts/queue/`: a pure core (filters in order, blocker resolution, the
elevated-tier ration, stop conditions) with adapters for `PLAN.md` (the default,
working before a project has a remote), GitHub Issues, and Jira. Two rules are
load-bearing and tested from both directions — **blockers resolve from links,
never labels**, and **the agent never files its own work items**.

Around all of it: **autonomy tiers** (what an agent does alone / after review /
never), **stop rules** (three strikes, flaky ≠ retry, session staleness),
**subagent gates** (`test-writer`, `code-reviewer`, `security-scanner`,
`prose-reviewer`, and `cdk-diff-reviewer` on the AWS target), **skills** (`pr-ship` pre-merge gate;
`loop` queue driver; `worktree-task` for concurrent sessions; `new-invariant`, a
generator for the invariant→hook→test pattern; `post-deploy-verify` and
`ro-debug` on the AWS target), and a one-page `CLAUDE.md` map a fresh session
orients by.

**The hooks are examples, not laws.** `.claude/rules/invariants.md` states the
pattern behind each one — a stated invariant, a mechanical check, a test for the
check — so you can delete the ones whose invariant your project does not have and
spend the slot on one it does. An inherited rule nobody chose is worse than an
empty rule file: the empty one is visibly incomplete, the inherited one is
invisibly wrong.

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

**And the enforcement layer is adversarially reviewed, not just tested.** The
Bash guard went through four review rounds with ten reviewers, who executed it
rather than read it. They found a PR body that could forge its own reviewer
verdict, a queue write that deleted the wrong line, and three ways to make the
guard crash into permitting everything. Each round's findings — including the
ones introduced by the previous round's _fix_ — are in the git history and in
`CHANGELOG.md`. The rule that came out of it is now part of what ships: a guard
that fails open must do provably bounded work, because fail-open turns every line
of its own work into a potential bypass.

Development (from a clone — `PLAN.md` and `demo.sh` live in the repository, not
in the published tarball): `pnpm test` (full), `pnpm test:unit` (fast loop),
`pnpm template:check` (templates in place). The plan of record is `PLAN.md`;
release notes and the release checklist ship in `CHANGELOG.md`.
