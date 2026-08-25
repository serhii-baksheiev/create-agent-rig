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

0. **Count this round before you spend on it.** Run it on the branch **under
   review** — if the PR is not checked out, do that first (step 2's warning covers
   why); on a detached checkout the command refuses rather than counting under
   `HEAD`:

   ```sh
   node .claude/scripts/queue/index.mjs gate-round --branch "$(git rev-parse --abbrev-ref HEAD)"
   ```

   **Read the exit code, not just its sign.**

   - **0** — proceed to step 1.
   - **2** — the rounds are spent. Return `HOLD` with one blocker whose `rule`
     is *gate rounds exhausted*, quoting the round count in its `note`. Do not
     run the fan-out.
   - **1** — the command itself failed (unreadable config, unreadable counter,
     detached checkout). This is **not** an exhausted cap: fix the cause and run
     step 0 again. Treating it as exhaustion escalates a healthy item.

   The cap is **2 by default**, and no shipped `.claude/queue.json` carries the key
   — the default lives in `core.mjs` as `DEFAULT_MAX_GATE_ROUNDS`. A project that
   wants a different cap sets `options.maxGateRounds` there, which in a rig whose
   `queue.json` is composed means changing what composes it, not editing the file.
   Rounds are counted per branch in `.claude/gate-rounds.json`, so the count outlives
   the session that spent them.

   ⚠ **Nothing forces this call.** No hook launches the gate, so step 0 holds
   because it is written here — the same standing as every other step. What it
   removes is the honest failure mode, a run that keeps re-reviewing because no
   check ever went red; it does not stop a session that skips it.

1. **The diff first — and the branch's own premises next.** Establish what is actually shipping: fetch, then diff
   against the **remote** default branch (`origin/<default>`), not a local
   copy that may be behind — diagnosing from stale local code produces
   confidently-wrong reviews. Everything below is scoped to this diff.

   Then, on the fetched ref, ask whether the branch is still the branch the run
   took up (AR-134):

   ```sh
   node .claude/scripts/revalidate.mjs --point BEFORE_PR --ticket <item-id> --base origin/<default>
   ```

   It compares two sources and names each one that moved: the item's `updatedAt`
   against the take-up snapshot `next` recorded (`task:updatedAt`), and what the
   default branch changed since this branch forked, on the paths the branch
   touches or a `check-premises` record in this run cited (`main:<path>`). It
   journals one `revalidation` event at `point: BEFORE_PR`; **exit code 2 is a HOLD**, with one blocker per named source: re-read the item, or the default
   branch on that path, and come back through step 0. Exit 0 with
   `unverifiable` means the task side could not be compared — no take-up
   snapshot in this run, or no marker — and is stated in the evidence, not read
   as a pass. Exit 1 is the command refusing (unknown point, no ticket, a base
   that is not a revision): fix the call. Its limits are its own header's; the
   cited-path set is a labelled assumption, not a recorded fact.
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

   🔴 **Record the set you launched, as you launch it.** The router journals the
   set it *routed*; the triggers above may only add, so what you actually
   launched is a different list and this is the only place that knows it:
   **Record the fan-out even when the launched set is empty.**

   ```sh
   node --input-type=module -e '
     const runDir = process.env.RIG_RUN_DIR;
     if (!runDir) process.exit(0);          // an undeclared run has no trace to write
     const journal = await import("./.claude/scripts/run-journal.mjs");
     try {
       console.log(journal.recordDecision({
         runDir,
         gate:      "reviewer-fan-out",
         verdict:   "launched",
         // `argv[1]` is the first argument after the script — `argv[0]` is the
         // node binary itself, and reading it here would record that path as
         // the commit and shift every reviewer along by one.
         headSha:   process.argv[1],
         reviewers: process.argv.slice(2),   // every reviewer you just started
         now:       new Date().toISOString(),
       }));
     } catch (error) {
       if (!journal.isTraceExhausted?.(error)) throw error;
       process.stderr.write(`run journal: ${error.message}\n  the fan-out above was NOT recorded.\n`);
     }
   ' "$(git rev-parse HEAD)" <reviewer> <reviewer> …
   ```

   Substitute the reviewers you actually started — the point of the record is
   that it is not derivable from the lane, so a list copied from this example
   records somebody else's fan-out. **One argument each**, unquoted — a single
   quoted string arrives as one reviewer whose name is both of theirs joined by
   a space, and `recordDecision` accepts it: it checks for a list of strings and
   nothing about what a name is.

   **Launched is not answered, and the difference is the point.** The records
   below are written per verdict that *parsed* — so a reviewer whose report came
   back `incomplete` produced no record at all, and without this one nothing
   afterwards can tell "that reviewer was never launched" from "it was launched
   and did not answer". Those need opposite responses, and the round that has to
   tell them apart is the one reading this trace after a compaction.

   🔴 **Check each reviewer's answer before you believe it.** Every gate spec
   ends in one fenced `json` block; save what each subagent returned and run

   ```sh
   node .claude/scripts/verdict.mjs check <report> <the reviewer you launched>
   ```

   on it **before** you decide anything from it. 🔴 **Name the reviewer.** You
   launched two or three of them and the check reads the report's LAST block, so
   without the name a report carrying `code-reviewer`'s `HOLD` followed by
   anything else answers about the anything else — a stop you never see. With
   the name, a block claiming another gate is refused.

   Exit 0 prints the parsed
   verdict — including for a `HOLD`, because a reviewer that *found* something
   is not a reviewer that broke. Exit 1 means the report does not end in a
   verdict this gate can act on: no block or one that is not JSON, a word no
   gate returns, a blocker naming no rule, or the case this check exists for —
   a `HOLD` with an empty `blockers` list, and its mirror, a `SHIP` carrying
   one. Where the shared vocabulary names the gate it also refuses a word that
   belongs to a different one; for a gate it does not name — a reviewer this
   project or its stack added — that one check is not made
   (`.claude/scripts/lib/verdict.mjs`, limit 1), so read such a report's word
   against the reviewer's own spec yourself.

   Such a report is **`incomplete`**: the reviewer did not answer. Read it as
   neither a pass nor a stop — relaunch that one reviewer with the shape, or
   record `incomplete` as a blocker of your own. Never read "no blockers
   parsed" as "no blockers found".

   **Then journal each verdict that parsed**, so the round's blockers outlive
   the session that read them — a gate round is counted and finite, and an
   escalation written after a compaction otherwise carries the round count and
   nothing about what was found:

   ```sh
   node --input-type=module -e '
     const runDir = process.env.RIG_RUN_DIR;
     if (!runDir) process.exit(0);          // an undeclared run has no trace to write
     // `check` prints nothing when it refuses, and a refused report is not a
     // verdict to record — parse only what it actually printed.
     if (!process.argv[1]) process.exit(0);
     const journal = await import("./.claude/scripts/run-journal.mjs");
     const v = JSON.parse(process.argv[1]);            // the block `check` printed
     try {
       console.log(journal.recordDecision({
         runDir,
         gate:     v.gate,
         verdict:  v.verdict,
         blockers: v.blockers,
         headSha:  v.headSha,       // absent when the gate named no commit
         now:      new Date().toISOString(),
       }));
     } catch (error) {
       // The split `queue/index.mjs` makes, for the reason `run-journal.mjs`
       // gives: a trace that can accept no more records is over, and the GATE
       // is not. Anything else is this call mis-declared, and stops it.
       if (!journal.isTraceExhausted?.(error)) throw error;
       process.stderr.write(`run journal: ${error.message}\n  the verdict above was NOT recorded.\n`);
     }
   ' "$(node .claude/scripts/verdict.mjs check <report> <reviewer>)"
   ```

   🔴 **The guard and the `catch` are the contract, not decoration** — an
   exhausted trace must cost this round its record and nothing else. A round is
   counted and capped, so a crash here spends one on a journal that was never
   the thing under review.
5. 🔴 **Coverage — check your own fan-out before you believe it.** You recorded
   what the route asked for, what you launched and what came back; this is the
   step that compares them, and it is the only one that does — nothing else in
   this gate would notice a reviewer that never answered:

   ```sh
   node .claude/scripts/verdict.mjs coverage "$(git rev-parse HEAD)"
   ```

   For a **declared run**, exit 0 is coverage. **Exit 1 is a `HOLD`.** A
   reason-only unreadable-round failure always prints the evidence boundary;
   remedies appear only when recovery is unambiguous. Reviewer lists cover the
   four comparable cases — never launched (launch it),
   launched and silent (go and read why), answered without naming a commit, or
   answered for another commit (the head moved under the round). Record either
   kind as a blocker of yours, in the same list as a failing check.

   Two limits, stated because a step that looks mechanical is trusted like one.
   It reads **this run's journal**, so with unset `RIG_RUN_DIR` the check is
   skipped; exit 0 is then an honest nothing, not coverage. And it cannot see a
   round that never reached this skill at all: a session that skips `pr-ship`
   skips its coverage check with it (`docs/decisions/gate-coverage.md`).
6. **DoD walk.** Check the Definition of Done list in
   `.claude/rules/workflow.md` item by item — test-first evidence, nothing
   skipped or weakened, boundaries respected, docs updated, autonomy tier
   honored.
7. **Named checks only.** The merge criterion is the project's *named* required
   checks, all green. "Some checks passed" is not a criterion; an unnamed
   green wall hides a red brick. Two traps here, both observed in the wild:
   status watchers can exit while checks are **still unregistered** — poll the
   head SHA's check runs and require each expected check *by name*; and a
   result list containing only a scanner (no build, no tests) is **not** done,
   it is a check set that has not arrived yet.

## Verdict

- `SHIP` — checks green, no blocking findings, DoD holds. Say so explicitly; a
  clean gate is a real result.
- `HOLD` — name every blocker: the failing check by name, the reviewer finding
  with its file:line, or the DoD item that does not hold. Blocking findings are
  resolved, not argued with; after fixes, the gate runs again from **step 0** —
  which counts the new round and is what makes "again" finite. Re-entering at
  step 1 skips the counter, and the unbounded rounds this gate measured are
  exactly what that produces.

Your own answer is a verdict like any other, so it ends the same way: prose for
the author, then **exactly one** fenced `json` block, and nothing after it.

```json
{
  "gate": "pr-ship",
  "verdict": "HOLD",
  "blockers": [
    { "rule": "required check `ci`", "note": "red on the head commit: 3 tests failed" },
    {
      "file": "packages/core/src/note.ts",
      "line": 42,
      "rule": "code-reviewer — checklist item 2",
      "note": "the failing case was deleted rather than fixed"
    }
  ],
  "advisories": [],
  "evidence": ["lane: model", "reviewers: code-reviewer, prose-reviewer"],
  "headSha": "9c1f0a7d4b3e2c5a8f6d0b9e7c4a1f2d3e5b6c70"
}
```

- `verdict` is `SHIP` or `HOLD` — this gate has no third answer.
- A failing check and a DoD line have no location, so `file` and `line` are
  omitted there; every blocker names the `rule` it came from either way.
- A `HOLD` with an empty `blockers` list, and a `SHIP` carrying one, are both
  answers this gate may not give. **Run the same command on your own block
  before you return it** — `node .claude/scripts/verdict.mjs check <your-block>
  pr-ship` — and fix what it refuses. Nothing downstream re-checks the gate's
  own answer, so this call is the only thing between a malformed verdict and
  whoever acts on it.
- **`headSha` is the commit you gated** — `git rev-parse HEAD`, the same one
  step 5 asked coverage about. It is what stops this verdict being read later
  as an answer about a commit that has since moved.

## Boundaries

- You never merge, push, or edit files — you gate. The merge itself stays with
  whoever holds that authority under `.claude/rules/autonomy.md`.
- One verdict per run. No "SHIP if you feel the tests are probably fine".
