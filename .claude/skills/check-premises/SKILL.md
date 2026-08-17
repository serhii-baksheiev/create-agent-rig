---
name: check-premises
description: Check claims about the code before building on them, or before shipping them. Use after taking a queue item and before the failing test — whenever the item asserts something exists, is missing, is broken, or works a particular way. Use again before the gate, on the run's own prose, where a behaviour claim nothing backs is UNMEASURED.
context: fork
allowed-tools: Read, Grep, Glob, Bash
argument-hint: <the queue item's text, or the diff and prose to check>
---

A queue item is a **claim about the code**, written by someone who was not
reading the code at the time. "The retry path swallows the error", "there is no
validation on that field", "the worker never gets the second message" — each of
those is a premise, and the work that follows is only worth doing if it is true.

This skill checks the premises. It writes nothing, and it has **two entry points**.

| entry point | the claims are | the code is | verdicts |
| --- | --- | --- | --- |
| after selection, **before the Red step** | the queue item's, about code it did not read | the repository | `PREMISES HOLD` / `PREMISE FALSE` / `UNVERIFIABLE` |
| after the work, **before the gate** | your own, in the rulebook prose the diff touches — and in the PR description if one exists yet | your diff | `PREMISES HOLD` / `UNVERIFIABLE` / `UNMEASURED` |

🔴 **Why the second one exists.** A claim you wrote about a mechanism you did not run
is cheap to write and expensive to find: `prose-reviewer` reaches it only after loading
the whole diff, and the fix is an edit to one sentence. Same machinery, same question — *is this claim true?* — pointed
at the text the run wrote instead of the text it was handed.

The rest of this skill is written for the first entry point. The second one runs the
same four steps with the diff as the code, and §4 carries what is different.

**What "rulebook prose" means here is not a new list** — it is the set
`.claude/rules/workflow.md` already uses for the `prose-reviewer` trigger: a rule
file, a skill, an agent spec, a decision record, `CLAUDE.md`, the README. Where a
rulebook file exists twice (a template source and a generated copy), check the
**source**; the copy is composed from it. A comment in a test or a hook is in scope
too when it asserts behaviour — the file it lives in does not change what a claim is.

🔴 **`PREMISE FALSE` belongs to the first entry point only.** At the second one the
claims are your own and the remedy is an edit, so a false one is not an escalation:
it is `UNMEASURED`'s neighbour — delete or correct the sentence and carry on. Reading
it as the escalation `loop` §6 defines would send a finished branch back to the queue
over one sentence.

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

At the **second** entry point this inverts for one case: a test is exactly what backs
a behaviour claim, so reading it is the point. The rule above is about not letting a
test's *name* stand in for what the code does; §4 says which artifacts count.

## 4. The verdict

| Verdict | When | What happens next |
| --- | --- | --- |
| `PREMISES HOLD` | every load-bearing claim checked out, or there were none | proceed to the Red step |
| `PREMISE FALSE` | a load-bearing claim is contradicted by the code | **stop and report** |
| `UNVERIFIABLE` | a load-bearing claim could not be decided from the code | report it as unverifiable, name what would decide it, and proceed only under a **labelled assumption** |
| `UNMEASURED` | **second entry point only:** a sentence you wrote asserts behaviour, and nothing you can point at backs it | **delete the sentence, or turn it into a pointer to the test that proves it** — before the gate |

🔴 **The edit belongs to the calling session, not to this skill.** It reports; the
caller performs the exit before the gate. (The rule is the one at the top of this
file — it writes nothing — not a property of its tool grant.)

🔴 **`UNMEASURED` has exactly two exits, and "reword it" is not one of them.** A
behaviour claim is either backed or it is not; softening the wording keeps an
unbacked claim in a document agents follow literally. So either the sentence goes,
or it becomes `see guard-invariant.example.test.mjs › "blocks the violation"` — a
pointer this project carries, so the reader can open it. `invariants.md` ("State the limits") states the norm this verdict
enforces.

What counts as backing — the same three forms `invariants.md` names and
`prose-reviewer` item 5 checks: a test you can name, a command whose output you have
in front of you, or a citation to code that does the thing. What does not: the queue
item said so (the item is a claim too — that is what the first entry point is for), it
was true of the previous design, or it is obviously right.

⚠ **A measurement of this project's own history fits none of the three**, and that is
a real gap rather than an oversight: the run that produced it is not in the repository,
and a journal entry does not travel with a rulebook that ships. So a figure about past
runs belongs in the journal and **not** in a file other projects receive — where it
would arrive with no backing at all. Say it qualitatively there, or not at all.

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
- **Each entry point is one pass, at its own end of the task.** A premise that goes
  false *between* them — a merge lands, a dependency moves — is a staleness stop rule
  (`.claude/rules/autonomy.md`), not this skill. Neither pass watches the other's
  claims.
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
