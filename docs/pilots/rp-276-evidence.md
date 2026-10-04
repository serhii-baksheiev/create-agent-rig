# RP-276 three-controller parallel pilot — acceptance evidence

Fixture: `serhii-baksheiev/rig-1-2-parallel-pilot`. Clones: `<pilot-host>/c-A` (pilot-A), `c-B` (pilot-B), `c-C` (pilot-C). All times UTC, 2026-10-04 unless stated.

Timeline anchor: PR #10 (rig upgrade) merged 21:24:20Z as 06df565; PR #11 (contract amendment) merged 21:35:20Z as 146ec9d.

## Item → controller → PR map

| Item | Spec task                          | Controller | Claim comment | PR  | PR head | Merge commit | Closed    |
| ---- | ---------------------------------- | ---------- | ------------- | --- | ------- | ------------ | --------- |
| #2   | T005 (README)                      | pilot-C    | 21:38:43Z     | #13 | 7e2480f | 121c8bd      | 21:43:06Z |
| #3   | T002 (countPrefix)                 | pilot-A    | 21:29:33Z     | #14 | 133013c | 1939300      | 21:45:17Z |
| #4   | T003 (countSuffix)                 | pilot-B    | 21:30:22Z     | #15 | 1d8770e | ceef4ec      | 21:47:34Z |
| #5   | T004 (summarize + README examples) | pilot-B    | 21:52:54Z     | #17 | 268344a | c312c42      | 22:09:28Z |

---

## 1. No duplicate ownership — PASS

Each of #2–#5 was claimed and shipped by exactly one controller (table above). One concurrent-claim attempt occurred and was refused by the queue adapter, not by coincidence of timing:

- `c-B/.claude/runs/20261005-012536-pilot-B/events.jsonl` seq 2: pilot-B's own SELECT ran for ticket 3 at 21:25:41Z (`BASELINE_CREATED`).
- seq 3 (21:26:28Z, 28 s after pilot-A's label): `{"kind":"claim","data":{"ticket":"3","ok":false,"claimed":false,"reason":"claim-stale","detail":"the issue is already labelled in-progress (labelled 2026-10-04T21:26:00Z by another controller, after SELECT at 21:25:41Z)"}}` — pilot-A had claimed #3 first (label event at 21:26:00Z per `c-A`'s side); pilot-B's claim was rejected.
- pilot-B then re-selected and took #4 instead (seq 5–7, `claim ok:true` at 21:26:43Z).

The GitHub timelines show exactly one `in-progress` label event per item in this run, and no issue carries two controllers' claim comments. (pilot-A's own `decisions.jsonl` shows two `item-selection: taken 3` entries at 21:25:20Z/21:25:48Z — this is **not** a second controller; it is pilot-A's own SELECT re-running after its first baseline record raced an untracked-file check, resolved internally as `revalidation-outcome … actionChanged:false`, filed afterward as improvement proposal #12.)

## 2. Blocked work never selected early — PASS

- #3 closed **21:45:17Z** (issue timeline `closed` event).
- #4 closed **21:47:34Z** (issue timeline `closed` event).
- #5 selected (`item-selection: taken 5`) at **21:48:09Z** (`c-B/.claude/runs/20261005-014533-pilot-B/decisions.jsonl` seq 4) — i.e. 35s after #4's close, and claimed/labelled in-progress at 21:48:24Z, claim comment posted 21:52:54Z. Both predecessors were closed before #5 was taken.
- Seven `nothing-selectable` SELECT outcomes before 21:48:09Z each counted one item held by `blocked` (pilot-A 21:36:56Z and 21:45:44Z; pilot-B 21:34:35Z, 21:36:48Z, 21:36:55Z and 21:45:40Z; pilot-C 21:43:31Z). Three of them, quoted:
  - `c-A/.../20261005-012514-pilot-A/decisions.jsonl` seq 35 (21:36:56Z): "3 item(s) are takeable work held back right now — 2 held by in-progress, 1 held by blocked... 1 item(s) are parked — 1 escalated."
  - `c-B/.../20261005-013638-pilot-B/decisions.jsonl` seq 1–2 (21:36:48Z, 21:36:55Z): same wording.
  - `c-C/.../20261005-012908/decisions.jsonl` seq 45 (21:43:31Z): "2 held by in-progress, 1 held by blocked."
- pilot-A's correction comment on #3 (21:46:28Z) names it explicitly: "#5 was waiting on #3 (now resolved) and stays blocked by #4, which is open and in progress under another controller. Nothing became selectable from this close."
- pilot-B's own close comment on #4 (21:47:30Z): "Unblocked: #5 was waiting on #3 and #4 (links); both are now closed."

## 3. Only ready/in-scope/unclaimed work returned — PASS

Per-controller selection/outcome sequence (from `decisions.jsonl` `item-selection` entries):

- **pilot-A**: taken 3 (21:25Z, run 1) → stopped `nothing-selectable` (21:36:56Z) → [escalation resolved, #3 shipped] → run 2: stopped `nothing-selectable` (21:45:44Z, "1 held by blocked, 1 held by in-progress").
- **pilot-B**: taken 3 → claim refused → taken 4 (21:26Z) → stopped `nothing-selectable` (21:34:35Z, run1) → run2: stopped `nothing-selectable` ×2 (21:36:48Z/55Z) → [resumed #4, shipped] → run3: stopped `nothing-selectable` (21:45:40Z) → taken 5 (21:48:09Z) → stopped `queue-empty` (22:09:42Z, final).
- **pilot-C**: taken 2 (21:29:13Z) → [shipped] → stopped `nothing-selectable` (21:43:31Z).

No selection ever names an out-of-scope or already-claimed item as "taken." Out-of-scope items (triage proposals #12/#16/#18) are explicitly called out as "fall outside the configured scope" in the stop messages, never selected as work.

## 4. Width naturally limits concurrency — PASS

Three controllers ran against four items (#2–#5); the plan let at most three run at once (#2, #3, #4), with #5 gated on #3 and #4, and the blocked item produced real `nothing-selectable` stops rather than invented work:

- pilot-A run 1 stopped `nothing-selectable` at 21:36:56Z while #3 (claimed, escalated at 21:36:45Z) and #4 (in progress under pilot-B) were both open, so the join #5 was still blocked on both.
- pilot-B's first run (`20261005-012536-pilot-B`) escalated #4 at 21:33:56Z and stopped `nothing-selectable` at 21:34:35Z. Its second run (`20261005-013638-pilot-B`) recorded two `nothing-selectable` selections at its start (21:36:48Z, 21:36:55Z), then resumed the #4 it already held from its continuation note after the amendment.
- Final state: pilot-A ends on `nothing-selectable` (queue has no more scoped, unclaimed, unblocked work for it after #3); pilot-C ends on `nothing-selectable` after #2; pilot-B alone drains the dependent tail (#4 then #5) and is the one to see `queue-empty`.

## 5. Merge/close unlocks downstream — PASS

- #4 closed **21:47:34Z**; #5 claimed **21:48:09–21:48:24Z** (selection→label), i.e. unlocked promptly after the second blocker cleared (#3 had already cleared at 21:45:17Z).
- Close performed by the adapter after `BEFORE_CLOSE` revalidation in every case:
  - #2: `revalidation` BEFORE_CLOSE `CHANGED`/`hold` at 21:42:53Z → `revalidation-outcome actionChanged:false` at 21:43:03Z → closed 21:43:06Z.
  - #3: BEFORE_CLOSE `CHANGED`/`hold` at 21:44:32Z → outcome `actionChanged:false` 21:44:46Z → closed 21:45:17Z.
  - #4: BEFORE_CLOSE `CHANGED`/`hold` at 21:46:39Z → outcome `actionChanged:false` 21:46:59Z → closed 21:47:34Z.
  - #5: BEFORE_CLOSE `CHANGED`/`hold` at 22:08:33Z → outcome `actionChanged:false` 22:09:13Z → closed 22:09:28Z.
- All four merged PR bodies use `Refs #n` (#13 "Refs #2", #14 "Refs #3", #15 "Refs #4", #17 "Refs #5") — none use a GitHub closing keyword (`Closes`/`Fixes`); closing was done by the adapter's explicit close call, confirmed per the RP-330 convention.

## 6. Existing worktree/test/review/pr-ship pipeline reused — PASS

RED observed before GREEN for every item, reviewer fan-out executed, exact-head CI gated the merge:

| Item | RED (check, exit)                                                     | GREEN (check, exit)                               | Reviewers run                                            | Final pr-ship    | CI on exact head                                |
| ---- | --------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------- | ---------------- | ----------------------------------------------- |
| #2   | `red-readme` exit 1 (ENOENT README.md)                                | `test` exit 0 (3 files/4 tests), lint/typecheck 0 | code-reviewer SHIP, prose-reviewer SHIP                  | SHIP (round 3/3) | `verify` success, GitGuardian success @ 7e2480f |
| #3   | `prefix-red` exit 1 (`Cannot find module…/prefix.js`)                 | `prefix-green` exit 0                             | code-reviewer (HOLD→SHIP), security-scanner SHIP         | SHIP (round 3/3) | `verify` success, GitGuardian success @ 133013c |
| #4   | `suffix-red` exit 1                                                   | `suffix-green` exit 0                             | code-reviewer (HOLD→SHIP)                                | SHIP (round 3/3) | `verify` success, GitGuardian success @ 1d8770e |
| #5   | `report-red` exit 1 (both report.test.ts and readme-examples.test.ts) | `report-green` exit 0                             | code-reviewer, prose-reviewer, security-scanner all SHIP | SHIP (round 1/3) | `verify` success, GitGuardian success @ 268344a |

Each branch is a per-item git branch/worktree under the controller's clone (`pilot-a/issue-3-count-prefix`, `pilot-B/4-count-suffix`, `pilot-B/5-summarize-report`, `pilot-C/issue-2-contributor-readme`), with `.rig/claims/<n>.json` SELECT baselines and `check-run` logs under each run's `checks/` directory (e.g. `c-A/.claude/runs/20261005-012514-pilot-A/checks/prefix-red-*.log`).

## 7. Revalidation catches stale assumptions — PASS

Revalidation HOLDs observed in the journals (all resolved `continue`/`actionChanged:false` after a re-read):

- **#3 BEFORE_PR**, two HOLDs (`CHANGED`, source `claim:scope`) at 21:39:58Z and 21:40:20Z — master had moved 06df565→146ec9d (#11); re-read confirmed T002 unaffected.
- **#4 BEFORE_PR**, HOLD (`claim:scope`) at 21:38:02Z/21:38:36Z — same #11 move; re-read confirmed T003 unaffected, the amended contract itself answered the open escalation.
- **#2 BEFORE_PR**, two HOLD cycles (21:38:17Z, 21:38:53Z/21:39:19Z) — once for #11's master move, once because the controller's own progress comment moved the `commentary` fingerprint.
- **BEFORE_CLOSE** HOLDs (`claim:scope`+`claim:commentary`) fired on all four items (#2 21:42:53Z, #3 21:44:32Z, #4 21:46:39Z, #5 22:08:33Z) — each re-read and recorded `actionChanged:false` before the adapter closed.
- `check-premises` also caught two **UNMEASURED** prose claims directly (not revalidation, but the same "don't ship an unbacked claim" mechanism): pilot-C's README draft asserted `corepack enable` gets pnpm 11.16.0 with nothing backing it (`c-C/.../decisions.jsonl` seq 14, 21:37:56Z) — deleted before shipping; pilot-A's draft PR body claimed `pnpm test/lint/typecheck` ran green with no matching `check-result` event (`c-A/.../decisions.jsonl` seq 17, 21:33:42Z) — deleted/replaced with a pointer.

**The reviewer-caught contract conflict (#3/#4), precisely:** `code-reviewer` — not revalidation — flagged that `specs/pilot/contract.md:43-44` required RED/GREEN to be recorded in the **portable issue claim** (`tddEvidence` in `.rig/claims/N.json`), but PR #10 (the rig upgrade, RP-398) had removed `.claude/scripts/lib/tdd-evidence.mjs`, the only mechanism able to write that field. code-reviewer returned **HOLD** on both #3 (`92722bd`, "checklist item 6 — contradicts the item it claims to implement") and #4 (`ebfe77e`, same checklist item) at gate round 1. Both controllers escalated (documented-stall) rather than fabricating the field by hand. The operator resolved it with PR #11 (amending `specs/pilot/contract.md` so RED/GREEN are recorded as an issue comment instead of the portable claim) plus matching "Operator decision" comments on #3 (21:37:09Z) and #4 (21:35:23Z). Both controllers then resumed at gate round 2/3 and shipped at round 3 with code-reviewer SHIP. This is an invariant conflict between a stale contract clause and an upgraded rig, correctly caught by the reviewer gate (not by revalidation, and not by CI).

## 8. No manual assignment after start — PASS

GitHub `assignees` on #2–#5 are all `[]` — no issue was ever assigned to a person or bot. The only operator actions found in the record, all consistent with the stated boundaries:

- Stale-claim releases before start, comments at 21:23:48Z (#2) and 21:23:51Z (#3): "Stale claim released for the RP-276 resume run... the item returns to the ready pool for a fresh independent controller."
- The contract amendment, PR #11 (merged 21:35:20Z), opened in response to the escalations.
- Escalation answers posted as "Operator decision" comments on #4 (21:35:23Z) and #3 (21:37:09Z), both pointing at #11 rather than hand-editing any claim or code.
- Restarting headless sessions and adding the bounded-wait instruction to the controllers' prompt (see §9/anomalies) — neither assigns an item.

No comment or label event assigns an item to a named controller by hand; each claim is backed by the controller's claim record (`workflowClaim`), its `in-progress` label and its claim comment.

## 9. Dispatch/run evidence recorded

Run directories (all under `.claude/runs/` in each clone):

- `c-A/.claude/runs/20261005-012514-pilot-A/` — first pilot-A run (#3 end-to-end: check-premises, reviewer fan-out, pr-ship rounds 1 & 3, PR body, escalation-3.md, continuation-3.txt, tdd-observations-3.md, check logs under `checks/`).
- `c-A/.claude/runs/20261005-014340-pilot-A/` — restarted pilot-A run (preflight.md CAUTION, merge+close of #14, then `nothing-selectable`).
- `c-B/.claude/runs/20261005-012536-pilot-B/` — first pilot-B run (#3 claim-refused → #4 claimed, escalation-4.md, proposal.json for issue #12).
- `c-B/.claude/runs/20261005-013638-pilot-B/` — restarted pilot-B run (resumed #4 after the amendment and opened PR #15; it ended while waiting for CI).
- `c-B/.claude/runs/20261005-014533-pilot-B/` — restarted pilot-B run (claims #5, ships it, proposal.json for #18, final `queue-empty`).
- `c-C/.claude/runs/20261005-012908/` — single pilot-C run (claims #2, ships it, proposal.json for #16, `nothing-selectable`).

Each run directory contains `decisions.jsonl` (gate verdicts) and `events.jsonl` (revalidation/claim/dispatch-start/dispatch-end/check-result events with `dispatch-end` carrying model/usage telemetry), plus `state.json` (take-up timestamps, escalation counters), `budget.md`, `pr-body.md`, per-reviewer `.md` reports, and `checks/*.log` raw command output. `.rig/claims/<n>.json` in each clone records the SELECT baselines of the items that clone selected, plus the tracked records merged in from other controllers' PRs; `.claude/gate-rounds.json` in each clone records the per-branch round counters (`pilot-a/issue-3-count-prefix: 3`, `pilot-B/4-count-suffix: 3`, `pilot-B/5-summarize-report: 1`, `pilot-C/issue-2-contributor-readme: 3`).

Logs: `<pilot-host>/logs/pilot-{A,B,C}.log` (final summaries + stop condition + run dir, per prompt instructions), plus `pilot-A-run1.log`, `pilot-B-run1.log`, `pilot-B-run2.log` documenting the earlier, superseded headless sessions. `pids.txt`/`pids-C.txt` record the launched process IDs.

## Anomalies (honest list)

- **Headless session exits while waiting on CI.** pilot-A's first session ended while waiting for PR #14's CI (`pilot-A-run1.log`: "PR #14 is open. I'm waiting for CI `verify` to finish..."). pilot-B's first session (`20261005-012536-pilot-B`) ended on `nothing-selectable` after escalating #4; its second session (`20261005-013638-pilot-B`) resumed #4 and ended while waiting for PR #15's CI (`pilot-B-run2.log`: "Still waiting on the background CI poll for PR #15..."). The relaunched runs `20261005-014340-pilot-A` and `20261005-014533-pilot-B` picked up the in-flight PRs and finished the merge and close. The cause is the headless session ending with the turn, not the queue adapter; the controllers' instructions were amended to wait with a bounded foreground command.
- **Escalations.** #3 and #4 both escalated (documented-stall) at gate round 1 over the same stale contract clause (see §7); both resolved via operator decision + PR #11 and shipped by round 3.
- **Uncommitted journal files in every clone.** `journal/2026-10.md` is untracked (`git status --short`) in all three clones — by design/rule ("committing straight to master isn't allowed," noted independently by pilot-A, pilot-B and pilot-C in their final logs). Not an error; flagged by each controller itself.
- **Three improvement proposals filed as triage issues**, none of which altered pilot behavior: #12 (pilot-B: delete the untracked SELECT baseline after a refused claim), #16 (pilot-C: BEFORE_PR re-hold cost 2 of 3 gate rounds on a no-op comment-fingerprint change), #18 (pilot-B: post progress comments through the adapter, not raw `gh`, to avoid spurious `claim:commentary` drift at BEFORE_CLOSE).
- **Adapter's own "Landed in …" close comments** do not carry the "controller pilot-X:" prefix (the adapter posts them, not the controller); pilot-A and pilot-B both noted this and could not change it, each posting a separately-prefixed close comment alongside it.
- **Codex unavailability for controller C.** The first pilot-C process was `codex exec` (codex-cli 0.157.0). It stopped before selecting anything with `The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.`; a probe on a supported model then reported the account's usage limit until 2026-10-10. The controlling session recorded this on RP-276 (comment of 2026-10-04 21:27Z) before the relaunch overwrote `logs/pilot-C.log`; pilot-C then ran as a third Claude Code controller. The owner later ruled (RP-276, 2026-10-05) that Codex is not used in this pilot and that three Claude Code controllers satisfy it, since the harness makes no essential difference to what the pilot proves.
- **pilot-A gate round 1 HOLD on check-premises UNMEASURED** (pr-body claiming local green checks with no matching check-result) and **pilot-C's corepack claim** — both caught and fixed before shipping (§7), not failures of the pipeline but evidence it worked.
