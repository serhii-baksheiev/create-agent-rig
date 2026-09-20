import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DECLARATION_REL,
  DECLARATION_SCHEMA_VERSION,
  KNOWN_ENTRY_KEYS,
  VERSION_PATTERN,
  parseDeclaration,
  serializeDeclaration,
  type DeclaredIntegration,
  type RejectionReason,
} from '../src/integrations/declaration.js';
import { REGISTRY, type ProviderDescriptor } from '../src/integrations/registry.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const schemaSubsetPath = path.join(repoRoot, 'scripts', 'lib', 'json-schema-subset.mjs');

interface ValidationResult {
  ok: boolean;
  errors: string[];
}
type Validate = (schema: unknown, value: unknown) => ValidationResult;

const loadValidate = async (): Promise<Validate> =>
  ((await import(pathToFileURL(schemaSubsetPath).href)) as { validate: Validate }).validate;

interface DeclarationSchema {
  additionalProperties: boolean;
  properties: {
    integrations: {
      items: {
        additionalProperties: boolean;
        properties: { version: { pattern: string } } & Record<string, unknown>;
      };
    };
  };
}

const loadSchema = async (): Promise<DeclarationSchema> =>
  JSON.parse(
    await readFile(
      path.join(repoRoot, 'contracts', 'integrations', 'v1', 'declaration.schema.json'),
      'utf8',
    ),
  ) as DeclarationSchema;

// An injected registry, independent of REGISTRY, so the parser's rules are
// pinned without depending on what the shipped matrix happens to contain.
const alphaMethodology: ProviderDescriptor = {
  id: 'alpha-methodology',
  displayName: 'Alpha',
  capability: 'methodology',
  exclusiveGroup: 'methodology',
  mode: 'external-installer',
  source: {
    kind: 'https',
    locator: 'https://alpha.example/install.sh',
    official: true,
    verifiedOn: '2026-01-01',
    docsUrl: 'https://alpha.example/docs',
  },
  license: { kind: 'spdx', id: 'MIT' },
  versionPolicy: { kind: 'pinned', default: '1.0.0' },
  routes: { 'claude-code': { route: 'external-installer', automation: 'automatic' } },
  stability: 'supported',
};

const betaMethodology: ProviderDescriptor = {
  ...alphaMethodology,
  id: 'beta-methodology',
  displayName: 'Beta',
};

const gammaBoard: ProviderDescriptor = {
  id: 'gamma-board',
  displayName: 'Gamma',
  capability: 'board',
  mode: 'hosted-service',
  source: {
    kind: 'https',
    locator: 'https://gamma.example/mcp',
    official: true,
    verifiedOn: '2026-01-01',
    docsUrl: 'https://gamma.example/docs',
  },
  license: { kind: 'spdx', id: 'MIT' },
  versionPolicy: { kind: 'floating', reason: 'fixture' },
  routes: {
    'claude-code': { route: 'mcp-config', automation: 'automatic' },
    codex: { route: 'guided-manual', automation: 'guided' },
  },
  stability: 'supported',
};

const noLicenseProvider: ProviderDescriptor = {
  ...gammaBoard,
  id: 'no-license-provider',
  license: null,
};

const unofficialProvider: ProviderDescriptor = {
  ...gammaBoard,
  id: 'unofficial-provider',
  source: { ...gammaBoard.source, official: false },
};

const testRegistry: readonly ProviderDescriptor[] = [
  alphaMethodology,
  betaMethodology,
  gammaBoard,
  noLicenseProvider,
  unofficialProvider,
];

const file = (integrations: unknown[], schemaVersion: unknown = DECLARATION_SCHEMA_VERSION) =>
  JSON.stringify({ schemaVersion, integrations });

describe('parseDeclaration — acceptance', () => {
  it('accepts the documented example and returns exactly these entries', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      integrations: [
        { id: 'memory-custom-executable', required: true, harnesses: ['claude-code'] },
      ],
    });
    expect(parseDeclaration(raw, REGISTRY)).toEqual({
      status: 'ok',
      entries: [{ id: 'memory-custom-executable', required: true, harnesses: ['claude-code'] }],
      rejected: [],
    });
  });

  it('rejects an id outside the registry as not-in-matrix and accepts its neighbours', () => {
    const raw = file([{ id: 'not-a-real-provider' }, { id: 'gamma-board' }]);
    expect(parseDeclaration(raw, testRegistry)).toEqual({
      status: 'ok',
      entries: [{ id: 'gamma-board' }],
      rejected: [{ id: 'not-a-real-provider', reason: 'not-in-matrix' }],
    });
  });

  it('accepts a harnesses value at exactly the deepest legitimate nesting (a string inside harnesses[])', () => {
    // root(0) -> integrations[](1) -> entry{}(2) -> harnesses[](3) -> "claude-code"(4):
    // exactly MAX_DECLARATION_DEPTH, the boundary the depth-bound tests below probe from the other side.
    const raw = file([{ id: 'gamma-board', harnesses: ['claude-code'] }]);
    expect(parseDeclaration(raw, testRegistry)).toEqual({
      status: 'ok',
      entries: [{ id: 'gamma-board', harnesses: ['claude-code'] }],
      rejected: [],
    });
  });
});

describe('parseDeclaration — refused keys', () => {
  it.each([
    ['command', { command: 'rm -rf /' }, 'arbitrary-command-refused'],
    ['args', { args: ['--force'] }, 'arbitrary-command-refused'],
    ['env', { env: { TOKEN: 'x' } }, 'arbitrary-command-refused'],
    [
      'source',
      { source: { kind: 'https', locator: 'https://evil.example' } },
      'non-official-source',
    ],
    ['url', { url: 'https://evil.example' }, 'non-official-source'],
    ['headers', { headers: { Authorization: 'Bearer x' } }, 'non-official-source'],
  ] as const)('refuses key "%s" with the named reason', (_key, extra, reason) => {
    const raw = file([{ id: 'gamma-board', ...extra }]);
    expect(parseDeclaration(raw, testRegistry)).toEqual({
      status: 'ok',
      entries: [],
      rejected: [{ id: 'gamma-board', reason }],
    });
  });

  it('refuses an unrecognised key as malformed', () => {
    const raw = file([{ id: 'gamma-board', unexpectedField: true }]);
    expect(parseDeclaration(raw, testRegistry)).toEqual({
      status: 'ok',
      entries: [],
      rejected: [{ id: 'gamma-board', reason: 'malformed' }],
    });
  });

  // RP-22 gate cycle 1 advisory (a): the reason must not depend on JSON key
  // order, and the most severe reason present wins.
  it.each([
    ['command listed before headers', { command: 'x', headers: {} }],
    ['headers listed before command', { headers: {}, command: 'x' }],
  ])('reports the most severe refused key regardless of order (%s)', (_label, extra) => {
    const raw = file([{ id: 'gamma-board', ...extra }]);
    expect(parseDeclaration(raw, testRegistry)).toEqual({
      status: 'ok',
      entries: [],
      rejected: [{ id: 'gamma-board', reason: 'arbitrary-command-refused' }],
    });
  });

  it.each([
    ['headers listed before an unrecognised key', { headers: {}, unexpectedField: true }],
    ['an unrecognised key listed before headers', { unexpectedField: true, headers: {} }],
  ])('non-official-source outranks malformed regardless of order (%s)', (_label, extra) => {
    const raw = file([{ id: 'gamma-board', ...extra }]);
    expect(parseDeclaration(raw, testRegistry)).toEqual({
      status: 'ok',
      entries: [],
      rejected: [{ id: 'gamma-board', reason: 'non-official-source' }],
    });
  });

  // advisory (a), second half: a refused key is reported as itself even when
  // the id is ALSO outside the registry — a typo'd id must never mask a
  // smuggling attempt by demoting it to the merely-unrecognised "not-in-matrix".
  it("a refused key wins over not-in-matrix, so a smuggled command is never hidden behind a typo'd id", () => {
    const raw = file([{ id: 'totally-not-a-real-provider', command: 'rm -rf /' }]);
    expect(parseDeclaration(raw, testRegistry)).toEqual({
      status: 'ok',
      entries: [],
      rejected: [{ id: 'totally-not-a-real-provider', reason: 'arbitrary-command-refused' }],
    });
  });
});

describe('parseDeclaration — descriptor validation reasons', () => {
  it('a descriptor with no licence is unknown-license', () => {
    const raw = file([{ id: 'no-license-provider' }]);
    expect(parseDeclaration(raw, testRegistry)).toEqual({
      status: 'ok',
      entries: [],
      rejected: [{ id: 'no-license-provider', reason: 'unknown-license' }],
    });
  });

  it('a descriptor with official false is non-official-source', () => {
    const raw = file([{ id: 'unofficial-provider' }]);
    expect(parseDeclaration(raw, testRegistry)).toEqual({
      status: 'ok',
      entries: [],
      rejected: [{ id: 'unofficial-provider', reason: 'non-official-source' }],
    });
  });
});

describe('parseDeclaration — malformed scalars', () => {
  it('refuses a version that fails the pin pattern', () => {
    const raw = file([{ id: 'gamma-board', version: 'not a version!' }]);
    expect(parseDeclaration(raw, testRegistry)).toEqual({
      status: 'ok',
      entries: [],
      rejected: [{ id: 'gamma-board', reason: 'malformed' }],
    });
  });

  it('accepts a version that matches the pin pattern', () => {
    const raw = file([{ id: 'gamma-board', version: '1.2.3' }]);
    expect(parseDeclaration(raw, testRegistry)).toEqual({
      status: 'ok',
      entries: [{ id: 'gamma-board', version: '1.2.3' }],
      rejected: [],
    });
  });

  it('refuses a harnesses value that names a harness the descriptor has no route for', () => {
    // alpha-methodology routes only claude-code
    const raw = file([{ id: 'alpha-methodology', harnesses: ['codex'] }]);
    expect(parseDeclaration(raw, testRegistry)).toEqual({
      status: 'ok',
      entries: [],
      rejected: [{ id: 'alpha-methodology', reason: 'malformed' }],
    });
  });

  it('accepts a harnesses value that is a subset of the descriptor routes', () => {
    const raw = file([{ id: 'gamma-board', harnesses: ['codex'] }]);
    expect(parseDeclaration(raw, testRegistry)).toEqual({
      status: 'ok',
      entries: [{ id: 'gamma-board', harnesses: ['codex'] }],
      rejected: [],
    });
  });

  // advisory (e), parser half: the schema cannot express uniqueItems (see the
  // shared file-shape fixtures below), so the parser refuses duplicates itself.
  it('refuses a harnesses array carrying a duplicate entry, as malformed', () => {
    const raw = file([{ id: 'gamma-board', harnesses: ['codex', 'codex'] }]);
    expect(parseDeclaration(raw, testRegistry)).toEqual({
      status: 'ok',
      entries: [],
      rejected: [{ id: 'gamma-board', reason: 'malformed' }],
    });
  });
});

describe('parseDeclaration — exclusive group conflicts', () => {
  it('rejects two methodology providers identically for either input order', () => {
    const forward = parseDeclaration(
      file([{ id: 'alpha-methodology' }, { id: 'beta-methodology' }]),
      testRegistry,
    );
    const backward = parseDeclaration(
      file([{ id: 'beta-methodology' }, { id: 'alpha-methodology' }]),
      testRegistry,
    );
    const expected = {
      status: 'ok',
      entries: [],
      rejected: [
        {
          id: 'alpha-methodology',
          reason: 'exclusive-group-conflict',
          message: 'exclusive group conflict: alpha-methodology, beta-methodology',
        },
        {
          id: 'beta-methodology',
          reason: 'exclusive-group-conflict',
          message: 'exclusive group conflict: alpha-methodology, beta-methodology',
        },
      ],
    };
    expect(forward).toEqual(expected);
    expect(backward).toEqual(expected);
  });

  it('does not conflict a lone methodology provider with itself', () => {
    const raw = file([{ id: 'alpha-methodology' }]);
    expect(parseDeclaration(raw, testRegistry)).toEqual({
      status: 'ok',
      entries: [{ id: 'alpha-methodology' }],
      rejected: [],
    });
  });
});

describe('parseDeclaration — whole file invalid', () => {
  it('voids the whole file when it is not JSON', () => {
    const result = parseDeclaration('not json at all', testRegistry);
    expect(result.status).toBe('invalid');
  });

  it('voids the whole file on a wrong schemaVersion', () => {
    const raw = file([{ id: 'gamma-board' }], 2);
    expect(parseDeclaration(raw, testRegistry).status).toBe('invalid');
  });

  it('voids the whole file when integrations is not an array', () => {
    const raw = JSON.stringify({ schemaVersion: 1, integrations: { id: 'gamma-board' } });
    expect(parseDeclaration(raw, testRegistry).status).toBe('invalid');
  });

  it('voids the whole file on a duplicate id', () => {
    const raw = file([{ id: 'gamma-board' }, { id: 'gamma-board' }]);
    expect(parseDeclaration(raw, testRegistry).status).toBe('invalid');
  });

  it('caps the echoed id in the duplicate-id error message (advisory (f))', () => {
    const longId = 'x'.repeat(200);
    const raw = file([{ id: longId }, { id: longId }]);
    const result = parseDeclaration(raw, testRegistry);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.error).toContain(`${'x'.repeat(64)}…`);
      expect(result.error).not.toContain('x'.repeat(65));
    }
  });

  it('voids the whole file on a control character anywhere in the JSON', () => {
    const raw = file([{ id: 'gamma-board', version: '1.0.0\u0007' }]);
    expect(parseDeclaration(raw, testRegistry).status).toBe('invalid');
  });

  it('voids the whole file when it is larger than 64 KiB', () => {
    const raw = file([{ id: 'gamma-board' }]).slice(0, -2) + ' '.repeat(70 * 1024) + ']}';
    expect(parseDeclaration(raw, testRegistry).status).toBe('invalid');
  });

  // RP-22 gate cycle 1, blocker 2: a root key outside {schemaVersion,
  // integrations} used to be silently ignored while the shipped schema
  // refused it. The error names the allowed key CLASS, never the offending
  // key's own (attacker-controlled, unbounded) text.
  it('voids the whole file on a root key outside {schemaVersion, integrations}, without echoing it', () => {
    const raw = JSON.stringify({ schemaVersion: 1, integrations: [], command: 'rm -rf /' });
    const result = parseDeclaration(raw, testRegistry);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.error).toMatch(/root key/);
      expect(result.error).not.toContain('rm -rf');
    }
  });
});

// RP-22 gate cycle 1, blocker 1: `hasControlCharacterDeep` used to recurse
// over the parsed value with no depth bound, ahead of every shape check, and
// threw RangeError on a hostile but small (well under 64 KiB) deeply nested
// value. `parseDeclaration` must be TOTAL — every one of these returns a
// ParseResult, never a throw.
describe('parseDeclaration is total — depth-bounded, never throws', () => {
  const nestedArray = (levels: number, leaf: unknown): string =>
    '['.repeat(levels) + JSON.stringify(leaf) + ']'.repeat(levels);

  it('voids a declaration nesting ~6000 levels inside a harnesses value (the gate-1 regression), instead of throwing', () => {
    const hostileHarnesses = nestedArray(6000, 'claude-code');
    const raw = `{"schemaVersion":1,"integrations":[{"id":"gamma-board","harnesses":${hostileHarnesses}}]}`;
    // ~12 KiB, well under the 64 KiB cap — the cap alone does not bound this.
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThan(64 * 1024);

    let result: ReturnType<typeof parseDeclaration> | undefined;
    expect(() => {
      result = parseDeclaration(raw, testRegistry);
    }).not.toThrow();
    expect(result?.status).toBe('invalid');
    if (result?.status === 'invalid') {
      expect(result.error).toMatch(/nests deeper than 4/);
    }
  });

  it('a fuzz list of hostile shapes never makes parseDeclaration throw', () => {
    const hostileShapes: Record<string, string> = {
      'deeply nested arrays (6000 levels)': nestedArray(6000, 0),
      'deeply nested objects (6000 levels)': `${'{"a":'.repeat(6000)}0${'}'.repeat(6000)}`,
      // ~28,000 single-digit array elements: breadth, not depth, and sized to
      // stay under the 64 KiB cap so it actually reaches the depth/control
      // walk instead of being turned away by the size check first (2 bytes
      // per element, comma included, keeps ~28,000 comfortably under 65,536).
      'many shallow array elements within the byte cap': `[${new Array(28_000).fill('0').join(',')}]`,
      'a 60 KiB top-level string': JSON.stringify('x'.repeat(60 * 1024)),
      'a non-JSON string with embedded control bytes': 'not json at all \u0000 ￿',
      'an empty string': '',
    };

    for (const [name, raw] of Object.entries(hostileShapes)) {
      let result: ReturnType<typeof parseDeclaration> | undefined;
      expect(() => {
        result = parseDeclaration(raw, testRegistry);
      }, name).not.toThrow();
      expect(result, name).toBeDefined();
      expect(['ok', 'invalid'], name).toContain(result?.status);
    }
  });
});

type FileShapeFixture = { name: string; value: unknown; accepted: boolean };

/**
 * Shared between `parseDeclaration` and the schema oracle, so the two
 * enforcement layers cannot silently drift apart the way they did in gate
 * cycle 1 (blocker 2: the schema refused a root key `parseDeclaration`
 * ignored). Every fixture here runs through BOTH, and is accepted or refused
 * identically at the FILE level by both layers.
 *
 * Two classes of input are deliberately absent from this shared list, because
 * for each of them the two layers legitimately disagree about which LEVEL the
 * refusal happens at, so "the same fixture, judged the same way by both"
 * would be the wrong shape of test:
 *
 * 1. A duplicate id. `scripts/lib/json-schema-subset.mjs`'s supported
 *    keyword set (`type`, `properties`, `required`, `additionalProperties`,
 *    `enum`, `const`, `items`, `pattern`, `minLength`) has nothing equivalent
 *    to `uniqueItems` across a whole array, so a duplicate id cannot be
 *    expressed as a schema-shape violation at all — it is pinned on the
 *    parser side alone, by "whole file invalid" above.
 * 2. An entry-level refusal (a refused key, a malformed scalar). The schema
 *    has no way to express "this one array element is invalid but the
 *    document as a whole still parses" — `additionalProperties: false` on an
 *    entry makes the WHOLE document fail schema validation, while the parser
 *    reports the file as `status: 'ok'` with that one entry moved to
 *    `rejected`. These are pinned together, on purpose, by
 *    `SCHEMA_ONLY_ENTRY_FIXTURES` below (RP-22 gate cycle 2, blocker 1) —
 *    each fixture there asserts BOTH the schema's file-level refusal and the
 *    parser's specific per-entry reason, so the correspondence between the
 *    two layers stays checked instead of merely assumed.
 */
const FILE_SHAPE_FIXTURES: readonly FileShapeFixture[] = [
  {
    name: 'an empty integrations array',
    value: { schemaVersion: 1, integrations: [] },
    accepted: true,
  },
  {
    name: 'one well-formed entry with every optional field',
    value: {
      schemaVersion: 1,
      integrations: [
        {
          id: 'gamma-board',
          required: true,
          version: '1.2.3',
          harnesses: ['claude-code', 'codex'],
        },
      ],
    },
    accepted: true,
  },
  { name: 'a wrong schemaVersion', value: { schemaVersion: 2, integrations: [] }, accepted: false },
  {
    name: 'integrations that is not an array',
    value: { schemaVersion: 1, integrations: { id: 'gamma-board' } },
    accepted: false,
  },
  {
    name: 'an unrecognised root key',
    value: { schemaVersion: 1, integrations: [], command: 'rm -rf /' },
    accepted: false,
  },
];

describe('file-level shape: parseDeclaration and the schema oracle agree on one shared fixture list', () => {
  it.each(FILE_SHAPE_FIXTURES)('$name', async ({ value, accepted }) => {
    const validate = await loadValidate();
    const schema = await loadSchema();
    const raw = JSON.stringify(value);

    const parsed = parseDeclaration(raw, testRegistry);
    expect(parsed.status).toBe(accepted ? 'ok' : 'invalid');
    if (parsed.status === 'ok') expect(parsed.rejected).toEqual([]);

    expect(validate(schema, value).ok).toBe(accepted);
  });
});

// RP-22 gate cycle 2, blocker 1: the schema's `additionalProperties: false`
// closure over an entry's keys had no test of its own — deleting it left all
// (then) 69 tests green, because KNOWN_ENTRY_KEYS (the parser's closure) and
// the schema's `items.properties` keys are one fact spelled twice, with
// nothing checking the two spellings still agree.
describe('the schema and KNOWN_ENTRY_KEYS spell the same entry-key closure once', () => {
  it("KNOWN_ENTRY_KEYS equals the schema's entry property keys, and both layers close the object", async () => {
    const schema = await loadSchema();
    const itemsSchema = schema.properties.integrations.items;
    expect(new Set(Object.keys(itemsSchema.properties))).toEqual(KNOWN_ENTRY_KEYS);
    expect(itemsSchema.additionalProperties).toBe(false);
    expect(schema.additionalProperties).toBe(false);
  });
});

type SchemaOnlyEntryFixture = { name: string; value: unknown; parserReason: RejectionReason };

/**
 * Exception class 2 from {@link FILE_SHAPE_FIXTURES}'s docstring: each of
 * these makes the WHOLE document fail the schema (an entry carries a key, or
 * a value shape, `additionalProperties`/`properties`/`pattern` refuses) while
 * `parseDeclaration` reports the file as `ok` with that one entry rejected
 * for a specific, literal reason. Asserting both sides together is what turns
 * "the two layers agree this input is bad, in their own way" from an assumed
 * property into a checked one.
 */
const SCHEMA_ONLY_ENTRY_FIXTURES: readonly SchemaOnlyEntryFixture[] = [
  {
    name: 'an entry carrying the refused command key',
    value: { schemaVersion: 1, integrations: [{ id: 'gamma-board', command: 'rm -rf /' }] },
    parserReason: 'arbitrary-command-refused',
  },
  {
    name: 'an entry carrying an unrecognised key',
    value: { schemaVersion: 1, integrations: [{ id: 'gamma-board', unexpectedField: true }] },
    parserReason: 'malformed',
  },
  {
    name: 'an entry with a non-boolean required',
    value: { schemaVersion: 1, integrations: [{ id: 'gamma-board', required: 'yes' }] },
    parserReason: 'malformed',
  },
  {
    name: 'an entry with an out-of-pattern version',
    value: { schemaVersion: 1, integrations: [{ id: 'gamma-board', version: 'not a version!' }] },
    parserReason: 'malformed',
  },
];

describe('entry-level refusals: the schema fails the whole document while the parser rejects just the entry', () => {
  it.each(SCHEMA_ONLY_ENTRY_FIXTURES)('$name', async ({ value, parserReason }) => {
    const validate = await loadValidate();
    const schema = await loadSchema();
    expect(validate(schema, value).ok).toBe(false);

    const parsed = parseDeclaration(JSON.stringify(value), testRegistry);
    expect(parsed.status).toBe('ok');
    if (parsed.status === 'ok') {
      expect(parsed.rejected).toEqual([{ id: 'gamma-board', reason: parserReason }]);
    }
  });
});

describe('the version pin pattern has one spelling (advisory (e))', () => {
  it('declaration.ts VERSION_PATTERN and declaration.schema.json carry the identical pattern string', async () => {
    const schema = await loadSchema();
    expect(VERSION_PATTERN.source).toBe(
      schema.properties.integrations.items.properties.version.pattern,
    );
  });
});

describe('serializeDeclaration', () => {
  const entries: DeclaredIntegration[] = [
    { id: 'gamma-board', required: false, version: '1.2.3', harnesses: ['claude-code'] },
    { id: 'alpha-methodology' },
  ];

  it('serializes to exactly these bytes', () => {
    const expected =
      '{\n' +
      '  "schemaVersion": 1,\n' +
      '  "integrations": [\n' +
      '    {\n' +
      '      "id": "alpha-methodology"\n' +
      '    },\n' +
      '    {\n' +
      '      "id": "gamma-board",\n' +
      '      "required": false,\n' +
      '      "version": "1.2.3",\n' +
      '      "harnesses": [\n' +
      '        "claude-code"\n' +
      '      ]\n' +
      '    }\n' +
      '  ]\n' +
      '}\n';
    expect(serializeDeclaration(entries)).toBe(expected);
  });

  it('parse ∘ serialize is stable', () => {
    const serialized = serializeDeclaration(entries);
    const parsed = parseDeclaration(serialized, testRegistry);
    expect(parsed).toEqual({
      status: 'ok',
      entries: [
        { id: 'alpha-methodology' },
        { id: 'gamma-board', required: false, version: '1.2.3', harnesses: ['claude-code'] },
      ],
      rejected: [],
    });
  });
});

describe('DECLARATION_REL', () => {
  it('names .rig/integrations.json', () => {
    expect(DECLARATION_REL).toBe('.rig/integrations.json');
  });
});
