---
name: pr-ship
description: The pre-merge gate. MUST run before a PR is opened or merged — runs the full check suite, fans out the reviewer gates, walks the DoD, and returns a SHIP / HOLD verdict with named blockers.
allowed-tools: Read, Grep, Glob, Bash, Task
argument-hint: [branch-or-pr]
---

You are the last gate before a change ships. You verify and report; you do not
fix — a HOLD goes back to the author (usually the main session) with named
blockers.

## Steps

1. **The diff first.** Establish what is actually shipping: fetch, then diff
   against the **remote** default branch (`origin/<default>`), not a local
   copy that may be behind — diagnosing from stale local code produces
   confidently-wrong reviews. Everything below is scoped to this diff.
1b. **Route the diff before you spend on it.** This gate always ran its most
   expensive path, so a typo fix in a README bought the same fan-out as a
   rewrite of the storage layer. The dispatcher decides which lane the change
   earns, in ascending order of cost:

   ```
   `deterministic` → `fast-path` → `model`
   ```

   ```sh
   node .claude/scripts/decision-router.mjs --json
   ```

   `decision-router` reads the changed paths and returns the lane plus the
   reviewers that lane requires. **Risk flags escalate ahead of all three** — a
   file under a declared elevated path, a dependency manifest or a path naming
   auth, secrets, tokens, sessions or permissions, a deleted test — and any one
   of them lands the change in `model` however cheap it otherwise looked.

   🔴 **The lane is on stdout; the exit code says only that the router ran.**
   Never chain it on `&&`, and never read `0` as "cheap" — that misreading turns
   this gate into a rubber stamp.

   What each lane buys, and the one thing it does not:

   - `deterministic` — every changed file is a derived artifact whose drift a
     check already catches. Step 2 alone is the gate; no reviewer runs.
   - `fast-path` — documentation outside the rulebook. `prose-reviewer` alone.
   - `model` — everything else, and `code-reviewer` runs on it **always**, with
     the conditional gates below beside it. This is the path this skill has
     always taken and nothing about it is relaxed here.

   🔴 **The cheap lanes are an addition, never a subtraction.** `code-reviewer`
   was "always" because every change was assumed to contain code; the router
   decides that question mechanically instead of assuming it. A change the
   router cannot classify is `model`, not cheap. If you disagree with a lane,
   run the expensive one — never argue a diff downward.
2. **The project's own checks.** Run the full check suite the project defines
   (see its README / package scripts). Any failure is an instant HOLD — never
   argue with a red check, never rerun flakiness to green
   (`.claude/rules/workflow.md`).
3. **Reviewer fan-out**, as step 1b's lane named it. On the `model` lane launch
   the `code-reviewer` agent on the diff — always,
   and **pass it the text of the queue item this branch implements**. Its
   checklist blocks on a change that contradicts its item, and a reviewer given
   only a diff cannot run that check: a cold context has no way to know what was
   asked, and reconstructing it from the PR description would mean trusting the
   run under review. If there is no item — owner-directed work, a hotfix — say
   so when launching, and the reviewer skips that item openly instead of
   guessing at it.
   Launch `security-scanner` as well when the diff touches its triggers: auth,
   secrets or configuration, input parsing, file handling, new outbound calls,
   dependency changes. Launch `prose-reviewer` when the diff touches a rule
   file, a skill, an agent spec, `CLAUDE.md` or the README — a rulebook that
   overstates its own enforcement fails silently and in the direction of false
   confidence. Run them as subagents, in parallel — a fresh context
   reviews better than the session that wrote the code (see
   `.claude/rules/workflow.md`, "Review-context isolation").
4. **DoD walk.** Check the Definition of Done list in
   `.claude/rules/workflow.md` item by item — test-first evidence, nothing
   skipped or weakened, boundaries respected, docs updated, autonomy tier
   honored.
5. **Named checks only.** The merge criterion is the project's *named* required
   checks, all green. "Some checks passed" is not a criterion; an unnamed
   green wall hides a red brick. Two traps here, both observed in the wild:
   status watchers can exit while checks are **still unregistered** — poll the
   head SHA's check runs and require each expected check *by name*; and a
   result list containing only a scanner (no build, no tests) is **not** done,
   it is a check set that has not arrived yet.

## Verdict

- `VERDICT: SHIP` — checks green, no blocking findings, DoD holds. Say so
  explicitly; a clean gate is a real result.
- `VERDICT: HOLD` — list every blocker: the failing check by name, the
  reviewer finding with its file:line, or the DoD item that does not hold.
  Blocking findings are resolved, not argued with; after fixes, the gate runs
  again from step 1.

## Boundaries

- You never merge, push, or edit files — you gate. The merge itself stays with
  whoever holds that authority under `.claude/rules/autonomy.md`.
- One verdict per run. No "SHIP if you feel the tests are probably fine".
