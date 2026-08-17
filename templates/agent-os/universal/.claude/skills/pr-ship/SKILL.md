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
2. **Route the diff before you spend on it.** This gate always ran its most
   expensive path, so a typo fix in a README bought the same fan-out as a
   rewrite of the storage layer. The dispatcher decides which lane the change
   earns, in ascending order of cost:

   ```
   `deterministic` → `fast-path` → `model`
   ```

   ```sh
   node .claude/scripts/decision-router.mjs --base origin/<default> --json
   ```

   **Pass the same base step 1 resolved.** The default is `origin/HEAD`, a ref
   `git clone` sets and `git init` + `git remote add` does not — and a base that
   is merely *different* rather than missing does not fail at all: the router
   routes a narrower file set than the one this gate reviews, and the narrower
   set is the one that can lose a risk flag.

   ⚠ **It routes the committed diff, `<base>...<head>` — never the working
   tree.** An uncommitted edit is invisible to it, including reviewer fixes you
   have applied but not committed, so commit before routing. If this gate was
   invoked on a PR that is not checked out, check it out first.

   `decision-router` reads the changed paths and returns the lane plus the
   reviewers that lane requires. **Risk flags escalate ahead of all three** — a
   file under a declared elevated path, a dependency manifest or a path naming
   auth, secrets, tokens, sessions or permissions, a deleted test (including the
   deletion half of a rename) — and any one of them lands the change in `model`
   however cheap it otherwise looked. The elevated-path flag has one carve-out,
   inherited from the gate sweep rather than invented here: `.md`/`.mdx` files
   and test paths that provision nothing are **inert**, so `infra/README.md`
   does not escalate while `infra/stack.ts` does. Note the mechanism is those
   two extensions and test paths — **not** this router's own notion of prose,
   which is `.md`/`.txt`. Neither set contains the other, and both differences
   are deliberate: aligning the sweep to the router takes `requirements.txt` in
   an elevated directory out of escalation, and aligning the router to the
   sweep puts executable `.mdx` back on the prose lane. A rulebook file is
   never inert.

   🔴 **The lane is on stdout; the exit code says only that the router ran.**
   Never chain it on `&&`, and never read `0` as "cheap" — that misreading turns
   this gate into a rubber stamp. **Exit 1 is not a lane**: it means nothing was
   routed — an unreadable diff, an empty file list, a project declaring no
   elevated path, an unrecognised flag, a base or head that is not a revision,
   or a run directory that is not there. Treat it as `model` and fix the cause;
   it is never a reason to skip the gate.

   🔴 **One rule covers every outcome: read STDOUT.** If a lane printed, that is
   the answer; if stdout is empty, treat the change as `model`. Do **not** key
   on the `run journal:` prefix — both journal failures wear it and they end
   differently. A trace that can no longer accept records ends the *trace*, not
   the routing, so the lane still prints and the exit stays 0 (start the next
   run in a new run directory). A run directory that was never there exits 1
   with nothing routed.

   What each lane buys:

   - `deterministic` — every changed file is a derived artifact, git says it was
     `modified` or `removed`, and **none of them sits under a declared elevated
     path**. The lane's floor is empty; step 4's triggers still apply on top.
   - `fast-path` — documentation outside the rulebook, plus any derived file
     travelling with it under those same two rules. `prose-reviewer` is the
     floor.
   - `model` — everything else, and `code-reviewer` runs on it **always**,
     with the triggers in step 4 beside it. Anything the router cannot classify
     lands here.

   🔴 **State what the cheap lanes give up, because they do give something up.**
   Dropping `code-reviewer` drops two of its checklist items that are *not*
   about code — contract drift, and "contradicts the item it claims to
   implement". Neither is decidable from paths. So the cheap lanes carry the
   item text to whatever cold reader they do launch (step 4).

   The `deterministic` lane launches none, and that rests on one claim: a file
   is generator output, so a check already catches its drift. The claim needs a
   prior output to have drifted **from** — which is why an added, copied,
   renamed or status-less entry is refused the lane, and why a **test snapshot
   is not a derived artifact here at all**. A snapshot is the behaviour claim,
   rewritten by the run that then passes by construction; routing one to a lane
   with no reviewer would be weakening a test with a dispatcher.

   If you disagree with a lane, run the expensive one — never argue a diff
   downward.
3. **The project's own checks.** Run the full check suite the project defines
   (see its README / package scripts). Any failure is an instant HOLD — never
   argue with a red check, never rerun flakiness to green
   (`.claude/rules/workflow.md`).
4. **Reviewer fan-out.** The lane from step 2 sets the **floor**:

   - `model` → launch the `code-reviewer` agent on the diff, always;
   - `fast-path` → launch `prose-reviewer`;
   - `deterministic` → the lane's floor is empty. The triggers below still
     apply: a floor of zero is not permission to skip one.

   **Whatever you launch, pass it the text of the queue item this branch
   implements.** A reviewer given only a diff cannot check the change against
   what was asked: a cold context has no way to know, and reconstructing it from
   the PR description would mean trusting the run under review. If there is no
   item — owner-directed work, a hotfix — say so when launching, and the
   reviewer skips that check openly instead of guessing at it.

   🔴 **The triggers below are lane-independent and may only ADD.** They read
   *what the code does*; the router reads *paths*, and a path cannot say that a
   module parses untrusted input — measured on this router's own first run,
   which named `code-reviewer` and `prose-reviewer` for a diff doing exactly
   that. So a `fast-path` diff still reaches `security-scanner` when it trips a
   trigger, and no lane removes one:

   - `security-scanner` when the diff touches auth, secrets or configuration,
     input parsing, file handling, new outbound calls, dependency changes;
   - `prose-reviewer` when the diff touches a rule file, a skill, an agent spec,
     a decision record under `docs/decisions/`, `CLAUDE.md` or the README — a
     rulebook that overstates its own enforcement fails silently and in the
     direction of false confidence;
   - an infrastructure review when it touches infrastructure (the stack layer
     names the agent).

   Run them as subagents, in parallel — a fresh context reviews better than the
   session that wrote the code (see `.claude/rules/workflow.md`,
   "Review-context isolation").
5. **DoD walk.** Check the Definition of Done list in
   `.claude/rules/workflow.md` item by item — test-first evidence, nothing
   skipped or weakened, boundaries respected, docs updated, autonomy tier
   honored.
6. **Named checks only.** The merge criterion is the project's *named* required
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
