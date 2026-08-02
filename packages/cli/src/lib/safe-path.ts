import path from 'node:path';

/**
 * Path safety for values that came from **outside the CLI** — the install
 * manifest is committed to a repository, so it arrives in pull requests like
 * any other file, and its values are substituted into paths.
 *
 * One module owns both halves so they cannot disagree: what may become a path
 * segment, and where a resolved path is allowed to land.
 */

/** A value that can be substituted into a path without steering it. */
export function isSafeSegment(value: string): boolean {
  return (
    value !== '' &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}

/**
 * `rel` resolved under `root`, or `null` when it would land anywhere else —
 * including an absolute path, an empty path, and the classic sibling
 * (`/tmp/rig` must not contain `/tmp/rig-evil`).
 *
 * This is the containment behind every write an upgrade makes. It is deliberate
 * belt-and-braces: the values that build `rel` are validated where they are
 * parsed, and this refuses the write anyway.
 */
export function resolveInside(root: string, rel: string): string | null {
  if (rel === '' || path.isAbsolute(rel)) return null;
  const segments = rel.split('/');
  // Refused, not repaired: joining an absolute or `..`-bearing path onto the
  // root would silently turn hostile input into a plausible-looking write.
  if (segments.some((segment) => !isSafeSegment(segment))) return null;
  const base = path.resolve(root);
  const dest = path.resolve(base, ...segments);
  if (dest === base) return null;
  return dest.startsWith(base + path.sep) ? dest : null;
}
