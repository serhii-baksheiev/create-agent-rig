import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { resolveWritableInside } from './safe-path.js';

export type AtomicWriteResult = { ok: true; dest: string } | { ok: false; reason: 'unsafe' };

/**
 * Write `bytes` to `rel` inside `repoDir` atomically: a temp file in the
 * SAME directory, `wx`-created (never overwrites an existing name) at
 * `mode`, fully written, then `rename`d over the destination — mirroring
 * `commands/integrations.ts`'s own `atomicWrite` (around lines 172-197),
 * including its symlink-safety shape: `resolveWritableInside` resolved once
 * before `mkdir`, re-resolved once after (the directory may not have
 * existed a moment ago), and re-checked a THIRD time immediately before the
 * rename, in case the destination itself was swapped for something unsafe
 * in the time it took to write the temp file.
 *
 * `rename` replaces the directory ENTRY at `dest` with the temp file's own
 * inode; it never opens or truncates whatever inode `dest` used to name.
 * That is what keeps a HARD LINK safe (round 2, security-scanner A1): a
 * second directory entry elsewhere on the same filesystem, pointing at the
 * very same data as `dest` used to, keeps pointing at the ORIGINAL bytes,
 * untouched — a plain truncate-then-write `writeFile` follows the path and
 * mutates that shared inode in place, which every other name for it would
 * observe too; `rename` never does, because it only ever repoints the one
 * directory entry this call was asked to write.
 *
 * `mode` is the EXACT permission bits (`0o000`-`0o777`) the renamed result
 * ends up with — the caller's job to pass the ORIGINAL file's own `mode &
 * 0o777` when one exists, so an atomic rewrite never silently changes a
 * user's own file's permissions. Defaults to `0o644` for a destination that
 * does not exist yet.
 *
 * Round 3, code-reviewer blocker 3: `open(temporary, 'wx', mode)` alone does
 * NOT guarantee this — `open(2)`'s creation mode is ANDed with `~umask` by
 * the kernel, so under an ordinary `umask 022` a requested `0o664` silently
 * becomes `0o644` (the group-write bit dropped), which is exactly the
 * corruption this function exists to prevent for the file's BYTES, just
 * aimed at its permissions instead. The handle is `chmod`'d to `mode`
 * explicitly, straight after the write, BEFORE the rename — `fchmod(2)`
 * (what `FileHandle#chmod` calls) sets the mode bits given, verbatim, and is
 * never filtered by the umask, which only ever applies to a file's CREATION
 * mode. This never WIDENS what the original file had: `mode` is only ever
 * the caller's own `& 0o777` mask of the original `stat().mode`, so setuid,
 * setgid and the sticky bit (bits above `0o777`) are never read from the
 * original file in the first place, and this function never sets them
 * either — dropped, not "preserved as 0", and never reintroduced by a wider
 * default when the caller passes none (the `0o644` default carries none of
 * them).
 *
 * A residual race remains between the third `resolveWritableInside` check
 * and the `rename` itself — a check-then-act sequence over the filesystem
 * cannot close that window entirely, the same limit `uninstall.ts`'s own
 * manifest-deletion checkpoint already documents for the identical shape.
 *
 * Round 3 advisory (code-reviewer A3): on Windows, a `rename` over a
 * destination another process holds open WITHOUT `FILE_SHARE_DELETE` can
 * fail (`EPERM`/`EBUSY`) where the in-place `writeFile` this function
 * replaced would have succeeded — the same trade-off `commands/
 * integrations.ts`'s own `atomicWrite` already makes for its own writes.
 * A failed rename here is not a partial write, though: the destination is
 * left completely untouched (the rename never started copying bytes into
 * it — a rename is one filesystem-metadata operation, not a copy), and the
 * `finally` block below unlinks the now-orphaned temp file, so a failure
 * leaves nothing behind to clean up by hand.
 */
export async function atomicWriteInRepo(
  repoDir: string,
  rel: string,
  bytes: Buffer,
  mode: number = 0o644,
): Promise<AtomicWriteResult> {
  let dest = await resolveWritableInside(repoDir, rel);
  if (dest === null) return { ok: false, reason: 'unsafe' };
  await mkdir(path.dirname(dest), { recursive: true });
  dest = await resolveWritableInside(repoDir, rel);
  if (dest === null) return { ok: false, reason: 'unsafe' };
  const temporary = path.join(
    path.dirname(dest),
    `.${path.basename(dest)}.${randomBytes(12).toString('hex')}.tmp`,
  );
  let created = false;
  try {
    const handle = await open(temporary, 'wx', mode);
    created = true;
    try {
      await handle.writeFile(bytes);
      // Round 3, code-reviewer blocker 3: `fchmod`, not merely the creation
      // mode above — see this function's own doc comment for why the
      // creation mode alone is not enough under a non-empty umask.
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
    if ((await resolveWritableInside(repoDir, rel)) !== dest)
      return { ok: false, reason: 'unsafe' };
    await rename(temporary, dest);
    created = false;
    return { ok: true, dest };
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
}
