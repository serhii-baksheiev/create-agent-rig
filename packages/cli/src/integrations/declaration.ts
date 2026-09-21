import { isPlainObject, scanForDepthAndControlChars } from '../lib/safe-text.js';
import type { Harness, ProviderDescriptor } from './registry.js';

export const DECLARATION_REL = '.rig/integrations.json';
export const DECLARATION_SCHEMA_VERSION = 1;
export const MAX_DECLARATION_BYTES = 64 * 1024;
export const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ROOT_KEYS: readonly string[] = Object.freeze([
  'schemaVersion',
  'integrations',
  'targets',
]);
export const KNOWN_ENTRY_KEYS: readonly string[] = Object.freeze([
  'id',
  'required',
  'version',
  'harnesses',
  'selected',
  'targets',
]);
const hash = /^[0-9a-f]{64}$/;
export type DeclaredIntegration = {
  id: string;
  required?: boolean;
  version?: string;
  harnesses?: Harness[];
  selected?: true;
  targets?: Partial<Record<'claude-code', { entryHash: string }>>;
};
export type DeclarationTargets = { codex?: { fileHash: string } };
export type RejectionReason = 'not-in-matrix' | 'arbitrary-command-refused' | 'malformed';
export type Rejection = { id: string; reason: RejectionReason };
export type ParseResult =
  | {
      status: 'ok';
      entries: DeclaredIntegration[];
      rejected: Rejection[];
      targets?: DeclarationTargets;
    }
  | { status: 'invalid'; error: string };
export function truncateForMessage(value: string): string {
  return value.length > 64 ? `${value.slice(0, 64)}…` : value;
}
const isHarness = (value: unknown): value is Harness =>
  value === 'claude-code' || value === 'codex';
function rejectKey(entry: Record<string, unknown>): RejectionReason | undefined {
  for (const key of Object.keys(entry)) {
    if (!KNOWN_ENTRY_KEYS.includes(key))
      return ['command', 'args', 'env', 'url', 'headers', 'source'].includes(key)
        ? 'arbitrary-command-refused'
        : 'malformed';
  }
  return undefined;
}
export function parseDeclaration(
  raw: string,
  registry: readonly ProviderDescriptor[],
): ParseResult {
  if (new TextEncoder().encode(raw).byteLength > MAX_DECLARATION_BYTES)
    return { status: 'invalid', error: 'the declaration is larger than 64 KiB' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'invalid', error: 'the declaration is not valid JSON' };
  }
  const scan = scanForDepthAndControlChars(parsed, 6);
  if (scan.tooDeep)
    return {
      status: 'invalid',
      error: 'the declaration nests deeper than 6 levels below its root',
    };
  if (scan.hasControlChar)
    return { status: 'invalid', error: 'the declaration carries a control or format character' };
  if (
    !isPlainObject(parsed) ||
    Object.keys(parsed).some((key) => !ROOT_KEYS.includes(key)) ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.integrations)
  )
    return { status: 'invalid', error: 'the declaration shape is invalid' };
  let targets: DeclarationTargets | undefined;
  if (Object.hasOwn(parsed, 'targets')) {
    if (
      !isPlainObject(parsed.targets) ||
      Object.keys(parsed.targets).some((key) => key !== 'codex') ||
      (Object.hasOwn(parsed.targets, 'codex') &&
        (!isPlainObject(parsed.targets.codex) ||
          Object.keys(parsed.targets.codex).length !== 1 ||
          typeof parsed.targets.codex.fileHash !== 'string' ||
          !hash.test(parsed.targets.codex.fileHash)))
    )
      return { status: 'invalid', error: 'the declaration targets shape is invalid' };
    if (Object.hasOwn(parsed.targets, 'codex'))
      targets = {
        codex: { fileHash: (parsed.targets.codex as Record<string, unknown>).fileHash as string },
      };
  }
  const ids = new Set<string>(),
    entries: DeclaredIntegration[] = [],
    rejected: Rejection[] = [],
    known = new Set<string>(registry.map((item) => item.id));
  for (const value of parsed.integrations) {
    if (
      !isPlainObject(value) ||
      typeof value.id !== 'string' ||
      value.id === '' ||
      ids.has(value.id)
    )
      return { status: 'invalid', error: 'every declared integration needs a unique string "id"' };
    ids.add(value.id);
    const bad = rejectKey(value);
    if (bad !== undefined) {
      rejected.push({ id: value.id, reason: bad });
      continue;
    }
    if (!known.has(value.id)) {
      rejected.push({ id: value.id, reason: 'not-in-matrix' });
      continue;
    }
    if (
      value.selected !== true ||
      (Object.hasOwn(value, 'required') && typeof value.required !== 'boolean') ||
      (Object.hasOwn(value, 'version') &&
        (typeof value.version !== 'string' || !VERSION_PATTERN.test(value.version)))
    ) {
      rejected.push({ id: value.id, reason: 'malformed' });
      continue;
    }
    let harnesses: Harness[] | undefined;
    if (Object.hasOwn(value, 'harnesses')) {
      if (
        !Array.isArray(value.harnesses) ||
        value.harnesses.length === 0 ||
        new Set(value.harnesses).size !== value.harnesses.length ||
        !value.harnesses.every(isHarness)
      ) {
        rejected.push({ id: value.id, reason: 'malformed' });
        continue;
      }
      harnesses = value.harnesses;
    }
    let targets: Partial<Record<'claude-code', { entryHash: string }>> | undefined;
    if (Object.hasOwn(value, 'targets')) {
      if (!isPlainObject(value.targets)) {
        rejected.push({ id: value.id, reason: 'malformed' });
        continue;
      }
      targets = {};
      let badTarget = false;
      for (const [name, target] of Object.entries(value.targets)) {
        if (
          name !== 'claude-code' ||
          !isPlainObject(target) ||
          Object.keys(target).length !== 1 ||
          typeof target.entryHash !== 'string' ||
          !hash.test(target.entryHash)
        ) {
          badTarget = true;
          break;
        }
        targets[name] = { entryHash: target.entryHash };
      }
      if (
        badTarget ||
        (harnesses !== undefined &&
          Object.keys(targets).some((name) => !harnesses!.includes(name as Harness)))
      ) {
        rejected.push({
          id: value.id,
          reason: badTarget ? 'arbitrary-command-refused' : 'malformed',
        });
        continue;
      }
    }
    entries.push({
      id: value.id,
      ...(typeof value.required === 'boolean' ? { required: value.required } : {}),
      ...(value.version === undefined ? {} : { version: value.version as string }),
      ...(harnesses === undefined ? {} : { harnesses }),
      selected: true,
      ...(targets === undefined ? {} : { targets }),
    });
  }
  return { status: 'ok', entries, rejected, ...(targets === undefined ? {} : { targets }) };
}
export function serializeDeclaration(
  entries: readonly DeclaredIntegration[],
  targets?: DeclarationTargets,
): string {
  const integrations = [...entries]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => ({
      id: entry.id,
      ...(entry.required === undefined ? {} : { required: entry.required }),
      ...(entry.version === undefined ? {} : { version: entry.version }),
      ...(entry.harnesses === undefined ? {} : { harnesses: entry.harnesses }),
      selected: true,
      ...(entry.targets === undefined ? {} : { targets: entry.targets }),
    }));
  return `${JSON.stringify(
    { schemaVersion: 1, integrations, ...(targets === undefined ? {} : { targets }) },
    null,
    2,
  )}\n`;
}
