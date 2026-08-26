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

// The sanitiser is IMPORTED, never re-derived. This repo had already ruled on
// which git variables to strip, exported the answer with its stated limit, and
// built a sweep for call sites that forget it — and this file still shipped a
// third copy, wider and wrong, which is the "two files enforcing one invariant"
// `invariants.md` names by rule. It comes from the small shared module rather
// than from `preflight.mjs`, because a CLI script has no business on the queue's
// read path: importing one there broke every fixture that copies only `queue/`.
import { withoutGitLocation } from '../git-env.mjs';

/**
 * The root of the MAIN checkout, from anywhere — main, a linked worktree, or a
 * subdirectory of either.
 *
 * `--git-common-dir` is what makes this a lookup rather than a guess: inside a
 * linked worktree it points at the main repository's `.git`, not the worktree's
 * own gitdir.
 *
 * 🔴 **The probe runs under `LC_ALL: 'C'`, because the catch CLASSIFIES git's
 * stderr and git translates it.** Under `fr_FR` the "no repository here" message
 * is *"ni ceci ni aucun de ses répertoires parents n'est un dépôt git"*; the
 * regex misses, and the legitimate fallback turns into a hard refusal from the
 * queue CLI — in a non-git directory, for anyone whose shell is not English. CI
 * runs under `C`, so CI can never see it. Note this SETS a variable rather than
 * stripping one: `GIT_CONFIG_*` is untouched.
 *
 * **Two failures fall back to `startDir`, and only those two:** there is no
 * repository above it, or git is not installed. A queue works fine in a plain
 * directory, and refusing there would break every non-git use to protect
 * nothing. **Every other failure is raised.** A bare catch here would turn
 * *dubious ownership*, a git too old for `--path-format`, or a broken binary
 * into the permissive answer — silently, with git's own explanation discarded.
 * That is the shape this whole module exists to remove, and swallowing it one
 * level up would just move it.
 *
 * 🔴 **The child's environment is sanitised through the SHARED list.** A git
 * hook exports `GIT_DIR` and `GIT_INDEX_FILE`; inherited here, they make this
 * function answer confidently about a checkout the caller is not in. A hook in
 * a linked worktree exports them **absolute**, so changing `cwd` does not save
 * you — see `git-env.mjs` for the measurements. This repository has the scar:
 * NOTES.md's `GIT_DIR` incident, 19 junk commits across two branches.
 *
 * ⚠ **Only *location* is stripped, deliberately.** A `GIT_*` prefix sweep would
 * also take `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_COUNT`, which is how containers and
 * CI inject `safe.directory` for a checkout owned by another uid — remove those
 * and git exits 128 on *dubious ownership*, which under the old bare catch came
 * back as the pre-fix behaviour with nothing printed.
 */
export const mainCheckoutRoot = (startDir) => {
  try {
    const gitDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: startDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        // `LC_ALL: 'C'` — see the note on classifying stderr, above.
        env: { ...withoutGitLocation(), LC_ALL: 'C', LANGUAGE: '' },
      },
    ).trim();
    return gitDir ? dirname(gitDir) : startDir;
  } catch (error) {
    if (error?.code === 'ENOENT') return startDir; // git is not installed
    const stderr = String(error?.stderr ?? '');
    if (/not a git repository|not a work tree/i.test(stderr)) return startDir;
    throw new Error(
      `could not determine the main checkout for ${startDir}: ${stderr.trim() || error?.message}`,
      { cause: error },
    );
  }
};

/**
 * Is this checkout in a state a gate round may be counted against (AR-141)?
 *
 * A round is counted per branch and the fan-out's verdicts name a head. On one
 * branch two rounds were counted before a commit that pre-commit then refused,
 * so the counter and the records named a head that never shipped. The three
 * states that make a head unshippable are decidable from git alone: a dirty
 * working tree (tracked or untracked), a branch with no upstream, and commits
 * the upstream has not seen. `{ ok: true }` otherwise; a git that cannot answer
 * is reported as such, never as clean.
 *
 * Bounded: three git calls, each with a timeout, and the porcelain output is
 * read only for emptiness.
 */
export const checkoutIsShippable = (root) => {
  const git = (args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: withoutGitLocation(),
      timeout: 30_000,
    }).trim();
  let status;
  try {
    status = git(['status', '--porcelain']);
  } catch (error) {
    return { ok: false, why: `git could not read the working tree at ${root}: ${error.message}` };
  }
  if (status !== '') {
    return {
      ok: false,
      why: 'the working tree is dirty — a round counted now would name a head that has not ' +
        'been committed; commit (and push) first',
    };
  }
  let ahead;
  try {
    ahead = git(['rev-list', '--count', '@{upstream}..HEAD']);
  } catch {
    return {
      ok: false,
      why: 'HEAD has no upstream — push the branch first, so the round names a head the ' +
        'reviewers and CI can see',
    };
  }
  if (ahead !== '0') {
    return {
      ok: false,
      why: `HEAD is ${ahead} commit(s) ahead of its upstream — push first, so the round names ` +
        'the head that ships',
    };
  }
  return { ok: true };
};
