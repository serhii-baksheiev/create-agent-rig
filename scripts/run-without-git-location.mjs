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
//
// Limits: on Windows a command that resolves to a `.cmd`/`.bat` shim (pnpm,
// corepack) cannot be executed directly, so that one case goes through a
// shell — and because no quoting is attempted, an argument carrying
// whitespace or a shell metacharacter is refused there rather than mangled.
// A command that resolves to an executable (`node`, anything `.exe`) never
// sees a shell on any platform. The shim branch is exercised only by the
// windows-unit job's `it.skipIf` cases; everywhere else the argv array
// reaches the command unparsed.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withoutGitLocation } from '../.claude/scripts/git-env.mjs';

const [command, ...args] = process.argv.slice(2);
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href && !command) {
  process.stderr.write('usage: run-without-git-location.mjs <command> [args…]\n');
  process.exit(2);
}
/**
 * Does `command` resolve to a `.cmd`/`.bat` shim on this platform? Bounded: one
 * look per PATH entry per PATHEXT extension, no recursion. A command given as a
 * path is checked as-is; a bare name is searched on PATH like the shell does.
 */
export const resolvesToShim = (command, env = process.env) => {
  if (process.platform !== 'win32') return false;
  const exts = String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean);
  const dirs =
    command.includes('\\') || command.includes('/')
      ? ['']
      : String(env.PATH ?? env.Path ?? '').split(';');
  for (const dir of dirs) {
    const base = dir ? join(dir, command) : command;
    const candidates = extname(command) ? [base] : exts.map((ext) => base + ext);
    for (const candidate of candidates) {
      if (existsSync(candidate)) return /\.(cmd|bat)$/i.test(candidate);
    }
  }
  return false;
};

const SHELL_UNSAFE = /[\s"'&|<>^%!()]/;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const useShell = resolvesToShim(command);
  if (useShell) {
    const unsafe = args.find((arg) => SHELL_UNSAFE.test(arg));
    if (unsafe !== undefined) {
      process.stderr.write(
        `run-without-git-location: ${command} is a shell shim on this platform and no quoting is attempted; ` +
          `refusing an argument with whitespace or a shell metacharacter: ${JSON.stringify(unsafe)}\n`,
      );
      process.exit(2);
    }
  }
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: withoutGitLocation(),
    shell: useShell,
  });
  if (result.error) {
    process.stderr.write(`run-without-git-location: ${result.error.message}\n`);
    process.exit(127);
  }
  process.exit(result.status ?? 1);
}
