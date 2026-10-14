// usage-readers.mjs — the bounded, read-only usage readers the dispatch
// evidence hook (`../record-dispatch.mjs`, RP-226/RP-227) folds through, and
// that the controller-session evidence of RP-511 reuses once it ships.
// Extracted from `record-dispatch.mjs` (RP-511, PR A): the bounds, the
// identity checks, the dedupe rules and every reason code are the ones that
// hook's header LIMITS document, and that hook's own tests exercise them
// through its re-exports — test/template/dispatch-usage.test.ts (absent in a
// generated rig) › "reports transcript-timeout when an injected clock crosses
// the 3 s bound between two read chunks" calls `readClaudeTranscriptUsage`
// through `record-dispatch.mjs`.
//
// Nothing here writes or logs; what reaches a journal is decided by the
// caller, and the hook's tests pin that neither a path nor any transcript
// content does — test/template/dispatch-usage.test.ts (absent in a generated
// rig) › "never carries the transcript path or assistant message content in
// the journal record" and test/template/dispatch-usage-codex.test.ts (absent
// in a generated rig) › "never carries the rollout path, the padding/canary
// content, or turn_token_usage/usage (the non-cumulative fields) in the
// journal record". The readers return only aggregated counters, a model
// string already present verbatim in a record, and short static reason codes.
//
// The path checks (UNC, absolute, basename binding) are the CALLER's:
// `record-dispatch.mjs` runs them before any reader here opens a file —
// test/template/dispatch-usage.test.ts (absent in a generated rig) › "reports
// usageUnavailable: transcript-path-unc for a UNC-shaped agent_transcript_path
// (leading "//") — never opens anything" — and every other caller must do the
// same: these functions open whatever path they are handed.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';

/** A narrow, allowlisted shape for `measuredModel` — never echoed unless it matches. */
export const MEASURED_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
export const MAX_MEASURED_MODEL_LENGTH = 128;

/**
 * Any leading pair of path separators, `\` and `/` in any mix — UNC-shaped,
 * refused before any fs call, for BOTH the Claude transcript path and the
 * Codex rollout path. Win32 treats `\` and `/` as the same separator, so
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
