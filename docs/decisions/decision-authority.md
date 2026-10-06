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

The machine-readable form that loop, preflight and doctor read is the
object `authorityPosture` returns. Its shape is pinned in the generator's
`test/template/authority.test.ts` (absent in a generated rig) › "is
deterministic — two calls with equal input serialise byte-identically to
the exact expected string".

Documentation that explains the contract points at the module and never
re-lists its decision or boundary ids — pinned in the same file › "does not
re-list any decision or boundary id — it points at the module instead of
duplicating it".

## Consequences

Where a run records the authority it was started with, how a delegated
decision becomes durable evidence a later controller can read, how stop
classes tell an owner decision apart from a real wall, and how preflight
and doctor report the posture are separate pieces of work. Each consumes
this module instead of restating it.

Adding, renaming or moving a decision kind between the two lists is a
contract change. It edits one file, and the test that pins the lists has to
change on purpose.

Nothing here adds a daemon, a database, a scheduler, a sandbox or a control
plane. The contract is a vocabulary and four pure functions. Enforcement
stays with the gates and hooks that already exist.
