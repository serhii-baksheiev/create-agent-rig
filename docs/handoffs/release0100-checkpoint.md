# 0.10.0 release continuation checkpoint

Snapshot: 2026-09-21 15:44 UTC. Recheck Git/GitHub/Jira after restart;
heads and current ticket descriptions take precedence over this note.

Master: 3d0ef3e9f231134b45dbb99c9edcb5cc4e6e94c6. PR247 schema1/Claude,
PR248 Codex rolling hashes, PR249 official Spec Kit lifecycle/process runner,
and PR250 aggregated doctor/Basic Memory preview are merged. PR250 reviewed
head a61d3ff92c4aa98afb76bf2f786c9d91f2e462af has the same tree as master.
Master CI35619123778 and full hosted Linux/Windows E2E35619123540 PASS.
RP21 is Done with those links. RP22/RP24 In Progress; RP92 To Do, closes last.

RP22 follow-up fix/rp-22-spec-kit-prerequisites is pushed at
fe15a5f5b6bb994092306555efffc12f2c7c36bd. It adds official
--ignore-agent-tools to initial Spec Kit configuration and discloses that
harness runtime/trust remain unverified. Fake-upstream regression was Red;
Windows targeted30pass2skip, Linux32pass, lint/typecheck and3726unit/template
pass7skip. Gate round1/3; code review started; security/prose pending.
Full hosted dispatch35620638349 pending. No PR yet. Matching Windows/WSL
worktrees rp22-spec-kit-prerequisites are clean. RP22 scope revalidation hold
was resolved by rereading the current final description and normal outcome.

RP24 branch feat/rp-24-release-acceptance is pushed at
f01a0a18ba53b2457e001a5761f0bf5c12d8b247. No PR yet. First real network lane
35618263910: normal full Linux/Windows suites PASS, packed acceptance FAIL
on both with packed-rig-command-failed. No real acceptance pass is claimed.
Review round1/3 HOLD: add finite phase/status/exit diagnosis, validate full
SHA before checkout in both jobs, name exact preflight tests in release docs.
Windows worktree has those source/workflow/docs fixes and new Red tests in
progress; not yet copied to WSL or committed. Test writer is correcting the
Windows Bash test launcher. Do not reset either worktree or lose edits.
Integrate the Spec Kit prerequisite fix before the next real acceptance run;
its relation to the current failure is still a hypothesis until phase data.

Active worktrees: rp24-release-acceptance and rp22-spec-kit-prerequisites.
Merged rp21-doctor cleanup is in progress; merged rp22-spec-kit was removed.
Matching WSL clone /home/serhiibaksheiev/rig, Ubuntu user serhiibaksheiev;
source ~/.nvm/nvm.sh before pnpm. Original S5 and historical dirty worktrees
remain untouched. Root owner dirt: .claude/hooks/dod-checks.json,
.rig/claims/RP-111.json.local, .rig/claims/RP-185.json,
docs/rig-0.9.0-codex-loop-prompt.md. Never include them in release commits.

Evidence: .claude/runs/20260921-codex-release0100. Reviews, failure logs and
patch backups live there. Root stash labelled RP21 Windows checkpoint and
WSL backup/rp21-before-spec-parent preserve earlier doctor work. Record
review verdicts via record.mjs decision, not events; coverage reads decisions.
Original Spec Kit gate3 exhausted and completed; doctor gate2 completed;
acceptance gate1 and new prerequisite branch gate1 are independent work.
No frozen claim fingerprints or revalidation mechanisms were changed.

Next: finish bounded fixes/reviews, merge prerequisite PR after exact-head
Linux/Windows checks, verify master; complete real packed acceptance on
Linux/Windows. Then prepare version0.10.0, changelog/compatibility/ledger,
content+secret scans/package hash and final exact-release-SHA evidence.
Package remains0.9.1. Hosted is primary, self-hosted route retained but no
registered runner observed; macOS untested. Memory-owned tickets remain
relates-only. No publish, public release/tag or channel change authorized.
