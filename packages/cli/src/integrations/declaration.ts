/**
 * `.rig/integrations.json`: the committed declaration of which registry
 * providers a repository opts into (RP-22, plan §1.1, §1.4).
 *
 * It is committed, so it arrives through pull requests like any other file —
 * untrusted input, exactly as `manifest.ts` and `uninstall.ts` already treat
 * their own files. It can name only an `id` from the {@link ProviderDescriptor}
 * registry passed in, plus a handful of validated scalars. An entry key that
 * would let the file carry a command, a URL, an argument, an environment
 * value or a header is refused with a named reason rather than ignored.
 *
 * Pure module: no `node:child_process`, no `node:net`, no filesystem. Pinned
 * by `packages/cli/test/integrations-registry.test.ts` › "registry.ts and
 * declaration.ts import neither child_process nor any net module".
 */
import { hasControlCharacter } from '../lib/safe-text.js';
import { validateDescriptor, type Harness, type ProviderDescriptor } from './registry.js';

export const DECLARATION_REL = '.rig/integrations.json';
export const DECLARATION_SCHEMA_VERSION = 1;

const MAX_DECLARATION_BYTES = 64 * 1024;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KNOWN_HARNESSES: readonly Harness[] = ['claude-code', 'codex'];
const ARBITRARY_COMMAND_KEYS = new Set(['command', 'args', 'env']);
const NON_OFFICIAL_SOURCE_KEYS = new Set(['source', 'url', 'headers']);
const KNOWN_ENTRY_KEYS = new Set(['id', 'required', 'version', 'harnesses']);

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

/** Every string leaf in a parsed JSON value, walked without regard to shape. */
function hasControlCharacterDeep(value: unknown): boolean {
  if (typeof value === 'string') return hasControlCharacter(value);
  if (Array.isArray(value)) return value.some((item) => hasControlCharacterDeep(item));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, child]) => hasControlCharacter(key) || hasControlCharacterDeep(child),
    );
  }
  return false;
}

function firstUnknownKeyReason(entry: Record<string, unknown>): RejectionReason | null {
  for (const key of Object.keys(entry)) {
    if (KNOWN_ENTRY_KEYS.has(key)) continue;
    if (ARBITRARY_COMMAND_KEYS.has(key)) return 'arbitrary-command-refused';
    if (NON_OFFICIAL_SOURCE_KEYS.has(key)) return 'non-official-source';
    return 'malformed';
  }
  return null;
}

function isHarnessSubset(value: unknown, descriptor: ProviderDescriptor): value is Harness[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (item): item is Harness =>
      typeof item === 'string' &&
      (KNOWN_HARNESSES as readonly string[]).includes(item) &&
      descriptor.routes[item as Harness] !== undefined,
  );
}

/**
 * Parse a `.rig/integrations.json` file against a provider registry.
 *
 * A file-level problem (not JSON, wrong `schemaVersion`, `integrations` not
 * an array, a duplicate id, a control character anywhere, or more than 64
 * KiB) voids the whole file — `{ status: 'invalid' }`. Otherwise every entry
 * is judged on its own: an id outside the registry, a refused key, a
 * malformed scalar, a descriptor that fails {@link validateDescriptor}, or an
 * `exclusiveGroup` conflict with another accepted entry moves it from
 * `entries` to `rejected` with a named reason.
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

  if (hasControlCharacterDeep(parsed)) {
    return { status: 'invalid', error: 'the declaration carries a control or format character' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'invalid', error: 'the declaration must be a JSON object' };
  }
  const root = parsed as Record<string, unknown>;

  if (root.schemaVersion !== DECLARATION_SCHEMA_VERSION) {
    return { status: 'invalid', error: `"schemaVersion" must be ${DECLARATION_SCHEMA_VERSION}` };
  }

  if (!Array.isArray(root.integrations)) {
    return { status: 'invalid', error: '"integrations" must be an array' };
  }

  const seenIds = new Set<string>();
  for (const rawEntry of root.integrations) {
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
      return { status: 'invalid', error: 'every declared integration must be a JSON object' };
    }
    const idValue = (rawEntry as Record<string, unknown>).id;
    if (typeof idValue !== 'string' || idValue === '') {
      return { status: 'invalid', error: 'every declared integration needs a string "id"' };
    }
    if (seenIds.has(idValue)) {
      return { status: 'invalid', error: `duplicate integration id "${idValue}"` };
    }
    seenIds.add(idValue);
  }

  const registryById = new Map(registry.map((descriptor) => [descriptor.id, descriptor]));
  const accepted: DeclaredIntegration[] = [];
  const rejected: Rejection[] = [];

  for (const rawEntry of root.integrations as Record<string, unknown>[]) {
    const id = rawEntry.id as string;
    const descriptor = registryById.get(id);
    if (descriptor === undefined) {
      rejected.push({ id, reason: 'not-in-matrix' });
      continue;
    }

    const badKeyReason = firstUnknownKeyReason(rawEntry);
    if (badKeyReason !== null) {
      rejected.push({ id, reason: badKeyReason });
      continue;
    }

    const requiredValue = rawEntry.required;
    if (requiredValue !== undefined && typeof requiredValue !== 'boolean') {
      rejected.push({ id, reason: 'malformed' });
      continue;
    }

    const versionValue = rawEntry.version;
    if (versionValue !== undefined) {
      if (typeof versionValue !== 'string' || !VERSION_PATTERN.test(versionValue)) {
        rejected.push({ id, reason: 'malformed' });
        continue;
      }
    }

    let harnesses: Harness[] | undefined;
    const harnessesValue = rawEntry.harnesses;
    if (harnessesValue !== undefined) {
      if (!isHarnessSubset(harnessesValue, descriptor)) {
        rejected.push({ id, reason: 'malformed' });
        continue;
      }
      harnesses = harnessesValue;
    }

    const validation = validateDescriptor(descriptor);
    if (!validation.ok) {
      rejected.push({ id, reason: validation.reason });
      continue;
    }

    accepted.push({
      id,
      ...(requiredValue !== undefined ? { required: requiredValue as boolean } : {}),
      ...(versionValue !== undefined ? { version: versionValue as string } : {}),
      ...(harnesses !== undefined ? { harnesses } : {}),
    });
  }

  // Two accepted entries sharing an `exclusiveGroup` are both rejected, with a
  // message built from the SORTED ids — so the input order of the file cannot
  // change what the message says.
  const groupMembers = new Map<string, string[]>();
  for (const entry of accepted) {
    const exclusiveGroup = registryById.get(entry.id)!.exclusiveGroup;
    if (exclusiveGroup === undefined) continue;
    const members = groupMembers.get(exclusiveGroup) ?? [];
    members.push(entry.id);
    groupMembers.set(exclusiveGroup, members);
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

  const entries = accepted.filter((entry) => !conflictingIds.has(entry.id));
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
