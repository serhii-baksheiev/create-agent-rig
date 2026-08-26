#!/usr/bin/env node
// PreToolUse hook: in an UNATTENDED run, the rulebook is never edited outside
// the current item's allow-list (AR-51).
//
// The rulebook is the set of files that decide what this session may do — the
// hooks, their wiring, the queue config and adapters, the router and the gate
// sweep, the rules, `CLAUDE.md`. Every one of them was editable by the run it
// governs: a Write to `.claude/hooks/dod-checks.json` with `[]` switched the
// stop gate off, and nothing refused it until the merge sweep, long after.
//
// How it decides — and it is deliberately dumb:
//   1. No unattended flag on disk (`.claude/scripts/unattended-flag.mjs`) → an
//      attended session → exit 0 for everything. A human at the keyboard edits
//      the rulebook on purpose.
//   2. Flag present and readable → every edit fragment whose repo-relative path
//      sits under a rulebook prefix is refused (exit 2) unless it also sits
//      under one of the item's `allow` prefixes. Paths outside the rulebook are
//      never judged.
//   3. Flag present and UNREADABLE → a rulebook edit is refused and the reason
//      names the flag; an edit outside the rulebook still passes. Refusing to
//      inspect is not allowing (`.claude/rules/invariants.md`).
//
// Limits — stated here, tested in the generator's `test/template/guard-rulebook.test.ts`:
//   - it sees one edit at a time, as text, before it lands — a rulebook file
//     rewritten through a Bash redirect (`echo … > .claude/settings.json`), a
//     generated file, or `git checkout` of another branch is not an edit tool
//     call and never reaches it; `guard-bash` does not cover that either;
//   - the flag in either home arms it (the env-derived one and the password
//     database one, like the kill switch), and only a flag arms it — an
//     attended session that never set one is exactly as free as before;
//   - it judges paths, not content: a README that merely mentions
//     `.claude/hooks/guard-bash.mjs` is not a rulebook edit;
//   - an `allow` prefix is matched as a string prefix of the repo-relative
//     path, so `.claude/scripts/queue/` allows the whole directory, while the
//     same prefix without its slash would also allow any sibling whose name
//     starts with `queue` — write prefixes with their trailing slash;
//   - fail-open on its own errors and on a payload it cannot parse, fail-closed
//     on a flag it cannot read: the guard targets drift, not an adversary.
//
// The rule it enforces is stated in `.claude/rules/autonomy.md`, "Never".
import { readFileSync } from 'node:fs';
import { editFragments } from './lib/edit-input.mjs';
import { readUnattended } from '../scripts/unattended-flag.mjs';

/** The files that decide what a session may do. Repo-relative prefixes. */
export const RULEBOOK_PREFIXES = Object.freeze([
  '.claude/hooks/',
  '.claude/settings.json',
  '.claude/queue.json',
  '.claude/scripts/queue/',
  '.claude/scripts/decision-router.mjs',
  '.claude/scripts/detect-missed-gate.mjs',
  '.claude/rules/',
  'CLAUDE.md',
]);

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

const toPosix = (value) => String(value ?? '').replaceAll('\\', '/');

/** The repo-relative tail of an absolute path, or the path itself when it is not under the root. */
export const relativeTo = (root, filePath) => {
  const dir = toPosix(root).replace(/\/+$/, '');
  const file = toPosix(filePath);
  if (dir !== '' && file.startsWith(`${dir}/`)) return file.slice(dir.length + 1);
  return file.replace(/^\.\//, '');
};

export const isRulebookPath = (rel) => RULEBOOK_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(prefix));

export const isAllowed = (rel, allow) =>
  (Array.isArray(allow) ? allow : []).some((prefix) => prefix !== '' && (rel === prefix || rel.startsWith(prefix)));

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0; // unparseable payload: not ours to judge
  }
  if (!EDIT_TOOLS.has(input?.tool_name)) return 0;

  const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const paths = [];
  for (const { filePath } of editFragments(input)) {
    if (typeof filePath !== 'string' || filePath === '') continue;
    const rel = relativeTo(root, filePath);
    if (isRulebookPath(rel) && !paths.includes(rel)) paths.push(rel);
    if (paths.length >= 64) break;
  }
  if (paths.length === 0) return 0; // nothing under the rulebook: never judged

  const mode = readUnattended();
  if (!mode.on) return 0; // attended session

  if (mode.unreadable) {
    process.stderr.write(
      `BLOCKED — "${paths[0]}" is part of the rulebook and the unattended flag at ${mode.path} is unreadable (${mode.why}). ` +
        'Refusing to inspect is not allowing: fix or remove the flag (`node .claude/scripts/unattended-flag.mjs off`), then retry.\n',
    );
    return 2;
  }

  const refused = paths.filter((rel) => !isAllowed(rel, mode.allow));
  if (refused.length === 0) return 0;
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
