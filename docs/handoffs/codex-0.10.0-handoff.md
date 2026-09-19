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
| RP-181 — ownership-bounded `uninstall`                      | **In review, NOT merge-ready.** PR #226, rebased onto `c88837c`. Cycle 2 round 1 returned HOLD (verdicts in a comment on the PR); §2a below lists three data-loss classes, one of which is still open.                              |
| RP-179 — capability decision, not the plugin migration      | **In review.** PR #232, on `c88837c`. The ticket's own scope is corrected on RP-179: this is the evaluation and decision, and plugin-first delivery, provenance and receipts move to RP-22.                                         |
| RP-180 — workflow governance as an experimental opt-in      | Not started. It splits `templates/agent-os/universal/layers.json`'s single `process` array into core + workflow and records the choice in the manifest, so it collides with RP-181's manifest work — sequence it after #226 merges. |
| RP-22 → RP-21 → RP-24                                       | Not started, in that order (RP-22 blocks RP-21; RP-24 is the clean-machine acceptance that consumes both). RP-22 does **not** inherit RP-179's rejected plugin-first promise — see the ruling recorded on RP-22.                    |

**What can merge now, and what cannot.** This handoff and #232 are documentation
and evidence; they merge on their own gates. #226 cannot merge until every item
in §2a is closed _and_ it has passed a fresh independent code and security
review — no green CI substitutes for that. RP-180 waits for #226 because both
touch the manifest. RP-92's required set is unchanged: RP-181, RP-179 (as the
decision it now is), RP-180, RP-22, RP-21 and the RP-24 clean-machine run on the
exact candidate SHA.

## 2a. `uninstall` — the three data-loss classes, so nobody re-derives them

`uninstall` deletes files from a repository on the evidence of a **committed**
manifest, which arrives in pull requests like any other file. Three ways that
went wrong; each needs a regression test before #226 can merge, and the PR is
not merge-ready while any is open.

1. **Ownership drawn at a top-level path segment** — closed. A manifest entry
   pairing any file under `.claude/`, `.rig/`, `docs/` or `journal/` with its
   true hash was treated as rig-owned and deleted. Repro: add
   `.claude/user-secret.txt` (or `.rig/run-state.json`) to `.claude/.rig-manifest.json`
   with that file's real sha256, run `uninstall --yes`, watch it disappear.
   Fix: ownership is the install set's **exact** paths. Regression test:
   `packages/cli/test/uninstall.test.ts` › "preserves %s even with its true hash
   — ownership is the exact path, not the top-level directory".
2. **The manifest itself read and deleted through a symlinked ancestor** —
   closed. Repro: make `.claude` a symlink to a directory outside the
   repository holding a manifest; plan reads it and apply unlinks it outside
   the repository. Fix: the manifest goes through the same segment-by-segment
   `regularFileStatus` walk as any owned path, at read and again before the
   unlink. Regression tests: › "refuses to trust the manifest itself when its
   own ancestor is a symlink…" and › "refuses to remove the manifest through an
   ancestor swapped for a symlink between planning and applying".
3. **A file changed between the plan and the apply is still deleted** — OPEN at
   the time of writing. Repro: run `uninstall` (or `--dry-run` then `uninstall
--yes`), edit a file the plan marked `remove` after the plan prints and
   after consent, and it is removed anyway: `applyUninstall` re-checks only
   that the path is still a plain file, never its bytes, and the plan carries
   no expected hash. Required: carry the expected raw-byte hash on each
   `remove` action, re-read and compare immediately before each unlink, and on
   a mismatch preserve that one path with a "changed since planning" reason
   rather than deleting or aborting the whole run. The same window applies to
   the manifest: record its digest at plan time and verify it before the first
   removal and again before deleting the manifest.

**Windows junction / reparse points are a merge requirement, not a footnote**
(owner ruling, 2026-09-20). A written "not measured" is not acceptable for a
command that deletes data on a supported platform, and the guard must not rest
on being able to create a Unix-style symlink. Required: a deterministic
junction fixture in the Windows lane (`fs.symlink(…, 'junction')` or
`mklink /J`) asserting the guard refuses a manifest path behind it; if the
environment genuinely blocks the fixture, the exact failure log plus a safe
fallback in the implementation.

**The product model is settled** (owner ruling, 2026-09-20):

- an ordinary `uninstall` stays conservative; anything that cannot be removed
  safely makes the run **partial**, and the manifest is kept;
- `--detach` is added: after the same safe cleanup it removes the manifest,
  leaves every preserved file to the user, and prints the full handover list;
- `--detach` never deletes a conflicting or modified file, and there is no
  `--force` in RP-181;
- the JSON result distinguishes `uninstalled`, `partial` and `detached`
  explicitly.

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
