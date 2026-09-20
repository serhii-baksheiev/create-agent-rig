/**
 * `.rig/receipts/<id>.json`: the committed evidence record a route writes
 * after acting on a declared integration (RP-22, plan §1.4).
 *
 * A receipt is parsed exactly like `.rig/integrations.json`: committed,
 * therefore untrusted input, refused rather than silently trimmed on any
 * unrecognised shape. `parseReceipt` is TOTAL — no string input may make it
 * throw — using the same iterative, depth-bounded scan `declaration.ts`
 * uses, duplicated locally rather than factored out so this slice does not
 * touch `declaration.ts`'s own scan beyond its two carried-over review items.
 * Pinned by `packages/cli/test/integrations-receipt.test.ts` › "a fuzz list
 * of hostile shapes never makes parseReceipt throw".
 *
 * A receipt is never read as state (plan §1.4, "What makes a receipt
 * trustworthy", point 2): this module offers no function that turns a
 * receipt alone into an {@link InstanceState} — `./state.js`'s `classify`
 * takes a `ReceiptBaseline` only to compare against a *live* observation,
 * never to answer "is it installed" by itself.
 *
 * Deviation from the plan's receipt example, and why: the example shows
 * `"version": null` and `"digest": null` written out explicitly. The
 * schema-subset validator this module's fixtures are checked against
 * (`scripts/lib/json-schema-subset.mjs`) has no `null` type and no `oneOf`,
 * so a schema field cannot accept "a string, or else `null`" — only "present
 * as a string" or "absent". This module therefore treats an absent field and
 * an explicit JSON `null` as two DIFFERENT things: absent is a valid empty
 * value, `null` is refused like any other type mismatch. `serializeReceipt`
 * always OMITS a field with no value rather than writing `null`. Code and
 * schema-subset capability win over the plan's literal example here, per
 * this slice's brief.
 *
 * This module imports `../lib/safe-text.js`, `./registry.js` for the closed
 * `Mode`/`Route`/`Harness` vocabularies (one spelling of each, not a second
 * copy), `./declaration.js` for `VERSION_PATTERN` and `truncateForMessage`,
 * and `./state.js` for the closed `InstanceState` vocabulary.
 */
import { hasControlCharacter } from '../lib/safe-text.js';
import { truncateForMessage, VERSION_PATTERN } from './declaration.js';
import { isHttpsUrl, type Harness, type Mode, type Route } from './registry.js';
import { INSTANCE_STATES, type InstanceState } from './state.js';

export { VERSION_PATTERN };

export const RECEIPT_SCHEMA_VERSION = 1;
export const RECEIPTS_DIR_REL = '.rig/receipts';

const MAX_RECEIPT_BYTES = 64 * 1024;

/**
 * Nothing this schema describes legitimately nests deeper than
 * root(0) → `acts`(1) → one harness's act object(2) → `observedAfter`(3) →
 * `evidence[]`(4) → an evidence string(5). Anything past that is not a
 * bigger receipt, it is a different, hostile shape (mirrors
 * `declaration.ts`'s `MAX_DECLARATION_DEPTH`).
 */
const MAX_RECEIPT_DEPTH = 5;

/** A lowercase, hyphenated token: an integration id, an installer tool name, an evidence tag. */
export const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** A lowercase hex digest, 7 to 128 characters (short SHA through SHA-512). */
export const DIGEST_PATTERN = /^[0-9a-f]{7,128}$/;

/** A UTC timestamp with second precision, e.g. `2026-09-21T10:00:00Z`. */
export const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const ROOT_KEYS_LIST = [
  'schemaVersion',
  'id',
  'mode',
  'source',
  'license',
  'declared',
  'rigVersion',
  'acts',
] as const;
/** The closed set of top-level receipt keys, matching the schema's root `properties`. */
export const ROOT_KEYS: readonly string[] = Object.freeze([...ROOT_KEYS_LIST]);
const ROOT_KEYS_SET = new Set(ROOT_KEYS);

const SOURCE_KEYS_LIST = ['kind', 'locator', 'official', 'verifiedOn'] as const;
export const SOURCE_KEYS: readonly string[] = Object.freeze([...SOURCE_KEYS_LIST]);
const SOURCE_KEYS_SET = new Set(SOURCE_KEYS);

const LICENSE_KEYS_LIST = ['kind', 'id', 'url'] as const;
export const LICENSE_KEYS: readonly string[] = Object.freeze([...LICENSE_KEYS_LIST]);
const LICENSE_KEYS_SET = new Set(LICENSE_KEYS);

const DECLARED_KEYS_LIST = ['required', 'version'] as const;
export const DECLARED_KEYS: readonly string[] = Object.freeze([...DECLARED_KEYS_LIST]);
const DECLARED_KEYS_SET = new Set(DECLARED_KEYS);

const INSTALLER_KEYS_LIST = ['tool', 'toolVersion', 'exitCode'] as const;
export const INSTALLER_KEYS: readonly string[] = Object.freeze([...INSTALLER_KEYS_LIST]);
const INSTALLER_KEYS_SET = new Set(INSTALLER_KEYS);

const OBSERVED_AFTER_KEYS_LIST = ['state', 'version', 'digest', 'evidence'] as const;
export const OBSERVED_AFTER_KEYS: readonly string[] = Object.freeze([...OBSERVED_AFTER_KEYS_LIST]);
const OBSERVED_AFTER_KEYS_SET = new Set(OBSERVED_AFTER_KEYS);

/** The closed set of keys inside one harness's act, matching the schema's act `properties`. */
const ACT_KEYS_LIST = [
  'route',
  'automation',
  'performedAt',
  'installer',
  'observedAfter',
  'notObserved',
] as const;
export const ACT_KEYS: readonly string[] = Object.freeze([...ACT_KEYS_LIST]);
const ACT_KEYS_SET = new Set(ACT_KEYS);

const HARNESS_VALUES_LIST = ['claude-code', 'codex'] as const;
export const HARNESS_VALUES: readonly Harness[] = Object.freeze([...HARNESS_VALUES_LIST]);
const HARNESS_VALUES_SET: ReadonlySet<string> = new Set<string>(HARNESS_VALUES);

const MODE_VALUES_LIST = [
  'external-installer',
  'native-plugin',
  'hosted-service',
  'external-executable',
] as const;
export const MODE_VALUES: readonly Mode[] = Object.freeze([...MODE_VALUES_LIST]);
const MODE_VALUES_SET: ReadonlySet<string> = new Set<string>(MODE_VALUES);

const ROUTE_VALUES_LIST = [
  'claude-plugin-cli',
  'mcp-config',
  'external-installer',
  'codex-plugin-guided',
  'guided-manual',
  'subsystem-manifest',
] as const;
export const ROUTE_VALUES: readonly Route[] = Object.freeze([...ROUTE_VALUES_LIST]);
const ROUTE_VALUES_SET: ReadonlySet<string> = new Set<string>(ROUTE_VALUES);

const AUTOMATION_VALUES_LIST = ['automatic', 'guided'] as const;
export const AUTOMATION_VALUES: readonly ('automatic' | 'guided')[] = Object.freeze([
  ...AUTOMATION_VALUES_LIST,
]);
const AUTOMATION_VALUES_SET: ReadonlySet<string> = new Set<string>(AUTOMATION_VALUES);

const SOURCE_KIND_VALUES_LIST = ['github', 'npm', 'pypi', 'https', 'marketplace'] as const;
export const SOURCE_KIND_VALUES: readonly (typeof SOURCE_KIND_VALUES_LIST)[number][] =
  Object.freeze([...SOURCE_KIND_VALUES_LIST]);
const SOURCE_KIND_VALUES_SET: ReadonlySet<string> = new Set<string>(SOURCE_KIND_VALUES);

const LICENSE_KIND_VALUES_LIST = ['spdx', 'terms'] as const;
export const LICENSE_KIND_VALUES: readonly (typeof LICENSE_KIND_VALUES_LIST)[number][] =
  Object.freeze([...LICENSE_KIND_VALUES_LIST]);
const LICENSE_KIND_VALUES_SET: ReadonlySet<string> = new Set<string>(LICENSE_KIND_VALUES);

const INSTANCE_STATES_SET: ReadonlySet<string> = new Set<string>(INSTANCE_STATES);

export type ReceiptSource = {
  kind: (typeof SOURCE_KIND_VALUES_LIST)[number];
  locator: string;
  official: boolean;
  verifiedOn: string;
};

export type ReceiptLicense = { kind: 'spdx'; id: string } | { kind: 'terms'; url: string };

export type ReceiptDeclared = { required: boolean; version?: string };

export type ReceiptInstaller = { tool: string; toolVersion: string; exitCode: number };

export type ReceiptObservedAfter = {
  state: InstanceState;
  version?: string;
  digest?: string;
  evidence: string[];
};

export type ReceiptAct = {
  route: Route;
  automation: 'automatic' | 'guided';
  performedAt: string;
  installer?: ReceiptInstaller;
  observedAfter: ReceiptObservedAfter;
  notObserved: string[];
};

export type Receipt = {
  schemaVersion: 1;
  id: string;
  mode: Mode;
  source: ReceiptSource;
  license: ReceiptLicense;
  declared: ReceiptDeclared;
  rigVersion: string;
  acts: Partial<Record<Harness, ReceiptAct>>;
};

export type ParseReceiptResult =
  { status: 'ok'; receipt: Receipt } | { status: 'invalid'; error: string };

/** A type predicate, not a cast: narrows `unknown` to an indexable object without asserting anything. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A real calendar date in `YYYY-MM-DD` (mirrors `registry.ts`'s `isRealDateString`; not exported there). */
function isRealDateString(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

type DepthScan = { tooDeep: boolean; hasControlChar: boolean };

/**
 * One iterative, explicit-worklist pass over the parsed JSON value — see
 * `declaration.ts`'s `scanParsedValue` for the full rationale (no recursion
 * over attacker-controlled input; total work bounded by the 64 KiB byte cap
 * checked before this ever runs).
 */
function scanParsedValue(root: unknown): DepthScan {
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  let hasControlChar = false;
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break; // guarded by the loop condition; stated for the type checker
    const { value, depth } = next;
    if (depth > MAX_RECEIPT_DEPTH) return { tooDeep: true, hasControlChar };
    if (typeof value === 'string') {
      if (hasControlCharacter(value)) hasControlChar = true;
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if (hasControlCharacter(key)) hasControlChar = true;
        stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return { tooDeep: false, hasControlChar };
}

type FieldResult<T> = { ok: true; value: T } | { ok: false; error: string };

const okField = <T>(value: T): FieldResult<T> => ({ ok: true, value });
const failField = <T>(error: string): FieldResult<T> => ({ ok: false, error });

function closedKeys(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
  label: string,
): string | null {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) return `${label} has an unrecognised key "${truncateForMessage(key)}"`;
  }
  return null;
}

function parseSource(raw: unknown): FieldResult<ReceiptSource> {
  if (!isPlainObject(raw)) return failField('"source" must be an object');
  const badKey = closedKeys(raw, SOURCE_KEYS_SET, '"source"');
  if (badKey !== null) return failField(badKey);
  for (const key of SOURCE_KEYS) {
    if (!Object.hasOwn(raw, key)) return failField(`"source" is missing "${key}"`);
  }
  const kind = raw.kind;
  if (typeof kind !== 'string' || !SOURCE_KIND_VALUES_SET.has(kind)) {
    return failField('"source.kind" is not one of the known source kinds');
  }
  const locator = raw.locator;
  if (typeof locator !== 'string' || locator === '') {
    return failField('"source.locator" must be a non-empty string');
  }
  if (kind === 'https') {
    if (!isHttpsUrl(locator)) {
      return failField('"source.locator" must be a valid https URL when kind is "https"');
    }
    // No query string or fragment: a receipt never carries a token or header
    // field (plan §1.4, "What a receipt never contains"), and a query string
    // is exactly where a third-party tool's own output tends to smuggle one.
    if (locator.includes('?') || locator.includes('#')) {
      return failField('"source.locator" must not carry a query string or fragment');
    }
  }
  const official = raw.official;
  if (typeof official !== 'boolean') return failField('"source.official" must be a boolean');
  const verifiedOn = raw.verifiedOn;
  if (typeof verifiedOn !== 'string' || !isRealDateString(verifiedOn)) {
    return failField('"source.verifiedOn" must be a real YYYY-MM-DD date');
  }
  return okField({
    kind: kind as ReceiptSource['kind'],
    locator,
    official,
    verifiedOn,
  });
}

function parseLicense(raw: unknown): FieldResult<ReceiptLicense> {
  if (!isPlainObject(raw)) return failField('"license" must be an object');
  const badKey = closedKeys(raw, LICENSE_KEYS_SET, '"license"');
  if (badKey !== null) return failField(badKey);
  const kind = raw.kind;
  if (typeof kind !== 'string' || !LICENSE_KIND_VALUES_SET.has(kind)) {
    return failField('"license.kind" must be "spdx" or "terms"');
  }
  if (kind === 'spdx') {
    if (Object.hasOwn(raw, 'url')) return failField('"license" of kind spdx must not carry "url"');
    const id = raw.id;
    if (typeof id !== 'string' || id === '')
      return failField('"license.id" must be a non-empty string');
    return okField({ kind: 'spdx', id });
  }
  if (Object.hasOwn(raw, 'id')) return failField('"license" of kind terms must not carry "id"');
  const url = raw.url;
  if (typeof url !== 'string' || !isHttpsUrl(url)) {
    return failField('"license.url" must be a valid https URL');
  }
  // Same reasoning as source.locator above: no query string or fragment.
  if (url.includes('?') || url.includes('#')) {
    return failField('"license.url" must not carry a query string or fragment');
  }
  return okField({ kind: 'terms', url });
}

function parseDeclared(raw: unknown): FieldResult<ReceiptDeclared> {
  if (!isPlainObject(raw)) return failField('"declared" must be an object');
  const badKey = closedKeys(raw, DECLARED_KEYS_SET, '"declared"');
  if (badKey !== null) return failField(badKey);
  if (!Object.hasOwn(raw, 'required')) return failField('"declared" is missing "required"');
  const required = raw.required;
  if (typeof required !== 'boolean') return failField('"declared.required" must be a boolean');
  if (!Object.hasOwn(raw, 'version')) return okField({ required });
  const version = raw.version;
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    return failField('"declared.version" does not match the version pin pattern');
  }
  return okField({ required, version });
}

function parseInstaller(raw: unknown): FieldResult<ReceiptInstaller> {
  if (!isPlainObject(raw)) return failField('"installer" must be an object');
  const badKey = closedKeys(raw, INSTALLER_KEYS_SET, '"installer"');
  if (badKey !== null) return failField(badKey);
  for (const key of INSTALLER_KEYS) {
    if (!Object.hasOwn(raw, key)) return failField(`"installer" is missing "${key}"`);
  }
  const tool = raw.tool;
  if (typeof tool !== 'string' || !SLUG_PATTERN.test(tool)) {
    return failField('"installer.tool" must be a lowercase slug');
  }
  const toolVersion = raw.toolVersion;
  if (typeof toolVersion !== 'string' || !VERSION_PATTERN.test(toolVersion)) {
    return failField('"installer.toolVersion" does not match the version pin pattern');
  }
  const exitCode = raw.exitCode;
  if (
    typeof exitCode !== 'number' ||
    !Number.isInteger(exitCode) ||
    exitCode < 0 ||
    exitCode > 255
  ) {
    return failField('"installer.exitCode" must be an integer between 0 and 255');
  }
  return okField({ tool, toolVersion, exitCode });
}

function parseEvidenceOrNotObserved(raw: unknown, label: string): FieldResult<string[]> {
  if (!Array.isArray(raw)) return failField(`"${label}" must be an array`);
  const items: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !SLUG_PATTERN.test(item)) {
      return failField(`"${label}" contains a value that is not a lowercase slug`);
    }
    items.push(item);
  }
  return okField(items);
}

function parseObservedAfter(raw: unknown): FieldResult<ReceiptObservedAfter> {
  if (!isPlainObject(raw)) return failField('"observedAfter" must be an object');
  const badKey = closedKeys(raw, OBSERVED_AFTER_KEYS_SET, '"observedAfter"');
  if (badKey !== null) return failField(badKey);
  if (!Object.hasOwn(raw, 'state')) return failField('"observedAfter" is missing "state"');
  const state = raw.state;
  if (typeof state !== 'string' || !INSTANCE_STATES_SET.has(state)) {
    return failField('"observedAfter.state" is not a known instance state');
  }
  if (!Object.hasOwn(raw, 'evidence')) return failField('"observedAfter" is missing "evidence"');
  const evidence = parseEvidenceOrNotObserved(raw.evidence, 'observedAfter.evidence');
  if (!evidence.ok) return evidence;

  const result: ReceiptObservedAfter = { state: state as InstanceState, evidence: evidence.value };
  if (Object.hasOwn(raw, 'version')) {
    const version = raw.version;
    if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
      return failField('"observedAfter.version" does not match the version pin pattern');
    }
    result.version = version;
  }
  if (Object.hasOwn(raw, 'digest')) {
    const digest = raw.digest;
    if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) {
      return failField('"observedAfter.digest" must be a lowercase hex digest');
    }
    result.digest = digest;
  }
  return okField(result);
}

function parseAct(raw: unknown, harness: string): FieldResult<ReceiptAct> {
  if (!isPlainObject(raw)) return failField(`acts["${harness}"] must be an object`);
  const badKey = closedKeys(raw, ACT_KEYS_SET, `acts["${harness}"]`);
  if (badKey !== null) return failField(badKey);

  const route = raw.route;
  if (typeof route !== 'string' || !ROUTE_VALUES_SET.has(route)) {
    return failField(`acts["${harness}"].route is not a known route`);
  }
  const automation = raw.automation;
  if (typeof automation !== 'string' || !AUTOMATION_VALUES_SET.has(automation)) {
    return failField(`acts["${harness}"].automation must be "automatic" or "guided"`);
  }
  const performedAt = raw.performedAt;
  if (typeof performedAt !== 'string' || !ISO_TIMESTAMP_PATTERN.test(performedAt)) {
    return failField(`acts["${harness}"].performedAt must be a UTC timestamp`);
  }
  if (!Object.hasOwn(raw, 'observedAfter')) {
    return failField(`acts["${harness}"] is missing "observedAfter"`);
  }
  const observedAfter = parseObservedAfter(raw.observedAfter);
  if (!observedAfter.ok) return observedAfter;
  if (!Object.hasOwn(raw, 'notObserved')) {
    return failField(`acts["${harness}"] is missing "notObserved"`);
  }
  const notObserved = parseEvidenceOrNotObserved(raw.notObserved, `acts["${harness}"].notObserved`);
  if (!notObserved.ok) return notObserved;

  const act: ReceiptAct = {
    route: route as Route,
    automation: automation as 'automatic' | 'guided',
    performedAt,
    observedAfter: observedAfter.value,
    notObserved: notObserved.value,
  };
  if (Object.hasOwn(raw, 'installer')) {
    const installer = parseInstaller(raw.installer);
    if (!installer.ok) return installer;
    act.installer = installer.value;
  }
  return okField(act);
}

function parseActs(raw: unknown): FieldResult<Receipt['acts']> {
  if (!isPlainObject(raw)) return failField('"acts" must be an object');
  const badKey = closedKeys(raw, HARNESS_VALUES_SET, '"acts"');
  if (badKey !== null) return failField(badKey);
  const keys = Object.keys(raw);
  if (keys.length === 0) return failField('"acts" must record at least one harness');

  const acts: Receipt['acts'] = {};
  for (const harness of keys) {
    const act = parseAct(raw[harness], harness);
    if (!act.ok) return act;
    acts[harness as Harness] = act.value;
  }
  return okField(acts);
}

/**
 * Parse a `.rig/receipts/<id>.json` file. TOTAL: no string input may make
 * this throw (see the fuzz test). Any problem — not JSON, too deep, a
 * control or Unicode-format character anywhere, more than 64 KiB, a root key
 * outside the closed set, a missing required field, or any field failing its
 * own shape check — voids the whole receipt: `{ status: 'invalid' }`. There
 * is no partial-acceptance mode here (unlike `parseDeclaration`'s
 * per-entry `rejected` list): a receipt describes exactly one integration,
 * so one bad field invalidates the one thing this file is for.
 */
export function parseReceipt(raw: string): ParseReceiptResult {
  if (new TextEncoder().encode(raw).byteLength > MAX_RECEIPT_BYTES) {
    return { status: 'invalid', error: 'the receipt is larger than 64 KiB' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'invalid', error: 'the receipt is not valid JSON' };
  }

  const scan = scanParsedValue(parsed);
  if (scan.tooDeep) {
    return {
      status: 'invalid',
      error: `the receipt nests deeper than ${MAX_RECEIPT_DEPTH} levels below its root`,
    };
  }
  if (scan.hasControlChar) {
    return { status: 'invalid', error: 'the receipt carries a control or format character' };
  }

  if (!isPlainObject(parsed)) {
    return { status: 'invalid', error: 'the receipt must be a JSON object' };
  }
  const root = parsed;

  const badRootKey = closedKeys(root, ROOT_KEYS_SET, 'the receipt');
  if (badRootKey !== null) return { status: 'invalid', error: badRootKey };
  for (const key of ROOT_KEYS) {
    if (!Object.hasOwn(root, key)) {
      return { status: 'invalid', error: `the receipt is missing "${key}"` };
    }
  }

  if (root.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    return { status: 'invalid', error: `"schemaVersion" must be ${RECEIPT_SCHEMA_VERSION}` };
  }

  const id = root.id;
  if (typeof id !== 'string' || !SLUG_PATTERN.test(id)) {
    return { status: 'invalid', error: '"id" must be a lowercase slug' };
  }

  const mode = root.mode;
  if (typeof mode !== 'string' || !MODE_VALUES_SET.has(mode)) {
    return { status: 'invalid', error: '"mode" is not one of the known modes' };
  }

  const source = parseSource(root.source);
  if (!source.ok) return { status: 'invalid', error: source.error };

  const license = parseLicense(root.license);
  if (!license.ok) return { status: 'invalid', error: license.error };

  const declared = parseDeclared(root.declared);
  if (!declared.ok) return { status: 'invalid', error: declared.error };

  const rigVersion = root.rigVersion;
  if (typeof rigVersion !== 'string' || !VERSION_PATTERN.test(rigVersion)) {
    return { status: 'invalid', error: '"rigVersion" does not match the version pin pattern' };
  }

  const acts = parseActs(root.acts);
  if (!acts.ok) return { status: 'invalid', error: acts.error };

  return {
    status: 'ok',
    receipt: {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      id,
      mode: mode as Mode,
      source: source.value,
      license: license.value,
      declared: declared.value,
      rigVersion,
      acts: acts.value,
    },
  };
}

function serializeAct(act: ReceiptAct): Record<string, unknown> {
  const body: Record<string, unknown> = {
    route: act.route,
    automation: act.automation,
    performedAt: act.performedAt,
  };
  if (act.installer !== undefined) body.installer = { ...act.installer };
  const observedAfter: Record<string, unknown> = { state: act.observedAfter.state };
  if (act.observedAfter.version !== undefined) observedAfter.version = act.observedAfter.version;
  if (act.observedAfter.digest !== undefined) observedAfter.digest = act.observedAfter.digest;
  observedAfter.evidence = [...act.observedAfter.evidence];
  body.observedAfter = observedAfter;
  body.notObserved = [...act.notObserved];
  return body;
}

/** Serialize a {@link Receipt} to its on-disk bytes: fixed key order, two-space indent, trailing newline. */
export function serializeReceipt(receipt: Receipt): string {
  const acts: Record<string, unknown> = {};
  for (const harness of HARNESS_VALUES) {
    const act = receipt.acts[harness];
    if (act !== undefined) acts[harness] = serializeAct(act);
  }
  const declared: Record<string, unknown> = { required: receipt.declared.required };
  if (receipt.declared.version !== undefined) declared.version = receipt.declared.version;

  const body = {
    schemaVersion: receipt.schemaVersion,
    id: receipt.id,
    mode: receipt.mode,
    source: { ...receipt.source },
    license: { ...receipt.license },
    declared,
    rigVersion: receipt.rigVersion,
    acts,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * The comparison form of a receipt used for the idempotent-write decision
 * (plan §1.4, "Idempotent bytes"): every act's `performedAt` is zeroed out,
 * so two receipts that differ ONLY in when an act was performed serialize to
 * the same bytes here. `serializeReceipt` above is unaffected — the real,
 * on-disk bytes always carry the true `performedAt`.
 */
export function serializeReceiptForComparison(receipt: Receipt): string {
  const withoutPerformedAt: Receipt = {
    ...receipt,
    acts: Object.fromEntries(
      Object.entries(receipt.acts).map(([harness, act]) => [
        harness,
        { ...(act as ReceiptAct), performedAt: '' },
      ]),
    ) as Receipt['acts'],
  };
  return serializeReceipt(withoutPerformedAt);
}

/**
 * Whether `next` differs from `previous` in any MATERIAL field — source,
 * version, digest, mode, route, state, or tool version (plan §1.4) — so the
 * caller knows whether to write `next` at all, or keep `previous` (and its
 * `performedAt`) unchanged on a no-op re-run. `previous === undefined` (no
 * receipt exists yet) is always a material change.
 */
export function hasMaterialChange(previous: Receipt | undefined, next: Receipt): boolean {
  if (previous === undefined) return true;
  return serializeReceiptForComparison(previous) !== serializeReceiptForComparison(next);
}
