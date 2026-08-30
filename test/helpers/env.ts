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
import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
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

/** The opposite direction: behaviour that exists only on Windows. */
export const onlyOnWindows = (): { ok: boolean; reason: string } => ({
  ok: process.platform === 'win32',
  reason: 'this behaviour exists only on Windows; there is nothing to measure elsewhere',
});

/** Is the POSIX shell used by generated hook commands available on this host? */
export const posixShellAvailable = (): { ok: boolean; reason: string } => ({
  ok: process.platform !== 'win32',
  reason:
    'the generated POSIX hook command requires /bin/sh; Windows wiring is decoded and asserted separately',
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

/**
 * A SECOND, genuinely distinct spelling of one directory — the Windows 8.3
 * short form (`RP57-E~1`, `SERHII~1`) — or a reason there is none here.
 *
 * This is a filesystem capability, not a platform: NTFS 8.3 name creation can
 * be turned off per volume (`fsutil 8dot3name query`), and a ReFS or POSIX
 * volume never had it. So it is MEASURED rather than guessed — the candidate is
 * accepted only when `realpathSync.native` resolves it back to the same
 * directory, which is what makes it a spelling rather than another path.
 *
 * Two sources, in order: the OS's own answer (`cmd`'s `%~sI`), which finds a
 * short form even under a long temp root; and `realpathSync`, which normalises
 * separators but leaves intact an 8.3 component the caller was already handed.
 * ⚠ The second is a fallback for a caller that passes such a path through; it
 * cannot fire for a caller that has already canonicalised with
 * `realpathSync.native`, because then both spellings are the same string and
 * `sameDirectory` rejects the candidate as identical.
 */
export const shortNameSpelling = (
  dir: string,
): { ok: boolean; reason: string; spelling: string } => {
  const canonical = realpathSync.native(dir);
  const sameDirectory = (candidate: string): boolean => {
    if (candidate === '' || candidate.toLowerCase() === canonical.toLowerCase()) return false;
    try {
      return realpathSync.native(candidate).toLowerCase() === canonical.toLowerCase();
    } catch {
      return false;
    }
  };
  for (const candidate of [askTheOsForAShortName(dir), safely(() => realpathSync(dir))]) {
    if (candidate !== null && sameDirectory(candidate)) {
      return { ok: true, reason: '', spelling: candidate };
    }
  }
  return {
    ok: false,
    reason: `this filesystem gives ${canonical} no distinct 8.3 short spelling (no cmd, or 8dot3 name creation is off on this volume), so the two spellings of one directory the case needs do not exist here`,
    spelling: canonical,
  };
};

const safely = (read: () => string): string | null => {
  try {
    return read();
  } catch {
    return null;
  }
};

/**
 * `%~sI` is the only reliable way to ask for an 8.3 name; Node exposes none.
 * `windowsVerbatimArguments` because Node's own quoting mangles the `for`
 * clause into `C:\"C:\Users\…"`, and for the same reason a path carrying a cmd
 * metacharacter is declined rather than interpolated. `spawnSync`, not
 * `execFileSync`, because only the former's options carry that flag.
 */
const askTheOsForAShortName = (dir: string): string | null => {
  if (/["&|<>^%!]/.test(dir)) return null;
  const probe = spawnSync('cmd', ['/d', '/c', `for %I in ("${dir}") do @echo %~sI`], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  });
  if (probe.error !== undefined || probe.status !== 0 || typeof probe.stdout !== 'string') {
    return null;
  }
  const answer = probe.stdout.trim();
  return answer === '' ? null : answer;
};
