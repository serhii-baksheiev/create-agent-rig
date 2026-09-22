# PLAN — `create-agent-rig` (harness package manager and composition layer)

> **Current release:** 0.10.1. Live work, status, dependencies and acceptance
> are on the Jira `RP` board. This file records the product boundary and the
> order that makes those tickets coherent; it is not a second queue.

> **Status (0.10.1 published 22 Sep 2026):** 0.10.1 is `latest`, published from
> `gitHead` `738b494806b435f0718f290dc3befb40829e5ebf`. Versions 0.1.0 through
> 0.10.1 are live; delivery is done through `0.10.1`, the current `latest`.
> `1.0.0` is prepared and waiting on the owner's publish: it freezes the
> harness-configuration contract and states the deprecation policy that governs
> it from here. It is a major because of that promise, not because of a
> breaking change — a 0.10.x rig sees no behaviour it would notice removed.
>
> **The default branch is not that release.** Work merges to `master`
> continuously, so what is on it at any moment is ahead of `latest`,
> unreleased, and has not been through a release gate. Installing from the
> default branch installs a development snapshot; every command the README
> shows is pinned `@latest` for that reason.

## 1. Product boundary

`create-agent-rig` configures Claude Code and Codex repositories. It installs
and upgrades a portable harness payload, preserves user changes through a
manifest with raw-byte ownership hashes, and reports conflicts. Native-plugin
and MCP composition through supported official installers belongs to the
remaining 0.10.0 work (RP-179 and RP-22), not the current implementation.

It is not an application generator. A fresh `create <dir>` does only three
things: creates the directory, initializes Git, and runs the same universal
harness installation as `init`. The package has no target selection, application
skeleton, stack overlay or cloud deployment template. The completed 0.10.0
release will also contain no provider marketplace, agent runtime, policy
benchmark, evidence framework or session-messaging subsystem.

Custom Memory is an optional external provider. It can contribute additional
evidence but is not a dependency of the package or the 0.10.0 release gate.

## 2. Locked decisions

| Decision | Consequence |
| --- | --- |
| **One portable harness payload** | `create` and `init` install the same universal repository configuration; there are no application targets or stack overlays. |
| **Thin create** | `create <dir>` is `mkdir → git init → init`, with an optional pristine baseline commit. |
| **Ownership before convenience** | Upgrade and uninstall act only on bytes the manifest can prove the rig owns; user edits and retired application files are preserved and reported. |
| **Deleted stays deleted** | Upgrade reports a user-deleted owned file instead of silently restoring it. |
| **Native capabilities first** | Supported plugins, MCP, skills and package managers are composed through official installers; the rig authors only portable repository wiring that those systems cannot provide. |
| **Workflow governance is optional** | The 0.10.0 workflow layer is experimental, opt-in and disabled by default. It may not become an enterprise policy/evidence framework under another name. |
| **Memory stays external and optional** | No custom Memory provider is required for create, init, upgrade, uninstall, doctor or the release gate. |
| **Templates are authored here** | Shipped Agent OS content is authored fresh in this repository, never copied from a private work repository. |
| **Git and registry paths both matter** | The published package must contain its templates; pack-path and git-path acceptance remain distinct checks. |
| **Only the repository root publishes** | `packages/cli` remains private and publication-locked; `npm publish` is an owner-only release step. |

These decisions replace the pre-0.10 application-generator plan. The removed
skeleton, target, stack and deployment design remains available in Git history,
not as a current promise in the plan of record.

## 3. Repository shape

```text
packages/cli/       CLI commands and manifest-aware ownership logic
templates/agent-os/ the portable Claude Code + Codex repository payload
test/e2e/           package, install and clean-repository acceptance
test/template/      hook, composition, ownership and dogfood invariants
scripts/            build, sync, release and repository maintenance
```

Claude-facing templates are the authoring surface. The sync scripts derive the
matching Codex projection and this repository's dogfood copy. Synced files are
never edited directly.

## 7. Phases — 0.10.0 release sequence

<!-- The heading number is a landmark, not a position: `test/template/journal.test.ts`
     › "keeps the queues and the phases, and no longer carries the journal" pins the
     literal string `## 7. Phases`. The section order here reads 1, 2, 3, 7, 5 for
     that reason. Renumber it only together with that assertion. -->


The dependency order is:

1. RP-177 removes application skeletons and reduces `create` to the thin
   bootstrap above.
2. RP-178 publishes an evidence-backed compatibility matrix and isolates any
   remaining workflow governance as experimental opt-in behavior.
3. RP-181 adds ownership-safe uninstall without taking plugin or MCP cleanup
   away from their assigned tickets.
4. RP-179 **decides** what is delivered natively and what stays generated, with
   evidence. It is an evaluation and an architecture decision — not a migration,
   and not a plugin-first promise. Delivery, provenance and receipts belong to
   RP-22; making `AGENTS.md` canonical belongs to RP-186.
5. RP-180 makes the workflow layer a disabled-by-default experimental opt-in.
   It records the choice in the manifest, so it follows RP-181's merge and
   rebases onto the ownership model RP-181 settled.
6. RP-22 composes supported plugins, MCP and executable subsystems through
   allowed official installers.
7. RP-21 adds doctor checks for the manifest, wiring, profiles, receipts and
   subsystem health.
8. RP-24 runs clean-machine acceptance.
9. RP-92 is the exact release gate; RP-88 closes only after that gate passes.

Two items sit outside that chain and are sequenced by their own dependencies,
not by it: RP-185 (the Codex `SessionStart` hook output Codex rejects) and
RP-186 (`AGENTS.md` canonical, `CLAUDE.md` a compatibility shim) both block
RP-92 and may be implemented in parallel with the chain above. RP-175 is
supporting-lane work and blocks nothing.

### Delivery discipline

After each merge, remaining branches are rebased on and rechecked against the
new `origin/master`. CI runs on GitHub-hosted runners only, so no release
condition depends on a machine being on. A PR merges on the required checks (`ci`, `e2e`,
`windows-smoke`) being green for its **exact** head, never an older one, and
never on CI alone where a review gate is owed.

## 5. Release evidence

Release evidence belongs in exact-head GitHub checks, Jira comments, PR bodies,
the release ledger and `journal/YYYY-MM.md`. Each task needs its acceptance
tests, adversarial cases where applicable, lint, typecheck, independent review,
green exact-head hosted checks and a post-merge verification of `master`.

Publishing to npm remains owner-only. A green release gate prepares the exact
artifact and provenance; it does not publish it.

## Agent queue

**Release work is on the Jira `RP` board.** This section is deliberately empty
and `parsePlan` must return zero from it. Repository-specific queue selection is
configured in `.claude/queue.json`; an in-place edit of that synced file is
drift.

Everything below this line is prose, and that is mechanical rather than
stylistic. `parsePlan` takes any `- ` or `* ` line in this section as a work item,
including an indented one. Write facts here as paragraphs so a fallback reader
cannot mistake its own footnotes for release work.

Three historical queue facts remain because their failure modes are still
otherwise silent.

**The empty heading above stays.** A missing `## Agent queue` is
`queue-unreadable` and exit 1, not the `queue-empty` exit 0 an empty section
gives. Those are opposite verdicts, so deleting a contentless heading is not
tidying.

**`AR-n` names two different things.** Jira issue keys and the old port brief's
own numbering overlap. Every brief-sense key now also exists as a real ticket,
so following a citation can land on an unrelated issue with no error. Check
which numbering a historical citation uses before following it.

**`ready` is a human-facing hint that no selection path reads.** Selection
excludes `operator-queue` and `triage` through the adapter's label rules. A JQL
filter on `labels = ready` against a board without that label returns an
`empty set`; that becomes `queue-empty`, exit 0, even while issues remain open.

## Operator queue

Owner-only release actions and product-boundary decisions are tracked on Jira.
The carried bullets below are not open items. They are the only local home for
three `plan-md` dedup fingerprints and remain until AR-48 moves that state to the
configured adapter. Deleting one can re-file the same proposal as a fresh
`seen ×1` with no warning. The `· fingerprint: … · seen ×N` tail is never edited
by hand.

- [carried → AR-46] **proposal: Either scope the declaration so it does not reach spawned children of the test runner (declare it per-command rather than as a shell export), or have the harness strip RIG_RUN_DIR from the environment it passes to the CLI, the way withoutGitLocation() strips GIT_DIR for git spawns. Same family as the GIT_DIR incident: ambient environment reaching a child that was never meant to see it, and resolving to a wrong answer rather than an error. [triage]** — finding: journal: the queue left the file — `loop` §1 tells every run to export RIG_RUN_DIR, and the exported variable reached both the CLI a test spawns in a temp project (turning test/template/review-fixes.test.ts RED) and this run’s real decisions.jsonl, which took 14 fixture records at seq 5-18 · part: .claude/skills/loop/SKILL.md §1 (the RIG_RUN_DIR declaration) and the harness that spawns the queue CLI — the contamination path, not only the exit-1 symptom · proof: EITHER branch is checkable and the proposal is satisfied by one. STRIP: `RIG_RUN_DIR=<a real run dir> pnpm test:unit` is green AND leaves that directory unchanged — today it fails 1 of 868 (test/template/review-fixes.test.ts:494, "expected 1 to be +0") and appends 14 records. SCOPE: the skill no longer instructs a shell export, so a run following it verbatim finishes with `pnpm test:unit` green and its run directory carrying only records the run itself wrote — check the DIRECTORY, not the command, because under this branch the variable is never in the environment to begin with. Precondition for either check: `pnpm test:unit` in a shell that never exported the variable is green TODAY, so checking the bare command retires a live defect. · fingerprint: `journal-the-queue-left-the-file-loop-1-t:claude-skills-loop-skill-md-1-the-rig-ru:either-scope-the-declaration-so-it-does-` · seen ×1
- [carried → AR-47] **proposal: A third stop kind, or a qualifier on queue-empty, for the case where the configured adapter is not the one the project declares its work lives in. AR3-35 split `queue-empty` from `nothing-selectable` precisely because an operator cannot otherwise tell whether the queue needs refilling; this run hit a third case neither covers — the work exists and is unreachable — and reported it as genuinely out of work. [triage]** — finding: journal: the queue left the file — stopped at `queue-empty` with 45 issues open on the board, because the adapter that can read them is not switched yet (AR-45) · part: .claude/scripts/queue/core.mjs (stopConditionOf) + .claude/skills/loop/SKILL.md §3 · proof: A run configured with `plan-md` against a PLAN.md whose Agent queue section declares the work has moved elsewhere stops with a verdict naming the unreachable queue, not "queue empty … refilling the queue is the owner’s job". Today the two are indistinguishable from the stop line. · fingerprint: `journal-the-queue-left-the-file-stopped-:claude-scripts-queue-core-mjs-stopcondit:a-third-stop-kind-or-a-qualifier-on-queu` · seen ×1
- [carried → AR-48] **proposal: State, or handle, what dedup means once the queue a fingerprint was filed into is no longer the queue being read — `seen ×N` silently resets, so a proposal filed twenty times before the migration reappears as a fresh `seen ×1`, the failure the cap exists to prevent. Cover the second path too: the fingerprint is derived from finding/part/change, so editing any of those three in place leaves a slug that matches nothing and the next filing writes a duplicate. [triage]** — finding: journal: the queue left the file — the eight triage proposals migrated to Jira, so proposeTriage under plan-md can no longer find the fingerprints of proposals this repo has already filed; and hand-editing a filed bullet desynchronises its fingerprint from its own text, which this run did and the gate caught · part: .claude/scripts/queue/core.mjs (`duplicateOf` at :575, `fingerprintOf` at :557) as called from .claude/scripts/queue/plan-md.mjs:408 · proof: EITHER branch is checkable and the proposal is satisfied by one. HANDLE: filing a proposal whose fingerprint matches a migrated one increments a count or reports the collision instead of writing a fresh `seen ×1`; and editing a filed bullet’s prose either regenerates its fingerprint or is refused. STATE: plan-md cannot query Jira for a migrated fingerprint, so both limits are written into the dedup comment and a reader finds them there rather than inferring the reset from a count. · fingerprint: `journal-the-queue-left-the-file-the-eigh:claude-scripts-queue-core-mjs-duplicateo:state-or-handle-what-dedup-means-once-th` · seen ×1

## Where the journal is

`journal/YYYY-MM.md` — one file per month, newest first. The convention and
field list are in `journal/README.md`.
