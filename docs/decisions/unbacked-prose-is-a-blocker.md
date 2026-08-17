# Why an unbacked behaviour claim is a blocker by rule

The rule is one paragraph in `.claude/rules/invariants.md` ("State the limits"), and
the check that catches it early is the second entry point of
`.claude/skills/check-premises`. This file is the measurement behind both. It is not
loaded into any session.

## The measurement

One PR in the generator this rulebook comes from, reviewed by two cold readers over
two gate rounds — **24 blocking findings**:

| round · reviewer | blockers | code defects | prose | process |
| --- | --- | --- | --- | --- |
| 1 · `code-reviewer` | 9 | 3 | 5 | 1 |
| 1 · `prose-reviewer` | 7 | 0 | 7 | 0 |
| 2 · `code-reviewer` | 2 | 1 | 1 | 0 |
| 2 · `prose-reviewer` | 6 | 0 | 6 | 0 |
| **total** | **24** | **4** | **19** | **1** |

Four defects in code. Nineteen findings about the run's **own prose**. One process
item (a label the run may not apply to itself).

⚠ Two limits on that table, because this file is the thing other files cite. The
split of a finding into *prose* and *code* is the authoring session's own reading;
only the blocker **counts** come from the reviewer reports. And it is one PR — a
large sample of one, in a repository whose diffs are unusually prose-heavy, because
the rulebook is the product. Read it as the reason a rule exists, not as a rate to
expect.

## What the nineteen were

Not typos, and not style. Every one was a **factual assertion about a mechanism**
that the mechanism did not support:

- **Figures quoted from a ticket rather than measured.** "5, 4, 2, 7, 8 rounds per
  item over the last five single-item runs, every check green." Checked against the
  journal: one of those numbers was two runs added together, the set was not the last
  five, and "every check was green" is contradicted by the entry supplying one of the
  figures — which also disclaims half the counts as its own sessions' rather than
  machine-recorded.
- **Enforcement claimed where none exists.** "So it is mechanical" — for a command a
  skill is *told* to call, with no hook behind it.
- **Limits written wider than the code.** A comment stating that a whole class of
  interleaved-write failure "disappears", when it had moved rather than gone; eight
  concurrent calls then lost half their increments.
- **A defence described that does not run.** A docblock promising the fastest of nine
  batched samples in a configuration that exhausted its budget at four.
- **Two rules disagreeing** about the same stop, in the same section, twenty lines
  apart.

The pattern across all of them: each was **decidable from the diff before the gate**,
and each cost a full reviewer round to discover.

## Why "by rule" rather than "by discovery"

By discovery, the cost is a round: a cold reader loads the whole diff, finds the
claim, writes it up, the author fixes it, and the gate runs again. By rule, the same
finding is a check the author runs on their own text before the gate — the machinery
already exists, because checking whether a claim about the code is true is exactly
what `check-premises` does to a queue item.

So the norm is not "write more carefully". It is: **a behaviour claim is either
generated from what it describes, or it is a pointer to the test that proves it.**
Anything else is deleted. The verdict for it is `UNMEASURED`, and rewording is not
one of its exits — softening the wording leaves an unbacked claim in a document
agents follow literally.

## Why the pointer form, specifically

`see gate-rounds.test.ts › "exits 2 — and only 2"` costs a reader one jump and buys
two things prose cannot:

- **It fails loudly.** Rename or delete that test and the citation becomes a dead
  reference — which `prose-reviewer` already blocks on. Prose just quietly becomes
  wrong, and nothing checks prose.
- **It cannot drift from the mechanism**, because the mechanism is what it points at.
  Every stale-figure finding in the table above was a sentence that stopped matching
  the code while continuing to look plausible.

## What this rule does NOT cover

- **Rationale.** "We chose X because Y" needs no test; it is an argument, not an
  assertion about behaviour. Requiring backing there would make the rule fire on
  exactly the writing this layer is made of.
- **A claim that is true but unbacked.** It is still `UNMEASURED`, and that is
  deliberate: the reader cannot tell the difference, which is the whole problem. Point
  at the test or cut the sentence.
- **Prose that merely reads badly.** `prose-reviewer` states its own boundary on
  that, and this rule does not widen it.

## The residual, stated

Nothing forces the second `check-premises` pass to run. It is a rule in the `loop`
skill and a section in a skill file — the same standing as every other written step
here, and the same standing this repository is careful to distinguish from a hook.
What it changes is the default path, not the possible ones: a run that skips it and a
run that passes it look identical afterwards, which is the honest description and the
reason the norm is also on `prose-reviewer`'s blocking checklist. The reviewer is the
backstop; the check is the cheap path.
