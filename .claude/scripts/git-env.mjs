/**
 * The environment a child `git` should run with — one implementation, imported.
 *
 * 🔴 **Why this is not inlined at each call site.** A process started under a
 * git hook inherits `GIT_DIR` and `GIT_INDEX_FILE` as paths RELATIVE to the
 * repository the hook fired in. A child running with a different `cwd` resolves
 * them against the wrong root and then answers confidently about a repository
 * its caller is not in — `rev-parse` comparing another repo's refs, `fetch`
 * writing into it. This repository has the scar: NOTES.md's `GIT_DIR` incident,
 * 19 junk commits across two branches.
 *
 * 🔴 **The list is explicit, and a `GIT_*` prefix sweep is the wrong shape.**
 * Only repository *location* is stripped. `GIT_SSH_COMMAND`, `GIT_ASKPASS` and
 * `GIT_TERMINAL_PROMPT` are the caller's environment and none of our business,
 * and `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_COUNT` are how containers and CI inject
 * `safe.directory` for a checkout owned by another uid — sweep those away and
 * git exits 128 on *dubious ownership*, which a caller that falls back quietly
 * turns straight back into the bug it was guarding against.
 *
 * ⚠ **Limit, stated because it bounds what this buys you:** sanitising here
 * protects only the spawns that call it. A call site that forgets is
 * unprotected and nothing in this module can detect that —
 * `test/template/git-env.test.ts` sweeps for exactly that, and a new git spawn
 * belongs on its list the day it is written.
 */

export const GIT_LOCATION_VARS = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]);

export const withoutGitLocation = (env = process.env) => {
  const sanitised = { ...env };
  for (const key of GIT_LOCATION_VARS) delete sanitised[key];
  return sanitised;
};
