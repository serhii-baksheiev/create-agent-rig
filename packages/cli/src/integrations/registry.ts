/**
 * The closed, release-owned integrations matrix (RP-22, plan §1.1).
 *
 * A declaration in a repository (`.rig/integrations.json`) can only ever name
 * an `id` from {@link REGISTRY} plus a few validated scalars — never a
 * command, a URL, an argument, an environment variable or a header. Every
 * argv element a later slice spawns comes from an in-code descriptor here,
 * because the declaration is committed and therefore untrusted input
 * (`manifest.ts` and `uninstall.ts` already state this posture for their own
 * files).
 *
 * This module imports NOTHING — no `node:` builtin, no sibling, not even its
 * own `declaration.ts`. Pinned by
 * `packages/cli/test/integrations-registry.test.ts` › "registry.ts and
 * declaration.ts import only their declared relative modules, and never
 * require, dynamically import, fetch, createRequire, process.binding,
 * bare-import, or re-export" and, more precisely for this file, › "registry.ts
 * has no imports at all, and declaration.ts imports exactly its two siblings".
 */

/** The harnesses Rig configures integrations for. */
export type Harness = 'claude-code' | 'codex';

/** What kind of thing the integration is. */
export type Mode =
  'external-installer' | 'native-plugin' | 'hosted-service' | 'external-executable';

/** How Rig gets the integration installed or configured, for one harness. */
export type Route =
  | 'claude-plugin-cli'
  | 'mcp-config'
  | 'external-installer'
  | 'codex-plugin-guided'
  | 'guided-manual'
  | 'subsystem-manifest';

export type ProviderSource = {
  kind: 'github' | 'npm' | 'pypi' | 'https' | 'marketplace';
  locator: string;
  official: boolean;
  verifiedOn: string;
  docsUrl: string;
};

export type ProviderLicense = { kind: 'spdx'; id: string } | { kind: 'terms'; url: string } | null;

export type VersionPolicy =
  { kind: 'pinned'; default: string } | { kind: 'floating'; reason: string };

export type ProviderRoute = { route: Route; automation: 'automatic' | 'guided' };

export type ProviderDescriptor = {
  id: string;
  displayName: string;
  capability: 'methodology' | 'design' | 'board' | 'memory';
  exclusiveGroup?: 'methodology';
  mode: Mode;
  source: ProviderSource;
  license: ProviderLicense;
  versionPolicy: VersionPolicy;
  routes: Partial<Record<Harness, ProviderRoute>>;
  stability: 'supported' | 'preview';
  trademark?: string;
};

export type DescriptorRejectionReason =
  'unknown-license' | 'non-official-source' | 'unpinnable-version' | 'malformed';

export type DescriptorValidation = { ok: true } | { ok: false; reason: DescriptorRejectionReason };

/**
 * A real `https:` URL: not a string that merely starts with the right
 * letters. Refuses userinfo (`https://user:pass@host` — a credential-shaped
 * value has no business in a docs/license link), an empty hostname (a bare
 * `https://` throws inside `URL` and is caught below), and accepts any casing
 * of the scheme (`HTTPS://…`), because `URL` itself lower-cases `.protocol`.
 */
export function isHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === ''
  );
}

/** A real calendar date in `YYYY-MM-DD`, not just four digits that look like one. */
function isRealDateString(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  // UTC round-trip: `new Date(Date.UTC(2026, 1, 30))` silently rolls over to
  // March 2nd for a February 30th that was never a real day.
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * The refusal rules a shipped descriptor must never trip. This is a check on
 * the release's OWN registry entries, not on committed input — the
 * declaration parser (`declaration.ts`) calls it per referenced descriptor so
 * a future registry entry that regresses one of these rules is refused the
 * same way a hostile declaration would be, rather than trusted because it
 * lives in-tree.
 */
export function validateDescriptor(descriptor: ProviderDescriptor): DescriptorValidation {
  if (descriptor.license === null) return { ok: false, reason: 'unknown-license' };
  if (descriptor.license.kind === 'terms' && !isHttpsUrl(descriptor.license.url)) {
    return { ok: false, reason: 'unknown-license' };
  }
  if (descriptor.source.official !== true) return { ok: false, reason: 'non-official-source' };
  if (!isHttpsUrl(descriptor.source.docsUrl)) return { ok: false, reason: 'non-official-source' };
  if (descriptor.source.kind === 'https' && !isHttpsUrl(descriptor.source.locator)) {
    return { ok: false, reason: 'non-official-source' };
  }
  if (!isRealDateString(descriptor.source.verifiedOn)) return { ok: false, reason: 'malformed' };
  if (descriptor.mode === 'external-installer' && descriptor.versionPolicy.kind === 'floating') {
    return { ok: false, reason: 'unpinnable-version' };
  }
  return { ok: true };
}

/**
 * Recursively `Object.freeze`s `value` and everything it (transitively)
 * references. Runs once, at module load, over this module's OWN small,
 * fixed-shape, in-code literal — never over parsed input — so it is exempt
 * from `invariants.md`'s "no recursion over input": there is no input here,
 * only the shape this file's author wrote.
 *
 * Stops descending into a value that is already frozen (`Object.isFrozen`),
 * which also means it never verifies what is INSIDE one: a descriptor that
 * reused a pre-frozen shared object (rather than a literal written fresh for
 * that descriptor) would have its own contents skipped here. Every entry in
 * {@link REGISTRY} today is a fresh object literal with no such reuse.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      // `Object.getOwnPropertyNames` erases the specific shape of `T`; the
      // cast just lets the loop below index into what it already enumerated.
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * The finite, release-owned provider matrix. One entry in this slice: the
 * existing Memory custom-executable path, exposed through the same registry
 * shape the routed providers of later slices will use. Every other provider
 * arrives in its own slice with a dated verification (plan §1.1, S1 brief).
 *
 * Frozen (deeply) so an accidental in-place edit — of the array, an entry, or
 * a nested `source`/`routes` object — throws in strict mode (every ESM module
 * is strict) instead of silently mutating the one matrix every consumer trusts.
 */
export const REGISTRY: readonly ProviderDescriptor[] = deepFreeze([
  {
    id: 'memory-custom-executable',
    displayName: 'Custom Memory Executable',
    capability: 'memory',
    mode: 'external-executable',
    source: {
      kind: 'github',
      locator: 'serhii-baksheiev/create-agent-rig',
      official: true,
      verifiedOn: '2026-09-20',
      docsUrl: 'https://github.com/serhii-baksheiev/create-agent-rig#readme',
    },
    license: {
      kind: 'terms',
      url: 'https://github.com/serhii-baksheiev/create-agent-rig/blob/master/LICENSE',
    },
    versionPolicy: {
      kind: 'floating',
      reason: 'compatibility is the handshake, not a range',
    },
    routes: {
      'claude-code': { route: 'subsystem-manifest', automation: 'automatic' },
      codex: { route: 'subsystem-manifest', automation: 'automatic' },
    },
    stability: 'supported',
  },
]);
