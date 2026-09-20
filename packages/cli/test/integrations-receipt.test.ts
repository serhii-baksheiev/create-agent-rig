import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACT_KEYS,
  AUTOMATION_VALUES,
  LICENSE_KIND_VALUES,
  MODE_VALUES,
  RECEIPTS_DIR_REL,
  RECEIPT_SCHEMA_VERSION,
  ROOT_KEYS,
  ROUTE_VALUES,
  SOURCE_KIND_VALUES,
  hasMaterialChange,
  parseReceipt,
  serializeReceipt,
  serializeReceiptForComparison,
  type Receipt,
} from '../src/integrations/receipt.js';
import { SPDX_EXPRESSION_PATTERN, isValidLocator } from '../src/integrations/registry.js';
import { INSTANCE_STATES } from '../src/integrations/state.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const schemaSubsetPath = path.join(repoRoot, 'scripts', 'lib', 'json-schema-subset.mjs');
const secretsLibPath = path.join(repoRoot, '.claude', 'scripts', 'lib', 'secrets.mjs');

interface ValidationResult {
  ok: boolean;
  errors: string[];
}
type Validate = (schema: unknown, value: unknown) => ValidationResult;

const loadValidate = async (): Promise<Validate> =>
  ((await import(pathToFileURL(schemaSubsetPath).href)) as { validate: Validate }).validate;

type FindSecretValues = (text: string) => { id: string; line: number }[];

const loadFindSecretValues = async (): Promise<FindSecretValues> =>
  (
    (await import(pathToFileURL(secretsLibPath).href)) as {
      findSecretValues: FindSecretValues;
    }
  ).findSecretValues;

const loadSchema = async (): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(
      path.join(repoRoot, 'contracts', 'integrations', 'v1', 'receipt.schema.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;

// The documented example (plan §1.4 / this slice's brief), adapted for this
// parser's version/digest convention: an absent field, never an explicit
// `null` — see receipt.ts's header for why the schema-subset validator forces
// that choice. Deliberately asymmetric (only claude-code carries an
// installer) to match the brief's own example — a guided step often has none.
function validReceiptValue(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'figma-mcp',
    mode: 'hosted-service',
    source: {
      kind: 'https',
      locator: 'https://mcp.figma.com/mcp',
      official: true,
      verifiedOn: '2026-09-21',
    },
    license: { kind: 'terms', url: 'https://mcp.figma.com/terms' },
    declared: { required: false },
    rigVersion: '0.10.0',
    acts: {
      'claude-code': {
        route: 'mcp-config',
        automation: 'automatic',
        performedAt: '2026-09-21T10:00:00Z',
        installer: { tool: 'claude', toolVersion: '2.1.278', exitCode: 0 },
        observedAfter: { state: 'installed', evidence: ['mcp-json-entry'] },
        notObserved: ['authorization', 'connectivity', 'project-approval'],
      },
      codex: {
        route: 'guided-manual',
        automation: 'guided',
        performedAt: '2026-09-21T10:00:00Z',
        observedAfter: { state: 'pending-user-action', evidence: [] },
        notObserved: ['everything'],
      },
    },
  };
}

const validReceiptRaw = (): string => JSON.stringify(validReceiptValue());

/** Like {@link validReceiptValue}, but BOTH acts carry an installer — used only where a fixture needs to mutate an installer field on either harness. */
function fullyPopulatedReceiptValue(): Record<string, unknown> {
  const value = validReceiptValue();
  const acts = value.acts as Record<string, Record<string, unknown>>;
  acts.codex!.installer = { tool: 'codex', toolVersion: '1.0.0', exitCode: 0 };
  return value;
}

type ActsMap = Record<string, Record<string, unknown>>;
const actsOf = (value: Record<string, unknown>): ActsMap => value.acts as ActsMap;

describe('parseReceipt — acceptance', () => {
  it('accepts the documented example (adapted: absent, not null, for unset version/digest)', () => {
    const result = parseReceipt(validReceiptRaw());
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.receipt.id).toBe('figma-mcp');
      expect(result.receipt.acts['claude-code']?.route).toBe('mcp-config');
      expect(result.receipt.acts.codex?.observedAfter.state).toBe('pending-user-action');
    }
  });

  it('accepts an act with no installer at all (a guided step often has none)', () => {
    const result = parseReceipt(validReceiptRaw());
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.receipt.acts.codex?.installer).toBeUndefined();
  });
});

describe('source.locator: a per-kind grammar, not "any non-empty string" (RP-22 gate cycle 1, blocker 1)', () => {
  const withSource = (kind: string, locator: string): string => {
    const value = validReceiptValue();
    value.source = { kind, locator, official: true, verifiedOn: '2026-09-21' };
    return JSON.stringify(value);
  };
  const errorFor = (kind: string) => `"source.locator" is not a valid locator for kind "${kind}"`;

  it.each([
    ['github', 'serhii-baksheiev/create-agent-rig'],
    ['npm', '@rig/cli'],
    ['npm', 'left-pad'],
    ['pypi', 'requests'],
    ['marketplace', 'some-extension'],
    ['https', 'https://mcp.figma.com/mcp'],
  ])('accepts a legal %s locator (%s)', (kind, locator) => {
    const result = parseReceipt(withSource(kind, locator));
    expect(result.status).toBe('ok');
  });

  it.each([
    ['github', '/etc/passwd', 'an absolute unix path'],
    ['github', 'C:\\Users\\evil\\tool.exe', 'a Windows absolute path'],
    ['github', 'owner/..', 'a parent-traversal repo segment'],
    ['npm', 'user@host', 'userinfo-shaped text'],
    ['npm', 'C:\\Users\\evil', 'a Windows path'],
    ['pypi', 'a/b', 'a value containing a slash'],
    ['pypi', 'user@host', 'userinfo-shaped text'],
    ['marketplace', 'user@host', 'userinfo-shaped text'],
    ['https', 'file:///etc/passwd', 'a file:// scheme'],
    ['https', 'https://mcp.figma.com/mcp?token=x', 'a query string'],
  ])('refuses a hostile %s locator (%s: %s)', (kind, locator) => {
    const result = parseReceipt(withSource(kind, locator));
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.error).toBe(errorFor(kind));
  });

  it('refuses a secret-shaped github locator that re-serializes to bytes findSecretValues flags — a GitHub PAT never parses', async () => {
    const findSecretValues = await loadFindSecretValues();
    // Assembled at runtime, per this repository's fixture rule.
    const secretShapedToken = [
      'ghp_',
      ...Array.from(
        { length: 36 },
        (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(i * 7 + 3) % 36],
      ),
    ].join('');
    expect(findSecretValues(`token: ${secretShapedToken}`).length).toBeGreaterThan(0); // sanity: this really is detected as a secret
    const result = parseReceipt(withSource('github', secretShapedToken));
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.error).toBe(errorFor('github'));
  });
});

describe('license: id (spdx) and url (terms) grammars', () => {
  const withLicense = (license: unknown): string => {
    const value = validReceiptValue();
    value.license = license;
    return JSON.stringify(value);
  };

  it.each([['MIT'], ['Apache-2.0'], ['MIT OR Apache-2.0']])('accepts spdx id %s', (id) => {
    expect(parseReceipt(withLicense({ kind: 'spdx', id })).status).toBe('ok');
  });

  it.each([
    ['empty string', ''],
    ['longer than the 64-character cap', 'A'.repeat(65)],
    ['a lowercase operator', 'MIT or Apache-2.0'],
    ['a control character', 'MIT\u0007'],
  ])('refuses spdx id that is %s', (_label, id) => {
    const result = parseReceipt(withLicense({ kind: 'spdx', id }));
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid' && _label !== 'a control character') {
      expect(result.error).toBe('"license.id" is not a bounded SPDX-expression-shaped string');
    }
  });

  it('refuses a terms url carrying a query string', () => {
    const result = parseReceipt(
      withLicense({ kind: 'terms', url: 'https://mcp.figma.com/terms?x=1' }),
    );
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.error).toBe(
        '"license.url" must be a valid https URL with no query string or fragment',
      );
    }
  });

  it('refuses a terms url that is not https at all', () => {
    const result = parseReceipt(withLicense({ kind: 'terms', url: 'http://mcp.figma.com/terms' }));
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.error).toBe(
        '"license.url" must be a valid https URL with no query string or fragment',
      );
    }
  });
});

describe('performedAt must be a REAL UTC timestamp, not just shape (advisory)', () => {
  it('refuses 9999-99-99T99:99:99Z, which matches the shape pattern but not a real calendar/clock value', () => {
    const value = validReceiptValue();
    actsOf(value)['claude-code']!.performedAt = '9999-99-99T99:99:99Z';
    const result = parseReceipt(JSON.stringify(value));
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.error).toBe('acts["claude-code"].performedAt must be a real UTC timestamp');
    }
  });

  it('refuses an hour of 24 (shape-valid, clock-invalid)', () => {
    const value = validReceiptValue();
    actsOf(value)['claude-code']!.performedAt = '2026-09-21T24:00:00Z';
    expect(parseReceipt(JSON.stringify(value)).status).toBe('invalid');
  });

  it('accepts the boundary 23:59:59', () => {
    const value = validReceiptValue();
    actsOf(value)['claude-code']!.performedAt = '2026-09-21T23:59:59Z';
    expect(parseReceipt(JSON.stringify(value)).status).toBe('ok');
  });

  it('never rejects on being "in the future" — this is a shape/calendar check, never a clock read', () => {
    const value = validReceiptValue();
    actsOf(value)['claude-code']!.performedAt = '2099-01-01T00:00:00Z';
    expect(parseReceipt(JSON.stringify(value)).status).toBe('ok');
  });
});

describe('evidence/notObserved are capped in length (advisory)', () => {
  it('refuses more than 16 entries', () => {
    const value = validReceiptValue();
    actsOf(value)['claude-code']!.observedAfter = {
      state: 'installed',
      evidence: Array.from({ length: 17 }, (_, i) => `tag-${i}`),
    };
    const result = parseReceipt(JSON.stringify(value));
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.error).toBe('"observedAfter.evidence" has more than 16 entries');
    }
  });

  it('accepts exactly 16 entries', () => {
    const value = validReceiptValue();
    actsOf(value)['claude-code']!.observedAfter = {
      state: 'installed',
      evidence: Array.from({ length: 16 }, (_, i) => `tag-${i}`),
    };
    expect(parseReceipt(JSON.stringify(value)).status).toBe('ok');
  });
});

describe('parseReceipt — refuses a control character, an absolute path, or an unknown top-level act key', () => {
  it('refuses a control character anywhere in the JSON', () => {
    const value = validReceiptValue();
    (value as { rigVersion: string }).rigVersion = '0.10.0\u0007';
    const result = parseReceipt(JSON.stringify(value));
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.error).toBe('the receipt carries a control or format character');
    }
  });

  // RP-22 gate cycle 3, cheap survivor (c): a control character can only
  // ever land in a KEY that is also, on its own, unrecognised — no known key
  // in this schema contains one. The two checks therefore both refuse this
  // fixture, but the DEPTH+CONTROL SCAN runs first (before any closedKeys
  // call), so its message is the one this test pins; deleting the scan
  // alone (leaving closedKeys in place) turns this specific message into
  // "... has an unrecognised key ...", which is exactly how the mutation
  // table's "depth+control scan" row is killed by this fixture rather than
  // by the rigVersion one above alone.
  it('refuses a control character inside a KEY name specifically, ahead of the unrecognised-key check', () => {
    const value = validReceiptValue();
    const source = value.source as Record<string, unknown>;
    delete source.official;
    source['official\u0007'] = true;
    const result = parseReceipt(JSON.stringify(value));
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.error).toBe('the receipt carries a control or format character');
    }
  });

  it.each([
    ['installer.tool', '/etc/passwd'],
    ['installer.tool', 'C:\\Users\\evil\\tool.exe'],
  ])(
    "refuses an absolute path (%s: %s) — it fails the field's own closed pattern",
    (_field, path_) => {
      const value = validReceiptValue();
      actsOf(value)['claude-code']!.installer = { tool: path_, toolVersion: '1.0.0', exitCode: 0 };
      const result = parseReceipt(JSON.stringify(value));
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.error).toBe('"installer.tool" must be a lowercase slug');
      }
    },
  );

  it('refuses an unknown key inside an act object', () => {
    const value = validReceiptValue();
    actsOf(value)['claude-code']!.bogusField = true;
    const result = parseReceipt(JSON.stringify(value));
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.error).toBe('acts["claude-code"] has an unrecognised key "bogusField"');
    }
  });

  it('refuses an unknown top-level receipt key', () => {
    const value = validReceiptValue();
    (value as Record<string, unknown>).command = 'rm -rf /';
    const result = parseReceipt(JSON.stringify(value));
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.error).toBe('the receipt has an unrecognised key "command"');
    }
  });

  it('refuses a harness key inside acts outside {claude-code, codex}', () => {
    const value = validReceiptValue();
    const acts = actsOf(value);
    acts.windsurf = acts['claude-code']!;
    const result = parseReceipt(JSON.stringify(value));
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.error).toBe('"acts" has an unrecognised key "windsurf"');
    }
  });
});

describe('serializeReceipt — literal bytes (fixed key order, two-space indent, trailing newline, at every level)', () => {
  it('serializes the fully populated example to exactly these bytes', () => {
    const parsed = parseReceipt(JSON.stringify(fullyPopulatedReceiptValue()));
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    const expected =
      '{\n' +
      '  "schemaVersion": 1,\n' +
      '  "id": "figma-mcp",\n' +
      '  "mode": "hosted-service",\n' +
      '  "source": {\n' +
      '    "kind": "https",\n' +
      '    "locator": "https://mcp.figma.com/mcp",\n' +
      '    "official": true,\n' +
      '    "verifiedOn": "2026-09-21"\n' +
      '  },\n' +
      '  "license": {\n' +
      '    "kind": "terms",\n' +
      '    "url": "https://mcp.figma.com/terms"\n' +
      '  },\n' +
      '  "declared": {\n' +
      '    "required": false\n' +
      '  },\n' +
      '  "rigVersion": "0.10.0",\n' +
      '  "acts": {\n' +
      '    "claude-code": {\n' +
      '      "route": "mcp-config",\n' +
      '      "automation": "automatic",\n' +
      '      "performedAt": "2026-09-21T10:00:00Z",\n' +
      '      "installer": {\n' +
      '        "tool": "claude",\n' +
      '        "toolVersion": "2.1.278",\n' +
      '        "exitCode": 0\n' +
      '      },\n' +
      '      "observedAfter": {\n' +
      '        "state": "installed",\n' +
      '        "evidence": [\n' +
      '          "mcp-json-entry"\n' +
      '        ]\n' +
      '      },\n' +
      '      "notObserved": [\n' +
      '        "authorization",\n' +
      '        "connectivity",\n' +
      '        "project-approval"\n' +
      '      ]\n' +
      '    },\n' +
      '    "codex": {\n' +
      '      "route": "guided-manual",\n' +
      '      "automation": "guided",\n' +
      '      "performedAt": "2026-09-21T10:00:00Z",\n' +
      '      "installer": {\n' +
      '        "tool": "codex",\n' +
      '        "toolVersion": "1.0.0",\n' +
      '        "exitCode": 0\n' +
      '      },\n' +
      '      "observedAfter": {\n' +
      '        "state": "pending-user-action",\n' +
      '        "evidence": []\n' +
      '      },\n' +
      '      "notObserved": [\n' +
      '        "everything"\n' +
      '      ]\n' +
      '    }\n' +
      '  }\n' +
      '}\n';
    expect(serializeReceipt(parsed.receipt)).toBe(expected);
  });

  it('parse ∘ serialize is stable', () => {
    const parsed = parseReceipt(validReceiptRaw());
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    const serialized = serializeReceipt(parsed.receipt);
    expect(parseReceipt(serialized)).toEqual(parsed);
  });

  it('serializes an spdx-licensed receipt to exactly {kind, id} key order (RP-22 gate cycle 2, advisory (f) — the only fixture using kind: "spdx" through the literal-bytes path)', () => {
    const value = validReceiptValue();
    value.license = { kind: 'spdx', id: 'MIT' };
    const parsed = parseReceipt(JSON.stringify(value));
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    expect(serializeReceipt(parsed.receipt)).toContain(
      '  "license": {\n    "kind": "spdx",\n    "id": "MIT"\n  },\n',
    );
  });
});

describe('serializeReceipt / serializeReceiptForComparison are input-key-order-invariant (RP-22 gate cycle 1, blocker 3)', () => {
  it('two RAW JSON texts differing only in field order within source/license/installer/observedAfter parse and serialize identically', () => {
    const canonical = fullyPopulatedReceiptValue();
    const reordered = JSON.parse(JSON.stringify(canonical)) as Record<string, unknown>;
    reordered.source = {
      verifiedOn: '2026-09-21',
      official: true,
      locator: 'https://mcp.figma.com/mcp',
      kind: 'https',
    };
    reordered.license = { url: 'https://mcp.figma.com/terms', kind: 'terms' };
    const reorderedActs = actsOf(reordered);
    reorderedActs['claude-code'] = {
      notObserved: ['authorization', 'connectivity', 'project-approval'],
      observedAfter: { evidence: ['mcp-json-entry'], state: 'installed' },
      installer: { exitCode: 0, toolVersion: '2.1.278', tool: 'claude' },
      performedAt: '2026-09-21T10:00:00Z',
      automation: 'automatic',
      route: 'mcp-config',
    };

    const parsedCanonical = parseReceipt(JSON.stringify(canonical));
    const parsedReordered = parseReceipt(JSON.stringify(reordered));
    expect(parsedCanonical.status).toBe('ok');
    expect(parsedReordered.status).toBe('ok');
    if (parsedCanonical.status !== 'ok' || parsedReordered.status !== 'ok') return;

    expect(serializeReceipt(parsedReordered.receipt)).toBe(
      serializeReceipt(parsedCanonical.receipt),
    );
    expect(hasMaterialChange(parsedCanonical.receipt, parsedReordered.receipt)).toBe(false);
  });

  it('a hand-built Receipt value whose nested objects were constructed in a different field order serializes identically to the canonical order, and hasMaterialChange agrees in both argument orders', () => {
    // RP-22 gate cycle 3, blocker: this is the ONLY test that can catch
    // `materialProjection` reverting to `source: { ...receipt.source }` —
    // the sibling test above feeds both receipts through `parseReceipt`
    // first, which already normalises key order regardless of what
    // `materialProjection` does with it, so its own `hasMaterialChange`
    // assertion cannot fail on this. This test hand-builds a `Receipt`
    // value directly (never through `parseReceipt`), so the fields really
    // do carry a different in-memory key order, on `source` AND on one
    // act's `installer`/`observedAfter`, and asserts `hasMaterialChange`
    // itself — not just `serializeReceipt` — is blind to that order, in
    // BOTH argument orders.
    const parsed = parseReceipt(validReceiptRaw());
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    const reorderedSource: Receipt['source'] = {
      verifiedOn: parsed.receipt.source.verifiedOn,
      official: parsed.receipt.source.official,
      locator: parsed.receipt.source.locator,
      kind: parsed.receipt.source.kind,
    };
    const canonicalAct = parsed.receipt.acts['claude-code'] as NonNullable<
      Receipt['acts']['claude-code']
    >;
    const reorderedAct: Receipt['acts']['claude-code'] = {
      ...canonicalAct,
      installer: canonicalAct.installer
        ? {
            exitCode: canonicalAct.installer.exitCode,
            toolVersion: canonicalAct.installer.toolVersion,
            tool: canonicalAct.installer.tool,
          }
        : undefined,
      observedAfter: {
        evidence: [...canonicalAct.observedAfter.evidence],
        digest: canonicalAct.observedAfter.digest,
        version: canonicalAct.observedAfter.version,
        state: canonicalAct.observedAfter.state,
      },
    };
    const reordered: Receipt = {
      ...parsed.receipt,
      source: reorderedSource,
      acts: { ...parsed.receipt.acts, 'claude-code': reorderedAct },
    };
    expect(serializeReceipt(reordered)).toBe(serializeReceipt(parsed.receipt));
    expect(hasMaterialChange(parsed.receipt, reordered)).toBe(false);
    expect(hasMaterialChange(reordered, parsed.receipt)).toBe(false);
  });
});

describe('serializeReceiptForComparison — serializes byte-identically when only performedAt would differ', () => {
  it("two receipts differing only in one act's performedAt compare byte-identically", () => {
    const parsedA = parseReceipt(validReceiptRaw());
    expect(parsedA.status).toBe('ok');
    if (parsedA.status !== 'ok') return;
    const receiptB: Receipt = {
      ...parsedA.receipt,
      acts: {
        ...parsedA.receipt.acts,
        'claude-code': {
          ...(parsedA.receipt.acts['claude-code'] as NonNullable<Receipt['acts']['claude-code']>),
          performedAt: '2099-01-01T00:00:00Z',
        },
      },
    };

    expect(serializeReceiptForComparison(receiptB)).toBe(
      serializeReceiptForComparison(parsedA.receipt),
    );
    // Sanity: the real, on-disk serializer is NOT blind to performedAt.
    expect(serializeReceipt(receiptB)).not.toBe(serializeReceipt(parsedA.receipt));
  });
});

type MaterialCase = { name: string; mutate: (r: Receipt) => Receipt; material: boolean };

const claudeAct = (r: Receipt) =>
  r.acts['claude-code'] as NonNullable<Receipt['acts']['claude-code']>;

// A hand-written literal table — one row per field this module's docstring
// names as material or explicitly not material. Never produced by calling
// `hasMaterialChange` itself.
const MATERIAL_TABLE: readonly MaterialCase[] = [
  {
    name: 'performedAt alone: NOT material',
    mutate: (r) => ({
      ...r,
      acts: { ...r.acts, 'claude-code': { ...claudeAct(r), performedAt: '2099-01-01T00:00:00Z' } },
    }),
    material: false,
  },
  {
    name: 'rigVersion alone: NOT material',
    mutate: (r) => ({ ...r, rigVersion: '9.9.9' }),
    material: false,
  },
  {
    name: 'declared.version alone: NOT material',
    mutate: (r) => ({ ...r, declared: { ...r.declared, version: '9.9.9' } }),
    material: false,
  },
  {
    name: 'license content alone: NOT material',
    mutate: (r) => ({ ...r, license: { kind: 'spdx', id: 'MIT' } }),
    material: false,
  },
  {
    name: "id alone: NOT material (hasMaterialChange never sees a different receipt's id in practice, but the projection excludes it regardless)",
    mutate: (r) => ({ ...r, id: 'a-different-id' }),
    material: false,
  },
  {
    name: 'automation alone: NOT material',
    mutate: (r) => ({
      ...r,
      acts: { ...r.acts, 'claude-code': { ...claudeAct(r), automation: 'guided' } },
    }),
    material: false,
  },
  {
    name: 'installer.tool (name, not version) alone: NOT material',
    mutate: (r) => ({
      ...r,
      acts: {
        ...r.acts,
        'claude-code': {
          ...claudeAct(r),
          installer: { ...claudeAct(r).installer!, tool: 'a-different-tool' },
        },
      },
    }),
    material: false,
  },
  {
    name: 'installer.exitCode alone: NOT material',
    mutate: (r) => ({
      ...r,
      acts: {
        ...r.acts,
        'claude-code': {
          ...claudeAct(r),
          installer: { ...claudeAct(r).installer!, exitCode: 1 },
        },
      },
    }),
    material: false,
  },
  {
    name: 'evidence content alone: NOT material',
    mutate: (r) => ({
      ...r,
      acts: {
        ...r.acts,
        'claude-code': {
          ...claudeAct(r),
          observedAfter: { ...claudeAct(r).observedAfter, evidence: ['a-different-tag'] },
        },
      },
    }),
    material: false,
  },
  {
    name: 'notObserved content alone: NOT material',
    mutate: (r) => ({
      ...r,
      acts: { ...r.acts, 'claude-code': { ...claudeAct(r), notObserved: ['everything'] } },
    }),
    material: false,
  },
  {
    name: 'mode alone: material',
    mutate: (r) => ({ ...r, mode: 'external-installer' }),
    material: true,
  },
  {
    name: 'source.locator alone: material',
    mutate: (r) => ({
      ...r,
      source: { ...r.source, locator: 'https://a-different-host.example/mcp' },
    }),
    material: true,
  },
  {
    name: 'route alone: material',
    mutate: (r) => ({
      ...r,
      acts: { ...r.acts, 'claude-code': { ...claudeAct(r), route: 'guided-manual' } },
    }),
    material: true,
  },
  {
    name: 'installer.toolVersion ("tool version") alone: material',
    mutate: (r) => ({
      ...r,
      acts: {
        ...r.acts,
        'claude-code': {
          ...claudeAct(r),
          installer: { ...claudeAct(r).installer!, toolVersion: '9.9.9' },
        },
      },
    }),
    material: true,
  },
  {
    name: 'observedAfter.state alone: material',
    mutate: (r) => ({
      ...r,
      acts: {
        ...r.acts,
        'claude-code': {
          ...claudeAct(r),
          observedAfter: { ...claudeAct(r).observedAfter, state: 'drifted' },
        },
      },
    }),
    material: true,
  },
  {
    name: 'observedAfter.version alone: material',
    mutate: (r) => ({
      ...r,
      acts: {
        ...r.acts,
        'claude-code': {
          ...claudeAct(r),
          observedAfter: { ...claudeAct(r).observedAfter, version: '9.9.9' },
        },
      },
    }),
    material: true,
  },
  {
    name: 'observedAfter.digest alone: material',
    mutate: (r) => ({
      ...r,
      acts: {
        ...r.acts,
        'claude-code': {
          ...claudeAct(r),
          observedAfter: { ...claudeAct(r).observedAfter, digest: 'deadbee' },
        },
      },
    }),
    material: true,
  },
];

describe('hasMaterialChange — the docstring and the behaviour are the same seven fields (RP-22 gate cycle 1, blocker 5)', () => {
  it('is true when there is no previous receipt', () => {
    const parsed = parseReceipt(validReceiptRaw());
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    expect(hasMaterialChange(undefined, parsed.receipt)).toBe(true);
  });

  it.each(MATERIAL_TABLE)('$name', ({ mutate, material }) => {
    const parsed = parseReceipt(validReceiptRaw());
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    const next = mutate(parsed.receipt);
    expect(hasMaterialChange(parsed.receipt, next)).toBe(material);
  });
});

describe('a receipt built from secret-shaped third-party output', () => {
  // Assembled at runtime, per this repository's fixture rule.
  const secretShapedToken = [
    'ghp_',
    ...Array.from(
      { length: 36 },
      (_, index) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(index * 7 + 3) % 36],
    ),
  ].join('');
  // Also assembled at runtime: a token whose ENTIRE content is lowercase hex,
  // 40 characters — the honest ambiguous case named below.
  const hexLookalikeSecret = Array.from(
    { length: 40 },
    (_, index) => '0123456789abcdef'[(index * 13 + 5) % 16],
  ).join('');

  type PatternField = { path: readonly string[]; isArray: boolean };

  function listPatternedFields(schema: unknown, prefix: readonly string[] = []): PatternField[] {
    const results: PatternField[] = [];
    if (typeof schema !== 'object' || schema === null) return results;
    const node = schema as Record<string, unknown>;
    if (node.type === 'string' && typeof node.pattern === 'string') {
      results.push({ path: prefix, isArray: false });
    }
    const items = node.items as Record<string, unknown> | undefined;
    if (node.type === 'array' && items?.type === 'string' && typeof items.pattern === 'string') {
      results.push({ path: prefix, isArray: true });
    }
    const properties = node.properties as Record<string, unknown> | undefined;
    if (properties !== undefined) {
      for (const key of Object.keys(properties)) {
        results.push(...listPatternedFields(properties[key], [...prefix, key]));
      }
    }
    return results;
  }

  function setAtPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
    let cursor: Record<string, unknown> = root;
    for (let index = 0; index < path.length - 1; index += 1) {
      cursor = cursor[path[index]!] as Record<string, unknown>;
    }
    cursor[path[path.length - 1]!] = value;
  }

  // The three leaves whose pattern is "lowercase hex/slug shaped" and which
  // therefore CANNOT tell a real value from a hex-shaped secret apart — this
  // is a stated limit, not an oversight (see the dedicated test below).
  const HEX_TOLERANT_LEAVES = new Set(['digest', 'evidence', 'notObserved']);

  // A SECOND stated limit, found while writing this very test: every
  // "version pin pattern" field (`VERSION_PATTERN`, shared with
  // declaration.ts) allows `.`, `_` and `-` alongside alnum — the underscore
  // a GitHub PAT needs (`ghp_…`) is legal version-pin syntax, so these four
  // leaves accept the token below even though nothing else does. Changing
  // `VERSION_PATTERN` itself is out of scope here: it is shared with, and
  // pinned by, `declaration.ts`'s own contract.
  const VERSION_PATTERN_TOLERANT_LEAVES = new Set(['version', 'toolVersion', 'rigVersion']);

  it('every OTHER patterned string field the schema declares (root, source, license, declared, and both act copies) refuses the secret-shaped token', async () => {
    const schema = await loadSchema();
    const fields = listPatternedFields(schema).filter((field) => {
      const leaf = field.path[field.path.length - 1]!;
      return !HEX_TOLERANT_LEAVES.has(leaf) && !VERSION_PATTERN_TOLERANT_LEAVES.has(leaf);
    });
    // Sanity: the walker actually found a non-trivial set of fields across
    // both act copies, so this test cannot silently pass over an empty list.
    expect(fields.length).toBeGreaterThanOrEqual(9);

    for (const field of fields) {
      // fullyPopulatedReceiptValue: installer.tool exists on BOTH acts here.
      const value = fullyPopulatedReceiptValue();
      setAtPath(value, field.path, field.isArray ? [secretShapedToken] : secretShapedToken);
      const result = parseReceipt(JSON.stringify(value));
      expect(result.status, field.path.join('.')).toBe('invalid');
    }
  });

  it('the honest gap: a version-pin-pattern field accepts the secret-shaped token, because VERSION_PATTERN permits the underscore it needs', async () => {
    const schema = await loadSchema();
    const fields = listPatternedFields(schema).filter((field) =>
      VERSION_PATTERN_TOLERANT_LEAVES.has(field.path[field.path.length - 1]!),
    );
    expect(fields.length).toBeGreaterThanOrEqual(4); // rigVersion, declared.version, installer.toolVersion x2, observedAfter.version x2

    for (const field of fields) {
      // fullyPopulatedReceiptValue: installer.toolVersion exists on BOTH acts here.
      const value = fullyPopulatedReceiptValue();
      setAtPath(value, field.path, secretShapedToken);
      const result = parseReceipt(JSON.stringify(value));
      expect(result.status, field.path.join('.')).toBe('ok');
    }
  });

  it('the honest gap: a PAT-shaped locator parses under the opaque kinds (npm, pypi, marketplace), the same undecidable class as the other two gaps', () => {
    // RP-22 gate cycle 2, blocker 1: `github` and `https` refuse this token
    // (it has no `/` at all, and it is not a URL); `npm`/`pypi`/`marketplace`
    // treat any bounded alnum/dot/underscore/hyphen string as a legal
    // package/extension name, and this token IS one — tightening the
    // grammar to exclude it would also exclude real names shaped the same
    // way, so the remedy is disclosure, exactly like the two gaps above.
    const opaqueKinds = ['npm', 'pypi', 'marketplace'] as const;
    for (const kind of opaqueKinds) {
      const value = validReceiptValue();
      value.source = { kind, locator: secretShapedToken, official: true, verifiedOn: '2026-09-21' };
      const result = parseReceipt(JSON.stringify(value));
      expect(result.status, kind).toBe('ok');
    }
  });

  it('source.locator still refuses the same secret-shaped token for github and https (the non-opaque kinds)', () => {
    const nonOpaqueKinds = ['github', 'https'] as const;
    for (const kind of nonOpaqueKinds) {
      const value = validReceiptValue();
      value.source = { kind, locator: secretShapedToken, official: true, verifiedOn: '2026-09-21' };
      const result = parseReceipt(JSON.stringify(value));
      expect(result.status, kind).toBe('invalid');
    }
  });

  it('the honest gap: digest/evidence/notObserved cannot distinguish a lowercase-hex-shaped secret from a real digest or slug, so they accept one', async () => {
    const schema = await loadSchema();
    const fields = listPatternedFields(schema).filter((field) =>
      HEX_TOLERANT_LEAVES.has(field.path[field.path.length - 1]!),
    );
    expect(fields.length).toBeGreaterThanOrEqual(3); // digest, evidence, notObserved on at least one act

    for (const field of fields) {
      const value = validReceiptValue();
      setAtPath(value, field.path, field.isArray ? [hexLookalikeSecret] : hexLookalikeSecret);
      const result = parseReceipt(JSON.stringify(value));
      // `evidence`'s slug pattern requires a LEADING LETTER — a hex string
      // starting with a digit fails it even though the rest is hex-shaped, so
      // this is genuinely "accepted when it happens to look enough like the
      // field's own shape", not a blanket pass.
      const startsWithLetter = /^[a-z]/.test(hexLookalikeSecret);
      const expectAccepted = field.path[field.path.length - 1] === 'digest' || startsWithLetter;
      expect(result.status, field.path.join('.')).toBe(expectAccepted ? 'ok' : 'invalid');
    }
  });

  it('a successfully parsed, re-serialized receipt carries no finding under findSecretValues (the real detector)', async () => {
    const findSecretValues = await loadFindSecretValues();
    const parsed = parseReceipt(validReceiptRaw());
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    expect(findSecretValues(serializeReceipt(parsed.receipt))).toEqual([]);
  });
});

describe('parseReceipt is total — depth-bounded, never throws', () => {
  const nestedArray = (levels: number, leaf: unknown): string =>
    '['.repeat(levels) + JSON.stringify(leaf) + ']'.repeat(levels);

  it('a fuzz list of hostile shapes never makes parseReceipt throw', () => {
    const hostileShapes: Record<string, string> = {
      'deeply nested arrays (6000 levels)': nestedArray(6000, 0),
      'deeply nested objects (6000 levels)': `${'{"a":'.repeat(6000)}0${'}'.repeat(6000)}`,
      'many shallow array elements within the byte cap': `[${new Array(28_000).fill('0').join(',')}]`,
      'a 60 KiB top-level string': JSON.stringify('x'.repeat(60 * 1024)),
      'a non-JSON string with embedded control bytes': 'not json at all \u0000 \uFFFF',
      'an empty string': '',
      'a bare BOM': '\uFEFF',
      'top-level null': 'null',
      'top-level true': 'true',
      'top-level a number': '1e999',
      'top-level 42': '42',
      'top-level a string': '"x"',
      'top-level an empty array': '[]',
      'a lone surrogate': JSON.stringify('\uD800'),
      '__proto__ as a root key': '{"__proto__": {"polluted": true}}',
      'constructor as a root key': '{"constructor": {"polluted": true}}',
      'array-like root': '{"0": "a", "1": "b", "length": 2}',
    };

    for (const [name, raw] of Object.entries(hostileShapes)) {
      let result: ReturnType<typeof parseReceipt> | undefined;
      expect(() => {
        result = parseReceipt(raw);
      }, name).not.toThrow();
      expect(result, name).toBeDefined();
      expect(['ok', 'invalid'], name).toContain(result?.status);
    }
  });

  it('voids a receipt nesting deeply inside an evidence array, instead of throwing', () => {
    // Built as TEXT, not as a JS value: `JSON.stringify`/`JSON.parse` on an
    // actually-6000-deep JS array recurse just as a naive parser would and
    // overflow the stack in the TEST's own setup, before `parseReceipt` ever
    // runs — the hostile shape has to arrive as a string, the way a
    // committed file does.
    const raw = validReceiptRaw().replace(
      '"evidence":["mcp-json-entry"]',
      `"evidence":${nestedArray(6000, 'x')}`,
    );
    expect(raw).not.toBe(validReceiptRaw()); // the replace actually matched
    let result: ReturnType<typeof parseReceipt> | undefined;
    expect(() => {
      result = parseReceipt(raw);
    }).not.toThrow();
    expect(result?.status).toBe('invalid');
  });
});

type FileShapeFixture = {
  name: string;
  value: unknown;
  accepted: boolean;
  errorEquals?: string;
};

/** Builds two fixtures — one per harness — from a single act-level mutation, so a schema/parser weakening on EITHER copy is caught (RP-22 gate cycle 1, blocker 2). */
function perHarnessFixtures(
  name: string,
  mutate: (act: Record<string, unknown>) => void,
  errorFor: (harness: string) => string,
): FileShapeFixture[] {
  return (['claude-code', 'codex'] as const).map((harness) => {
    const value = fullyPopulatedReceiptValue();
    mutate(actsOf(value)[harness]!);
    return { name: `${name} (${harness})`, value, accepted: false, errorEquals: errorFor(harness) };
  });
}

/**
 * Shared between `parseReceipt` and the schema oracle, exactly as
 * `declaration.ts`'s `FILE_SHAPE_FIXTURES` does — every fixture here is
 * judged the same way, at the same (whole-document) level, by both layers,
 * AND (RP-22 gate cycle 1, blocker 2) every refusal names the SPECIFIC error
 * a check produces, not merely `status: 'invalid'` — so a check whose
 * deletion makes a LATER, different check fire instead is caught by the
 * string no longer matching, not masked by both outcomes reading "invalid".
 */
const FILE_SHAPE_FIXTURES: readonly FileShapeFixture[] = [
  { name: 'the documented example', value: validReceiptValue(), accepted: true },
  {
    name: 'a wrong schemaVersion',
    value: { ...validReceiptValue(), schemaVersion: 2 },
    accepted: false,
    errorEquals: '"schemaVersion" must be 1',
  },
  {
    name: 'an unrecognised root key',
    value: { ...validReceiptValue(), command: 'rm -rf /' },
    accepted: false,
    errorEquals: 'the receipt has an unrecognised key "command"',
  },
  ...(
    ['schemaVersion', 'id', 'mode', 'source', 'license', 'declared', 'rigVersion', 'acts'] as const
  ).map((key) => {
    const value = validReceiptValue();
    delete value[key];
    return {
      name: `a receipt missing the required root field "${key}"`,
      value,
      accepted: false,
      errorEquals: `the receipt is missing "${key}"`,
    };
  }),
  {
    name: 'id with an uppercase letter (fails the slug pattern)',
    value: { ...validReceiptValue(), id: 'Figma-MCP' },
    accepted: false,
    errorEquals: '"id" must be a lowercase slug',
  },
  {
    name: 'mode outside the known set',
    value: { ...validReceiptValue(), mode: 'telepathy' },
    accepted: false,
    errorEquals: '"mode" is not one of the known modes',
  },
  {
    name: 'rigVersion with a leading dot (fails the version pattern)',
    value: { ...validReceiptValue(), rigVersion: '.0.10.0' },
    accepted: false,
    errorEquals: '"rigVersion" does not match the version pin pattern',
  },
  // --- source ---
  {
    name: 'source carrying an unrecognised key',
    value: {
      ...validReceiptValue(),
      source: { ...(validReceiptValue().source as object), bogus: true },
    },
    accepted: false,
    errorEquals: '"source" has an unrecognised key "bogus"',
  },
  ...(['kind', 'locator', 'official', 'verifiedOn'] as const).map((key) => {
    const value = validReceiptValue();
    const source = { ...(value.source as Record<string, unknown>) };
    delete source[key];
    value.source = source;
    return {
      name: `source missing "${key}"`,
      value,
      accepted: false,
      errorEquals: `"source" is missing "${key}"`,
    };
  }),
  {
    name: 'source.kind outside the known set',
    value: (() => {
      const value = validReceiptValue();
      value.source = { ...(value.source as object), kind: 'ftp' };
      return value;
    })(),
    accepted: false,
    errorEquals: '"source.kind" is not one of the known source kinds',
  },
  {
    name: 'source.official is not a boolean',
    value: (() => {
      const value = validReceiptValue();
      value.source = { ...(value.source as object), official: 'yes' };
      return value;
    })(),
    accepted: false,
    errorEquals: '"source.official" must be a boolean',
  },
  {
    name: 'source.verifiedOn fails the date SHAPE pattern outright (wrong digit count)',
    value: (() => {
      const value = validReceiptValue();
      value.source = { ...(value.source as object), verifiedOn: '2026-1-1' };
      return value;
    })(),
    accepted: false,
    errorEquals: '"source.verifiedOn" must be a real YYYY-MM-DD date',
  },
  {
    name: 'source.locator (https) carrying a query string (the schema pattern also excludes "?", so both layers agree here)',
    value: (() => {
      const value = validReceiptValue();
      value.source = { ...(value.source as object), locator: 'https://mcp.figma.com/mcp?x=1' };
      return value;
    })(),
    accepted: false,
    errorEquals: '"source.locator" is not a valid locator for kind "https"',
  },
  // --- license ---
  {
    name: 'license carrying an unrecognised key',
    value: {
      ...validReceiptValue(),
      license: { kind: 'terms', url: 'https://x.example/terms', bogus: true },
    },
    accepted: false,
    errorEquals: '"license" has an unrecognised key "bogus"',
  },
  {
    name: 'license missing "kind"',
    value: { ...validReceiptValue(), license: { url: 'https://x.example/terms' } },
    accepted: false,
    errorEquals: '"license.kind" must be "spdx" or "terms"',
  },
  {
    name: 'license.kind outside {spdx, terms}',
    value: { ...validReceiptValue(), license: { kind: 'mit-ish', id: 'MIT' } },
    accepted: false,
    errorEquals: '"license.kind" must be "spdx" or "terms"',
  },
  // --- declared ---
  {
    name: 'declared carrying an unrecognised key',
    value: { ...validReceiptValue(), declared: { required: false, bogus: true } },
    accepted: false,
    errorEquals: '"declared" has an unrecognised key "bogus"',
  },
  {
    name: 'declared missing "required"',
    value: { ...validReceiptValue(), declared: {} },
    accepted: false,
    errorEquals: '"declared" is missing "required"',
  },
  {
    name: 'declared.required is not a boolean',
    value: { ...validReceiptValue(), declared: { required: 'yes' } },
    accepted: false,
    errorEquals: '"declared.required" must be a boolean',
  },
  {
    name: 'declared.version fails the version pin pattern',
    value: { ...validReceiptValue(), declared: { required: false, version: 'not a version!' } },
    accepted: false,
    errorEquals: '"declared.version" does not match the version pin pattern',
  },
  // --- acts (root object) ---
  {
    name: 'acts carrying a harness key outside {claude-code, codex}',
    value: (() => {
      const value = validReceiptValue();
      const acts = actsOf(value);
      acts.windsurf = acts['claude-code']!;
      return value;
    })(),
    accepted: false,
    errorEquals: '"acts" has an unrecognised key "windsurf"',
  },
  // --- act level, generated for BOTH harnesses ---
  // `parseAct` has no dedicated hasOwn-then-"is missing" check for these
  // three fields (unlike observedAfter/notObserved below) — an absent value
  // falls straight through to the enum/pattern check, which reports the SAME
  // message a wrong-but-present value would. The fixture asserts the message
  // the code actually produces, not one it does not.
  ...perHarnessFixtures(
    'act missing "route"',
    (act) => delete act.route,
    (harness) => `acts["${harness}"].route is not a known route`,
  ),
  ...perHarnessFixtures(
    'act missing "automation"',
    (act) => delete act.automation,
    (harness) => `acts["${harness}"].automation must be "automatic" or "guided"`,
  ),
  ...perHarnessFixtures(
    'act missing "performedAt"',
    (act) => delete act.performedAt,
    (harness) => `acts["${harness}"].performedAt must be a real UTC timestamp`,
  ),
  ...perHarnessFixtures(
    'act missing "observedAfter"',
    (act) => delete act.observedAfter,
    (harness) => `acts["${harness}"] is missing "observedAfter"`,
  ),
  ...perHarnessFixtures(
    'act missing "notObserved"',
    (act) => delete act.notObserved,
    (harness) => `acts["${harness}"] is missing "notObserved"`,
  ),
  ...perHarnessFixtures(
    'act carrying an unrecognised key',
    (act) => {
      act.bogus = true;
    },
    (harness) => `acts["${harness}"] has an unrecognised key "bogus"`,
  ),
  ...perHarnessFixtures(
    'act.route outside the known set',
    (act) => {
      act.route = 'telepathy';
    },
    (harness) => `acts["${harness}"].route is not a known route`,
  ),
  ...perHarnessFixtures(
    'act.automation outside {automatic, guided}',
    (act) => {
      act.automation = 'psychic';
    },
    (harness) => `acts["${harness}"].automation must be "automatic" or "guided"`,
  ),
  ...perHarnessFixtures(
    'act.performedAt fails the timestamp shape',
    (act) => {
      act.performedAt = 'not-a-timestamp';
    },
    (harness) => `acts["${harness}"].performedAt must be a real UTC timestamp`,
  ),
  ...perHarnessFixtures(
    'act.installer carrying an unrecognised key',
    (act) => {
      (act.installer as Record<string, unknown>).bogus = true;
    },
    () => '"installer" has an unrecognised key "bogus"',
  ),
  ...perHarnessFixtures(
    'act.installer missing "tool"',
    (act) => {
      delete (act.installer as Record<string, unknown>).tool;
    },
    () => '"installer" is missing "tool"',
  ),
  ...perHarnessFixtures(
    'act.installer missing "toolVersion"',
    (act) => {
      delete (act.installer as Record<string, unknown>).toolVersion;
    },
    () => '"installer" is missing "toolVersion"',
  ),
  ...perHarnessFixtures(
    'act.installer missing "exitCode"',
    (act) => {
      delete (act.installer as Record<string, unknown>).exitCode;
    },
    () => '"installer" is missing "exitCode"',
  ),
  ...perHarnessFixtures(
    'act.installer.tool fails the slug pattern',
    (act) => {
      (act.installer as Record<string, unknown>).tool = 'NOT-lowercase';
    },
    () => '"installer.tool" must be a lowercase slug',
  ),
  ...perHarnessFixtures(
    'act.installer.toolVersion fails the version pin pattern',
    (act) => {
      (act.installer as Record<string, unknown>).toolVersion = 'not a version!';
    },
    () => '"installer.toolVersion" does not match the version pin pattern',
  ),
  // Pins installer.exitCode's `type: "integer"` keyword — dropping it lets
  // the schema accept any type, and this is the one fixture whose value is
  // otherwise well-formed EXCEPT for exitCode's type (RP-22 gate cycle 1,
  // blocker 2).
  ...perHarnessFixtures(
    'act.installer.exitCode is a string, not a number',
    (act) => {
      (act.installer as Record<string, unknown>).exitCode = 'zero';
    },
    () => '"installer.exitCode" must be an integer between 0 and 255',
  ),
  // A fractional number within 0-255: json-schema-subset's `type: "integer"`
  // already distinguishes "a whole number" from "a number" (RP-22 gate cycle
  // 2, advisory (f)), so both layers refuse this — but only `Number.isInteger`
  // is what actually enforces it on the parser side, and nothing pinned that
  // check's own boundary before this.
  ...perHarnessFixtures(
    'act.installer.exitCode is a fractional number within 0-255',
    (act) => {
      (act.installer as Record<string, unknown>).exitCode = 1.5;
    },
    () => '"installer.exitCode" must be an integer between 0 and 255',
  ),
  ...perHarnessFixtures(
    'act.observedAfter carrying an unrecognised key',
    (act) => {
      (act.observedAfter as Record<string, unknown>).bogus = true;
    },
    () => '"observedAfter" has an unrecognised key "bogus"',
  ),
  ...perHarnessFixtures(
    'act.observedAfter missing "state"',
    (act) => {
      delete (act.observedAfter as Record<string, unknown>).state;
    },
    () => '"observedAfter" is missing "state"',
  ),
  ...perHarnessFixtures(
    'act.observedAfter missing "evidence"',
    (act) => {
      delete (act.observedAfter as Record<string, unknown>).evidence;
    },
    () => '"observedAfter" is missing "evidence"',
  ),
  ...perHarnessFixtures(
    'act.observedAfter.state outside the known set',
    (act) => {
      (act.observedAfter as Record<string, unknown>).state = 'teleported';
    },
    () => '"observedAfter.state" is not a known instance state',
  ),
  ...perHarnessFixtures(
    'act.observedAfter.version fails the version pin pattern',
    (act) => {
      (act.observedAfter as Record<string, unknown>).version = 'not a version!';
    },
    () => '"observedAfter.version" does not match the version pin pattern',
  ),
  ...perHarnessFixtures(
    'act.observedAfter.digest fails the hex-digest pattern',
    (act) => {
      (act.observedAfter as Record<string, unknown>).digest = 'ABCDEF1';
    },
    () => '"observedAfter.digest" must be a lowercase hex digest',
  ),
  ...perHarnessFixtures(
    'act.observedAfter.evidence contains a non-slug value',
    (act) => {
      (act.observedAfter as Record<string, unknown>).evidence = ['Not-A-Slug'];
    },
    () => '"observedAfter.evidence" contains a value that is not a lowercase slug',
  ),
  ...perHarnessFixtures(
    'act.notObserved contains a non-slug value',
    (act) => {
      act.notObserved = ['Not-A-Slug'];
    },
    (harness) => `"acts["${harness}"].notObserved" contains a value that is not a lowercase slug`,
  ),
];

describe('file-level shape: parseReceipt and the schema oracle agree on one shared fixture list', () => {
  it.each(FILE_SHAPE_FIXTURES)('$name', async ({ value, accepted, errorEquals }) => {
    const validate = await loadValidate();
    const schema = await loadSchema();
    const raw = JSON.stringify(value);

    const parsed = parseReceipt(raw);
    expect(parsed.status).toBe(accepted ? 'ok' : 'invalid');
    if (!accepted && parsed.status === 'invalid' && errorEquals !== undefined) {
      expect(parsed.error).toBe(errorEquals);
    }

    expect(validate(schema, value).ok).toBe(accepted);
  });
});

type SchemaOnlyFixture = { name: string; value: unknown; errorEquals: string };

/**
 * Correlations `parseReceipt` enforces that this schema subset genuinely
 * cannot express (no `oneOf`, no `minProperties`, no numeric bound, no
 * per-kind conditional pattern) — mirrors `declaration.ts`'s documented
 * schema-subset exceptions. Each of these passes the schema (structurally
 * well-shaped, or shaped enough for the schema's superset pattern) while
 * `parseReceipt` refuses it for a reason the schema has no keyword for.
 */
const SCHEMA_ONLY_FIXTURES: readonly SchemaOnlyFixture[] = [
  {
    name: 'license.kind spdx carrying a url as well as an id (the schema does not correlate the two)',
    value: {
      ...validReceiptValue(),
      license: { kind: 'spdx', id: 'MIT', url: 'https://x.example' },
    },
    errorEquals: '"license" of kind spdx must not carry "url"',
  },
  {
    name: 'license.kind terms carrying an id as well as a url',
    value: {
      ...validReceiptValue(),
      license: { kind: 'terms', id: 'MIT', url: 'https://x.example' },
    },
    errorEquals: '"license" of kind terms must not carry "id"',
  },
  {
    name: 'installer.exitCode outside 0-255 (the schema subset has no numeric bound keyword)',
    value: (() => {
      const value = validReceiptValue();
      (actsOf(value)['claude-code']!.installer as Record<string, unknown>).exitCode = 999;
      return value;
    })(),
    errorEquals: '"installer.exitCode" must be an integer between 0 and 255',
  },
  {
    name: 'acts with no harness at all (the schema subset has no minProperties)',
    value: { ...validReceiptValue(), acts: {} },
    errorEquals: '"acts" must record at least one harness',
  },
  {
    name: 'source.locator that is a well-shaped github owner/repo string while source.kind is npm (schema cannot pick a pattern by kind)',
    value: (() => {
      const value = validReceiptValue();
      value.source = {
        kind: 'npm',
        locator: 'owner/repo',
        official: true,
        verifiedOn: '2026-09-21',
      };
      return value;
    })(),
    errorEquals: '"source.locator" is not a valid locator for kind "npm"',
  },
  {
    name: 'evidence with 17 entries (the schema subset has no maxItems)',
    value: (() => {
      const value = validReceiptValue();
      actsOf(value)['claude-code']!.observedAfter = {
        state: 'installed',
        evidence: Array.from({ length: 17 }, (_, i) => `tag-${i}`),
      };
      return value;
    })(),
    errorEquals: '"observedAfter.evidence" has more than 16 entries',
  },
  {
    name: 'performedAt shape-valid but calendar/clock-invalid (the schema subset has no way to check a real date beyond pattern)',
    value: (() => {
      const value = validReceiptValue();
      actsOf(value)['claude-code']!.performedAt = '9999-99-99T99:99:99Z';
      return value;
    })(),
    errorEquals: 'acts["claude-code"].performedAt must be a real UTC timestamp',
  },
  {
    name: 'source.verifiedOn shape-valid but calendar-invalid (30 Feb) — the schema subset has no way to check a real date beyond pattern',
    value: (() => {
      const value = validReceiptValue();
      value.source = { ...(value.source as object), verifiedOn: '2026-02-30' };
      return value;
    })(),
    errorEquals: '"source.verifiedOn" must be a real YYYY-MM-DD date',
  },
  {
    name: "license.url exactly 129 characters — within the schema pattern's own 9-129 bound but past MAX_LOCATOR_LENGTH (128), which the schema subset cannot express as a length keyword",
    value: {
      ...validReceiptValue(),
      license: { kind: 'terms', url: `https://${'a'.repeat(121)}` },
    },
    errorEquals: '"license.url" must be a valid https URL with no query string or fragment',
  },
];

describe('schema-subset limits: parseReceipt refuses what the schema alone cannot express', () => {
  it.each(SCHEMA_ONLY_FIXTURES)('$name', async ({ value, errorEquals }) => {
    const validate = await loadValidate();
    const schema = await loadSchema();
    expect(validate(schema, value).ok).toBe(true);

    const result = parseReceipt(JSON.stringify(value));
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.error).toBe(errorEquals);
  });
});

describe('ROOT_KEYS / ACT_KEYS correspond to the schema, one fact spelled once', () => {
  it('ROOT_KEYS equals the schema root properties keys', async () => {
    const schema = await loadSchema();
    expect(new Set(ROOT_KEYS)).toEqual(
      new Set(Object.keys((schema as { properties: Record<string, unknown> }).properties)),
    );
  });

  it("ACT_KEYS equals both the claude-code and codex act schemas' properties keys", async () => {
    const schema = await loadSchema();
    const acts = (
      schema as {
        properties: {
          acts: { properties: Record<string, { properties: Record<string, unknown> }> };
        };
      }
    ).properties.acts.properties;
    expect(new Set(ACT_KEYS)).toEqual(new Set(Object.keys(acts['claude-code']!.properties)));
    expect(new Set(ACT_KEYS)).toEqual(new Set(Object.keys(acts.codex!.properties)));
  });

  it('the claude-code and codex act schemas are identical duplicates', async () => {
    const schema = await loadSchema();
    const acts = (schema as { properties: { acts: { properties: Record<string, unknown> } } })
      .properties.acts.properties;
    expect(JSON.stringify(acts['claude-code'])).toBe(JSON.stringify(acts.codex));
  });

  it.each([
    ['ROOT_KEYS', ROOT_KEYS],
    ['ACT_KEYS', ACT_KEYS],
  ])('mutating %s throws', (_name, frozen) => {
    expect(() => {
      (frozen as string[]).push('x');
    }).toThrow();
  });
});

/**
 * Every enum's closed TS vocabulary against the schema's OWN enum array, by
 * exact set equality — not merely "a hostile value outside the CURRENT set is
 * refused", which survives the enum being WIDENED as long as the hostile
 * probe value still isn't a member of the wider set (RP-22 gate cycle 1,
 * blocker 2: root.mode, source.kind, license.kind, act.route, act.automation
 * and act.observedAfter.state (both act copies) all widened silently before
 * this test existed).
 */
describe('every enum has one spelling: the TS closed vocabulary equals the schema enum, exactly', () => {
  it('MODE_VALUES equals schema.properties.mode.enum', async () => {
    const schema = await loadSchema();
    expect(new Set(MODE_VALUES)).toEqual(
      new Set((schema as { properties: { mode: { enum: string[] } } }).properties.mode.enum),
    );
  });

  it('SOURCE_KIND_VALUES equals schema.properties.source.properties.kind.enum', async () => {
    const schema = await loadSchema();
    const kindEnum = (
      schema as { properties: { source: { properties: { kind: { enum: string[] } } } } }
    ).properties.source.properties.kind.enum;
    expect(new Set(SOURCE_KIND_VALUES)).toEqual(new Set(kindEnum));
  });

  it('LICENSE_KIND_VALUES equals schema.properties.license.properties.kind.enum', async () => {
    const schema = await loadSchema();
    const kindEnum = (
      schema as { properties: { license: { properties: { kind: { enum: string[] } } } } }
    ).properties.license.properties.kind.enum;
    expect(new Set(LICENSE_KIND_VALUES)).toEqual(new Set(kindEnum));
  });

  it('ROUTE_VALUES equals both act copies’ route.enum', async () => {
    const schema = await loadSchema();
    const acts = (
      schema as {
        properties: {
          acts: { properties: Record<string, { properties: { route: { enum: string[] } } }> };
        };
      }
    ).properties.acts.properties;
    expect(new Set(ROUTE_VALUES)).toEqual(new Set(acts['claude-code']!.properties.route.enum));
    expect(new Set(ROUTE_VALUES)).toEqual(new Set(acts.codex!.properties.route.enum));
  });

  it('AUTOMATION_VALUES equals both act copies’ automation.enum', async () => {
    const schema = await loadSchema();
    const acts = (
      schema as {
        properties: {
          acts: { properties: Record<string, { properties: { automation: { enum: string[] } } }> };
        };
      }
    ).properties.acts.properties;
    expect(new Set(AUTOMATION_VALUES)).toEqual(
      new Set(acts['claude-code']!.properties.automation.enum),
    );
    expect(new Set(AUTOMATION_VALUES)).toEqual(new Set(acts.codex!.properties.automation.enum));
  });

  it('INSTANCE_STATES equals both act copies’ observedAfter.state.enum', async () => {
    const schema = await loadSchema();
    const acts = (
      schema as {
        properties: {
          acts: {
            properties: Record<
              string,
              { properties: { observedAfter: { properties: { state: { enum: string[] } } } } }
            >;
          };
        };
      }
    ).properties.acts.properties;
    expect(new Set(INSTANCE_STATES)).toEqual(
      new Set(acts['claude-code']!.properties.observedAfter.properties.state.enum),
    );
    expect(new Set(INSTANCE_STATES)).toEqual(
      new Set(acts.codex!.properties.observedAfter.properties.state.enum),
    );
  });
});

describe('parseReceipt refuses a receipt larger than 64 KiB, even when otherwise well-formed', () => {
  it('refuses a receipt padded with whitespace past the 64 KiB cap', () => {
    const raw = validReceiptRaw();
    // Padding with whitespace right after the opening brace: still valid
    // JSON, still the same document semantically — the ONLY thing standing
    // between this and acceptance is the byte cap (RP-22 gate cycle 1,
    // blocker 2: this check had no dedicated test and survived deletion).
    const padded = `${raw.slice(0, 1)}${' '.repeat(70 * 1024)}${raw.slice(1)}`;
    expect(new TextEncoder().encode(padded).byteLength).toBeGreaterThan(64 * 1024);
    const result = parseReceipt(padded);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.error).toBe('the receipt is larger than 64 KiB');
  });
});

describe('license.id and SPDX_EXPRESSION_PATTERN have one spelling', () => {
  it('the schema license.id pattern is byte-identical to registry.ts SPDX_EXPRESSION_PATTERN', async () => {
    const schema = await loadSchema();
    const licenseSchema = (
      schema as { properties: { license: { properties: { id: { pattern: string } } } } }
    ).properties.license.properties.id;
    expect(SPDX_EXPRESSION_PATTERN.source).toBe(licenseSchema.pattern);
  });
});

/**
 * `license.url` has no single shared pattern string the way `license.id`
 * does — the schema's `^https://[^\s?#]{1,121}$` and the parser's
 * `isValidLocator('https', …)` are two different expressions of the same
 * intended rule (a real https URL, no query string or fragment) because the
 * parser ALSO calls the real `URL` constructor, which no regex here
 * re-implements. A shared fixture list run through both is the
 * correspondence check instead (RP-22 gate cycle 3, cheap survivor (b)) —
 * with the three KNOWN divergences named rather than silently matched by
 * accident (found while writing this very test; only "length" was expected
 * going in):
 *
 * 1. Length: the schema's own bound is 9-129 characters, `isValidLocator`'s
 *    is 128, so a value of EXACTLY 129 characters is a fixture the two
 *    layers legitimately disagree on (already pinned as a
 *    SCHEMA_ONLY_FIXTURES entry above — restated directly here, without
 *    going through `parseReceipt`).
 * 2. Userinfo: the schema's character class `[^\s?#]` has nothing that
 *    excludes `user:pass@`, so a userinfo-bearing URL matches the SHAPE
 *    pattern; only `isValidLocator`'s real `URL` parse (via `isHttpsUrl`)
 *    refuses it. This is the same "schema checks shape, parser checks
 *    reality" split every other real-value check in this module has
 *    (`isRealDateString`, `isRealTimestampString`) — restated here because
 *    it was not named before this fixture list surfaced it.
 * 3. A raw space: the schema's `\s` exclusion refuses it outright, but the
 *    WHATWG `URL` constructor `isHttpsUrl` calls percent-encodes a bare
 *    space in the path rather than throwing, and `isValidLocator`'s own
 *    query/fragment check only looks for literal `?`/`#` characters — so a
 *    locator carrying a raw space parses. Named here as a found, disclosed
 *    gap rather than fixed, matching this module's established posture
 *    toward `source.locator`'s own undecidable shapes (a real fix would be
 *    a new `isValidLocator` check for a schema-caller mismatch, which is
 *    out of scope for a "pin the two-mutant divergence" round).
 */
describe('license.url: the schema pattern and isValidLocator agree, except at the three named divergences (length, userinfo, whitespace)', () => {
  const LICENSE_URL_FIXTURES: readonly { name: string; url: string; accepted: boolean }[] = [
    { name: 'a plain https URL', url: 'https://mcp.figma.com/terms', accepted: true },
    { name: 'a query string', url: 'https://mcp.figma.com/terms?x=1', accepted: false },
    { name: 'a fragment', url: 'https://mcp.figma.com/terms#f', accepted: false },
    { name: 'a non-https scheme', url: 'http://mcp.figma.com/terms', accepted: false },
  ];

  it.each(LICENSE_URL_FIXTURES)(
    '$name: the schema pattern and isValidLocator agree',
    async ({ url, accepted }) => {
      const schema = await loadSchema();
      const pattern = (
        schema as { properties: { license: { properties: { url: { pattern: string } } } } }
      ).properties.license.properties.url.pattern;
      expect(new RegExp(pattern).test(url)).toBe(accepted);
      expect(isValidLocator('https', url)).toBe(accepted);
    },
  );

  it("named divergence 1 (length): a URL of exactly 129 characters passes the schema pattern's own 9-129 bound but fails isValidLocator's 128-character MAX_LOCATOR_LENGTH", async () => {
    const url = `https://${'a'.repeat(121)}`; // 8 + 121 = 129 characters total
    expect(url).toHaveLength(129);
    const schema = await loadSchema();
    const pattern = (
      schema as { properties: { license: { properties: { url: { pattern: string } } } } }
    ).properties.license.properties.url.pattern;
    expect(new RegExp(pattern).test(url)).toBe(true);
    expect(isValidLocator('https', url)).toBe(false);
  });

  it("named divergence 2 (userinfo): a userinfo-bearing URL passes the schema's character-class pattern but fails isValidLocator's real URL parse", async () => {
    const url = 'https://user:pass@mcp.figma.com/terms';
    const schema = await loadSchema();
    const pattern = (
      schema as { properties: { license: { properties: { url: { pattern: string } } } } }
    ).properties.license.properties.url.pattern;
    expect(new RegExp(pattern).test(url)).toBe(true);
    expect(isValidLocator('https', url)).toBe(false);
  });

  it("named divergence 3 (whitespace): a raw space in the path fails the schema's \\s-excluding pattern but isValidLocator accepts it, because the real URL parse percent-encodes a space rather than throwing", async () => {
    const url = 'https://mcp.figma.com/te rms';
    const schema = await loadSchema();
    const pattern = (
      schema as { properties: { license: { properties: { url: { pattern: string } } } } }
    ).properties.license.properties.url.pattern;
    expect(new RegExp(pattern).test(url)).toBe(false);
    expect(isValidLocator('https', url)).toBe(true);
  });
});

describe('RECEIPT_SCHEMA_VERSION / RECEIPTS_DIR_REL', () => {
  it('names schema version 1 and the .rig/receipts directory', () => {
    expect(RECEIPT_SCHEMA_VERSION).toBe(1);
    expect(RECEIPTS_DIR_REL).toBe('.rig/receipts');
  });
});
