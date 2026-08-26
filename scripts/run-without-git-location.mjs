#!/usr/bin/env node
// Run a command with every git location variable removed from its environment.
//
// A git hook receives the location git exported for the commit in progress —
// GIT_DIR/GIT_WORK_TREE from a linked worktree, GIT_INDEX_FILE from `commit -a`
// — and every child of the hook inherits it. A test fixture that spawns git in
// a temp directory then acts on the SHARED repository: fixture commits became a
// branch head, `init --bare` flipped core.bare, a fixture's `git add` overwrote
// the real index (journal/2026-08.md, AR-144 and AR-148). The staged secret
// sweep needs that location and runs before this; the checks after it do not.
//
// The list of variables is `GIT_LOCATION_VARS` in .claude/scripts/git-env.mjs —
// imported, never restated, so there is one spelling of it (invariants.md).
import { spawnSync } from 'node:child_process';
import { withoutGitLocation } from '../.claude/scripts/git-env.mjs';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write('usage: run-without-git-location.mjs <command> [args…]\n');
  process.exit(2);
}
const result = spawnSync(command, args, { stdio: 'inherit', env: withoutGitLocation() });
if (result.error) {
  process.stderr.write(`run-without-git-location: ${result.error.message}\n`);
  process.exit(127);
}
process.exit(result.status ?? 1);
