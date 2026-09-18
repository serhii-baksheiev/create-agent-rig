# Handoff — release 0.10.0 loop, for continuation in Codex

**Updated:** 2026-09-18.
**Authoritative base:** `origin/master` =
`14333a79a6744b90fea4bf27ec52204b17c96b83` (`docs: refresh 0.10.0 release
handoff (#229)`).

This is the cold-start record for the 0.10.0 release loop. Prefer repository
heads, current PR checks, and accepted owner rulings over older notes. Jira
records coordination state; it must agree with those sources before a merge.

---

## 1. Release boundary

0.10.0 makes Rig a package-manager and composition layer for repository-scoped
Claude Code and Codex configuration. It configures harnesses; it does not
generate applications or recreate capabilities already supplied by native
plugins, MCP, skills, or official package managers.

Keep: thin `create`, manifest-aware `upgrade`, raw-byte ownership, conflict
reporting, deleted-stays-deleted behaviour, portable project wiring, security
guards, `doctor`, safe uninstall, and supported external-solution installation
and receipts.

Do not add: app skeletons, policy benchmark/evidence frameworks under a new
name, session messaging, a workflow runtime, a provider marketplace/SDK, or a
Memory release gate. Custom Memory providers remain optional external opt-ins.

`RP-92` is the release gate; `RP-88` is In Progress. The remaining blocker
order is RP-177, RP-178, RP-181, then RP-179/RP-180, RP-22, RP-21, and RP-24
on the exact candidate SHA. Do not recreate duplicate work items or widen this
scope.

## 2. Current stop point

### RP-177 — remove application scaffolding / thin `create`

- PR: **#230**, draft/HOLD.
- Branch: `feat/rp-177-remove-app-skeletons`.
- Current published head:
  `58ceb4e9f37bac3be1eb7cc8450170fc38714325` (`test: use portable npm
transport`).
- Jira: In Progress. Its latest comments record the PR, the Windows diagnosis,
  current-head evidence, and the exhausted gate.

The owner authorized one reset of the previously exhausted RP-177 review gate.
That reset used all three configured rounds. On exact head
`826f75a08f047f175295293637f6c185a67b5ed6`, independent code, security, and
prose reviewers all returned SHIP and fan-out coverage was complete. Local
evidence on that head was lint/typecheck/sync green, 125 full-suite files with
4,223 passed and 4 skipped, and 119 pre-commit files with 4,190 passed and 4
skipped.

PR #230 then ran its first exact-head GitHub-hosted checks. Linux `ci` and `e2e`
passed, but `windows-smoke` failed deterministically in
`packages/cli/test/package-contents.test.ts`: direct `execFile("npm", …)`
returned `ENOENT`. The runner's before/after bare-Node spawn probes were healthy,
so this was a test-harness portability defect, not host saturation and not a
flaky check. It was not rerun blindly.

The existing Windows failure supplied Red evidence. A test-writer confirmed
that no duplicate test was needed: the repository already has independently
covered Windows argv transport in
`test/template/package-manager-transport.test.ts`. Current head `58ceb4e`
changes only the package-content test to reuse `runPackageManager('npm', …)`.

Evidence on exact current head `58ceb4e`:

- lint and typecheck pass;
- package-content plus package-manager transport: 2 files, 13 passed;
- Windows transport probe resolves real npm (`11.16.0`);
- pre-commit: 119 files, 4,190 passed, 4 skipped;
- full `pnpm test`: 125 files, 4,223 passed, 4 skipped;
- GitHub-hosted `ci`, `e2e`, and `windows-smoke`: pass;
- GitGuardian: pass; `windows-e2e`: intentionally skipped by the workflow.

The previous SHIP verdict is stale because it names `826f75a`, not `58ceb4e`.
PR #230 therefore remains draft/HOLD even though current-head checks are green.
The surviving local gate state now records **4 rounds against a cap of 3** for
this branch, and `gate-round` refuses another round. Do not edit or bypass that
counter, do not reuse the old SHIP, and do not merge.

**NEXT ACTION:** the owner must explicitly authorize a new independent RP-177
gate cycle for exact head `58ceb4e9f37bac3be1eb7cc8450170fc38714325`
**and direct the reset/disposition of the recorded over-cap counter**. After
authorization, re-read PR #230/Jira/master, follow that counter direction, run
exact-head code/security/prose reviews and coverage, update the PR body, mark it
ready only on SHIP, and merge only if the named exact-head checks remain green.

### PR #227 — RP-178 compatibility matrix

- Draft, open: `feat/rp-178-compatibility-matrix` at
  `601970d13d169ddeab65924e56a80842ccf13fc2`.
- Its displayed checks predate RP-177 and become stale after RP-177 merges.
- After RP-177, rebase onto the new `origin/master`; remove references and
  acceptance for deleted `guard-core-purity`, `guard-web-boundary`, skeleton,
  stack, and application capabilities.
- Use one `supported`/`degraded`/`unsupported` vocabulary. Every matrix row must
  point to an executable test or exact release evidence. Wiring alone is not
  Windows acceptance. Remove session-messaging and dead policy-coverage
  pointers; do not rebuild an evidence framework under another name.
- RP-82, RP-110, RP-157, RP-160, and RP-161 are handled by removal evidence and
  the remaining consumer graph inside RP-178, not prerequisite PRs.

### PR #226 — RP-181 ownership-bounded uninstall

- Draft, open: `feat/rp-181-uninstall` at
  `e98199e2061ce7e2ae4eec39afb1797ca894aa70`.
- It waits for RP-177 and RP-178, then must be rebased onto `origin/master`.
- Required blockers remain realpath/lstat confinement for targets and every
  parent, no symlink traversal in empty-parent cleanup, raw-byte hashing,
  truthful `removed`/dry-run/partial-failure reporting, manifest retention on
  incomplete removal, explicit destructive consent, hostile-manifest and
  control/format-character rejection, and matching README/CHANGELOG/command
  contracts.
- Plugin/MCP cleanup remains owned by RP-179/RP-22.

## 3. Merge and verification discipline

1. Resolve the RP-177 owner-only gate-reset blocker above. Do not merge #230 on
   green CI alone.
2. After RP-177 merges, fetch and verify post-merge master, close RP-177 only
   after `BEFORE_CLOSE`, then immediately re-read/rebase/gate RP-178.
3. After RP-178, rebase/gate RP-181. After every merge, fetch `origin/master`
   and recheck every remaining PR for drift, mergeability, reviews, and checks.
4. Continue with the next unblocked mandatory 0.10.0 item; do not invent or
   duplicate work.

GitHub-hosted runners are the normal CI path. Local self-hosted configuration is
fallback only. Never bypass red checks or blind-rerun failures; distinguish code,
CI, and host defects from their logs and exact evidence.

## 4. Environment note

The user-level Codex configuration was verified without modification:

```toml
[features.context_management]
experimental_mode = true
```

It is present in `~/.codex/config.toml`. This is local configuration, not a
repository artifact or release acceptance criterion.

## 5. Owner-only conditions

The active owner-only blocker is authorization for another RP-177 gate cycle on
exact head `58ceb4e`, including explicit reset/disposition of the local counter
that records 4 rounds against a cap of 3. Other owner-only actions remain npm
publication, force-pushing published/shared history, external irreversible
deletion, secrets/credentials, paid operations or third-party terms, owner-only
settings, and a material change to the accepted 0.10.0 boundary.
