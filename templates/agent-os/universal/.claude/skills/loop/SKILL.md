---
name: loop
description: The unattended work driver. Picks the next queue item through the queue adapter, runs it under the autonomy rules, journals at checkpoints, and ends the session on a stated stop condition — never inventing work. Use at the start of every autonomous run and between tasks.
allowed-tools: Read, Grep, Glob, Write, Edit, Bash, Task
argument-hint: [max-tasks]
---

You drive an unattended session. `.claude/rules/autonomy.md` sets the behaviour
boundaries; the **queue** holds the work; `PLAN.md` holds state, standing
decisions and the journal. This skill is the driver in between: what gets picked,
what keeps the loop going, what stops it, and where the report goes.

Per-task procedure is unchanged: (worktree if another session may run) → failing
test first → implement → `pr-ship` → merge on the named criterion → verify the
deployed surface if one changed.

## 0. The queue is behind an adapter

Selection never reads a tracker directly. It goes through
`.claude/scripts/queue/index.mjs`, which resolves the adapter named in
`.claude/queue.json`:

```bash
node .claude/scripts/queue/index.mjs next      # the item to take, and why the rest were skipped
node .claude/scripts/queue/index.mjs next --json
node .claude/scripts/queue/index.mjs hygiene   # stale labels, link anomalies
```

- **`plan-md`** (default) — the Agent queue in `PLAN.md`. The only adapter that
  works in a freshly generated project. Its limit is real and stated in the
  adapter: a flat list carries **no dependency links**, so the blocker filter is
  absent rather than satisfied.
- **`github-issues`** — the upgrade once the project has a remote. Per-item state,
  a comment thread, and dependencies written as `Blocked by #7` in the body.

🔴 **If the queue cannot be read, stop the run and say so.** Never fall back to
memory, to a stale copy, or to "what I remember was next". A remembered queue is
how a loop works items that no longer exist, and it is exactly the rot the
state-vs-queue split exists to prevent.

## 1. Preflight — once, before the first task

```bash
node .claude/scripts/preflight.mjs
```

Three items are scripted (kill switch absent · local default branch matches the
remote · the last deploy concluded successfully) and the script **prints the ones
it did not check, every time**. Paste the block into the journal: a checklist that
leaves no record cannot tell you it was skipped.

Verdicts: **STOP** → do not start, deal with the cause. **CAUTION** → start,
knowing which ground is soft. **GO** → the scripted three are clean; the rest are
still yours.

**An `unknown` never becomes a `pass`.** A probe that could not run tells you
nothing.

**First-ever run: attended and short** — one normal item, owner watching. Go
unattended only after the escalation path and the post-deploy verdict have each
been seen working at least once.

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
"window", "user demand" without a named metric — is **never self-taken**; the human
hands it over explicitly. A `trigger-auto` item needs its trigger verified *this
run*: unverified is not fired, and rationalising a trigger into firing builds for
scale that does not exist.

**The elevated tier is rationed by spacing, not by counting** — a per-run count is
meaningless when the run has no end. Never two elevated items back to back: land a
normal item on a healthy runtime in between. One unreviewed permissions or schema
change is recoverable; a chain of them compounding overnight is not.

**The tier marker is a pre-filter, not the authority.** If an item passed as normal
and the work turns out to touch an elevated path (`CLAUDE.md` →
`elevated-paths`), run the gate anyway, record the verdict on the PR, and treat it
as this run's elevated item for spacing.

## 3. What keeps the loop running, and what stops it

Per-task stops (three strikes, attempt budget, invariant conflict, a blocking
reviewer verdict) **do not end the run**: escalate that item (§5) and take the
next one.

The run-level conditions are in `stopConditionOf` in `core.mjs`, checked in
severity order: **queue unreadable** · **runtime regression** · **kill switch** ·
**two escalations in a row** · **budget** · **queue empty**.

Three of them deserve their reasons repeated:

- **Runtime regression** → deploy the revert first, diagnose second, start no new
  work on top. A regression compounds into everything built above it.
- **Two escalations in a row** → stop. If two consecutive tasks hit walls, the
  third likely will too: the wall is systemic, not task-local. This is the main
  guard against grinding a broken assumption for hours.
- **Queue empty after the filters** → **stop; do not invent work.** No refactoring
  sprees, no polish, no pre-emptive optimisation. An empty filtered queue is a
  legitimate, successful end of session; refilling it is the owner's job.
  **Expect this to be the most common ending** — the queue is finite and the loop
  drains it. That is the system working.

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

## 5. Every task carries an outcome state

The stop conditions say why the loop stopped. None of them says whether what it
produced is trustworthy, and those are different questions — a run can stop for a
perfectly good reason having produced something nobody should build on.

| State | Means |
| --- | --- |
| `clean-pass` | every stage produced its artifact from its **documented inputs**; checks green; the deployed surface healthy where one changed |
| `documented-stall` | it stopped at a real wall, and the diagnosis names **which stage needed what, and which upstream stage should have supplied it** |
| `incomplete` | it stopped and the record does not explain where or why |

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
attempt budget, an invariant conflict, or a blocking reviewer verdict:

1. Comment the diagnosis on the queue item: what fails, what was tried, the
   current hypothesis, links to the PR and the failing run. **Name the outcome
   state in the same comment** — `incomplete` if the diagnosis cannot say which
   stage needed what. Writing `incomplete` on your own task is uncomfortable and
   is the point: the run that produced it is the only witness.
2. Mark it `escalated` and leave it claimed — **not** back to a selectable state,
   or the next query picks it up and works it twice.
3. Journal it. 4. **Take the next item.** One stuck task does not end a run; two
   in a row does (§3).

**Run-scoped — the run itself is broken, and it ends.** A runtime regression, two
escalations in a row, a systemic wall, a queue-data anomaly: open an escalation
issue with the diagnosis and links, notify the owner if the harness can, and write
the journal entry. In continuous mode the notification matters more than it does
in a bounded run — nobody is watching, so a silent stop is indistinguishable from
a run still working.

## 7. The journal, and closing the loop

Write a checkpoint entry **every few completed items and at every stop**, not only
at the end: a run that dies unexpectedly must not take its history with it. The
field list is in `PLAN.md` under `## Journal`.

At every **stop** — not at a checkpoint — turn the run's findings into **at most
three** improvement proposals. **The cap is the mechanism, not a budget:** an
unbounded improvement list is another diary, and three forces a choice. Each names
four things, and a proposal missing any of them is not ready to file:

1. the finding it came from, cited as the journal line it appears on;
2. the part to change — a skill, an agent spec, a hook, a rule file, `CLAUDE.md`,
   the CI workflow;
3. the change, concretely enough to diff;
4. how the next run would prove it worked — the observation that would differ.

```bash
# proposals go to triage, never to the Agent queue
node .claude/scripts/queue/index.mjs next --json     # (the adapter's proposeTriage does the filing)
```

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
| Take items needing a human decision | It cannot unblock itself; those wait in the Operator queue |
| Take a `trigger-human` item | It would build for scale that does not exist |
| Take two elevated items back to back | One unreviewed schema/permissions change is recoverable; a chain overnight is not |
| Merge past a blocking reviewer verdict | The reviewer gate is what replaced the human merge |
| Trust a `blocked` label over the links | The label is a snapshot; the links are the dependency |
| "Improve" on an empty queue | An empty filtered queue is the end of the run, not an invitation |
| Start new work on an unhealthy runtime | The regression compounds into everything above it |
| Act on the "Never" tier | A hard stop, enforced by hooks |

## 9. State updates bracket the task, they are not a follow-up

- **Opening:** claim the item **before the first file is edited** — the same turn
  that creates the branch or worktree. Not when the PR opens. An item being worked
  while it still reads as available is invisible to the human and re-selectable by
  the very next query.
- **Closing:** close it with the merged PR linked, immediately after the
  post-merge verdict — not in a cleanup pass.

Between those two moments the item keeps absorbing what happens **as it happens** —
a decision, a deviation, a defect found in passing, a tier discovered mid-work. A
run that dies mid-task leaves its whole trail on the item; a run that batches its
comments to the end leaves nothing.

If the task changed a **fact** in `PLAN.md` — a state row, a standing decision, an
Operator-queue item it unblocked — that edit lands **in the same PR that changed
the fact**, never a docs-only follow-up.
