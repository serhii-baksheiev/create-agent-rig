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
// The record is bounded by ONE allowlist, `DISPATCH_FIELDS`: every key is
// filtered through it immediately before the write, so a field added to the
// payload handling but not to the list never reaches the journal. It is
// exported so this hook's own test can compare it with the independent copy it
// keeps (`.claude/rules/invariants.md`, the independent-oracle
// invariant): `schema`, `harness`, `controller`, `agentType`, `agentRef`,
// `declaredModel`, `declaredEffort`, `declaredSource`, `usage`,
// `usageUnavailable`, `measuredModel`. `controller` and `agentRef` are never
// the raw `session_id`/`agent_id` — they are
// `sha256(basename(runDir) + "\0" + value).slice(0, 16)`, so the record names
// no id a reader could correlate outside this one run.
//
// CLAUDE USAGE CAPTURE (RP-226), on `SubagentStop` with `--harness=claude`
// only: this hook reads ONLY the payload's `agent_transcript_path` — never
// `transcript_path` (the parent's) — and, since round 2 (RP-227,
// security-scanner-r1.md A5), refuses a UNC-shaped path first (reusing
// `UNC_PATH_RE`, shared with the Codex path below), then requires its
// basename to be exactly `agent-<agent_id>.jsonl` for the payload's OWN
// `agent_id`; any other basename, a UNC-shaped or missing/empty path,
// resolves to `usageUnavailable` without opening anything. The read itself
// is bounded on three axes at once: at
// most 32 MiB read in total, at most 8 MiB in one line, at most 3s wall
// time (checked between chunks) — a fixed-size buffer on an
// `O_RDONLY|O_NONBLOCK` handle opened after an `lstatSync`/`fstatSync`
// `isFile()` check. Crossing ANY bound, an unreadable file, an empty
// transcript, a transcript with no usage-bearing assistant record, an
// out-of-range counter, or a single malformed JSON line ANYWHERE in the
// transcript makes the whole dispatch `usageUnavailable: '<short reason
// code>'` (`transcript-unreadable`, `transcript-path-missing`,
// `transcript-path-unc`, `transcript-path-mismatch`, `transcript-too-large`,
// `transcript-line-too-large`, `transcript-timeout`,
// `transcript-malformed-line`, `transcript-empty`, `no-usage-records`,
// `invalid-usage-counter`) — never a partial number, and the reason codes
// themselves never carry the path or any transcript content. Assistant
// records' `message.usage` counters (`input_tokens`, `output_tokens`,
// `cache_creation_input_tokens`, `cache_read_input_tokens`) are deduped by
// `requestId ?? message.id`, last occurrence per key wins, then summed;
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
// (`rollout-path-unc`; round 2, security-scanner-r1.md B1) — checked BEFORE
// and independently of `path.isAbsolute`, because a mixed-separator UNC path
// is not POSIX-absolute and would otherwise fall through as the wrong reason
// code — then not absolute (`rollout-path-not-absolute`), then an
// `lstatSync`/`fstatSync` `isFile()` check exactly as the Claude transcript
// gets (`transcript-unreadable`; a symlink, FIFO, or other non-regular file
// is refused without ever being followed). The read itself shares RP-226's
// bounded JSONL reader verbatim (`readBoundedLines`, extracted below so both
// sections call the same lstat/open/chunked-read/carry-across-chunk
// implementation once) — the same 32 MiB total / 8 MiB per line / 3s
// wall-time bounds and the same
// `transcript-too-large`/`transcript-line-too-large`/`transcript-timeout`/
// `transcript-malformed-line`/`transcript-empty` reason codes, because a
// Codex rollout is JSONL exactly as a Claude transcript is.
//
// Identity is Codex-specific: the rollout's FIRST `session_meta.payload.id`
// — never a later one — must equal the payload's own `agent_id`, or the
// whole dispatch is `usageUnavailable: 'rollout-identity-mismatch'` — a
// rollout with no `session_meta` record at all is the same failure (round 2,
// code-reviewer-r1.md B1: a Codex child spawned with forked context writes
// TWO `session_meta` records, the child's own first and the PARENT's
// second; reading the last one made every forked child mismatch). Once
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
// counter is extracted at all — is `usageUnavailable: 'no-usage-counters'`
// (round 2, code-reviewer-r1.md B2), never `usage: { evidenceSource }` with
// no counters, which would read as "measured" to any caller checking
// `'usage' in data`; a present-but-negative-or-fractional field makes the
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
//     the FIRST is read.** Measured on this machine (round 2,
//     code-reviewer-r1.md B1): a real forked child rollout, codex-cli
//     0.156.1, 2026-09-23
//     (`~/.codex/sessions/2026/09/23/rollout-2026-09-23T16-59-32-01a0ce59-....jsonl`),
//     writes the child's OWN `session_meta` (carrying `forked_from_id`/
//     `parent_thread_id`) at ordinal 0 and the PARENT's `session_meta` at
//     ordinal 1. 132 of 281 child rollouts on this machine are forked this
//     way, across codex-cli 0.148.0–0.156.1 — this is not a rare shape.
//     Reading only the first record is a deliberate choice, not an
//     unexercised gap: a rollout whose first `session_meta` does not name
//     `agent_id` is `rollout-identity-mismatch` even when a later one does.
//   - **The 3s bound is checked only between read chunks, not around the
//     whole read.** `lstatSync`, `openSync`, a single slow `readSync`, and
//     the final line's `JSON.parse` all run outside the clock; a process
//     stuck in one of those still relies on the harness's own hook timeout
//     as the real backstop (security-scanner-r1.md A5).
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
// renamed by RP-227 round 2 (prose-reviewer-r1.md, replacing a dead citation
// to the pre-RP-227 test name this same sentence used to quote) — › "does
// not apply the Claude transcript reader to a Codex dispatch — a rollout
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
// The RP-226 fix round (code-reviewer-r1.md / security-scanner-r1.md) is
// pinned in dispatch-usage.test.ts (absent in a generated rig) › "reports
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
// end-to-end read of a Codex dispatch-end, added to this citation list in
// round 2 (code-reviewer-r1.md A4) — › "shows the Codex usage and the
// "usage measured; monetary cost unavailable" money line for a run with a
// measured dispatch-end".
//
// Round 2 (RP-227, review of PR #333 head 3b82189) is pinned in
// dispatch-usage-codex.test.ts (absent in a generated rig) › "identifies a
// forked child rollout from its FIRST session_meta record (the child's own,
// carrying forked_from_id/parent_thread_id) — not the parent's second
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
  readSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHookInput } from './lib/hook-input.mjs';
import { recordEvent } from '../scripts/run-journal.mjs';
import { readUnattended } from '../scripts/unattended-flag.mjs';

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
 * `lstatSync`/`openSync` (round 2, security-scanner-r1.md B1 — proven on
 * Windows against a real `\\wsl$` share: the unfixed regex read over SMB and
 * journalled usage for both mixed spellings).
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
 * RP-227 (Codex rollout) fold their own records through — the lstat/open,
 * chunked read, carry-across-chunk partial line, and all three bounds (total
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
    if (!fstatSync(fd).isFile()) return 'transcript-unreadable';

    const chunk = Buffer.alloc(TRANSCRIPT_READ_CHUNK_BYTES);
    // The pending partial line, carried across chunk reads as a list of
    // already-copied slices plus a running byte length — never
    // re-concatenated or rescanned from its start on every chunk (one
    // forward pass; code-reviewer-r1.md B1). Each new chunk is scanned only
    // for its own newlines; a completed line's slices are concatenated and
    // decoded exactly once.
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
 * Claude transcript — a UNC-shaped path is refused first (round 2,
 * security-scanner-r1.md A5, reusing the Codex path's fixed `UNC_PATH_RE`),
 * then the basename binding, both before any file is even opened;
 * `transcript_path` (the parent's) is never consulted.
 */
function claudeUsageOf(input, agentId) {
  const transcriptPath = input.agent_transcript_path;
  if (typeof transcriptPath !== 'string' || transcriptPath.trim() === '') {
    return { usageUnavailable: 'transcript-path-missing' };
  }
  if (UNC_PATH_RE.test(transcriptPath)) {
    return { usageUnavailable: 'transcript-path-unc' };
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
      // PARENT's second (round 2, code-reviewer-r1.md B1); once one has been
      // read, every later session_meta line is inert, even a malformed one.
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
  // checks (round 2, code-reviewer-r1.md B2).
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
 * result (round 2, security-scanner-r1.md B1): `path.isAbsolute` is
 * platform-native, and on POSIX a mixed-separator UNC path like
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

function main() {
  try {
    const input = readHookInput();
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return 0;

    const eventName = input.hook_event_name;
    if (eventName !== 'SubagentStart' && eventName !== 'SubagentStop') return 0;

    const agentId = input.agent_id;
    if (typeof agentId !== 'string') return 0;

    const runDir = resolveRunDir(process.env);
    if (!runDir) return 0;

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
