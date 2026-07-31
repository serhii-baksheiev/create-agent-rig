/**
 * `init` installs the PROCESS layer only — a subset of the hooks the generated
 * shape gets. The wiring it writes has to match that subset exactly:
 *
 * - wiring a hook file that was not installed makes every matching tool call
 *   fail on a missing module;
 * - wiring nothing at all is worse and quieter — the hooks sit on disk, the
 *   rules claim they are enforced, and nothing ever calls them.
 *
 * So the wiring is *derived* from the shipped settings.json rather than
 * maintained as a second copy: add a process hook and wire it once, upstream,
 * and init picks it up.
 */

/** Matches the hook file a wired command runs, e.g. `.claude/hooks/guard-bash.mjs`. */
const HOOK_REFERENCE = /\.claude\/hooks\/[A-Za-z0-9._-]+\.mjs/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An entry survives unless it names a hook file that is not installed. */
function keepEntry(entry: unknown, installed: ReadonlySet<string>): boolean {
  if (!isRecord(entry) || typeof entry.command !== 'string') return true;
  const referenced = HOOK_REFERENCE.exec(entry.command);
  return referenced === null || installed.has(referenced[0]);
}

/** A group survives only with at least one entry left — never as an empty shell. */
function keepGroup(group: unknown, installed: ReadonlySet<string>): unknown | null {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return group;
  const hooks = group.hooks.filter((entry) => keepEntry(entry, installed));
  return hooks.length === 0 ? null : { ...group, hooks };
}

/**
 * The shipped settings, narrowed to the hooks actually installed. Shapes this
 * function does not understand are passed through untouched — it filters, it
 * never rewrites.
 */
export function settingsForInstalledHooks(
  settings: unknown,
  installed: ReadonlySet<string>,
): unknown {
  if (!isRecord(settings) || !isRecord(settings.hooks)) return settings;
  const events: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      events[event] = groups;
      continue;
    }
    const kept = groups.map((group) => keepGroup(group, installed)).filter((g) => g !== null);
    if (kept.length > 0) events[event] = kept;
  }
  return { ...settings, hooks: events };
}
