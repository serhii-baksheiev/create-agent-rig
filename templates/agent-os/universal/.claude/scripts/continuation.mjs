#!/usr/bin/env node
// Bounded continuation notes for an unfinished workflow-level stop.
//
// A second controller — another machine, another session, days later — has to
// be able to resume or revalidate a claimed item from durable, SHARED evidence
// alone: a tracker note, the PR, the branch, the claim. It cannot see this
// session's own run journal or Memory. This file is the one place that
// composes that note and, with `--post`, publishes it — and it does so on
// exactly FOUR workflow-level stops, never on an ordinary Claude Stop, a
// subagent stop, or a review round:
//
//   escalation   — `.claude/rules/autonomy.md` ("Escalation format")
//   blocker      — an owner/external blocker the run cannot resolve itself
//   pause        — an intentional pause or handoff
//   terminated   — the session ends while a claimed item remains unfinished
//
//   node .claude/scripts/continuation.mjs --ticket <id> --stop <kind>
//        [--pr <n>] [--diagnosis <text>] [--remaining <text>] [--post]
//
// The note is always printed to stdout. `--post` is the only thing that
// touches the network — without it, nothing here ever resolves or calls a
// queue adapter at all, so a caller that never passes it gets a purely local,
// read-only preview.
//
// It NEVER records: a transcript, a prompt, source code, a local filesystem
// path, or a credential. Two scrubbing passes run over the free-text fields
// (`--diagnosis`, `--remaining`) before anything is printed or posted:
//
//   - an absolute path (POSIX `/home/…`, `/Users/…`, `/tmp/…`, a Windows
//     `C:\…` path, or a `\\wsl$\…` UNC path) becomes `[path]`;
//   - a credential-shaped value, judged by the one vocabulary this project
//     already refuses commits over (`lib/secrets.mjs`), becomes `[redacted]`.
//
// Every field this composes is capped, so one long field cannot make the note
// itself unpostable: `diagnosis` and `remaining` are each capped at 500
// characters (an explicit `[truncated]` marker, never a silent cut), and the
// WHOLE note is capped at 2000 characters as a backstop for a field this
// module does not cap per-field (`branch`, for instance) — see
// `test/template/continuation.test.ts` (absent in a generated rig) ›
// "caps diagnosis and remaining at 500 characters, with an explicit
// [truncated] marker" and › "caps the whole note, even when no single field
// is over its own cap".
//
// Evidence is gathered from what is already durable in this checkout, never
// invented or asked of the session's own memory:
//
//   - branch and head SHA — `git rev-parse` through the shared sanitised
//     environment (`git-env.mjs`), so a checkout under a git hook is not
//     misread (see that module's own header for the incident this guards);
//   - gate rounds already spent on this branch — `queue/gate-rounds.mjs`,
//     the same counter `pr-ship` writes;
//   - the latest gate verdict — `readRunEvidence(runDir)`, which reads
//     `RIG_RUN_DIR`'s run journal (`run-journal.mjs`) ONLY when that
//     variable is declared; an undeclared run reports every evidence field
//     `null`, silently, like every other optional trace in this rig.
//
// `--post` resolves the configured queue adapter exactly the way
// `queue/index.mjs` and `preflight.mjs` already do (`loadConfig` +
// `resolveAdapter`) and calls its `comment()`. An adapter that cannot post —
// `plan-md` has no comment thread at all — is a refusal, not a silent no-op:
// the note is still printed, and the process exits non-zero naming why.
//
// --- Limits -----------------------------------------------------------
//
// - The path scrub recognises four shapes by literal prefix (POSIX
//   `/home/`, `/Users/`, `/tmp/`; a Windows drive-letter path; a `\\wsl$\`
//   UNC path) and nothing else — an absolute path under a directory this
//   list does not name (`/srv/…`, `/opt/…`, a relative path) is not
//   recognised and passes through unscrubbed.
// - Credential redaction reuses `SECRET_VALUE_PATTERNS` from
//   `lib/secrets.mjs` verbatim, so it inherits that module's own stated
//   limits (a text scan, not an entropy analyser; an all-letters secret is
//   invisible to the `assigned-secret` arm) rather than restating them here.
// - `readRunEvidence` reads only the LAST recorded decision in the run's
//   journal — the run's own most recent gate verdict, never a history of
//   every gate this run ran.
// - Gate rounds are read for the branch `git` reports right now; a detached
//   checkout (`HEAD` literal) is refused by `gate-rounds.mjs`'s own
//   `requireBranch`, which this module reports as an unknown count rather
//   than a crash.
//
// See `test/template/continuation.test.ts` (absent in a generated rig) for
// every case above, by name, next to the assertion that proves it.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withoutGitLocation } from './git-env.mjs';
import { readRun } from './run-journal.mjs';
import { SECRET_VALUE_PATTERNS } from './lib/secrets.mjs';

/** The only four workflow-level stops this note exists for. */
export const STOP_KINDS = Object.freeze(['escalation', 'blocker', 'pause', 'terminated']);

const PATH_MARKER = '[path]';
const REDACTED_MARKER = '[redacted]';
const FIELD_CAP = 500;
const FIELD_TRUNCATION_MARKER = '[truncated]';
const NOTE_CAP = 2000;
const NOTE_TRUNCATION_SUFFIX = '\n[truncated]';

// Four absolute-path shapes, matched by their literal prefix and consumed up
// to the next whitespace — see the Limits note above for what this does not
// recognise. `i` covers `wsl$` however it is cased; the POSIX and Windows
// arms are already exact about theirs (a filesystem convention, not a value
// worth loosening).
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\[^\s]+|\\\\wsl\$\\[^\s]+|\/(?:home|Users|tmp)\/[^\s]+)/gi;

const scrubPaths = (text) => text.replace(ABSOLUTE_PATH, PATH_MARKER);

/**
 * Redact every credential shape `lib/secrets.mjs` names, reusing its own
 * patterns rather than a second copy of the vocabulary (`invariants.md`:
 * "one mechanism, one implementation").
 *
 * The `assigned-secret` pattern judges its captured value (`reject`) —
 * exactly as `findSecretValues` does — so an all-letters value (an
 * identifier, not a credential) is left alone; every other pattern answers
 * with one substring test, same as there.
 */
const redactSecrets = (text) => {
  let result = text;
  for (const entry of SECRET_VALUE_PATTERNS) {
    const flags = entry.pattern.flags.includes('g') ? entry.pattern.flags : `${entry.pattern.flags}g`;
    const global = new RegExp(entry.pattern.source, flags);
    if (!entry.reject) {
      result = result.replace(global, REDACTED_MARKER);
      continue;
    }
    const groupIndex = entry.valueGroup ?? 1;
    result = result.replace(global, (...args) => {
      const groups = args.slice(1, -2);
      const value = groups[groupIndex - 1];
      return entry.reject.test(value ?? '') ? args[0] : REDACTED_MARKER;
    });
  }
  return result;
};

/** Cap one free-text field, with an explicit marker rather than a silent cut. */
const truncateField = (value) => {
  if (value.length <= FIELD_CAP) return value;
  const keep = FIELD_CAP - FIELD_TRUNCATION_MARKER.length;
  return `${value.slice(0, keep)}${FIELD_TRUNCATION_MARKER}`;
};

/** Scrub, then cap — never the other way, or a cut could reopen a redaction. */
const composeTextField = (value) =>
  value === undefined || value === null
    ? 'unknown'
    : truncateField(redactSecrets(scrubPaths(String(value))));

/** Cap the WHOLE note — a backstop for a field this module does not cap on its own. */
const capNote = (note) => {
  if (note.length <= NOTE_CAP) return note;
  return `${note.slice(0, NOTE_CAP - NOTE_TRUNCATION_SUFFIX.length)}${NOTE_TRUNCATION_SUFFIX}`;
};

const renderVerdict = (verdict) => {
  if (!verdict || !verdict.gate || !verdict.verdict) return 'unknown';
  const shortSha = verdict.headSha ? String(verdict.headSha).slice(0, 7) : 'unknown';
  const blockers =
    Array.isArray(verdict.blockers) && verdict.blockers.length > 0
      ? ` — blockers: ${verdict.blockers.join(', ')}`
      : '';
  return `${verdict.gate} ${verdict.verdict} @ ${shortSha}${blockers}`;
};

/**
 * The shared note shape, in a fixed key order — see the module header for
 * what it never carries. Throws only on an unknown/absent `stop`: every
 * other field is optional and renders `unknown` rather than being guessed or
 * omitted, so a reader always sees the same ten lines.
 */
export const composeNote = ({
  ticket,
  stop,
  branch,
  pr,
  headSha,
  gateRounds,
  verdict,
  diagnosis,
  remaining,
} = {}) => {
  if (!STOP_KINDS.includes(stop)) {
    throw new Error(
      `continuation note needs --stop to be one of ${STOP_KINDS.join(', ')}; got ${JSON.stringify(stop)}.`,
    );
  }

  const lines = [
    'rig-continuation v1',
    `ticket: ${ticket ?? 'unknown'}`,
    `stop: ${stop}`,
    `branch: ${branch ?? 'unknown'}`,
    `pr: ${pr ?? 'unknown'}`,
    `head: ${headSha ?? 'unknown'}`,
    `gate-rounds: ${gateRounds ?? 'unknown'}`,
    `latest-verdict: ${renderVerdict(verdict)}`,
    `diagnosis: ${composeTextField(diagnosis)}`,
    `remaining: ${composeTextField(remaining)}`,
  ];

  return capNote(lines.join('\n'));
};

/**
 * The latest gate decision this run's journal carries, or nulls — never a
 * throw. `runDir` absent, non-existent, unreadable, or carrying no decision
 * at all are all read the same way: there is no evidence, not an error.
 */
export const readRunEvidence = (runDir) => {
  try {
    const { decisions } = readRun({ runDir });
    if (decisions.length === 0) return { gate: null, verdict: null, headSha: null, blockers: [] };
    const latest = decisions[decisions.length - 1];
    return {
      gate: latest.gate ?? null,
      verdict: latest.verdict ?? null,
      headSha: latest.headSha ?? null,
      blockers: Array.isArray(latest.blockers) ? latest.blockers.map((blocker) => blocker.rule) : [],
    };
  } catch {
    return { gate: null, verdict: null, headSha: null, blockers: [] };
  }
};

// --- CLI ---------------------------------------------------------------

const gitValue = (args, cwd) => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: withoutGitLocation(),
    }).trim();
  } catch {
    return null;
  }
};

const parseArgs = (argv) => {
  const args = { ticket: null, stop: null, pr: null, diagnosis: null, remaining: null, post: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--ticket') args.ticket = argv[(i += 1)] ?? null;
    else if (flag === '--stop') args.stop = argv[(i += 1)] ?? null;
    else if (flag === '--pr') args.pr = argv[(i += 1)] ?? null;
    else if (flag === '--diagnosis') args.diagnosis = argv[(i += 1)] ?? null;
    else if (flag === '--remaining') args.remaining = argv[(i += 1)] ?? null;
    else if (flag === '--post') args.post = true;
    else return { error: `unknown flag ${flag}` };
  }
  if (!args.ticket) {
    return {
      error:
        'usage: node continuation.mjs --ticket <id> --stop escalation|blocker|pause|terminated ' +
        '[--pr <n>] [--diagnosis <text>] [--remaining <text>] [--post]\n--ticket is required.',
    };
  }
  if (!STOP_KINDS.includes(args.stop)) {
    return {
      error: `--stop must be one of ${STOP_KINDS.join(', ')}; got ${JSON.stringify(args.stop)}.`,
    };
  }
  return { ok: true, ...args };
};

/**
 * Was this file invoked directly? Compared by REALPATH on both sides, the
 * same shape every CLI sibling in this directory uses (see
 * `duplicate-work.mjs`'s own copy for the symlinked-checkout case it guards).
 */
const invokedDirectly = () => {
  if (!process.argv[1]) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
};

if (invokedDirectly()) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(1);
  }

  const cwd = process.cwd();
  const branch = gitValue(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const headSha = gitValue(['rev-parse', 'HEAD'], cwd);

  const gateRounds = await (async () => {
    if (!branch) return null;
    try {
      const { gateRoundsFor } = await import('./queue/gate-rounds.mjs');
      return gateRoundsFor({ branch, projectRoot: cwd });
    } catch {
      return null;
    }
  })();

  // `readRunEvidence` already reports nulls for an undeclared/unreadable run
  // — passing `undefined` when RIG_RUN_DIR is unset takes that same path.
  const verdict = readRunEvidence(process.env.RIG_RUN_DIR);

  const note = composeNote({
    ticket: parsed.ticket,
    stop: parsed.stop,
    branch,
    pr: parsed.pr,
    headSha,
    gateRounds,
    verdict,
    diagnosis: parsed.diagnosis,
    remaining: parsed.remaining,
  });

  process.stdout.write(`${note}\n`);

  // `--post` is the ONLY branch that resolves a queue adapter or touches the
  // network — every other path above is local evidence gathering.
  if (parsed.post) {
    try {
      const { loadConfig, resolveAdapter } = await import('./queue/index.mjs');
      const configPath = join(cwd, '.claude', 'queue.json');
      const config = loadConfig(configPath);
      const adapter = await resolveAdapter(config.adapter ?? 'plan-md');
      const result = await adapter.comment({ id: parsed.ticket }, note, { env: process.env });
      if (!result?.ok) {
        process.stderr.write(
          `continuation: the note above was NOT posted — ${result?.why ?? 'the adapter refused'}\n`,
        );
        process.exit(1);
      }
    } catch (error) {
      process.stderr.write(`continuation: the note above was NOT posted — ${error.message}\n`);
      process.exit(1);
    }
  }

  process.exit(0);
}
