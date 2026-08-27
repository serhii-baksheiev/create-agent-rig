#!/usr/bin/env node
// The unattended flag — how a hook learns that a loop is running, and what the
// current item is allowed to touch (AR-51).
//
//   node .claude/scripts/unattended-flag.mjs on --item AR-51 --run-dir <dir> --allow <prefix> [<prefix>…]
//   node .claude/scripts/unattended-flag.mjs off
//
// It is a FILE, not an environment variable: a `PreToolUse` hook is spawned by
// the harness with the harness's own environment, never with a variable the
// session exported — the generator's `test/template/guard-rulebook.test.ts` ›
// "only a flag arms it — an exported RIG_UNATTENDED=1 with no flag changes
// nothing" pins that side of it — and in some harnesses an `export` does not
// even survive to the next Bash call. The kill switch (`stop-flag.mjs`) is a
// file for the same reason,
// and this module copies its shape: machine-level, under BOTH homes, so a
// worktree sees it and a `$HOME` set from `.claude/settings.json` cannot hide it.
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
// the rulebook (`src/`, `.claude/skills/loop/`) is harmless — such a path is
// never judged — and items name those all the time, so it is kept, not
// refused — › "an allow entry that widens the rulebook — a prefix of a rulebook prefix such as `.` — makes the flag unreadable".
//
// Bounded: the file is read up to 64 KiB, `allow` is capped at 64 entries, and
// both limits are refusals, never silent truncation.
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homesOf } from './stop-flag.mjs';

export const FLAG_BASENAME = 'create-agent-rig-loop-UNATTENDED';
export const MAX_FLAG_BYTES = 64 * 1024;
export const MAX_ALLOW_ENTRIES = 64;

/**
 * The files that decide what a session may do — repo-relative prefixes. Owned
 * here because two things read them: the guard, to judge an edit, and the
 * writer above, to refuse an allow-list that reaches outside them.
 */
export const RULEBOOK_PREFIXES = Object.freeze([
  '.claude/hooks/',
  '.claude/settings.json',
  '.claude/queue.json',
  // the per-checkout board selector: picks among the boards queue.json declares,
  // so an unattended run must not be able to re-aim itself through it either
  '.claude/queue.board',
  '.claude/scripts/queue/',
  '.claude/scripts/decision-router.mjs',
  '.claude/scripts/detect-missed-gate.mjs',
  '.claude/rules/',
  'CLAUDE.md',
]);

/** Is this repo-relative path part of the rulebook? */
export const isRulebookPath = (rel) =>
  RULEBOOK_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(prefix));

/**
 * Does this allow entry widen the rulebook — is it a proper prefix of a rulebook
 * prefix, so that it would admit the whole prefix and more? `.claude/scripts/`
 * widens (it covers `.claude/scripts/queue/` and its siblings); `src/` does not
 * (it covers nothing the guard judges); `.claude/scripts/queue/` does not (it is
 * exactly a rulebook prefix, the ordinary allow entry).
 */
export const isWidening = (entry) =>
  typeof entry !== 'string' ||
  entry === '' ||
  RULEBOOK_PREFIXES.some((prefix) => prefix !== entry && prefix.startsWith(entry));

/** Every path that arms unattended mode. The env-derived home is first. */
export const unattendedFlags = (env = process.env) =>
  homesOf(env).map((home) => join(home, '.claude', FLAG_BASENAME));

const readCapped = (path) => {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_FLAG_BYTES + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return { bytes, text: buffer.toString('utf8', 0, Math.min(bytes, MAX_FLAG_BYTES)) };
  } finally {
    closeSync(fd);
  }
};

const unreadable = (path, why) => ({ on: true, unreadable: true, path, why });

/** The mode the flag declares — see the header for the three answers. */
export const readUnattended = (env = process.env) => {
  const path = unattendedFlags(env).find((candidate) => {
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (!path) return { on: false };
  let raw;
  try {
    raw = readCapped(path);
  } catch (error) {
    return unreadable(path, `cannot be read: ${error?.code ?? 'read failed'}`);
  }
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

/** Write the flag under the env-derived home. Returns the paths written. */
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
  const [path] = unattendedFlags(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ item: item.trim(), runDir, allow: list }, null, 2)}\n`);
  return [path];
};

/** Remove every flag that exists. Returns the paths removed. */
export const clearUnattended = (env = process.env) => {
  const removed = [];
  for (const path of unattendedFlags(env)) {
    try {
      if (existsSync(path)) {
        rmSync(path);
        removed.push(path);
      }
    } catch {
      // a home this process cannot write is not this run's flag to remove
    }
  }
  return removed;
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
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
};

if (invokedDirectly()) {
  const [word, ...rest] = process.argv.slice(2);
  const valueOf = (flag) => {
    const index = rest.indexOf(flag);
    return index === -1 ? null : (rest[index + 1] ?? null);
  };
  if (word === 'on') {
    const item = valueOf('--item');
    if (!item || item.startsWith('--')) {
      process.stderr.write('unattended-flag on: --item <id> is required — the flag names the item whose paths are allowed\n');
      process.exit(1);
    }
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
      [path] = writeUnattended({ item, runDir: valueOf('--run-dir'), allow });
    } catch (error) {
      process.stderr.write(`unattended-flag on: ${error?.message ?? error}\n`);
      process.exit(1);
    }
    process.stdout.write(`${path}\n`);
    process.exit(0);
  }
  if (word === 'off') {
    const removed = clearUnattended();
    process.stdout.write(removed.length === 0 ? 'no unattended flag was set\n' : `${removed.join('\n')}\n`);
    process.exit(0);
  }
  process.stderr.write(`unknown word: ${word ?? '(none)'}. This CLI has two: on, off.\n`);
  process.exit(1);
}
