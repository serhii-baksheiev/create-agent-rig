# SessionStart hook output: one JSON wire format, both harnesses

Status: accepted for RP-185.

## Decision

`inject-rules.mjs` (the SessionStart hook that re-injects the autonomy rules on
startup, resume and compaction) prints one JSON object to stdout, unconditionally,
for both Claude Code and Codex:

```json
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}
```

No trailing newline, no other top-level fields, no provider branching. The
`additionalContext` value carries exactly the text the hook used to write
directly to stdout (the `[agent-os] …` banner, the notice, the excerpted rules).

## Why

Measured, 2026-09-17, Codex 0.154.0 on Windows: with the previous plain-text
output — stdout beginning with the literal characters `[agent-os] Autonomy
rules refresh …` — Codex printed `Hook failed └ hook returned invalid session
start JSON output`, and the autonomy refresh never reached the session's
context. Claude Code was unaffected by that same plain-text form. A second
SessionStart hook in the same measured session, one that already emitted
`{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":…}}`,
did reach the session — which is what pointed at the wire format rather than at
"Codex rejects plain text" as the fix.

That framing matters because it is not what Codex's own documentation says.
[Codex's hooks reference](https://learn.chatgpt.com/docs/hooks) states plainly
that plain text on stdout is accepted for `session_start` and is added as
developer context — so "Codex does not support plain-text SessionStart output"
would be false, and this file does not claim it. What the page does not
document is *how* Codex decides a given stdout is JSON rather than plain text,
or what happens when that decision goes the wrong way. The measured symptom —
an output whose first character is `[` reported as *invalid* JSON, rather than
silently read as plain text — is consistent with a sniff that treats a leading
`[` (or `{`) as a signal to attempt a JSON parse, and reports a failure rather
than falling back when that parse does not succeed. That mechanism is inferred
from the symptom, not read off the page, and is stated here as an inference,
not a documented fact.

## Why the JSON envelope, not a reworded plain-text banner

The alternative fix — keep printing plain text, just not starting with `[` —
would have worked too, but it leaves the same undocumented sniffing behaviour
one character choice away from breaking again, for a reason nobody would think
to look for. The JSON form sidesteps the ambiguity entirely rather than
tip-toeing around it, and it turns out to need no provider branching, because
both harnesses already document the identical shape:

- **Codex** ([learn.chatgpt.com/docs/hooks](https://learn.chatgpt.com/docs/hooks)):
  gives the worked example
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Load the workspace conventions before editing."}}`
  as JSON output for a `session_start` hook.
- **Claude Code** ([code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)):
  documents the same nested shape for `SessionStart` — `hookSpecificOutput`
  with `hookEventName` (must equal `"SessionStart"`) and `additionalContext` —
  and states that JSON is detected when stdout starts with `{` and ends with
  `}`; anything else is treated as plain text and added to context the same
  way. `systemMessage` and `terminalSequence` are also accepted fields there,
  unused here because nothing today needs them.

One shape, honoured by both harnesses' own documentation, is what
`invariants.md` ("One mechanism, one implementation") asks for whenever a
single source can serve two consumers — the alternative, a provider check that
picks plain text for one harness and JSON for the other, would be exactly the
kind of guessed, undocumented branching this repository's rules warn against
("never invent APIs or behavior").

## What this does not claim

- Not that Codex rejects plain text in general — its own docs say otherwise.
- Not a documented account of Codex's JSON-vs-plain-text sniffing — that
  mechanism is not published; only the fix (always emit the one documented
  JSON shape) is asserted, not the internal reason it was needed.
- Not that `source: "startup"`, `"resume"` and `"compact"` are guaranteed
  identical by either harness's spec beyond what each page states; both are
  silent on any per-source difference in output handling, and the hook applies
  the same output uniformly across all three because nothing in either
  contract says to do otherwise.

## The exit path: exitCode vs exit(), and what it trades

The envelope change alone re-armed the original defect at a different trigger.
`inject-rules.mjs` ended with `process.exit(main())`, and `process.exit()` tears
the process down without waiting for a queued `stdout.write()` to drain. Under
the old plain-text wire format a write a pipe's buffer could not hold in one
piece degraded to *partial rules text* — readable, if incomplete. Under the
JSON envelope the same truncation is *invalid JSON* — precisely the state
Codex was measured rejecting wholesale, just moved from "the output starts
with `[`" to "the output was cut off mid-object". Exit code 0 either way, so
nothing downstream reports it.

Reproduced independently by two review passes at HEAD before the fix: a
consumer that does not start reading until well after the child would have
exited loses everything past the pipe's buffer — at one measurement, a 74 KB
rules file delivered 0 bytes; at another, 65536 of 73893. Both parse as
`Unterminated string`.

The fix is `process.exitCode = main()` in place of `process.exit(main())`.
Every path through `main()` returns `0`, so the exit STATUS does not change.
What changes is whether the process terminates before the write finishes:
`exitCode` lets Node's event loop drain naturally, which is what lets a large
payload actually reach a reader. Verified against the same probe shape that
found the defect, at four payload sizes (7 083 B through 1 002 552 B) and
three consumer shapes (a non-draining reader, a slow reader at 4 KiB/50 ms,
and a plain file redirect): every case delivered the complete envelope and
parsed. Pinned in the generator's `hooks.test.ts` (absent in a generated rig)
› "delivers the whole envelope even when the reader does not drain until
process.exit(main()) would already have torn the process down", which goes
red (`Unterminated string`, at a byte count that is host-dependent — kernel
pipe buffer size and scheduler timing both vary) if the single line is
reverted. The pinned payload is sized for a deterministic kill rather than a
merely likely one: a smaller payload truncated on nearly every reversion run
on every host checked, but not every one, and a pin the defect can slip
through occasionally is a pin that will eventually be green on a real
revert. That pin's coverage is Linux-shaped: Node documents pipe writes as
synchronous on Windows and asynchronous on POSIX, so the same reversion is
expected to have little or nothing to catch on a Windows lane — the test's
own comment says so, so a future reader does not mistake a Linux-only kill
for cross-platform cover.

**What this trades away, stated plainly rather than left to be discovered:**
`process.exit()` also GUARANTEED teardown, and `exitCode` does not. A consumer
that never reads stdout at all no longer gets a fast, wrong exit 0 — it gets
a hook that stays alive indefinitely, waiting on the write. Measured: still
running 8 seconds in in one review's reproduction, at 74 KB and 1 MB payloads
with nobody draining; completing the instant a reader appeared. A probe built
to refuse reading until the child would already have exited measurably
DEADLOCKS this version, where `process.exit()` would have terminated
(truncated, but terminated). Nothing in this file bounds that wait — the
calling harness's own hook timeout does. Not reachable at the size this hook
ships today (a few KB, well under a second to write), but a real behaviour
change on a project whose `autonomy.md` grows large, or whose harness stops
reading a hook's stdout entirely. The trade is made on purpose: a loud hang
bounded by the harness's own timeout is preferred over a silent, truncated
"success" with no bound on how wrong it can be.

A second, smaller consequence of the same change: a reader that vanishes
MID-write (a closed pipe, a harness that kills this process before reading)
now surfaces as an unhandled `error` event on `process.stdout` — exit 1 with
a Node stack trace on stderr, where the old `process.exit()` path exited 0
silently in the same situation. The handler is narrow rather than blanket,
and the difference is measured, not theoretical: an earlier draft of this
fix silenced every stdout error unconditionally, and security review found
that with stdout redirected to `/dev/full` — a genuine write failure
(ENOSPC), with the reader still fully attached — that blanket form exited 0
with nothing delivered and no diagnostic, the exact silent-loss shape this
whole file exists to avoid, moved one write call over. The handler now
distinguishes the two: EPIPE (the reader is gone; there is nothing left to
report to) stays silent, and anything else is written to stderr and marks
the exit non-zero. Pinned in the generator's `hooks.test.ts` (absent in a
generated rig) › "silently exits 0 when the reader is gone before the write
starts (EPIPE)" and › "reports a genuine stdout write failure on stderr and
marks the exit non-zero, rather than looking like a healthy session".

**Left for a separate decision, not for this one:** seven sibling hooks in
this same directory still end in `process.exit(…)` with no wait for a
pending write — `block-no-verify.mjs`, `guard-rulebook.mjs`,
`guard-subagent-model.mjs`, `guard-bash.mjs`, `guard-secret-file.mjs`
(`process.exit(status)`), `gate-stop-dod.mjs` (`process.exit(code)`) and
`warn-subagent-routing.mjs` (the first four and the last end
`process.exit(main())`). Their payloads are short (a refusal message, not a
whole rules file), so the exposure is far smaller, but the reasoning above
now lives in one hook's comments only — `invariants.md`'s "one mechanism,
one implementation" would ask for the same pattern everywhere it applies.
This change deliberately does not touch the other seven: changing every
`process.exit()` call in the hooks directory in a PR whose stated purpose is
a SessionStart wire-format fix is exactly the scope creep `autonomy.md`'s
Tier-2 discipline exists to catch. Recorded here so the inconsistency is a
known, named backlog item rather than something the next reader has to
rediscover.

## Risk and rollback

Tier 2 (`templates/agent-os/universal/.claude/hooks/` is a declared elevated
path) for both decisions this record carries, each with its own risk and its
own rollback:

**The wire format.** The blast radius is narrow: this hook's own stdout
contract, read only by the two harnesses' SessionStart machinery. If either
harness's documented shape turns out to differ from what was fetched here, or
a future harness version stops accepting it, rollback is reverting
`inject-rules.mjs` to write plain text again — a one-line change, the same
one this decision replaces. The old plain-text form is pinned by a regression
test precisely so it is not reintroduced by accident while chasing an
unrelated fix: the generator's `hooks.test.ts` (absent in a generated rig) ›
"never regresses to the old bare [agent-os]-prefixed plain-text stdout".

**The exit path** ("The exit path: exitCode vs exit(), and what it trades",
above). The blast radius is this hook's shutdown behaviour, not its output
shape: a consumer that never drains stdout at all now holds this process
alive rather than letting it exit truncated, bounded only by the calling
harness's own hook timeout. If that trade turns out to be wrong — a harness
with no such timeout, or one where a hung hook process is worse than a
truncated one — rollback is reverting the single `process.exitCode = main()`
line to `process.exit(main())`, independently of the wire-format decision
above; the two lines do not depend on each other. That reintroduces the
flush defect this record measures, so a revert of this line alone should
also remove or explicitly override the test that pins it: the generator's
`hooks.test.ts` (absent in a generated rig) › "delivers the whole envelope
even when the reader does not drain until process.exit(main()) would already
have torn the process down".
