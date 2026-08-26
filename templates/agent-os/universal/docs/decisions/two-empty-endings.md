# Why "queue empty" and "nothing selectable" are different endings

The rule lives in the `loop` skill, section 3. This file explains why the two
stops are reported separately, how the parked pile grows under each adapter, and
why a parked cause outranks a holding one. It is not loaded into any session.

## The two endings ask the owner for opposite things

- **Queue empty after the filters** — there is no work. Refilling it is the
  owner's job. Expect this to be the most common ending: the queue is finite and
  the loop drains it.
- **Nothing selectable** — the work is there and every piece of it is held back
  by a condition that clears when _something else happens_: the elevated spacing
  (a normal item lands — or an elevated one whose paths were all documents, see
  `spacing-rations-mechanisms.md`), a blocker (its item closes), `in-progress`
  (the other session finishes), a trigger (a human declares it), an owner (the
  item is marked for another repository and a human moves or re-marks it —
  AR-132), a `re-scope` item (a human rewrites it against the current code and
  removes the label — AR-144), and a `deferred` item (it carries the `parked`
  label and a human un-parks it — AR-144).

An empty queue wants refilling. A held one wants interleaving, time, or — for a
trigger or an owner — the human act the stop line names.
Reporting the second as the first sends the owner to write tickets that already
exist; reporting the first as the second tells them to wait for nothing.

## The parked pile is reported next to the verdict, never inside it

Parked items are out of play and waiting on a human. They are not work this run
can take, and they are not why the queue is empty — so they are named separately,
by cause and count. An `obsolete` item (AR-144) is one of them: it waits on a
human close with a comment naming the evidence, which the loop never writes.

⚠ "Parked" here is the pile, not the `parked` **label**. The label (AR-144) means
"valid work, deliberately not now" — takeable, held, freed by an un-park — so its
cause is spelled `deferred`, and it is never in this pile. The two were named
before each other existed; this note is the reconciliation rather than a rename,
because the pile word runs through the stop line, the tests and this record.

How that pile grows is the adapter's business, and the stop line does not guess:

| adapter                                  | what lands in the parked pile                         |
| ---------------------------------------- | ----------------------------------------------------- |
| tracker-backed (`github-issues`, `jira`) | an escalated item, a filed proposal (both stay open), and an item labelled `obsolete` (AR-144) |
| `plan-md`                                | a `[triage]` or an `[obsolete]` line sitting in the Agent queue — nothing else, because a flat list has no per-item state |

Under `plan-md` a filed proposal goes to the Operator queue, where selection
never looks, and an escalation leaves **no mark on the queue at all** — a flat
list has no per-item state.

## That absence is not a safety

`plan-md`'s `escalate` writes nothing to the queue and returns `ok: false`,
handing back the instruction with it: move the item to the Operator queue in the
same edit. That move is the session's, and skipping it means the next run takes
the stuck item straight back.

It does still record the escalation into the run state, like every other
adapter. The two are different facts, which is why escalating must go through
the adapter rather than by hand-labelling: the count is what ends a run that has
hit the same wall twice.

## Why a parked cause outranks a holding one

An escalated item is left **claimed** on purpose, so it arrives carrying
`in-progress` as well as `escalated`.

Reading that as _held_ would report "another session will finish it" about an
item no session is on — and, worse, would make the empty verdict unreachable
from the first escalation onward. Reporting a working queue as empty is the
defect this distinction exists to prevent; reporting a parked one as working is
the same defect reversed.

Neither ending is an invitation to refill the queue or invent work.
