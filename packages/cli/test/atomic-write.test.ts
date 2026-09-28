import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWriteInRepo } from '../src/lib/atomic-write.js';
import { modeBitsExist, skipUnless } from '../../../test/helpers/env.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

/**
 * RP-268 AD3 — `atomic-write.ts`'s own doc comment (lines 44-50) promises
 * that this function "never WIDENS what the original file had" and "never
 * sets [setuid, setgid or sticky bits] either", but that promise currently
 * holds ONLY because every caller in this codebase already passes `stat().
 * mode & 0o777` — `atomicWriteInRepo` itself forwards whatever `mode` it is
 * given, unmasked, straight to both `open(temporary, 'wx', mode)` (the
 * creation mode, itself further filtered by the umask) and the unfiltered
 * `handle.chmod(mode)` right after. A caller that passes a mode carrying
 * setuid/setgid/sticky bits — by a future bug elsewhere in this codebase, or
 * directly here — currently has them land on the written file, contradicting
 * the function's own documented contract. The fix this test is red for:
 * `atomicWriteInRepo` masks `mode` to `& 0o777` itself, defensively, rather
 * than trusting every caller to have already done so.
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
