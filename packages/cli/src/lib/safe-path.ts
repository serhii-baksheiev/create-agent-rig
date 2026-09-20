import { lstat, realpath } from 'node:fs/promises';
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
 * what {@link resolveInside} holds every path segment to when an upgrade
 * writes — `CLAUDE.md` and `.claude/rules/workflow.md` have to keep passing it,
 * so it cannot become this whitelist. But `project.name` is substituted into
 * `.claude/scripts/stop-flag.mjs` **inside a single-quoted JavaScript string
 * literal**, and `guard-bash` imports that module on every Bash call. A value
 * that steers no path at all still closes that quote: it reaches code
 * execution in the hook process, and it silently disarms the kill switch,
 * because the paths it computes stop pointing at `~/.claude/<name>-loop-STOP`.
 * A brake that looks installed and is not is the worst of the two.
 *
 * So the rule is a whitelist, not a blacklist of the payloads anyone thought
 * of. It costs nothing real: `create` already refuses anything outside this
 * shape, and `projectNameFor` only ever emits `[a-z0-9._-]` — plus a leading
 * `_`, which is why the first character allows it.
 *
 * One legitimate value it does reject on purpose: the **empty** region, which
 * `init` writes to mean "no region". That carve-out belongs to the caller
 * (`parseManifest`), not here — an empty string is exactly what a whitelist of
 * substitutable characters should refuse, and folding "or empty" into this
 * predicate would hand it to `name` and `scope` as well.
 */
export function isSafeSubstitutionValue(value: string): boolean {
  return /^[a-z0-9_][a-z0-9._-]*$/.test(value);
}

/**
 * The most path segments any legitimate `rel` this codebase constructs or
 * tests ever needs. The deepest path this release's own install set ships is
 * `.claude/skills/worktree-task/SKILL.md` (4 segments); this leaves 4x
 * headroom for a rule, skill or hook nested one or two levels deeper someday,
 * without coming anywhere near the cost boundary below.
 *
 * `rel` is not always this command's own construction, though — a rig
 * manifest is committed input (`uninstall`'s `files`/`kept` keys reach
 * {@link resolveInside} through `onDisk`, one key at a time, before ownership
 * is even checked), so a hostile one can name a key of unbounded segment
 * count. `path.resolve(base, ...segments)` below is a SPREAD over
 * `segments`, and past roughly 65,000–130,000 elements (engine-dependent)
 * that raises an uncaught `RangeError: Maximum call stack size exceeded` —
 * not caught anywhere on this path, so it would surface as a raw stack trace
 * instead of the refusal this function exists to return, and under `--json`
 * as a bare message instead of the promised payload. This is the "no spread
 * of an array whose length is unbounded by input" case named in
 * `.claude/rules/invariants.md`'s fail-open rule; the cap below closes it by
 * refusing before the spread is ever reached.
 */
const MAX_PATH_SEGMENTS = 16;

/**
 * `rel` resolved under `root`, or `null` when it would land anywhere else —
 * including an absolute path, an empty path, the classic sibling
 * (`/tmp/rig` must not contain `/tmp/rig-evil`), or a segment count past
 * {@link MAX_PATH_SEGMENTS}.
 *
 * This is the containment behind every write an upgrade makes. It is deliberate
 * belt-and-braces: the values that build `rel` are validated where they are
 * parsed, and this refuses the write anyway.
 */
export function resolveInside(root: string, rel: string): string | null {
  if (rel === '' || path.isAbsolute(rel)) return null;
  const segments = rel.split('/');
  if (segments.length > MAX_PATH_SEGMENTS) return null;
  // Refused, not repaired: joining an absolute or `..`-bearing path onto the
  // root would silently turn hostile input into a plausible-looking write.
  if (segments.some((segment) => !isSafeSegment(segment))) return null;
  const base = path.resolve(root);
  const dest = path.resolve(base, ...segments);
  if (dest === base) return null;
  return dest.startsWith(base + path.sep) ? dest : null;
}

/**
 * Resolve a prospective write through the repository's real path and refuse
 * every symlink in the relative path that already exists.
 *
 * Lexical containment is not enough for a writer: `root/.claude` can be a
 * link to another directory, and a link at the final path can be dangling
 * until `writeFile` creates its target. Missing components are allowed because
 * callers create them, then call this function again immediately before the
 * write. The second check makes the newly-created chain evidence too.
 */
export async function resolveWritableInside(root: string, rel: string): Promise<string | null> {
  let base: string;
  try {
    base = await realpath(root);
    if (!(await lstat(base)).isDirectory()) return null;
  } catch {
    return null;
  }

  const dest = resolveInside(base, rel);
  if (dest === null) return null;

  let cursor = base;
  for (const segment of rel.split('/')) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) return null;
      const resolved = await realpath(cursor);
      if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return dest;
      return null;
    }
  }

  return dest;
}
