# Who may decide is a separate question from whether anyone is watching

## Context

Before 1.5.0, Rig had a word for one property of a run: whether it is
unattended. The unattended flag, preflight and doctor all answer that
question (`docs/decisions/unattended-posture.md`). They do not answer a
second one: when the run reaches a choice the rules route to a human, who
may make it?

Without a word for that, a long autonomous run in practice took its
authority from a prompt. The owner wrote "decisions are delegated to you"
into a session. The next session, after a compaction or on another machine,
either did not have that sentence or had to be given it again. Two things
then happened. A delegated run stopped on ordinary choices the owner had
already handed over. Or the delegation was read as broader than it was,
because nothing said where it ended.

## Decision

`.claude/scripts/lib/authority.mjs` is the single source of the controller
authority contract. It is pure Core — zero imports, no I/O — like the
posture contract beside it.

- **Execution mode and decision authority are two independent values.** An
  unattended run may still be owner-controlled, and an attended session may
  run with delegated authority. Neither one implies the other.
- **The default is the owner.** An absent authority setting reads as owner,
  so every rig that predates this contract keeps its behaviour. A setting
  that is present but malformed reads as unknown, and unknown never acts as
  delegated.
- **Delegated authority covers a closed list of ordinary decisions** and
  never covers a second closed list of boundaries. Both lists live in the
  module and nowhere else. A decision that fits no delegable kind stays the
  owner's: asking the module about a kind it does not name is an error, not
  a quiet no.
- **Delegated is not "gates off".** Every boundary on the second list —
  among them the Never tier, the kill switch, a failing mechanical gate and
  unreadable evidence — holds under every authority. Delegation decides who
  answers a question a gate leaves open; it never answers a question a gate
  has already closed.
- **Publishing authority is a constant, not a mode.** The module exports it
  as the owner and builds the posture object from that constant, ignoring
  any value a caller passes for it.

The machine-readable form of the contract is the object `authorityPosture`
returns. Its shape is pinned in the generator's
`test/template/authority.test.ts` (absent in a generated rig) › "is
deterministic — two calls with equal input serialise byte-identically to
the exact expected string".

Documentation that explains the contract points at the module and never
re-lists its decision or boundary ids — pinned in the same file › "does not
re-list any decision or boundary id — it points at the module instead of
duplicating it".

## Stop classes

The opt-in workflow layer sorts each stop it catalogues into a decision the
rules route to the owner, a blocked item or a run-level wall, and turns a
stop, the run's authority and the decision it needs into one answer. Only a
stop whose decision is of a delegable kind resolves without a human, and only
under delegated authority — pinned in the generator's
`test/template/stop-class.test.ts` (absent in a generated rig) ›
"table-driven: every ITEM_STOPS entry resolves, under delegated authority,
to the independently declared expected resolution — and none of them is
decide-and-continue under owner". A run-level wall stops the run under every
authority, because the run-level stops take no authority input at all — ›
"takes no authority input:
decisionAuthority alongside a systemic/external input is ignored — the
result is deep-equal to the call without it, and the stop still fires".

## Delegated decisions are durable evidence

A decision a delegated run resolves is recorded where a replacement
controller can read it without this session's memory: the opt-in workflow
layer appends it to a per-item file under `.rig/decisions/`, which travels
with the item's branch like the claim records do. Only a run whose declared
authority is delegated can record one, and only of a delegable kind — pinned
in the generator's `test/template/delegated-decision.test.ts` (absent in a
generated rig) › "refuses when the run authority is absent (reads as owner),
naming owner". A recorded decision is made; no record means the decision is
still open — › "a FRESH run directory (a different controller session) still
reads the made decision". The gates read their own inputs and never this
record, so a recorded decision bypasses none of them.

The record command writes the decision file; it does not stage or commit it.
Explicitly stage `.rig/decisions/<ticket>.jsonl` and commit it with the item's
branch before expecting another clone to read the decision. Per-run journals
under `.claude/runs/` are local evidence and do not replace that portable file.
Revalidation of an existing claim record mechanically checks its committed
Git version; initial selection may create an unversioned baseline. The
delegated-decision reader reads the working-tree file without requiring a
committed Git version. A successful decision read therefore does not prove
that another clone can read it.
Generator evidence (absent in a generated rig):
`test/e2e/delegated-authority.test.ts` › "scenario 6: a
second controller session (B) reads session A's delegated decision back as
durable evidence" explicitly stages and commits the file before cloning;
`test/template/delegated-decision.test.ts` (absent in a generated rig) ›
"journals exactly one run-journal
EVENT (kind: delegated-decision), and writes NOTHING to decisions.jsonl"
pins the separate local event.

The reader refuses a persistently linked decisions directory or a multiply
linked record file. These static containment checks assume the decisions
directory is not concurrently replaced during the read; they do not provide
race-proof containment against such replacement.
The static refusals are pinned in the generator's
`test/template/delegated-decision.test.ts` (absent in a generated rig) › "a
.rig/decisions directory junction to a different checkout is unreadable — exit
2, never that checkout's decision" and › "a ticket file hard-linked from
another checkout is unreadable — exit 2, never that checkout's decision".
Those checks do not establish protection against concurrent directory replacement.

## Consequences

Preflight and doctor report the posture, and the loop declares the authority
at launch and resolves each stop through it. Each of them consumes this
module instead of restating it.

Adding, renaming or moving a decision kind between the two lists is a
contract change. It edits one file, and the test that pins the lists has to
change on purpose.

Nothing here adds a daemon, a database, a scheduler, a sandbox or a control
plane. The contract is a vocabulary and four pure functions. Enforcement
stays with the gates and hooks that already exist.
