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

## Risk and rollback

Tier 2 (`templates/agent-os/universal/.claude/hooks/` is a declared elevated
path). The blast radius is narrow: this hook's own stdout contract, read only
by the two harnesses' SessionStart machinery. If either harness's documented
shape turns out to differ from what was fetched here, or a future harness
version stops accepting it, rollback is reverting `inject-rules.mjs` to write
plain text again — a one-line change, the same one this decision replaces. The
old plain-text form is pinned by a regression test precisely so it is not
reintroduced by accident while chasing an unrelated fix: the generator's
`hooks.test.ts` (absent in a generated rig) ›
"never regresses to the old bare [agent-os]-prefixed plain-text stdout".
