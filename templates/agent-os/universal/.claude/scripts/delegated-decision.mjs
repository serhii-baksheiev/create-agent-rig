#!/usr/bin/env node
// Durable evidence of a `delegated` authority's resolution of an owner-gated
// decision (RP-340), built on the RP-339 authority contract
// (`.claude/scripts/lib/authority.mjs`).
//
// A replacement controller — another session, another machine, days later —
// has to be able to tell an ALREADY-MADE delegated decision from an
// unresolved owner one without depending on conversational memory: the
// session that made the call may be long gone, compacted, or simply someone
// else's. This file is the one place that records that call, durably, in
// `<project root>/.rig/decisions/<ticket>.jsonl` — one append-only line per
// decision — and reads it back:
//
//   node .claude/scripts/delegated-decision.mjs record --ticket <id> \
//        --decision <kind> --summary <text> [--evidence <text>] \
//        [--release <label>] [--post]
//   node .claude/scripts/delegated-decision.mjs list --ticket <id> [--json]
//   node .claude/scripts/delegated-decision.mjs resolve --stop <item-stop-id> [--json]
//
// `resolve` reads, never writes: it answers what THIS run may do about one
// per-item stop, from `queue/stop-class.mjs` and the run's declared authority —
// `describe('delegated-decision.mjs resolve — turns a per-item stop into one
// of three resolutions')` in the test file named below.
//
// `record` may resolve nothing on its own authority. It reads the run's OWN
// declared authority — `run-state.mjs`'s `decisionAuthority`, written by
// `node run-state.mjs authority owner|delegated` into the SAME run directory
// (RP-340's other half, `run-state-authority.test.ts`) — and refuses unless
// that run is exactly `delegated` AND `--decision` names an id
// `DELEGABLE_DECISIONS` lists. An absent authority reads as `owner`
// (`parseDecisionAuthority`'s own default), and every `NON_DELEGABLE_BOUNDARIES`
// id (`publication`, `kill-switch`, …) is refused regardless of authority — the
// same three-way split `mayResolve` enforces, read here rather than
// reimplemented. See `test/template/delegated-decision.test.ts` (absent in a
// generated rig), `describe('delegated-decision.mjs record — refusals write
// nothing and journal nothing')` for every refusal case by name.
//
// `list` needs no run directory and no declared authority at all: it is the
// read side a FRESH controller uses before doing anything else, and it reads
// only what is already on disk — › "a FRESH process with no RIG_RUN_DIR at
// all still reads the made decision — durable, not conversational" and ›
// "a FRESH run directory (a different controller session) still reads the
// made decision".
//
// It NEVER records a transcript, a prompt, source code, or a credential.
// `summary`/`evidence`/`release` go through the EXACT SAME whole-field
// redaction `continuation.mjs` already built — `composeCappedTextField`/
// `composeTextField`, imported rather than copied (`.claude/rules/
// invariants.md`: "one mechanism, one implementation") — so a
// credential-shaped value becomes `[redacted]`, an absolute path becomes
// `[path]`, an embedded line terminator is collapsed, and a free-text value
// is capped at 500 characters with an explicit `[truncated]` marker.
// `ticket`/`branch`/`head` go through `composeTextField`, the same module's
// structured-field pipeline (secret check, path scrub, newline collapse, no
// free-text cap). See `continuation.mjs`'s own header for the redaction
// rules in full; this file never re-derives them.
//
// `record` never writes a line that did not first journal — the ORDER is
// deliberate: the run journal (`run-journal.mjs`'s `recordEvent`, kind
// `delegated-decision`) is appended FIRST; only once that succeeds is the
// durable evidence file appended. A journal failure therefore leaves NO
// evidence at all — the decision then reads back as still open, the safe
// side of the ambiguity — and a later failure writing the evidence file
// (after the event already journalled) exits non-zero naming exactly that:
// the event was journalled but the evidence was NOT written. See ›
// "journals exactly one run-journal EVENT (kind: delegated-decision), and
// writes NOTHING to decisions.jsonl" and › "a refused call journals nothing
// into the run directory either".
//
// `record` never follows a symlink out of the project; the mechanism is
// `lib/item-records.mjs`, shared with every item record kind. `.rig` and
// `.rig/decisions` are each `lstat`-checked (refusing a symlink or a
// non-directory) before use, created one path segment at a time when
// missing, and the resulting directory's realpath is checked against
// `<realpath of project root>/.rig/decisions` before anything is written;
// the evidence file itself is `lstat`-checked before any open (created with
// `O_EXCL` when absent; otherwise it must be a regular file with a single
// name, and the opened handle must be that same file), so the defence does
// not rest on `O_NOFOLLOW`, which Windows lacks. See `describe
// ('delegated-decision.mjs record — never follows a symlink out of the
// project, and writes nothing outside it')` for the cases (`.rig` itself,
// `.rig/decisions`, the ticket file as a symlink, and as a hard link).
//
// `--release <label>` is optional and validated by the same shape a ticket
// id is (see `RELEASE_LABEL` below); omitted, the stored field is `release:
// null`, never absent — › "stores release: null when --release is not given
// at all", › "accepts the well-formed --release label \"rel-1.5.0\"", and ›
// "refuses the unsafe --release label \"\" and writes nothing".
//
// `--post` is the only thing that touches the network, resolved exactly the
// way `continuation.mjs --post` resolves it — `queue/index.mjs`'s
// `loadConfig` + `resolveAdapter`, then that adapter's `comment()`. Without
// it, `record` never resolves an adapter, and reads `.claude/queue.json` only
// for an `extra-gate-round` decision's `options.maxDelegatedRounds` (RP-442);
// a project with no such file records perfectly well — ›
// "works with no .claude/queue.json present at all when --post is not
// given". The posted body is a fixed, line-oriented shape — › "(d) the
// posted comment body starts with \"rig-delegated-decision v1\" and carries
// ticket/decision/authority/summary lines, redacted exactly as the stored
// record".
//
// `list`'s human (non-`--json`) output escapes every C0/C1 control
// character and DEL in a stored field as `\uXXXX` text rather than printing
// it raw — › "never prints a raw ESC byte from a summary that carries one".
// `--json` output is unaffected: `JSON.stringify` already escapes a control
// character inside a JSON string.
//
// `record` prints the decisions file path RELATIVE to the project root,
// never the absolute path — › "prints the decisions file path relative to
// the project root, never absolute".
//
// --- Limits -------------------------------------------------------------
//
// - A ticket id is accepted only by SHAPE: 1-64 characters, starting with a
//   letter or digit, the rest letters/digits/`_`/`-` (`lib/item-records.mjs`'s
//   `SAFE_TICKET` pattern) — this value becomes a FILENAME, not merely
//   an interpolated string, so a path separator or a `..` segment is refused
//   outright rather than scrubbed. On top of the shape check,
//   `decisionsPathFor` also refuses a Windows reserved device name (`CON`,
//   `NUL`, `COM1`…`COM9`, `LPT1`…`LPT9`, case-insensitive) and a
//   credential-shaped value (`composeTextField(ticket) !== ticket` — the
//   same whole-field secret check every other structured field goes
//   through) — › "refuses the Windows reserved device name \"CON\" used as
//   a ticket id" and › "refuses a credential-shaped ticket id, assembled at
//   runtime, and creates no file".
// - A release label is accepted by the same kind of shape, with one more
//   character allowed (`.`, for a version-ish label): 1-64 characters,
//   starting with a letter or digit, the rest letters/digits/`_`/`-`/`.`
//   (`RELEASE_LABEL` below).
// - `list` never reads a decisions file larger than 256 KiB, and never
//   partially: the size is checked (`fstatSync`, on the OPEN FILE HANDLE,
//   never the path) BEFORE any read, so an oversized file is refused whole —
//   › "a file larger than 256 KiB is unreadable — exit 2, never partially
//   read".
// - `list` never follows a symlink at the decisions file itself, and never
//   blocks on a non-regular file.
//   The path is `lstat`-checked first (refusing a symlink or anything that
//   is not a regular file — a FIFO included, so a FIFO with no writer is
//   refused before any `open()` is attempted and can never block inside
//   one), the file is then opened `O_NOFOLLOW`, and the open handle is
//   `fstat`-checked again before any byte is read. See › "a symlink to a
//   regular file elsewhere is unreadable — exit 2, never the target's own
//   content", › "a directory in place of the decisions file is unreadable —
//   exit 2", and › "a FIFO with no writer is unreadable — exit 2 within a
//   bound, never hanging inside open()".
// - `parseDecisions` validates in three passes, never interleaved line by
//   line. First, every line's JSON syntax, in order — the first
//   syntactically invalid line ends the scan immediately. Second, once every
//   line parses, every record's nine required keys, in order, reporting the
//   first record missing one. Third, once every record carries every key,
//   whether the record could be a GENUINE delegated decision at all: its
//   `authority` must be exactly `"delegated"`, its `ticket` must match the
//   one requested (when a ticket was given to check against), and its
//   `decision` must be a delegable id under the RP-339 contract
//   (`mayResolve(decision, 'delegated')`, a non-delegable or unknown id
//   failing this the same way `record` itself would refuse it). A file whose
//   line 2 is malformed JSON is reported as a line-2 problem even when line
//   1 would separately fail a later pass — the passes never run interleaved.
//   See `describe('delegated-decision.mjs list — refuses a forged record as
//   unreadable')` and the matching `parseDecisions(text, { ticket })` cases
//   under `describe('delegated-decision.mjs — exported pure helpers')`.
// - Recording bypasses no mechanical gate: this module never writes to a run
//   journal's `decisions.jsonl` — a delegated decision is a run EVENT
//   (`recordEvent`, kind `delegated-decision`), never a gate VERDICT — and
//   never calls `revalidate.mjs`, `queue/core.mjs`, or `verdict.mjs`, and
//   neither of those three ever references `.rig/decisions` or this file —
//   see `describe('delegated-decision.mjs — recording bypasses no mechanical
//   gate')`.
//
// --- Untested design limits ----------------------------------------------
//
// - The run's authority is SELF-declared. Any session can run `node
//   run-state.mjs authority delegated` into its own run directory; nothing
//   in this file (or in `run-state.mjs`) checks that against anything an
//   owner actually granted. A record this file writes proves what the run
//   DECLARED, never what the owner authorised.
// - A record of a delegable kind is not authenticated against anyone with
//   write access to the branch. This file's whole security model is
//   "evidence, not access control" — it stops a declared-owner run and a
//   forged record from being read back as a resolved decision, and it stops
//   neither a dishonest authority declaration nor a credential-holding
//   writer from fabricating one.
//
// See `test/template/delegated-decision.test.ts` (absent in a generated rig)
// for every case above, by name, next to the assertion that proves it.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withoutGitLocation } from './git-env.mjs';
import { composeCappedTextField, composeTextField } from './continuation.mjs';
import { readState } from './run-state.mjs';
import { DECISION_AUTHORITIES, mayResolve, parseDecisionAuthority } from './lib/authority.mjs';
import { recordEvent } from './run-journal.mjs';
import { ITEM_STOPS, resolutionOf } from './queue/stop-class.mjs';
import { loadConfig } from './queue/queue-config.mjs';
import { mainCheckoutRoot } from './queue/checkout.mjs';
import {
  appendItemRecordLine,
  ensureItemRecordDir,
  itemRecordPathFor,
  readItemRecordFile,
} from './lib/item-records.mjs';

const MAX_DECISIONS_BYTES = 256 * 1024;

/** The owner's delegated-round budget when `.claude/queue.json` names none (RP-442). */
export const DEFAULT_MAX_DELEGATED_ROUNDS = 1;

/** 1-64 characters; starts with a letter or digit; the rest letters, digits, `_`, `-` or `.`. */
const RELEASE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * `<projectRoot>/.rig/decisions/<ticket>.jsonl` — `lib/item-records.mjs`'s
 * `itemRecordPathFor` for the `decisions` kind, which owns every refusal of an
 * unsafe ticket id.
 */
export const decisionsPathFor = (projectRoot, ticket) =>
  itemRecordPathFor(projectRoot, 'decisions', ticket);

const REQUIRED_KEYS = Object.freeze([
  'schemaVersion',
  'ticket',
  'decision',
  'authority',
  'summary',
  'evidence',
  'branch',
  'head',
  'at',
]);

/**
 * Parse a decisions file's text into records, or report exactly where it is
 * unreadable. Three passes, never interleaved — see the module header's
 * "Limits" section for why: every line's JSON syntax first, in file order;
 * then every record's required keys; then, only once every record has every
 * key, whether it could be a GENUINE delegated decision at all (authority,
 * matching ticket when one is given, delegable decision id).
 */
export const parseDecisions = (text, { ticket } = {}) => {
  if (text === '') return { ok: true, records: [] };

  const rawLines = text.split('\n');
  // Exactly one trailing empty element is the artefact of the file's own
  // final newline — every record line this module writes ends with one. A
  // blank line in the MIDDLE of the file is still a real line and still
  // fails the JSON check below.
  if (rawLines[rawLines.length - 1] === '') rawLines.pop();

  const parsed = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    try {
      parsed.push(JSON.parse(rawLines[index]));
    } catch {
      return { ok: false, line: index + 1, reason: 'invalid JSON' };
    }
  }

  for (let index = 0; index < parsed.length; index += 1) {
    const record = parsed[index];
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      return { ok: false, line: index + 1, reason: 'not a JSON object' };
    }
    const missing = REQUIRED_KEYS.filter((key) => !Object.hasOwn(record, key));
    if (missing.length > 0) {
      return { ok: false, line: index + 1, reason: `missing required field(s): ${missing.join(', ')}` };
    }
  }

  // Pass 3 (RP-340 round 1, security): structurally complete is not the same
  // as genuine. A forged line can carry every required key and still claim
  // an authority nobody declared, a ticket it was not filed under, or a
  // decision the RP-339 contract never delegates — any one of those makes
  // the record unreadable, the same as a structural defect.
  for (let index = 0; index < parsed.length; index += 1) {
    const record = parsed[index];
    if (record.authority !== 'delegated') {
      return {
        ok: false,
        line: index + 1,
        reason: `authority is ${JSON.stringify(record.authority)}, not "delegated"`,
      };
    }
    if (ticket !== undefined && record.ticket !== ticket) {
      return {
        ok: false,
        line: index + 1,
        reason: `ticket ${JSON.stringify(record.ticket)} does not match the requested ${JSON.stringify(ticket)}`,
      };
    }
    let delegable;
    try {
      delegable = mayResolve(record.decision, 'delegated');
    } catch {
      return {
        ok: false,
        line: index + 1,
        reason: `decision ${JSON.stringify(record.decision)} is not a decision the authority contract names`,
      };
    }
    if (!delegable) {
      return {
        ok: false,
        line: index + 1,
        reason: `decision ${JSON.stringify(record.decision)} is not delegable`,
      };
    }
  }

  return { ok: true, records: parsed };
};

// --- CLI -----------------------------------------------------------------

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

const projectRootOf = (cwd) => gitValue(['rev-parse', '--show-toplevel'], cwd) ?? cwd;

/**
 * The owner's budget of delegated gate rounds per ticket and branch:
 * `options.maxDelegatedRounds` from the queue config, an owner-composed file,
 * so a controller cannot enlarge it by recording decisions (RP-442).
 */
export const delegatedRoundBudget = (config) => {
  const raw = config?.options?.maxDelegatedRounds;
  if (raw === undefined) return DEFAULT_MAX_DELEGATED_ROUNDS;
  if (!Number.isInteger(raw) || raw < 0) {
    throw new Error(
      `options.maxDelegatedRounds ${JSON.stringify(raw)} is not a non-negative integer.`,
    );
  }
  return raw;
};

/**
 * Every `extra-gate-round` authorization recorded on one branch, whatever
 * ticket each names — the budget belongs to the branch, so a second ticket id
 * cannot buy another round (RP-442 round 2).
 */
export const extraGateRoundsOnBranch = ({ projectRoot, branch }) => {
  const dir = join(projectRoot, '.rig', 'decisions');
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return names.flatMap((name) =>
    extraGateRoundsFor({ projectRoot, ticket: name.slice(0, -'.jsonl'.length), branch }),
  );
};

/** The `extra-gate-round` authorizations recorded for one ticket on one branch. */
export const extraGateRoundsFor = ({ projectRoot, ticket, branch }) => {
  const file = readItemRecordFile(decisionsPathFor(projectRoot, ticket), {
    maxBytes: MAX_DECISIONS_BYTES,
  });
  if (!file.exists) return [];
  const result = parseDecisions(file.text, { ticket });
  if (!result.ok) {
    throw new Error(`the decisions record line ${result.line} is unreadable — ${result.reason}`);
  }
  return result.records.filter(
    (record) => record.decision === 'extra-gate-round' && record.branch === branch,
  );
};

const DECISIONS_PREFIX = '.rig/decisions/';
const MAX_RECORD_WALK = 32;
const MAX_RUN_DIRS = 200;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
/** Gates whose verdict on a head means a review round ran there. */
const REVIEW_GATES = new Set(['pr-ship', 'code-reviewer', 'prose-reviewer', 'security-scanner']);

/**
 * The heads one authorization covers: its own head, then every first-parent
 * commit on top of it that changes only `.rig/decisions/` — committing the
 * record itself must not move the round off the head it was decided for.
 * `null` when HEAD is not such a descendant within the bound.
 */
const recordOnlyChain = (projectRoot, from, to) => {
  if (from === to) return [to];
  let list;
  try {
    list = execFileSync('git', ['rev-list', '--first-parent', `--max-count=${MAX_RECORD_WALK}`, to], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: withoutGitLocation(),
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return null;
  }
  const chain = [];
  for (const sha of list) {
    if (sha === from) return [from, ...chain];
    let changed;
    try {
      changed = execFileSync('git', ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', sha], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: withoutGitLocation(),
      })
        .split('\n')
        .filter(Boolean);
    } catch {
      return null;
    }
    if (changed.length === 0 || !changed.every((path) => path.startsWith(DECISIONS_PREFIX))) return null;
    chain.unshift(sha);
  }
  return null;
};

/** Every `decisions.jsonl` this checkout's runs hold, bounded; throws when one cannot be read. */
const journalDecisionTexts = (projectRoot, runDir) => {
  const dirs = new Set();
  const runsRoot = join(mainCheckoutRoot(projectRoot), '.claude', 'runs');
  let names = [];
  try {
    names = readdirSync(runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  // The newest runs by name (run dirs are timestamp-named): a round spent on
  // the head under review is recent, and an old checkout must not lose
  // delegated rounds for good once it has accumulated many runs.
  for (const name of names.sort().reverse().slice(0, MAX_RUN_DIRS)) dirs.add(join(runsRoot, name));
  if (typeof runDir === 'string' && runDir !== '') dirs.add(runDir);
  const texts = [];
  for (const dir of dirs) {
    const file = join(dir, 'decisions.jsonl');
    let size;
    try {
      size = statSync(file).size;
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (size > MAX_JOURNAL_BYTES) throw new Error(`${file} is over ${MAX_JOURNAL_BYTES} bytes.`);
    texts.push(readFileSync(file, 'utf8'));
  }
  return texts;
};

/**
 * Whether `gate-round --authorized` may run one round past the base cap
 * (RP-442): a durable `extra-gate-round` authorization for this ticket and
 * branch whose head is HEAD, or HEAD's record-only descendant, and no review
 * verdict yet on any head that authorization covers. That verdict set is the
 * only consumption fact — there is no consumed-state file.
 */
export const authorizedRoundFor = ({ projectRoot, ticket, branch, runDir }) => {
  if (typeof ticket !== 'string' || ticket === '') {
    return { ok: false, why: '--authorized needs --ticket <id>, the item the authorization was recorded for.' };
  }
  const head = gitValue(['rev-parse', 'HEAD'], projectRoot);
  if (!head) return { ok: false, why: 'HEAD could not be read.' };
  let records;
  let texts;
  let onBranch;
  let budget;
  try {
    records = extraGateRoundsFor({ projectRoot, ticket, branch });
    onBranch = extraGateRoundsOnBranch({ projectRoot, branch }).length;
    budget = delegatedRoundBudget(loadConfig(join(projectRoot, '.claude', 'queue.json')));
    texts = journalDecisionTexts(projectRoot, runDir);
  } catch (error) {
    return { ok: false, why: `the authorization or its consumption could not be read — ${error.message}` };
  }
  // More authorizations than the owner's budget can only come from outside
  // `record`; none of them is honoured.
  if (onBranch > budget) {
    return {
      ok: false,
      why: `${branch} holds ${onBranch} extra-gate-round authorizations, more than the budget of ${budget}.`,
    };
  }
  for (const record of records) {
    const covered = recordOnlyChain(projectRoot, record.head, head);
    if (covered === null) continue;
    const heads = new Set(covered.map((sha) => sha.toLowerCase()));
    const answered = texts.some((text) =>
      text.split('\n').some((line) => {
        if (line === '') return false;
        let decision;
        try {
          decision = JSON.parse(line);
        } catch {
          return false;
        }
        return (
          REVIEW_GATES.has(decision?.gate) &&
          typeof decision?.headSha === 'string' &&
          heads.has(decision.headSha.toLowerCase())
        );
      }),
    );
    if (answered) {
      return { ok: false, why: `the authorization for ${record.head} is already spent — a review answered on it.` };
    }
    return { ok: true, head: record.head };
  }
  return {
    ok: false,
    why: `no extra-gate-round authorization for ${ticket} on ${branch} matches HEAD ${head}.`,
  };
};

const VALUE_FLAGS = Object.freeze({
  '--ticket': 'ticket',
  '--decision': 'decision',
  '--summary': 'summary',
  '--evidence': 'evidence',
  '--release': 'release',
  '--head': 'head',
});

const parseRecordArgs = (argv) => {
  const args = {
    ticket: undefined,
    decision: undefined,
    summary: undefined,
    evidence: undefined,
    release: undefined,
    head: undefined,
    post: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (Object.hasOwn(VALUE_FLAGS, flag)) {
      // Checked BEFORE the value is read, and the message never says
      // "undefined": a flag with nothing after it is a missing value, not a
      // JavaScript `undefined` the caller typed.
      if (i + 1 >= argv.length) {
        return { error: `record: ${flag} requires a value.` };
      }
      i += 1;
      args[VALUE_FLAGS[flag]] = argv[i];
    } else if (flag === '--post') {
      args.post = true;
    } else {
      return { error: `record: unknown flag ${flag}` };
    }
  }
  return { ok: true, ...args };
};

const parseListArgs = (argv) => {
  const args = { ticket: undefined, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--ticket') {
      if (i + 1 >= argv.length) {
        return { error: 'list: --ticket requires a value.' };
      }
      i += 1;
      args.ticket = argv[i];
    } else if (flag === '--json') {
      args.json = true;
    } else {
      return { error: `list: unknown flag ${flag}` };
    }
  }
  if (typeof args.ticket !== 'string' || args.ticket === '') {
    return { error: 'list: --ticket is required.' };
  }
  return { ok: true, ...args };
};

const refuse = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

/**
 * The `--post` comment body — a fixed, line-oriented shape so a fresh
 * reader (human or script) can parse it without guessing. `release` is
 * omitted entirely when the record carries none, never printed as `release:
 * null`. See the module header's pointer to the exact test pinning this
 * shape.
 */
const composePostBody = (record) => {
  const lines = ['rig-delegated-decision v1', `ticket: ${record.ticket}`];
  if (record.release !== null) lines.push(`release: ${record.release}`);
  lines.push(`decision: ${record.decision}`, `authority: ${record.authority}`, `summary: ${record.summary}`);
  return lines.join('\n');
};

const runRecord = async (argv, cwd) => {
  const parsed = parseRecordArgs(argv);
  if (!parsed.ok) return refuse(parsed.error);

  const projectRoot = projectRootOf(cwd);

  let decisionsPath;
  try {
    decisionsPath = decisionsPathFor(projectRoot, parsed.ticket);
  } catch (error) {
    return refuse(error.message);
  }

  if (typeof parsed.decision !== 'string' || parsed.decision === '') {
    return refuse('record: --decision is required.');
  }
  if (typeof parsed.summary !== 'string' || parsed.summary === '') {
    return refuse('record: --summary is required and may not be empty.');
  }
  if (parsed.release !== undefined && !RELEASE_LABEL.test(parsed.release)) {
    return refuse(
      `record: --release ${JSON.stringify(parsed.release)} is not a safe release label — expected ` +
        '1-64 characters, starting with a letter or digit, and only letters, digits, "_", "-" or ' +
        '"." after that.',
    );
  }

  const runDir = process.env.RIG_RUN_DIR;
  if (!runDir) {
    return refuse(
      'RIG_RUN_DIR is not set, so there is no run whose declared authority this could check — ' +
        'a decision recorded under nobody’s authority is not durable evidence of anything.',
    );
  }

  const rawAuthority = readState(runDir).decisionAuthority;
  const authority = parseDecisionAuthority(rawAuthority);
  if (authority === 'unknown') {
    return refuse(
      `run authority ${JSON.stringify(rawAuthority)} is not something this contract recognises ` +
        `— expected one of ${DECISION_AUTHORITIES.join(', ')}.`,
    );
  }
  if (authority !== 'delegated') {
    return refuse(
      `this decision needs a delegated run authority; this run's declared authority is owner. ` +
        'Only an owner may resolve it directly.',
    );
  }

  let allowed;
  try {
    allowed = mayResolve(parsed.decision, authority);
  } catch (error) {
    return refuse(error.message);
  }
  if (!allowed) {
    return refuse(
      `"${parsed.decision}" is a boundary that stays with the owner regardless of delegation.`,
    );
  }

  const branch = gitValue(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const head = gitValue(['rev-parse', 'HEAD'], cwd);

  let delegatedRound = null;
  // RP-442: an extra gate round is bound to the exact head and branch it was
  // decided for, and to the owner's budget — checked before anything is written.
  if (parsed.decision === 'extra-gate-round') {
    if (parsed.head === undefined) {
      return refuse('record: extra-gate-round requires --head <sha>, the head the round is for.');
    }
    if (!branch || branch === 'HEAD') {
      return refuse('record: extra-gate-round needs a named branch; this checkout is detached.');
    }
    if (parsed.head !== head) {
      return refuse(
        `record: --head ${JSON.stringify(parsed.head)} is not this checkout's HEAD (${head}); ` +
          'an extra gate round is decided for the head under review.',
      );
    }
    let budget;
    let recorded;
    try {
      budget = delegatedRoundBudget(loadConfig(join(projectRoot, '.claude', 'queue.json')));
      recorded = extraGateRoundsOnBranch({ projectRoot, branch }).length;
    } catch (error) {
      return refuse(`record: ${error.message}`);
    }
    delegatedRound = `delegated round ${recorded + 1} of ${budget} on ${branch}`;
    if (recorded >= budget) {
      return refuse(
        `record: the delegated gate-round budget is spent — ${recorded} of ${budget} on ` +
          `${branch}. The next decision belongs to the owner.`,
      );
    }
  }

  const record = {
    schemaVersion: 1,
    ticket: composeTextField(parsed.ticket),
    release: parsed.release === undefined ? null : composeTextField(parsed.release),
    decision: parsed.decision,
    authority,
    summary: composeCappedTextField(parsed.summary),
    evidence: parsed.evidence === undefined ? null : composeCappedTextField(parsed.evidence),
    branch: composeTextField(branch),
    head: composeTextField(head),
    at: new Date().toISOString(),
  };

  // Journal FIRST — a journal failure then leaves no evidence at all, which
  // is the safe side of the ambiguity (see the module header). Never a
  // substitute input to a check that reads its own inputs (see the module
  // header's "Limits" section): this is a run EVENT, not a gate VERDICT.
  try {
    recordEvent({
      runDir,
      kind: 'delegated-decision',
      data: {
        ticket: parsed.ticket,
        release: record.release,
        decision: parsed.decision,
        summary: record.summary,
      },
      now: record.at,
    });
  } catch (error) {
    return refuse(
      `delegated-decision: the decision was NOT recorded — the run journal refused it: ${error.message}`,
    );
  }

  // Only now does the durable evidence file get touched — never following a
  // symlink out of the project (see the module header's "Limits" section).
  try {
    ensureItemRecordDir(projectRoot, 'decisions');
    appendItemRecordLine(decisionsPath, `${JSON.stringify(record)}\n`);
  } catch (error) {
    return refuse(
      'delegated-decision: the decision above was journalled but the evidence was NOT written — ' +
        error.message,
    );
  }

  const relativePath = relative(projectRoot, decisionsPath);
  process.stdout.write(`recorded ${parsed.decision} for ${parsed.ticket} -> ${relativePath}\n`);
  if (delegatedRound !== null) process.stdout.write(`${delegatedRound}\n`);

  // `--post` is the ONLY branch that resolves a queue adapter or touches the
  // network — exactly the way `continuation.mjs --post` resolves one.
  if (parsed.post) {
    try {
      const { loadConfig, resolveAdapter } = await import('./queue/index.mjs');
      const configPath = join(projectRoot, '.claude', 'queue.json');
      const config = loadConfig(configPath);
      const adapter = await resolveAdapter(config.adapter ?? 'plan-md');
      const result = await adapter.comment({ id: parsed.ticket }, composePostBody(record), {
        env: process.env,
      });
      if (!result?.ok) {
        return refuse(
          `delegated-decision: the decision above was recorded but NOT posted — ` +
            `${result?.why ?? 'the adapter refused'}`,
        );
      }
    } catch (error) {
      return refuse(`delegated-decision: the decision above was recorded but NOT posted — ${error.message}`);
    }
  }

  process.exit(0);
};

/** Escape every C0/C1 control character and DEL as `\uXXXX` text — human output only; `--json` needs nothing, `JSON.stringify` already escapes them. */
// eslint-disable-next-line no-control-regex -- the control range IS the subject of this regex
const ESCAPE_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const escapeControlChars = (text) =>
  text.replace(ESCAPE_CONTROL_CHARS, (ch) => `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}`);

const printList = (records, json) => {
  if (json) {
    process.stdout.write(`${JSON.stringify(records)}\n`);
    return;
  }
  for (const record of records) {
    const line = `${record.ticket} ${record.decision} ${record.at} — ${record.summary}`;
    process.stdout.write(`${escapeControlChars(line)}\n`);
  }
};

const runList = (argv, cwd) => {
  const parsed = parseListArgs(argv);
  if (!parsed.ok) return refuse(parsed.error);

  const projectRoot = projectRootOf(cwd);

  let decisionsPath;
  try {
    decisionsPath = decisionsPathFor(projectRoot, parsed.ticket);
  } catch (error) {
    return refuse(error.message);
  }

  let fileResult;
  try {
    fileResult = readItemRecordFile(decisionsPath, { maxBytes: MAX_DECISIONS_BYTES });
  } catch (error) {
    process.stderr.write(`delegated-decision: ${decisionsPath} is unreadable — ${error.message}\n`);
    process.exit(2);
  }

  if (!fileResult.exists) {
    printList([], parsed.json);
    process.exit(0);
  }

  const result = parseDecisions(fileResult.text, { ticket: parsed.ticket });
  if (!result.ok) {
    process.stderr.write(
      `delegated-decision: ${decisionsPath} line ${result.line} is unreadable — ${result.reason}\n`,
    );
    process.exit(2);
  }

  printList(result.records, parsed.json);
  process.exit(0);
};

/**
 * Was this file invoked directly? Compared by REALPATH on both sides, the
 * same shape every CLI sibling in this directory uses.
 */
const invokedDirectly = () => {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
};

const parseResolveArgs = (argv) => {
  const args = { stop: undefined, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--stop') {
      if (i + 1 >= argv.length) {
        return { error: 'resolve: --stop requires a value.' };
      }
      i += 1;
      args.stop = argv[i];
    } else if (flag === '--json') {
      args.json = true;
    } else {
      return { error: `resolve: unknown flag ${flag}` };
    }
  }
  if (typeof args.stop !== 'string' || args.stop === '') {
    return { error: 'resolve: --stop is required.' };
  }
  return { ok: true, ...args };
};

const runResolve = (argv) => {
  const parsed = parseResolveArgs(argv);
  if (!parsed.ok) return refuse(parsed.error);
  const runDir = process.env.RIG_RUN_DIR;
  if (!runDir) {
    return refuse('resolve: RIG_RUN_DIR is not set, so there is no run whose authority to read.');
  }
  const entry = ITEM_STOPS.find((stop) => stop.id === parsed.stop);
  if (!entry) {
    return refuse(
      `resolve: "${parsed.stop}" is not a per-item stop queue/stop-class.mjs names ` +
        `(${ITEM_STOPS.map((stop) => stop.id).join(', ')}).`,
    );
  }
  const authority = parseDecisionAuthority(readState(runDir).decisionAuthority);
  const resolution = resolutionOf({ stopClass: entry.stopClass, authority, decision: entry.decision });
  const answer = {
    stop: entry.id,
    stopClass: entry.stopClass,
    decision: entry.decision,
    authority,
    resolution,
  };
  process.stdout.write(
    parsed.json
      ? `${JSON.stringify(answer)}\n`
      : `${answer.stop}: ${answer.resolution} (${answer.stopClass}, authority ${answer.authority})\n`,
  );
  process.exit(0);
};

if (invokedDirectly()) {
  const [command, ...rest] = process.argv.slice(2);
  const cwd = process.cwd();

  if (command === 'record') {
    await runRecord(rest, cwd);
  } else if (command === 'list') {
    runList(rest, cwd);
  } else if (command === 'resolve') {
    runResolve(rest);
  } else {
    process.stderr.write(
      `unknown command: ${command ?? '(none)'}. This CLI has three: \`record\`, \`list\` and \`resolve\`.\n`,
    );
    process.exit(1);
  }
}
