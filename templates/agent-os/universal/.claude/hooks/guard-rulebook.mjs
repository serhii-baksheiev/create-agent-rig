#!/usr/bin/env node
// PreToolUse hook: in an UNATTENDED run, the rulebook is never edited outside
// the current item's allow-list (AR-51).
//
// The rulebook is the set of files that decide what this session may do — hooks
// and settings wiring, the queue config and selector, all scripts, rules, skills
// and agents, the `.codex/` configuration, the integrity manifest, `AGENTS.md`
// and `CLAUDE.md`. Every one of them was editable by the run it governs: a
// Write to `.claude/hooks/dod-checks.json` with `[]` switched the stop gate
// off, and nothing refused it until the merge sweep, long after.
//
// How it decides — and it is deliberately dumb:
//   1. No unattended flag on disk (`.claude/scripts/unattended-flag.mjs`) → an
//      attended session → exit 0 for everything. A human at the keyboard edits
//      the rulebook on purpose.
//   2. Flag present and readable → every edit fragment whose repo-relative path
//      sits under a rulebook prefix is refused (exit 2) unless it also sits
//      under one of the item's `allow` prefixes. A known path outside the
//      rulebook is never judged — › "allows a MultiEdit beyond the fragment cap
//      when its known path is outside the rulebook". A pathless global refusal
//      for an oversized or unsupported `apply_patch` payload is blocked while
//      armed because its scope cannot be proved — › "states the pathless
//      global-refusal limit for oversized and unsupported apply_patch payloads".
//   3. Flag present and UNREADABLE → a rulebook edit is refused and the reason
//      names the flag; an edit outside the rulebook still passes. Refusing to
//      inspect is not allowing (`.claude/rules/invariants.md`).
//
// Limits — each stated here and each measured in the generator's
// `test/template/guard-rulebook.test.ts` (absent in a generated rig), by the
// test named beside it:
//   - it sees one edit at a time, as text, before it lands — a rulebook file
//     rewritten through a Bash redirect (`echo … > .claude/settings.json`), a
//     generated file, or `git checkout` of another branch is not an edit tool
//     call and never reaches it, and `guard-bash` does not cover that either —
//     › "a Bash redirect into the rulebook is not an edit tool call and passes
//     — guard-bash does not cover it either";
//   - the flag in either home arms it (the env-derived one and the password
//     database one, like the kill switch), and ONLY a flag arms it: an
//     exported variable changes nothing, and an attended session that never
//     set a flag is exactly as free as before — › "only a flag arms it — an
//     exported RIG_UNATTENDED=1 with no flag changes nothing";
//   - it judges paths, not content: a README that merely mentions
//     `.claude/hooks/guard-bash.mjs` is not a rulebook edit — › "guards the
//     path, not prose that mentions a guarded path";
//   - it compares both roots and payload paths in their selected and canonical
//     spellings, whether selection came from `CLAUDE_PROJECT_DIR` or the
//     working-directory fallback — › "canonicalizes a differently spelled
//     checkout root before guarding a canonical payload path", › "blocks when
//     the checkout root and payload use the same symlink spelling", and
//     › "blocks an existing rulebook file when only the payload path uses a symlink spelling";
//   - an `allow` prefix is a string prefix of the repo-relative path and may
//     not widen the rulebook — an entry that is itself a prefix of a rulebook
//     prefix (`.`, `.claude/`, `.claude/scripts/`) makes the flag unreadable
//     and the guard refuses — › "a flag whose allow-list widens the rulebook is
//     unreadable, so `--allow .` cannot disarm it";
//   - fail-open on its own errors and on a payload it cannot parse — › "allows
//     an empty payload object" and › "allows non-JSON stdin" — and fail-closed
//     on a flag it cannot read — › "blocks a rulebook edit when the flag exists
//     but cannot be read, and names the file": the guard targets drift, not an
//     adversary.
//
// The rule it enforces is stated in `.claude/rules/autonomy.md`, "Never".
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { editFragments } from './lib/edit-input.mjs';
import { RULEBOOK_PREFIXES, isRulebookPath, readUnattended } from '../scripts/unattended-flag.mjs';

export { RULEBOOK_PREFIXES, isRulebookPath };

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

const toPosix = (value) => String(value ?? '').replaceAll('\\', '/');

const canonicalRoot = (root) => {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
};

/** Resolve symlinks in the nearest existing ancestor, preserving a missing tail. */
const canonicalPath = (filePath) => {
  let cursor = resolve(filePath);
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync(cursor), ...tail);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return filePath;
      tail.unshift(basename(cursor));
      cursor = parent;
    }
  }
};

/** The repo-relative tail of an absolute path, or the path itself when it is not under the root. */
export const relativeTo = (root, filePath) => {
  const dir = toPosix(root).replace(/\/+$/, '');
  const file = toPosix(filePath);
  if (dir !== '' && file.startsWith(`${dir}/`)) return file.slice(dir.length + 1);
  return file.replace(/^\.\//, '');
};

export const isAllowed = (rel, allow) =>
  (Array.isArray(allow) ? allow : []).some((prefix) => prefix !== '' && (rel === prefix || rel.startsWith(prefix)));

const protectedRelative = (roots, filePath) =>
  [...new Set([filePath, canonicalPath(filePath)])]
    .flatMap((spelling) => roots.map((root) => relativeTo(root, spelling)))
    .find(isRulebookPath);

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0; // unparseable payload: not ours to judge
  }
  if (!EDIT_TOOLS.has(input?.tool_name)) return 0;

  const selectedRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = canonicalRoot(selectedRoot);
  const comparisonRoots = [...new Set([root, selectedRoot])];
  const unattendedEnv = { ...process.env, CLAUDE_PROJECT_DIR: root };
  const fragments = editFragments(input);
  const globalRefusal = fragments.find(
    ({ inspectionRefusal, appliesToAll }) => appliesToAll && inspectionRefusal,
  );
  if (globalRefusal) {
    if (globalRefusal.filePath) {
      const rel = protectedRelative(comparisonRoots, globalRefusal.filePath);
      if (rel === undefined) return 0;
    }
    const mode = readUnattended(unattendedEnv);
    if (!mode.on) return 0;
    process.stderr.write(
      `BLOCKED — cannot safely inspect this unattended edit: ${globalRefusal.inspectionRefusal}\n` +
        `${globalRefusal.remedy ?? 'Split it into a smaller edit and retry.'}\n`,
    );
    return 2;
  }
  const paths = [];
  for (const { filePath } of fragments) {
    if (typeof filePath !== 'string' || filePath === '') continue;
    const rel = protectedRelative(comparisonRoots, filePath);
    if (rel !== undefined && !paths.includes(rel)) paths.push(rel);
  }
  if (paths.length === 0) return 0; // nothing under the rulebook: never judged

  const mode = readUnattended(unattendedEnv);
  if (!mode.on) return 0; // attended session

  if (mode.unreadable) {
    process.stderr.write(
      `BLOCKED — "${paths[0]}" is part of the rulebook and the unattended flag at ${mode.path} is unreadable (${mode.why}). ` +
        'Refusing to inspect is not allowing: fix it, or clear this checkout with `node .claude/scripts/unattended-flag.mjs off --root "$PWD"`, then retry.\n',
    );
    return 2;
  }

  const refused = paths.filter(
    (rel) => rel === '.claude/queue.board' || !isAllowed(rel, mode.allow),
  );
  if (refused.length === 0) return 0;
  if (refused[0] === '.claude/queue.board') {
    process.stderr.write(
      'BLOCKED — ".claude/queue.board" is the checkout board selector and cannot be changed while unattended, even through an item allow-list. ' +
        'Disarm unattended mode before deliberately switching queues.\n',
    );
    return 2;
  }
  process.stderr.write(
    `BLOCKED — "${refused[0]}" is part of the rulebook, and an unattended run never edits the rulebook outside its item's allow-list ` +
      `(item ${mode.item ?? '(none)'}; allowed prefixes: ${mode.allow.length === 0 ? 'none' : mode.allow.join(', ')}). ` +
      'If the item really needs this path, it belongs in the allow-list the loop wrote at claim time — a decision, not a default. ' +
      'See .claude/rules/autonomy.md, "Never".\n',
  );
  return 2;
}

try {
  process.exit(main());
} catch {
  process.exit(0); // a crashed guard must not block the session
}
