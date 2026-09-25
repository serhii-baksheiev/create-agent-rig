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
// `transcript_path` (the parent's) — and only when its basename is exactly
// `agent-<agent_id>.jsonl` for the payload's OWN `agent_id`; any other
// basename, or a missing/empty path, resolves to `usageUnavailable` without
// opening anything. The read itself is bounded on three axes at once: at
// most 32 MiB read in total, at most 8 MiB in one line, at most 3s wall
// time (checked between chunks) — a fixed-size buffer on an
// `O_RDONLY|O_NONBLOCK` handle opened after an `lstatSync`/`fstatSync`
// `isFile()` check. Crossing ANY bound, an unreadable file, an empty
// transcript, a transcript with no usage-bearing assistant record, an
// out-of-range counter, or a single malformed JSON line ANYWHERE in the
// transcript makes the whole dispatch `usageUnavailable: '<short reason
// code>'` (`transcript-unreadable`, `transcript-path-missing`,
// `transcript-path-mismatch`, `transcript-too-large`,
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
// `usage.evidenceSource` is always `'claude-subagent-transcript'`. Codex is
// untouched by this section — see RP-227.
//
// The reader is exported as `readClaudeTranscriptUsage(file, { now } = {})`,
// `now` defaulting to `Date.now` and gating every wall-clock read inside it,
// so the 3s bound can be driven deterministically from a test with no real
// sleep. Importing this module for that export (or for `DISPATCH_FIELDS`)
// never runs `main()` — see `invokedDirectly()` below.
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
//   - **`usage`/`usageUnavailable`/`measuredModel` are Claude-only.** Codex
//     dispatches carry neither key — the Codex projection of this hook is
//     unchanged by RP-226 (RP-227 is its own ticket).
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
// records disagree on the model", › "does not attempt usage capture on
// Codex — neither usage nor usageUnavailable appears", › "reports
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
  const start = now();
  let fd;
  try {
    let lst;
    try {
      lst = lstatSync(file);
    } catch {
      return { usageUnavailable: 'transcript-unreadable' };
    }
    if (!lst.isFile()) return { usageUnavailable: 'transcript-unreadable' };

    fd = openSync(file, OPEN_FLAGS);
    if (!fstatSync(fd).isFile()) return { usageUnavailable: 'transcript-unreadable' };

    const usageByKey = new Map();
    const models = new Set();
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
      if (now() - start > MAX_TRANSCRIPT_MS) return { usageUnavailable: 'transcript-timeout' };
      let bytesRead;
      try {
        bytesRead = readSync(fd, chunk, 0, chunk.length, position);
      } catch {
        return { usageUnavailable: 'transcript-unreadable' };
      }
      if (bytesRead === 0) break;
      position += bytesRead;
      totalRead += bytesRead;
      if (totalRead > MAX_TRANSCRIPT_TOTAL_BYTES) {
        return { usageUnavailable: 'transcript-too-large' };
      }

      let cursor = 0;
      for (;;) {
        const relative = chunk.subarray(cursor, bytesRead).indexOf(0x0a);
        if (relative === -1) break;
        const newline = cursor + relative;
        const slice = chunk.subarray(cursor, newline);
        if (carryLength + slice.length > MAX_TRANSCRIPT_LINE_BYTES) {
          return { usageUnavailable: 'transcript-line-too-large' };
        }
        if (!flushLine(slice)) return { usageUnavailable: 'transcript-malformed-line' };
        cursor = newline + 1;
      }
      if (cursor < bytesRead) {
        // Copy once: `chunk` is a fixed buffer reused by the next `readSync`.
        const remainder = Buffer.from(chunk.subarray(cursor, bytesRead));
        carryLength += remainder.length;
        if (carryLength > MAX_TRANSCRIPT_LINE_BYTES) {
          return { usageUnavailable: 'transcript-line-too-large' };
        }
        carrySlices.push(remainder);
      }
    }

    if (totalRead === 0) return { usageUnavailable: 'transcript-empty' };
    if (carryLength > MAX_TRANSCRIPT_LINE_BYTES) {
      return { usageUnavailable: 'transcript-line-too-large' };
    }
    if (!flushLine(Buffer.alloc(0))) return { usageUnavailable: 'transcript-malformed-line' };

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
  } catch {
    return { usageUnavailable: 'transcript-unreadable' };
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
 * `{ usage }` or `{ usageUnavailable }` for one `SubagentStop` payload's
 * Claude transcript — the basename binding is checked here, before any file
 * is even opened, and `transcript_path` (the parent's) is never consulted.
 */
function claudeUsageOf(input, agentId) {
  const transcriptPath = input.agent_transcript_path;
  if (typeof transcriptPath !== 'string' || transcriptPath.trim() === '') {
    return { usageUnavailable: 'transcript-path-missing' };
  }
  if (path.basename(transcriptPath) !== expectedTranscriptBasename(agentId)) {
    return { usageUnavailable: 'transcript-path-mismatch' };
  }
  return readClaudeTranscriptUsage(transcriptPath);
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

    if (eventName === 'SubagentStop' && harness === 'claude') {
      const usageResult = claudeUsageOf(input, agentId);
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
