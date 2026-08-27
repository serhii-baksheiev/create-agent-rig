/**
 * What this environment can and cannot run — so a test that needs a git
 * checkout or a non-root uid SKIPS with its reason instead of going red for a
 * reason no report names (AR-107).
 *
 * Measured on a .git-less copy at 693f5e8: 68 tests in 8 files went red, none
 * a defect — `git ls-files` / `check-ignore` / `check-attr` / `rev-parse`, and
 * the apply_patch guards, which resolve the repository root with git and fail
 * closed on move and path inspection without one. Seven cases rely on a mode
 * bit denying root — six on `chmod 0o500` refusing a write, one on `0o000`
 * refusing a read —
 * which root ignores; measured as uid 0 in a node:22 container: all seven skip
 * with their reason, nothing else changes.
 *
 * The skip is `ctx.skip(reason)` (vitest ≥ 2 `TestContext.skip(note)`), so the
 * reason travels into the report. Pinned in
 * `test/template/test-env-helpers.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import type { TestContext } from 'vitest';
import { gitEnv } from '../../packages/cli/src/lib/git-env.js';

/**
 * True when `dir` is inside a git work tree — asked of git itself, with any
 * hook-exported location removed. Memoised per directory: the answer is asked
 * once per test file, not once per test. Limit: `rev-parse` walks upward, so
 * a `.git`-less copy placed inside another repository answers true and the
 * skips do not fire there — measure on a copy outside any checkout.
 */
const known = new Map<string, boolean>();
export const hasGitRepo = (dir: string): boolean => {
  const cached = known.get(dir);
  if (cached !== undefined) return cached;
  const answer = probeGit(dir);
  known.set(dir, answer);
  return answer;
};

const probeGit = (dir: string): boolean => {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      env: gitEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
};

/** True under uid 0; false where `getuid` does not exist (Windows). */
export const isRoot = (): boolean => process.getuid?.() === 0;

/** Skip this test with `reason` when `condition` is false. */
export const skipUnless = (ctx: TestContext, condition: boolean, reason: string): void => {
  if (!condition) ctx.skip(reason);
};

export const needsGit = (repoRoot: string): { ok: boolean; reason: string } => ({
  ok: hasGitRepo(repoRoot),
  reason: `no git repository at ${repoRoot} (git ls-files / check-ignore / check-attr need one)`,
});

export const needsNonRoot = (): { ok: boolean; reason: string } => ({
  ok: !isRoot(),
  reason:
    'running as root: chmod 0o500 does not deny root, so an EACCES the test needs never happens',
});

/** The guards resolve the repository root with git and refuse without one. */
export const needsGitRoot = (repoRoot: string): { ok: boolean; reason: string } => ({
  ok: hasGitRepo(repoRoot),
  reason: `no git repository at ${repoRoot}: the apply_patch guard resolves the root with git rev-parse, and its move and path inspection refuses without one — this case would pass vacuously`,
});

/**
 * Can a mode bit deny this process? Not as root (modes are ignored) and not
 * on Windows (chmod is a no-op for directories and there is no execute bit),
 * so a test that needs an EACCES, or an executable bit that survives a copy,
 * names this as its reason — a capability genuinely absent there, counted
 * rather than silently green.
 */
export const modeBitsDeny = (): { ok: boolean; reason: string } => ({
  ok: !isRoot() && process.platform !== 'win32',
  reason:
    process.platform === 'win32'
      ? 'on Windows a chmod mode bit denies nothing and there is no execute bit, so the refusal the test needs never happens'
      : 'running as root: a chmod mode bit does not deny root, so the EACCES the test needs never happens',
});

/**
 * Can this process create a symlink? On Windows that needs a privilege an
 * ordinary CI account does not have, so a fixture built on one fails for a
 * reason that has nothing to do with the code under test.
 */
export const symlinksAvailable = (): { ok: boolean; reason: string } => ({
  ok: process.platform !== 'win32',
  reason:
    'on Windows creating a symlink needs a privilege an ordinary CI account lacks; the fixture cannot be built',
});

/** The opposite direction: a branch that exists only on Windows (a `.cmd` shim). */
export const onlyOnWindows = (): { ok: boolean; reason: string } => ({
  ok: process.platform === 'win32',
  reason: 'this branch exists only on Windows (a .cmd shim); there is nothing to measure elsewhere',
});

/** Do mode bits exist at all here? Windows has none; root sees them, so this is not `modeBitsDeny`. */
export const modeBitsExist = (): { ok: boolean; reason: string } => ({
  ok: process.platform !== 'win32',
  reason: 'on Windows a file has no POSIX mode bits to read',
});

/** Can a FIFO be created here? `mkfifo` has no Windows counterpart. */
export const fifosAvailable = (): { ok: boolean; reason: string } => ({
  ok: process.platform !== 'win32',
  reason: 'on Windows there is no mkfifo; the FIFO fixture cannot be built',
});
