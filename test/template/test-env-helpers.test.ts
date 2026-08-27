import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';
import {
  hasGitRepo,
  isRoot,
  modeBitsDeny,
  needsGit,
  needsNonRoot,
  skipUnless,
} from '../helpers/env.js';

// AR-107: a test that cannot run in this environment says so, by name, instead
// of failing on a symptom (a missing .git, an EACCES root never sees). These
// helpers are what such a test reaches for.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'test-env-helpers-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// A fake TestContext: only `skip` is exercised, so only `skip` is provided.
const fakeContext = (): { ctx: TestContext; skip: ReturnType<typeof vi.fn> } => {
  const skip = vi.fn();
  // The cast is deliberate: skipUnless must only ever touch ctx.skip.
  return { ctx: { skip } as unknown as TestContext, skip };
};

describe('test/helpers/env', () => {
  it('hasGitRepo is true for this checkout and false for an empty temp dir', () => {
    expect(hasGitRepo(repoRoot)).toBe(existsSync(path.join(repoRoot, '.git')));
    expect(hasGitRepo(tmp)).toBe(false);
  });

  it('hasGitRepo ignores a hook-exported GIT_DIR pointing elsewhere', () => {
    const previous = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = '/nowhere/.git';
    try {
      expect(hasGitRepo(repoRoot)).toBe(existsSync(path.join(repoRoot, '.git')));
      expect(hasGitRepo(tmp)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = previous;
    }
  });

  it('isRoot matches process.getuid', () => {
    expect(isRoot()).toBe(process.getuid?.() === 0);
  });

  it('skipUnless skips with the reason when the condition is false', () => {
    const failing = fakeContext();
    skipUnless(failing.ctx, false, 'because');
    expect(failing.skip).toHaveBeenCalledTimes(1);
    expect(failing.skip).toHaveBeenCalledWith('because');

    const passing = fakeContext();
    skipUnless(passing.ctx, true, 'because');
    expect(passing.skip).not.toHaveBeenCalled();
  });

  it('needsGit and needsNonRoot name their reasons', () => {
    const git = needsGit(tmp);
    expect(git.ok).toBe(false);
    expect(git.reason).toMatch(/no git repository/);
    expect(git.reason).toContain(tmp);

    expect(needsGit(repoRoot).ok).toBe(existsSync(path.join(repoRoot, '.git')));

    const nonRoot = needsNonRoot();
    expect(nonRoot.ok).toBe(!isRoot());
    expect(nonRoot.reason).toMatch(/root/);
  });

  it('modeBitsDeny is false as root and on Windows, and names which', () => {
    const { ok, reason } = modeBitsDeny();
    expect(ok).toBe(!isRoot() && process.platform !== 'win32');
    expect(reason).toMatch(process.platform === 'win32' ? /Windows/ : /root/);
  });
});
