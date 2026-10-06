// Item-owned durable records (opt-in workflow layer): one append-only JSONL
// file per queue item under `.rig/<kind>/<ticket>.jsonl`, committed with the
// item's branch so a later session or another clone can read it back.
//
// One mechanism, one implementation (`.claude/rules/invariants.md`): this is
// the path check, the append and the bounded read that `delegated-decision.mjs`
// (RP-340) built for `.rig/decisions/`, extracted so that every kind of item
// record shares them (RP-312). The callers own what a record MEANS — its
// fields, its redaction, its journal event; this module only owns where the
// bytes go and how they are written and read without following a link out of
// the project.
//
// See `test/template/item-records.test.ts` (absent in a generated rig) for
// every refusal below, by name, and `test/template/delegated-decision.test.ts`
// (absent in a generated rig) for the same refusals through the CLI.
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
import { join } from 'node:path';

import { composeTextField } from '../continuation.mjs';

/** The record directories under `.rig/` this module serves. */
export const ITEM_RECORD_KINDS = Object.freeze(['decisions', 'evidence']);

/** 1-64 characters; starts with a letter or digit; the rest letters, digits, `_` or `-`. */
const SAFE_TICKET = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Windows reserved device names — never safe as a filename stem on any platform here. */
const WINDOWS_DEVICE_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

const requireKind = (kind) => {
  if (!ITEM_RECORD_KINDS.includes(kind)) {
    throw new Error(
      `item-records: ${JSON.stringify(kind)} is not an item record kind — expected one of ` +
        `${ITEM_RECORD_KINDS.join(', ')}.`,
    );
  }
};

/**
 * `<projectRoot>/.rig/<kind>/<ticket>.jsonl`. Throws when `kind` is not one
 * of {@link ITEM_RECORD_KINDS}; when `ticket` is not a string matching
 * {@link SAFE_TICKET} — this value becomes a filename, so a path separator or
 * a `..` segment is refused outright rather than scrubbed; when it is a
 * Windows reserved device name; or when it is credential-shaped
 * (`composeTextField(ticket) !== ticket`).
 */
export const itemRecordPathFor = (projectRoot, kind, ticket) => {
  requireKind(kind);
  if (typeof ticket !== 'string' || !SAFE_TICKET.test(ticket)) {
    throw new Error(
      `item-records: ${JSON.stringify(ticket)} is not a safe ticket id — expected 1-64 ` +
        'characters, starting with a letter or digit, and only letters, digits, "_" or "-" after that.',
    );
  }
  if (WINDOWS_DEVICE_NAME.test(ticket)) {
    throw new Error(
      `item-records: ${JSON.stringify(ticket)} is a Windows reserved device name and unsafe ` +
        'to use as a ticket id / filename stem.',
    );
  }
  if (composeTextField(ticket) !== ticket) {
    throw new Error(
      'item-records: this ticket id looks like a credential and will not be used as a ' +
        'filename or stored anywhere.',
    );
  }
  return join(projectRoot, '.rig', kind, `${ticket}.jsonl`);
};

/**
 * One path segment under `parentDir`: refuse a symlink or a non-directory,
 * create it (one segment, non-recursive — `parentDir` must already exist)
 * when missing, then re-`lstat` the result before trusting it.
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
 * `<projectRoot>/.rig/<kind>`, safe to write into: neither `.rig` nor
 * `.rig/<kind>` is a symlink, both are directories, and the resulting
 * directory's REALPATH is exactly `<realpath of projectRoot>/.rig/<kind>` —
 * closing the gap a bind mount or a race between the lstat checks and this
 * one could otherwise leave open.
 */
export const ensureItemRecordDir = (projectRoot, kind) => {
  requireKind(kind);
  const rigDir = ensureDirSegment(projectRoot, '.rig');
  const kindDir = ensureDirSegment(rigDir, kind);
  const expected = join(realpathSync(projectRoot), '.rig', kind);
  if (realpathSync(kindDir) !== expected) {
    throw new Error(`${kindDir} resolves outside the project root; refusing to write.`);
  }
  return kindDir;
};

/**
 * Append one already-serialised line (the caller supplies its newline) to the
 * record file at `recordPath`, never following a link out of the project.
 */
export const appendItemRecordLine = (recordPath, line) => {
  // The path is checked BEFORE any open, because `O_NOFOLLOW` does not exist
  // on Windows: an open-flag defence alone would follow a link there. A path
  // that does not exist yet is created with `O_EXCL`, which refuses anything
  // already at the name on every platform; an existing one must be a regular
  // file with exactly one name, and the opened handle must be that same file.
  let pathStat = null;
  try {
    pathStat = lstatSync(recordPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`${recordPath} is unreadable — ${error.message}`, { cause: error });
    }
  }
  if (pathStat?.isSymbolicLink()) {
    throw new Error(`${recordPath} is a symlink; refusing to follow it out of the project.`);
  }
  if (pathStat && (!pathStat.isFile() || pathStat.nlink !== 1)) {
    throw new Error(`${recordPath} is not a regular file with a single name; refusing to write.`);
  }
  const flags =
    constants.O_WRONLY |
    constants.O_APPEND |
    (pathStat ? 0 : constants.O_CREAT | constants.O_EXCL) |
    // Undefined on Windows; the lstat above and the identity check below are
    // what hold there.
    (constants.O_NOFOLLOW ?? 0);
  let fd;
  try {
    fd = openSync(recordPath, flags, 0o644);
  } catch (error) {
    if (error?.code === 'ELOOP' || error?.code === 'EEXIST') {
      throw new Error(`${recordPath} changed under the check; refusing to write.`, {
        cause: error,
      });
    }
    throw new Error(`${recordPath} is unreadable — ${error.message}`, { cause: error });
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`${recordPath} is not a regular file with a single name; refusing to write.`);
    }
    if (pathStat && (stat.dev !== pathStat.dev || stat.ino !== pathStat.ino)) {
      throw new Error(`${recordPath} changed under the check; refusing to write.`);
    }
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
};

/**
 * Read the record file at `recordPath`, never following a symlink and never
 * blocking on a non-regular file. `{ exists: false }` for an absent file. The
 * path is `lstat`-checked FIRST (refusing a symlink or anything that is not a
 * regular file — a FIFO included, so a FIFO with no writer is refused before
 * any `open()` and can never block inside one), the file is then opened
 * `O_NOFOLLOW`, and the open handle is `fstat`-checked again, with the
 * `maxBytes` bound, before any byte is read: a file over the bound is refused
 * whole, never partially read.
 */
export const readItemRecordFile = (recordPath, { maxBytes }) => {
  let pathStat;
  try {
    pathStat = lstatSync(recordPath);
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
    fd = openSync(recordPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw new Error(error.message, { cause: error });
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error('is not a regular file.');
    }
    if (stat.size > maxBytes) {
      throw new Error(`exceeds ${maxBytes} bytes and is refused whole rather than partially read.`);
    }
    return { exists: true, text: readFileSync(fd, 'utf8') };
  } finally {
    closeSync(fd);
  }
};
