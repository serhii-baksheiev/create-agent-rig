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

Per-task procedure is unchanged: (worktree if another session may run) →
`check-premises` → failing test first → implement → `pr-ship` → merge on the
named criterion → verify the deployed surface if one changed.

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

**Then, before the Red step: `check-premises`.** The item was written by someone
who was not reading the code at the time, and everything downstream — the failing
test, the implementation, the reviewer comparing diff to item — inherits its
claims rather than checking them. On `PREMISE FALSE` the item is escalated (§6),
not repaired in place: a run that silently re-aims its own task has authored work
for itself, which is the one thing this loop does not do (§8).

## 3. What keeps the loop running, and what stops it

Per-task stops (three strikes, attempt budget, invariant conflict, a blocking
reviewer verdict, a false premise in the item itself) **do not end the run**:
escalate that item (§5) and take the next one.

The run-level conditions are in `stopConditionOf` in `core.mjs`, checked in
severity order: **queue unreadable** · **runtime regression** · **kill switch** ·
**two escalations in a row** · **budget** · **nothing selectable** · **queue
empty**.

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
  pile if there is one, by cause and count: items that are out of play and wait
  on a human. They are reported next to the verdict rather than swept into it —
  they are not work this run can take, and they are not why the queue is empty.
  How that pile grows is the adapter's business and the line does not guess at
  it: on a tracker-backed adapter an escalated item and a filed proposal both
  stay open and land there. Under `plan-md` only a `[triage]` line sitting in
  the Agent queue can — a filed proposal goes to the Operator queue, where
  selection never looks, and an escalation leaves no mark on the queue at all,
  because a flat list has no per-item state. 🔴 **That last one is an absence,
  not a safety.** `plan-md`'s `escalate` writes nothing, returns `ok: false`,
  and hands back the instruction with it: move the item to the Operator queue in
  the same edit. That move is the session's, and skipping it means the next run
  takes the stuck item straight back.
- **Nothing selectable** → also a clean stop, and **not the same finding**.
  Takeable work is still there and every piece of it is **held back by a
  condition that clears without anything being written**: the elevated spacing
  (a normal item lands), a blocker (its item closes), in-progress (the other
  session finishes), a trigger (a human declares it). The stop line names how
  many and by which of those, because the two endings ask the owner for opposite
  things: an empty queue wants refilling, a held one wants interleaving or
  simply time. 🔴 **A parked cause outranks a holding one on the same item.** An
  escalated item is left claimed on purpose, so it arrives carrying
  `in-progress` as well — and reading that as held would report "another session
  will finish it" about an item no session is on, and make the empty verdict
  unreachable from the first escalation onward. Reporting a working queue as
  empty is the defect this kind exists to prevent, and reporting a parked one as
  working is the same defect reversed — **and refilling is still not this run's
  job, nor is inventing work.**

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
attempt budget, an invariant conflict, a blocking reviewer verdict, or a
`PREMISE FALSE` verdict from `check-premises` — the last one is a
`documented-stall` (§5), and its diagnosis is already written: what the item
claimed, what the code says, and the citation:

1. Comment the diagnosis on the queue item: what fails, what was tried, the
   current hypothesis, and links to the PR and the failing run where they exist
   — a premise stop has neither, and its citation stands in for both. **Name the outcome
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

Filing is the adapter's `proposeTriage`, which the CLI deliberately does **not**
expose — `index.mjs` is read-only (`next`, `list`, `hygiene`) so that no accidental
invocation can write to the queue. Call it directly:

```bash
node --input-type=module -e '
  const a = await import("./.claude/scripts/queue/plan-md.mjs");   // or github-issues / jira
  console.log(await a.proposeTriage({
    finding: "<the journal line it came from>",
    part:    "<skill | agent | hook | rule | CLAUDE.md | workflow>",
    change:  "<concretely enough to diff>",
    proof:   "<the observation that would differ next run>",
  }));
'
```

A proposal missing any of the four parts is refused rather than filed half-formed.

**All three adapters write it themselves** — `jira` and `github-issues` create a
`triage`-labelled issue, `plan-md` appends a bullet to the **Operator queue**, and
each increments an existing proposal carrying the same fingerprint rather than
filing a second. `ok: true` means it is filed: there is no "I noted it in the
summary" version of filing.

`ok: false` is the one case that still needs you, and it is a structural fault
rather than a step in the procedure: `plan-md` returns it when the plan file has
no `## Operator queue` heading, because a proposal then has nowhere to land that
the selection query cannot reach. Add the heading — never the Agent queue.

One adapter needs more than the snippet above carries: `jira` requires
`options.project` and throws rather than filing without it. It fails loudly, so
nothing is lost — but called exactly as written, it does not file.

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
| Take two elevated items back to back | One unreviewed schema/permissions change is recoverable; a chain overnight is not |
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
- **Closing:** close it with the merged PR linked, immediately after the
  post-merge verdict — not in a cleanup pass.
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
