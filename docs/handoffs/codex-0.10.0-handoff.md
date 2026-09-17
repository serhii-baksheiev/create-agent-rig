# Handoff — release 0.10.0 loop, for continuation in Codex

**Updated:** 2026-09-18.
**Authoritative base:** `origin/master` = `4382bd3` (`docs(handoff): 0.10.0 loop state for continuation in Codex (#228)`).

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

- Branch: `feat/rp-177-remove-app-skeletons`.
- Published head: `7d336da9b8bb162be2cc95a9176d8b0e337f78a0`.
- The final post-review commit is `7d336da` (`fix: remove retired substitution surfaces`).
- The complete suite on that head passed: **124 files, 4,220 tests passed, 4
  skipped**.
- The round-3 findings were fixed: manifest keys reject Unicode format controls;
  obsolete scope/region/`@app`/filename substitution surfaces were removed;
  supported substitution is only `__PROJECT_NAME__`; and the generated rulebook
  was synchronised.
- Jira comment **18602** records the branch head, evidence, and escalation.

No RP-177 pull request may be opened yet. `pr-ship` consumed its three permitted
rounds: the third round was HOLD, its findings were subsequently fixed in
`7d336da`, and a fourth self-service review round is prohibited. The required
next action is an **owner-authorized gate reset or an owner-arranged independent
review** of `7d336da`; only a SHIP outcome from that authorized path permits
opening and merging the RP-177 PR. Do not bypass the cap, manufacture a new
evidence framework, or treat the existing test result as a substitute for the
missing authorized review.

### PR #227 — RP-178 compatibility matrix

- Draft, open: `feat/rp-178-compatibility-matrix` at
  `601970d13d169ddeab65924e56a80842ccf13fc2`.
- Its currently displayed CI/E2E checks are green, but they predate RP-177 and
  do not make it mergeable for 0.10.0.
- After RP-177 merges, rebase onto the new `origin/master`, remove references
  and acceptance for `guard-core-purity` and `guard-web-boundary` if RP-177
  removed them, and rerun the relevant suite and review gates.
- The matrix must use one status vocabulary and point every status at executable
  test evidence or exact release evidence. Windows wiring alone is not Windows
  support; do not claim it without measured Windows acceptance evidence.
- Do not restore policy benchmark or evidence-shell machinery under a different
  name.

### PR #226 — RP-181 ownership-bounded uninstall

- Draft, open: `feat/rp-181-uninstall` at
  `e98199e2061ce7e2ae4eec39afb1797ca894aa70`.
- Its currently displayed CI/E2E checks are green, but it must wait for RP-177
  and be rebased onto the resulting `origin/master` before further gate work.
- Before it can merge, enforce realpath/lstat confinement for target and parent
  components, including adversarial symlink cases; hash source bytes rather than
  decoded UTF-8; and make `removed` mean files actually deleted. Dry-run must
  expose a separate plan and partial failure must list only completed removals.
- Keep plugin/MCP cleanup with the agreed owners of RP-179/RP-22. Preserve user
  changes and upgrade compatibility; do not turn uninstall into a broad cleanup.

## 3. Merge and verification discipline

1. Resolve the RP-177 owner-only review/gate-reset blocker, then review, open,
   and merge RP-177 only when the authorized gate returns SHIP and the exact-head
   checks are green.
2. Re-read both remaining PRs immediately after that merge. Rebase RP-178 first,
   resolve drift, verify and gate it; then perform the same process for RP-181.
3. After every merge, fetch `origin/master`, inspect all remaining PRs for drift,
   mergeability, reviews, and check status before selecting the next unblocked
   `rel-0.10.0` item.

Do not merge on stale green CI, skip a red check, blind-rerun a flaky test, or
depend on a local self-hosted runner for normal PR validation. GitHub-hosted
runners are the normal CI path; local runner configuration is fallback only.

## 4. Environment note

The user-level Codex configuration was checked separately:

```toml
[features.context_management]
experimental_mode = true
```

It is present in `~/.codex/config.toml`. This is local configuration, not a
repository artifact and not a release acceptance criterion.

## 5. Owner-only conditions

The active owner-only blocker is the RP-177 gate-round cap described above.
Other owner-only actions remain npm publication, force-pushing published/shared
history, external irreversible deletion, secrets/credentials, paid operations or
third-party terms, owner-only settings, and a material change to the accepted
0.10.0 boundary.

When the RP-177 gate authorization arrives, start by confirming the branch SHA,
working tree, Jira state, and current PR state again. If any source disagrees,
code/current checks and accepted owner rulings control the decision.
