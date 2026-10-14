// record-session-usage.mjs — Stop/SessionEnd hook (Claude Code and, via the
// Codex projection, Codex): journals one `controller-usage` EVENT per
// snapshot of the CONTROLLER session's own token usage into the run journal
// (`.claude/scripts/run-journal.mjs`, `events.jsonl`) — the controller half
// of the usage evidence `record-dispatch.mjs` already records per subagent
// (RP-225/226/227), read back by `token-report.mjs` (RP-511 PR C), which
// counts a run with no such event under `controllerRuns.withoutSnapshot`
// and never reads it as zero — what a report does with that count is the
// report's own rule, not a mechanism here.
//
// observe-only: refuses nothing and returns no decision. It exits 0 on every
// path, writes nothing to stdout, and never throws out of `main()` — a `Stop`
// hook that wrote a stdout decision could block a real session, and this
// hook must never carry that power by accident —
// test/template/session-usage.test.ts (absent in a generated rig) › "journals
// one controller-usage event on Stop with only allowlisted fields and a
// hashed controller, exits 0 and prints nothing" and › "writes nothing for
// another event, for a missing harness flag, for no run directory, or for
// malformed stdin — and always exits 0 silently".
//
// WHAT IT READS. Only the payload's `transcript_path` — the controller's own
// transcript (Claude) or rollout (Codex), as the harness names it on `Stop`
// and `SessionEnd` — through the same bounded reader as the subagent capture
// (`./lib/usage-readers.mjs`): the bounds and the read-failure codes
// (`transcript-unreadable`, `transcript-too-large`,
// `transcript-line-too-large`, `transcript-timeout`,
// `transcript-malformed-line`, `transcript-empty`) are `readBoundedLines`'s
// and shared. The path codes keep the subagent capture's Claude names on
// BOTH harnesses — `transcript-path-missing`, `transcript-path-unc`,
// `transcript-path-not-absolute`, `transcript-path-mismatch`, exactly
// `record-dispatch.mjs`'s `claudeUsageOf` codes — so this hook never says
// `rollout-path-unc`/`rollout-path-not-absolute` for a Codex path as that
// hook's `codexUsageOf` does; and the Codex identity code is
// `session-identity-mismatch` where the subagent capture says
// `rollout-identity-mismatch`. The path is refused before anything is
// opened when it is missing or empty
// (`transcript-path-missing`), UNC-shaped in any separator mix
// (`transcript-path-unc`), not absolute (`transcript-path-not-absolute`), or
// when its basename does not carry the payload's own `session_id`
// (`transcript-path-mismatch`): Claude names the file `<session_id>.jsonl`,
// Codex `rollout-<stamp>-<session_id>.jsonl` —
// test/template/session-usage.test.ts (absent in a generated rig) › "refuses
// a missing, UNC-shaped (any separator mix) or relative transcript_path
// before opening anything, on both harnesses" and › "records usageUnavailable:
// transcript-path-mismatch when the basename does not carry the session id,
// without opening the file". Inside the file the binding is the session id
// again — a Claude record's `sessionId`, a Codex rollout's first
// `session_meta.payload.id` and each `token_usage_record.payload.thread_id`
// — so a resumed or forked session's foreign records are counted, never
// summed (`coverage`): the readers' own section in `./lib/usage-readers.mjs`
// carries the tests.
//
// WHAT IT WRITES. One `controller-usage` event whose `data` is filtered
// through ONE allowlist, `SESSION_USAGE_FIELDS`, immediately before the
// write: `schema`, `harness`, `controller`, `trigger`, `cumulative`, `usage`,
// `usageUnavailable`, `coverage`, `harnessVersion`, `sessionAggregate`.
// `controller` is never the raw `session_id` — it is `record-dispatch.mjs`'s
// own `ref(runDir, session_id)`, so it names no id a reader could correlate
// outside this run. On Claude it is the same hash a `dispatch-start` of the
// same session carries, so the two kinds of record meet on one identity —
// test/template/session-usage.test.ts (absent in a generated rig) › "names
// the controller by the same ref() a Claude dispatch-start of the same
// session carries, never by the raw session id"; a Codex `dispatch-start`
// carries no `controller` at all (`record-dispatch.mjs`, its LIMITS), so on
// Codex this record is the only one that names the session. `cumulative` is
// always `true`: the counters are the session's running total as of this
// snapshot, so a reader keeps the LAST snapshot per controller and never
// sums snapshots.
//
// REPEATED SNAPSHOTS. `Stop` fires at every turn end, so an idle turn would
// re-record the same total. Before writing, the hook reads the run's last
// `controller-usage` event for this controller and skips the write when
// `usage`, `usageUnavailable` and `coverage` are byte-identical —
// test/template/session-usage.test.ts (absent in a generated rig) › "does not
// write a second event for an identical snapshot, but does for a changed one,
// and SessionEnd is a trigger too". The check is bounded: a run whose
// `events.jsonl` or `decisions.jsonl` is past `MAX_SNAPSHOT_CHECK_BYTES` is
// not read, and the snapshot is then written regardless —
// test/template/session-usage.test.ts (absent in a generated rig) › "writes a
// repeated snapshot regardless once the journal is past the repeated-snapshot
// check bound". A snapshot whose counters are LOWER than the previous one is
// still written: the reader, not this hook, decides what a non-monotonic
// sequence means, and it must see it —
// test/template/session-usage.test.ts (absent in a generated rig) › "still
// writes a lower snapshot after a higher one — the reader, not the hook,
// judges a non-monotonic sequence".
//
// LIMITS, stated because a hook's own claim about its reach is the first
// thing to go stale:
//   - **No run directory declared → nothing recorded, not zero.** As for
//     dispatches: `RIG_RUN_DIR`, else the armed unattended flag's `runDir`,
//     else silence (the "writes nothing …" test above).
//   - **A session the harness kills does not fire Stop or SessionEnd.** Such
//     a run has no `controller-usage` event at all — absent evidence, never
//     zero. Whether a harness gives `SessionEnd` the full `timeout` this
//     hook is wired with is the harness's own behaviour, not observed here;
//     the `Stop` snapshots stand on their own either way.
//   - **The readers' bounds apply to the controller's file as to a
//     subagent's** — `MAX_TRANSCRIPT_TOTAL_BYTES`, `MAX_TRANSCRIPT_LINE_BYTES`
//     and `MAX_TRANSCRIPT_MS` in `./lib/usage-readers.mjs`. A controller
//     transcript past the total bound records `transcript-too-large` at every
//     Stop — the shared reader's bound,
//     test/template/dispatch-usage-codex.test.ts (absent in a generated rig)
//     › "reports usageUnavailable with transcript-too-large, with no partial
//     numbers, when the rollout exceeds 32 MiB total" — and a file still
//     being written whose last line is incomplete records
//     `transcript-malformed-line` —
//     test/template/session-usage.test.ts (absent in a generated rig) ›
//     "records transcript-malformed-line, never a partial sum, when the last
//     line of a transcript still being written is incomplete". Both are
//     absent evidence with a reason, never a partial number.
//   - **Assistant records are not the session's whole consumption.** Only
//     assistant records are read, so a request that leaves none is not
//     seen; `coverage.basis` says so, and the optional `sessionAggregate`
//     (the harness's UNDOCUMENTED `cost-state` record) is carried for
//     comparison only — never added to `usage`.
//   - **A Codex project hook may be skipped until the project is trusted**,
//     exactly as for dispatches; the trace is then absent, not zero.
//   - **Codex `Stop`/`SessionEnd` have not been observed delivering a
//     `transcript_path`.** RP-227's live probe covered `SubagentStop` only
//     (`record-dispatch.mjs`, CODEX USAGE CAPTURE); the Codex row for this
//     hook in `docs/compatibility.md` stays UNVERIFIED until a live `Stop`
//     payload is recorded. This hook never handles `SubagentStop`: there the
//     path would be the parent's, which is the wrong file for a subagent.
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHookInput } from './lib/hook-input.mjs';
import {
  UNC_PATH_RE,
  readClaudeControllerUsage,
  readCodexControllerUsage,
} from './lib/usage-readers.mjs';
import { ref, resolveRunDir } from './record-dispatch.mjs';
import { recordEvent, readRun } from '../scripts/run-journal.mjs';

/** The one allowlist a record's `data` may carry — see the header. */
export const SESSION_USAGE_FIELDS = Object.freeze([
  'schema',
  'harness',
  'controller',
  'trigger',
  'cumulative',
  'usage',
  'usageUnavailable',
  'coverage',
  'harnessVersion',
  'sessionAggregate',
]);

/** The journal event kind this hook writes. */
export const CONTROLLER_USAGE = 'controller-usage';

const HANDLED_EVENTS = new Set(['Stop', 'SessionEnd']);

/** A narrow shape for a session id as it may appear in a file name. */
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** A journal file larger than this is not read for the repeated-snapshot check. */
const MAX_SNAPSHOT_CHECK_BYTES = 4 * 1024 * 1024;

function harnessOf(argv) {
  for (const arg of argv) {
    if (arg === '--harness=claude') return 'claude';
    if (arg === '--harness=codex') return 'codex';
  }
  return null;
}

/** Whether `basename` is the file the harness writes for `sessionId`. */
function basenameBindsSession(basename, sessionId, harness) {
  if (harness === 'claude') return basename === `${sessionId}.jsonl`;
  return basename.startsWith('rollout-') && basename.endsWith(`-${sessionId}.jsonl`);
}

/** `{ usage, coverage, ... }` or `{ usageUnavailable }` for one payload's controller file. */
export function controllerUsageOf(input, sessionId, harness) {
  const transcriptPath = input.transcript_path;
  if (typeof transcriptPath !== 'string' || transcriptPath.trim() === '') {
    return { usageUnavailable: 'transcript-path-missing' };
  }
  if (UNC_PATH_RE.test(transcriptPath)) {
    return { usageUnavailable: 'transcript-path-unc' };
  }
  if (!path.isAbsolute(transcriptPath)) {
    return { usageUnavailable: 'transcript-path-not-absolute' };
  }
  if (!basenameBindsSession(path.basename(transcriptPath), sessionId, harness)) {
    return { usageUnavailable: 'transcript-path-mismatch' };
  }
  return harness === 'claude'
    ? readClaudeControllerUsage(transcriptPath, sessionId)
    : readCodexControllerUsage(transcriptPath, sessionId);
}

/** The comparable part of a snapshot — what a repeat must equal to be skipped. */
const fingerprintOf = (data) =>
  JSON.stringify({
    usage: data.usage ?? null,
    usageUnavailable: data.usageUnavailable ?? null,
    coverage: data.coverage ?? null,
  });

/**
 * The fingerprint of this run's last `controller-usage` event for
 * `controller`, `null` when there is none, or `undefined` when the check
 * could not be made (journal too large, unreadable) — in which case the
 * snapshot is written regardless.
 */
export function lastSnapshotFingerprint(runDir, controller) {
  try {
    // `readRun` reads BOTH journal files in full, so both are size-gated —
    // the same parity `record-dispatch.mjs`'s orphan check keeps.
    const events = statSync(path.join(runDir, 'events.jsonl'));
    if (events.size > MAX_SNAPSHOT_CHECK_BYTES) return undefined;
    try {
      const decisions = statSync(path.join(runDir, 'decisions.jsonl'));
      if (decisions.size > MAX_SNAPSHOT_CHECK_BYTES) return undefined;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') return undefined;
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return undefined;
  }
  try {
    const { events } = readRun({ runDir });
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.kind !== CONTROLLER_USAGE) continue;
      const data = event.data;
      if (data === null || typeof data !== 'object' || data.controller !== controller) continue;
      return fingerprintOf(data);
    }
    return null;
  } catch {
    return undefined;
  }
}

function main() {
  try {
    const input = readHookInput();
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return 0;
    if (!HANDLED_EVENTS.has(input.hook_event_name)) return 0;

    const sessionId = input.session_id;
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return 0;

    const harness = harnessOf(process.argv.slice(2));
    if (harness === null) return 0;

    const runDir = resolveRunDir(process.env);
    if (!runDir) return 0;

    const data = {
      schema: 1,
      harness,
      controller: ref(runDir, sessionId),
      trigger: input.hook_event_name,
      cumulative: true,
    };
    const result = controllerUsageOf(input, sessionId, harness);
    if (result.usageUnavailable) {
      data.usageUnavailable = result.usageUnavailable;
    } else {
      data.usage = result.usage;
      data.coverage = result.coverage;
      if (result.harnessVersion !== undefined) data.harnessVersion = result.harnessVersion;
      if (result.sessionAggregate !== undefined) data.sessionAggregate = result.sessionAggregate;
    }

    const previous = lastSnapshotFingerprint(runDir, data.controller);
    if (previous !== null && previous !== undefined && previous === fingerprintOf(data)) return 0;

    try {
      const bounded = Object.fromEntries(
        Object.entries(data).filter(([key]) => SESSION_USAGE_FIELDS.includes(key)),
      );
      recordEvent({ runDir, kind: CONTROLLER_USAGE, data: bounded, now: new Date().toISOString() });
    } catch {
      // Every `RunJournalError` is swallowed on purpose — observe-only: a lost
      // record costs the trace, never the session.
    }
  } catch {
    // A broken observation must never make the session unusable.
  }
  return 0;
}

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
