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
 * A value that can be substituted into an **installed file** without changing
 * what that file means.
 *
 * 🔴 **Why this is not {@link isSafeSegment}, and why widening that one instead
 * would be wrong.** `isSafeSegment` answers "can this steer a path", and it is
 * what every segment of an installed path is held to at write time, through
 * {@link resolveInside} — `CLAUDE.md` and `.claude/rules/workflow.md` have to
 * keep passing it, so it cannot become this whitelist. But `project.name` is
 * substituted
 * into `.claude/scripts/stop-flag.mjs` **inside a single-quoted JavaScript
 * string literal**, and `guard-bash` imports that module on every Bash call. A
 * value that steers no path at all still closes that quote: it reaches code
 * execution in the hook process, and it silently disarms the kill switch,
 * because the paths it computes stop pointing at `~/.claude/<name>-loop-STOP`.
 * A brake that looks installed and is not is the worst of the two.
 *
 * So the rule is a whitelist, not a blacklist of the payloads anyone thought
 * of. It costs nothing real: `create` already refuses anything outside this
 * shape, and `projectNameFor` only ever emits `[a-z0-9._-]` — plus a leading
 * `_`, which is why the first character allows it. Nothing this repository can
 * legitimately produce is rejected here.
 */
export function isSafeSubstitutionValue(value: string): boolean {
  return /^[a-z0-9_][a-z0-9._-]*$/.test(value);
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
