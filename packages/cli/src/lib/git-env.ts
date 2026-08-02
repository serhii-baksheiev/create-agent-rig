/**
 * Variables that point git at a repository other than the one at `cwd`.
 *
 * Inherited, they silently redirect a git command into the CALLER's repository:
 * `git init` re-initialises it, `add -A` stages the caller's tree, and a commit
 * lands on whatever branch the caller has checked out — while the directory the
 * command was aimed at ends up with no `.git` at all.
 *
 * This is not hypothetical. Git sets `GIT_DIR` and `GIT_INDEX_FILE` — absolute —
 * for the hooks it runs, so a `git commit` from a linked worktree whose
 * pre-commit runs a suite that shells out to git writes one junk commit per
 * invocation onto the branch being committed. Observed twice in this repo, from
 * two different call sites, which is why this lives in one module: a second copy
 * of this list is a second chance to fix one and forget the other.
 *
 * The list is explicit rather than a `GIT_*` sweep on purpose — `GIT_SSH_COMMAND`
 * or `GIT_TERMINAL_PROMPT` are the caller's environment and none of our business.
 * Only repository *location* is stripped.
 *
 * 🔴 Limit, stated: this strips repository *location*, not every way git can be
 * redirected. The config-injection family (`GIT_CONFIG_COUNT`/`_KEY_n`/`_VALUE_n`,
 * `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_GLOBAL`/`_SYSTEM`) can carry `core.worktree`
 * or `core.bare` and is deliberately out of scope: git never sets those for the
 * hooks that cause this problem, and stripping a caller's deliberate config
 * overrides would be its own surprise.
 *
 * 🔴 And it protects exactly the call sites that use it. It does not make git
 * safe to call from a hook-invoked process in general, and a spawn that forgets
 * `gitEnv()` is unprotected — nothing in this module can detect that. The sweep
 * in `test/template/git-env.test.ts` is what watches for it.
 */
export const GIT_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
] as const;

/** The caller's environment minus anything that re-points git at another repo. */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitised = { ...env };
  for (const key of GIT_LOCATION_VARS) delete sanitised[key];
  return sanitised;
}
