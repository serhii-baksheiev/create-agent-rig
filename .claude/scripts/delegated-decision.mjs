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
// `record` never follows a symlink out of the project. `.rig` and
// `.rig/decisions` are each `lstat`-checked (refusing a symlink or a
// non-directory) before use, created one path segment at a time when
// missing, and the resulting directory's realpath is checked against
// `<realpath of project root>/.rig/decisions` before anything is written;
// the evidence file itself is opened `O_NOFOLLOW`. See `describe
// ('delegated-decision.mjs record — never follows a symlink out of the
// project, and writes nothing outside it')` for all three cases (`.rig`
// itself, `.rig/decisions`, and the ticket file).
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
// it, `record` never reads `.claude/queue.json` and never resolves an
// adapter at all; a project with no such file records perfectly well — ›
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
//   letter or digit, the rest letters/digits/`_`/`-` (`decisionsPathFor`'s
//   own `SAFE_TICKET` pattern) — this value becomes a FILENAME, not merely
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
// - `list` never follows a symlink, and never blocks on a non-regular file.
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
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withoutGitLocation } from './git-env.mjs';
import { composeCappedTextField, composeTextField } from './continuation.mjs';
import { readState } from './run-state.mjs';
import { DECISION_AUTHORITIES, mayResolve, parseDecisionAuthority } from './lib/authority.mjs';
import { recordEvent } from './run-journal.mjs';

const DECISIONS_ROOT = ['.rig', 'decisions'];
const MAX_DECISIONS_BYTES = 256 * 1024;

/** 1-64 characters; starts with a letter or digit; the rest letters, digits, `_` or `-`. */
const SAFE_TICKET = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Windows reserved device names — never safe as a filename stem on any platform here. */
const WINDOWS_DEVICE_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/** 1-64 characters; starts with a letter or digit; the rest letters, digits, `_`, `-` or `.`. */
const RELEASE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * `<projectRoot>/.rig/decisions/<ticket>.jsonl`. Throws when `ticket` is not
 * a string matching {@link SAFE_TICKET} — this value becomes a filename, so
 * a path separator or a `..` segment is refused outright rather than
 * scrubbed, unlike the free-text fields below — or when it is a Windows
 * reserved device name, or when it is credential-shaped
 * (`composeTextField(ticket) !== ticket` — the same whole-field secret check
 * every other structured field in this module goes through). See the module
 * header's "Limits" section for the exact tests pinning each refusal.
 */
export const decisionsPathFor = (projectRoot, ticket) => {
  if (typeof ticket !== 'string' || !SAFE_TICKET.test(ticket)) {
    throw new Error(
      `delegated-decision: ${JSON.stringify(ticket)} is not a safe ticket id — expected 1-64 ` +
        'characters, starting with a letter or digit, and only letters, digits, "_" or "-" after that.',
    );
  }
  if (WINDOWS_DEVICE_NAME.test(ticket)) {
    throw new Error(
      `delegated-decision: ${JSON.stringify(ticket)} is a Windows reserved device name and unsafe ` +
        'to use as a ticket id / filename stem.',
    );
  }
  if (composeTextField(ticket) !== ticket) {
    throw new Error(
      'delegated-decision: this ticket id looks like a credential and will not be used as a ' +
        'filename or stored anywhere.',
    );
  }
  return join(projectRoot, ...DECISIONS_ROOT, `${ticket}.jsonl`);
};

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

// --- filesystem safety: never follow a symlink out of the project --------

/**
 * One path segment under `parentDir`: refuse a symlink or a non-directory,
 * create it (one segment, non-recursive — `parentDir` must already exist)
 * when missing, then re-`lstat` the result before trusting it. Mirrors
 * `run-state.mjs`'s `readStateForSelection` lstat-before-trust posture,
 * applied to a directory rather than a file.
 */
const ensureDirSegment = (parentDir, name) => {
  const target = join(parentDir, name);
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`${target} is unreadable — ${error.message}`, { cause: error });
    }
    mkdirSync(target);
    stat = lstatSync(target);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${target} is a symlink; refusing to follow it out of the project.`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${target} is not a directory.`);
  }
  return target;
};

/**
 * `<projectRoot>/.rig/decisions`, safe to write into: neither `.rig` nor
 * `.rig/decisions` is a symlink, both are directories, and the resulting
 * directory's REALPATH is exactly `<realpath of projectRoot>/.rig/decisions`
 * — closing the gap a bind mount or a race between the lstat checks above
 * and this one could otherwise leave open.
 */
const ensureDecisionsDir = (projectRoot) => {
  const rigDir = ensureDirSegment(projectRoot, '.rig');
  const decisionsDir = ensureDirSegment(rigDir, 'decisions');
  const expected = join(realpathSync(projectRoot), '.rig', 'decisions');
  if (realpathSync(decisionsDir) !== expected) {
    throw new Error(`${decisionsDir} resolves outside the project root; refusing to write.`);
  }
  return decisionsDir;
};

/**
 * Append one already-serialised line to the decisions file at `decisionsPath`,
 * never following a symlink: opened `O_NOFOLLOW`, and the open handle is
 * `fstat`-checked before the write. `O_NOFOLLOW` turns a symlinked ticket
 * file into `ELOOP`, reported here as a symlink refusal rather than the bare
 * errno text — see the module header's "Limits" section.
 */
const appendDecisionRecord = (decisionsPath, line) => {
  let fd;
  try {
    fd = openSync(
      decisionsPath,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        // `O_NOFOLLOW` is undefined on some Windows builds of Node — the
        // same `?? 0` fallback `run-state.mjs`'s `readStateForSelection` uses.
        (constants.O_NOFOLLOW ?? 0),
      0o644,
    );
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new Error(`${decisionsPath} is a symlink; refusing to follow it out of the project.`, {
        cause: error,
      });
    }
    throw new Error(`${decisionsPath} is unreadable — ${error.message}`, { cause: error });
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`${decisionsPath} is not a regular file; refusing to write.`);
    }
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
};

/**
 * Read the decisions file at `decisionsPath` for `list`, never following a
 * symlink and never blocking on a non-regular file. `{ exists: false }` for
 * an absent file — the honest "no decision made yet" answer. Mirrors
 * `run-state.mjs`'s `readStateForSelection` lstat-before-open posture: the
 * path is `lstat`-checked FIRST (refusing a symlink or anything that is not
 * a regular file — a FIFO included, so a FIFO with no writer is refused
 * before any `open()` and can never block inside one), the file is then
 * opened `O_NOFOLLOW`, and the open handle is `fstat`-checked again, with
 * the 256 KiB bound, before any byte is read.
 */
const readDecisionsFile = (decisionsPath) => {
  let pathStat;
  try {
    pathStat = lstatSync(decisionsPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    throw new Error(error.message, { cause: error });
  }
  if (pathStat.isSymbolicLink()) {
    throw new Error('is a symlink; refusing to follow it.');
  }
  if (!pathStat.isFile()) {
    throw new Error('is not a regular file.');
  }

  let fd;
  try {
    fd = openSync(decisionsPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw new Error(error.message, { cause: error });
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error('is not a regular file.');
    }
    // Checked on the OPEN HANDLE, before any read, never partially: see the
    // module header's "Limits" section.
    if (stat.size > MAX_DECISIONS_BYTES) {
      throw new Error(
        `exceeds ${MAX_DECISIONS_BYTES} bytes and is refused whole rather than partially read.`,
      );
    }
    return { exists: true, text: readFileSync(fd, 'utf8') };
  } finally {
    closeSync(fd);
  }
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

const VALUE_FLAGS = Object.freeze({
  '--ticket': 'ticket',
  '--decision': 'decision',
  '--summary': 'summary',
  '--evidence': 'evidence',
  '--release': 'release',
});

const parseRecordArgs = (argv) => {
  const args = {
    ticket: undefined,
    decision: undefined,
    summary: undefined,
    evidence: undefined,
    release: undefined,
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
    ensureDecisionsDir(projectRoot);
    appendDecisionRecord(decisionsPath, `${JSON.stringify(record)}\n`);
  } catch (error) {
    return refuse(
      'delegated-decision: the decision above was journalled but the evidence was NOT written — ' +
        error.message,
    );
  }

  const relativePath = relative(projectRoot, decisionsPath);
  process.stdout.write(`recorded ${parsed.decision} for ${parsed.ticket} -> ${relativePath}\n`);

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
    fileResult = readDecisionsFile(decisionsPath);
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

if (invokedDirectly()) {
  const [command, ...rest] = process.argv.slice(2);
  const cwd = process.cwd();

  if (command === 'record') {
    await runRecord(rest, cwd);
  } else if (command === 'list') {
    runList(rest, cwd);
  } else {
    process.stderr.write(
      `unknown command: ${command ?? '(none)'}. This CLI has two: \`record\` and \`list\`.\n`,
    );
    process.exit(1);
  }
}
