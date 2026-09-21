# 0.10.0 checkpoint - 2026-09-21, 13:14 UTC

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
- Codex slice [PR #248](https://github.com/serhii-baksheiev/create-agent-rig/pull/248):
  `feat/rp-22-codex-mcp`, exact clean/pushed head
  `a97b3b45cf2cbd5fac1347787065d30a0c610bcb`, Windows and WSL worktrees.
  Round 2/3 all code/security/prose SHIP; coverage complete. First-round prose
  required only named Codex test links; runtime/tests unchanged from d9cf2115.
  Full Linux 131 files/3815 passed/14 skips; native Windows Codex 11/11.
  Ordinary hooks passed. Original exact-head dispatch 35600987747 passed;
  new-head dispatch 35602582383 and all PR checks passed.
  Merged as 92a3f81fd63ae44dda3db694257ea2604ed0dc11; trees match. Master CI 35604145986 and E2E 35604145975 are running.
- Spec Kit slice: `feat/rp-22-spec-kit`, Windows and WSL, HEAD d9cf2115 with
  staged implementation. Official pinned lifecycle, bounded process-tree
  spawn, wizard, public add/apply/remove and explicit adoption are wired.
  Legacy equals-form Memory routing is covered. Old unused exec.ts framework
  and its framework-only tests were removed. Linux lifecycle18/18; native
  Windows combined42passed4platformskips. Initial full Linux suite found two
  obsolete exact-two-provider expectations and a recursive fake cleanup call;
  corrected to include Spec Kit and remove only fixture-owned files. Their
  targeted32tests passed. Three lint issues fixed. Full confirming run is in
  progress, logs /tmp/rig-spec-{lint,typecheck,test}.log in WSL. No Spec Kit
  commit or PR yet. Source/input/exec safety must receive all review gates.
- Doctor preparation: `feat/rp-21-doctor`, Windows `.claude/worktrees/rp21-doctor`
  now based on d9cf2115. New verify.ts/integrations-verify.test.ts: seven cases
  pass, two await Basic Memory registry. Rejected IDs are not echoed. Four
  new Basic Memory wiring/data-preservation/coexistence tests are Red because
  provider is not yet in registry; implementation pending after Spec Kit.
  This is preparation, not delivery of RP-21 or a new release blocker.

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

## Live continuation checkpoint � 2026-09-21 13:36 UTC

This section supersedes older progress above; revalidate all live heads.
Master is 92a3f81fd63ae44dda3db694257ea2604ed0dc11, merged Codex PR248.
Reviewed head a97b3b45cf2cbd5fac1347787065d30a0c610bcb has identical tree.
Master CI35604145986 and E2E35604145975 passed including nativeWindows.
Codex Windows/WSL worktrees and local/remote branches removed after clean checks.
Jira RP22 updated with exact merge and postmerge links; remains InProgress.

Spec Kit branch feat/rp-22-spec-kit is clean/pushed at
159746b07ff0527fa0010dcaa7ae1972f8cd2c86 in Windows and WSL worktrees.
No PR yet. Round1/3 code/security SHIP, prose running. One fanout recorded
seq60, security seq61, code seq62. Dispatch35605355062 Linux passed,
Windows pending. FullLinux134files3735pass8skips before two narrow diagnostics
fixes; final related27tests and ordinary precommit passed. NativeWindows
privacy regression passed. Real upstream network acceptance not yet performed.

Doctor/Basic preparation feat/rp-21-doctor is based on159746b0 with uncommitted
source/tests/docs in Windows and WSL. Basic wiring4tests green; verifier14tests
Windows12pass2POSIXskips, Linux14pass. Aggregate foundation7tests green.
Offline pinned SpecKit inspector4tests green. Not yet public index routing,
customMemory diagnosis, full guard fixture diagnosis, or final command docs.
Memory-doctor test-writer is active. Do not claim RP21 delivered.

Next deterministic step: collect prose gate, complete pr-ship coverage, open
SpecKit PR; merge only exact reviewed head after namedPRchecks and dispatchWindows.
In parallel finish doctor TDD surfaces, then full checks/reviews. RP24/RP92
remain open; version still0.9.1; no publish/tag/releasechannel action taken.
Root owner dirt and historical worktrees listed above remain untouched.
Run directory remains .claude/runs/20260921-codex-release0100; backups refreshed
as spec-kit-spawn.patch and doctor-verify.patch before any cleanup.

## Live continuation checkpoint � 2026-09-21 14:00 UTC

Master remains 92a3f81fd63ae44dda3db694257ea2604ed0dc11; origin re-fetched,
zero divergence and no open PRs. Previous Codex master checks passed.
Spec Kit clean/pushed head abb85a97fefcc48567a39a1dae7b21caed0f1862 includes
TEMPORARY phase diagnostics that MUST be removed before review/merge.
Hosted run35605355062 failed Windows; Linux passed. Isolated diagnostic
run35608077994 also failed as intended, proving a 10-second timeout inside
Windows PowerShell Add-Type: entered marker observed, compiled/created absent.
Linux passed. Docs-only run35607073381 cancelled after original failure.
Local Node22 isolated normal spawn passed, so Node version is not the cause.
No retry without correction. Round2/3 counted at78903ebb, no round2 fanout;
round1 code/security SHIP159746b, prose HOLD evidence pointers fixed78903ebb.

Doctor branch remains uncommitted based159746b in Windows/WSL; Windows is
newer. Public CLI routing, Basic wiring, bounded verifier, offline SpecKit
inspection, Memory diagnosis are implemented with focused tests. Public
schema corrected to existing ok/warn/fail plus detail/fix; nine doctor tests
pass. Guard fixture worker still diagnoses one failing clean batch; workflow
integrity verification and final full-suite/reviews remain. Memory child
payload validation needs inspection. Do not claim RP21 done.

Next: fix measured Windows compiler bootstrap, remove probe and validate exact
head; finish guard/workflow doctor and docs concurrently. Preserve all dirty
files before updating doctor parent. Root owner dirt unchanged. Refresh
run-directory doctor-verify.patch from HEAD including staged new files.
RP22 InProgress; RP21/RP24/RP92 open; version0.9.1, no publish/tag.

## Live continuation checkpoint � 2026-09-21 14:17 UTC

Spec Kit clean/pushed Windows+WSL head e7601f48f7dcbde92308ec2bcad470caa4701505.
Temporary probes are removed. Diagnostic35610272733 at2ad7a073 proved identical
supervisor succeeds under PowerShell7 within the unchanged deadline; PS5
compiler stalls on hosted Windows. Final change prefers installed standard
PowerShell7, retains system PowerShell fallback, never installs a runtime.
NativeWindows lifecycle/process tests37pass2skip; lint/typecheck and normal
precommit3667pass7skip. Exact-head full hosted dispatch just requested; inspect
GitHub for its run ID. Final gate still pending; no PR, no merge.

Doctor Windows source now includes public route, versioned JSON records,
Basic wiring, bounded verifier, offline SpecKit status, validated Memory
response, structural guard wiring plus package-only allowed/denied fixtures,
and workflow-script integrity. Native focused modules24pass; publicdoctor+
CLI14pass. Linux full suite3792pass8skip with ONE obsolete documented-exit
expectation failure; corrected to include new doctor's usage2, and targeted
contract+guard104tests pass. Final full verification/review still pending.
Current doctor parent159746b; save its own commit before updating parent to
SpecKit final head. Windows is source of latest edits; sync changed files to
WSL and refresh binary patch before cleanup/rebase. Root owner dirt unchanged.
