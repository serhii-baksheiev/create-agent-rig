// usage-readers.mjs — the bounded, read-only usage readers the dispatch
// evidence hook (`../record-dispatch.mjs`, RP-226/RP-227) and the
// controller-session hook (`../record-session-usage.mjs`, RP-511) fold
// through. The subagent readers were extracted from `record-dispatch.mjs`
// (RP-511, PR A): their bounds, identity checks, dedupe rules and reason codes
// are the ones that hook's header LIMITS document, and that hook's own tests
// exercise them through its re-exports — test/template/dispatch-usage.test.ts (absent in a
// generated rig) › "reports transcript-timeout when an injected clock crosses
// the 3 s bound between two read chunks" calls `readClaudeTranscriptUsage`
// through `record-dispatch.mjs`. The controller readers (the RP-511 section
// below) document their own identity checks and codes there.
//
// Nothing here writes or logs; what reaches a journal is decided by the
// caller, and the hook's tests pin that neither a path nor any transcript
// content does — test/template/dispatch-usage.test.ts (absent in a generated
// rig) › "never carries the transcript path or assistant message content in
// the journal record" and test/template/dispatch-usage-codex.test.ts (absent
// in a generated rig) › "never carries the rollout path, the padding/canary
// content, or turn_token_usage/usage (the non-cumulative fields) in the
// journal record". A subagent reader returns only aggregated counters, a
// model string already present verbatim in a record, short static reason
// codes, and — RP-511 PR D — `harnessVersion` (the version string the
// subagent's own file names, only when it passes `HARNESS_VERSION_RE`) and
// `usage.partialCounters` (the names of counters some counted records omit)
// — test/template/dispatch-usage.test.ts (absent in a generated rig) ›
// "records the harness version the subagent transcript names, beside usage"
// and › "names, under usage.partialCounters, a counter present on some
// assistant records and absent on others — the sum is written, never
// silently as complete"; test/template/dispatch-usage-codex.test.ts (absent
// in a generated rig) › "records the harness version the rollout
// session_meta names as harnessVersion (RP-511 PR D)". A controller reader
// (the RP-511 section below) returns, in
// addition, `coverage` (counts and a fixed `basis` string), `harnessVersion`
// (the file's own version string, only when it passes `HARNESS_VERSION_RE`
// and every counted record agrees) and, on Claude, `sessionAggregate` — the
// `cost-state` record's per-model counters, keyed by model names that pass
// `MEASURED_MODEL_RE`, never its `costUSD` —
// test/template/session-usage.test.ts (absent in a generated rig) › "carries
// cost-state as a labelled diagnostic without costUSD, and omits a harness
// version the records disagree on" and › "binds a Codex rollout by its
// basename and reads the parent thread total with --harness=codex".
//
// The path checks are the CALLER's — these functions open whatever path
// they are handed. `record-dispatch.mjs` refuses a UNC-shaped or relative
// path before either reader opens anything, and binds a Claude transcript's
// basename to the agent id as well —
// test/template/dispatch-usage.test.ts (absent in a generated rig) › "reports
// usageUnavailable: transcript-path-unc for a UNC-shaped agent_transcript_path
// (leading "//") — never opens anything" and
// test/template/dispatch-usage-codex.test.ts (absent in a generated rig) ›
// "reports usageUnavailable with rollout-path-unc for a UNC-shaped
// agent_transcript_path". A Codex rollout is bound by its content instead,
// inside `readCodexRolloutUsage` —
// test/template/dispatch-usage-codex.test.ts (absent in a generated rig) ›
// "reports usageUnavailable with rollout-identity-mismatch when the FIRST
// session_meta does not match agent_id, even when a LATER session_meta
// does". Every other caller owns the same path checks before calling in.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';

/** A narrow, allowlisted shape for `measuredModel` — never echoed unless it matches. */
export const MEASURED_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
export const MAX_MEASURED_MODEL_LENGTH = 128;

/**
 * Any leading pair of path separators, `\` and `/` in any mix — UNC-shaped.
 * A CALLER tests a path against this before handing it to a reader here
 * (`record-dispatch.mjs` does, for both the Claude transcript path and the
 * Codex rollout path); no reader in this module applies it. Win32 treats `\` and `/` as the same separator, so
 * `/\host\share\...` and `\/host/share/...` resolve to `\\?\UNC\...` exactly
 * as `\\host\share\...` and `//host/share/...` do; a regex matching only the
 * two same-character pairs let both mixed forms through to
 * `lstatSync`/`openSync`.
 */
export const UNC_PATH_RE = /^[\\/]{2}/;

/** Open without blocking a FIFO, exactly as `../guard-subagent-model.mjs` does. */
export const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/** Transcript reader bounds — see `../record-dispatch.mjs`, header LIMITS. */
const MAX_TRANSCRIPT_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_TRANSCRIPT_LINE_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_MS = 3000;
const TRANSCRIPT_READ_CHUNK_BYTES = 64 * 1024;

export const USAGE_COUNTER_FIELDS = Object.freeze([
  ['input_tokens', 'inputTokens'],
  ['output_tokens', 'outputTokens'],
  ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
  ['cache_read_input_tokens', 'cacheReadInputTokens'],
]);

/** `version` (Claude) / `cli_version` (Codex) as written by the harness — a short, narrow shape. */
export const HARNESS_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+.][0-9A-Za-z.-]{0,32})?$/;

/** A non-negative safe integer — the only shape a counter is ever read or summed as. */
const isCounter = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * Sums `USAGE_COUNTER_FIELDS` across the deduped Claude usage records in
 * `usageByKey`. Returns `{ counters, partialCounters }` — `counters` carries a
 * field only when at least one record has it; `partialCounters` names every
 * field that SOME records carry and others omit (RP-511 PR D: such a sum is
 * still written, but never silently, so a reader can refuse to treat it as
 * complete). Returns `{ usageUnavailable }` instead when any counter is not a
 * non-negative safe integer or any accumulated sum leaves the safe-integer
 * range (`'counter-overflow'`) — never a partial or wrapped number.
 */
function summedUsageCounters(usageByKey) {
  const counters = {};
  const partialCounters = [];
  for (const [rawKey, outKey] of USAGE_COUNTER_FIELDS) {
    let present = 0;
    let sum = 0;
    for (const raw of usageByKey.values()) {
      const value = raw?.[rawKey];
      if (value === undefined) continue;
      if (!isCounter(value)) return { usageUnavailable: 'invalid-usage-counter' };
      present += 1;
      sum += value;
      if (!Number.isSafeInteger(sum)) return { usageUnavailable: 'counter-overflow' };
    }
    if (present === 0) continue;
    counters[outKey] = sum;
    if (present < usageByKey.size) partialCounters.push(outKey);
  }
  return { counters, partialCounters };
}

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
export function readBoundedLines(file, foldLine, { now = Date.now } = {}) {
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
    if (
      !opened.isFile() ||
      opened.ino !== lst.ino ||
      (process.platform !== 'win32' && opened.dev !== lst.dev)
    ) {
      return 'transcript-unreadable';
    }
    const current = lstatSync(file);
    if (!current.isFile()) {
      return 'transcript-unreadable';
    }
    const currentFd = openSync(file, OPEN_FLAGS | (constants.O_NOFOLLOW ?? 0));
    try {
      const currentOpened = fstatSync(currentFd);
      if (
        !currentOpened.isFile() ||
        currentOpened.dev !== opened.dev ||
        currentOpened.ino !== opened.ino
      ) {
        return 'transcript-unreadable';
      }
    } finally {
      closeSync(currentFd);
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
 * Reads one Claude subagent transcript, bounded as `../record-dispatch.mjs`'s
 * header LIMITS state, and
 * returns either `{ usage, measuredModel?, harnessVersion? }` or
 * `{ usageUnavailable: <short reason code> }`, where `usage` may name under
 * `partialCounters` the counters some deduped records omitted. Never returns
 * or logs the path or any message content — only aggregated numbers, a model
 * string already present verbatim in the transcript (and only when it passes
 * `MEASURED_MODEL_RE`), the transcript's own `version` string (only when it
 * passes `HARNESS_VERSION_RE` and every counted record agrees —
 * test/template/dispatch-usage.test.ts (absent in a generated rig) › "omits
 * harnessVersion when counted records disagree on the version, carry none,
 * or carry one out of shape"), or a short static reason code.
 *
 * `now` defaults to `Date.now` and is the only source of wall-clock reads in
 * this function — the test suite injects a fake one to drive the 3s bound
 * (`MAX_TRANSCRIPT_MS`) deterministically, with no real sleep.
 */
export function readClaudeTranscriptUsage(file, { now = Date.now } = {}) {
  const usageByKey = new Map();
  const models = new Set();
  const versions = new Set();

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
    if (typeof record.version === 'string') versions.add(record.version);
    usageByKey.set(key, usage); // last occurrence for this key wins
    return true;
  };

  const errorCode = readBoundedLines(file, foldLine, { now });
  if (errorCode) return { usageUnavailable: errorCode };

  if (usageByKey.size === 0) return { usageUnavailable: 'no-usage-records' };

  const summed = summedUsageCounters(usageByKey);
  if (summed.usageUnavailable) return { usageUnavailable: summed.usageUnavailable };
  const usage = {
    evidenceSource: 'claude-subagent-transcript',
    requests: usageByKey.size,
    ...summed.counters,
  };
  if (summed.partialCounters.length > 0) usage.partialCounters = summed.partialCounters;

  const result = { usage };
  if (models.size === 1) {
    const candidate = [...models][0];
    if (candidate.length <= MAX_MEASURED_MODEL_LENGTH && MEASURED_MODEL_RE.test(candidate)) {
      result.measuredModel = candidate;
    }
  }
  // The harness version every counted record agrees on — evidence for the
  // report's per-version exclusivity check, never a guess from the parent.
  if (versions.size === 1) {
    const candidate = [...versions][0];
    if (HARNESS_VERSION_RE.test(candidate)) result.harnessVersion = candidate;
  }
  return result;
}

/** `input_tokens`/`cached_input_tokens`/`output_tokens`/`reasoning_output_tokens`
 * (a Codex rollout's `thread_token_usage`) → `record-dispatch.mjs`'s own field names —
 * exactly the four fields `token-report.mjs`'s `codexUsageOf` already sums. */
export const CODEX_USAGE_COUNTER_FIELDS = Object.freeze([
  ['input_tokens', 'inputTokens'],
  ['cached_input_tokens', 'cachedInputTokens'],
  ['output_tokens', 'outputTokens'],
  ['reasoning_output_tokens', 'reasoningOutputTokens'],
]);

/**
 * Reads one Codex rollout, bounded exactly as `readClaudeTranscriptUsage` is,
 * and returns either `{ usage, harnessVersion? }` or `{ usageUnavailable:
 * <short reason code> }` — `harnessVersion` is `session_meta.payload.cli_version`
 * when it passes `HARNESS_VERSION_RE`. `agentId` is the dispatch's own `agent_id` — the rollout's
 * `session_meta.payload.id` must equal it (a rollout with no `session_meta`
 * record at all is the same failure: `'rollout-identity-mismatch'`), and only
 * the LAST `token_usage_record` whose `payload.thread_id === agentId` is
 * read; its `thread_token_usage` (the cumulative total) is mapped, never
 * summed across records. Never returns or logs the path or any rollout
 * content — only aggregated numbers, that version string, or a short static
 * reason code.
 *
 * `now` defaults to `Date.now`, exactly as `readClaudeTranscriptUsage` — the
 * test suite injects a fake one to drive the shared 3s bound deterministically.
 */
export function readCodexRolloutUsage(file, agentId, { now = Date.now } = {}) {
  let sessionMetaSeen = false;
  let sessionMetaId;
  let cliVersion;
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
        if (payload !== null && typeof payload === 'object') {
          if (typeof payload.id === 'string') sessionMetaId = payload.id;
          if (typeof payload.cli_version === 'string') cliVersion = payload.cli_version;
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
  const result = { usage };
  if (cliVersion !== undefined && HARNESS_VERSION_RE.test(cliVersion)) {
    result.harnessVersion = cliVersion;
  }
  return result;
}

// ── Controller-session usage (RP-511) ───────────────────────────────────────
//
// The same bounded reader, folded for the CONTROLLER's own transcript (Claude)
// or rollout (Codex) — the `transcript_path` a `Stop`/`SessionEnd` payload
// carries — instead of a subagent's. The identity binding is the payload's
// `session_id`, inside the file, and it differs per harness. Claude: every
// record carries its own `sessionId`, and a resumed or forked session's file
// carries the PREVIOUS session's records too, so only records whose
// `sessionId` equals the payload's are summed; the rest are counted under
// `coverage.foreignSessionRecords`, and a file with no own usage-bearing
// record at all is `no-usage-records` —
// test/template/session-usage.test.ts (absent in a generated rig) › "sums only
// the payload session, dedupes by requestId with the last record winning, and
// counts foreign records" and › "reports no-usage-records when every
// usage-bearing record belongs to another session". Codex: the rollout's
// FIRST `session_meta.payload.id` must be the session id or the whole read
// is `session-identity-mismatch` —
// test/template/session-usage.test.ts (absent in a generated rig) › "refuses
// a rollout whose first session_meta names another thread — a forked child
// carrying the parent meta second is still the child". The content-stripped
// copy of a real 2.1.296 transcript that was continued from an earlier
// session is the fixture the Claude reader is checked against, with an
// independent dedupe — test/template/session-usage.test.ts (absent in a
// generated rig) › "agrees with an independent dedupe on the real 2.1.296
// transcript fixture, and the fixture carries no prompt or response text".
//
// `coverage` states what the counters are built from — assistant records
// only, deduped per request, with `compactBoundaries` counted — because a
// request that leaves no assistant record is not seen by this reader at all;
// nothing here claims to see the session's whole consumption. The optional `sessionAggregate` is the
// harness's own cumulative `cost-state` record — UNDOCUMENTED, written
// periodically (so possibly stale: `recordsBehind` is how many records
// followed it), not authoritative billing, never summed with anything here;
// its `costUSD` is never copied — test/template/session-usage.test.ts (absent
// in a generated rig) › "carries cost-state as a labelled diagnostic without
// costUSD, and omits a harness version the records disagree on".

/** The counters copied out of a `cost-state` record's `modelUsage[<model>]` — never `costUSD`. */
const COST_STATE_COUNTER_FIELDS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'thinkingTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
]);
const MAX_COST_STATE_MODELS = 16;

/**
 * `{ usage, coverage, harnessVersion?, sessionAggregate? }` or
 * `{ usageUnavailable }` for one Claude controller transcript, bound to
 * `sessionId`. Dedupe is the subagent reader's (`requestId ?? message.id`,
 * last occurrence wins); counters absent from every deduped record stay
 * absent, and one out-of-range counter rejects the whole read.
 */
export function readClaudeControllerUsage(file, sessionId, { now = Date.now } = {}) {
  const usageByKey = new Map();
  const versions = new Set();
  let assistantRecords = 0;
  let foreignSessionRecords = 0;
  let compactBoundaries = 0;
  let records = 0;
  let costState = null;
  let costStateAt = -1;

  const foldLine = (lineBuf) => {
    if (lineBuf.length === 0) return true;
    let record;
    try {
      record = JSON.parse(lineBuf.toString('utf8'));
    } catch {
      return false;
    }
    if (record === null || typeof record !== 'object') return true;
    records += 1;
    const own = record.sessionId === sessionId;
    if (record.type === 'system' && record.subtype === 'compact_boundary' && own) {
      compactBoundaries += 1;
      return true;
    }
    if (record.type === 'cost-state' && own) {
      costState = record;
      costStateAt = records;
      return true;
    }
    if (record.type !== 'assistant') return true;
    const message = record.message;
    if (message === null || typeof message !== 'object') return true;
    const usage = message.usage;
    if (usage === null || typeof usage !== 'object') return true;
    if (!own) {
      foreignSessionRecords += 1;
      return true;
    }
    assistantRecords += 1;
    if (typeof record.version === 'string') versions.add(record.version);
    const requestId = typeof record.requestId === 'string' ? record.requestId : undefined;
    const messageId = typeof message.id === 'string' ? message.id : undefined;
    const key = requestId ?? messageId;
    if (key === undefined) return true;
    usageByKey.set(key, usage);
    return true;
  };

  const errorCode = readBoundedLines(file, foldLine, { now });
  if (errorCode) return { usageUnavailable: errorCode };
  if (usageByKey.size === 0) return { usageUnavailable: 'no-usage-records' };

  const summed = summedUsageCounters(usageByKey);
  if (summed.usageUnavailable) return { usageUnavailable: summed.usageUnavailable };
  const usage = {
    evidenceSource: 'claude-controller-transcript',
    requests: usageByKey.size,
    ...summed.counters,
  };

  const result = {
    usage,
    coverage: {
      basis: 'assistant-records-last-per-request',
      assistantRecords,
      dedupedRequests: usageByKey.size,
      foreignSessionRecords,
      compactBoundaries,
    },
  };
  // A counter some counted records omit is summed from the records that
  // carry it and NAMED here, so a reader never takes the sum for complete.
  if (summed.partialCounters.length > 0) result.coverage.partialCounters = summed.partialCounters;
  if (versions.size === 1) {
    const candidate = [...versions][0];
    if (HARNESS_VERSION_RE.test(candidate)) result.harnessVersion = candidate;
  }
  if (costState !== null) {
    const aggregate = sessionAggregateOf(costState);
    if (aggregate !== null) {
      aggregate.recordsBehind = records - costStateAt;
      result.sessionAggregate = aggregate;
    }
  }
  return result;
}

/**
 * The bounded, counter-only projection of one `cost-state` record, or `null`
 * when it carries no usable `modelUsage`. Model names are echoed only when
 * they pass `MEASURED_MODEL_RE`; `costUSD` and every other field are dropped.
 */
function sessionAggregateOf(record) {
  const modelUsage = record.modelUsage;
  if (modelUsage === null || typeof modelUsage !== 'object') return null;
  const models = {};
  let count = 0;
  for (const [model, raw] of Object.entries(modelUsage)) {
    if (count >= MAX_COST_STATE_MODELS) break;
    if (model.length > MAX_MEASURED_MODEL_LENGTH || !MEASURED_MODEL_RE.test(model)) continue;
    if (raw === null || typeof raw !== 'object') continue;
    const counters = {};
    let any = false;
    for (const field of COST_STATE_COUNTER_FIELDS) {
      const value = raw[field];
      if (value === undefined) continue;
      if (!isCounter(value)) return null;
      counters[field] = value;
      any = true;
    }
    if (!any) continue;
    models[model] = counters;
    count += 1;
  }
  if (count === 0) return null;
  return {
    evidenceSource: 'claude-cost-state',
    documented: false,
    authoritative: false,
    additive: false,
    models,
  };
}

/**
 * `{ usage, coverage, harnessVersion? }` or `{ usageUnavailable }` for one
 * Codex controller rollout, bound to `sessionId`: the rollout's FIRST
 * `session_meta.payload.id` must equal it, and the LAST `token_usage_record`
 * whose `payload.thread_id` equals it supplies `thread_token_usage` — the
 * thread's cumulative total, replaced never summed. Records of other threads
 * are counted under `coverage.foreignThreadRecords`; `compacted` records
 * under `coverage.compactedRecords` —
 * test/template/session-usage.test.ts (absent in a generated rig) › "reads
 * the last own-thread cumulative total, counts foreign-thread and compacted
 * records, and never sums". That the cumulative total is the one to read was
 * measured once, on real 0.161/0.162 rollouts, and recorded in Jira RP-511
 * (comment 24425) — a measurement, not a mechanism this file enforces.
 */
export function readCodexControllerUsage(file, sessionId, { now = Date.now } = {}) {
  let sessionMetaSeen = false;
  let sessionMetaId;
  let cliVersion;
  let ownRecords = 0;
  let foreignThreadRecords = 0;
  let compactedRecords = 0;
  const responseIds = new Set();
  let lastThreadTokenUsage = null;

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
      if (!sessionMetaSeen) {
        sessionMetaSeen = true;
        const payload = record.payload;
        if (payload !== null && typeof payload === 'object') {
          if (typeof payload.id === 'string') sessionMetaId = payload.id;
          if (typeof payload.cli_version === 'string') cliVersion = payload.cli_version;
        }
      }
      return true;
    }
    if (record.type === 'compacted') {
      compactedRecords += 1;
      return true;
    }
    if (record.type !== 'token_usage_record') return true;
    const payload = record.payload;
    if (payload === null || typeof payload !== 'object') return true;
    if (payload.thread_id !== sessionId) {
      foreignThreadRecords += 1;
      return true;
    }
    ownRecords += 1;
    if (typeof payload.response_id === 'string') responseIds.add(payload.response_id);
    const threadTokenUsage = payload.thread_token_usage;
    lastThreadTokenUsage =
      threadTokenUsage !== null && typeof threadTokenUsage === 'object' ? threadTokenUsage : {};
    return true;
  };

  const errorCode = readBoundedLines(file, foldLine, { now });
  if (errorCode) return { usageUnavailable: errorCode };
  if (sessionMetaId === undefined || sessionMetaId !== sessionId) {
    return { usageUnavailable: 'session-identity-mismatch' };
  }
  if (lastThreadTokenUsage === null) return { usageUnavailable: 'no-usage-records' };

  const usage = { evidenceSource: 'codex-controller-rollout' };
  let anyCounter = false;
  for (const [rawKey, outKey] of CODEX_USAGE_COUNTER_FIELDS) {
    const value = lastThreadTokenUsage[rawKey];
    if (value === undefined) continue;
    if (!isCounter(value)) return { usageUnavailable: 'invalid-usage-counter' };
    usage[outKey] = value;
    anyCounter = true;
  }
  if (!anyCounter) return { usageUnavailable: 'no-usage-counters' };

  const result = {
    usage,
    coverage: {
      basis: 'thread-cumulative-last-record',
      tokenUsageRecords: ownRecords,
      distinctResponseIds: responseIds.size,
      foreignThreadRecords,
      compactedRecords,
    },
  };
  if (cliVersion !== undefined && HARNESS_VERSION_RE.test(cliVersion)) {
    result.harnessVersion = cliVersion;
  }
  return result;
}
