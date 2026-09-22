# Runners — GitHub-hosted only

Owner ruling, 2026-09-22. Every workflow job in this repository runs on a
standard GitHub-hosted image, named literally in its `runs-on`. This
repository is public, so those runners cost it no minutes, and no pull request
or release check depends on a machine somebody has to switch on. Pinned in
`test/template/root-ci.test.ts` › "runs every job on a GitHub-hosted image,
named literally".

## The two paths

| workflow  | when                                                                                | runners                                                                                 |
| --------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `ci.yml`  | every pull request and push to master                                               | `ubuntu-latest`, `windows-latest`                                                       |
| `e2e.yml` | push to master, nightly, dispatch; PRs on CLI/template paths run the Linux job only | `ubuntu-latest` (`e2e`), `windows-latest` (`windows-e2e`), `macos-latest` (`macos-e2e`) |

What each lane runs, and that the Windows and macOS full suites stay off pull
requests, are pinned in `test/template/root-ci.test.ts` › "runs a Windows
smoke lane — the unit project only — on the hosted image", › "keeps the
Windows full suite off pull requests — it runs on master, nightly and by
dispatch" and › "runs the full suite on macOS off pull requests, on the hosted
image".

On a pull request the `windows-e2e` check reports `skipped`, not `success` —
observed on PR #211's own head (`16d53eb`, E2E run 34775448341) — and
`macos-e2e` carries the same `if:`; the merge criterion in
`.claude/rules/node-ts.md` reads `ci` and, where the paths trigger it, `e2e`.
`gh workflow run e2e.yml --ref <branch>` is a `workflow_dispatch`, which that
`if:` does not exclude, so it runs all three jobs on that branch head. The
dispatch takes only the release inputs — pinned by › "takes only the release
inputs by dispatch — there is no runner switch".

A red hosted job is never re-run until green: classify the defect first.

## What a release transcript records

Every `e2e.yml` job prints one line before it checks out — `runner.name`,
`runner.os`, `runner.environment`, `runner.arch`, `ImageOS` and the SHA —
pinned in `test/template/root-ci.test.ts` › "records which runner executed
each job, so release evidence can name it". The `ci.yml` jobs name their
runner in `runs-on` literally and print nothing. A release entry cites, per
required check: the SHA, the run URL, the runner label from that line, the
command, and the result with its skips.
