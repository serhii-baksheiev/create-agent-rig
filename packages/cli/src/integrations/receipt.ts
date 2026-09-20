/**
 * `.rig/receipts/<id>.json`: the committed evidence record a route writes
 * after acting on a declared integration (RP-22, plan §1.4).
 *
 * A receipt is parsed exactly like `.rig/integrations.json`: committed,
 * therefore untrusted input, refused rather than silently trimmed on any
 * unrecognised shape. `parseReceipt` is TOTAL — no string input may make it
 * throw — using the same iterative, depth-bounded scan `declaration.ts` uses
 * (`scanForDepthAndControlChars`, shared from `../lib/safe-text.js` — RP-22 S2
 * gate finding: this used to be a private, duplicated copy). Pinned by
 * `packages/cli/test/integrations-receipt.test.ts` › "a fuzz list of hostile
 * shapes never makes parseReceipt throw".
 *
 * A receipt is never read as state (plan §1.4, "What makes a receipt
 * trustworthy", point 2): this module offers no function that turns a
 * receipt alone into an {@link InstanceState} — `./state.js`'s `classify`
 * takes a `ReceiptBaseline` only to compare against a *live* observation,
 * never to answer "is it installed" by itself.
 *
 * `source.locator` and `license.id` are validated against `registry.ts`'s
 * `isValidLocator`/`isValidSpdxExpression` — the SAME grammar a shipped
 * registry descriptor is held to (RP-22 gate cycle 1, blocker 1: these fields
 * previously accepted any non-empty string). Stated exactly, because gate
 * cycle 2 found the wider claim false: the grammar refuses an absolute or
 * traversal path, a drive letter, a backslash, a scheme, userinfo, and a
 * query string or fragment, and it caps length — it does NOT refuse every
 * token-shaped value. Under `source.kind` `npm`/`pypi`/`marketplace`, a
 * `ghp_`-style token is also a syntactically legal package/extension name, so
 * it parses (see `integrations-receipt.test.ts` › "the honest gap: a
 * PAT-shaped locator parses under the opaque kinds (npm, pypi, marketplace),
 * the same undecidable class as the other two gaps"). Catching that shape is
 * the pre-commit secret sweep's job, not this parser's: `findSecretValues` (used
 * as the oracle in this module's own tests) catches every DELIMITED token
 * shape it knows about in every one of this schema's string fields once the
 * receipt is serialized; the one shape no field here can ever refuse on its
 * own is a bare lowercase-hex string, because that is structurally
 * indistinguishable from a real digest or slug (see the same test file ›
 * "the honest gap: digest/evidence/notObserved cannot distinguish a
 * lowercase-hex-shaped secret from a real digest or slug, so they accept
 * one").
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
 * This module imports `../lib/safe-text.js` (the shared JSON-safety
 * primitives), `./registry.js` for the closed `Mode`/`Route`/`Harness`
 * vocabularies and the shared locator/SPDX/date grammar (one spelling of
 * each, not a second copy), `./declaration.js` for `VERSION_PATTERN` and
 * `truncateForMessage`, and `./state.js` for the closed `InstanceState`
 * vocabulary.
 */
import { isPlainObject, scanForDepthAndControlChars } from '../lib/safe-text.js';
import { truncateForMessage, VERSION_PATTERN } from './declaration.js';
import {
  isRealDateString,
  isValidLocator,
  isValidSpdxExpression,
  type Harness,
  type Mode,
  type Route,
} from './registry.js';
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

/**
 * A UTC timestamp with second precision, e.g. `2026-09-21T10:00:00Z`. This is
 * the SHAPE only — `9999-99-99T99:99:99Z` matches it. {@link isRealTimestampString}
 * is the actual parser-side check; this pattern is exported only because the
 * schema mirrors it (the schema subset cannot express the real-calendar
 * check `isRealDateString` performs, only the shape).
 */
export const ISO_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/**
 * A real UTC timestamp: a real calendar date (leap years included, no rolled-
 * over months) with hour/minute/second each in range. Deliberately NOT a
 * "not in the future" check — that would make `parseReceipt`'s answer depend
 * on the clock it runs on, which a pure, TOTAL parser must not do.
 */
function isRealTimestampString(value: string): boolean {
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return false;
  const [, datePart, hourText, minuteText, secondText] = match;
  if (!isRealDateString(datePart!)) return false;
  return Number(hourText) <= 23 && Number(minuteText) <= 59 && Number(secondText) <= 59;
}

/**
 * `evidence`/`notObserved` are short lists of tags, not open-ended logs — a
 * real probe names a handful of things it did or did not check. Capped so a
 * receipt cannot be inflated into an unbounded array of otherwise-valid slugs
 * (the schema subset has no `maxItems`, so this bound is parser-only).
 */
const MAX_EVIDENCE_ITEMS = 16;

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
  // The cast is narrowing, not asserting: `kind` already passed the
  // SOURCE_KIND_VALUES_SET membership check above, so it is one of
  // ReceiptSource['kind']'s five literals here.
  const knownKind = kind as ReceiptSource['kind'];
  // isValidLocator is the SAME grammar registry.ts holds a shipped descriptor
  // to (RP-22 gate cycle 1, blocker 1) — a github/npm/pypi/marketplace
  // locator can no longer be an arbitrary path, hostname, token, or blob of
  // third-party output; an https locator additionally may not carry a query
  // string or fragment, folded into the one shared function.
  if (typeof locator !== 'string' || !isValidLocator(knownKind, locator)) {
    return failField(`"source.locator" is not a valid locator for kind "${knownKind}"`);
  }
  const official = raw.official;
  if (typeof official !== 'boolean') return failField('"source.official" must be a boolean');
  const verifiedOn = raw.verifiedOn;
  if (typeof verifiedOn !== 'string' || !isRealDateString(verifiedOn)) {
    return failField('"source.verifiedOn" must be a real YYYY-MM-DD date');
  }
  return okField({
    kind: knownKind,
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
    // isValidSpdxExpression is the SAME grammar registry.ts holds a shipped
    // descriptor's license id to (RP-22 gate cycle 1, blocker 1).
    if (typeof id !== 'string' || !isValidSpdxExpression(id)) {
      return failField('"license.id" is not a bounded SPDX-expression-shaped string');
    }
    return okField({ kind: 'spdx', id });
  }
  if (Object.hasOwn(raw, 'id')) return failField('"license" of kind terms must not carry "id"');
  const url = raw.url;
  // isValidLocator('https', …) applies the same https-URL-with-no-query-or-
  // fragment rule this field always needed, now shared with source.locator's
  // https branch instead of duplicated.
  if (typeof url !== 'string' || !isValidLocator('https', url)) {
    return failField('"license.url" must be a valid https URL with no query string or fragment');
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
  if (raw.length > MAX_EVIDENCE_ITEMS) {
    return failField(`"${label}" has more than ${MAX_EVIDENCE_ITEMS} entries`);
  }
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

  // Narrowing, not asserting: `state` already passed the INSTANCE_STATES_SET
  // membership check above.
  const result: ReceiptObservedAfter = {
    state: state as InstanceState,
    evidence: evidence.value,
  };
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
  if (typeof performedAt !== 'string' || !isRealTimestampString(performedAt)) {
    return failField(`acts["${harness}"].performedAt must be a real UTC timestamp`);
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

  // Both casts narrow, not assert: `route`/`automation` already passed their
  // membership checks above.
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
    // Narrowing, not asserting: `keys` came from `raw` after `closedKeys`
    // already refused any key outside HARNESS_VALUES_SET.
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

  const scan = scanForDepthAndControlChars(parsed, MAX_RECEIPT_DEPTH);
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
      // Narrowing, not asserting: `mode` already passed MODE_VALUES_SET above.
      mode: mode as Mode,
      source: source.value,
      license: license.value,
      declared: declared.value,
      rigVersion,
      acts: acts.value,
    },
  };
}

/**
 * Every nested object below is built FIELD BY FIELD, in a fixed order — never
 * `{ ...someParsedObject }` — so the output key order depends only on THIS
 * function, never on the order a caller happened to build (or a raw JSON
 * document happened to list) its input fields in (RP-22 gate cycle 1,
 * blocker 3: two receipts differing only in input key order used to
 * serialize to different bytes, because spreading a nested object here
 * copied whatever order it already had rather than re-fixing one).
 */
function serializeSource(source: ReceiptSource): Record<string, unknown> {
  return {
    kind: source.kind,
    locator: source.locator,
    official: source.official,
    verifiedOn: source.verifiedOn,
  };
}

function serializeLicense(license: ReceiptLicense): Record<string, unknown> {
  return license.kind === 'spdx'
    ? { kind: 'spdx', id: license.id }
    : { kind: 'terms', url: license.url };
}

function serializeInstaller(installer: ReceiptInstaller): Record<string, unknown> {
  return { tool: installer.tool, toolVersion: installer.toolVersion, exitCode: installer.exitCode };
}

function serializeObservedAfter(observedAfter: ReceiptObservedAfter): Record<string, unknown> {
  const body: Record<string, unknown> = { state: observedAfter.state };
  if (observedAfter.version !== undefined) body.version = observedAfter.version;
  if (observedAfter.digest !== undefined) body.digest = observedAfter.digest;
  body.evidence = [...observedAfter.evidence];
  return body;
}

function serializeAct(act: ReceiptAct): Record<string, unknown> {
  const body: Record<string, unknown> = {
    route: act.route,
    automation: act.automation,
    performedAt: act.performedAt,
  };
  if (act.installer !== undefined) body.installer = serializeInstaller(act.installer);
  body.observedAfter = serializeObservedAfter(act.observedAfter);
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
    source: serializeSource(receipt.source),
    license: serializeLicense(receipt.license),
    declared,
    rigVersion: receipt.rigVersion,
    acts,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * The comparison form of a receipt used ONLY by the
 * "differs only in performedAt" property below — every act's `performedAt`
 * is zeroed out, so two receipts differing ONLY in when an act was performed
 * serialize to the same bytes here. `serializeReceipt` above is unaffected —
 * the real, on-disk bytes always carry the true `performedAt`.
 *
 * NOT used by {@link hasMaterialChange}: that function has its own, narrower
 * notion of "differs" (plan §1.4's seven named fields), which this function's
 * "everything except performedAt" is not the same claim as (RP-22 gate cycle
 * 1, blocker 5 — the two used to be conflated).
 */
export function serializeReceiptForComparison(receipt: Receipt): string {
  const acts: Receipt['acts'] = {};
  for (const harness of HARNESS_VALUES) {
    const act = receipt.acts[harness];
    if (act !== undefined) acts[harness] = { ...act, performedAt: '' };
  }
  return serializeReceipt({ ...receipt, acts });
}

/** The plan §1.4 material fields, projected from one harness's act. */
type MaterialAct = {
  route: Route;
  toolVersion: string | undefined;
  state: InstanceState;
  version: string | undefined;
  digest: string | undefined;
};

/**
 * The plan §1.4 material fields, and NOTHING else: `source` (whole object),
 * `mode`, and per act `route`, `installer.toolVersion` ("tool version"), and
 * `observedAfter`'s own `state`/`version`/`digest` triple. Everything else on
 * a {@link Receipt} is explicitly NOT projected here, so a change to any of
 * THOSE fields alone can never flip {@link hasMaterialChange} — and each one
 * left out has a named consequence, not just an omission:
 *
 * - `id`, `rigVersion` — a receipt can go on recording the rig version that
 *   performed the act long after a newer release runs again over an
 *   unchanged install; the field goes stale until something else forces a
 *   rewrite.
 * - `declared` (the pin recorded at act time) — a re-run after the
 *   DECLARATION changes, with the install itself unchanged, keeps the old
 *   declared copy in the receipt rather than refreshing it.
 * - `license` — considered and left out on purpose: it is provenance about
 *   the source's legal terms, not a fact about whether the integration is
 *   installed, matches, or drifted. A receipt can carry a stale license
 *   record indefinitely. If a future slice finds a reason license changes
 *   should force a rewrite, that is a new decision to write down here, not
 *   an oversight to quietly fix.
 * - an act's `automation` — a route that changes from guided to automatic
 *   (or back) between runs leaves the OLD automation value on record.
 * - `installer.tool`/`exitCode` — a different installer tool, or a
 *   different exit code from the same tool, is not itself a reason to
 *   rewrite; only a `toolVersion` change is.
 * - `evidence`/`notObserved` — their CONTENT can change (a probe names a
 *   different set of things it checked) with the receipt's evidence list
 *   left describing an earlier run, as long as `state`/`version`/`digest`
 *   agree.
 * - every act's `performedAt` — see {@link serializeReceiptForComparison}.
 *
 * `source` is built through {@link serializeSource} — the SAME field-by-field
 * builder `serializeReceipt` uses — rather than spread (`{ ...receipt.source
 * }`), so two receipts differing only in `source`'s OWN input key order
 * project identically here too (RP-22 gate cycle 2, blocker 2: a spread
 * copies whatever order the input object already had, which is exactly the
 * order-dependence `serializeReceipt`'s own nested objects were fixed to not
 * have in gate cycle 1).
 */
function materialProjection(receipt: Receipt): {
  mode: Mode;
  source: Record<string, unknown>;
  acts: Partial<Record<Harness, MaterialAct>>;
} {
  const acts: Partial<Record<Harness, MaterialAct>> = {};
  for (const harness of HARNESS_VALUES) {
    const act = receipt.acts[harness];
    if (act === undefined) continue;
    acts[harness] = {
      route: act.route,
      toolVersion: act.installer?.toolVersion,
      state: act.observedAfter.state,
      version: act.observedAfter.version,
      digest: act.observedAfter.digest,
    };
  }
  return { mode: receipt.mode, source: serializeSource(receipt.source), acts };
}

/**
 * Whether `next` differs from `previous` in any MATERIAL field — exactly
 * {@link materialProjection}'s projection, which is plan §1.4's own list
 * (source, version, digest, mode, route, state, tool version) and nothing
 * more — so the caller knows whether to write `next` at all, or keep
 * `previous` (and its `performedAt`, `rigVersion`, `evidence`/`notObserved`
 * content, etc.) unchanged on a no-op re-run. `previous === undefined` (no
 * receipt exists yet) is always a material change.
 */
export function hasMaterialChange(previous: Receipt | undefined, next: Receipt): boolean {
  if (previous === undefined) return true;
  return JSON.stringify(materialProjection(previous)) !== JSON.stringify(materialProjection(next));
}
