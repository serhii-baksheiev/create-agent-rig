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
// It NEVER records: a transcript, a prompt, source code, or a credential.
// EVERY string field this composes — `ticket`, `branch`, `pr`, the verdict's
// gate names and blocker rule names, `diagnosis`, `remaining` — goes through
// the same three passes, in this order, before anything is printed or
// posted:
//
//   - an embedded newline is collapsed to `⏎`, so a forged `\nhead: …` line
//     inside free text cannot be read as a second field by a reader who only
//     greps for `^head: `;
//   - an absolute-path SHAPE (see "Limits" below) becomes `[path]`;
//   - a credential-shaped value, judged by the one vocabulary this project
//     already refuses commits over (`lib/secrets.mjs`), becomes `[redacted]`.
//
// `diagnosis` and `remaining` additionally each get their own 500-character
// cap after that (an explicit `[truncated]` marker, never a silent cut); no
// other field is capped on its own — the whole note's 2000-character cap
// (below) is what bounds a long `branch` or similar instead.
//
// Every field this composes is bounded, so one long field cannot make the note
// itself unpostable: `diagnosis` and `remaining` are each capped at 500
// characters, and the WHOLE note is capped at 2000 characters as a backstop
// for a field this module does not cap per-field (`branch`, for instance) —
// see `test/template/continuation.test.ts` (absent in a generated rig) ›
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
//   - gate rounds already spent on THIS branch, in THIS checkout's own
//     counter file (`queue/gate-rounds.mjs`, the same counter `pr-ship`
//     writes) — reported as `unknown`, never `0`, when the counter carries no
//     entry for the branch, because the counter can never observe a genuine,
//     journalled zero (every entry it holds is a positive integer);
//   - the latest REVIEW ROUND — `readRunEvidence(runDir)`, which reads
//     `RIG_RUN_DIR`'s run journal (`run-journal.mjs`) ONLY when that variable
//     is declared: the last `reviewer-fan-out` decision this run recorded,
//     and the latest verdict journalled under each reviewer name IT
//     launched, after it. An undeclared, missing, or unusable run directory,
//     or one that never recorded a fan-out, reports `{ headSha: null,
//     reviewers: [] }` — silently, like every other optional trace in this
//     rig, never a throw.
//
// `--post` resolves the configured queue adapter exactly the way
// `queue/index.mjs` and `preflight.mjs` already do (`loadConfig` +
// `resolveAdapter`) and calls its `comment()`. An adapter that cannot post —
// `plan-md` has no comment thread at all — is a refusal, not a silent no-op:
// the note is still printed, and the process exits non-zero naming why.
//
// `--ticket` is validated against a tracker-key or bare-number shape
// (`/^[A-Z][A-Z0-9_]+-\d+$|^\d+$/`) before anything else runs — including
// before `--post` resolves an adapter at all. This value is later
// interpolated into an adapter call (`comment({ id: ticket }, …)`); refusing
// an unrecognised shape early is cheaper than trusting whatever a caller, or
// a scripted retry, supplies.
//
// --- Limits -----------------------------------------------------------
//
// - The path scrub recognises an absolute path by SHAPE, not by a fixed
//   prefix list, and nothing outside these four shapes:
//     - a tilde-prefixed home path (`~/…`), consumed to the next whitespace;
//     - a drive-letter path (`C:\…` or `C:/…`), consumed to the next `"` or
//       to the end of the field — so embedded spaces (`C:\Users\Some Name\…`)
//       stay part of the match, and a drive letter is only recognised when it
//       is not itself preceded by a letter or digit (so the `s:` inside
//       `https://…` is never mistaken for one);
//     - a `\\host\share\…` UNC path (any host, `\\wsl$\…` and
//       `\\wsl.localhost\…` included), consumed to the next whitespace,
//       together with one immediately preceding `label:` token when the text
//       reads `label: \\host\share\…` — otherwise a line that names the host
//       twice (once as a plain word, once inside the path) leaves the first
//       copy behind;
//     - a slash-rooted POSIX path of two or more segments, consumed to the
//       next whitespace, and only when it is not itself preceded by `:`, a
//       word character, or another `/` — which is what keeps a URL
//       (`https://example.invalid/a/b`) intact rather than being read as a
//       POSIX path starting mid-string.
//   A RELATIVE path (`src/file.ts`, `../sibling/x.ts`), a single-segment
//   absolute path (`/etc` alone, with nothing after it), and any shape this
//   list does not name pass through unscrubbed.
// - Credential redaction reuses `SECRET_VALUE_PATTERNS` from
//   `lib/secrets.mjs` verbatim, so it inherits that module's own stated
//   limits (a text scan, not an entropy analyser; an all-letters secret is
//   invisible to the `assigned-secret` arm) rather than restating them here.
//   A shape that vocabulary does not name — a connection-string password
//   (`postgres://user:hunter2@host/db`), for one — is not redacted here
//   either; it would need a pattern added to `lib/secrets.mjs` itself (one
//   mechanism, one implementation — `invariants.md`), not a second copy here.
// - `readRunEvidence` reads only the latest REVIEW ROUND — every reviewer
//   verdict journalled after the LAST `reviewer-fan-out` decision, and only
//   for the reviewer names that fan-out actually launched. An
//   `item-selection` or `review-routing:*` record, and any verdict from a
//   round before the latest fan-out, are never reported.
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

/** A tracker key (`RP-224`) or a bare issue number (`224`) — nothing else. */
const TICKET_SHAPE = /^[A-Z][A-Z0-9_]+-\d+$|^\d+$/;

const PATH_MARKER = '[path]';
const REDACTED_MARKER = '[redacted]';
const NEWLINE_MARKER = '⏎';
const FIELD_CAP = 500;
const FIELD_TRUNCATION_MARKER = '[truncated]';
const NOTE_CAP = 2000;
const NOTE_TRUNCATION_SUFFIX = '\n[truncated]';

const FAN_OUT_GATE = 'reviewer-fan-out';

// Every character class below is a single bounded repetition — no nested or
// overlapping quantifiers — so each pass is a linear scan of the field, never
// catastrophic-backtracking-prone (`invariants.md`: "no clock, randomness or
// I/O" is not the concern here, but the bounded-work rule for anything that
// runs on untrusted input is the same one).
//
// `~/…`, to the next whitespace.
const TILDE_HOME = /~\/[^\s]+/g;
// A drive letter not itself preceded by a letter/digit (so `http` **s** `:`
// is never read as a drive letter), to the next `"`, `|`, or the end of the
// field — `|` is not a legal Windows path character, so excluding it (rather
// than whitespace, which a real path may legitimately carry) is what lets an
// embedded space survive while a ` | `-joined next field does not.
const DRIVE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^"|\r\n]*/g;
// `\\host\share\…`, to the next whitespace — together with a single,
// immediately preceding `label:` token when one directly precedes it (a
// colon-terminated run of non-whitespace, then the whitespace that separates
// it from the path), so a line reading `host: \\host\share\…` does not leave
// the label's own copy of the hostname behind.
const UNC_PATH = /(?:[^\s:]+:\s+)?\\\\[^\s\\]+\\[^\s]*/g;
// A slash-rooted POSIX path of >= 2 segments, not preceded by `:`, a word
// character, or another `/` — the guard that keeps a URL's path intact.
const POSIX_PATH = /(?<![:\w/])\/[^\s/]+(?:\/[^\s/]+)+/g;

const scrubPaths = (text) =>
  text
    .replace(UNC_PATH, PATH_MARKER)
    .replace(DRIVE_PATH, PATH_MARKER)
    .replace(TILDE_HOME, PATH_MARKER)
    .replace(POSIX_PATH, PATH_MARKER);

/** Collapse an embedded newline so free text cannot forge a second `key: value` line. */
const collapseNewlines = (text) => text.replace(/\r\n|\r|\n/g, NEWLINE_MARKER);

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

/**
 * Collapse newlines, scrub paths, then redact secrets — every string field
 * this note composes goes through this, not only `diagnosis`/`remaining`.
 * `undefined`/`null` render `unknown` rather than being guessed or omitted.
 */
const composeTextField = (value) =>
  value === undefined || value === null ? 'unknown' : redactSecrets(scrubPaths(collapseNewlines(String(value))));

/** `composeTextField`, plus the per-field 500-character cap `diagnosis`/`remaining` carry. */
const composeCappedTextField = (value) =>
  value === undefined || value === null ? 'unknown' : truncateField(composeTextField(value));

/** Cap the WHOLE note — a backstop for a field this module does not cap on its own. */
const capNote = (note) => {
  if (note.length <= NOTE_CAP) return note;
  return `${note.slice(0, NOTE_CAP - NOTE_TRUNCATION_SUFFIX.length)}${NOTE_TRUNCATION_SUFFIX}`;
};

const shortShaOf = (headSha) => (headSha ? String(headSha).slice(0, 7) : 'unknown');

/** Blocker rule names, scrubbed/redacted like every other string field, blanks dropped. */
const renderBlockerRules = (blockers) =>
  Array.isArray(blockers)
    ? blockers.filter((rule) => typeof rule === 'string' && rule.trim() !== '').map(composeTextField)
    : [];

/**
 * Renders either verdict shape `composeNote` accepts:
 *
 *   - a single verdict: `{ gate, verdict, headSha, blockers }`
 *   - a review round: `{ headSha, reviewers: [{ gate, verdict, blockers }, …] }`
 *     — the shape `readRunEvidence` returns.
 *
 * `unknown` when there is nothing to report: no verdict at all, a single
 * verdict missing its `gate`/`verdict`, or a review round with no reviewers.
 */
const renderVerdict = (verdict) => {
  if (!verdict) return 'unknown';

  if (Array.isArray(verdict.reviewers)) {
    if (verdict.reviewers.length === 0) return 'unknown';
    const shortSha = shortShaOf(verdict.headSha);
    const parts = verdict.reviewers.map((reviewer) => {
      const gate = composeTextField(reviewer?.gate);
      const answer = reviewer?.verdict ?? 'unknown';
      const blockers = renderBlockerRules(reviewer?.blockers);
      const suffix = blockers.length > 0 ? ` (${blockers.join(', ')})` : '';
      return `${gate} ${answer}${suffix}`;
    });
    return `${parts.join(', ')} @ ${shortSha}`;
  }

  if (!verdict.gate || !verdict.verdict) return 'unknown';
  const shortSha = shortShaOf(verdict.headSha);
  const gate = composeTextField(verdict.gate);
  const blockers = renderBlockerRules(verdict.blockers);
  const suffix = blockers.length > 0 ? ` — blockers: ${blockers.join(', ')}` : '';
  return `${gate} ${verdict.verdict} @ ${shortSha}${suffix}`;
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
    `ticket: ${composeTextField(ticket)}`,
    `stop: ${stop}`,
    `branch: ${composeTextField(branch)}`,
    `pr: ${composeTextField(pr)}`,
    `head: ${headSha ?? 'unknown'}`,
    `gate-rounds-this-checkout: ${gateRounds ?? 'unknown'}`,
    `latest-verdict: ${renderVerdict(verdict)}`,
    `diagnosis: ${composeCappedTextField(diagnosis)}`,
    `remaining: ${composeCappedTextField(remaining)}`,
  ];

  return capNote(lines.join('\n'));
};

/**
 * The latest REVIEW ROUND this run's journal carries: the last
 * `reviewer-fan-out` decision, and the latest verdict journalled under each
 * reviewer name IT launched, after it — never `item-selection`,
 * `review-routing:*`, or a verdict from a round before the latest fan-out.
 * `runDir` absent, non-existent, unreadable, or carrying no fan-out at all
 * are all read the same way: there is no evidence, not an error.
 */
export const readRunEvidence = (runDir) => {
  try {
    const { decisions } = readRun({ runDir });

    let fanOut = null;
    let fanOutIndex = -1;
    decisions.forEach((decision, index) => {
      if (decision.gate === FAN_OUT_GATE) {
        fanOut = decision;
        fanOutIndex = index;
      }
    });
    if (!fanOut) return { headSha: null, reviewers: [] };

    const launched = Array.isArray(fanOut.reviewers)
      ? new Set(fanOut.reviewers.filter((name) => typeof name === 'string'))
      : new Set();

    const latestByReviewer = new Map();
    for (let index = fanOutIndex + 1; index < decisions.length; index += 1) {
      const decision = decisions[index];
      if (!launched.has(decision.gate)) continue;
      latestByReviewer.set(decision.gate, {
        gate: decision.gate,
        verdict: decision.verdict ?? null,
        blockers: Array.isArray(decision.blockers)
          ? decision.blockers.map((blocker) => blocker.rule)
          : [],
      });
    }

    return {
      headSha: fanOut.headSha ?? null,
      reviewers: Array.from(latestByReviewer.values()),
    };
  } catch {
    return { headSha: null, reviewers: [] };
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
  // Validated FIRST, before the --stop check below and before any adapter is
  // ever resolved: this value is later interpolated into an adapter call.
  if (!TICKET_SHAPE.test(args.ticket)) {
    return {
      error:
        `--ticket must look like a tracker key (e.g. RP-224) or a bare issue number; ` +
        `got ${JSON.stringify(args.ticket)}.`,
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
      const rounds = gateRoundsFor({ branch, projectRoot: cwd });
      // `gateRoundsFor` answers 0 for "no entry at all" — the counter can
      // never hold a genuine journalled zero, so a bare 0 here would always
      // be the absent-entry case wearing the wrong word. Report `unknown`.
      return rounds > 0 ? rounds : null;
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
