# 0.10.0 release continuation checkpoint

Snapshot: 2026-09-21 16:02 UTC. Recheck Git/GitHub/Jira after restart;
heads and current ticket descriptions take precedence over this note.

Master: eb86d97b02c33c88bb6f9ed93511280d585d2f35. PR251 merged the
Spec Kit prerequisite correction; its master CI35622465648/E2E35622465657
are pending. Previous master3d0ef3e passed all checks. PR247 schema1/Claude,
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
pass7skip. Gate round1/3; code/security/prose SHIP and coverage complete.
Full hosted dispatch35620638349 PASS both OS; PR251 merged with identical
tree. Matching Windows/WSL
worktrees rp22-spec-kit-prerequisites are clean. RP22 scope revalidation hold
was resolved by rereading the current final description and normal outcome.

RP24 branch feat/rp-24-release-acceptance is pushed at
ff01fda00bb5e1a5b820090fb794853660ca8300. No PR yet. First real network lane
35618263910: normal full Linux/Windows suites PASS, packed acceptance FAIL
on both with packed-rig-command-failed. No real acceptance pass is claimed.
Review round1/3 HOLD: add finite phase/status/exit diagnosis, validate full
SHA before checkout in both jobs, name exact preflight tests in release docs.
Round2 code/security/prose SHIP and coverage complete at ff01fda.
Dedicated run35621981552: Linux full suite passed; real initial Spec Kit
installation and dual status passed, then repeat failed because the fixture
modified SKILL.md before repeat. Official status correctly reported warning.
Windows still running. The bounded scenario fix keeps skill bytes+mtimeNs
unchanged through repeat, then doctor, then modifies it only for uninstall
preservation. Windows script/checkpoint edits are being committed in WSL.
This failed real test is the Red case; no product mechanism changes.

Release metadata is prepared independently in chore/rp-24-release0100,
worktree release0100. Windows at ff01fda has six uncommitted metadata/doc
files (root+inner package0.10.0, CHANGELOG, README, command contract,
regenerated hash-history). WSL worktree is mid-merge from master eb86d97
with the same metadata copied; no commit/push yet. Backup release-metadata.patch
is in runDir. Targeted version/hash/contract/compatibility126tests PASS.
Do not reset either metadata worktree. Bring in the final acceptance fix
before final release review/evidence. No 0.10 ledger row is added.
Active worktrees: rp24-release-acceptance, rp22-spec-kit-prerequisites, release0100.
Merged rp21-doctor and rp22-spec-kit worktrees/local+remote branches removed.
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
acceptance gate2 and prerequisite branch gate1 are independent work.
No frozen claim fingerprints or revalidation mechanisms were changed.

Next: finish bounded fixes/reviews, merge prerequisite PR after exact-head
Linux/Windows checks, verify master; complete real packed acceptance on
Linux/Windows. Then prepare version0.10.0, changelog/compatibility/ledger,
content+secret scans/package hash and final exact-release-SHA evidence.
Package remains0.9.1. Hosted is primary, self-hosted route retained but no
registered runner observed; macOS untested. Memory-owned tickets remain
relates-only. No publish, public release/tag or channel change authorized.
