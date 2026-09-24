#!/usr/bin/env node
// The unattended flag — how a hook learns that a loop is running, and what the
// current item is allowed to touch (AR-51).
// All upstream test pointers in this script name the generator suite, absent in a generated rig.
//
//   node .claude/scripts/unattended-flag.mjs on --root <checkout> --item AR-51 --run-dir <dir> --allow <prefix> [<prefix>…]
//   node .claude/scripts/unattended-flag.mjs verify --root <checkout> --item AR-51
//   node .claude/scripts/unattended-flag.mjs off --root <checkout>
//   node .claude/scripts/unattended-flag.mjs off --legacy --path <reported-path>
//
// `--root` is mandatory for `on` and `verify` (RP-258) — an unrooted `on`
// wrote a flag `readUnattended` could not tell apart from stale legacy
// machine-wide state, and an unrooted `verify` then read that same ambiguity
// back as armed; both now refuse before doing anything else. `off` keeps its
// own unscoped fallback (see its branch below).
//
// It is a FILE, not an environment variable: a `PreToolUse` hook is spawned by
// the harness with the harness's own environment, never with a variable the
// session exported — the generator's `test/template/guard-rulebook.test.ts` (absent in a generated rig) ›
// "only a flag arms it — an exported RIG_UNATTENDED=1 with no flag changes
// nothing" pins that side of it — and in some harnesses an `export` does not
// even survive to the next Bash call. The kill switch (`stop-flag.mjs`) is a
// file for the same reason,
// and this module copies its two-home lookup. Unlike the machine-wide brake,
// each unattended record is scoped to the canonical checkout, so concurrent
// worktrees cannot overwrite or clear one another's authorization.
//
// The flag is JSON, `{ item, runDir, allow }`. `allow` is the list of
// repo-relative prefixes the current item may write under even though they are
// part of the rulebook — the loop writes it at claim time from the paths the
// item names, and clears the flag when the run ends. A blanket "no rulebook
// edits while unattended" would stall on the first queue item that touches
// `queue/*.mjs`, which is most of this queue; the allow-list is what makes the
// guard livable, and the guard is what makes the allow-list a decision rather
// than a default.
//
// 🔴 Three answers, and the third is not the first: `{ on: false }` when no flag
// exists — an attended session, the guard does nothing; `{ on: true, item,
// runDir, allow }` when it reads; `{ on: true, unreadable: true, why }` when a
// file is THERE and this module cannot read it as the shape above. A guard that
// treated the third as the first would be disarmed by a corrupt flag, which is
// the fail-open bypass `.claude/rules/invariants.md` names.
//
// 🔴 An `allow` entry may not WIDEN the rulebook: one that is a prefix of a
// rulebook prefix — `.`, `.claude/`, `.claude/scripts/`, `CLAUDE` — would let
// the flag disarm the guard for a whole tree while it reports itself as on, so
// the writer refuses it and a flag carrying one is unreadable. An entry outside
// the rulebook (`src/`) is harmless because it is never judged; a narrow entry
// inside it (`.claude/skills/loop/`) authorizes only that subtree. Items name
// both forms, so they are kept — › "an allow entry that widens the rulebook — a prefix of a rulebook prefix such as `.` — makes the flag unreadable".
//
// Bounded: the file is read up to 64 KiB, `allow` is capped at 64 entries, and
// both limits are refusals, never silent truncation. A candidate is opened
// nonblocking and must be a regular file — see the generator's
// `test/template/unattended-flag.test.ts` (absent in a generated rig) ›
// "returns promptly and fails closed when a candidate is a FIFO". An access
// error is unreadable, not absent — › "is on-but-unreadable when access to an
// existing flag fails at the stat boundary".
// Cleanup preserves the same distinction: an owned legacy record that cannot
// be inspected is an error, not evidence that nothing remains — › "exits
// nonzero and leaves an unreadable owned legacy flag in place".
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutGitLocation } from './git-env.mjs';
import { homesOf } from './stop-flag.mjs';

export const FLAG_BASENAME = '__PROJECT_NAME__-loop-UNATTENDED';
export const MAX_FLAG_BYTES = 64 * 1024;
export const MAX_ALLOW_ENTRIES = 64;

/**
 * The files that decide what a session may do — repo-relative prefixes. Owned
 * here because two things read them: the guard, to judge an edit, and the
 * writer above, to refuse an allow-list that reaches outside them.
 */
export const RULEBOOK_PREFIXES = Object.freeze([
  '.agents/',
  '.claude/.rig-manifest.json',
  '.claude/doctor-exemptions.json',
  '.claude/agents/',
  '.claude/hooks/',
  '.claude/settings.json',
  '.claude/queue.json',
  // the per-checkout board selector: picks among the boards queue.json declares,
  // so an unattended run must not be able to re-aim itself through it either
  '.claude/queue.board',
  '.claude/scripts/',
  '.claude/rules/',
  '.claude/skills/',
  '.codex/',
  'AGENTS.md',
  'CLAUDE.md',
  // the detection contract preflight and claim-records both read: it decides
  // whether preflight STOPs and what the scope fingerprint watches, so an
  // unattended run does not rewrite what its own revalidation checks against
  // — outside its item's allow-list, like every other entry here and unlike
  // `.claude/queue.board`, which `guard-rulebook` refuses even when the
  // allow-list names it. The exact file, never `.rig/` — a SELECT still needs to
  // write its own baseline under `.rig/claims/`, which stays unlisted here.
  '.rig/revalidation.json',
]);

// Case-folded once at module load, for the same comparison every caller shares
// — never re-derived per call, and never used anywhere but inside
// `isWidening` below (`canonicalRulebookPath` folds its own comparison from
// `RULEBOOK_PREFIX_SEGMENTS` instead).
const FOLDED_RULEBOOK_PREFIXES = RULEBOOK_PREFIXES.map((prefix) => prefix.toLowerCase());

/**
 * The canonical rulebook spelling of a repo-relative path, or `undefined`
 * when it names no rulebook prefix at all. Case-insensitive on the PREFIX
 * match only — NTFS and default APFS resolve a miscased spelling
 * (`.Codex/config.toml`) to the same file as the canonical one, and this
 * comparison is what a directory this checkout has never created yet (or
 * any path on a case-sensitive filesystem) reaches, exactly as spelled by
 * the caller — see the generator's `test/template/guard-rulebook.test.ts`
 * (absent in a generated rig) › "guard-rulebook: blocks a miscased
 * rulebook path even when the guarded directory does not exist on disk yet
 * (RP-215)" › "blocks a Write to .Codex/config.toml when .codex/ is absent
 * from the checkout".
 *
 * RP-215 round 2: the returned spelling replaces only the matched prefix
 * characters with `RULEBOOK_PREFIXES`' own spelling — the remainder of the
 * path (and any allow-list entry) keeps whatever case it was written in.
 * This is the one place a path is re-cased; every comparison downstream
 * (`isAllowed`, the `.claude/queue.board` carve-out in `guard-rulebook.mjs`)
 * takes this canonical value and stays a literal, case-sensitive match —
 * canonicalising the PATH, never folding the ALLOW-LIST, is what keeps a
 * miscased allow entry (`.Claude/`, `.claude/Scripts/`) from ever matching
 * anything, including the one prefix deliberately withheld as an allow root
 * (`.claude/scripts/`, `isWidening`).
 *
 * RP-243: before the fold above, a trailing run of `.`/` ` is stripped from
 * a path component — `.codex./config.toml` folds the same as
 * `.codex/config.toml` — except a component made entirely of dots (`.`,
 * `..`), left untouched so a traversal segment is never collapsed into an
 * empty name. Only the PATH is normalised this way, never an allow-list
 * entry — the same asymmetry as the case fold above.
 *
 * RP-243 round 2: only the components the matched prefix itself spans are
 * normalised — bounded by the longest `RULEBOOK_PREFIXES` entry's own
 * segment count, computed once below — so a component beyond that span
 * keeps its literal spelling and the canonical path returns it raw. See the
 * generator's `test/template/unattended-flag.test.ts` (absent in a
 * generated rig) › "isRulebookPath: a trailing dot or space on a path
 * component is judged the same as the component with it stripped (RP-243)".
 */
const stripTrailingDotsAndSpaces = (component) => {
  if (/^\.+$/.test(component)) return component;
  let end = component.length;
  while (end > 0) {
    const code = component.charCodeAt(end - 1);
    if (code !== 46 /* '.' */ && code !== 32 /* ' ' */) break;
    end -= 1;
  }
  return end === component.length ? component : component.slice(0, end);
};

/**
 * `RULEBOOK_PREFIXES` split into segments once, at module load — a directory
 * entry (`.claude/hooks/`) drops its trailing slash first, so both forms
 * yield the segment names a path's own `/`-split components are compared
 * against. `directory` records whether the entry itself ended in `/`: a
 * directory entry needs an exact fold-match on every one of its segments
 * plus something after them; a file entry (`CLAUDE.md`, `.rig/revalidation.json`)
 * is matched with a `startsWith` on its last segment — see the generator's
 * `test/template/unattended-flag.test.ts` (absent in a generated rig) ›
 * "isRulebookPath: a path continuing past a matched FILE entry is still a rulebook path (round 3 regression)".
 */
const RULEBOOK_PREFIX_SEGMENTS = RULEBOOK_PREFIXES.map((prefix) => {
  const directory = prefix.endsWith('/');
  const segments = (directory ? prefix.slice(0, -1) : prefix).split('/');
  const foldedSegments = segments.map((segment) => segment.toLowerCase());
  return { prefix, directory, foldedSegments, length: segments.length };
});

// The most components any single entry's match can ever need to inspect —
// never re-derived per call, and the only thing that bounds how many of a
// path's own components `canonicalRulebookPath` normalises.
const MAX_PREFIX_SEGMENTS = RULEBOOK_PREFIX_SEGMENTS.reduce(
  (max, entry) => Math.max(max, entry.length),
  0,
);

export const canonicalRulebookPath = (rel) => {
  const components = rel.split('/');
  const headCount = Math.min(components.length, MAX_PREFIX_SEGMENTS);
  const normalisedHead = new Array(headCount);
  const foldedHead = new Array(headCount);
  for (let i = 0; i < headCount; i += 1) {
    normalisedHead[i] = stripTrailingDotsAndSpaces(components[i]);
    foldedHead[i] = normalisedHead[i].toLowerCase();
  }
  for (const entry of RULEBOOK_PREFIX_SEGMENTS) {
    const { directory, foldedSegments, length: segmentCount, prefix } = entry;
    if (components.length < segmentCount) continue;
    let leadingMatches = true;
    for (let i = 0; i < segmentCount - 1; i += 1) {
      if (foldedHead[i] !== foldedSegments[i]) {
        leadingMatches = false;
        break;
      }
    }
    if (!leadingMatches) continue;
    const lastFolded = foldedHead[segmentCount - 1];
    const lastSegment = foldedSegments[segmentCount - 1];
    if (directory) {
      if (lastFolded !== lastSegment) continue;
      if (components.length === segmentCount) continue; // no trailing slash, nothing after
      if (components.length === segmentCount + 1 && components[segmentCount] === '') {
        return prefix; // the path itself ends with the literal trailing slash
      }
      return prefix + components.slice(segmentCount).join('/');
    }
    // File entry: the last spanned component is compared folded+normalised,
    // same as every other component this function inspects; anything past
    // it — the rest of that component, and every component after it — is
    // returned exactly as written.
    if (lastFolded === lastSegment) {
      if (components.length === segmentCount) return prefix;
      return `${prefix}/${components.slice(segmentCount).join('/')}`;
    }
    if (lastFolded.startsWith(lastSegment)) {
      const extra = normalisedHead[segmentCount - 1].slice(lastSegment.length);
      if (components.length === segmentCount) return prefix + extra;
      return `${prefix}${extra}/${components.slice(segmentCount).join('/')}`;
    }
  }
  return undefined;
};

/** Is this repo-relative path part of the rulebook? See `canonicalRulebookPath`. */
export const isRulebookPath = (rel) => canonicalRulebookPath(rel) !== undefined;

/**
 * Does this allow entry widen the rulebook? It is unsafe when it is an
 * exact protected prefix deliberately unavailable as an allow root (`.agents/`,
 * `.claude/scripts/`, `.codex/`), or when it is a proper prefix of any
 * rulebook prefix and would therefore admit that prefix plus siblings. All
 * protected script paths sit under `.claude/scripts/`; a narrower path such as
 * `.claude/scripts/queue/` is an ordinary allow entry and does not widen it.
 * `src/` also does not widen it because the guard judges nothing there.
 *
 * RP-215 round 2: the entry is case-folded once before either comparison —
 * the allow side now folds like the path side (`canonicalRulebookPath`) — so
 * a miscased entry (`.Claude/`, `.claude/Scripts/`) is judged exactly like its
 * canonical spelling instead of slipping through as ordinary, harmless text;
 * see the generator's `test/template/unattended-flag.test.ts` (absent in a
 * generated rig) › "isWidening: a miscased allow entry must be refused
 * exactly like its canonical spelling (RP-215 round 2)".
 */
export const isWidening = (entry) => {
  if (typeof entry !== 'string' || entry === '') return true;
  const folded = entry.toLowerCase();
  return (
    folded === '.agents/' ||
    folded === '.claude/scripts/' ||
    folded === '.codex/' ||
    FOLDED_RULEBOOK_PREFIXES.some((prefix) => prefix !== folded && prefix.startsWith(folded))
  );
};

/**
 * One spelling for one directory — the single canonicaliser this file compares
 * and hashes with (`invariants.md`, "One mechanism, one implementation").
 *
 * RP-54: it is `realpathSync.native`, not `realpathSync`, and on Windows those
 * differ. Both normalise separators; only the native one expands an 8.3 short
 * name, so `C:\Users\RUNNER~1\…` and `C:\Users\runneradmin\…` survive
 * `realpathSync` as two strings for one directory. The flag is named by a hash
 * of this value while the generated Codex Windows hook supplies
 * `git rev-parse --show-toplevel` — a different spelling of the same checkout —
 * so the guard looked for a file nobody wrote and, being fail-open, allowed the
 * rulebook edit it exists to refuse. Proven by
 * unattended-flag.test.ts › "scopes the flag by the checkout, so two spellings
 * of one directory arm one file".
 *
 * A path that does not exist has no real path; `resolve` is the fallback, and
 * it is the same one on both sides of every comparison below.
 */
const canonicalPath = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};

const canonicalCheckout = (env) => {
  const declared = typeof env.CLAUDE_PROJECT_DIR === 'string' ? env.CLAUDE_PROJECT_DIR.trim() : '';
  if (declared === '') return null;
  return canonicalPath(declared);
};

const checkoutId = (env) => {
  const canonical = canonicalCheckout(env);
  if (canonical === null) return null;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
};

const scopedBasename = (env) => {
  const id = checkoutId(env);
  return id === null ? FLAG_BASENAME : FLAG_BASENAME.replace('-loop-UNATTENDED', `-${id}-loop-UNATTENDED`);
};

/** Every checkout-scoped path that arms unattended mode. The env-derived home is first. */
export const unattendedFlags = (env = process.env) =>
  homesOf(env).map((home) => join(home, '.claude', scopedBasename(env)));

/** Legacy machine-wide candidates are never accepted as scoped authorization. */
const legacyFlags = (env) => homesOf(env).map((home) => join(home, '.claude', FLAG_BASENAME));

const isMissing = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

const readCapped = (path) => {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) {
      const error = new Error('unattended flag is not a regular file');
      error.code = 'EINVAL';
      throw error;
    }
    const buffer = Buffer.alloc(MAX_FLAG_BYTES + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return { bytes, text: buffer.toString('utf8', 0, Math.min(bytes, MAX_FLAG_BYTES)) };
  } finally {
    closeSync(fd);
  }
};

const unreadable = (path, why) => ({ on: true, unreadable: true, path, why });

const inspectCandidates = (candidates) => {
  const present = [];
  for (const path of candidates) {
    try {
      present.push({ path, raw: readCapped(path) });
    } catch (error) {
      if (isMissing(error)) continue;
      return {
        present,
        failure: unreadable(path, `cannot be read: ${error?.code ?? 'read failed'}`),
      };
    }
  }
  return { present, failure: null };
};

/** The mode the flag declares — see the header for the three answers. */
export const readUnattended = (env = process.env) => {
  const scoped = checkoutId(env) !== null;
  const inspected = inspectCandidates(unattendedFlags(env));
  if (inspected.failure) return inspected.failure;
  const { present } = inspected;
  let path = present[0]?.path;
  let raw = present[0]?.raw ?? null;
  if (scoped && present.length > 1) {
    const first = present[0];
    if (
      present.some(
        ({ raw: candidate }) =>
          candidate.bytes !== first.raw.bytes || candidate.text !== first.raw.text,
      )
    ) {
      return unreadable(first.path, 'mirrored checkout-scoped unattended flags disagree');
    }
    raw = first.raw;
  }
  if (!path && scoped) {
    const legacy = inspectCandidates(legacyFlags(env));
    if (legacy.failure) return legacy.failure;
    path = legacy.present[0]?.path;
    if (path) {
      // The remedy ("re-arm it with `on --root …` or remove it") is deliberately
      // not part of this reason: re-arming only makes sense to a caller that is
      // about to arm something, and `why` also surfaces inside `off`'s own
      // refusal (whose remedy is "remove it", not "re-arm it") and inside
      // `guard-rulebook`'s BLOCKED message (which already names its own fix).
      // `why` stays a pure statement of what is wrong; each caller that can
      // usefully re-arm says so itself.
      return unreadable(
        path,
        'the armed unattended flag is an unscoped legacy record that carries no checkout root, so it ' +
          'cannot authorize this checkout',
      );
    }
  }
  if (!path) return { on: false };
  if (raw.bytes > MAX_FLAG_BYTES) return unreadable(path, `larger than ${MAX_FLAG_BYTES} bytes`);
  let parsed;
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    return unreadable(path, 'not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return unreadable(path, 'not a JSON object');
  }
  if (!Array.isArray(parsed.allow) || parsed.allow.some((entry) => typeof entry !== 'string')) {
    return unreadable(path, '`allow` is not an array of strings');
  }
  if (parsed.allow.length > MAX_ALLOW_ENTRIES) {
    return unreadable(path, `\`allow\` carries more than ${MAX_ALLOW_ENTRIES} entries`);
  }
  const allow = parsed.allow.map((entry) => entry.trim()).filter(Boolean);
  const wide = allow.find(isWidening);
  if (wide !== undefined) {
    return unreadable(
      path,
      `\`allow\` entry ${JSON.stringify(wide)} widens the rulebook (it is a prefix of a rulebook prefix) — an allow-list narrows the rulebook, never widens it`,
    );
  }
  return {
    on: true,
    item: typeof parsed.item === 'string' ? parsed.item : null,
    runDir: typeof parsed.runDir === 'string' ? parsed.runDir : null,
    allow,
  };
};

/**
 * Write the flag. Scoped records are mirrored into both trusted homes, with the
 * password-database home first, so a caller whose HOME differs still observes
 * the target checkout's state. An unscoped legacy-compatible write keeps the
 * historical first-home behaviour.
 */
export const writeUnattended = ({ item, runDir = null, allow = [] } = {}, env = process.env) => {
  if (typeof item !== 'string' || item.trim() === '') {
    throw new Error('the unattended flag needs an item id — a run without an item has nothing to allow');
  }
  const list = (Array.isArray(allow) ? allow : []).map((entry) => String(entry).trim()).filter(Boolean);
  if (list.length > MAX_ALLOW_ENTRIES) {
    throw new Error(`the allow-list is capped at ${MAX_ALLOW_ENTRIES} entries`);
  }
  const wide = list.find(isWidening);
  if (wide !== undefined) {
    throw new Error(
      `allow entry ${JSON.stringify(wide)} widens the rulebook — it is a prefix of one of ${RULEBOOK_PREFIXES.join(', ')}; ` +
        'an allow-list narrows the rulebook, never widens it. A directory entry needs its trailing slash ' +
        '(`.claude/hooks/`, not `.claude/hooks`).',
    );
  }
  const candidates = unattendedFlags(env);
  const targets = checkoutId(env) === null ? candidates.slice(0, 1) : [...candidates].reverse();
  const written = [];
  const content = `${JSON.stringify({ item: item.trim(), runDir, allow: list }, null, 2)}\n`;
  try {
    for (const path of targets) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      written.push(path);
    }
  } catch (error) {
    for (const path of written) {
      try {
        rmSync(path);
      } catch {
        // best-effort rollback; a surviving record keeps readers fail-closed
      }
    }
    throw error;
  }
  return written;
};

const pathBelongsToCheckout = (candidate, checkout) => {
  // `checkout` is `canonicalCheckout`'s output, so the candidate takes the same
  // canonicaliser: two spellings compared here would put an in-checkout runDir
  // outside its own checkout.
  const resolved = canonicalPath(candidate);
  const rel = relative(checkout, resolved);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const legacyBelongsToCheckout = (flagPath, env) => {
  const checkout = canonicalCheckout(env);
  if (checkout === null) return false;
  try {
    const raw = readCapped(flagPath);
    if (raw.bytes > MAX_FLAG_BYTES) return false;
    const parsed = JSON.parse(raw.text);
    return typeof parsed?.runDir === 'string' && pathBelongsToCheckout(parsed.runDir, checkout);
  } catch (error) {
    if (!isMissing(error)) {
      throw new Error(
        `legacy unattended flag at ${flagPath} cannot be read: ${error?.code ?? error?.message ?? 'read failed'}`,
        { cause: error },
      );
    }
    return false;
  }
};

/** Remove this checkout's flags and a provably-owned legacy record. */
export const clearUnattended = (env = process.env) => {
  const removed = [];
  const failures = [];
  const candidates = checkoutId(env) === null
    ? unattendedFlags(env)
    : [
        ...unattendedFlags(env),
        ...legacyFlags(env).filter((path) => legacyBelongsToCheckout(path, env)),
      ];
  for (const path of [...new Set(candidates)]) {
    try {
      rmSync(path);
      removed.push(path);
    } catch (error) {
      if (isMissing(error)) continue;
      failures.push(`${path}: ${error?.code ?? error?.message ?? 'remove failed'}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`failed to remove unattended flag(s): ${failures.join('; ')}`);
  }
  return removed;
};

/** Explicit operator migration: remove exactly the inspected legacy record. */
export const clearLegacyUnattended = (selectedPath) => {
  if (typeof selectedPath !== 'string' || selectedPath.trim() === '') {
    throw new Error('off --legacy requires --path <reported-path>');
  }
  const path = resolve(selectedPath);
  if (basename(path) !== FLAG_BASENAME || basename(dirname(path)) !== '.claude') {
    throw new Error(`refusing legacy cleanup outside .claude/${FLAG_BASENAME}`);
  }
  try {
    rmSync(path);
    return [path];
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
};

const invokedDirectly = () => {
  if (!process.argv[1]) return false;
  return canonicalPath(fileURLToPath(import.meta.url)) === canonicalPath(process.argv[1]);
};

if (invokedDirectly()) {
  const [word, ...rest] = process.argv.slice(2);
  const valueOf = (flag) => {
    const index = rest.indexOf(flag);
    return index === -1 ? null : (rest[index + 1] ?? null);
  };
  const root = valueOf('--root');
  const hasRoot = root !== null && !root.startsWith('--') && root.trim() !== '';
  const cliEnv = hasRoot ? { ...process.env, CLAUDE_PROJECT_DIR: root } : process.env;
  // RP-258: `on` and `verify` both scope the flag to a checkout — an unrooted
  // `on` writes a flag `readUnattended` cannot tell apart from stale legacy
  // machine-wide state, and an unrooted `verify` reads that same ambiguity
  // back as armed. `--root` is required for both, checked before either does
  // anything else (before `on` writes, before `verify` looks anything up).
  // `off` is unaffected: it already falls back to unscoped cleanup on
  // purpose (see its own branch below).
  //
  // RP-258 round 2: requiring the flag *to be present* was not enough — a
  // blank, nonexistent, or merely-a-subdirectory `--root` still let
  // `canonicalCheckout` (via its `resolve()` fallback) scope a flag to a
  // spelling `guard-rulebook` can never produce, because the guard is always
  // handed the checkout's own toplevel — `CLAUDE_PROJECT_DIR` on the Claude
  // harness, `git rev-parse --show-toplevel` on the Codex one. `on`/`verify`
  // reported success while arming/reading a flag the guard would never see —
  // the same "authorized nothing while claiming to" shape as the
  // missing-root case above, one level down. So both now also confirm the
  // root realpaths to an existing directory AND is that directory's own git
  // checkout toplevel — checked before any flag write or lookup, exactly
  // like the presence check above. A root git cannot place in any checkout
  // at all (absent git, no repository there) is refused rather than
  // accepted, the same direction as every other unconfirmable case here:
  // nothing distinguishes it from the ambiguous cases above closely enough
  // to trust it.
  const GIT_ROOT_TIMEOUT_MS = 10_000;
  /** The realpath of `candidate` if it exists and is a directory, else null. */
  const existingDirectoryRealpath = (candidate) => {
    let real;
    try {
      real = realpathSync.native(candidate);
    } catch {
      return null;
    }
    try {
      return statSync(real).isDirectory() ? real : null;
    } catch {
      return null;
    }
  };
  /**
   * The git checkout toplevel for `dir`, or null when git cannot confirm
   * one — absent, not a repository, or any other failure; never accepted.
   * Bounded like every other child this template spawns (`gate-stop-dod.mjs`'s
   * own pattern): a sanitised env (`withoutGitLocation`, so an inherited
   * `GIT_DIR`/`GIT_INDEX_FILE` cannot redirect it at the caller's repo — see
   * `git-env.mjs`) and a fixed timeout, never an unbounded wait.
   */
  const gitCheckoutToplevel = (dir) => {
    let output;
    try {
      output = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        env: withoutGitLocation(),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: GIT_ROOT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      return null;
    }
    return existingDirectoryRealpath(output.trim());
  };
  const requireRoot = (subcommand) => {
    if (!hasRoot) {
      process.stderr.write(
        `unattended-flag ${subcommand}: --root <checkout> is required — an unrooted flag cannot be ` +
          'scoped to the checkout it authorizes, and an unscoped read cannot tell a scoped flag from a stale legacy one\n',
      );
      process.exit(1);
    }
    const realRoot = existingDirectoryRealpath(root);
    if (realRoot === null) {
      process.stderr.write(
        `unattended-flag ${subcommand}: --root ${root} does not exist — an unattended flag cannot be ` +
          'scoped to a checkout that is not there\n',
      );
      process.exit(1);
    }
    const toplevel = gitCheckoutToplevel(realRoot);
    if (toplevel === null) {
      process.stderr.write(
        `unattended-flag ${subcommand}: --root ${root} could not be confirmed as a git checkout root — ` +
          'git found no repository there (or could not be run), so this run cannot verify what it would be ' +
          'scoping the flag to\n',
      );
      process.exit(1);
    }
    if (toplevel !== realRoot) {
      process.stderr.write(
        `unattended-flag ${subcommand}: --root ${root} is not a git checkout root — its toplevel is ` +
          `${toplevel}, and a flag scoped to a subdirectory is invisible to guard-rulebook, which always scopes ` +
          'itself by the real checkout toplevel\n',
      );
      process.exit(1);
    }
  };
  if (word === 'on') {
    const item = valueOf('--item');
    if (!item || item.startsWith('--')) {
      process.stderr.write('unattended-flag on: --item <id> is required — the flag names the item whose paths are allowed\n');
      process.exit(1);
    }
    requireRoot('on');
    const allowIndex = rest.indexOf('--allow');
    const allow =
      allowIndex === -1
        ? []
        : rest.slice(allowIndex + 1).filter((entry, i, all) => {
            const stop = all.findIndex((e) => e.startsWith('--'));
            return stop === -1 || i < stop;
          });
    let path;
    try {
      [path] = writeUnattended({ item, runDir: valueOf('--run-dir'), allow }, cliEnv);
    } catch (error) {
      process.stderr.write(`unattended-flag on: ${error?.message ?? error}\n`);
      process.exit(1);
    }
    process.stdout.write(`${path}\n`);
    process.exit(0);
  }
  if (word === 'off') {
    const legacy = rest.includes('--legacy');
    let removed;
    try {
      removed = legacy ? clearLegacyUnattended(valueOf('--path')) : clearUnattended(cliEnv);
    } catch (error) {
      process.stderr.write(`unattended-flag off: ${error?.message ?? error}\n`);
      process.exit(1);
    }
    if (!legacy && root) {
      const remaining = readUnattended(cliEnv);
      if (remaining.on) {
        const reason = remaining.why ?? 'an unattended flag is still armed';
        process.stderr.write(
          `unattended-flag off: ${reason} at ${remaining.path}. ` +
            'Inspect that exact record; if no pre-upgrade run still uses it, remove it with `off --legacy --path <reported-path>`.\n',
        );
        process.exit(1);
      }
    }
    process.stdout.write(removed.length === 0 ? 'no unattended flag was set\n' : `${removed.join('\n')}\n`);
    process.exit(0);
  }
  // 🔴 **The read-back `on` did not have, and the reason it is a subcommand
  // rather than a line in the skill (RP-103).**
  //
  // `on` refuses a widening allow entry — correctly — by throwing before it
  // writes anything, so the refusal leaves NO flag on disk. Pinned in the
  // generator's `test/template/unattended-flag.test.ts` (absent in a generated
  // rig) › "does not change `on`: a widening --allow still exits 1 and still
  // writes no flag" — the claim is checkable, so it carries a pointer rather
  // than standing on its own. And `guard-rulebook`
  // reads "no flag" as "attended session" and does nothing. So the run that was
  // meant to be the most constrained became the LEAST: every rulebook path
  // editable, including the hook wiring that enforces the rule. Loud at arming
  // (exit 1), and completely silent for the rest of the run.
  //
  // The asymmetry is what made it a defect rather than a rough edge: the `off`
  // branch above ALREADY reads back, and refuses while naming the record it
  // found. One direction of the same operation verified itself and the other
  // did not.
  //
  // ⚠ **Stating the limit, because this whole file is about a mechanism being
  // trusted further than it goes.** `verify` is mechanical where it runs; that
  // it runs is still the `loop` skill's prose. This closes "the refusal was
  // silent" — the run is told, in a command whose exit status is its whole
  // output — and does NOT close "a run that ignores exit statuses ignores this
  // one too". The hook-enforced version would need `guard-rulebook` to tell
  // "attended" from "unattended but unarmed", and it cannot: absence of a flag
  // is all it sees.
  if (word === 'verify') {
    const item = valueOf('--item');
    if (!item || item.startsWith('--')) {
      process.stderr.write(
        'unattended-flag verify: --item <id> is required — verifying "some flag is armed" would pass on a stale one from a previous run\n',
      );
      process.exit(1);
    }
    requireRoot('verify');
    const state = readUnattended(cliEnv);
    // ⚠ `unreadable` carries `on: true` — it means "a flag is THERE and cannot be
    // trusted", which is what `off` needs in order to refuse to clear it blindly.
    // For a read-back it is a FAILURE, not an arming: an unreadable record
    // authorizes nothing, and its `item` is absent, so testing only `!state.on`
    // would fall through to the item-mismatch branch and print the wrong reason
    // for the right refusal.
    if (!state.on || state.unreadable) {
      const why = state.why ? ` (${state.why})` : '';
      // `why` is a pure reason (see its own comment in `readUnattended`); the
      // re-arm remedy belongs here, where re-arming is actually the answer —
      // `off`'s own refusal (above) already has its own, different one.
      const remedy = state.unreadable
        ? ' Re-arm it with `on --root <checkout> --item <id>` or remove it, then verify again.'
        : '';
      process.stderr.write(
        `unattended-flag verify: NO usable unattended flag is armed for ${item}${why}.${remedy} ` +
          'guard-rulebook reads an absent flag as an attended session and refuses nothing, so this run is ' +
          'UNGUARDED against the rulebook — every rule, hook, skill and settings path is editable. ' +
          'Arm it with a narrower --allow (an allow-list narrows the rulebook, never widens it) and verify again, or stop the run.\n',
      );
      process.exit(1);
    }
    if (state.item !== item) {
      process.stderr.write(
        `unattended-flag verify: the armed flag names ${JSON.stringify(state.item)}, not ${JSON.stringify(item)} — ` +
          `it is a leftover from another run and does not authorize this one. This run is UNGUARDED against the rulebook. ` +
          `Clear it with \`off\` and arm it for ${item}, or stop the run.\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`${state.path ?? 'armed'}\n`);
    process.exit(0);
  }
  process.stderr.write(`unknown word: ${word ?? '(none)'}. This CLI has three: on, verify, off.\n`);
  process.exit(1);
}
