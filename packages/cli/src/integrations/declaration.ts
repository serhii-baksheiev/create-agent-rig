/**
 * `.rig/integrations.json`: the committed declaration of which registry
 * providers a repository opts into (RP-22, plan §1.1, §1.4).
 *
 * It is committed, so it arrives through pull requests like any other file —
 * untrusted input, exactly as `manifest.ts` and `uninstall.ts` already treat
 * their own files. It can name only an `id` from the {@link ProviderDescriptor}
 * registry passed in, plus a handful of validated scalars. An entry key that
 * would let the file carry a command, a URL, an argument, an environment
 * value or a header is refused with a named reason rather than ignored — and
 * so is a root key outside `schemaVersion`/`integrations`.
 *
 * This module imports only its sibling `./registry.js` and `../lib/safe-text.js`.
 * Pinned by `packages/cli/test/integrations-registry.test.ts` › "every
 * integrations/ module imports only its declared relative modules, and never
 * requires, dynamically imports, fetches, createRequires, process.bindings,
 * bare-imports, or re-exports" and, more precisely for this file, › "each
 * module imports EXACTLY its declared set — registry.ts and state.ts import
 * nothing at all".
 *
 * `parseDeclaration` is TOTAL: no string input may make it throw. The one
 * property that would break that promise — an iterative-vs-recursive walk
 * over attacker-controlled JSON — is pinned by
 * `packages/cli/test/integrations-declaration.test.ts` › "a fuzz list of
 * hostile shapes never makes parseDeclaration throw". The walk itself
 * (`scanForDepthAndControlChars`) and the `isPlainObject` predicate live in
 * `../lib/safe-text.js`, shared with `receipt.ts` rather than duplicated
 * (RP-22 S2 gate finding — `.claude/rules/invariants.md`, "One mechanism, one
 * implementation").
 */
import { isPlainObject, scanForDepthAndControlChars } from '../lib/safe-text.js';
import { validateDescriptor, type Harness, type ProviderDescriptor } from './registry.js';

export const DECLARATION_REL = '.rig/integrations.json';
export const DECLARATION_SCHEMA_VERSION = 1;

/**
 * Exported (RP-22 round 2) so a caller that wants to refuse an oversized file
 * BEFORE reading it whole — `stat` the path, compare its size, only then
 * `readFile` — has the same number `parseDeclaration` itself enforces after
 * the fact, rather than a second, easily-drifting copy of `64 * 1024`
 * (`.claude/rules/invariants.md`, "One mechanism, one implementation"). This
 * export changes no behaviour here: the check below is unchanged.
 */
export const MAX_DECLARATION_BYTES = 64 * 1024;

/**
 * The version pin pattern. Exported so a test can assert, byte for byte, that
 * this is the same string as `contracts/integrations/v1/declaration.schema.json`'s
 * `properties.integrations.items.properties.version.pattern` — one fact, one
 * spelling (`.claude/rules/invariants.md`, "One mechanism, one implementation").
 */
export const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Nothing this schema describes legitimately nests deeper than
 * root(0) → `integrations[]`(1) → an entry object(2) → a scalar field or
 * `harnesses[]`(3) → a harness string(4). Anything past that is not a bigger
 * declaration, it is a different, hostile shape.
 */
const MAX_DECLARATION_DEPTH = 4;

const ROOT_KEYS_LIST = ['schemaVersion', 'integrations'] as const;

/**
 * Exported so a test can assert this is the SAME array as the schema's
 * top-level `properties` keys — one fact, one spelling
 * (`.claude/rules/invariants.md`, "One mechanism, one implementation"). A
 * frozen ARRAY, not a `Set`: `Object.freeze` on a `Set` leaves its internal
 * slots (`add`/`delete`) open, so a live `Set` export is still mutable
 * (RP-22 S2 carry-over) — the same reasoning as {@link KNOWN_ENTRY_KEYS} below.
 */
export const ROOT_KEYS: readonly string[] = Object.freeze([...ROOT_KEYS_LIST]);
const ROOT_KEYS_SET = new Set(ROOT_KEYS);
const ARBITRARY_COMMAND_KEYS = new Set(['command', 'args', 'env']);
const NON_OFFICIAL_SOURCE_KEYS = new Set(['source', 'url', 'headers']);

const KNOWN_ENTRY_KEYS_LIST = ['id', 'required', 'version', 'harnesses'] as const;

/**
 * Exported so a test can assert this is the SAME array as the schema's
 * `properties.integrations.items.properties` keys — one fact, one spelling
 * (`.claude/rules/invariants.md`, "One mechanism, one implementation"). Before
 * that correspondence test existed, the schema's own `additionalProperties:
 * false` on an entry could be deleted with every test still green (RP-22 gate
 * cycle 2, blocker 1): the parser and the schema legitimately refuse an
 * unknown entry key at different LEVELS (parser: per-entry rejection, file
 * still `ok`; schema: the whole document fails to validate), so neither
 * layer's own test suite alone could notice the other losing its closure.
 *
 * A frozen ARRAY, not a `Set` (RP-22 S2 carry-over, gate finding on S1): a
 * frozen `Set` is still mutable through `add`/`delete` — `Object.freeze`
 * only closes the object's own property slots, not the methods a `Set`
 * dispatches through internally. The membership check below uses a private,
 * un-exported `Set` built from this array.
 */
export const KNOWN_ENTRY_KEYS: readonly string[] = Object.freeze([...KNOWN_ENTRY_KEYS_LIST]);
const KNOWN_ENTRY_KEYS_SET = new Set(KNOWN_ENTRY_KEYS);
const MAX_ECHOED_ID_LENGTH = 64;

export type DeclaredIntegration = {
  id: string;
  required?: boolean;
  version?: string;
  harnesses?: Harness[];
};

export type RejectionReason =
  | 'not-in-matrix'
  | 'arbitrary-command-refused'
  | 'non-official-source'
  | 'malformed'
  | 'unknown-license'
  | 'unpinnable-version'
  | 'exclusive-group-conflict';

export type Rejection = { id: string; reason: RejectionReason; message?: string };

export type ParseResult =
  | { status: 'ok'; entries: DeclaredIntegration[]; rejected: Rejection[] }
  | { status: 'invalid'; error: string };

/**
 * A value longer than {@link MAX_ECHOED_ID_LENGTH} truncated for a message a
 * maintainer reads. Exported so `receipt.ts` does not re-implement the same
 * truncation rule (`.claude/rules/invariants.md`, "One mechanism, one
 * implementation").
 */
export function truncateForMessage(value: string): string {
  return value.length > MAX_ECHOED_ID_LENGTH ? `${value.slice(0, MAX_ECHOED_ID_LENGTH)}…` : value;
}

function isHarness(value: string): value is Harness {
  return value === 'claude-code' || value === 'codex';
}

/** An array of distinct harnesses, each named in `descriptor`'s own routes. */
function isHarnessSubset(value: unknown, descriptor: ProviderDescriptor): value is Harness[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (new Set(value).size !== value.length) return false;
  return value.every(
    (item): item is Harness =>
      typeof item === 'string' && isHarness(item) && descriptor.routes[item] !== undefined,
  );
}

/**
 * The worst refused-key reason an entry's OWN keys carry, scanning every key
 * rather than stopping at the first — so the reason cannot depend on the
 * order the file happens to list keys in. `arbitrary-command-refused` (a
 * command/args/env key) outranks `non-official-source` (source/url/headers),
 * which outranks `malformed` (any other unrecognised key); a known key scores
 * nothing. `null` means every key is known.
 */
function mostSevereUnknownKeyReason(entry: Record<string, unknown>): RejectionReason | null {
  const SEVERITY = {
    known: 0,
    malformed: 1,
    'non-official-source': 2,
    'arbitrary-command-refused': 3,
  } as const;
  let best: RejectionReason | null = null;
  let bestSeverity: number = SEVERITY.known;
  for (const key of Object.keys(entry)) {
    let reason: RejectionReason | null;
    let severity: number;
    if (KNOWN_ENTRY_KEYS_SET.has(key)) {
      reason = null;
      severity = SEVERITY.known;
    } else if (ARBITRARY_COMMAND_KEYS.has(key)) {
      reason = 'arbitrary-command-refused';
      severity = SEVERITY['arbitrary-command-refused'];
    } else if (NON_OFFICIAL_SOURCE_KEYS.has(key)) {
      reason = 'non-official-source';
      severity = SEVERITY['non-official-source'];
    } else {
      reason = 'malformed';
      severity = SEVERITY.malformed;
    }
    if (severity > bestSeverity) {
      bestSeverity = severity;
      best = reason;
    }
  }
  return best;
}

type ValidatedEntry = { id: string; raw: Record<string, unknown> };

/**
 * Parse a `.rig/integrations.json` file against a provider registry.
 *
 * A file-level problem — not JSON, too deep, a control or Unicode-format
 * character anywhere, more than 64 KiB, a root key outside `schemaVersion`/
 * `integrations`, the wrong `schemaVersion`, `integrations` not an array, a
 * non-object entry, an entry with no string `id`, or a duplicate id — voids
 * the whole file: `{ status: 'invalid' }`. Otherwise every entry is judged on
 * its own: a refused key (checked first, so a smuggling attempt is never
 * masked by an id that also happens to be outside the registry), an id
 * outside the registry, a malformed scalar, a descriptor that fails
 * {@link validateDescriptor}, or an `exclusiveGroup` conflict with another
 * accepted entry moves it from `entries` to `rejected` with a named reason.
 */
export function parseDeclaration(
  raw: string,
  registry: readonly ProviderDescriptor[],
): ParseResult {
  if (new TextEncoder().encode(raw).byteLength > MAX_DECLARATION_BYTES) {
    return { status: 'invalid', error: 'the declaration is larger than 64 KiB' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'invalid', error: 'the declaration is not valid JSON' };
  }

  const scan = scanForDepthAndControlChars(parsed, MAX_DECLARATION_DEPTH);
  if (scan.tooDeep) {
    return {
      status: 'invalid',
      error: `the declaration nests deeper than ${MAX_DECLARATION_DEPTH} levels below its root`,
    };
  }
  if (scan.hasControlChar) {
    return { status: 'invalid', error: 'the declaration carries a control or format character' };
  }

  if (!isPlainObject(parsed)) {
    return { status: 'invalid', error: 'the declaration must be a JSON object' };
  }
  const root = parsed;

  for (const key of Object.keys(root)) {
    if (!ROOT_KEYS_SET.has(key)) {
      return {
        status: 'invalid',
        error: 'the declaration has a root key outside {schemaVersion, integrations}',
      };
    }
  }

  if (root.schemaVersion !== DECLARATION_SCHEMA_VERSION) {
    return { status: 'invalid', error: `"schemaVersion" must be ${DECLARATION_SCHEMA_VERSION}` };
  }

  if (!Array.isArray(root.integrations)) {
    return { status: 'invalid', error: '"integrations" must be an array' };
  }

  const seenIds = new Set<string>();
  const validEntries: ValidatedEntry[] = [];
  for (const rawEntry of root.integrations) {
    if (!isPlainObject(rawEntry)) {
      return { status: 'invalid', error: 'every declared integration must be a JSON object' };
    }
    const entry = rawEntry;
    const idValue = entry.id;
    if (typeof idValue !== 'string' || idValue === '') {
      return { status: 'invalid', error: 'every declared integration needs a string "id"' };
    }
    if (seenIds.has(idValue)) {
      return {
        status: 'invalid',
        error: `duplicate integration id "${truncateForMessage(idValue)}"`,
      };
    }
    seenIds.add(idValue);
    validEntries.push({ id: idValue, raw: entry });
  }

  const registryById = new Map(registry.map((descriptor) => [descriptor.id, descriptor]));
  const accepted: { entry: DeclaredIntegration; descriptor: ProviderDescriptor }[] = [];
  const rejected: Rejection[] = [];

  for (const { id, raw: entry } of validEntries) {
    // Scanned first and independent of registry membership: a refused key is
    // reported as itself, never masked by an id that also happens to be
    // outside the registry (a typo'd id must not hide a smuggling attempt).
    const badKeyReason = mostSevereUnknownKeyReason(entry);
    if (badKeyReason !== null) {
      rejected.push({ id, reason: badKeyReason });
      continue;
    }

    const descriptor = registryById.get(id);
    if (descriptor === undefined) {
      rejected.push({ id, reason: 'not-in-matrix' });
      continue;
    }

    let required: boolean | undefined;
    if (Object.hasOwn(entry, 'required')) {
      const value = entry.required;
      if (typeof value !== 'boolean') {
        rejected.push({ id, reason: 'malformed' });
        continue;
      }
      required = value;
    }

    let version: string | undefined;
    if (Object.hasOwn(entry, 'version')) {
      const value = entry.version;
      if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
        rejected.push({ id, reason: 'malformed' });
        continue;
      }
      version = value;
    }

    let harnesses: Harness[] | undefined;
    if (Object.hasOwn(entry, 'harnesses')) {
      const value = entry.harnesses;
      if (!isHarnessSubset(value, descriptor)) {
        rejected.push({ id, reason: 'malformed' });
        continue;
      }
      harnesses = value;
    }

    const validation = validateDescriptor(descriptor);
    if (!validation.ok) {
      rejected.push({ id, reason: validation.reason });
      continue;
    }

    accepted.push({
      entry: {
        id,
        ...(required !== undefined ? { required } : {}),
        ...(version !== undefined ? { version } : {}),
        ...(harnesses !== undefined ? { harnesses } : {}),
      },
      descriptor,
    });
  }

  // Two accepted entries sharing an `exclusiveGroup` are both rejected, with a
  // message built from the SORTED ids — so the input order of the file cannot
  // change what the message says.
  const groupMembers = new Map<string, string[]>();
  for (const { entry, descriptor } of accepted) {
    if (descriptor.exclusiveGroup === undefined) continue;
    const members = groupMembers.get(descriptor.exclusiveGroup) ?? [];
    members.push(entry.id);
    groupMembers.set(descriptor.exclusiveGroup, members);
  }

  const conflictingIds = new Set<string>();
  for (const members of groupMembers.values()) {
    if (members.length < 2) continue;
    for (const id of members) conflictingIds.add(id);
  }

  if (conflictingIds.size > 0) {
    const sortedConflicting = [...conflictingIds].sort();
    const message = `exclusive group conflict: ${sortedConflicting.join(', ')}`;
    for (const id of sortedConflicting)
      rejected.push({ id, reason: 'exclusive-group-conflict', message });
  }

  const entries = accepted
    .filter(({ entry }) => !conflictingIds.has(entry.id))
    .map(({ entry }) => entry);
  return { status: 'ok', entries, rejected };
}

/**
 * Stable bytes: entries sorted by id, a fixed key order per entry
 * (`id, required, version, harnesses`), two-space indent, trailing newline,
 * absent optionals omitted rather than written `null`.
 */
export function serializeDeclaration(entries: readonly DeclaredIntegration[]): string {
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const integrations = sorted.map((entry) => {
    const ordered: Record<string, unknown> = { id: entry.id };
    if (entry.required !== undefined) ordered.required = entry.required;
    if (entry.version !== undefined) ordered.version = entry.version;
    if (entry.harnesses !== undefined) ordered.harnesses = entry.harnesses;
    return ordered;
  });
  const body = { schemaVersion: DECLARATION_SCHEMA_VERSION, integrations };
  return `${JSON.stringify(body, null, 2)}\n`;
}
