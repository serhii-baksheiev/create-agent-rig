# 0.10.0 release continuation checkpoint

Snapshot: 2026-09-21 15:17 UTC. Recheck Git/GitHub/Jira after restart;
heads and current ticket descriptions take precedence over this note.

Master: f38d9cbf8c914ea10f27562c62abe4cb894b927d. PR249 merged the pinned
Spec Kit lifecycle and minimal process runner from reviewed head
4eefcd454e16851e73c22786b92382343c432d07. Full hosted Linux/Windows dispatch
35614012001 passed before merge; merge tree equals the reviewed tree.
Master CI35616266887 passed; full post-merge E2E35616266888 is still running.
Earlier PR247 delivered schema1/Claude ownership; PR248 delivered Codex hashes.

Open PR250: https://github.com/serhii-baksheiev/create-agent-rig/pull/250
Head a61d3ff92c4aa98afb76bf2f786c9d91f2e462af, feat/rp-21-doctor.
Code/security/prose SHIP in round2 of3; exact-head coverage complete.
Full Linux passed dispatch35617153962; Windows and ordinary PR checks pending.
Previous full Linux/Windows8e205759 passed. The final review correction warns
on selected providers without harnesses and skips their upstream diagnosis;
two regression rows were Red, then all11 doctor tests passed on both platforms.
Do not merge until all exact-head checks pass. Verify master after merge.

RP24 branch feat/rp-24-release-acceptance is pushed at
de49b9906ee7177ff1398a996c6a3634dbf5b192. Windows was synchronized to that
commit. WSL is merging reviewed doctor a61d3ff; only the old checkpoint text
conflicted, replaced by this current snapshot. Finish the merge commit, push,
synchronize Windows, then run formal reviews and the explicit network lane.
No real provider-network acceptance has run yet. No RP24 PR is open yet.
The branch owns .github/workflows/e2e.yml, scripts/release-acceptance.mjs,
test/template/release-acceptance.test.ts, docs/releasing.md, this checkpoint
and the adapter-created .rig/claims/RP-24.json. Preflight refusal tests pass.
The lane requires release_acceptance=true plus a full release_sha and retains
the hosted/self-hosted switch; macOS is untested.

Jira: RP22/RP21/RP24 In Progress, RP92 To Do. RP92 closes last. Memory-owned
issues remain relates-only. RP24 SELECT created its baseline through the
unchanged claim mechanism after complete sibling-journal inspection; the
adapter acknowledged its claim. RP22's old receipt scope is superseded and
its revalidation holds have normal recorded reread outcomes. Do not rewrite
frozen claim fingerprints or revalidation behavior.

Active Windows worktrees are under .claude/worktrees/: rp21-doctor,
rp24-release-acceptance and merged rp22-spec-kit (cleanup pending).
Matching WSL clone: /home/serhiibaksheiev/rig, Ubuntu user serhiibaksheiev;
source ~/.nvm/nvm.sh before pnpm. Original S5 branch/worktree is preserved.
Historical dirty worktrees are untouched. Root owner changes remain:
.claude/hooks/dod-checks.json, untracked .rig/claims/RP-111.json.local,
.rig/claims/RP-185.json and docs/rig-0.9.0-codex-loop-prompt.md.
Never include those in a release commit.

Run evidence: .claude/runs/20260921-codex-release0100. It contains review
reports, CI failure diagnoses and patch backups, including doctor-review-fix.patch
and rp24-fragment.patch. Root stash labelled "RP21 Windows checkpoint before
adopting saved and rebased doctor commit" and WSL backup branch
backup/rp21-before-spec-parent retain the earlier doctor state. No work is lost.
For journal reviews use record.mjs decision, not an event: coverage reads
review decisions. Reports end in fenced JSON; raw JSON is for recording only.
Gate counts: SpecKit3 exhausted, CI fixture-only closure reviewed without a
fourth broad audit; doctor2; RP24 formal review not started.

Next: merge doctor only after checks; verify master and update Jira. Complete
RP24 real pinned Spec Kit/packed artifact evidence on Linux and Windows, then
prepare version0.10.0, changelog/compatibility/ledger, content+secret scans and
final exact-release-SHA acceptance. Package is still0.9.1. No npm publish,
public tag/release or release-channel change is authorized. Stop only for the
owner's final publish step after the remaining safe work is complete.
