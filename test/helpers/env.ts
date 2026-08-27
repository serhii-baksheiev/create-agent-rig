/**
 * What this environment can and cannot run — so a test that needs a git
 * checkout or a non-root uid SKIPS with its reason instead of going red for a
 * reason no report names (AR-107).
 *
 * Measured on a .git-less copy at 693f5e8: 68 tests in 8 files went red, none
 * a defect — `git ls-files` / `check-ignore` / `check-attr` / `rev-parse`, and
 * the apply_patch guards, which resolve the repository root with git and fail
 * closed without one. Six more cases rely on `chmod 0o500` denying a write,
 * which root ignores; that half is stated, not measured (no uid 0 here).
 *
 * The skip is `ctx.skip(reason)` (vitest ≥ 2 `TestContext.skip(note)`), so the
 * reason travels into the report. Pinned in
 * `test/template/test-env-helpers.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import type { TestContext } from 'vitest';
import { gitEnv } from '../../packages/cli/src/lib/git-env.js';

/** True when `dir` is inside a git work tree — asked of git itself, with any hook-exported location removed. */
export const hasGitRepo = (dir: string): boolean => {
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
  reason: `no git repository at ${repoRoot}: the apply_patch guards resolve the root with git rev-parse and refuse every patch without one`,
});
