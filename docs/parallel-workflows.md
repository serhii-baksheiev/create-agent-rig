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
its own issue links and workflow. The Spec Kit importer targets GitHub Issues,
or Jira when that is the configured queue (see "Import into Jira" below). It
does not require Jira or change `PLAN.md`.

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

## Import into Jira

When `.claude/queue.json` names the `jira` adapter and a project, the same task
file can be projected into that project instead, with the adapter's `JIRA_*`
credentials:

```sh
node .claude/scripts/queue/index.mjs import spec-kit --to jira --tasks specs/my-feature/tasks.md --dry-run
node .claude/scripts/queue/index.mjs import spec-kit --to jira --tasks specs/my-feature/tasks.md
```

The compilation, identities and dry-run report are the GitHub target's
(`test/template/spec-kit-import-jira.test.ts` › "dry-run report matches the
github-issues target's shape and identities for the same tasks.md"). Each task
becomes a Jira Task with the `rig-spec-kit` label and its identity marker as the
first line of the description. Dependencies become native Blocks links,
created together with the dependent issue (› "creates dependents with their
Blocks link in the create request (link direction), then an identical reimport
is unchanged"), so the Jira queue holds a dependent until its blocker is done
(› "an imported dependent is held by listEligible and selectNext until its
blocker is done"). A re-import adds a missing link and leaves links it did not
make alone (› "adds a missing Blocks link to an existing projected issue in the
correct direction (link direction, repair path), and leaves user links
untouched"); a link between two projected
issues that `tasks.md` no longer lists is refused, never deleted — remove it by
hand (› "refuses a stale projected link before any write").

Jira's search index can lag a write by minutes, so the importer re-reads every
search hit by key before treating it as projected, and refuses two issues
claiming one identity (› "refuses an ambiguous projection, including one
produced by a lagging index"). A failed write stops the import and names the
issues already written; nothing is retried (› "a failed write names the
completed keys, retries nothing, and echoes no task text" and › "a failed write
after this run's creates (%s) names the keys created in this run and echoes no
task text"). After a partial
failure, run the dry run again and wait until it reports the named issues as
`update` or `unchanged` before re-importing: an import run before the index
catches up can create a second issue for the same task, which the next import
then refuses as ambiguous.

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
