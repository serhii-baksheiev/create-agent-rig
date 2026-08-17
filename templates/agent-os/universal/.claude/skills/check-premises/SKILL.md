---
name: check-premises
description: Check a queue item's claims about the code before building on them. Use immediately after taking an item and before the failing test — whenever the item asserts that something exists, is missing, is broken, or works a particular way.
context: fork
allowed-tools: Read, Grep, Glob, Bash
argument-hint: <the queue item's text>
---

A queue item is a **claim about the code**, written by someone who was not
reading the code at the time. "The retry path swallows the error", "there is no
validation on that field", "the worker never gets the second message" — each of
those is a premise, and the work that follows is only worth doing if it is true.

This skill checks the premises. It writes nothing, and it has **two entry points**.

| entry point | the claims are | the code is | verdicts |
| --- | --- | --- | --- |
| after selection, **before the Red step** | the queue item's, about code it did not read | the repository | `PREMISES HOLD` / `PREMISE FALSE` / `UNVERIFIABLE` |
| after the work, **before the gate** | your own, in the PR description and any rulebook prose you touched | your diff | the same, plus `UNMEASURED` |

🔴 **Why the second one exists.** On the PR that produced it, the run's own prose
about mechanisms was the largest class of blocking finding — every one decidable from
the diff before the gate ran, and every one costing a reviewer round to discover
(`docs/decisions/unbacked-prose-is-a-blocker.md` has the counts and what they were).
Same machinery, same question — *is this claim true?* — pointed at the text the run
wrote instead of the text it was handed.

The rest of this skill is written for the first entry point. The second one runs the
same four steps with the diff as the code, and §4 carries what is different.

## Why it sits here and not in review

A false premise is not caught later. Review reads the diff against the item, and
both are wrong in the same direction: the item said the validation was missing,
the diff adds validation, the reviewer sees a diff that does what the item asked.
Nobody re-reads the file that had the validation all along. The cost lands as a
duplicate implementation, a "fix" for a bug that was somewhere else entirely, or
a refactor of a path that no caller reaches — all of it green, reviewed, merged.

The check is cheap because it is narrow, and the next section is that narrowness.

## 1. Write out the claims — as claims

List what the item asserts about the code as it exists **now**. Two to five
lines. Keep them in the item's own terms; do not repair them while transcribing
— a claim you have already improved is one you will not test.

Separate the claims from the request. "Add a `GET /notes/:id` route" asserts
nothing; "the route handler bypasses the usecase layer" does.

An item that asserts nothing is done here: verdict `PREMISES HOLD`, one line
saying there were none. That is a common and perfectly good outcome.

## 2. Mark the load-bearing ones

🔴 **A claim is load-bearing when its falsity changes what gets built.** Only
those get verified. **This is not an audit** of the item, the file, or the
codebase — the moment it becomes one, it stops being cheap, gets skipped under
time pressure, and the whole step is lost.

| Load-bearing | Not |
| --- | --- |
| "there is no X" — if X exists, the task is already done | a stale line number in the item's description |
| "X is called from Y" — if it is not, the fix goes in the wrong place | a misspelled symbol you can resolve at a glance |
| "X handles the empty case by Z" — the fix is designed against Z | a claim about a file this task will not touch |
| "nothing enforces X" — the whole task is the enforcement | a claim the task's own failing test would immediately expose |

That last row is the one worth internalising: a premise the Red step would
falsify in the next five minutes does not need checking here. This step exists
for the premises a passing test **would not** catch — the ones about code the
task never touches.

## 3. Verify each, against the code, with a citation

Read the code. Not the tests, not the docs, not another queue item — those are
claims too. Each verified premise gets a `file:line` citation; a premise you
believe but cannot cite is not verified, it is remembered.

## 4. The verdict

| Verdict | When | What happens next |
| --- | --- | --- |
| `PREMISES HOLD` | every load-bearing claim checked out, or there were none | proceed to the Red step |
| `PREMISE FALSE` | a load-bearing claim is contradicted by the code | **stop and report** |
| `UNVERIFIABLE` | a load-bearing claim could not be decided from the code | report it as unverifiable, name what would decide it, and proceed only under a **labelled assumption** |
| `UNMEASURED` | **second entry point only:** a sentence you wrote asserts behaviour, and nothing you can point at backs it | **delete the sentence, or turn it into a pointer to the test that proves it** — before the gate |

🔴 **`UNMEASURED` has exactly two exits, and "reword it" is not one of them.** A
behaviour claim is either backed or it is not; softening the wording keeps an
unbacked claim in a document agents follow literally. So either the sentence goes,
or it becomes `see gate-rounds.test.ts › "exits 2 — and only 2"` — a pointer a
reader can open. `invariants.md` ("State the limits") states the norm this verdict
enforces.

What counts as backing: a test you can name, a command whose output you have in
front of you, or a citation to code that does the thing. What does not: the queue
item said so (the item is a claim too — that is what the first entry point is for),
it was true of the previous design, or it is obviously right.

🔴 **On `PREMISE FALSE` the answer is stop and report — never quietly work around
the false premise by building something adjacent that seems useful.** Write what
the item claimed, what the code actually says with its citation, and what the
task might become instead. Then let a human re-aim it. The item is wrong, and an
agent that silently repairs a wrong item produces work nobody asked for, in a
branch named after a task that does not exist.

`UNVERIFIABLE` is not a soft pass. A probe that could not run tells you nothing —
so the assumption travels in the open, in the item and in the PR description,
where the next reader can see which part of the work rests on it.

## Examples — the three shapes this actually catches

**The thing already exists.** Item: "the payload schema does not reject an empty
title". The schema does reject it, three lines into the validator; the reported
bug came from a caller that never invoked the validator. Building "the missing
check" would have added a second, divergent rule and left the real defect —
the caller — in place. Verdict `PREMISE FALSE`; the task becomes a caller fix.

**The thing is somewhere else.** Item: "the worker retries forever because the
retry budget is not applied". The budget is applied, and correctly; the message
returns to the queue from a path above it that never consumed the budget at all.
The fix designed against the item would have been written in a file that was not
the problem. Verdict `PREMISE FALSE`.

**Nothing enforces it — except something does.** Item: "nothing stops a handler
importing the storage layer directly". A hook does exactly that, and has since
before the item was filed. Two hours of building a second enforcement mechanism,
which would then have disagreed with the first. Verdict `PREMISE FALSE`.

Note what all three have in common: the resulting work would have been correct,
tested, reviewable, and useless. That is the failure mode this catches, and it
is invisible to every gate downstream.

## Limits — stated, because a check trusted past its reach is worse than none

- **It reads the code, so it only catches what the code can contradict.** A claim
  about runtime behaviour ("this times out in production"), about intent, or
  about a system this repository does not contain is `UNVERIFIABLE` here, not
  false — say so rather than guessing.
- **It is one pass, before the work.** A premise that becomes false while the
  task runs (a merge lands, a dependency moves) is a staleness stop rule
  (`.claude/rules/autonomy.md`), not this skill.
- **It has no opinion on whether the task is worth doing.** True premises and a
  pointless task is a perfectly consistent state, and it belongs to whoever fills
  the queue.
- 🔴 **Nothing makes this run, and the verdict is a self-report.** No hook fires
  when a task starts building on an unchecked claim, and no artifact outlives the
  step — so a run that skipped it and a run that passed it look identical
  afterwards. That is the honest description of every rule of this shape here
  (the `loop` skill says the same about its own no-hand-feeding rule), and it is
  why the citation matters: a `file:line` in the report is the one part of this a
  later reader can re-check.
