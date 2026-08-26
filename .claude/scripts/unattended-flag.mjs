#!/usr/bin/env node
// The unattended flag — how a hook learns that a loop is running, and what the
// current item is allowed to touch (AR-51).
//
//   node .claude/scripts/unattended-flag.mjs on --item AR-51 --run-dir <dir> --allow <prefix> [<prefix>…]
//   node .claude/scripts/unattended-flag.mjs off
//
// It is a FILE, not an environment variable, for a reason that was measured
// before this module was written: a `PreToolUse` hook is spawned by the harness
// with the harness's environment — a throwaway hook dumped 71 variables and not
// one `RIG_*` — and an `export` in a Bash tool call does not even survive to the
// next call. The kill switch (`stop-flag.mjs`) is a file for the same reason,
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
// Bounded: the file is read up to 64 KiB, `allow` is capped at 64 entries, and
// both limits are refusals, never silent truncation.
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FLAG_BASENAME = 'create-agent-rig-loop-UNATTENDED';
export const MAX_FLAG_BYTES = 64 * 1024;
export const MAX_ALLOW_ENTRIES = 64;

/** Every path that arms unattended mode. The env-derived home is first. */
export const unattendedFlags = () => {
  const homes = new Set([homedir()]);
  try {
    homes.add(userInfo().homedir);
  } catch {
    // no password entry — the env-derived home is all there is
  }
  return [...homes].map((home) => join(home, '.claude', FLAG_BASENAME));
};

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
export const readUnattended = () => {
  const path = unattendedFlags().find((candidate) => {
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
  return {
    on: true,
    item: typeof parsed.item === 'string' ? parsed.item : null,
    runDir: typeof parsed.runDir === 'string' ? parsed.runDir : null,
    allow: parsed.allow.map((entry) => entry.trim()).filter(Boolean),
  };
};

/** Write the flag under the env-derived home. Returns the paths written. */
export const writeUnattended = ({ item, runDir = null, allow = [] } = {}) => {
  if (typeof item !== 'string' || item.trim() === '') {
    throw new Error('the unattended flag needs an item id — a run without an item has nothing to allow');
  }
  const list = (Array.isArray(allow) ? allow : []).map((entry) => String(entry).trim()).filter(Boolean);
  if (list.length > MAX_ALLOW_ENTRIES) {
    throw new Error(`the allow-list is capped at ${MAX_ALLOW_ENTRIES} entries`);
  }
  const [path] = unattendedFlags();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ item: item.trim(), runDir, allow: list }, null, 2)}\n`);
  return [path];
};

/** Remove every flag that exists. Returns the paths removed. */
export const clearUnattended = () => {
  const removed = [];
  for (const path of unattendedFlags()) {
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
    const [path] = writeUnattended({ item, runDir: valueOf('--run-dir'), allow });
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
