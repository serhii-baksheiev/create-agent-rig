import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACT_KEYS,
  RECEIPTS_DIR_REL,
  RECEIPT_SCHEMA_VERSION,
  ROOT_KEYS,
  hasMaterialChange,
  parseReceipt,
  serializeReceipt,
  serializeReceiptForComparison,
  type Receipt,
} from '../src/integrations/receipt.js';

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
// that choice.
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
});

describe('parseReceipt — refuses a control character, an absolute path, or an unknown top-level act key', () => {
  it('refuses a control character anywhere in the JSON', () => {
    const value = validReceiptValue();
    (value as { rigVersion: string }).rigVersion = '0.10.0\u0007';
    expect(parseReceipt(JSON.stringify(value)).status).toBe('invalid');
  });

  it.each([
    ['installer.tool', '/etc/passwd'],
    ['installer.tool', 'C:\\Users\\evil\\tool.exe'],
  ])(
    "refuses an absolute path (%s: %s) — it fails the field's own closed pattern",
    (_field, path_) => {
      const value = validReceiptValue();
      const acts = value.acts as Record<string, { installer: { tool: string } }>;
      acts['claude-code']!.installer.tool = path_;
      expect(parseReceipt(JSON.stringify(value)).status).toBe('invalid');
    },
  );

  it('refuses an unknown key inside an act object', () => {
    const value = validReceiptValue();
    const acts = value.acts as Record<string, Record<string, unknown>>;
    acts['claude-code']!.bogusField = true;
    const result = parseReceipt(JSON.stringify(value));
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.error).toMatch(/unrecognised key/);
  });

  it('refuses an unknown top-level receipt key', () => {
    const value = validReceiptValue();
    (value as Record<string, unknown>).command = 'rm -rf /';
    const result = parseReceipt(JSON.stringify(value));
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.error).toMatch(/unrecognised key/);
      expect(result.error).not.toContain('rm -rf');
    }
  });

  it('refuses a harness key inside acts outside {claude-code, codex}', () => {
    const value = validReceiptValue();
    const acts = value.acts as Record<string, unknown>;
    acts.windsurf = acts['claude-code'];
    expect(parseReceipt(JSON.stringify(value)).status).toBe('invalid');
  });
});

describe('serializeReceipt / serializeReceiptForComparison — serializes byte-identically when only performedAt would differ', () => {
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

  it('serializeReceipt produces stable, parseable bytes (parse ∘ serialize is stable)', () => {
    const parsed = parseReceipt(validReceiptRaw());
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    const serialized = serializeReceipt(parsed.receipt);
    expect(parseReceipt(serialized)).toEqual(parsed);
  });
});

describe('hasMaterialChange', () => {
  it('is true when there is no previous receipt', () => {
    const parsed = parseReceipt(validReceiptRaw());
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    expect(hasMaterialChange(undefined, parsed.receipt)).toBe(true);
  });

  it('is false when only performedAt differs', () => {
    const parsed = parseReceipt(validReceiptRaw());
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    const next: Receipt = {
      ...parsed.receipt,
      acts: {
        ...parsed.receipt.acts,
        'claude-code': {
          ...(parsed.receipt.acts['claude-code'] as NonNullable<Receipt['acts']['claude-code']>),
          performedAt: '2099-01-01T00:00:00Z',
        },
      },
    };
    expect(hasMaterialChange(parsed.receipt, next)).toBe(false);
  });

  it('is true when a material field (observedAfter.state) differs', () => {
    const parsed = parseReceipt(validReceiptRaw());
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    const next: Receipt = {
      ...parsed.receipt,
      acts: {
        ...parsed.receipt.acts,
        'claude-code': {
          ...(parsed.receipt.acts['claude-code'] as NonNullable<Receipt['acts']['claude-code']>),
          observedAfter: {
            ...(parsed.receipt.acts['claude-code'] as NonNullable<Receipt['acts']['claude-code']>)
              .observedAfter,
            state: 'drifted',
          },
        },
      },
    };
    expect(hasMaterialChange(parsed.receipt, next)).toBe(true);
  });
});

describe('a receipt built from secret-shaped third-party output contains none of it', () => {
  // Assembled at runtime, per this repository's fixture rule — never a
  // literal credential-shaped string in source.
  const secretShapedToken = [
    'ghp_',
    ...Array.from(
      { length: 36 },
      (_, index) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(index * 7 + 3) % 36],
    ),
  ].join('');

  it.each([
    [
      'installer.tool',
      (value: Record<string, unknown>) => {
        const acts = value.acts as Record<string, { installer: { tool: string } }>;
        acts['claude-code']!.installer.tool = secretShapedToken;
      },
    ],
    [
      'an evidence entry',
      (value: Record<string, unknown>) => {
        const acts = value.acts as Record<string, { observedAfter: { evidence: string[] } }>;
        acts['claude-code']!.observedAfter.evidence = [secretShapedToken];
      },
    ],
    [
      'a notObserved entry',
      (value: Record<string, unknown>) => {
        const acts = value.acts as Record<string, { notObserved: string[] }>;
        acts.codex!.notObserved = [secretShapedToken];
      },
    ],
    [
      'source.locator, smuggled in a query string',
      (value: Record<string, unknown>) => {
        const source = value.source as { locator: string };
        source.locator = `https://mcp.figma.com/mcp?token=${secretShapedToken}`;
      },
    ],
  ])('refuses a receipt carrying a secret-shaped value in %s', (_label, mutate) => {
    const value = validReceiptValue();
    mutate(value);
    expect(parseReceipt(JSON.stringify(value)).status).toBe('invalid');
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

type FileShapeFixture = { name: string; value: unknown; accepted: boolean };

/**
 * Shared between `parseReceipt` and the schema oracle, exactly as
 * `declaration.ts`'s `FILE_SHAPE_FIXTURES` does — every fixture here is
 * judged the same way, at the same (whole-document) level, by both layers.
 * Unlike a declaration, a receipt has no partial-acceptance mode: there is no
 * "entries" list a bad field can be moved out of, so there is no second,
 * entry-level exception class here — only `SCHEMA_ONLY_FIXTURES` below, for
 * the handful of correlations the schema subset cannot express at all.
 */
const FILE_SHAPE_FIXTURES: readonly FileShapeFixture[] = [
  { name: 'the documented example', value: validReceiptValue(), accepted: true },
  {
    name: 'a wrong schemaVersion',
    value: { ...validReceiptValue(), schemaVersion: 2 },
    accepted: false,
  },
  {
    name: 'an unrecognised root key',
    value: { ...validReceiptValue(), command: 'rm -rf /' },
    accepted: false,
  },
  {
    name: 'a receipt missing a required root field (license)',
    value: (() => {
      const value = validReceiptValue();
      delete value.license;
      return value;
    })(),
    accepted: false,
  },
  {
    name: 'id with an uppercase letter (fails the slug pattern)',
    value: { ...validReceiptValue(), id: 'Figma-MCP' },
    accepted: false,
  },
  {
    name: 'mode outside the known set',
    value: { ...validReceiptValue(), mode: 'telepathy' },
    accepted: false,
  },
  {
    name: 'rigVersion with a leading dot (fails the version pattern)',
    value: { ...validReceiptValue(), rigVersion: '.0.10.0' },
    accepted: false,
  },
];

describe('file-level shape: parseReceipt and the schema oracle agree on one shared fixture list', () => {
  it.each(FILE_SHAPE_FIXTURES)('$name', async ({ value, accepted }) => {
    const validate = await loadValidate();
    const schema = await loadSchema();
    const raw = JSON.stringify(value);

    expect(parseReceipt(raw).status).toBe(accepted ? 'ok' : 'invalid');
    expect(validate(schema, value).ok).toBe(accepted);
  });
});

type SchemaOnlyFixture = { name: string; value: unknown };

/**
 * Correlations `parseReceipt` enforces that this schema subset genuinely
 * cannot express (no `oneOf`, no `minProperties`, no numeric bound, no
 * string-content check beyond `pattern`/`minLength`) — mirrors
 * `declaration.ts`'s documented schema-subset exceptions. Each of these
 * passes the schema (structurally well-shaped) while `parseReceipt` refuses
 * it for a reason the schema has no keyword for.
 */
const SCHEMA_ONLY_FIXTURES: readonly SchemaOnlyFixture[] = [
  {
    name: 'license.kind spdx carrying a url as well as an id (the schema does not correlate the two)',
    value: {
      ...validReceiptValue(),
      license: { kind: 'spdx', id: 'MIT', url: 'https://x.example' },
    },
  },
  {
    name: 'license.kind terms carrying an id as well as a url',
    value: {
      ...validReceiptValue(),
      license: { kind: 'terms', id: 'MIT', url: 'https://x.example' },
    },
  },
  {
    name: 'installer.exitCode outside 0-255 (the schema subset has no numeric bound keyword)',
    value: (() => {
      const value = validReceiptValue();
      const acts = value.acts as Record<string, { installer: { exitCode: number } }>;
      acts['claude-code']!.installer.exitCode = 999;
      return value;
    })(),
  },
  {
    name: 'acts with no harness at all (the schema subset has no minProperties)',
    value: { ...validReceiptValue(), acts: {} },
  },
  {
    name: 'source.locator carrying a query string (the schema subset has no such content check)',
    value: (() => {
      const value = validReceiptValue();
      (value.source as { locator: string }).locator = 'https://mcp.figma.com/mcp?x=1';
      return value;
    })(),
  },
];

describe('schema-subset limits: parseReceipt refuses what the schema alone cannot express', () => {
  it.each(SCHEMA_ONLY_FIXTURES)('$name', async ({ value }) => {
    const validate = await loadValidate();
    const schema = await loadSchema();
    expect(validate(schema, value).ok).toBe(true);
    expect(parseReceipt(JSON.stringify(value)).status).toBe('invalid');
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

describe('RECEIPT_SCHEMA_VERSION / RECEIPTS_DIR_REL', () => {
  it('names schema version 1 and the .rig/receipts directory', () => {
    expect(RECEIPT_SCHEMA_VERSION).toBe(1);
    expect(RECEIPTS_DIR_REL).toBe('.rig/receipts');
  });
});
