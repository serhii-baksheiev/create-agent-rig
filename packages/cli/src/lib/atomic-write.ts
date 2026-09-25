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
 * `mode`, when given, is the mode the temp file (and so the renamed result)
 * is created with — the caller's job to pass the ORIGINAL file's mode when
 * one exists, so an atomic rewrite never silently changes a user's own
 * file's permissions. Defaults to `0o644` for a destination that does not
 * exist yet.
 *
 * A residual race remains between the third `resolveWritableInside` check
 * and the `rename` itself — a check-then-act sequence over the filesystem
 * cannot close that window entirely, the same limit `uninstall.ts`'s own
 * manifest-deletion checkpoint already documents for the identical shape.
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
