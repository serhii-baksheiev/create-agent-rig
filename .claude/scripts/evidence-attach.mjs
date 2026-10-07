#!/usr/bin/env node
// Artifact evidence (opt-in workflow layer, RP-312): attach an externally
// produced artifact — a test report, a scan, a browser trace, a reviewer's
// note — to a queue item as bounded, provenance-aware Rig evidence.
//
//   node .claude/scripts/evidence-attach.mjs attach --ticket <id> \
//        --kind <token> --producer <token> [--producer-version <version>] \
//        --subject-kind <token> --subject-id <text> [--subject-version <text>] \
//        --authority-class <token> (--file <path> | --ref <text>) \
//        [--advisory-decision <pass|concerns|fail>] [--advisory-summary <text>] [--json]
//   node .claude/scripts/evidence-attach.mjs list --ticket <id> [--json]
//
// Why, the descriptor, advisory-only producer decisions, the identity
// boundary and the non-goals: `docs/decisions/artifact-evidence.md`.
// Current-head staleness is read by gate coverage, not here.
//
// `attach` needs a declared run (RIG_RUN_DIR) whose journal shows the ticket
// was selected (the queue's SELECT revalidation event) and a repository with a
// HEAD commit; the descriptor binds the artifact to that item and that head. It
// journals one `artifact-evidence` run EVENT first and only then appends the
// same descriptor to `.rig/evidence/<ticket>.jsonl` through
// `lib/item-records.mjs` — the item-owned record mechanism `.rig/decisions/`
// uses too, so there is one evidence store, not a provider-specific one. A
// journal that cannot be written stops the attach before the evidence file is
// touched. It never writes a gate verdict: an external `pass|concerns|fail`
// is carried as `advisory` data and nothing else.
//
// `list` needs neither: it reads the committed record back, bounded, and
// refuses a forged line (a field missing, another item, a verdict word where
// only an advisory word or an authority class belongs) as unreadable, exit 2.
//
// Tests: `test/template/evidence-attach.test.ts` (absent in a generated rig).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withoutGitLocation } from './git-env.mjs';
import { composeCappedTextField, composeTextField } from './continuation.mjs';
import { readRun, recordEvent } from './run-journal.mjs';
import { findSecretValues, isCredentialPath } from './lib/secrets.mjs';
import { VERDICT_WORDS } from './lib/verdict.mjs';
import {
  appendItemRecordLine,
  ensureItemRecordDir,
  itemRecordPathFor,
  readItemRecordFile,
} from './lib/item-records.mjs';

/** What an external producer may say about its own artifact — data, never a Rig verdict. */
export const ADVISORY_DECISIONS = Object.freeze(['pass', 'concerns', 'fail']);

const SCHEMA_VERSION = 1;
const MAX_EVIDENCE_BYTES = 256 * 1024;
const MAX_REF_LENGTH = 2048;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const HASH_CHUNK = 64 * 1024;

/** kind, producer, subject kind, authority class: lowercase, 1-64 characters. */
const TOKEN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** The producer's own version, e.g. `1.27.2` or `0.0.83`: one token, 1-64 characters. */
const PRODUCER_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const HEAD_SHA = /^[0-9a-f]{7,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const REQUIRED_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'subject',
  'authorityClass',
  'producer',
  'ref',
  'sha256',
  'item',
  'headSha',
  'producedAt',
]);

/** `scheme://authority…` — group 1 the scheme, group 2 the authority. */
const REMOTE_REF = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s]*)/i;

/**
 * The item a run took up: the SELECT revalidation event the queue journals at
 * selection — the same predicate `queue/index.mjs` reads to tell a resume
 * from a first selection.
 */
const isSelectionOf = (event, ticket) =>
  event?.kind === 'revalidation' &&
  event.data?.point === 'SELECT' &&
  String(event.data?.ticket) === ticket &&
  typeof event.data?.result === 'string' &&
  typeof event.data?.sourcePointer === 'string';

const isVerdictWord = (value) =>
  typeof value === 'string' && VERDICT_WORDS.includes(value.toUpperCase());

/** Why an authority class cannot be accepted, or null when it can. */
const authorityClassProblem = (value) => {
  if (isVerdictWord(value)) {
    return 'is a Rig verdict word; an external producer describes where evidence came from and never grants a verdict';
  }
  if (typeof value !== 'string' || !TOKEN.test(value)) return 'is not a lowercase token';
  return null;
};

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Why a parsed record cannot be genuine evidence for `ticket`, or null. */
const recordProblem = (record, ticket) => {
  if (!isPlainObject(record)) return 'not a JSON object';
  const missing = REQUIRED_KEYS.filter((key) => !Object.hasOwn(record, key));
  if (missing.length > 0) return `missing required field(s): ${missing.join(', ')}`;
  if (record.schemaVersion !== SCHEMA_VERSION) {
    return `schemaVersion ${JSON.stringify(record.schemaVersion)} is not ${SCHEMA_VERSION}`;
  }
  if (ticket !== undefined && record.item !== ticket) {
    return `item ${JSON.stringify(record.item)} does not match the requested ${JSON.stringify(ticket)}`;
  }
  for (const key of ['kind', 'producer']) {
    if (typeof record[key] !== 'string' || !TOKEN.test(record[key])) {
      return `${key} ${JSON.stringify(record[key])} is not a lowercase token`;
    }
  }
  if (
    Object.hasOwn(record, 'producerVersion') &&
    (typeof record.producerVersion !== 'string' || !PRODUCER_VERSION.test(record.producerVersion))
  ) {
    return `producerVersion ${JSON.stringify(record.producerVersion)} is not a version token`;
  }
  const authority = authorityClassProblem(record.authorityClass);
  if (authority) return `authorityClass ${JSON.stringify(record.authorityClass)} ${authority}`;
  const { subject } = record;
  if (
    !isPlainObject(subject) ||
    typeof subject.kind !== 'string' ||
    !TOKEN.test(subject.kind) ||
    typeof subject.id !== 'string' ||
    (Object.hasOwn(subject, 'version') && typeof subject.version !== 'string')
  ) {
    return 'subject is not { kind, id, version? }';
  }
  if (typeof record.ref !== 'string' || record.ref === '' || record.ref.length > MAX_REF_LENGTH) {
    return 'ref is not a non-empty bounded string';
  }
  if (record.sha256 !== null && (typeof record.sha256 !== 'string' || !SHA256.test(record.sha256))) {
    return 'sha256 is neither null nor a lowercase SHA-256 digest';
  }
  if (typeof record.headSha !== 'string' || !HEAD_SHA.test(record.headSha)) {
    return 'headSha is not a commit id';
  }
  if (typeof record.producedAt !== 'string' || Number.isNaN(Date.parse(record.producedAt))) {
    return 'producedAt is not a timestamp';
  }
  if (Object.hasOwn(record, 'advisory')) {
    const { advisory } = record;
    if (!isPlainObject(advisory) || !ADVISORY_DECISIONS.includes(advisory.decision)) {
      return `advisory.decision is not one of ${ADVISORY_DECISIONS.join(', ')}`;
    }
    if (Object.hasOwn(advisory, 'summary') && typeof advisory.summary !== 'string') {
      return 'advisory.summary is not a string';
    }
  }
  return null;
};

/**
 * Parse an evidence file's text into records, or report the first line that
 * cannot be genuine evidence: `{ ok: true, records } | { ok: false, line, reason }`.
 */
export const parseEvidence = (text, { ticket } = {}) => {
  if (text === '') return { ok: true, records: [] };
  const lines = text.split('\n');
  // The one trailing empty element is the file's own final newline.
  if (lines[lines.length - 1] === '') lines.pop();
  // Every line's syntax first, then every record's meaning — so the first
  // report names the first line that is not JSON at all.
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      records.push(JSON.parse(lines[index]));
    } catch {
      return { ok: false, line: index + 1, reason: 'invalid JSON' };
    }
  }
  for (let index = 0; index < records.length; index += 1) {
    const problem = recordProblem(records[index], ticket);
    if (problem) return { ok: false, line: index + 1, reason: problem };
  }
  return { ok: true, records };
};

// --- CLI -----------------------------------------------------------------

// eslint-disable-next-line no-control-regex -- the control range IS the subject of this regex
const ESCAPE_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const printable = (text) =>
  String(text).replace(ESCAPE_CONTROL_CHARS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** Refusals echo argv, so every control character is escaped before it reaches a terminal. */
const refuse = (message) => {
  process.stderr.write(`evidence-attach: ${printable(message)}\n`);
  process.exit(1);
};

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

const ATTACH_FLAGS = Object.freeze({
  '--ticket': 'ticket',
  '--kind': 'kind',
  '--producer': 'producer',
  '--producer-version': 'producerVersion',
  '--subject-kind': 'subjectKind',
  '--subject-id': 'subjectId',
  '--subject-version': 'subjectVersion',
  '--authority-class': 'authorityClass',
  '--file': 'file',
  '--ref': 'ref',
  '--advisory-decision': 'advisoryDecision',
  '--advisory-summary': 'advisorySummary',
});

const LIST_FLAGS = Object.freeze({ '--ticket': 'ticket' });

const parseFlags = (argv, valueFlags) => {
  const out = { json: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) return { ok: false, error: `${flag} was given more than once.` };
    seen.add(flag);
    if (flag === '--json') {
      out.json = true;
      continue;
    }
    const key = valueFlags[flag];
    if (key === undefined) return { ok: false, error: `unrecognised argument ${JSON.stringify(flag)}.` };
    const value = argv[index + 1];
    if (value === undefined) return { ok: false, error: `${flag} needs a value.` };
    out[key] = value;
    index += 1;
  }
  return { ok: true, value: out };
};

/**
 * The artifact at `file` (relative to `cwd`, or absolute): inside the project,
 * a regular file reached without a symlink, not a credential path, and at most
 * MAX_ARTIFACT_BYTES — hashed through the open handle in bounded chunks.
 */
const hashLocalArtifact = (file, cwd, projectRoot) => {
  const absolute = isAbsolute(file) ? file : resolve(cwd, file);
  let pathStat;
  try {
    pathStat = lstatSync(absolute);
  } catch (error) {
    throw new Error(`--file ${JSON.stringify(file)} cannot be read — ${error.code ?? error.message}.`, {
      cause: error,
    });
  }
  if (pathStat.isSymbolicLink()) throw new Error(`--file ${JSON.stringify(file)} is a symlink; refusing to follow it.`);
  if (!pathStat.isFile()) throw new Error(`--file ${JSON.stringify(file)} is not a regular file.`);

  const root = realpathSync(projectRoot);
  const real = realpathSync(absolute);
  const rel = relative(root, real);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`--file ${JSON.stringify(file)} is outside the project; evidence names only project files.`);
  }
  const ref = rel.split(sep).join('/');
  if (isCredentialPath(ref)) {
    throw new Error(`--file names a credential path (${ref}); it is never hashed or recorded.`);
  }

  const fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
      throw new Error(`--file ${JSON.stringify(file)} changed under the check.`);
    }
    if (stat.size > MAX_ARTIFACT_BYTES) {
      throw new Error(`--file exceeds ${MAX_ARTIFACT_BYTES} bytes; attach a --ref to it instead.`);
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(HASH_CHUNK);
    let total = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, HASH_CHUNK, null);
      if (read === 0) break;
      total += read;
      if (total > MAX_ARTIFACT_BYTES) {
        throw new Error(`--file exceeds ${MAX_ARTIFACT_BYTES} bytes; attach a --ref to it instead.`);
      }
      hash.update(buffer.subarray(0, read));
    }
    return { ref, sha256: hash.digest('hex') };
  } finally {
    closeSync(fd);
  }
};

const runAttach = (argv, cwd) => {
  const parsed = parseFlags(argv, ATTACH_FLAGS);
  if (!parsed.ok) return refuse(parsed.error);
  const options = parsed.value;

  for (const [flag, key] of [
    ['--ticket', 'ticket'],
    ['--kind', 'kind'],
    ['--producer', 'producer'],
    ['--subject-kind', 'subjectKind'],
    ['--subject-id', 'subjectId'],
    ['--authority-class', 'authorityClass'],
  ]) {
    if (options[key] === undefined) return refuse(`${flag} is required.`);
  }
  for (const [flag, key] of [
    ['--kind', 'kind'],
    ['--producer', 'producer'],
    ['--subject-kind', 'subjectKind'],
  ]) {
    if (!TOKEN.test(options[key])) {
      return refuse(`${flag} ${JSON.stringify(options[key])} is not a lowercase token (1-64 of a-z 0-9 . _ -).`);
    }
  }
  if (options.producerVersion !== undefined && !PRODUCER_VERSION.test(options.producerVersion)) {
    return refuse(
      `--producer-version ${JSON.stringify(options.producerVersion)} is not a version token (1-64 of A-Z a-z 0-9 . + _ -).`,
    );
  }
  if (options.producerVersion !== undefined && findSecretValues(options.producerVersion).length > 0) {
    return refuse('--producer-version carries a credential-shaped value; it is never recorded.');
  }
  const authority = authorityClassProblem(options.authorityClass);
  if (authority) return refuse(`--authority-class ${JSON.stringify(options.authorityClass)} ${authority}.`);
  if ((options.file === undefined) === (options.ref === undefined)) {
    return refuse('exactly one of --file or --ref is required.');
  }
  if (options.advisoryDecision !== undefined && !ADVISORY_DECISIONS.includes(options.advisoryDecision)) {
    return refuse(`--advisory-decision must be one of ${ADVISORY_DECISIONS.join(', ')}.`);
  }
  if (options.advisorySummary !== undefined && options.advisoryDecision === undefined) {
    return refuse('--advisory-summary needs --advisory-decision.');
  }
  if (options.ref !== undefined) {
    // Whitespace or a control character anywhere is refused first: a URL parser
    // strips tabs and newlines, so the authority read below would otherwise
    // stop short of userinfo that a client still sends.
    // eslint-disable-next-line no-control-regex -- the control range IS the subject of this regex
    if (/[\s\u0000-\u001f\u007f-\u009f]/u.test(options.ref)) {
      return refuse('--ref carries whitespace or a control character.');
    }
    if (options.ref === '' || options.ref.length > MAX_REF_LENGTH) {
      return refuse(`--ref must be 1-${MAX_REF_LENGTH} characters.`);
    }
    if (findSecretValues(options.ref).length > 0) {
      return refuse('--ref carries a credential-shaped value; it is never recorded.');
    }
    const remote = REMOTE_REF.exec(options.ref);
    if (!remote || remote[1].toLowerCase() === 'file' || remote[2] === '') {
      return refuse(
        '--ref must be a remote reference (scheme://host/…); a local file goes through --file, which hashes it.',
      );
    }
    if (remote[2].includes('@') || options.ref.includes('\\')) {
      return refuse('--ref carries URL userinfo; credentials in a reference are never recorded.');
    }
    // The parser a consumer uses decides last: it reads the authority past
    // slashes and backslashes the regex above stops at.
    let parsed;
    try {
      parsed = new URL(options.ref);
    } catch {
      return refuse('--ref is not a URL a client could parse.');
    }
    if (parsed.protocol === 'file:' || parsed.host === '') {
      return refuse('--ref must be a remote reference (scheme://host/…).');
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return refuse('--ref carries URL userinfo; credentials in a reference are never recorded.');
    }
  }

  const runDir = process.env.RIG_RUN_DIR;
  if (!runDir) {
    return refuse('RIG_RUN_DIR is not set, so there is no run to journal this evidence in.');
  }

  let selected;
  try {
    selected = readRun({ runDir }).events.some((event) => isSelectionOf(event, options.ticket));
  } catch (error) {
    return refuse(`the run journal in RIG_RUN_DIR is unreadable — ${error.message}`);
  }
  if (!selected) {
    return refuse(
      `${options.ticket} was not selected in this run (no SELECT revalidation in the run journal); ` +
        'evidence attaches only to an item the run took up.',
    );
  }

  const projectRoot = gitValue(['rev-parse', '--show-toplevel'], cwd);
  if (!projectRoot) return refuse('not inside a git repository.');
  const headSha = gitValue(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], cwd);
  if (!headSha) return refuse('the repository has no HEAD commit to bind the evidence to.');

  let evidencePath;
  try {
    evidencePath = itemRecordPathFor(projectRoot, 'evidence', options.ticket);
  } catch (error) {
    return refuse(error.message);
  }

  let artifact;
  if (options.file !== undefined) {
    try {
      artifact = hashLocalArtifact(options.file, cwd, projectRoot);
    } catch (error) {
      return refuse(error.message);
    }
  } else {
    artifact = { ref: options.ref, sha256: null };
  }

  const subject = { kind: options.subjectKind, id: composeTextField(options.subjectId) };
  if (options.subjectVersion !== undefined) subject.version = composeTextField(options.subjectVersion);

  const descriptor = {
    schemaVersion: SCHEMA_VERSION,
    kind: options.kind,
    subject,
    authorityClass: options.authorityClass,
    producer: options.producer,
    ...(options.producerVersion === undefined ? {} : { producerVersion: options.producerVersion }),
    ref: artifact.ref,
    sha256: artifact.sha256,
    item: options.ticket,
    headSha,
    producedAt: new Date().toISOString(),
  };
  if (options.advisoryDecision !== undefined) {
    descriptor.advisory = { decision: options.advisoryDecision };
    if (options.advisorySummary !== undefined) {
      descriptor.advisory.summary = composeCappedTextField(options.advisorySummary);
    }
  }

  // Journal first: a run that cannot record what it attached attaches nothing.
  try {
    recordEvent({ runDir, kind: 'artifact-evidence', data: descriptor, now: descriptor.producedAt });
  } catch (error) {
    return refuse(`the run journal refused the evidence event — ${error.message}`);
  }

  try {
    ensureItemRecordDir(projectRoot, 'evidence');
    appendItemRecordLine(evidencePath, `${JSON.stringify(descriptor)}\n`);
  } catch (error) {
    process.stderr.write(
      `evidence-attach: ${printable(`journaled, but ${relative(projectRoot, evidencePath)} was not written — ${error.message}`)}\n`,
    );
    process.exit(2);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(descriptor)}\n`);
  } else {
    process.stdout.write(
      `evidence-attach: ${descriptor.kind} from ${descriptor.producer} attached to ${descriptor.item} ` +
        `at ${headSha.slice(0, 12)} — ${relative(projectRoot, evidencePath).split(sep).join('/')}\n`,
    );
  }
  process.exit(0);
};

const runList = (argv, cwd) => {
  const parsed = parseFlags(argv, LIST_FLAGS);
  if (!parsed.ok) return refuse(parsed.error);
  const { ticket, json } = parsed.value;
  if (ticket === undefined) return refuse('--ticket is required.');

  const projectRoot = gitValue(['rev-parse', '--show-toplevel'], cwd) ?? cwd;
  let evidencePath;
  try {
    evidencePath = itemRecordPathFor(projectRoot, 'evidence', ticket);
  } catch (error) {
    return refuse(error.message);
  }

  let file;
  try {
    file = readItemRecordFile(evidencePath, { maxBytes: MAX_EVIDENCE_BYTES });
  } catch (error) {
    process.stderr.write(
      `evidence-attach: ${printable(`${evidencePath} is unreadable — ${error.message}`)}\n`,
    );
    process.exit(2);
  }
  let records = [];
  if (file.exists) {
    const result = parseEvidence(file.text, { ticket });
    if (!result.ok) {
      process.stderr.write(
        `evidence-attach: ${printable(`${evidencePath} line ${result.line} is unreadable — ${result.reason}`)}\n`,
      );
      process.exit(2);
    }
    records = result.records;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(records)}\n`);
  } else if (records.length === 0) {
    process.stdout.write(`evidence-attach: no evidence recorded for ${ticket}.\n`);
  } else {
    for (const record of records) {
      const advisory = record.advisory ? ` advisory=${record.advisory.decision}` : '';
      process.stdout.write(
        printable(
          `${record.producedAt} ${record.kind} from ${record.producer} (${record.authorityClass}) ` +
            `at ${record.headSha.slice(0, 12)}${advisory} — ${record.ref}`,
        ) + '\n',
      );
    }
  }
  process.exit(0);
};

const invokedDirectly = () => {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(process.argv[1]) === real(fileURLToPath(import.meta.url));
};

if (invokedDirectly()) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'attach') runAttach(rest, process.cwd());
  else if (command === 'list') runList(rest, process.cwd());
  else refuse('usage: evidence-attach.mjs attach … | list --ticket <id> [--json]');
}
