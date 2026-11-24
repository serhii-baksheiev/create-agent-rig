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
record, so a recorded decision bypasses none of them — with one bounded
exception, the gate-round counter, described next.

## Extra gate rounds are bounded (opt-in workflow layer)

The delegable decision to run an extra gate round buys one review round past
`maxGateRounds` for one exact ticket, branch and head, never a standing
permission. The owner's
`options.maxDelegatedRounds` in `.claude/queue.json` (default 1) bounds how
many such authorizations a branch may hold, whatever ticket each names, and
both `record` and the counter read it from there, so a controller cannot
enlarge it by recording decisions — the generator's
`test/template/delegated-rounds.test.ts` (absent in a generated rig) ›
"absent maxDelegatedRounds defaults to 1: a first record succeeds, a second
for the same ticket+branch is refused". The authorization is committed with
the branch, only a record committed at HEAD counts, and admission for the
launch must run under a journalled delegated authority — › "gate-round
--authorized refuses a bypass of the committed-record and consuming-authority
rules (RP-442, security-scanner)". Admission for a new delegated fan-out requires
that no reviewer has answered on the covered head. Consumption counts each matching
recorded non-empty fan-out once in the existing gate counter; a reviewer answer that arrives
after valid admission does not erase that launched work — › "counts a reserved delegated fan-out after a reviewer verdict makes a new admission ineligible".
Reviewer verdicts still prevent a fresh admission on the answered authorization.
A new head earns nothing on
its own — › "exits 2 on a fix commit past the default budget — no second
authorization exists to match". With the default budget a run therefore stops
at the owner after three base rounds and one delegated round, however the
records are edited — › "an in-place rewrite of the single counted record to a
new, unverdicted head cannot buy a round past the total cap (probe 3)". The default
counter path resolves to the main checkout for linked worktrees and to a separate
path for an independent clone — see `test/template/gate-round-evidence.test.ts`
(absent in a generated rig) › "shares the default counter path across linked worktrees but not independent clones".

Evidence-backed transitions take the counter lock before the relevant run-journal
locks and retain both through the evidence check and counter persistence. Admission
checks this branch's active, completed and released token bindings. One active
slot covers one recorded fan-out; excess or late unaccounted evidence holds new
admission. Release retains a marker in the existing counter rather than forgetting
the token. Explicit consumption of late evidence for a released token counts it
once and returns HOLD, including on replay, while retaining the journal records.
The generator's `test/template/gate-round-evidence.test.ts` (absent in a generated
rig) exercises this boundary in "serializes a fan-out append through the final
counter write during %s" and "does not grant a different declared run after a
released token receives late fan-out evidence".

Journal lock ownership checks require writers on one host in one PID namespace;
they do not establish liveness across hosts or PID namespaces. Within that scope,
age alone does not reclaim a journal lock: its canonical owner PID must be
confirmed absent. Live or unverifiable ownership remains busy. The generator's
`test/template/run-journal-writers.test.ts` (absent in a generated rig) pins this
in "is not reclaimed when its canonical owner remains alive", "reclaims the
canonical lock of a confirmed-dead owner and leaves no lock file behind", and
"fails closed without deleting the ambiguous lock or appending an event".

Delegated verdict eligibility also uses the bounded current/root journal set;
see `test/template/delegated-rounds.test.ts` (absent in a generated rig) › "serializes an unbound root-journal
reviewer verdict written at the authorized counter-lock boundary" and
› "refuses a covered-head verdict from a root journal created at final counter persistence".

The generic journal preserves evidence; it does not control external reviewer
processes. Launching without admission or after release violates the procedure.
These accounting checks do not claim to prevent an unrecorded external launch.

The run's authority is self-declared. In the opt-in workflow layer,
`run-state.mjs authority` journals each declaration with the value before and after it —
`test/template/run-state-authority.test.ts` (absent in a generated rig) ›
"journals the first declaration and a later change, each with the previous and new value" —
and the record and resolve commands act on a delegated authority only when the state file matches
the latest journalled declaration — pinned in the generator's
`test/template/delegated-decision.test.ts` (absent in a generated rig) ›
"refuses to record under a delegated authority that was written by hand and
never declared". A record therefore shows what the run declared, not what the
owner authorised.

The record command writes the decision file; it does not stage or commit it.
Explicitly stage `.rig/decisions/<ticket>.jsonl` and commit it with the item's
branch before expecting another clone to read the decision. Per-run journals
under `.claude/runs/` are local evidence and do not replace that portable file.
Revalidation of an existing claim record mechanically checks its committed
Git version; initial selection may create an unversioned baseline — the
generator's `test/template/content-blind-revalidation.test.ts` (absent in a
generated rig) › "refuses to resume from an existing claim until Git tracks
it". The delegated-decision reader reads the working-tree file without
requiring a committed Git version — `test/template/delegated-decision.test.ts`
(absent in a generated rig) › "a FRESH process with no RIG_RUN_DIR at all
still reads the made decision — durable, not conversational". A successful
decision read therefore does not prove that another clone can read it.
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
