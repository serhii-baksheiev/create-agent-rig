// record-dispatch.mjs — SubagentStart/SubagentStop hook (Claude Code and, via
// the Codex projection, Codex): journals one `dispatch-start`/`dispatch-end`
// EVENT per subagent this harness actually started, into the run journal
// (`.claude/scripts/run-journal.mjs`, `events.jsonl`) — the mechanical half of
// "did this reviewer even run", read back by `lib/gate-coverage.mjs`'s
// `witness` answer.
//
// observe-only: refuses nothing and returns no decision. It exits 0 on every
// path, writes nothing to stdout, and never throws out of `main()` — a
// `SubagentStop` hook that wrote a stdout decision could block a real session,
// and this hook must never carry that power by accident.
//
// The harness is read from `--harness=claude`/`--harness=codex` on argv —
// never guessed from the payload, which carries no reliable marker of which
// harness sent it. The run directory is `RIG_RUN_DIR` when declared, else the
// armed unattended flag's own `runDir` (`../scripts/unattended-flag.mjs`),
// else this hook writes nothing at all: a run nobody declared is not a run
// this hook may invent one for.
//
// RP-287 — that silence is indistinguishable from a genuinely attended
// session with nothing armed anywhere, and the RP-231 pilot lost ~15
// dispatches to exactly that: the controller was started in one checkout
// while the loop's run/flag lived in another. So when neither `RIG_RUN_DIR`
// nor an own-scoped flag resolves a run directory, this hook takes ONE extra,
// still-bounded look — a counted `opendirSync`/`readSync` walk (never
// `readdirSync`'s unbounded array) of ONE directory, `<env-home>/.claude`,
// where `<env-home>` is the home `env.HOME`/`env.USERPROFILE` itself declares
// (never a file open, never a content read), matched only against the
// checkout-scoped flag basename shape
// (`<FLAG_BASENAME-prefix>-<16 hex>-loop-UNATTENDED`, derived from
// `unattended-flag.mjs`'s own exported `FLAG_BASENAME` rather than a second
// copy of the prefix), with the entries examined capped. This probe
// deliberately does NOT reuse `stop-flag.mjs`'s `homesOf` — that helper's
// second candidate is always the real, OS-level `userInfo().homedir`,
// ignoring `env` entirely, which is exactly right for the security-relevant
// brake it backs but wrong for this diagnostic: a parallel test worker or a
// live loop mirroring a scoped flag into the real machine home (RP-263) would
// make this probe fire at random on a checkout that shares no home with
// either. `env` declaring neither `HOME` nor `USERPROFILE` means this probe
// scans nothing, rather than guessing a real home no caller declared. Finding
// an entry that is not among this checkout's own candidate paths means
// ANOTHER checkout's flag is armed in the SAME home, and this hook writes ONE
// bounded (<=512 chars) `record-dispatch:` line to stderr naming the root it
// checked (`CLAUDE_PROJECT_DIR`, or `cwd`, sanitised through `CONTROL_CHARS_RE`
// — a Unicode-general-category-based class, not an explicit range list; see
// that constant's own doc comment for exactly what it strips —
// so the line stays one line and carries no invisible-rendering character) —
// never the other checkout's `runDir` or flag content, and never more than
// that one line. Still exits 0, stdout stays empty, and nothing is written to
// any journal; any error inside this probe is swallowed, exactly like every
// other failure mode in this observe-only hook. See dispatch-journal.test.ts
// (absent in a generated rig) › "prints exactly one bounded stderr notice
// naming the checked root, and writes nothing, when the armed flag belongs to
// a DIFFERENT checkout". RP-294 round 2 (B3) extracted the bounded scan's
// DECISION into a small, exported, pure function, `firstForeignFlag(names,
// isForeign, cap = MAX_HOME_ENTRIES_EXAMINED)` — pulls at most `cap` items
// from an arbitrary iterable and returns the first one `isForeign` accepts,
// or `undefined`; `anotherCheckoutFlagIsPresent` below feeds it a lazy
// generator over the `opendirSync` handle's own entries, so the cap still
// bounds the real `readSync` calls, not just the function's own loop. See
// dispatch-journal.test.ts (absent in a generated rig) › "record-dispatch.mjs
// — firstForeignFlag: the bounded scan decision extracted into a testable
// pure function (RP-294 round 2, B3)".
//
// The record is bounded by ONE allowlist, `DISPATCH_FIELDS`: every key is
// filtered through it immediately before the write, so a field added to the
// payload handling but not to the list never reaches the journal. It is
// exported so this hook's own test can compare it with the independent copy it
// keeps (`.claude/rules/invariants.md`, the independent-oracle
// invariant): `schema`, `harness`, `controller`, `agentType`, `agentRef`,
// `declaredModel`, `declaredEffort`, `declaredSource`, `usage`,
// `usageUnavailable`, `measuredModel`, `orphan`. `controller` and `agentRef`
// are never the raw `session_id`/`agent_id` — they are
// `sha256(basename(runDir) + "\0" + value).slice(0, 16)`, so the record names
// no id a reader could correlate outside this one run.
//
// ORPHAN DISPATCH-ENDS (RP-294): the RP-231 controller run
// (rel110-20260928-213527, read-only evidence, never committed here)
// journaled a run of `dispatch-end` events with no matching `dispatch-start`
// anywhere in the run — harness-internal `SubagentStop` firings. The payload
// SHAPE is what that evidence actually recorded, not a guess: those
// orphan ends carried no `agent_type` at all, while every real, paired end in
// the same journal echoed back the payload's own `agent_type`. So `orphan:
// true` is written only when BOTH hold (RP-294 round 2, B4): no earlier
// `dispatch-start` in this run carries the same `agentRef`, AND the payload's
// own `agent_type` is absent or fails `AGENT_TYPE_RE` (the same narrow shape
// `agentType` below is built from). The second condition exists to rule out
// an ordinary start/end RACE — a `SubagentStop` whose `SubagentStart` hook
// has not finished writing yet, for a real agent whose payload DOES carry
// `agent_type` — which "no start" alone cannot tell apart from a genuine
// harness-internal event. See dispatch-journal.test.ts (absent in a generated
// rig) › "record-dispatch.mjs — orphan requires BOTH no earlier start AND no
// agent_type on the payload (RP-294 round 2, B4)". Never marked on a
// `dispatch-start`, and never derived from anything but that explicit flag
// once written (`token-report.mjs` trusts it verbatim rather than
// re-deriving "orphan" from its own pairing miss).
//
// The "no earlier dispatch-start" half is `hasEarlierDispatchStart`, and it
// is bounded on TWO axes, in this order (RP-294 round 2, B1): first, BEFORE
// any read at all, `statSync` on both `events.jsonl` and `decisions.jsonl` —
// either file larger than `MAX_ORPHAN_CHECK_BYTES` (~4 MiB) answers `null`
// (unknown) with no file ever opened for this check; only once both files
// pass that size gate does it call `readRun` and apply the pre-existing
// `MAX_ORPHAN_CHECK_EVENTS` (4096) count guard as a second, independent
// bound. Round 1 checked the event count only AFTER `readRun` had already
// done the full unbounded read and parse — a bound on what happens after an
// unbounded read is not a bound on the read. `null` on either bound, or on
// ANY failure reading the run (a `RunJournalError`, a stat error other than
// "the file does not exist yet", or anything else), leaves `orphan` absent —
// the previous behaviour — rather than guessed either way; a genuinely
// missing journal file (`ENOENT` — this run has not written that file yet)
// is zero bytes, not a failure. See dispatch-journal.test.ts (absent in a
// generated rig) › "record-dispatch.mjs — the orphan check is bounded by
// file size, not merely by event count after an unbounded read (RP-294
// round 2, B1)".
//
// CLAUDE USAGE CAPTURE (RP-226), on `SubagentStop` with `--harness=claude`
// only: this hook reads ONLY the payload's `agent_transcript_path` — never
// `transcript_path` (the parent's) — and refuses a UNC-shaped path first
// (reusing `UNC_PATH_RE`, shared with the Codex path below; see
// dispatch-usage.test.ts (absent in a generated rig) › "reports
// usageUnavailable: transcript-path-unc for a UNC-shaped
// agent_transcript_path (leading "//") — never opens anything"), then
// requires an absolute path (see dispatch-usage.test.ts, absent in a generated
// rig, › "reports usageUnavailable with transcript-path-not-absolute for a
// relative path whose basename otherwise binds to its agent_id") and its
// basename to be exactly `agent-<agent_id>.jsonl` for the
// payload's OWN `agent_id`; any other basename, a UNC-shaped or
// missing/empty path, resolves to `usageUnavailable` without opening
// anything. The read itself
// is bounded on three axes at once: at
// most 32 MiB read in total, at most 8 MiB in one line, at most 3s wall
// time (checked between chunks) — a fixed-size buffer on an
// `O_RDONLY|O_NONBLOCK` handle whose opened `fstatSync` is a regular file
// with the same device and inode as the preceding regular-file `lstatSync`.
// That comparison happens after `openSync`: it rejects a different opened file
// before reading changed content, but does not prevent the open itself. See
// dispatch-usage-codex.test.ts (absent in a generated rig) › "does not read a
// rollout replaced with a symlink after lstatSync has accepted its regular
// file". Crossing ANY bound, an unreadable file, an empty
// transcript, a transcript with no usage-bearing assistant record, an
// out-of-range counter, or a single malformed JSON line ANYWHERE in the
// transcript makes the whole dispatch `usageUnavailable: '<short reason
// code>'` (`transcript-unreadable`, `transcript-path-missing`,
// `transcript-path-unc`, `transcript-path-not-absolute`,
// `transcript-path-mismatch`, `transcript-too-large`,
// `transcript-line-too-large`, `transcript-timeout`,
// `transcript-malformed-line`, `transcript-empty`, `no-usage-records`,
// `invalid-usage-counter`) — never a partial number, and the reason codes
// themselves never carry the path or any transcript content. Assistant
// records' `message.usage` counters (`input_tokens`, `output_tokens`,
// `cache_creation_input_tokens`, `cache_read_input_tokens`) are deduped by
// `requestId ?? message.id`, last occurrence per key wins, then summed. An
// optional cache counter can therefore sum only valid deduped records that
// carry it; that is not a partial transcript result: any malformed line,
// unreadable path, or read-bound failure rejects every accumulated counter.
// `usage.requests` is the count of distinct keys. A counter absent from
// every deduped record stays absent (never `0`, never inferred); a counter
// present anywhere but not a non-negative safe integer makes the whole
// dispatch `usageUnavailable: 'invalid-usage-counter'` instead of a sum built
// from an out-of-range number. `measuredModel` is set only when every
// assistant record's `message.model` agrees AND that string is at most 128
// characters matching `^[A-Za-z0-9][A-Za-z0-9._:/@-]*$` — a disagreement or a
// non-matching string omits `measuredModel` but still records `usage`.
// `usage.evidenceSource` is always `'claude-subagent-transcript'`. Codex's
// own usage capture is CODEX USAGE CAPTURE, just below.
//
// The reader is exported as `readClaudeTranscriptUsage(file, { now } = {})`,
// `now` defaulting to `Date.now` and gating every wall-clock read inside it,
// so the 3s bound can be driven deterministically from a test with no real
// sleep. Importing this module for that export (or for `DISPATCH_FIELDS`)
// never runs `main()` — see `invokedDirectly()` below.
//
// CODEX USAGE CAPTURE (RP-227), on `SubagentStop` with `--harness=codex`
// only: this hook reads ONLY the payload's `agent_transcript_path` — the
// CHILD rollout — never `transcript_path` (the parent's, on `SubagentStop`).
// The path is refused before any file is even opened, checked in this order:
// missing or empty (`transcript-path-missing`, reused from RP-226),
// UNC-shaped — a leading pair of separators, `\`/`/` in ANY mix
// (`rollout-path-unc`) — checked BEFORE and independently of
// `path.isAbsolute`, because a mixed-separator UNC path is not
// POSIX-absolute and would otherwise fall through as the wrong reason
// code — then not absolute (`rollout-path-not-absolute`), then an
// `lstatSync`/`openSync`/`fstatSync` regular-file identity check exactly as
// the Claude transcript gets (`transcript-unreadable`; a symlink, FIFO, or
// other non-regular file is refused before reading, and after opening a
// candidate descriptor the reader rejects a different opened file before
// reading its changed content). See dispatch-usage-codex.test.ts (absent in a generated rig) ›
// "does not read a rollout replaced with a symlink after lstatSync has
// accepted its regular file". The read itself shares RP-226's
// bounded JSONL reader verbatim (`readBoundedLines`, extracted below so both
// sections call the same lstat/open/fstat identity check, chunked-read/carry-across-chunk
// implementation once) — the same 32 MiB total / 8 MiB per line / 3s
// wall-time bounds and the same
// `transcript-too-large`/`transcript-line-too-large`/`transcript-timeout`/
// `transcript-malformed-line`/`transcript-empty` reason codes, because a
// Codex rollout is JSONL exactly as a Claude transcript is.
//
// Identity is Codex-specific: the rollout's FIRST `session_meta.payload.id`
// — never a later one — must equal the payload's own `agent_id`, or the
// whole dispatch is `usageUnavailable: 'rollout-identity-mismatch'` — a
// rollout with no `session_meta` record at all is the same failure. A Codex
// child spawned with forked context writes TWO `session_meta` records, the
// child's own first and the PARENT's second — see the LIMITS entry below on
// forked children for the test that pins reading only the first. Once
// identity holds, the LAST `token_usage_record` whose `payload.thread_id ===
// agent_id` is the one read (no such record is `usageUnavailable:
// 'no-usage-records'`, reused from RP-226); its `thread_token_usage` — the
// thread's CUMULATIVE total, never `turn_token_usage` (one turn) or `usage`
// (that event's own delta) — is mapped onto this hook's own field names:
// `input_tokens`→`inputTokens`, `cached_input_tokens`→`cachedInputTokens`,
// `output_tokens`→`outputTokens`,
// `reasoning_output_tokens`→`reasoningOutputTokens` — exactly the four fields
// `token-report.mjs`'s own `codexUsageOf` already sums. A LATER matching
// record REPLACES the previous one rather than summing with it, because the
// total is already cumulative; a field absent from `thread_token_usage` stays
// absent (never `0`, never inferred); a matched record whose
// `thread_token_usage` is absent, `null`, `{}`, or not an object — so no
// counter is extracted at all — is `usageUnavailable: 'no-usage-counters'`,
// never `usage: { evidenceSource }` with no counters, which would read as
// "measured" to any caller checking `'usage' in data`; a
// present-but-negative-or-fractional field makes the
// whole dispatch `usageUnavailable: 'invalid-usage-counter'` (reused from
// RP-226) instead of a partial record. `usage.evidenceSource` is always
// `'codex-subagent-rollout'`.
//
// The reader is exported as `readCodexRolloutUsage(file, agentId, { now =
// Date.now } = {})`, mirroring `readClaudeTranscriptUsage`'s own `now`
// injection so the shared 3s bound stays deterministic under test.
//
// LIMITS, stated because a hook's own claim about its reach is the first thing
// to go stale:
//   - **No run directory declared → nothing recorded, not zero coverage.** A
//     reader comparing a launched set against zero dispatch-start events must
//     report that as UNAVAILABLE evidence, never as "nobody was witnessed" —
//     `lib/gate-coverage.mjs`'s `witness` answer does exactly that.
//   - **A Codex project hook may be skipped until the project is trusted.**
//     Codex does not run project-level hooks for an untrusted project, so a
//     Codex run's dispatch trace may simply be absent for a reason this hook
//     cannot see or report.
//   - **`controller` is Claude-only, and unmeasured on Codex.** Codex's own
//     session-id equivalent (if any) has not been observed on this hook's
//     stdin, so `controller` is omitted rather than guessed for any harness
//     other than `claude`.
//   - **`declaredModel`/`declaredEffort` are read from a small bounded head of
//     one definition file** (`.claude/agents/<type>.md` frontmatter for
//     Claude, `.codex/agents/<type>.toml` for Codex) and are omitted, not
//     guessed, when that file is absent, unreadable, or names an effort
//     outside the accepted enum.
//   - **Usage is only ever attempted on `SubagentStop`.** A `SubagentStart`
//     carries the same `agent_transcript_path`, but the file is not yet
//     complete at start, so this hook never reads it there.
//   - **`measuredModel` is Claude-only, even after RP-227.** A Codex rollout
//     carries no per-message model field this hook reads, so `measuredModel`
//     is never set for `--harness=codex` — `usage`/`usageUnavailable` are now
//     captured for both harnesses (RP-226 Claude, RP-227 Codex), each from
//     its own file shape and its own reason-code vocabulary (Codex adds
//     `rollout-identity-mismatch`; every other code is shared).
//   - **`cache_write_input_tokens` and `total_tokens` are read off a real
//     Codex rollout's `thread_token_usage` but never mapped.** Only the four
//     fields `token-report.mjs`'s `codexUsageOf` already sums are read
//     (`input_tokens`, `cached_input_tokens`, `output_tokens`,
//     `reasoning_output_tokens`); a real rollout's other two
//     `thread_token_usage` fields are ignored, never folded into an existing
//     counter.
//   - **A forked child rollout carries TWO `session_meta` records, and only
//     the FIRST is read** — the child's OWN `session_meta` (carrying
//     `forked_from_id`/`parent_thread_id`) first, the PARENT's second; see
//     dispatch-usage-codex.test.ts (absent in a generated rig) › "identifies
//     a forked child rollout from its FIRST session_meta record (the
//     child's own, carrying forked_from_id/parent_thread_id) — not the
//     parent's second record". Reading only the first record is a
//     deliberate choice, not an unexercised gap: a rollout whose first
//     `session_meta` does not name `agent_id` is `rollout-identity-mismatch`
//     even when a later one does.
//   - **The 3s bound is checked only between read chunks, not around the
//     whole read.** `lstatSync`, `openSync`, a single slow `readSync`, and
//     the final line's `JSON.parse` all run outside the clock; a process
//     stuck in one of those still relies on the harness's own hook timeout
//     as the real backstop.
//   - **Absolute non-UNC paths are not proven local.** This hook accepts an
//     absolute non-UNC regular file under the same bounds and post-open
//     identity check, but has no network-location detector. On Windows,
//     mapped drive letters and `SUBST` aliases can denote network paths; see
//     https://learn.microsoft.com/en-us/windows/win32/api/shlwapi/nf-shlwapi-pathisnetworkpathw.
//     The hook behaviour is pinned in dispatch-usage-codex.test.ts (absent in
//     a generated rig) ›
//     "documents that absolute non-UNC paths are not proven local, and still captures usage from one (network location remains unmeasured)".
//   - **`no-usage-records` has a narrow Codex meaning.** It is returned only
//     after the first `session_meta` binds to `agent_id`, when no
//     `token_usage_record` has that `thread_id`; a matched record without a
//     usable counter is instead `no-usage-counters`. See
//     dispatch-usage-codex.test.ts (absent in a generated rig) › "reports
//     usageUnavailable with no-usage-records when identity holds but no
//     token_usage_record names this thread_id".
//   - **The orphan check (RP-294) is bounded by file size FIRST, then by
//     event count — never by time.** `hasEarlierDispatchStart` `statSync`s
//     both journal files before opening either; past `MAX_ORPHAN_CHECK_BYTES`
//     (~4 MiB) on either one, `readRun` is never called at all. Only once both
//     pass that gate does the pre-existing `MAX_ORPHAN_CHECK_EVENTS` (4096)
//     count guard run as a second check. A run that never crosses either
//     bound but is merely slow to read from disk has no separate timeout
//     here, unlike the transcript readers above.
//   - **Orphan needs no earlier start AND no `agent_type` on the payload
//     (RP-294 round 2, B4).** A real dispatch-end whose `SubagentStart` hook
//     simply has not finished writing yet still carries the payload's own
//     `agent_type`, so "no earlier start" alone is not sufficient — only a
//     payload with no valid `agent_type` either is marked `orphan: true`.
//
// PRIVACY: this record never carries `cwd`, a transcript path, a prompt, a
// response, a raw `session_id`/`agent_id`, or an email address — see
// dispatch-journal.test.ts (absent in a generated rig) › "never persists the
// payload fields the item forbids", and, for the usage reader specifically,
// dispatch-usage.test.ts (absent in a generated rig) › "never carries the
// transcript path or assistant message content in the journal record".
//
// Pinned in dispatch-journal.test.ts (absent in a generated rig) › "exits 0
// and prints nothing when RIG_RUN_DIR is unset and no unattended flag is
// armed", › "records a dispatch-start event on SubagentStart, keyed by
// agentRef", › "records a dispatch-end event on SubagentStop, with the same
// agentRef as the matching start", › "reports 'claude' when spawned with
// --harness=claude", › "carries controller = ref(runDir, session_id) on
// Claude, when session_id is a string", › "reads declaredModel/declaredEffort/
// declaredSource from Claude agent frontmatter", › "reads declaredModel/
// declaredEffort/declaredSource from a Codex agent profile", and › "exports
// DISPATCH_FIELDS equal to this test's own independent copy, in both
// directions".
//
// The usage reader is pinned in dispatch-usage.test.ts (absent in a
// generated rig) › "sums input/output tokens across distinct requestIds, and
// counts requests as the number of distinct ids", › "dedupes by requestId:
// the same requestId appearing twice is counted once, with the LAST
// occurrence winning", › "falls back to message.id for dedup when a record
// carries no requestId", › "sums a cache counter present on every assistant
// record in the transcript", › "sums a cache counter present on some
// assistant records and absent on others, from only the records that carry
// it", › "omits a cache counter absent from every assistant record in the
// transcript — never zero", › "records measuredModel when every assistant
// record names the same model", › "omits measuredModel when assistant
// records disagree on the model", and — this file's own Codex-boundary test,
// renamed by RP-227 (replacing a dead citation to the pre-RP-227 test name
// this same sentence used to quote) — › "does not apply the Claude
// transcript reader to a Codex dispatch — a rollout
// with no session_meta records usageUnavailable: rollout-identity-mismatch,
// never a Claude-shaped usage (RP-227)". › "reports
// usageUnavailable when agent_transcript_path’s basename does not match
// agent-<agent_id>.jsonl for the payload’s own agent_id", › "reports
// usageUnavailable and never reads transcript_path (the parent) when
// agent_transcript_path is absent", › "reports usageUnavailable, with no
// partial numbers, when a single line exceeds the per-line bound (8 MiB)",
// › "reports usageUnavailable, with no partial numbers, when the transcript
// exceeds the total-size bound (32 MiB)", › "reports usageUnavailable, not a
// partial sum, when the transcript contains a malformed JSON line", and ›
// "exports DISPATCH_FIELDS containing usage, usageUnavailable, and
// measuredModel".
//
// The RP-226 fix round is pinned in dispatch-usage.test.ts (absent in a
// generated rig) › "reports
// usageUnavailable with code transcript-empty for a zero-byte transcript",
// › "reports usageUnavailable with code no-usage-records for a transcript
// containing only user records", › "reports transcript-timeout when an
// injected clock crosses the 3 s bound between two read chunks", › "processes
// four ~7.9 MiB lines (inside both size bounds) well within the 3 s bound",
// › "does not record measuredModel when message.model is a 7 KiB string, but
// still records usage", › "does not record measuredModel when message.model
// contains an ESC control character, but still records usage, and ESC never
// reaches the journal", › "does not record measuredModel when it is 129
// characters — one over the 128-character allowlist bound — but still
// records usage", › "records measuredModel at exactly the 128-character
// allowlist bound — a guard against an off-by-one in the Green step’s fix",
// › "records measuredModel for a normal Claude model id shape
// (claude-haiku-4-5-20251001) — a guard against the Green step’s allowlist
// rejecting real ids", › "reports usageUnavailable with code
// invalid-usage-counter for a negative token counter, not a sum", and ›
// "reports usageUnavailable with code invalid-usage-counter for a fractional
// token counter, not a sum".
//
// The Codex reader is pinned in dispatch-usage-codex.test.ts (absent in a
// generated rig) › "reads thread_token_usage from the LAST matching
// token_usage_record, maps its four counters, and sets evidenceSource", ›
// "uses the LAST token_usage_record for the agent — a later, smaller
// thread_token_usage is not summed with an earlier one", › "ignores a
// token_usage_record for a DIFFERENT thread_id, even when it appears after
// the matching one", › "a counter absent from thread_token_usage stays
// absent — never zero, never inferred", › "does not attempt usage capture on
// SubagentStart — only SubagentStop reads the rollout", › "reports
// usageUnavailable with rollout-identity-mismatch when session_meta.payload.id
// differs from the dispatch's agent_id", › "reports usageUnavailable with
// rollout-identity-mismatch when the rollout has no session_meta record at
// all", › "reports usageUnavailable with no-usage-records when identity
// holds but no token_usage_record names this thread_id", › "reports
// usageUnavailable and never reads transcript_path (the parent) when
// agent_transcript_path is absent", › "reports usageUnavailable with
// rollout-path-not-absolute for a relative agent_transcript_path", › "reports
// usageUnavailable with rollout-path-unc for a UNC-shaped
// agent_transcript_path", › "reports usageUnavailable, never following it,
// when agent_transcript_path is a symlink to a real usage-bearing rollout",
// › "reports usageUnavailable when agent_transcript_path is a FIFO — mkfifo
// is POSIX-only, so this is skipped on win32", › "reports usageUnavailable
// when agent_transcript_path names a file that does not exist", › "reports
// usageUnavailable with transcript-empty for a zero-byte rollout", › "reports
// usageUnavailable with transcript-malformed-line for a malformed JSON line
// anywhere in the rollout", › "reports usageUnavailable with
// transcript-line-too-large, with no partial numbers, when a single line
// exceeds 8 MiB", › "reports usageUnavailable with transcript-too-large, with
// no partial numbers, when the rollout exceeds 32 MiB total", › "reports
// transcript-timeout when an injected clock crosses the 3 s bound between two
// read chunks", › "reports usageUnavailable with invalid-usage-counter for a
// negative thread_token_usage counter, not a partial record", › "reports
// usageUnavailable with invalid-usage-counter for a fractional
// thread_token_usage counter, not a partial record", › "never carries the
// rollout path, the padding/canary content, or turn_token_usage/usage (the
// non-cumulative fields) in the journal record", › "still sums
// input/output tokens from a Claude transcript on --harness=claude,
// unaffected by the Codex rollout reader" (this last one the Claude
// regression the same file also pins), and — the token-report.mjs
// end-to-end read of a Codex dispatch-end — › "shows the Codex usage and the
// "usage measured; monetary cost unavailable" money line for a run with a
// measured dispatch-end".
//
// RP-227's forked-identity, no-usage-counters and mixed-separator-UNC fixes
// are pinned in dispatch-usage-codex.test.ts (absent in a generated rig) ›
// "identifies a forked child rollout from its FIRST session_meta record (the
// child's own, carrying forked_from_id/parent_thread_id) — not the parent's second
// record", › "reports usageUnavailable with rollout-identity-mismatch when
// the FIRST session_meta does not match agent_id, even when a LATER
// session_meta does", › "reports usageUnavailable (no usage key at all) when
// the matched token_usage_record has no thread_token_usage field", › "reports
// usageUnavailable (no usage key at all) when thread_token_usage is null", ›
// "reports usageUnavailable (no usage key at all) when thread_token_usage is
// an empty object", › "reports usageUnavailable (no usage key at all) when
// thread_token_usage is not an object (a string)", › "pins the specific
// reason code no-usage-counters (distinct from no-usage-records, which means
// "never matched at all")", › "reports usageUnavailable with rollout-path-unc
// for a mixed-separator UNC path (leading "/\\\\") — never opens anything",
// and › "reports usageUnavailable with rollout-path-unc for a
// mixed-separator UNC path (leading "\\\\/") — never opens anything".
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHookInput } from './lib/hook-input.mjs';
import { recordEvent, readRun } from '../scripts/run-journal.mjs';
import { FLAG_BASENAME, readUnattended, unattendedFlags } from '../scripts/unattended-flag.mjs';

/** The one allowlist a record's `data` may carry — see the header. */
export const DISPATCH_FIELDS = Object.freeze([
  'schema',
  'harness',
  'controller',
  'agentType',
  'agentRef',
  'declaredModel',
  'declaredEffort',
  'declaredSource',
  'usage',
  'usageUnavailable',
  'measuredModel',
  'orphan',
]);

/** A narrow, allowlisted shape for an agent type — never echoed unless it matches. */
const AGENT_TYPE_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** A narrow, allowlisted shape for `measuredModel` — never echoed unless it matches. */
const MEASURED_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
const MAX_MEASURED_MODEL_LENGTH = 128;

/** The `effort:`/`model_reasoning_effort` values this hook will ever declare. */
const DECLARED_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** How much of a definition file this hook reads — small, and bounded. */
const MAX_DEFINITION_BYTES = 8 * 1024;

/** Open without blocking a FIFO, exactly as the sibling routing guard does. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/**
 * Any leading pair of path separators, `\` and `/` in any mix — UNC-shaped,
 * refused before any fs call, for BOTH the Claude transcript path and the
 * Codex rollout path. Win32 treats `\` and `/` as the same separator, so
 * `/\host\share\...` and `\/host/share/...` resolve to `\\?\UNC\...` exactly
 * as `\\host\share\...` and `//host/share/...` do; a regex matching only the
 * two same-character pairs let both mixed forms through to
 * `lstatSync`/`openSync`.
 */
const UNC_PATH_RE = /^[\\/]{2}/;

/**
 * `ref(runDir, x) = sha256(basename(runDir) + "\0" + x).slice(0, 16)` — the
 * one hash both `controller` and `agentRef` go through, so neither carries the
 * raw id it stands in for.
 */
const ref = (runDir, value) =>
  createHash('sha256')
    .update(`${path.basename(runDir)}\0${value}`)
    .digest('hex')
    .slice(0, 16);

/** `RIG_RUN_DIR` when declared, else the armed unattended flag's own `runDir`; else `null`. */
function resolveRunDir(env) {
  const declared = env.RIG_RUN_DIR;
  if (typeof declared === 'string' && declared.trim() !== '') return declared;
  const flag = readUnattended(env);
  if (flag && flag.on === true && typeof flag.runDir === 'string' && flag.runDir.trim() !== '') {
    return flag.runDir;
  }
  return null;
}

// RP-287 — a checkout with no armed flag of its own, next to ANOTHER
// checkout's armed one, is not silence. See the header for the full design;
// this is the bounded probe and the one-line notice it may print.

/**
 * How many directory entries this probe examines — bounded, never unbounded
 * work. Exported so a test can pin the production value directly rather than
 * trusting a call site to pass it correctly (RP-294 round 3) — see
 * `anotherCheckoutFlagIsPresent`'s own doc comment.
 */
export const MAX_HOME_ENTRIES_EXAMINED = 1024;

/** The longest stderr notice this probe ever writes — bounded, per the header. */
const MAX_NOTICE_LENGTH = 512;

/**
 * Every character this hook strips from the checked root before it is ever
 * formatted into the RP-287 mismatch notice, so the notice always stays one
 * line. RP-294 round 3
 * (a security-scanner SHIP-with-advisory finding at ac42ae4) replaced the
 * round-1/round-2 approach — an explicit, enumerated range list — with
 * Unicode GENERAL CATEGORIES, because enumeration kept missing individual
 * invisible-rendering characters one at a time (round 1: C1, U+2028/U+2029;
 * round 2: bidi-control/zero-width; round 3: SOFT HYPHEN, CGJ, VS16, a tag
 * character, HANGUL FILLER — five more the range-list approach had not
 * named yet). The class:
 *
 *   `\p{Cc}` — every C0 control (`\x00`-`\x1f`, including ESC), DEL
 *     (`\x7f`), and C1 control (`\x80`-`\x9f`, including CSI `\x9b`);
 *   `\p{Cf}` — format characters: ALM, the zero-width range U+200B-U+200F,
 *     the bidi-embedding/override range U+202A-U+202E, the word-joiner/
 *     isolate range U+2060-U+2069, BOM (U+FEFF), SOFT HYPHEN (U+00AD), and
 *     the assigned "Trojan Source" tag characters (U+E0001, U+E0020-U+E007F);
 *   `\p{Zl}`/`\p{Zp}` — the Unicode line/paragraph separators (U+2028/
 *     U+2029);
 *   plus SEVEN characters that render just as invisibly but sit OUTSIDE
 *     those categories in at least one Unicode version this hook may run
 *     under, added explicitly rather than assumed covered: the four Hangul
 *     filler characters (U+115F, U+1160, U+3164, U+FFA0 — category `Lo`,
 *     not `Cf`), the variation-selector range U+FE00-U+FE0F (category
 *     `Mn`, not `Cf` — VS16, U+FE0F, is the representative case tested),
 *     MONGOLIAN VOWEL SEPARATOR (U+180E — `Cf` only in older Unicode
 *     versions), and COMBINING GRAPHEME JOINER (U+034F — category `Mn`,
 *     not `Cf`).
 *
 * See dispatch-journal.test.ts (absent in a generated rig) › "the mismatch
 * notice sanitises C1 controls and the Unicode line/paragraph separators,
 * not just C0/DEL" (round 1), › "the mismatch notice sanitises bidi-control
 * and zero-width characters (RP-294 round 2, security advisory)" (round 2),
 * and › "the mismatch notice sanitises further invisible-rendering
 * characters: SHY, CGJ, VS16, a tag character, and HANGUL FILLER (RP-294
 * round 3, security advisory)" (round 3, this rewrite).
 */
// Every codepoint below is a deliberately independent class member (Unicode categories
// plus explicit invisible-rendering exceptions the categories miss); none are meant to
// compose into one visual grapheme together, which is exactly the mistake this rule
// otherwise guards against.
const CONTROL_CHARS_RE =
  // eslint-disable-next-line no-misleading-character-class -- see the comment above
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{FE00}-\u{FE0F}\u{180E}\u{034F}]/gu;

/** `-loop-UNATTENDED` — the fixed suffix `scopedBasename` in `unattended-flag.mjs` inserts an id before. */
const SCOPED_FLAG_SUFFIX = '-loop-UNATTENDED';

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The one home this probe ever looks at: `env.HOME` (POSIX) or
 * `env.USERPROFILE` (Windows), whichever `stop-flag.mjs`'s own `homesOf`
 * would derive its env-based candidate from — trimmed, and `null` when `env`
 * declares neither. Deliberately never falls through to `os.homedir()` or
 * `os.userInfo().homedir`: both ignore `env` and can resolve the real machine
 * home even when the caller declared an isolated one, which is exactly the
 * source of the flakiness this probe must not have (see the header).
 */
function envHomeOf(env) {
  const home = typeof env.HOME === 'string' ? env.HOME.trim() : '';
  if (home !== '') return home;
  const userProfile = typeof env.USERPROFILE === 'string' ? env.USERPROFILE.trim() : '';
  return userProfile !== '' ? userProfile : null;
}

/**
 * The checkout-scoped flag basename shape — `<prefix>-<16 hex>-loop-UNATTENDED`
 * — derived from `unattended-flag.mjs`'s own exported `FLAG_BASENAME` rather
 * than a second copy of the prefix (`invariants.md`, "one spelling of a
 * fact"). Matches only that exact shape: neither the unscoped kill switch
 * (`…-loop-STOP`) nor an unrelated file in the same directory.
 */
const SCOPED_FLAG_BASENAME_RE = (() => {
  const prefix = FLAG_BASENAME.endsWith(SCOPED_FLAG_SUFFIX)
    ? FLAG_BASENAME.slice(0, -SCOPED_FLAG_SUFFIX.length)
    : FLAG_BASENAME;
  return new RegExp(`^${escapeRegExp(prefix)}-[0-9a-f]{16}${escapeRegExp(SCOPED_FLAG_SUFFIX)}$`);
})();

/**
 * The bounded-scan DECISION (RP-294 round 2, B3), extracted into a small,
 * exported, pure function so its cap boundary is provable outright rather
 * than only observable through directory-enumeration order (filesystem-
 * defined, and therefore not something a black-box test can control). Pulls
 * at most `cap` items from `names` — via one `.next()` call per item examined,
 * never more — and returns the first one `isForeign` accepts, or `undefined`
 * once either `names` is exhausted or `cap` items have been examined,
 * whichever comes first. See dispatch-journal.test.ts (absent in a generated
 * rig) › "record-dispatch.mjs — firstForeignFlag: the bounded scan decision
 * extracted into a testable pure function (RP-294 round 2, B3)".
 */
export function firstForeignFlag(names, isForeign, cap = MAX_HOME_ENTRIES_EXAMINED) {
  const iterator = names[Symbol.iterator]();
  for (let examined = 0; examined < cap; examined += 1) {
    const { value, done } = iterator.next();
    if (done) return undefined;
    if (isForeign(value)) return value;
  }
  return undefined;
}

/**
 * A lazy generator over one already-open `opendirSync` handle's entry NAMES
 * only — never the whole `readdirSync` array — so `firstForeignFlag` pulling
 * at most `cap` items also bounds the real `readSync` calls made, not merely
 * its own loop.
 */
function* dirEntryNames(handle) {
  let entry = handle.readSync();
  while (entry !== null) {
    yield entry.name;
    entry = handle.readSync();
  }
}

/**
 * Whether a checkout-scoped unattended flag OTHER than this checkout's own is
 * present in `envHomeOf(env)`'s `.claude` directory — a counted
 * `opendirSync`/`readSync` walk (never a file open, never a content read,
 * never an unbounded `readdirSync` array), matched only against
 * `SCOPED_FLAG_BASENAME_RE`, with entries examined capped at
 * `MAX_HOME_ENTRIES_EXAMINED` (via `firstForeignFlag` over `dirEntryNames`)
 * and the directory handle always closed via `closeSync` in `finally`. `env`
 * declaring no home means nothing is scanned. Never reports which other
 * checkout it saw.
 *
 * `deps.opendir` (default `opendirSync`) is the ONE seam this function takes
 * a real filesystem call through — exported, with the seam, so a test can
 * prove the PRODUCTION call site itself stays capped at
 * `MAX_HOME_ENTRIES_EXAMINED` (a fake directory handle with entries the test
 * fully controls, counting real `readSync` calls made) rather than only
 * proving `firstForeignFlag` is bounded in isolation, which a call site could
 * silently stop honouring (e.g. passing `Infinity`) without any existing test
 * noticing (RP-294 round 3). See dispatch-journal.test.ts (absent in a
 * generated rig) › "record-dispatch.mjs — anotherCheckoutFlagIsPresent: the
 * PRODUCTION wiring is bounded, not merely firstForeignFlag in isolation
 * (RP-294 round 3)".
 */
export function anotherCheckoutFlagIsPresent(env, { opendir = opendirSync } = {}) {
  const home = envHomeOf(env);
  if (home === null) return false;
  const own = new Set(unattendedFlags(env));
  const dir = path.join(home, '.claude');
  let handle;
  try {
    handle = opendir(dir);
  } catch {
    return false;
  }
  try {
    const isForeign = (name) =>
      SCOPED_FLAG_BASENAME_RE.test(name) && !own.has(path.join(dir, name));
    return firstForeignFlag(dirEntryNames(handle), isForeign, MAX_HOME_ENTRIES_EXAMINED) !== undefined;
  } finally {
    try {
      handle.closeSync();
    } catch {
      // nothing left to release
    }
  }
}

/** `CLAUDE_PROJECT_DIR` when declared, else `process.cwd()` — the root this hook checked, and the only thing the notice ever names. */
function checkedRootOf(env) {
  const declared = typeof env.CLAUDE_PROJECT_DIR === 'string' ? env.CLAUDE_PROJECT_DIR.trim() : '';
  return declared !== '' ? declared : process.cwd();
}

/**
 * The one bounded (<=512 chars) `record-dispatch:` stderr line this hook ever
 * writes — naming only the root it checked, never another checkout's runDir
 * or flag content. The root is sanitised first through `CONTROL_CHARS_RE` —
 * a Unicode-general-category-based class (`\p{Cc}\p{Cf}\p{Zl}\p{Zp}`, plus a
 * handful of characters that render just as invisibly but sit outside those
 * categories) — see that constant's own doc comment for exactly what it
 * strips — each becoming `?`, so a root path carrying one can never split
 * this into more than the one line the tests require.
 */
function writeMismatchNotice(env) {
  const root = checkedRootOf(env).replace(CONTROL_CHARS_RE, '?');
  const message =
    `record-dispatch: no unattended flag is armed for this checkout (${root}); ` +
    'dispatch was not recorded. Start the controller from the checkout whose own run directory it declares.';
  const bounded = message.length > MAX_NOTICE_LENGTH ? message.slice(0, MAX_NOTICE_LENGTH) : message;
  process.stderr.write(`${bounded}\n`);
}

/** `'claude'`/`'codex'` from an explicit `--harness=` flag; never guessed, and never anything else. */
function harnessOf(argv) {
  for (const arg of argv) {
    if (arg === '--harness=claude') return 'claude';
    if (arg === '--harness=codex') return 'codex';
  }
  return null;
}

/** The first `MAX_DEFINITION_BYTES` of a regular file, or `null` when it cannot be read. */
function readDefinitionHead(file) {
  let fd;
  try {
    fd = openSync(file, OPEN_FLAGS);
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(MAX_DEFINITION_BYTES);
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(fd, buffer, filled, buffer.length - filled, null);
      if (read === 0) break;
      filled += read;
    }
    return buffer.subarray(0, filled).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // nothing left to release
      }
    }
  }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/;

/** `{ model?, effort? }` read from a Claude agent definition's frontmatter. */
function claudeDeclaredFields(text) {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const match = FRONTMATTER.exec(stripped);
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (key !== 'model' && key !== 'effort') continue;
    fields[key] = line.slice(separator + 1).trim();
  }
  return fields;
}

const TOML_FIELD = /^(model|model_reasoning_effort)\s*=\s*"([^"]*)"\s*$/;

/** `{ model?, effort? }` read from a Codex agent profile's `model`/`model_reasoning_effort`. */
function codexDeclaredFields(text) {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const fields = {};
  for (const rawLine of stripped.split(/\r?\n/)) {
    const match = TOML_FIELD.exec(rawLine.trim());
    if (!match) continue;
    if (match[1] === 'model') fields.model = match[2];
    else fields.effort = match[2];
  }
  return fields;
}

/** `{ model?, effort? }` for `agentType`, from the definition file the harness names; `null` when unreadable. */
function definitionFields(agentType, harness, projectRoot) {
  if (harness === 'codex') {
    const text = readDefinitionHead(path.join(projectRoot, '.codex', 'agents', `${agentType}.toml`));
    return text === null ? null : codexDeclaredFields(text);
  }
  const text = readDefinitionHead(path.join(projectRoot, '.claude', 'agents', `${agentType}.md`));
  return text === null ? null : claudeDeclaredFields(text);
}

// ── Claude subagent usage capture (RP-226), on SubagentStop only ───────────
//
// See the header LIMITS for the design this section implements: the
// transcript is trusted only via `agent_transcript_path` (never the parent's
// `transcript_path`), only when its basename is exactly
// `agent-<agent_id>.jsonl` for the payload's own `agent_id`, and the read is
// bounded on three axes at once — total bytes, one line's bytes, and wall
// time. Any bound crossed, any unreadable/mismatched path, or any malformed
// JSON line anywhere in the file resolves to `usageUnavailable`, never a
// partial number — this is the fail-closed side of the fail-open guard rule
// in `.claude/rules/invariants.md`: the *read* fails closed on doubt, while
// the *hook* around it still always exits 0.

/** Transcript reader bounds — see the header LIMITS. */
const MAX_TRANSCRIPT_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_TRANSCRIPT_LINE_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_MS = 3000;
const TRANSCRIPT_READ_CHUNK_BYTES = 64 * 1024;

const USAGE_COUNTER_FIELDS = Object.freeze([
  ['input_tokens', 'inputTokens'],
  ['output_tokens', 'outputTokens'],
  ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
  ['cache_read_input_tokens', 'cacheReadInputTokens'],
]);

/**
 * The basename `agent_transcript_path` must carry to be trusted at all — the
 * payload's own `agent_id`, never any other agent's, and never the parent's
 * `transcript_path`.
 */
const expectedTranscriptBasename = (agentId) => `agent-${agentId}.jsonl`;

/**
 * The one-pass, bounded JSONL line reader both RP-226 (Claude transcript) and
 * RP-227 (Codex rollout) fold their own records through — the lstat/open/fstat
 * identity check, chunked read, carry-across-chunk partial line, and all three bounds (total
 * bytes, one line's bytes, wall time) live here exactly once. `foldLine(buf)`
 * is called with each complete line's raw bytes (no trailing newline,
 * possibly zero-length for a trailing blank line) and returns `false` for a
 * malformed line, `true` otherwise; this function never parses JSON itself.
 * Returns a short reason code on any failure, or `null` on a clean read.
 */
function readBoundedLines(file, foldLine, { now = Date.now } = {}) {
  const start = now();
  let fd;
  try {
    let lst;
    try {
      lst = lstatSync(file);
    } catch {
      return 'transcript-unreadable';
    }
    if (!lst.isFile()) return 'transcript-unreadable';

    fd = openSync(file, OPEN_FLAGS);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== lst.dev || opened.ino !== lst.ino) {
      return 'transcript-unreadable';
    }

    const chunk = Buffer.alloc(TRANSCRIPT_READ_CHUNK_BYTES);
    // The pending partial line, carried across chunk reads as a list of
    // already-copied slices plus a running byte length — never
    // re-concatenated or rescanned from its start on every chunk (one
    // forward pass). Each new chunk is scanned only for its own newlines; a
    // completed line's slices are concatenated and decoded exactly once.
    let carrySlices = [];
    let carryLength = 0;
    let totalRead = 0;
    let position = 0;

    /** Completes the pending carry with `finalSlice` (may be empty), folds it, and resets the carry. */
    const flushLine = (finalSlice) => {
      const lineBuf =
        carrySlices.length === 0
          ? finalSlice
          : finalSlice.length === 0
            ? Buffer.concat(carrySlices)
            : Buffer.concat([...carrySlices, finalSlice]);
      carrySlices = [];
      carryLength = 0;
      return foldLine(lineBuf);
    };

    for (;;) {
      if (now() - start > MAX_TRANSCRIPT_MS) return 'transcript-timeout';
      let bytesRead;
      try {
        bytesRead = readSync(fd, chunk, 0, chunk.length, position);
      } catch {
        return 'transcript-unreadable';
      }
      if (bytesRead === 0) break;
      position += bytesRead;
      totalRead += bytesRead;
      if (totalRead > MAX_TRANSCRIPT_TOTAL_BYTES) {
        return 'transcript-too-large';
      }

      let cursor = 0;
      for (;;) {
        const relative = chunk.subarray(cursor, bytesRead).indexOf(0x0a);
        if (relative === -1) break;
        const newline = cursor + relative;
        const slice = chunk.subarray(cursor, newline);
        if (carryLength + slice.length > MAX_TRANSCRIPT_LINE_BYTES) {
          return 'transcript-line-too-large';
        }
        if (!flushLine(slice)) return 'transcript-malformed-line';
        cursor = newline + 1;
      }
      if (cursor < bytesRead) {
        // Copy once: `chunk` is a fixed buffer reused by the next `readSync`.
        const remainder = Buffer.from(chunk.subarray(cursor, bytesRead));
        carryLength += remainder.length;
        if (carryLength > MAX_TRANSCRIPT_LINE_BYTES) {
          return 'transcript-line-too-large';
        }
        carrySlices.push(remainder);
      }
    }

    if (totalRead === 0) return 'transcript-empty';
    if (carryLength > MAX_TRANSCRIPT_LINE_BYTES) {
      return 'transcript-line-too-large';
    }
    if (!flushLine(Buffer.alloc(0))) return 'transcript-malformed-line';

    return null;
  } catch {
    return 'transcript-unreadable';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // nothing left to release
      }
    }
  }
}

/**
 * Reads one Claude subagent transcript, bounded as the header states, and
 * returns either `{ usage, measuredModel? }` or `{ usageUnavailable: <short
 * reason code> }`. Never returns or logs the path or any message content —
 * only aggregated numbers, a model string already present verbatim in the
 * transcript (and only when it passes `MEASURED_MODEL_RE`), or a short
 * static reason code.
 *
 * `now` defaults to `Date.now` and is the only source of wall-clock reads in
 * this function — the test suite injects a fake one to drive the 3s bound
 * (`MAX_TRANSCRIPT_MS`) deterministically, with no real sleep.
 */
export function readClaudeTranscriptUsage(file, { now = Date.now } = {}) {
  const usageByKey = new Map();
  const models = new Set();

  /** Parses and folds one complete line (no trailing newline) into the accumulators. */
  const foldLine = (lineBuf) => {
    if (lineBuf.length === 0) return true;
    let record;
    try {
      record = JSON.parse(lineBuf.toString('utf8'));
    } catch {
      return false;
    }
    if (record === null || typeof record !== 'object' || record.type !== 'assistant') return true;
    const message = record.message;
    if (message === null || typeof message !== 'object') return true;
    if (typeof message.model === 'string') models.add(message.model);
    const usage = message.usage;
    if (usage === null || typeof usage !== 'object') return true;
    const requestId = typeof record.requestId === 'string' ? record.requestId : undefined;
    const messageId = typeof message.id === 'string' ? message.id : undefined;
    const key = requestId ?? messageId;
    if (key === undefined) return true;
    usageByKey.set(key, usage); // last occurrence for this key wins
    return true;
  };

  const errorCode = readBoundedLines(file, foldLine, { now });
  if (errorCode) return { usageUnavailable: errorCode };

  if (usageByKey.size === 0) return { usageUnavailable: 'no-usage-records' };

  const usage = { evidenceSource: 'claude-subagent-transcript', requests: usageByKey.size };
  for (const [rawKey, outKey] of USAGE_COUNTER_FIELDS) {
    let present = false;
    let sum = 0;
    for (const raw of usageByKey.values()) {
      const value = raw?.[rawKey];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < 0) {
        return { usageUnavailable: 'invalid-usage-counter' };
      }
      present = true;
      sum += value;
    }
    if (present) usage[outKey] = sum;
  }

  const result = { usage };
  if (models.size === 1) {
    const candidate = [...models][0];
    if (candidate.length <= MAX_MEASURED_MODEL_LENGTH && MEASURED_MODEL_RE.test(candidate)) {
      result.measuredModel = candidate;
    }
  }
  return result;
}

/**
 * `{ usage }` or `{ usageUnavailable }` for one `SubagentStop` payload's
 * Claude transcript — a UNC-shaped path is refused first (reusing the
 * Codex path's `UNC_PATH_RE`), then a non-absolute path, then the basename
 * binding, all before any file is even opened; `transcript_path` (the
 * parent's) is never consulted.
 */
function claudeUsageOf(input, agentId) {
  const transcriptPath = input.agent_transcript_path;
  if (typeof transcriptPath !== 'string' || transcriptPath.trim() === '') {
    return { usageUnavailable: 'transcript-path-missing' };
  }
  if (UNC_PATH_RE.test(transcriptPath)) {
    return { usageUnavailable: 'transcript-path-unc' };
  }
  if (!path.isAbsolute(transcriptPath)) {
    return { usageUnavailable: 'transcript-path-not-absolute' };
  }
  if (path.basename(transcriptPath) !== expectedTranscriptBasename(agentId)) {
    return { usageUnavailable: 'transcript-path-mismatch' };
  }
  return readClaudeTranscriptUsage(transcriptPath);
}

// ── Codex subagent usage capture (RP-227), on SubagentStop only ────────────
//
// See the header's CODEX USAGE CAPTURE section. A Codex rollout is JSONL
// exactly as a Claude transcript is, so this reuses `readBoundedLines` for
// the read itself and RP-226's own reason codes for every bound it shares;
// only the identity check and the record shapes it folds are new.

/** `input_tokens`/`cached_input_tokens`/`output_tokens`/`reasoning_output_tokens`
 * (a Codex rollout's `thread_token_usage`) → this hook's own field names —
 * exactly the four fields `token-report.mjs`'s `codexUsageOf` already sums. */
const CODEX_USAGE_COUNTER_FIELDS = Object.freeze([
  ['input_tokens', 'inputTokens'],
  ['cached_input_tokens', 'cachedInputTokens'],
  ['output_tokens', 'outputTokens'],
  ['reasoning_output_tokens', 'reasoningOutputTokens'],
]);

/**
 * Reads one Codex rollout, bounded exactly as `readClaudeTranscriptUsage` is,
 * and returns either `{ usage }` or `{ usageUnavailable: <short reason
 * code> }`. `agentId` is the dispatch's own `agent_id` — the rollout's
 * `session_meta.payload.id` must equal it (a rollout with no `session_meta`
 * record at all is the same failure: `'rollout-identity-mismatch'`), and only
 * the LAST `token_usage_record` whose `payload.thread_id === agentId` is
 * read; its `thread_token_usage` (the cumulative total) is mapped, never
 * summed across records. Never returns or logs the path or any rollout
 * content — only aggregated numbers or a short static reason code.
 *
 * `now` defaults to `Date.now`, exactly as `readClaudeTranscriptUsage` — the
 * test suite injects a fake one to drive the shared 3s bound deterministically.
 */
export function readCodexRolloutUsage(file, agentId, { now = Date.now } = {}) {
  let sessionMetaSeen = false;
  let sessionMetaId;
  let matched = false;
  let lastThreadTokenUsage = {};

  const foldLine = (lineBuf) => {
    if (lineBuf.length === 0) return true;
    let record;
    try {
      record = JSON.parse(lineBuf.toString('utf8'));
    } catch {
      return false;
    }
    if (record === null || typeof record !== 'object') return true;
    if (record.type === 'session_meta') {
      // The FIRST session_meta record wins, never a later one — a forked
      // child rollout carries the child's OWN session_meta first and the
      // PARENT's second; once one has been read, every later session_meta
      // line is inert, even a malformed one.
      if (!sessionMetaSeen) {
        sessionMetaSeen = true;
        const payload = record.payload;
        if (payload !== null && typeof payload === 'object' && typeof payload.id === 'string') {
          sessionMetaId = payload.id;
        }
      }
      return true;
    }
    if (record.type === 'token_usage_record') {
      const payload = record.payload;
      if (payload !== null && typeof payload === 'object' && payload.thread_id === agentId) {
        matched = true;
        const threadTokenUsage = payload.thread_token_usage;
        // thread_token_usage is the thread's cumulative total, so the LAST
        // matching record replaces (never sums with) the previous one.
        lastThreadTokenUsage =
          threadTokenUsage !== null && typeof threadTokenUsage === 'object' ? threadTokenUsage : {};
      }
      return true;
    }
    return true;
  };

  const errorCode = readBoundedLines(file, foldLine, { now });
  if (errorCode) return { usageUnavailable: errorCode };

  if (sessionMetaId === undefined || sessionMetaId !== agentId) {
    return { usageUnavailable: 'rollout-identity-mismatch' };
  }
  if (!matched) return { usageUnavailable: 'no-usage-records' };

  const usage = { evidenceSource: 'codex-subagent-rollout' };
  let anyCounter = false;
  for (const [rawKey, outKey] of CODEX_USAGE_COUNTER_FIELDS) {
    const value = lastThreadTokenUsage[rawKey];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) {
      return { usageUnavailable: 'invalid-usage-counter' };
    }
    usage[outKey] = value;
    anyCounter = true;
  }
  // A matched record whose thread_token_usage is absent, null, {}, or not an
  // object normalises to {} above, so this loop finds nothing — that must
  // never read as "measured": `'usage' in data` is exactly what a caller
  // checks.
  if (!anyCounter) return { usageUnavailable: 'no-usage-counters' };
  return { usage };
}

/**
 * `{ usage }` or `{ usageUnavailable }` for one `SubagentStop` payload's
 * Codex rollout — the path is refused before any file is even opened
 * (missing or empty, UNC-shaped, not absolute, in that order), and
 * `transcript_path` (the parent's) is never consulted.
 *
 * The UNC check runs BEFORE `path.isAbsolute` and independently of its
 * result: `path.isAbsolute` is platform-native, and on POSIX a
 * mixed-separator UNC path like
 * `\/host/share/...` is NOT absolute (it does not start with `/`), which
 * would let it fall through as `rollout-path-not-absolute` — the wrong
 * refusal, and one that implies the UNC check never ran — if absoluteness
 * were checked first.
 */
function codexUsageOf(input, agentId) {
  const rolloutPath = input.agent_transcript_path;
  if (typeof rolloutPath !== 'string' || rolloutPath.trim() === '') {
    return { usageUnavailable: 'transcript-path-missing' };
  }
  if (UNC_PATH_RE.test(rolloutPath)) {
    return { usageUnavailable: 'rollout-path-unc' };
  }
  if (!path.isAbsolute(rolloutPath)) {
    return { usageUnavailable: 'rollout-path-not-absolute' };
  }
  return readCodexRolloutUsage(rolloutPath, agentId);
}

// ── Orphan dispatch-end detection (RP-294) ──────────────────────────────────
//
// See the header's ORPHAN DISPATCH-ENDS section. Bounded on TWO axes, in
// this order, never by time: a byte-size gate (`MAX_ORPHAN_CHECK_BYTES`),
// checked via `statSync` BEFORE either journal file is ever opened for this
// check, then — only once both files pass that gate — an event-count guard
// (`MAX_ORPHAN_CHECK_EVENTS`) applied to what `readRun` returns. `null`
// (unknown) is returned on either bound, rather than a guess either way. See
// dispatch-journal.test.ts (absent in a generated rig) ›
// "record-dispatch.mjs — the orphan check is bounded by file size, not
// merely by event count after an unbounded read (RP-294 round 2, B1)".

/**
 * The largest either journal file (`events.jsonl`, `decisions.jsonl`) may be
 * for this hook's orphan check to read it at all — ~4 MiB. `statSync` runs
 * BEFORE any read, so a run whose journal has grown past this bound is never
 * opened for this check: `readRun` is not called at all. A run past this
 * size leaves `orphan` absent (the previous behaviour) rather than reading
 * further.
 */
const MAX_ORPHAN_CHECK_BYTES = 4 * 1024 * 1024;

/**
 * How many events in the run's own journal this hook's orphan check will
 * ever look at — the SECOND bound, applied only once both files already
 * passed `MAX_ORPHAN_CHECK_BYTES` above. A run past this count leaves
 * `orphan` absent (the previous behaviour) rather than scanning further.
 */
const MAX_ORPHAN_CHECK_EVENTS = 4096;

/**
 * The byte size of `file`, or `0` when it does not exist yet — a run's
 * `events.jsonl`/`decisions.jsonl` genuinely may not exist before this run's
 * first record, and that is an empty journal, not a failure. Any OTHER stat
 * failure (permissions, and the like) propagates to the caller, which is
 * already wrapped in `hasEarlierDispatchStart`'s own `try`/`catch` and
 * resolves to `null` exactly like any other read failure.
 */
function journalFileSize(file) {
  try {
    return statSync(file).size;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

/**
 * Whether `agentRef` has an earlier `dispatch-start` recorded anywhere in
 * this run's own journal, checked just before writing a `dispatch-end`
 * record — `true`/`false` when the read succeeded and stayed within both
 * bounds, `null` ("unknown, do not guess") when either journal file is
 * larger than `MAX_ORPHAN_CHECK_BYTES` (checked first, before either file is
 * opened), the run's events exceed `MAX_ORPHAN_CHECK_EVENTS` (checked second,
 * against what `readRun` returns), or `readRun`/`statSync` throws for any
 * other reason (a missing run directory, an unreadable journal, anything
 * else). A caller must mark `orphan: true` only on an explicit `false` here
 * — never on `null`.
 */
function hasEarlierDispatchStart(runDir, agentRef) {
  try {
    const eventsBytes = journalFileSize(path.join(runDir, 'events.jsonl'));
    const decisionsBytes = journalFileSize(path.join(runDir, 'decisions.jsonl'));
    if (eventsBytes > MAX_ORPHAN_CHECK_BYTES || decisionsBytes > MAX_ORPHAN_CHECK_BYTES) {
      return null;
    }
    const { events } = readRun({ runDir });
    if (events.length > MAX_ORPHAN_CHECK_EVENTS) return null;
    return events.some(
      (event) => event.kind === 'dispatch-start' && event.data?.agentRef === agentRef,
    );
  } catch {
    return null;
  }
}

function main() {
  try {
    const input = readHookInput();
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return 0;

    const eventName = input.hook_event_name;
    if (eventName !== 'SubagentStart' && eventName !== 'SubagentStop') return 0;

    const agentId = input.agent_id;
    if (typeof agentId !== 'string') return 0;

    const runDir = resolveRunDir(process.env);
    if (!runDir) {
      try {
        if (anotherCheckoutFlagIsPresent(process.env)) writeMismatchNotice(process.env);
      } catch {
        // RP-287's probe is observe-only too: a broken check must never
        // block or crash this hook.
      }
      return 0;
    }

    const harness = harnessOf(process.argv.slice(2));
    const kind = eventName === 'SubagentStart' ? 'dispatch-start' : 'dispatch-end';

    const data = { schema: 1 };
    if (harness) data.harness = harness;
    if (harness === 'claude' && typeof input.session_id === 'string') {
      data.controller = ref(runDir, input.session_id);
    }

    const rawAgentType = input.agent_type;
    const agentType =
      typeof rawAgentType === 'string' && AGENT_TYPE_RE.test(rawAgentType) ? rawAgentType : null;
    if (agentType) data.agentType = agentType;

    data.agentRef = ref(runDir, agentId);

    // RP-294 round 2, B4: BOTH conditions, not "no start" alone — see the
    // header's ORPHAN DISPATCH-ENDS section for why `agentType === null` is
    // checked first (cheap, and skips the bounded journal read entirely for
    // every ordinary end that carries a real agent_type).
    if (
      kind === 'dispatch-end' &&
      agentType === null &&
      hasEarlierDispatchStart(runDir, data.agentRef) === false
    ) {
      data.orphan = true;
    }

    if (agentType) {
      const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
      const declared = definitionFields(agentType, harness, projectRoot);
      if (declared) {
        let sourced = false;
        if (typeof declared.model === 'string' && declared.model.trim() !== '') {
          data.declaredModel = declared.model.trim();
          sourced = true;
        }
        if (typeof declared.effort === 'string' && DECLARED_EFFORTS.has(declared.effort.trim())) {
          data.declaredEffort = declared.effort.trim();
          sourced = true;
        }
        if (sourced) data.declaredSource = 'agent-definition';
      }
    }

    if (eventName === 'SubagentStop' && (harness === 'claude' || harness === 'codex')) {
      const usageResult =
        harness === 'claude' ? claudeUsageOf(input, agentId) : codexUsageOf(input, agentId);
      if (usageResult.usageUnavailable) {
        data.usageUnavailable = usageResult.usageUnavailable;
      } else {
        data.usage = usageResult.usage;
        if (usageResult.measuredModel !== undefined) data.measuredModel = usageResult.measuredModel;
      }
    }

    try {
      const bounded = Object.fromEntries(
        Object.entries(data).filter(([key]) => DISPATCH_FIELDS.includes(key)),
      );
      recordEvent({ runDir, kind, data: bounded, now: new Date().toISOString() });
    } catch {
      // Every `RunJournalError` (undeclared, missing, ended, unusable, busy) is
      // swallowed here on purpose — this hook is observe-only, and a lost
      // record costs the trace, never the session.
    }
  } catch {
    // A broken observation must never make the session unusable.
  }
  return 0;
}

/**
 * Whether this file is being run as a script rather than imported — the
 * realpath on both sides, as `inject-rules.mjs` explains, so a symlinked
 * checkout still runs.
 */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
}

if (invokedDirectly()) {
  process.exit(main());
}
