# Runners — hosted first, self-hosted as the fallback

Owner ruling, 2026-09-13. This repository is public, so standard GitHub-hosted
runners cost it no minutes; the ruling is about **dependency**, not money: no
pull request and no release check may depend on a machine somebody has to
switch on.

## The two paths

| workflow  | when                                                                          | runner                                                                           |
| --------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `ci.yml`  | every pull request and push to master                                         | hosted only — `ubuntu-latest`, `windows-latest`; no switch exists on this path   |
| `e2e.yml` | push to master, nightly, dispatch, PRs on CLI/template paths (Linux job only) | hosted by default; `self-hosted` through one switch, same jobs and same commands |

What each lane runs, and that the Windows full suite stays off pull requests,
is pinned in `test/template/root-ci.test.ts` › "runs a Windows smoke lane — the
unit project only — on the hosted image", › "keeps the pull-request path off
self-hosted runners entirely" and › "keeps the Windows full suite off pull
requests — it runs on master, nightly and by dispatch".

## The switch

One switch, read in `runs-on` of every `e2e.yml` job — pinned in
`test/template/root-ci.test.ts` › "accepts runner_mode hosted|self-hosted by
dispatch input and by repository variable, hosted by default":

- **per run:** `gh workflow run e2e.yml --ref <branch> -f runner_mode=self-hosted`
- **standing:** the repository variable `RUNNER_MODE=self-hosted`
  (Settings → Secrets and variables → Actions → Variables); delete it to
  return to hosted.

Self-hosted runners are selected by label set: `self-hosted, Linux, X64` and
`self-hosted, Windows, X64`. A dispatch in self-hosted mode with no runner
registered under those labels queues until one appears — it does not fall back
to hosted silently, and it does not fail.

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

Every job prints one line before it checks out — `runner.name`, `runner.os`,
`runner.environment` (`github-hosted` or `self-hosted`), `runner.arch`,
`ImageOS` and the SHA — pinned in `test/template/root-ci.test.ts` › "records
which runner executed each job, so release evidence can name it". A release
entry cites, per required check: the SHA, the run URL, the runner type and
label from that line, the command, the result with its skips, and the reason
when the self-hosted fallback was used.

## Registering a self-hosted runner

This repository has no runner registered today (`gh api
repos/{owner}/{repo}/actions/runners` → `total_count: 0`). Registration is
repository-scoped and follows GitHub's own procedure (Settings → Actions →
Runners → New self-hosted runner), with the labels above added at
configuration time. Nothing in this repository installs or configures a
runner; the Memory repository's dedicated Windows host is registered there,
not here, and cannot be scheduled from this repository's workflows.
