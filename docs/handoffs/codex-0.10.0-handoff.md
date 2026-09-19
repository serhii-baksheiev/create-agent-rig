# Handoff — release 0.10.0 loop

**Updated:** 2026-09-20.
**Authoritative base:** `origin/master` = `c88837c` (`Merge pull request #227 from
serhii-baksheiev/feat/rp-178-compatibility-matrix`).

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
guards, `doctor`, safe `uninstall`, and supported external-solution
installation and receipts.

Do not add: app skeletons, policy benchmark/evidence frameworks under a new
name, session messaging, a workflow runtime, a provider marketplace/SDK, or a
Memory release gate. Custom Memory providers remain optional external opt-ins.

`RP-92` is the release gate; `RP-88` is In Progress.

## 2. Where the critical path stands

| item                                                        | state                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RP-177 — remove application scaffolding                     | **Done**, merged `ed6f11f` (#230). Its one regression (a file-system exec-bit assertion that could never pass on Windows, red on every master `E2E` run since) is fixed in #231, merged `2504e49`.                                  |
| RP-178 — compatibility matrix replaces the policy benchmark | **Done**, merged `c88837c` (#227, head `b3b6198`). Gate cycle 2: rounds 1 and 2 HOLD, round 3 SHIP from code-reviewer, security-scanner and prose-reviewer.                                                                         |
| RP-181 — ownership-bounded `uninstall`                      | **In review.** PR #226, head `5aa844f`, rebased onto `c88837c`. Cycle 2 round 1 returned HOLD — the verdicts and their three blockers are recorded in a comment on that PR; round 2 in progress.                                    |
| RP-179 — native plugins and generated fallback              | **In review.** PR #232, head `090066e`, on `c88837c`. Exact-head `ci`, `e2e`, `windows-smoke` green; gate not started.                                                                                                              |
| RP-180 — workflow governance as an experimental opt-in      | Not started. It splits `templates/agent-os/universal/layers.json`'s single `process` array into core + workflow and records the choice in the manifest, so it collides with RP-181's manifest work — sequence it after #226 merges. |
| RP-22 → RP-21 → RP-24                                       | Not started, in that order (RP-22 blocks RP-21; RP-24 is the clean-machine acceptance that consumes both).                                                                                                                          |

## 3. How this loop works here

- **Work happens in full WSL clones**, never in a linked worktree: `~/rig`
  (master), `~/rig-178`, `~/rig-179`, `~/rig-181`. The Windows checkout cannot
  reach green on `pnpm test:unit`, so every commit is made in a clone where the
  pre-commit hook runs unmodified.
- **Every PR takes the full gate**: `gate-round`, `revalidate --point BEFORE_PR`,
  `decision-router`, the reviewer fan-out, `verdict.mjs check` on each report,
  the fan-out and verdict records, then `verdict.mjs coverage` on the head. Three
  rounds per branch; a fourth is an escalation, not a re-review.
- **A material rebase starts a new gate cycle** on the new exact head (owner
  authorization, 2026-09-20). Old findings are carried into the new cycle's
  checklist and re-checked there — never dropped. The normalization is stated in
  the PR body.
- **Windows evidence:** `windows-e2e` is skipped on pull requests by design. Run
  `gh workflow run e2e.yml --ref <branch>` for a branch, or read the post-merge
  master `E2E` run. Never merge on an older head's green.
- **Merge criterion:** the required checks by name (`ci`, `e2e`,
  `windows-smoke`) green **for the exact head**, then a merge commit through the
  API on that SHA.

## 4. Owner-only conditions

`npm publish`; force-pushing published or shared history beyond the two
branches this loop was granted (`feat/rp-178-compatibility-matrix`,
`feat/rp-181-uninstall`); external irreversible deletion; secrets and
credentials; paid operations or third-party terms; owner-only settings; and a
material change to the accepted 0.10.0 boundary.

Everything else — implementation, decomposition, rebases, CI changes, Jira,
review, labels and merge — is delegated to the loop (owner, 2026-09-20).

## 5. Environment note

The user-level Codex configuration was checked separately:

```toml
[features.context_management]
experimental_mode = true
```

It is present in `~/.codex/config.toml`. This is local configuration, not a
repository artifact and not a release acceptance criterion.
