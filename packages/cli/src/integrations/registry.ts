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
 * `packages/cli/test/integrations-registry.test.ts` › "every integrations/
 * module imports only its declared relative modules, and never requires,
 * dynamically imports, fetches, createRequires, process.bindings,
 * bare-imports, or re-exports" and, more precisely for this file, › "each
 * module imports EXACTLY its declared set — registry.ts and state.ts import
 * nothing at all".
 *
 * `isValidLocator`/`isValidSpdxExpression` are the one grammar a
 * `source.locator`/`license.id` must match, for a shipped descriptor here AND
 * for a committed, untrusted receipt (`receipt.ts` imports both rather than
 * keeping its own copy — RP-22 S2 gate finding B1).
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

/**
 * A real calendar date in `YYYY-MM-DD`, not just four digits that look like
 * one. Exported (RP-22 S2 gate finding) so `receipt.ts` imports this instead
 * of duplicating it — its own prior copy is exactly the "not exported there"
 * this comment used to describe (`.claude/rules/invariants.md`, "One
 * mechanism, one implementation").
 */
export function isRealDateString(value: string): boolean {
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
 * The one bound every `source.locator`, of any kind, is checked against
 * before its own kind's grammar even runs. A per-kind pattern below can
 * itself admit a longer string (`{0,99}` etc.) than this — the cap is
 * enforced exactly once, here, rather than re-derived per pattern
 * (RP-22 S2 gate finding B1).
 */
export const MAX_LOCATOR_LENGTH = 128;

/** The bound a `license.id` (an SPDX expression) is checked against. */
export const MAX_LICENSE_ID_LENGTH = 64;

/**
 * `owner/repo`, GitHub's own shape: an owner (alnum and hyphens, no leading
 * hyphen, GitHub's 39-character ceiling) then exactly one `/` then a repo
 * name (alnum, dot, underscore, hyphen, starting alnum). Anchored full-string,
 * so a leading `/`, a `..` segment, a drive letter, a backslash, a scheme, a
 * second `/`, `?`/`#`, an `@`, or whitespace all fail to match — there is
 * nothing in either character class for them to match against.
 */
export const GITHUB_LOCATOR_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * An npm package name: optionally `@scope/`, then a lowercase name (alnum,
 * dot, underscore, hyphen, starting alnum). npm names are lowercase by
 * convention and by npm's own registry rule, so this is stricter than GitHub's
 * pattern on purpose — the same hostile shapes are excluded for the same
 * reason (no character in either class can spell a path, a scheme, or an
 * unscoped `@`).
 */
export const NPM_LOCATOR_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}$/;

/** A PyPI project name: one segment, alnum/dot/underscore/hyphen, starting alnum. */
export const PYPI_LOCATOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * No marketplace-kind descriptor ships in {@link REGISTRY} yet, so there is no
 * real example to derive a richer (e.g. `name@marketplace`) grammar from —
 * inventing one ahead of a real descriptor would be exactly the kind of
 * unbacked API this project's rules refuse. Until one exists, a marketplace
 * locator is treated as the same conservative opaque-slug shape as PyPI: no
 * `@`, so a `user@host`-shaped value is refused by the character class alone,
 * not by a rule about what looks like a hostname. Widen this only once an
 * actual marketplace descriptor needs more (RP-22 S2 gate finding B1).
 */
export const MARKETPLACE_LOCATOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * An SPDX license EXPRESSION shape (`MIT`, `Apache-2.0`, `MIT OR Apache-2.0`)
 * — the operator grammar SPDX expressions use, not a check against the real
 * SPDX license list (that list is thousands of entries long and would be a
 * second closed vocabulary to keep in sync; this is a shape check, the same
 * kind of bound `VERSION_PATTERN` in `declaration.ts` applies to a version
 * string). Capped by {@link MAX_LICENSE_ID_LENGTH}, checked in
 * {@link isValidSpdxExpression} rather than inside the pattern, so the pattern
 * itself needs no repetition-count bookkeeping to stay total.
 */
export const SPDX_EXPRESSION_PATTERN = /^[A-Za-z0-9.+-]+(?: (?:AND|OR|WITH) [A-Za-z0-9.+-]+)*$/;

/**
 * Whether `locator` is a legitimate locator for `kind` — the ONE grammar
 * `validateDescriptor` (below, for a shipped registry entry) and
 * `receipt.ts`'s `parseSource` (for committed, untrusted receipt input) both
 * call, so the two can never quietly drift into checking different things
 * (RP-22 S2 gate finding B1; `.claude/rules/invariants.md`, "One mechanism,
 * one implementation"). The `https` branch folds in the query-string/fragment
 * refusal `receipt.ts` used to apply only to itself — a receipt or a
 * descriptor never carries a token or header field, and a query string is
 * exactly where one gets smuggled in.
 *
 * RP-22 S3 carry-over from S2: the https branch used to be LAXER than
 * `contracts/integrations/v1/receipt.schema.json`'s `license.url` pattern
 * (`^https://[^\s?#]{1,121}$`) on a raw space — the real `URL` parse
 * percent-encodes a space into the path rather than rejecting it, and the
 * query/fragment check only looked for literal `?`/`#`. That is now refused
 * on the raw input string directly, closing the gap named in
 * `integrations-receipt.test.ts` › "closed divergence (whitespace): a raw
 * space in the path now fails both the schema pattern and isValidLocator".
 *
 * A backslash was refused in the SAME pass, on the belief that it closed a
 * matching gap the same way — it did not (gate cycle 1, blocker 9). The
 * schema's `[^\s?#]` character class has nothing that excludes a backslash,
 * so a backslash-bearing URL still passes the schema pattern; refusing it
 * here makes THIS PARSER STRICTER than the schema, the opposite direction
 * from every other named divergence. The contract schema is not this
 * slice's to change (a separate, Tier-2 decision), so this is named as its
 * own divergence rather than silently claimed closed — see
 * `integrations-receipt.test.ts` › "named divergence 3 (backslash):
 * isValidLocator is STRICTER than the schema pattern here — the schema's
 * character class does not exclude a backslash at all".
 *
 * A separate shape — scheme casing — genuinely IS closed by this function:
 * `isHttpsUrl`'s real `URL` parse accepts any casing of the scheme (`URL`
 * itself lower-cases `.protocol`), so `isValidLocator('https', 'HTTPS://…')`
 * used to accept what the schema's literal `^https://` prefix always
 * refused — the parser was LAXER here. Requiring the raw locator to
 * literally start with lowercase `https://` converges it with the schema —
 * see `integrations-receipt.test.ts` › "closed divergence (uppercase
 * scheme): HTTPS://… now fails isValidLocator too, matching the schema
 * pattern's literal lowercase prefix".
 */
export function isValidLocator(kind: ProviderSource['kind'], locator: string): boolean {
  if (locator.length === 0 || locator.length > MAX_LOCATOR_LENGTH) return false;
  if (kind === 'https') {
    if (!isHttpsUrl(locator)) return false;
    if (!locator.startsWith('https://')) return false;
    if (locator.includes('?') || locator.includes('#')) return false;
    if (locator.includes('\\') || /\s/.test(locator)) return false;
    return true;
  }
  if (kind === 'github') return GITHUB_LOCATOR_PATTERN.test(locator);
  if (kind === 'npm') return NPM_LOCATOR_PATTERN.test(locator);
  if (kind === 'pypi') return PYPI_LOCATOR_PATTERN.test(locator);
  return MARKETPLACE_LOCATOR_PATTERN.test(locator); // kind === 'marketplace'
}

/** Whether `value` is a bounded, SPDX-expression-shaped string. */
export function isValidSpdxExpression(value: string): boolean {
  return (
    value.length > 0 && value.length <= MAX_LICENSE_ID_LENGTH && SPDX_EXPRESSION_PATTERN.test(value)
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
  if (descriptor.license.kind === 'spdx' && !isValidSpdxExpression(descriptor.license.id)) {
    return { ok: false, reason: 'malformed' };
  }
  if (descriptor.source.official !== true) return { ok: false, reason: 'non-official-source' };
  // `docsUrl` deliberately stays on the plain `isHttpsUrl` check, not
  // `isValidLocator` — it is a documentation link a maintainer reads, never
  // a fetch or spawn target, so a query string on it (`?tab=readme`) is
  // ordinary and is not the same risk a `source.locator`'s query string is.
  if (!isHttpsUrl(descriptor.source.docsUrl)) return { ok: false, reason: 'non-official-source' };
  // Both branches route through the SAME `isValidLocator` a committed
  // receipt is checked against (RP-22 gate cycle 2, advisory (a): the https
  // branch used to call `isHttpsUrl` directly, bypassing the query-string/
  // fragment refusal `isValidLocator('https', …)` also applies — "one
  // grammar, both callers" was false in this one branch). Only the REASON
  // differs per kind, kept exactly as before: https keeps its pre-existing,
  // tested `non-official-source`; the other four kinds had no locator-shape
  // check at all before gate cycle 1, so a new failure there is `malformed`.
  // MAX_LOCATOR_LENGTH (128) applies here too — a shipped descriptor's
  // locator is capped exactly like a committed receipt's.
  if (descriptor.source.kind === 'https' && !isValidLocator('https', descriptor.source.locator)) {
    return { ok: false, reason: 'non-official-source' };
  }
  if (
    descriptor.source.kind !== 'https' &&
    !isValidLocator(descriptor.source.kind, descriptor.source.locator)
  ) {
    return { ok: false, reason: 'malformed' };
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
// Exported (RP-22 S2 carry-over) only so the "stops descending into an
// already-frozen value" limit above has a direct test of its own — see
// `integrations-registry.test.ts` › "does not descend into a value that
// arrives already frozen, so a nested mutable property inside a pre-frozen
// shared object is left mutable" — rather than resting on this comment alone
// (`.claude/rules/invariants.md`, "State the limits — and test them").
export function deepFreeze<T>(value: T): T {
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
