import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWriteInRepo } from '../src/lib/atomic-write.js';
import { modeBitsExist, skipUnless } from '../../../test/helpers/env.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

/**
 * RP-268 AD3 — `atomic-write.ts`'s doc comment promises that this function
 * "never WIDENS what the original file had" and never sets setuid, setgid or
 * the sticky bit. Before RP-268 that held ONLY because every caller passed
 * `stat().mode & 0o777`: `atomicWriteInRepo` forwarded whatever `mode` it was
 * given, unmasked, to both `open(temporary, 'wx', mode)` and the unfiltered
 * `handle.chmod(mode)`, so a caller passing those bits had them land on the
 * written file. These tests pin the fix: `atomicWriteInRepo` masks `mode` to
 * `& 0o777` itself, rather than trusting every caller to have done so.
 */

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-atomic-write-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

describe('atomicWriteInRepo — masks mode to & 0o777 itself, never trusting the caller (RP-268 AD3)', () => {
  it('never lets setuid, setgid or the sticky bit reach the written file, even when the caller passes them', async (context) => {
    skipUnless(context, modeBitsExist().ok, modeBitsExist().reason);

    // setuid (0o4000) + setgid (0o2000) + sticky (0o1000) + ordinary rwxr-xr-x
    const requestedMode = 0o4755 | 0o2000 | 0o1000;
    const result = await atomicWriteInRepo(repo, 'out.txt', Buffer.from('hello'), requestedMode);

    expect(result.ok).toBe(true);
    const mode = (await stat(path.join(repo, 'out.txt'))).mode;
    // The three bits above the ordinary permission bits: setuid|setgid|sticky.
    expect(mode & 0o7000).toBe(0);
    // Masking must not also drop the ordinary bits that were legitimately
    // requested alongside them.
    expect(mode & 0o777).toBe(0o755);
  });

  it('still preserves the ordinary low 9 bits exactly when the caller already masked them (regression: masking must not also drop legitimate bits)', async (context) => {
    skipUnless(context, modeBitsExist().ok, modeBitsExist().reason);

    const result = await atomicWriteInRepo(repo, 'out2.txt', Buffer.from('hello'), 0o600);

    expect(result.ok).toBe(true);
    const mode = (await stat(path.join(repo, 'out2.txt'))).mode;
    expect(mode & 0o777).toBe(0o600);
  });
});
