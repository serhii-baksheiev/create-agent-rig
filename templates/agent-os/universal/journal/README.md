# The journal

The human record of what sessions did here. **One file per month**, named
`journal/YYYY-MM.md` — the month is the filename's job, so entries themselves
stay date-free and their order carries the sequence.

**Newest-on-top inside each file.** A new entry goes directly under the month's
heading, so the file reads as a stack. Prune freely: this is operational memory,
not an archive.

**The shape of a month file**, stated because the first session of a new month
creates it and a shape nobody wrote down is one that has to be guessed:

- it **opens with a single `#` heading** naming the month;
- **every entry is a `###`** under that heading, and there is nothing at `##`
  or any other level in between;
- a new entry is inserted directly beneath the `#` heading, above the previous
  newest.

**What is mechanically checked, precisely — because this file ships into a
project and its checks do not.** The generator that produced this rig has tests
for the first two bullets and for the `YYYY-MM.md` filename; **this project has
none of them** unless you write them. That is the same arrangement
`.claude/rules/invariants.md` describes for the hooks, and the same caveat
applies: what is not tested here is convention, however firmly it is written.

The third bullet — *where* a new entry is inserted — is convention even in the
generator. Nothing checks entry order anywhere yet; making "newest" decidable
for date-free entries is its own piece of work. Do not read the presence of a
shape rule as a guarantee that a misordered file would be caught.

`README.md` is this document, not a month file. Other names: a file that does
not match `YYYY-MM.md` is never **read** as a month file — but do not read that
as permission, because in the generator any other `*.md` in this directory
**fails** the filename check. Keep archives and side notes out of this
directory, or somewhere with a non-`.md` extension.

An unattended run writes an entry at every stop **and** at checkpoints along the
way, because a run that dies unexpectedly must not take its history with it.

🔴 **This is not the run trace.** `.claude/runs/<run>/events.jsonl` and
`decisions.jsonl` are machine-readable, append-only and **oldest-first**, written
by `run-journal.mjs`. This file is the human record and is newest-on-top. They
answer different questions — the trace says what the run decided and on what
basis, this says what a reader needs to know afterwards — and reading one as the
other is how a reader concludes a run did nothing.

## The entry

The fields exist so an entry can be visibly **incomplete**. A journal with no
stated shape decays into a diary that reads fine and proves nothing.

Copy the block and drop the fields that do not apply — `unblocked` is the
exception, and it is stated even when the answer is "nothing".

```markdown
### <one-line summary of the session>

- **done** — what landed, one line each, with the PR reference
- **escalated** — what stopped, and the diagnosis: what failed, what was tried,
  the current hypothesis, and the one question whose answer unblocks it
- **reviewed** — changes that went through a reviewer gate, and what it returned
- **stopped at** — which stop condition ended the session (or "checkpoint,
  still running")
- **unblocked** — what the session's closes released
- **queue hygiene** — queue state the session found unreliable and reported
- **cost** — the counts the session actually observed
```

## The two fields that are most often got wrong

**`unblocked` is never dropped**, and it has **three** answers that do not
substitute for each other:

1. the items that were waiting, by name;
2. "nothing was waiting" — the queue carries dependency links and none pointed
   here;
3. "this queue has no dependency links" — it cannot answer at all.

A flat-list queue is **absent, not satisfied**, and writing "nothing was waiting"
there claims a look that no query could perform. A missing line and an unpaid
debt read identically from outside, which is why the empty case has to be
written to mean anything.

**`cost` carries only what the session observed** — reviewer subagents run, CI
runs consumed (re-runs included, the cheapest signal that a task fought its
tests), deploys triggered.

## Never estimated — and this governs every field, not just `cost`

**Any** field the session cannot observe stays **visibly empty, never
estimated**. A plausible number will be believed, by the next reader and by the
next run reasoning about its own budget — and the same is true of a plausible
sentence: a guessed `reviewed` or an inferred `unblocked` is the identical
failure without the digits. Leave the gap; it is information.

## Queue hygiene is reported, never corrected in passing

A stale marker, a dependency already satisfied, an item describing work already
done — record it here. Quietly fixing the metadata destroys the evidence that the
metadata is unreliable.
