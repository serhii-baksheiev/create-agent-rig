# Parallel Workflows

Spec Kit can plan and decompose a feature into `tasks.md`. Rig projects the
supported task lines into GitHub Issues; its existing queue reads those issues,
their dependencies and claims when controllers select work. The tracker is the
shared coordination surface. Rig does not run the controllers or maintain a
second scheduler.

The workflow layer is opt-in (`create-agent-rig init --layer workflow`). A new
installation still starts with the `plan-md` queue adapter and a simple
`PLAN.md` Agent queue. That remains a useful flat, single-controller path.
For independently selecting controllers, configure a shared tracker. GitHub
Issues is the intended choice without Jira; Jira is an optional tracker with
its own issue links and workflow. The Spec Kit importer in this release targets
GitHub Issues only. It does not require Jira or change `PLAN.md`.

## Import one Spec Kit task file

Run these commands from the repository containing the installed workflow layer
and the Spec Kit plan, with `gh` authenticated for that repository:

```sh
node .claude/scripts/queue/index.mjs import spec-kit --to github-issues --tasks specs/my-feature/tasks.md --dry-run
node .claude/scripts/queue/index.mjs import spec-kit --to github-issues --tasks specs/my-feature/tasks.md
```

Use `--json` for machine-readable reports. `--tasks` may be omitted only when
exactly one `specs/<feature-slug>/tasks.md` exists. Import does not select a
queue item or alter the configured adapter; configure `.claude/queue.json` for
`github-issues` before controllers use the projected issues.

The importer recognises checklist tasks with an ID and a title. Dependencies
are taken only from an explicit suffix:

```md
- [ ] T001 Add the first behavior
- [ ] T002 Add the dependent behavior (depends on T001)
```

The feature slug and task ID form a stable identity. Each projected issue has
the `rig-spec-kit` label and an identity marker in its body. Explicit
dependencies become `Blocked by #<issue>` lines that the GitHub Issues queue
already understands. File order and task prose do not create dependencies.
The importer also provisions `in-progress`, `escalated` and `triage` when
absent, so normal GitHub queue lifecycle transitions remain available.
Malformed IDs, duplicate or unknown dependencies, cycles and ambiguous
existing projections are refused before issue writes.

The dry run reads the plan and current GitHub Issues, then reports creates,
updates and unchanged tasks without writing issues or labels. The real import
creates missing issues and updates projected titles, bodies and dependency
lines; an unchanged re-import writes nothing. It does not delete an issue when
a task disappears from `tasks.md`. Edits to a projected title or body are
replaced on the next import; keep ongoing discussion in issue comments.

If GitHub fails partway through an import, fix the cause and run the dry run
again before re-importing. The importer reconciles completed work by identity.
Keep both the marker and label on each projected issue: removing either makes
it ineligible for matching and can lead to a new issue. If matching is
ambiguous, resolve the duplicate issues before retrying. The import is bounded
to one task file and refuses incomplete issue listings rather than guessing.

## Run controllers against the shared queue

Each controller needs its own checkout or worktree, branch, process and run
directory. All controllers read the same tracker and use Rig's normal
selection, claim, TDD, review, revalidation and PR flow. Dependency-blocked
issues wait until their blockers close. Claims are advisory rather than
transactional locks, so controllers must check duplicate ownership and
revalidate when the tracker or `master` changes. More model capacity does not
imply unlimited safe concurrency.

Concurrent independent queue loops in linked worktrees remain experimental.
The [measured concurrency decision](decisions/concurrent-sessions.md) records
shared-state limits; running two sessions in one checkout is unsupported. The
three-controller release pilot is the acceptance test for this workflow, and
its outcome must be recorded before claiming broader support. Rig does not add
a daemon, cluster, distributed lock service or private controller-to-controller
state for this feature.
