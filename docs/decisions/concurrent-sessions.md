# Concurrent sessions on one machine — what the Rig shares, and what is supported

⚠ **This record is not synced.** Most files in this directory are composed from
`templates/agent-os/universal/docs/decisions/` by `scripts/sync-agent-os.mjs`
and travel into every generated project — and `CLAUDE.md` rule 5 says an edit
to a synced file is lost at the next sync. This one is authored here and stays
here, like `memory-rig-boundary.md` beside it: it rules on this product's own
sessions, names tracker keys, and cites tests of the **generator** that no
generated rig receives — a citation the template layer refuses unless it says
so beside the pointer (`test/template/evidence-pointers.test.ts` › "says so
when the test it names is one a generated project never receives"), and this
record's only reader is this repository. **Edit it in place**, and cite it only from files this
repository owns (the `CLAUDE.md` addendum, the journal) — a synced rule, skill
or agent spec that named it would point every generated rulebook at a record it
does not have.

Status: accepted. Owner ruling on RP-120 (comment `17383`, 2026-09-07), which
narrowed the item to the Rig's own state; the measurements are this
repository's, taken on the Windows host under Claude Code 2.1.263 at master
`f28afae7`. The Memory publish lock and the embedded-rulebook version skew were
measured on the same item and belong to other keys — see "What is outside this
ruling".

## The question, and why it is answered once

On 2026-09-02 three Claude Code sessions ran concurrently on one machine in
three repositories, and nothing in the Rig was designed for that: every safety
mechanism assumes one loop per checkout and, in places, one loop per machine.
It worked, which is the dangerous outcome — nothing measured what was shared.
Answered per incident, the question gets a different answer each time; so it is
answered here for the three shapes concurrency takes on one machine, and the
rows below are the contract a later `doctor` (RP-21) can report against.

## The three shapes, and the ruling on each

| surface | what is shared between the sessions | how the shared part is protected | evidence | status |
| --- | --- | --- | --- | --- |
| `concurrent-sessions/cross-repository` | the kill switch `~/.claude/create-agent-rig-loop-STOP` (by design — it must stop every session on the machine) and the `~/.claude/` directory the flag files live in | each checkout's unattended flag is named by the sha256 of its own real path, so two repositories never arm one file; nothing else in the table below crosses a repository boundary | `test/template/unattended-flag.test.ts` › "scopes on/off to --root so concurrent checkout CLIs do not share a flag" | `SUPPORTED` |
| `concurrent-sessions/linked-worktree` | `.claude/queue.state.json` (the spacing ration), `.claude/gate-rounds.json` (the per-branch round counter), the kill switch, and the one `.git` object store | both files resolve to the **main** checkout on purpose (`mainCheckoutRoot`); the state file is refused when torn or mis-shaped rather than read as "nothing closed"; the counter is written through a per-pid temp file and a rename, with no lock — racing gates lose increments in the generous direction and never the file; on Windows a rename over a counter another process holds open is refused with `EPERM`, so the rename is retried within a fixed budget, and a loser past it removes its temp file and reports the code | `test/template/queue.test.ts` › "records a close made inside a worktree into the main checkout"; `test/template/queue.test.ts` › "refuses a state file holding %s"; `test/template/concurrent-sessions.test.ts` › "eight concurrent recordGateRound calls all exit 0 and leave one parseable counter between one and eight"; `test/template/gate-rounds.test.ts` › "retries the rename while another process holds the counter open, and still counts the round" | `DEGRADED` |
| `concurrent-sessions/same-directory` | the working tree, the unattended flag, the board selector `.claude/queue.board`, and — if the sessions declare the same run directory — the run journal | nothing between sessions: the second `on` replaces the first session's item and allow-list without refusal, and one `off` disarms both; `verify` detects the mismatch after the fact; two writers on one run journal are refused loudly rather than merged | `test/template/concurrent-sessions.test.ts` › "a second `on` in the same checkout replaces the first item, verify for the first item then refuses, and one `off` disarms both"; `test/template/run-journal.test.ts` › "prints the item but refuses baseline creation when the run directory holds a broken sequence" | `UNSUPPORTED` |

The rows are also declared as `EvidenceRow` literals in
`test/template/concurrent-sessions.test.ts` — the capability-contract shape
RP-36 defined (`packages/cli/src/policy/core/evidence-matrix.ts`), since no
registry of rows exists yet to append to — and validated there through
`validateEvidenceRow`. The table above is a second copy of that fact, so the two
are held in correspondence in both directions by
`test/template/concurrent-sessions.test.ts` › "the decision record tables
exactly the surfaces above with the same statuses": a surface named here that
no row carries goes red, and so does a row this table does not name. The rows
carry `harness: claude` and `os: win32` because that is what was measured; the
mechanisms are harness-neutral, and a Codex row is a separate measurement that
is not claimed.

### Cross-repository — SUPPORTED

Two sessions in two repositories share the kill switch and nothing else the Rig
writes. The switch is shared on purpose: `stop-flag.mjs` puts it under `$HOME`
precisely because a git worktree is its own project root, so a flag dropped in
one checkout would be invisible to a session running in another. Everything
else the Rig keeps is under the checkout (`.claude/`, `.rig/`, the run
directory) or keyed by the checkout's path (the unattended flag).

### Main checkout plus a linked worktree — DEGRADED, and what the condition is

The `worktree-task` skill promises working-tree isolation and delivers it: two
branches in two directories with one `.git`. What it does not say, and this
record does, is that two of the Rig's state files cross that boundary **by
design**:

- **`queue.state.json`** — the last completed tier, which rations the next
  elevated selection. A close made inside a worktree writes it into the main
  checkout, because the ration is repository-global on purpose
  (`docs/decisions/spacing-rations-mechanisms.md`): switching worktrees must
  not turn one session's mechanism close into permission for a second one.
  The write is a whole-file `writeFileSync` with no temp-and-rename; the
  reader compensates by refusing a torn, mis-shaped or out-of-vocabulary file
  instead of reading it as "nothing has closed yet", so a race here costs a
  refused selection, never a released ration. The design this replaced — a
  forgiving reader plus a whole-file writer — read an unparseable file as `{}`
  and wrote it back fresh, and that is why the counter moved to its own file
  (`test/template/gate-rounds.test.ts` › "refuses a counts file it cannot
  parse, rather than starting the count over", whose comment records it).
- **`gate-rounds.json`** — rounds per branch. Same location, same reason: the
  count must outlive the worktree the branch is gated in. `recordGateRound` is
  read-modify-write with no lock; eight concurrent calls on one counter were
  measured recording four, and the module's header accepts that as bounded
  loss in the generous direction (each lost increment buys one extra allowed
  round) rather than paying for a lock the sequential loop does not need. What
  was fixed was the crash: a fixed temp name made the losers fail with
  `ENOENT` on rename. Pinning that claim found a second crash: on the Windows
  host this ruling was measured on, eight racing callers lost one to
  `EPERM: operation not permitted, rename` in four rounds of thirty, each time
  leaving the loser's temp file behind — Windows refuses a rename over a file
  another process holds open, deterministically, for as long as the handle is
  open, and a reader's `readFileSync` is enough (RP-120, comment `17386`; on
  Linux the same probe lost increments and never a caller). So the rename is
  now retried within a fixed budget, and a loser that still cannot rename
  removes its temp file and reports the code and the file; with that, eight
  callers all exit 0 and leave one parseable counter with no temp file behind
  on both hosts (`test/template/concurrent-sessions.test.ts` › "eight concurrent
  recordGateRound calls all exit 0 and leave one parseable counter between one
  and eight"; `test/template/gate-rounds.test.ts` › "retries the rename while
  another process holds the counter open, and still counts the round" and ›
  "gives up past its budget, removes its temp file, keeps the old count, and
  names the code and the file"). A bounded retry, not a lock: the count can
  still lose an increment, and nothing waits on a holder past the budget.

**The condition under which this shape is supported:** one loop per worktree,
each on its own branch. The counter is per branch, so two sessions gating the
*same* branch from two worktrees are the same-directory case wearing two
directories — that is unsupported, below. The ration is one value for the
checkout, and a close in either place moves it for both; that is the intended
behaviour, not a race.

Two facts that a reader of this shape should know and that are already pinned:
the Stop gate measures the tree its own hook file sits in, never the cwd
(`test/template/hooks.test.ts` › "runs the checks in the project root, so a
check reading the tree sees the session project"), and a repository scan or lint run from the
main checkout no longer walks into `.claude/worktrees/` (RP-155, PR #197 and
#198 — `test/template/scan-exclusions.test.ts` › "filesBelow does not report a
file inside a nested checkout under .claude/worktrees/, and still reports its
siblings" and `test/template/lint-ignores-worktrees.test.ts` › "ignores every
path under .claude/worktrees/, so a sibling checkout is not linted as this
one").
Before RP-155 the main checkout's own `pnpm lint` failed with 397–399
typescript-eslint parsing errors per run whenever a worktree was live — measured
three times and recorded in PR #197's description — which was the worst
practical cost of this shape.

### Two sessions in one directory — UNSUPPORTED

Everything is shared and nothing arbitrates. The working tree is the reason the
`worktree-task` skill exists ("an unattended run and a hand-driven session share
a working tree and overwrite each other's edits"). Beyond it, the unattended
flag is one file per checkout path: a second session's `on` replaces the first
session's item and allow-list, so the first session runs under an allow-list it
never declared, and the second session's `off` disarms the guard for both.
`verify` refuses the mismatch when it is asked — the loop asks at claim time —
but nothing refuses the overwrite itself. The board selector `.claude/queue.board`
is one file per checkout too. And two runs that declare one run directory each read a sequence
the other advanced; the journal refuses the broken sequence rather than
repairing it — the selection still prints its item and refuses to create a
baseline on that trace (`test/template/run-journal.test.ts` › "prints the item
but refuses baseline creation when the run directory holds a broken
sequence") — so the trace is lost loudly and the work is not.

The Rig does not build a coordinator for this shape, and the item said so in
its boundary: where the honest answer is "unsupported same-repo", say so.

## What is outside this ruling, and where it lives

- **The Memory publish lock** (RP-120 mechanism 1). Measured on the same host
  and recorded on the item: `memory-sync.sh`'s five-minute stale-lock reclaim
  has no liveness check, so a live publisher slower than five minutes has its
  lock stolen by the next Stop; on this host, where the hook's per-file
  `find | sed | sort` walk is quadratic in process spawns, every publisher is
  slower than that, and 281 `bash.exe` were found alive. That is a Memory
  defect and is **RP-164**; the Rig implements nothing for it.
- **Rulebook version skew** (mechanism 4). Two rulebook generations coordinate
  on one machine today (embedded 0.5.0 in `claude-config`, this tree at its own
  version), and nothing on the Rig side measures or refuses skew. Closing the
  gap is **RP-107**; measuring skew is not in this ruling.
- **The Jira label race** (mechanism 3). The premise was false when measured
  (RP-120 comment `16685`: the adapter's `escalate` uses Jira's `update.labels`
  add, not a replacement of the array), so the mechanism was found fine and,
  by the item's own rule, gets no test here. Whether that atomic write deserves
  a pin of its own is a follow-up proposal, not this ruling.
- **Subagents sharing one working tree within a session** is **RP-68**, and
  **serialising the shared CI runner** is **RP-84**. Both are one-session or
  one-host questions; this record is about sessions.

## What this record deliberately does not claim

- It does not claim a lock-free counter is correct. It claims the loss is
  bounded, in the generous direction, and cheaper than a lock — and pins the
  bound rather than the figure.
- It does not claim the same-directory shape is detected before harm. It
  claims it is detected when asked (`verify`) and refused where refusal is
  cheap (the run journal), and is otherwise unsupported.
- It carries one harness and one operating system per row, because that is what
  was measured. The mechanisms are files the Rig owns, so the reading transfers;
  the evidence does not until it is taken.
