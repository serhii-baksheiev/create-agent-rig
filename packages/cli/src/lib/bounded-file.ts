import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * A bounded, FIFO-safe read of one file inside a repository — the shared
 * shape behind `init.ts`'s `readKeptRootClaudeMd` (RP-256 slice 1) and the
 * AGENTS.md managed-region reads slice 2 adds (`init.ts`, `upgrade.ts`,
 * `uninstall.ts`, `doctor.ts`). One implementation, so the FIFO/size/
 * containment defence lives in exactly one place (`.claude/rules/
 * invariants.md`, "one spelling of a fact").
 *
 * security-scanner round 2 blocker B1 (PR #324, the finding this shape was
 * built to close): a repository-controlled symlink can point at a FIFO, a
 * device, or a file of unbounded size. This opens the path directly with
 * `O_RDONLY | O_NONBLOCK` (so `open()` on a FIFO with nothing on the write
 * end returns immediately instead of blocking the event loop), `fstat`s that
 * SAME handle — never a second, independent `lstat`/`stat` call, which would
 * leave a window for the target to change underneath — and reads only from
 * that handle, only when it names a REGULAR file no larger than `maxBytes`.
 * The containment check below DOES resolve the path a second time, through
 * `realpath(abs)` rather than the handle — that one is answering a different
 * question (is the target inside `repoDir` at all) than the size/regularity
 * fstat settles, and reads the bytes it vouches for from the handle opened
 * earlier regardless of what a race did to the path in between.
 *
 * `null` for anything else: a directory, a missing path, a non-regular
 * target, a target over `maxBytes`, a target outside the repo, or a target
 * this process cannot read.
 */
export async function readBoundedFileInRepo(
  repoDir: string,
  abs: string,
  maxBytes: number,
): Promise<Buffer | null> {
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(abs, flags);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return null;
    let repoReal: string;
    let targetReal: string;
    try {
      repoReal = await realpath(repoDir);
      targetReal = await realpath(abs);
    } catch {
      return null;
    }
    if (targetReal !== repoReal && !targetReal.startsWith(repoReal + path.sep)) return null;
    const bytes = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) return null;
    return bytes.subarray(0, offset);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
