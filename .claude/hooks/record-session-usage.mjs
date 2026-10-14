// record-session-usage.mjs — Stop/SessionEnd hook (Claude Code and, via the
// Codex projection, Codex): journals one `controller-usage` EVENT per
// snapshot of the CONTROLLER session's own token usage into the run journal
// (`.claude/scripts/run-journal.mjs`, `events.jsonl`) — the controller half
// of the usage evidence `record-dispatch.mjs` already records per subagent
// (RP-225/226/227), read back by `token-report.mjs` (RP-511).
//
// observe-only: refuses nothing and returns no decision. It exits 0 on every
// path, writes nothing to stdout, and never throws out of `main()` — a `Stop`
// hook that wrote a stdout decision could block a real session, and this
// hook must never carry that power by accident.
//
// WHAT IT READS. Only the payload's `transcript_path` — the controller's own
// transcript (Claude) or rollout (Codex), as the harness names it on `Stop`
// and `SessionEnd` — through the same bounded readers, bounds and reason
// codes as the subagent capture (`./lib/usage-readers.mjs`). The path is
// refused before anything is opened when it is missing or empty
// (`transcript-path-missing`), UNC-shaped (`transcript-path-unc`), not
// absolute (`transcript-path-not-absolute`), or when its basename does not
// carry the payload's own `session_id` (`transcript-path-mismatch`): Claude
// names the file `<session_id>.jsonl`, Codex `rollout-<stamp>-<session_id>.jsonl`.
// Inside the file the binding is the session id again — a Claude record's
// `sessionId`, a Codex rollout's first `session_meta.payload.id` and each
// `token_usage_record.payload.thread_id` — so a resumed or forked session's
// foreign records are counted, never summed (`coverage`).
//
// WHAT IT WRITES. One `controller-usage` event whose `data` is filtered
// through ONE allowlist, `SESSION_USAGE_FIELDS`, immediately before the
// write: `schema`, `harness`, `controller`, `trigger`, `cumulative`, `usage`,
// `usageUnavailable`, `coverage`, `harnessVersion`, `sessionAggregate`.
// `controller` is never the raw `session_id` — it is `record-dispatch.mjs`'s
// own `ref(runDir, session_id)`, the same hash a `dispatch-start` carries, so
// the two kinds of record meet on one identity and neither names an id a
// reader could correlate outside this run. `cumulative` is always `true`:
// the counters are the session's running total as of this snapshot, so a
// reader keeps the LAST snapshot per controller and never sums snapshots.
//
// REPEATED SNAPSHOTS. `Stop` fires at every turn end, so an idle turn would
// re-record the same total. Before writing, the hook reads the run's last
// `controller-usage` event for this controller (bounded: `events.jsonl` past
// `MAX_SNAPSHOT_CHECK_BYTES` is not read, and the snapshot is then written
// regardless) and skips the write when `usage`, `usageUnavailable` and
// `coverage` are byte-identical. A snapshot whose counters are LOWER than the
// previous one is still written: the reader, not this hook, decides what a
// non-monotonic sequence means, and it must see it.
//
// LIMITS, stated because a hook's own claim about its reach is the first
// thing to go stale:
//   - **No run directory declared → nothing recorded, not zero.** As for
//     dispatches: `RIG_RUN_DIR`, else the armed unattended flag's `runDir`,
//     else silence.
//   - **A session the harness kills does not fire Stop or SessionEnd.** Such
//     a run has no `controller-usage` event at all; `token-report.mjs`
//     reports it as a run without a controller snapshot, never as zero.
//   - **Assistant records are not the session's whole consumption.** A
//     compaction's own requests and helper-model requests leave no assistant
//     record in a Claude transcript; `coverage.basis` says so, and the
//     optional `sessionAggregate` (the harness's UNDOCUMENTED `cost-state`
//     record) is carried for comparison only — never added to `usage`.
//   - **A Codex project hook may be skipped until the project is trusted**,
//     exactly as for dispatches; the trace is then absent, not zero.
//   - **`transcript_path` on Codex is the parent rollout on Stop/SessionEnd**
//     (RP-227 live probe); on `SubagentStop` it would be too, which is why
//     this hook never handles that event.
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

/** `events.jsonl` larger than this is not read for the repeated-snapshot check. */
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
    const stat = statSync(path.join(runDir, 'events.jsonl'));
    if (stat.size > MAX_SNAPSHOT_CHECK_BYTES) return undefined;
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
