---
name: loop
description: The unattended work driver. Picks the next queue item through the queue adapter, runs it under the autonomy rules, journals at checkpoints, and ends the session on a stated stop condition — never inventing work. Use at the start of every autonomous run and between tasks.
allowed-tools: Read, Grep, Glob, Write, Edit, Bash, Task
argument-hint: [max-tasks]
---

You drive an unattended session. `.claude/rules/autonomy.md` sets the behaviour
boundaries; the **queue** holds the work; the journal is `journal/YYYY-MM.md`,
one file per month, newest-on-top; `PLAN.md` holds state and standing
decisions. This skill is the driver in between: what gets picked,
what keeps the loop going, what stops it, and where the report goes.

Per-task procedure: (worktree if another session may run) → `check-premises` on the
item → failing test first → implement → **`check-premises` again, on your own prose**
→ `pr-ship` → merge on the named criterion → verify the deployed surface if one
changed.

## 0. The queue is behind an adapter

Selection never reads a tracker directly. It goes through
`.claude/scripts/queue/index.mjs`, which resolves the adapter named in
`.claude/queue.json`:

```bash
node .claude/scripts/queue/index.mjs next      # the item to take, and why the rest were skipped
node .claude/scripts/queue/index.mjs next --json
node .claude/scripts/queue/index.mjs hygiene   # stale labels, link anomalies, overtaken proposals
```

- **`plan-md`** (default) — the Agent queue in `PLAN.md`. The only adapter that
  works in a freshly generated project. Its limit is real and stated in the
  adapter: a flat list carries **no dependency links**, so the blocker filter is
  absent rather than satisfied.
- **`github-issues`** — the upgrade once the project has a remote. Per-item state,
  a comment thread, and dependencies written as `Blocked by #7` in the body.
- **`jira`** — for a team that already lives there. Native issue links, so the
  dependency needs no convention. Credentials come from the environment
  (`JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`) and never from a file in the
  repo; the project or the JQL goes in `.claude/queue.json`.

Adding a fourth is an adapter, not a rewrite: `core.mjs` holds every selection
decision and each adapter only maps its tracker's records onto the neutral shape.

🔴 **If the queue cannot be read, stop the run and say so.** Never fall back to
memory, to a stale copy, or to "what I remember was next". A remembered queue is
how a loop works items that no longer exist, and it is exactly the rot the
state-vs-queue split exists to prevent.

## 1. Preflight — once, before the first task

```bash
node .claude/scripts/preflight.mjs
```

Four items are scripted (kill switch absent · `RIG_RUN_DIR` not already
exported · local default branch matches the remote · the last deploy concluded
successfully) and the script **prints the ones it did not check, every time**. Paste the block into the journal: a checklist that
leaves no record cannot tell you it was skipped.

Verdicts: **STOP** → do not start, deal with the cause. **CAUTION** → start,
knowing which ground is soft. **GO** → the scripted four are clean; the rest are
still yours.

**An `unknown` never becomes a `pass`.** A probe that could not run tells you
nothing.

**First-ever run: attended and short** — one normal item, owner watching. Go
unattended only after the escalation path and the post-deploy verdict have each
been seen working at least once.

### Declare the run directory here, before the first selection

🔴 **This is not optional, and it is not only about the trace.** The run's
**stop conditions** live in that directory too (§3) — the escalation streak, the
deploy verdict, the budget flag. With `RIG_RUN_DIR` unset the escalation count
is recorded nowhere, silently, so an undeclared run is not a run with a missing
journal: it is a run whose main brake is off and which looks exactly like a
healthy one (`docs/decisions/run-directory.md`).

The machine trace (§7) is the other half, and its first call site is
**selection**, which runs before every task. Declared later, it misses
everything that already happened — so this goes in preflight or not at all:

```bash
export RIG_RUN_DIR="$PWD/.claude/runs/$(date +%Y%m%d-%H%M%S)"   # one per run
mkdir -p "$RIG_RUN_DIR"
```

⚠ **That export reaches the commands THIS shell runs and nothing else.** A
`PreToolUse` hook is spawned by the harness with the harness's own environment,
never with a variable the session exported — pinned in the generator's
`test/template/guard-rulebook.test.ts` (absent in a generated rig) › "only a
flag arms it — an exported RIG_UNATTENDED=1 with no flag changes nothing" —
and in some harnesses the export does not even survive to the next Bash call,
which is why every command in this skill can also take the run directory per
invocation. What a hook CAN see is a file, so the unattended signal is one:

```bash
# at claim time, from the paths the item names (repo-relative prefixes, with
# their trailing slash); the guard refuses every other rulebook edit while it is on
node .claude/scripts/unattended-flag.mjs on --item <item-id> --run-dir "$RIG_RUN_DIR" --allow <prefix> [<prefix>…]
```

`guard-rulebook` reads it (`.claude/rules/autonomy.md`, "Never"): with the flag
on, a Write/Edit/MultiEdit/NotebookEdit/`apply_patch` under `.claude/hooks/`,
`.claude/settings.json`, `.claude/queue.json`, `.claude/scripts/queue/`, the
router, the gate sweep, `.claude/rules/` or `CLAUDE.md` is refused unless its
path starts with an allowed prefix; with no flag the guard does nothing. An
item that needs a rulebook path names it here — a decision made at claim
time, never a default — and the stop step below turns the flag off. Pinned in
the generator's `test/template/guard-rulebook.test.ts` — absent in a generated
rig — › "blocks a hook-config edit with an empty allow-list, naming path, item and the rule".

⚠ **The export outlives the run's own calls.** Everything the session spawns
inherits it — and a test suite that spawns the queue CLI would write fixture
records into this run's trace (AR-139: 38 fixture selections and 22 fixture
revalidation events in one session, two tests exiting 1). So preflight refuses
to start on a `RIG_RUN_DIR` already exported. The generator's own test harness
also scrubs the variable before any test file loads — its `test/setup-env.ts`,
pinned by its `test/template/rig-run-dir-scrub.test.ts` › "holds with the
variable exported around the whole vitest process" — and **neither file ships
into a generated rig**: here, nothing scrubs it, and a rig's own test setup is
the place to do the same.

🔴 **One directory per run, never shared and never reused — and the journal
cannot enforce this for you.** A collision or an already-ended directory is
refused loudly; two runs whose records merely do not collide are merged into one
seamless trace with nothing able to say so. A fresh directory per run is the
only thing that prevents it, and it is yours to do — the exact boundary is in
`docs/decisions/run-directory.md`.

## 2. Selection — filters in order, then the sort

The queue is queried **fresh before every task**, never from a cached list: the
loop itself closes items and unblocks their dependents, so a list read at the
start of the run is wrong by the second task. Re-resolve after every close.

The filters, in order, are implemented in `.claude/scripts/queue/core.mjs` — read
them there rather than re-deriving them here. Two of them are load-bearing enough
to restate:

🔴 **Blockers resolve from links, never from labels.** A `ready`/`blocked` label is
a hand-maintained snapshot; the links are the dependency. Nothing updates a
dependent's label when its blocker lands — and in continuous mode the loop is what
landed it. A label-driven loop stalls on work it just unblocked itself, and takes
work whose blocker is still open. Both directions happen. Stale labels are
**reported as queue hygiene, never silently corrected**: quietly fixing the
metadata destroys the evidence that the metadata is unreliable.

🔴 **A missing trigger marker means unconditional, not missing data.** Work that is
genuinely conditional says so. A `trigger-human` item — a "security pass", a
"window", "user demand" without a named metric — is **never taken on that marker
alone**; the human hands it over explicitly. A `trigger-auto` item needs its
trigger verified *this run*: unverified is not fired, and rationalising a
trigger into firing builds for scale that does not exist.

⚠ **An item carrying BOTH markers is taken as `trigger-auto`.** Every adapter
resolves `auto` first, nothing refuses the combination, and no hygiene check
reports it — so one recorded declaration takes an item whose author also marked
it human-gated. The reachable path is an owner tightening an auto-gated item and
not deleting the old marker, and the silent resolution goes to the **less**
restrictive gate. Until that is fixed, treat a double-marked item as
human-gated by hand.

🔴 **An item marked for another repository is held, never taken.** A label
`owner-<name>` names the repository an item belongs to; the checkout names
itself in `options.owner` of `.claude/queue.json`, and a mismatch — or an
owned item in a checkout that declares no owner — is the holding cause `owner`,
reported by `hygiene` as `owner-mismatch`. It clears the way `trigger-human`
does: a human moves the item or re-marks it. An unmarked item is unconditional.
Two items of another product once entered this queue as normal spacers and
escalated `PREMISE FALSE` back to back — a run-level stop spent on work that
was never this checkout's (AR-132). Pinned in the generator's
`test/template/queue-owner.test.ts` — absent in a generated rig — › "holds an
item whose owner is another repository, with the cause named".

🔴 **An item's lifecycle is a label a human wrote, and the loop infers none of
it** (AR-144). Four words, read by `lifecycleOf` in `core.mjs` so every adapter
means the same thing — three of lifecycle, one of scheduling:

- `keep-core` — the problem and the responsibility are valid and the item is
  executable as written. A statement about the item, never a condition on taking
  it: a bare `keep-core` item is selected like an unmarked one.
- `re-scope` — the problem is valid but the item is **not executable
  literally**: a path, a mechanism, a boundary or an acceptance criterion has
  drifted. It is the holding cause `re-scope`, reported by `hygiene` as
  `re-scope-pending` until it clears — and it clears **only** by a human
  re-reading the code, rewriting the item and removing the label. It is a
  short-lived quarantine, not a backlog category, and never a synonym for
  obsolete, low priority or parked. The loop surfaces it and never rewrites it:
  a re-aimed item is work the agent authored (§8).
- `obsolete` — the responsibility is gone or fully superseded by a proven
  mechanism. A **human verdict, terminal**: the loop never applies it and never
  closes an item because it believes another mechanism supersedes it. Closing as
  obsolete needs external evidence and a comment naming the replacement or the
  reason — so an obsolete item is out of play (the cause `obsolete`), not held,
  and the stop line says so.
- `parked` — valid work deliberately not active now. The **scheduling** axis,
  orthogonal to the three above: `keep-core + parked` is the ordinary shape of a
  deferred item and means "still needed, not now". It is the holding cause
  **`deferred`**, freed by a human un-parking it. The cause is not spelled
  `parked` on purpose: §3 already uses that word for the **out-of-play pile** —
  items waiting on a human that no session will take — and a parked-labelled
  item is the opposite, held and takeable. So the stop line reads "held by
  deferred" for the label, and "are parked" for the pile; `obsolete` lands in
  the pile, the `parked` label never does.

The rule under all four: **nothing infers `obsolete`** — not age, not a key
range, old terminology, `parked`, absence from a roadmap, or a migration marker.
`legacy-backlog` is that marker, retired: `hygiene` reports an open item still
carrying it (`stale-legacy-backlog-label`), and two lifecycle labels on one item
(`contradictory-lifecycle-labels`) — selection meanwhile reads the most
restrictive one. Reported, never corrected: which label is wrong is the human's
call. Pinned in the generator's `test/template/queue-lifecycle.test.ts` — absent
in a generated rig — › "holds a re-scope item and says a human rewrites it" and
› "refuses an obsolete item and says a human closes it with a comment naming the
evidence".

**For a `trigger-auto` item, record the declaration** — it has to outlive the
turn it was made in, or the next selection holds the item back again:

```bash
node .claude/scripts/run-state.mjs trigger <item-id>
```

🔴 **This does nothing for a `trigger-human` item, and the command will not tell
you so.** Selection refuses that kind outright — it never consults the record —
so the only thing that makes one takeable is a human changing the item's own
marker. Recording a "declaration" against it succeeds, prints, and leaves the
item exactly as unselectable as before.

⚠ **It is keyed by the item's id — and under `plan-md` that id is the item's
POSITION in the list.** So a declaration made for the third bullet transfers to
whatever occupies the third slot after someone edits `PLAN.md`, for the rest of
the run. Re-check the item the declaration names before acting on it, or use an
adapter whose ids are stable (`github-issues`, `jira`). There is no un-fire
word: a new run starts with a clean state, which is the same remedy the budget
stop relies on.

**The elevated tier is rationed by spacing, not by counting** — a per-run count is
meaningless when the run has no end. Never two elevated items back to back **when
the first one touched a mechanism** (next paragraph): land a normal item on a
healthy runtime in between. One unreviewed permissions or schema change is
recoverable; a chain of them compounding overnight is not.

**Only a change that EXECUTES spaces the next item.** The close records
`normal` | `elevated-prose` | `elevated-mechanism`, computed from the diff's
paths (`queue/state.mjs`): an elevated change whose elevated paths are all
documents is `elevated-prose` and clears the ration, because a document cannot
compound into a broken runtime overnight. Prose keeps its tier everywhere it is
*reviewed* — model lane, cold readers, `human-review`, the gate sweep — and loses
it only here. A tier outside that vocabulary **holds**, never releases
(`docs/decisions/spacing-rations-mechanisms.md`).

**The tier marker is a pre-filter, not the authority.** If an item passed as normal
and the work turns out to touch an elevated path (`CLAUDE.md` →
`elevated-paths`), run the gate anyway, record the verdict on the PR, and treat it
as this run's elevated item for spacing.

**Selection also revalidates the item against its last take-up.** `next`
records the selected item's `updatedAt` marker in the run state (`takeUps`) and,
when the item is offered again, compares the two — against this run's take-up
when it has one, otherwise against the newest earlier run's under `.claude/runs/`
(AR-138: before that, an item taken up yesterday compared against nothing and
read as a first sight). A proposal the loop files carries its own baseline: the
`jira` and `github-issues` adapters record the filed item's marker as a take-up
in the run that filed it. The event names which it used — `baseline:
this-run | previous-run | null` — pinned in the generator's
`test/template/revalidation-baseline.test.ts` — absent in a generated rig — ›
"holds when the marker moved past the earlier run’s take-up, and names that
baseline". A marker that
moved prints a `revalidate:` line and the JSON carries `revalidation.changed:
true`: **re-read the item before acting on it**, then record what the re-read
concluded — whether the change altered the action is the evidence this exists to
collect, and the comparison alone cannot supply it:

```bash
node .claude/scripts/revalidate.mjs outcome --point SELECT --ticket <item-id> --action-changed <true | false> --note '<what changed, or why it changes nothing>'
```

It appends one `revalidation-outcome` record whose `answers` names the
revalidation it resolves, so the report can pair the two without guessing. The
note is stored verbatim from argv, so keep it in single quotes: inside double
quotes the shell expands a backtick or a `$` before the command sees it.
Nothing forces this record — a `revalidation` event with no matching outcome is
counted as `unresolved`, which is the honest word for a re-read the run skipped.

Under a declared run directory, every selection logs one `revalidation` event
`{ticket, point: SELECT, changed, source, action, task}` — the same shape the
BEFORE_PR and BEFORE_CLOSE points write. **No-change is always recorded**, one
line per selection and no sampling: the rule is explicit so the report's
`opportunities` is a count and not an estimate. An adapter with no marker
(`plan-md`) logs `changed: null`, never "unchanged". ⚠ The marker also moves on
the run's own claim and comments. The `jira` and `github-issues` adapters
re-record the take-up after each write they make — claim, comment, close,
escalate — so a move made through the adapter is not a hold (AR-140, from the
journal's RX3/RX4 entry: every BEFORE_PR catch of that run was the run's own
comment, counted by `revalidation-report.mjs`); a
comment posted by any other route — a REST call by hand, a connector — still
moves it like anyone else's, and a `true` can still be self-inflicted that way
— the re-read decides, which is why the outcome is recorded separately, and a
hold the re-read overturns is counted as a false hold with its source named.
Pinned in the generator's `test/template/self-inflicted-marker.test.ts` — absent
in a generated rig — › "%s leaves the take-up at the marker the write produced",
an `it.each` over claim, comment, close and escalate. The
four-week view is `node .claude/scripts/revalidation-report.mjs --since <date>`,
over this rig's `.claude/runs/` (or a `--runs <dir>`). The behaviour is pinned in the
generator's `test/template/queue-revalidation.test.ts` — absent in a generated
rig — › "an adapter with no marker records a blind spot, not \"unchanged\"", ›
"a moved marker holds on task:updatedAt, re-snapshots, and journals the change"
and › "the loop skill's outcome command records what the re-read concluded", and
in `test/template/revalidation-evidence.test.ts`.

**Then, before the Red step: `check-premises`.** The item was written by someone
who was not reading the code at the time, and everything downstream — the failing
test, the implementation, the reviewer comparing diff to item — inherits its
claims rather than checking them. On `PREMISE FALSE` the item is escalated (§6),
not repaired in place: a run that silently re-aims its own task has authored work
for itself, which is the one thing this loop does not do (§8).

🔴 **And again at the other end, before `pr-ship`: `check-premises` on the prose the
task itself wrote** — the rulebook prose the diff touches (the skill defines that set,
and it is the one `workflow.md` already uses for the `prose-reviewer` trigger), plus
the PR description once one exists. The verdict is `UNMEASURED`, with two exits:
delete the sentence, or make it a pointer to the test that proves it. Run it before
the gate: a reviewer reaches the same sentence only after loading the whole diff, and
that is a round spent on what an edit would have fixed.

`PREMISE FALSE` stays with the first pass. At the second one the claims are your own
and the remedy is an edit, so nothing escalates.

**Both passes end in a block, and you check it before you act on it** — the skill
returns one fenced `json` verdict like every other gate, and this loop is its caller:

```sh
node .claude/scripts/verdict.mjs check <report> check-premises
```

**`<report>` is a file you write, not one the harness leaves behind.** The
subagent's answer arrives as text in the conversation; its transcript on disk is
a JSONL file whose last fenced block does not parse, so pointing the check at it
exits 1 whatever the reviewer said. Save the whole answer to a file under the run
directory — `$RIG_RUN_DIR/check-premises.md`, one file per gate so two answers
never overwrite each other — and pass that path (`-` reads stdin instead). The
same holds for every `<report>` in this skill, as `pr-ship` already does for its
reviewers (AR-117). Pinned in the generator's `test/template/loop-report-file.test.ts`
— absent in a generated rig — › "states that the report is a file the session
writes from the subagent answer, before the first check".

Exit 1 means it did not answer: a stop verdict naming no premise, or no block at all.
That is `incomplete` — neither "the premises hold" nor a reason to escalate — so run
the pass again rather than reading the silence as a pass.

**Then journal the block that parsed**, exactly as `pr-ship` journals a reviewer's —
the paths a premise check names are what `revalidate.mjs` reads at BEFORE_PR as the
task's cited paths, and a verdict held only in context cites nothing after a
compaction:

```sh
node --input-type=module -e '
  const runDir = process.env.RIG_RUN_DIR;
  if (!runDir) process.exit(0);          // an undeclared run has no trace to write
  if (!process.argv[1]) process.exit(0); // `check` printed nothing: nothing to record
  const journal = await import("./.claude/scripts/run-journal.mjs");
  const v = JSON.parse(process.argv[1]);
  try {
    console.log(journal.recordDecision({
      runDir,
      gate:     "check-premises",
      verdict:  v.verdict,
      blockers: v.blockers,
      headSha:  v.headSha,
      now:      new Date().toISOString(),
    }));
  } catch (error) {
    // The same split pr-ship makes: an exhausted trace is over, the task is not.
    if (!journal.isTraceExhausted?.(error)) throw error;
    process.stderr.write(`run journal: ${error.message}\n  the premise verdict above was NOT recorded.\n`);
  }
' "$(node .claude/scripts/verdict.mjs check <report> check-premises)"
```

## 3. What keeps the loop running, and what stops it

Per-task stops (three strikes, attempt budget, invariant conflict, a blocking
reviewer verdict, an exhausted gate-round cap, a false premise in the item itself)
**do not end the run**: escalate that item (§6) and take the next one.

The run-level conditions are in `stopConditionOf` in `core.mjs`, checked in
severity order: **queue unreadable** · **runtime regression** · **kill switch** ·
**two escalations in a row** · **budget** · **nothing selectable** · **queue
empty**.

🔴 **Their inputs come from a file, not from your memory — and that is why they
fire at all.** `escalations` and `lastDeployVerdict` live in
`<RIG_RUN_DIR>/state.json`, written by `run-state.mjs`. A stop condition held in
a session's memory is absent exactly when it is needed, because compaction is
what a long run does (`docs/decisions/stop-conditions-in-a-file.md`).

**One of the three writes itself; two you write.** The escalation count needs
nothing from you beyond using the documented calls — but it has two writers, and
both have to be the documented one:

- it **rises** through every adapter's `escalate()` (§6), which is why
  escalating by hand-labelling the item counts nothing;
- it **resets** through the close step's `recordCompletedTier`, and **only when
  you pass it `runDir`** (§9 has the command; it is one of that call's
  load-bearing arguments, not an optional extra). Omit it and the count is
  monotonic: two escalations an hour apart end the run however many tasks
  landed in between.

The other two are yours, after the checks that produce them:

```bash
# the post-deploy check answers in a block like every other gate, and the word
# below is retyped out of it — so check the block before you trust the word
node .claude/scripts/verdict.mjs check <report> post-deploy-verify

# after the post-deploy check (`.claude/rules/autonomy.md`, "Post-deploy
# verification") — REGRESSION stops the next selection, HEALTHY clears it
node .claude/scripts/run-state.mjs deploy REGRESSION

# when the declared budget (§4) cannot fit another task
node .claude/scripts/run-state.mjs budget exhausted
```

Both **refuse** a word outside their vocabulary and refuse to run with no
`RIG_RUN_DIR`, rather than writing something the stop conditions cannot match: a
file that looks recorded and stops nothing is worse than no file.

**Only the deploy verdict can be taken back**, and the asymmetry is deliberate:
`HEALTHY` names a real later event — the revert landed — while un-exhausting a
budget would name only a decision taken by the run that declared the stop
(`docs/decisions/stop-conditions-in-a-file.md`). A new run gets a clean state;
that is the way back from both.

Selection itself — `node .claude/scripts/queue/index.mjs next`, §0 — is what
*reads* these and stops on them. It is still the command you run to get work.

⚠ **The kill switch is not among them.** It stays mechanical in `guard-bash`
and scripted in preflight; `next` does not check for the flag, so **keep
checking it between tasks** — the brake block later in this section says how.

Four of them deserve their reasons repeated:

- **Runtime regression** → deploy the revert first, diagnose second, start no new
  work on top. A regression compounds into everything built above it.
- **Two escalations in a row** → stop. If two consecutive tasks hit walls, the
  third likely will too: the wall is systemic, not task-local. This is the main
  guard against grinding a broken assumption for hours.
- **Queue empty after the filters** → **stop; do not invent work.** No refactoring
  sprees, no polish, no pre-emptive optimisation. An empty filtered queue is a
  legitimate, successful end of session; refilling it is the owner's job.
  **Expect this to be the most common ending** — the queue is finite and the loop
  drains it. That is the system working. The stop line also names the **parked**
  pile if there is one, by cause and count: items out of play, waiting on a
  human. They are reported next to the verdict, never swept into it. 🔴 Under
  `plan-md` an escalation leaves no mark on the queue at all — `escalate`
  returns `ok: false` with the instruction to move the item to the Operator
  queue **in the same edit**, and skipping that move means the next run takes
  the stuck item straight back.
- **Nothing selectable** → also a clean stop, and **not the same finding**.
  Takeable work is still there and every piece of it is **held back by a
  condition that clears when something else happens, not by refilling the
  queue**: the elevated spacing (a normal or prose-only item lands), a blocker (its item
  closes), in-progress (the other session finishes), a trigger (a human
  declares it — and for a `trigger-auto` item that declaration is **written**,
  §2, so this is the one hold that needs a command rather than only time), and
  an owner (§2: the item is another repository's, and a human moves it or
  re-marks it — neither time nor interleaving frees it). The
  stop line names how many and by which, because the two endings ask the owner
  for opposite things: an empty queue wants refilling, a held one wants
  interleaving, time, or — for a trigger or an owner — a human act the line
  names. 🔴 **A parked cause outranks a holding one on the
  same item** — an escalated item is left claimed on purpose, so it arrives
  carrying `in-progress` too. **Neither ending is an invitation to refill the
  queue or invent work.** Why the two are split, and how the parked pile grows
  per adapter: `docs/decisions/two-empty-endings.md`.

🔴 **The kill switch is a real file, not an intention:**

```bash
touch ~/.claude/__PROJECT_NAME__-loop-STOP     # brake on
rm    ~/.claude/__PROJECT_NAME__-loop-STOP     # brake off
```

While it exists, `guard-bash.mjs` **denies the merge at the tool layer**, so
nothing lands even if this file is never read. Everything else stays allowed on
purpose: finish the current task, push the branch, open the PR, write the journal,
stop. Losing in-flight work is not what stopping cleanly means. Check for the flag
between tasks rather than waiting to be denied.

## 4. Budget — a rate, not a task count

There is no "max N tasks" ceiling by default; the bound is **cost per run or per
rolling day**, declared at the start. Meter it **before** picking the next task,
not after. If the remaining allowance cannot plausibly fit the next task's size,
stop now rather than starting something that will be abandoned half-done.

The journal's `cost` block carries only what the session **observes**: reviewer
subagents run, CI runs consumed (re-runs included — the cheapest signal that a task
fought its tests), deploys triggered.

⚠ **There is deliberately no token or currency column.** The harness does not
reliably expose per-subagent accounting to the agent, and a plausible number in a
cost column **will be believed** — by the next reader, and by the next run
reasoning about its own budget. A field the loop cannot observe stays **visibly
empty, never estimated.**

**Where the budget lives, and what is honest about it.** The **decision** is
recorded, not the arithmetic:

```bash
node .claude/scripts/run-state.mjs budget exhausted
```

That sets the flag `stopConditionOf` reads, so the next selection stops with
`queue: budget` — and it survives a compaction, which is the whole reason it is
a file. **Nothing computes it for you**: the counters above are the ones the
session observes, and judging that the remaining allowance cannot fit another
task stays yours. There is deliberately no field holding a spend figure, for the
same reason the journal has no currency column — a number the run cannot
observe, written where a stop condition reads, is a fiction with authority.

## 5. Every task carries an outcome state

The stop conditions say why the loop stopped. None of them says whether what it
produced is trustworthy, and those are different questions — a run can stop for a
perfectly good reason having produced something nobody should build on.

| State | Means |
| --- | --- |
| `clean-pass` | every stage produced its artifact from its **documented inputs**; checks green; the deployed surface healthy where one changed |
| `documented-stall` | it stopped at a real wall, and the diagnosis names **which stage needed what, and which upstream stage should have supplied it** |
| `incomplete` | it stopped and the record does not explain where or why |

🔴 **What `documented-stall` requires is the STAGE and the wall, not a full
inventory of findings** — and this had to be settled, because the two readings
disagreed the first time a stop arrived without an inventory. An exhausted
gate-round cap names its stage (the gate) and its wall (the branch's rounds are
spent — the count, not a verdict on whether the fixes were converging, which the
counter never measured; AR-115), while the individual blockers behind it are not persisted anywhere until
per-round verdicts exist. That is a `documented-stall`: the record locates the wall
and the next reader knows where to look.

`incomplete` is for a record that cannot say **where** it stopped — not for one that
can say where but not everything about it. Widening `incomplete` to cover a thin
diagnosis would make it the common case, and it is meant to be the rare one: it is
the only failing state, and a state that fires on honest stops stops being read.

🔴 **`documented-stall` is a success, and reading it as a failure is how this stops
working.** A stall that names its under-supply is the most useful thing an
unattended run produces: it converts a vague gap into a located, fixable defect.
`incomplete` is the only failing state — and it fails on the **record**, not the
outcome. A task that shipped nothing but explained exactly where it hit the wall
did better work than one that shipped something nobody can retrace.

### 5.1 The no-hand-feeding rule

> **When a stage asks for context an earlier stage should have supplied, do not
> answer it with new facts.** Record what it needed and which stage should have
> carried it, then either continue from the documented inputs plus a **labelled
> assumption**, or stop. **The stall is the finding.**

An unattended run is structurally biased the other way: a later stage asks for
something nobody supplied, the driver answers from its own head because it happens
to know, and the line keeps moving. The output looks clean and is fiction —
assembled from context no documented input contains and no reader can retrace.

Two corollaries, because they are the ones rationalised away mid-run:

- **A stage that finishes without producing its named artifact is an under-supply
  finding, not a retry.** Never rerun it until the output looks clean — that is
  re-running CI until it goes green, one level up.
- **"I already know this" is the signal, not the exemption.** The question is not
  whether the fact is true; it is whether the pipeline supplied it. A true fact
  injected by hand still leaves the next run starving in the same place.

⚠ **Known limit, documented rather than trusted:** both halves rely on the run
reporting on itself, and hand-feeding is ordinary helpful completion rather than a
deliberate act a model catches itself performing. A stated rule still shifts
behaviour and costs nothing per run — but it is precisely why the one status that
mechanises fully (`missed`, `.claude/rules/autonomy.md`) needs no self-report.

## 6. Escalation — two channels, by scope

**Task-scoped — the item is the home, and the loop continues.** Three strikes, the
attempt budget, an invariant conflict, a blocking reviewer verdict, an **exhausted
gate-round cap**, or a `PREMISE FALSE` verdict from `check-premises` **on the queue
item**. The last two are
a `documented-stall` (§5) and their diagnoses differ, so take the one that matches the
stop: a false premise writes what the item claimed, what the code says, and the
citation; an exhausted cap writes the round count and what the last gate reported.
Both then follow the same three steps:

1. Comment the diagnosis on the queue item, in the shape
   `.claude/rules/autonomy.md` ("Escalation format") sets — **cite it rather
   than working from this list**, which is a reminder and is short by two of
   its clauses: what was *observed* (verbatim errors, not summaries), and the
   single question whose answer unblocks the work. So: what fails, what was tried, the
   current hypothesis, and links to the PR and the failing run where they exist
   — a premise stop has neither, and its citation stands in for both. **Name the outcome
   state in the same comment** — `incomplete` if the diagnosis cannot say **where** it
   stopped (§5: a thin diagnosis that still locates the wall is a `documented-stall`).
   Writing `incomplete` on your own task is uncomfortable and
   is the point: the run that produced it is the only witness.
2. Mark it `escalated` and leave it claimed — **not** back to a selectable state,
   or the next query picks it up and works it twice.
3. Journal it. 4. **Take the next item.** One stuck task does not end a run; two
   in a row does (§3).

🔴 **The gate-round cap is the stop a run will not reach on its own.** Every other
stop here has a red thing behind it; a gate that keeps finding fixable prose is all
green, so three strikes never fires and the run has no reason to stop re-entering it.
`pr-ship` step 0 counts the round per branch in `.claude/gate-rounds.json` and exits 2
past the cap. The count outlives the session, which is the point — a counter held in
context is one the next context does not have.

⚠ **What the cap does not carry, stated because the gap decides what you can write in
the escalation:** the counter records the round and nothing about it. Findings travel
separately, and the two do not cover the same ground — the count is **per branch, in
the main checkout, across runs**, while a verdict is journalled into **this run's**
directory. So `decisions.jsonl` holds the rounds this run spent and nothing about a
round spent before it: a branch on its third round in its second run has one round's
findings here, and the earlier ones in whichever directory that run declared, or
nowhere if it declared none.

Write the diagnosis from what you can actually read — the round count, plus this run's
records where there are any — and say which of the rounds that leaves unaccounted for
rather than reconstructing them from memory. `pr-ship` is told to journal each verdict
that parsed, and like every gate here that is a step in a skill rather than a
mechanism: a round whose session skipped it left no record either.

🔴 **Escalate through the adapter, never by hand-labelling the item.** Every
adapter's `escalate()` counts the escalation into the run state as it marks the
item, which is what makes "two in a row" a condition the next selection can
check rather than one you have to remember across a compaction. Adding the
label yourself marks the item and counts nothing — and the run then grinds past
the wall this rule exists to stop it at. (`plan-md` still returns `ok: false`,
because a flat list has no per-item state to mark; the count is recorded all the
same, and moving the item to the Operator queue is still yours.)

**Run-scoped — the run itself is broken, and it ends.** A runtime regression, two
escalations in a row, a systemic wall, a queue-data anomaly: open an escalation
issue with the diagnosis and links, notify the owner if the harness can, and write
the journal entry. In continuous mode the notification matters more than it does
in a bounded run — nobody is watching, so a silent stop is indistinguishable from
a run still working.

## 7. The journal, and closing the loop

Write a checkpoint entry **every few completed items and at every stop**, not only
at the end: a run that dies unexpectedly must not take its history with it. The
entry goes at the TOP of `journal/YYYY-MM.md` — this month's file, newest-on-top
— and the field list is in `journal/README.md` next to it.

**Behind that entry there is a machine trace, and it is a different artifact.**
`.claude/scripts/run-journal.mjs` writes gate verdicts to `decisions.jsonl` and
everything else to `events.jsonl`, both append-only, inside the run directory
declared in §1. Five things about it are worth knowing before relying on it:

- **The run declares the directory; nothing invents one.** With `RIG_RUN_DIR`
  unset, every call site stays silent — the *trace* is opt-in, and a run that
  never declared one has no journal rather than a journal in a guessed place.
  🔴 **The stop conditions in the same directory are not opt-in** (§1): an
  undeclared run also stops counting escalations, and that half is silent too.
  Read "opt-in" as describing this file, never the declaration.
- **It answers *what the run decided and on what basis*, never *was that
  right*.** It replaces neither the month file above nor `PLAN.md`; it is the
  evidence a reader checks those against. It is also **oldest-first**, where the
  month file is newest-on-top — reading one as the other is how a reader
  concludes a run did nothing.
- **A record after the run-end marker is refused, and a broken sequence is
  refused on both write and read.** The order is asserted rather than described,
  so a stale record cannot read as the current one — which is the whole failure a
  journal exists to prevent.
- ⚠ **The trace can stop before the run does, and the two failures part ways
  here.** A journal that can no longer accept records — a sequence already
  broken, a file that will not parse, a run already marked ended — is a lost
  trace, **not** a reason to withhold work the queue can still hand out: the
  selection prints, stderr carries a `run journal:` line, the exit code stays 0.
  The refusals are the ones where nothing has happened yet and a second fixes
  it, and there are **four**: the declaration is empty, its directory does not
  exist, the path is not a directory, or the journal module is missing. Each
  exits 1 with nothing on stdout.
- 🔴 A `run journal:` line on stderr is **not** the queue failing. That one is
  `queue: queue-unreadable` on stdout (§0) and it ends the run; this one does
  not.

**The marker is written by the stop, and the stop is a step in this skill.** A
journal whose end nobody writes leaves every run reading as still-running, which
is exactly the ambiguity the marker exists to remove.

🔴 **At a stop — never at a checkpoint — and after the proposals below, not
before them.** The marker closes the journal to further records, so a run that
writes it mid-way keeps working while every later record is refused: a trace
truncated quietly, which is worse than one that stops loudly. It is the last
thing the run does, in document order and in wall-clock order both:

```bash
node --input-type=module -e '
  const { endRun } = await import("./.claude/scripts/run-journal.mjs");
  console.log(endRun({
    runDir: process.env.RIG_RUN_DIR,
    stop:   "<the stop condition from §3: queue-empty | budget | kill-switch | …>",
    now:    new Date().toISOString(),
  }));
'
```

If no run directory was declared, there is nothing to close and this step is
skipped — say so in the journal entry rather than leaving the reader to guess
which of the two happened.

**And turn the unattended flag off** — it outlives the run otherwise, and the
next attended session would find its rulebook edits refused in the name of an
item nobody is working:

```bash
node .claude/scripts/unattended-flag.mjs off
```

At every **stop** — not at a checkpoint — turn the run's findings into **at most
three** improvement proposals. **The cap is the mechanism, not a budget:** an
unbounded improvement list is another diary, and three forces a choice. Each names
four things, and a proposal missing any of them is not ready to file:

1. the finding it came from, cited as the journal line it appears on;
2. the part to change — a skill, an agent spec, a hook, a rule file, `CLAUDE.md`,
   the CI workflow;
3. the change, concretely enough to diff;
4. how the next run would prove it worked — the observation that would differ.

Filing is the adapter's `proposeTriage`, which the CLI deliberately does **not**
expose — `index.mjs` never writes to the QUEUE (`next`, `list`, `hygiene` only), so
that no accidental invocation can change what the next run is handed. Its one
write is to the run journal above, and only into a directory the run declared —
a trace of the selection, never a change to it. Call `proposeTriage` directly:

```bash
node --input-type=module -e '
  const a = await import("./.claude/scripts/queue/plan-md.mjs");   // or github-issues / jira
  console.log(await a.proposeTriage({
    finding: "<the journal line it came from>",
    part:    "<skill | agent | hook | rule | CLAUDE.md | workflow>",
    change:  "<concretely enough to diff>",
    proof:   "<the observation that would differ next run>",
    // a pair: what the probe touched, and what is concluded from it. The
    // mechanism accepts a proposal without them; this procedure does not.
    measured: "<the paths the probe actually exercised>",
    inferred: "<the conclusion, citing only surfaces named in measured>",
  }, { project: "<KEY>" }));   // jira only — the project key from .claude/queue.json;
                               // plan-md and github-issues take no second argument
'
```

A proposal missing any of the four parts is refused rather than filed half-formed.

**A finding can say what it measured and what it inferred, as two paired fields**
(AR-142). A proposal whose premise was never true had no check at filing, only at
take-up — AR-124 was filed, promoted and claimed before its platform conclusion
was traced to a probe that had touched one hook. So `measured` and `inferred`
are separate, and `validateProposal` refuses an `inferred` that cites a path
`measured` does not, naming both fields and the path; one field without the
other is refused too, and neither files as before. The surface is a cited path
(`citedPathsOf`), so a conclusion that names no path passes this check — it
catches the path-shaped overreach and nothing subtler.

⚠ **The pair is how a proposal opts into the check, and a proposal filed without
it is not checked at all** — `validateProposal` keeps the four-part contract, so
the AR-124 shape with neither field still files as it always did. That is the
stated limit, not an oversight: making the fields mandatory would refuse every
proposal the three adapters already file, and the loop is the author this rule
is for. So **every proposal this loop files carries both fields** — the snippet
above supplies them, and a stop that cannot say what it measured has nothing
to propose. A reviewer reading a filed proposal without the pair reads a
proposal that skipped this procedure. Pinned in the generator's
`test/template/queue.test.ts` — absent in a generated rig — › "refuses a
proposal whose inference names a surface its measurement did not touch", ›
"files a proposal whose inference stays inside what it measured", › "refuses one
of the two fields without the other" and › "a proposal with neither field files
as today".

**The filed item also records the commit it was measured against** — an `asOf:`
line, HEAD of this checkout unless the call passes its own `asOf` (`null` files
without one). It is there for `hygiene`, which lists the proposals on file and
reports one whose cited paths changed since its `asOf` as
`proposal-possibly-overtaken`, one with no `asOf` as `proposal-asof-missing`, and
one git cannot diff from as `proposal-asof-unanswerable` — never as clean. Two
proposals in a row once escalated `PREMISE FALSE` because the merge that
falsified each landed after it was filed, and selection hands out the oldest
first (AR-116). The behaviour is pinned in the generator's
`test/template/proposal-asof.test.ts` — absent in a generated rig — ›
"names the overtaken one, the unanswerable one, and stays silent on the current one".

**All three adapters write it themselves** — `jira` and `github-issues` create a
`triage`-labelled issue, `plan-md` appends a bullet to the **Operator queue**, and
each increments an existing proposal carrying the same fingerprint rather than
filing a second. `ok: true` means it is filed: there is no "I noted it in the
summary" version of filing.

`ok: false` is the one case that still needs you, and it is a structural fault
rather than a step in the procedure: `plan-md` returns it when the plan file has
no `## Operator queue` heading, because a proposal then has nowhere to land that
the selection query cannot reach. Add the heading — never the Agent queue.

One adapter needs the second argument the snippet above carries: `jira` requires
`options.project` and throws rather than filing without it — loudly, so nothing
is lost, but a call that drops it files nothing (AR-117).

🔴 **The loop proposes; the owner patches.** Self-applying a change to its own
rulebook is how an unattended run drifts irreversibly, and it collides head-on
with the rule that the agent authors no work for itself.

🔴 **Proposals land in `triage`, never in the queue the loop selects from.** A
triage item is unselectable twice over — no ready marker, and `triage` is excluded
outright. **Deduplicate by fingerprint:** twenty "queue empty" stops must produce
one proposal with a count of twenty, not twenty proposals. **A stop with nothing
worth proposing files nothing** — zero is a legitimate number, and padding to
three poisons the only channel by which this project learns.

## 8. What the loop does NOT do

| Does not | Why |
| --- | --- |
| **Create its own work items** | The queue is human-filled. Self-authored work drifts scope, and unattended it drifts unwatched |
| **Re-aim an item whose premise turned out false** | Same rule wearing a disguise: an item silently rewritten into "what it should have said" is a work item the agent authored. Escalate it (§6) |
| Take items needing a human decision | It cannot unblock itself; those wait in the Operator queue |
| Take a `trigger-human` item | It would build for scale that does not exist |
| Take two mechanism-touching elevated items back to back | One unreviewed schema/permissions change is recoverable; a chain overnight is not (a prose-only elevated close clears it) |
| Merge past a blocking reviewer verdict | The reviewer gate is what replaced the human merge |
| Trust a `blocked` label over the links | The label is a snapshot; the links are the dependency |
| "Improve" on a queue that hands out nothing | Whether it stopped as empty or as held back, a run with no item is at its end, not at an invitation |
| Start new work on an unhealthy runtime | The regression compounds into everything above it |
| Act on the "Never" tier | A hard stop, enforced by hooks |

## 9. State updates bracket the task, they are not a follow-up

- **Opening:** claim the item **before the first file is edited** — the same turn
  that creates the branch or worktree. Not when the PR opens. An item being worked
  while it still reads as available is invisible to the human and re-selectable by
  the very next query.
- **Closing:** first ask whether the item is still the item you took up — a
  late comment or a status somebody else moved is not published as `Done`
  underneath it (AR-135):

  ```bash
  node .claude/scripts/revalidate.mjs --point BEFORE_CLOSE --ticket <item-id>
  ```

  It compares the item's marker against the newer of this run's last
  validation and its take-up — an adapter re-records the take-up after each
  write of its own (§2, AR-140), so a comment posted after BEFORE_PR does not
  hold the close; pinned in the generator's
  `test/template/self-inflicted-marker.test.ts` › "continues when the run’s own
  write moved the marker after the last validation" — and its
  state against the `in-progress` a close expects, journals one `revalidation`
  event at `point: BEFORE_CLOSE`, and lists the item's dependants with each
  one's state re-read for the write-back below — pinned in the generator's
  `test/template/revalidate.test.ts` (absent in a generated rig) › "appends
  exactly one BEFORE_CLOSE revalidation event after the BEFORE_PR one, and does
  not end the run", › "runs the BEFORE_CLOSE revalidation before the close call
  and reads a hold as a stop" and › "re-reads each dependant's state, and names
  one the tracker no longer offers". On a `github-issues` queue that list is
  empty: a single `gh issue view` carries no cross-index, so `find` answers no
  `blocks` there (`test/template/close-transitioned.test.ts` › "github asks `gh
  issue view` with the full field list and maps CLOSED to closed"). A
  hold (exit 2) stops the close: re-read the item, record the outcome with
  `node .claude/scripts/revalidate.mjs outcome --point BEFORE_CLOSE --ticket
  <item-id> --action-changed <true | false> --note '…'`, and close only if the
  re-read leaves the action standing. Then call the
  adapter's `close(ticket, { prUrl, transitionId })` with the merged PR linked,
  immediately after the post-merge verdict — not in a cleanup pass — and read
  its answer: `ok: true` says the call ran, and only `transitioned` set to
  `true` says the close landed, because every adapter reads the item back after
  the transition — `jira` the status category after the POST, `github-issues`
  `gh issue view --json state`, `plan-md` the line being there and then gone
  (the generator's `test/template/close-transitioned.test.ts` › "GETs the issue
  status after the transition POST and reports transitioned: true when the
  category is done", › "runs `issue view <id> --json state` after `issue close`
  and reports transitioned: true on CLOSED", › "reports transitioned: true once
  the item's line is gone"). A close whose result says `transitioned: false` is
  not a close: report it, and leave the item as the adapter left it — `jira` its
  status, `github-issues` its `in-progress` label, which comes off only after a
  read-back that says CLOSED (› "leaves the in-progress label on an issue whose
  close did not land"), `plan-md` nothing, because the line was never there. The
  tier below is recorded only for a close that transitioned; a close that did
  not is not the "something landed" the escalation streak resets on. **Record
  the tier in the same step**, because the next selection rations on it:

  ```bash
  node --input-type=module -e '
    const { recordCompletedTier } = await import("./.claude/scripts/queue/state.mjs");
    const { withoutGitLocation } = await import("./.claude/scripts/git-env.mjs");
    const { execFileSync } = await import("node:child_process");
    const merge = "<merge-sha>";
    // The merge commit against its first parent: what the PR actually added.
    const changedFiles = execFileSync(
      "git", ["diff", "--name-only", "-z", `${merge}^1`, merge],
      { encoding: "utf8", env: withoutGitLocation() },
    ).split("\0").filter(Boolean);
    console.log(recordCompletedTier({
      changedFiles,
      projectRoot: process.cwd(),
      runDir: process.env.RIG_RUN_DIR,
    }));
  '
  ```

  Five details in that command are load-bearing — copy it, do not re-derive it:

  - **`runDir`**, or the escalation streak (§3) never resets;
  - **`<merge-sha>^1 <merge-sha>`**, never `origin/<default>...<merge-sha>`;
  - **`-z`, and split on `\0`**, or a quoted path records the wrong tier;
  - **`execFileSync` with an argument array**, never a shell string;
  - **`env: withoutGitLocation()`**, or under a git hook it diffs another repo.

  🔴 One of them — `-z` — fails **silently and permissively**: it records
  `normal` for an elevated change rather than refusing. The wrong diff form
  refuses loudly, and omitting `runDir` fails quietly toward a stop nobody can
  clear. Which fails which way, measured rather than assumed, is in
  `docs/decisions/closing-a-task.md`.

  🔴 **The tier comes from the diff, never from the item's marker.** The marker
  is a pre-filter (§2); `autonomy.md` decides the tier by what the change
  *touches*, and rationing on the marker would mean one written a tier low
  silently buys a second elevated item in a row. A marker that disagrees with
  the paths is queue hygiene to report, not the value to ration on.

  It **refuses** rather than guessing when the file list is empty or missing:
  an absence is not a normal-tier change, and the permissive answer written
  confidently is exactly how this seam went unnoticed in the first place. If it
  refuses, find the file list — do not pass one to make it quiet.
- **Write-back:** with the close, record what it **unblocked** — the items that
  were waiting on this one, by name. It is the journal's `unblocked` field, and
  it is **required, not a step for when it applies**: an absent line and an
  unpaid debt are the same observation from outside, so the empty case has to
  be written to mean anything. Which empty case matters — "nothing was waiting"
  is an answer, "this queue has no dependency links" is the absence of one
  (§0), and a queue that cannot be asked must never be reported as asked.

  🔴 It is a **report, not an edit to those items.** Blocked state is
  re-resolved from the blocker itself on every selection (§2), so nothing is
  stuck waiting to be corrected — and a label fixed by hand is evidence
  destroyed, which §2 forbids by name. What the write-back buys is the thing no
  query can answer: whether anyone **looked**. Where the close changed a fact
  rather than a state — an Operator-queue item it settles — the paragraph
  closing this section applies instead, and that edit lands in the same PR.

Between the opening and the close the item keeps absorbing what happens **as it happens** —
a decision, a deviation, a defect found in passing, a tier discovered mid-work. A
run that dies mid-task leaves its whole trail on the item; a run that batches its
comments to the end leaves nothing.

If the task changed a **fact** in `PLAN.md` — a state row, a standing decision, an
Operator-queue item it unblocked — that edit lands **in the same PR that changed
the fact**, never a docs-only follow-up.
