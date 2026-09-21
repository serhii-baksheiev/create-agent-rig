# 0.10.0 checkpoint — 2026-09-21

Re-read Git/GitHub/Jira before resuming: this is a dated checkpoint, not task
authority. The September 21 descriptions of RP-22, RP-21, RP-24, RP-88 and
RP-92 supersede the older receipt-based architecture in prior handoffs.

## Baseline and preserved work

- Freshly fetched master: `8cd5096de23fefb23681ff383e1518bb04298d54`.
- No open PRs at baseline. [CI](https://github.com/serhii-baksheiev/create-agent-rig/actions/runs/35554031632)
  and [Linux/Windows E2E](https://github.com/serhii-baksheiev/create-agent-rig/actions/runs/35554031646)
  passed on that SHA using hosted runners.
- Preserved S5: `feat/rp-22-s5-mcp`, head
  `420ff588936c40bf2d06521c036f2ecd9fab5e21`, Windows worktree
  `.claude/worktrees/rp22-s5-mcp`. No history rewrite.
- Current ownership slice: `feat/rp-22-intent-mcp`, Windows and WSL
  `.claude/worktrees/rp22-intent-mcp`; the WSL checkout is a validation mirror.
- Independent upcoming spawn/Spec Kit slice: `feat/rp-22-spec-kit`, Windows
  `.claude/worktrees/rp22-spec-kit`, created from the baseline above. Integrate
  the ownership slice before connecting its command surface.
- Main Windows checkout has preserved local changes: modified
  `.claude/hooks/dod-checks.json`; untracked `.rig/claims/RP-111.json.local`,
  `.rig/claims/RP-185.json` and `docs/rig-0.9.0-codex-loop-prompt.md`.
  These are not release changes. Other historical worktrees remain untouched.
- Other dirty worktrees found in the baseline: `release-090-control`
  (staged monthly journal); `rp111-semantic-benchmark` (benchmark tests and
  untracked stage diagnostics); `rp177-owner-reset` (staged create fix/test
  and changelog); `rp189-owned-directory` (staged claim, upgrade fix and test).
  Preserve them. A prunable temporary `native-315ad8f` registration no longer
  has usable Git metadata; it was not removed.

## Remaining release path

RP-22 remains In Progress until all setup acceptance passes. RP-21, RP-24 and
RP-92 remain open. RP-88 is In Progress. Historical prerequisites are Done;
Memory-owned tickets remain relates-only. RP-53 and RP-189 are outside the
mandatory release path.

The ownership slice replaces separate receipts and setup verification with
intent-held Claude entry hashes, explicit consent and stale-plan refusal.
Next: Codex whole-file rendering and rolling fileHash; minimal bounded spawn
and official Spec Kit delegation; Basic Memory preview and aggregated doctor;
exact-SHA release acceptance. The release version has not yet been bumped from
0.9.1. The ledger includes the published 0.9.1 SHA.

Native Windows full-suite evidence requires an E2E dispatch on each code PR's
exact head. The self-hosted dispatch switch remains configured; the repository
runner API returned zero registered runners at this checkpoint. Do not claim
self-hosted execution or macOS acceptance without a run.

## Resume mechanics

Run trace: `.claude/runs/20260921-codex-release0100` in the Windows main checkout.
Re-export its absolute path as `RIG_RUN_DIR` for journal and gates. Jira adapter
uses the existing user-level `~/.config/create-agent-rig/jira.env`; never copy
its contents into a repository or report. RP-22's changed scope was detected at
SELECT and resolved after reading the superseding descriptions, with
`action-changed true`. Claim/revalidation behavior remains frozen.

Before compaction or restart, save all current edits in the task branch or a
named patch and update this checkpoint with the new exact heads and evidence.
The owner has authorized routine engineering, review, Jira and exact-reviewed
merges. Publishing to npm, public tags/releases, release-channel changes,
credentials/grants, paid terms, destructive published-history changes and a
product-boundary change remain owner-only.
