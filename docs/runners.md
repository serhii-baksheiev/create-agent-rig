# Runners — hosted first, self-hosted as the fallback

Owner ruling, 2026-09-13. This repository is public, so standard GitHub-hosted
runners cost it no minutes; the ruling is about **dependency**, not money: no
pull request and no release check may depend on a machine somebody has to
switch on.

## The two paths

| workflow  | when                                                                                | runner                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`  | every pull request and push to master                                               | hosted only — `ubuntu-latest`, `windows-latest`; no switch exists on this path                                                                       |
| `e2e.yml` | push to master, nightly, dispatch; PRs on CLI/template paths run the Linux job only | hosted by default; `self-hosted` through one switch on push, nightly and dispatch — on a pull request the switch is ignored and the job stays hosted |

What each lane runs, that no pull request can reach a self-hosted runner, and
that the Windows full suite stays off pull requests are pinned in
`test/template/root-ci.test.ts` › "runs a Windows smoke lane — the unit
project only — on the hosted image", › "keeps the pull-request path off
self-hosted runners entirely" and › "keeps the Windows full suite off pull
requests — it runs on master, nightly and by dispatch".

## The switch

One switch, read in `runs-on` of every `e2e.yml` job and guarded off pull
requests — pinned in `test/template/root-ci.test.ts` › "accepts runner_mode
hosted|self-hosted by dispatch input and by repository variable, hosted by
default":

- **per run:** `gh workflow run e2e.yml --ref <branch> -f runner_mode=self-hosted`
- **standing:** the repository variable `RUNNER_MODE=self-hosted`, spelled
  exactly so (Settings → Secrets and variables → Actions → Variables); delete
  it to return to hosted.

Self-hosted runners are selected by label set: `self-hosted, Linux, X64` and
`self-hosted, Windows, X64`. Confirm a runner carrying those labels is online
before dispatching in self-hosted mode. A runner on this path needs `bash`
(both jobs' first step) and, on Windows, `pwsh`, the shells the jobs already
declare.

Two consequences of the shape. On a pull request the `windows-e2e` check
reports `skipped`, not `success` — observed on PR #211's own head (`16d53eb`,
E2E run 34775448341); the merge criterion in `.claude/rules/node-ts.md` reads
`ci` and, where the paths trigger it, `e2e`. And `gh workflow run e2e.yml
--ref <branch>` is a `workflow_dispatch`, which the job's `if:` does not
exclude, so it runs **both** jobs, the full Windows suite included, on that
branch head — pinned by `test/template/root-ci.test.ts` › "keeps the Windows
full suite off pull requests — it runs on master, nightly and by dispatch".

## When to switch

Only on a confirmed **infrastructure** condition:

- GitHub reports the hosted Actions quota exhausted or hosted runners disabled
  for the repository;
- hosted capacity is unavailable as a platform (an incident), not because a
  job failed;
- the owner sets `runner_mode=self-hosted` or the variable.

A failing test, a timeout, an assertion or a broken build is **not** a reason:
classify the defect first. A red hosted job is never re-run on self-hosted as a
way to get green, and an unchanged suite is never re-run until green on either
runner type.

## What a release transcript records

Every `e2e.yml` job prints one line before it checks out — `runner.name`,
`runner.os`, `runner.environment` (`github-hosted` or `self-hosted`),
`runner.arch`, `ImageOS` and the SHA — pinned in
`test/template/root-ci.test.ts` › "records which runner executed each job, so
release evidence can name it". The `ci.yml` jobs name their runner in
`runs-on` literally and print nothing. A release entry cites, per required
check: the SHA, the run URL, the runner type and label from that line, the
command, the result with its skips, and the reason when the self-hosted
fallback was used.

## Registering a self-hosted runner

This repository has no runner registered today (`gh api
repos/{owner}/{repo}/actions/runners` → `total_count: 0`). Registration is
repository-scoped and follows GitHub's own procedure (Settings → Actions →
Runners → New self-hosted runner), with the labels above added at
configuration time; register it ephemeral and on an isolated host, because
the jobs it would run check out and execute this repository's code. Nothing in
this repository installs or configures a runner; the Memory repository's
dedicated Windows host is registered there, not here, and cannot be scheduled
from this repository's workflows.
