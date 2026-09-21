# 0.10.0 checkpoint - 2026-09-21, 12:38 UTC

Recheck Git, GitHub and live Jira after resuming. Heads outrank this dated note.
The September 21 RP-22/RP-21/RP-24/RP-88/RP-92 descriptions and owner prompt
supersede the receipt-based architecture in older handoffs.

## Delivered and current work

- Master: `1f85b0783863ff4bba01fab5b1257e0359be3f79`, ownership
  [PR #247](https://github.com/serhii-baksheiev/create-agent-rig/pull/247).
  Reviewed head `bf978a53138955495eebcc51176de52f50446383`; trees match.
  Code/security/prose SHIP in round 2/3, complete coverage. PR ci/e2e/
  windows-smoke passed. Hosted Linux/Windows dispatch 35597239808 passed.
  Post-merge [CI 35598820184](https://github.com/serhii-baksheiev/create-agent-rig/actions/runs/35598820184)
  and [E2E 35598820192](https://github.com/serhii-baksheiev/create-agent-rig/actions/runs/35598820192)
  passed, including native Windows full suite. Jira RP-22 has merge evidence.
  Owned intent worktrees/local branches and merged remote branch were removed.
- Codex slice: `feat/rp-22-codex-mcp`, Windows and WSL
  `.claude/worktrees/rp22-codex-mcp`. Implementation awaits commit/gates at this
  checkpoint. Native WSL branch is based on master above; Windows still has
  reviewed predecessor `bf978a5` until alignment with the native commit.
  Whole-file base rendering, rolling root `targets.codex.fileHash`, safe
  compiled conflict fragments, repeated harness selection, missing-file apply
  restoration and stale snapshots are implemented. Nine original Reds plus
  four failing follow-up regressions preceded their fixes. Current focused
  native Windows suite: 11/11; Linux full suite: 131 files, 3815 passed,
  14 platform skips. Lint/typecheck passed. No Codex PR opened yet.
- Spec Kit slice: `feat/rp-22-spec-kit`, Windows worktree based on master above;
  WSL mirror still based on original `8cd5096`. New uncommitted
  `spawn.ts`, `windows-job.ts`, `spec-kit.ts`, `setup-wizard.ts` and tests.
  Pinned official lifecycle tests: Linux 15/15, Windows 14 plus POSIX-only skip.
  Process-tree tests: Windows 7/7, Linux 6 plus Windows-only skip. Wizard tests
  5/5. Public Spec Kit command integration tests are being written; commands
  are not wired yet. Old exec framework must be deleted with the real consumer.
  Legacy Memory equals-option routing regression is pending.
- Doctor preparation: `feat/rp-21-doctor`, Windows `.claude/worktrees/rp21-doctor`
  based on master above. Only new `verify.ts` and `integrations-verify.test.ts`.
  Four local-verification cases and the rejected-ID privacy regression pass;
  Basic Memory and Codex cases await registry/schema integration. This is
  preparatory RP-22 verification work, not a claim that RP-21 is delivered.

## Preserved unrelated work

- Original S5 `feat/rp-22-s5-mcp` remains at
  `420ff588936c40bf2d06521c036f2ecd9fab5e21`; no history rewrite.
- Main Windows checkout preserves modified `.claude/hooks/dod-checks.json`
  and untracked `.rig/claims/RP-111.json.local`, `.rig/claims/RP-185.json`,
  `docs/rig-0.9.0-codex-loop-prompt.md`. Never include these in release commits.
- Historical dirty worktrees remain: release-090-control (monthly journal),
  rp111-semantic-benchmark (benchmark/diagnostics), rp177-owner-reset
  (create/changelog/test), rp189-owned-directory (claim/upgrade/test).
  Broken native-315ad8f metadata was deliberately not pruned.

## Release authority and next steps

RP-22 remains In Progress; RP-21/RP-24/RP-92 remain open. RP-88 is In Progress.
Mandatory path: RP-22 -> RP-21 -> RP-24 -> RP-92. Historical prerequisites stay
Done; Memory-owned issues are relates-only. Version remains 0.9.1; no publish,
tag, release-channel change or new credentials are authorized automatically.

Next: commit/push/gate Codex slice; dispatch exact-head Windows e2e before
merge; wire Spec Kit through official pinned lifecycle and wizard; Basic Memory
wiring-only preview; aggregate doctor; exact-SHA packed-artifact acceptance.
After each merge verify master CI/E2E and update factual Jira evidence.
Self-hosted fallback remains configured; registered runners were zero at the
baseline. macOS and self-hosted execution are not claimed without actual runs.

## Recovery

Run directory in the Windows main checkout:
`.claude/runs/20260921-codex-release0100`. It contains reports, JSON verdicts,
run journal, `codex-implementation.patch`, `spec-kit-spawn.patch`, and
`doctor-verify.patch`. Refresh backups before any reset/context cleanup.
Export its absolute path as `RIG_RUN_DIR` for gates. Existing user-level Jira
env file stays outside the repository; never copy or display it.

Normal BEFORE_PR Jira search truncated comments. Direct adapter `find('RP-22')`
returned complete commentary; `revalidate-direct.mjs` uses that record with the
unchanged frozen revalidation mechanism, verifies the actual origin/master
merge base, and journals evidence. Superseded claim scope was reread and
resolved with the normal outcome command. Do not rewrite frozen claim hashes.
Use normal revalidation if the direct helper detects a moved merge base.
