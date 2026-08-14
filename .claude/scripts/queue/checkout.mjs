/**
 * Which checkout are we in?
 *
 * Its own module on purpose, and the reason is a defect this seam already had:
 * the writer resolved its file from `process.cwd()` while the reader resolved
 * from the script's own location, so a close run inside `.claude/worktrees/<slug>/`
 * wrote a tier the next selection could not see — and `worktree-task` then
 * deleted the directory it had written to. Two answers to "which checkout" is
 * one answer too many, so both sides import this.
 *
 * It sits apart from `state.mjs` because the CLI needs only this much. Pulling
 * the whole tier computation (and `detect-missed-gate.mjs` behind it) into the
 * read path would make selection depend on a module it never calls.
 */

import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

/**
 * The root of the MAIN checkout, from anywhere — main, a linked worktree, or a
 * subdirectory of either.
 *
 * `--git-common-dir` is what makes this a lookup rather than a guess: inside a
 * linked worktree it points at the main repository's `.git`, not the worktree's
 * own gitdir.
 *
 * Falls back to `startDir` outside a git work tree. A queue works fine in a
 * plain directory, and refusing there would break every non-git use to protect
 * nothing.
 *
 * 🔴 **Every `GIT_*` variable is stripped from the child's environment.** A git
 * hook exports `GIT_DIR` and `GIT_INDEX_FILE` as paths RELATIVE to the
 * repository it fired in; inherited by a child running with a different `cwd`,
 * they resolve against the wrong root and this function confidently answers
 * about a checkout the caller is not in. The question here is strictly "what
 * does `startDir` belong to", and an ambient answer is the wrong answer. This
 * repository has the scar: NOTES.md's `GIT_DIR` incident, 19 junk commits
 * across two branches.
 */
export const mainCheckoutRoot = (startDir) => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  try {
    const gitDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: startDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env },
    ).trim();
    return gitDir ? dirname(gitDir) : startDir;
  } catch {
    return startDir;
  }
};
