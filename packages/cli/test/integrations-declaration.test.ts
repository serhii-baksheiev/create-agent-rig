import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DECLARATION_REL,
  DECLARATION_SCHEMA_VERSION,
  parseDeclaration,
  serializeDeclaration,
  type DeclaredIntegration,
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

const loadSchema = async (): Promise<unknown> =>
  JSON.parse(
    await readFile(
      path.join(repoRoot, 'contracts', 'integrations', 'v1', 'declaration.schema.json'),
      'utf8',
    ),
  ) as unknown;

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

  it('voids the whole file on a control character anywhere in the JSON', () => {
    const raw = file([{ id: 'gamma-board', version: '1.0.0\u0007' }]);
    expect(parseDeclaration(raw, testRegistry).status).toBe('invalid');
  });

  it('voids the whole file when it is larger than 64 KiB', () => {
    const raw = file([{ id: 'gamma-board' }]).slice(0, -2) + ' '.repeat(70 * 1024) + ']}';
    expect(parseDeclaration(raw, testRegistry).status).toBe('invalid');
  });
});

describe('the declaration.schema.json oracle (RP-22 S1)', () => {
  it('every accepted fixture validates, and the two schema-shape-invalid fixtures do not', async () => {
    const validate = await loadValidate();
    const schema = await loadSchema();

    const acceptedFixtures = [
      { schemaVersion: 1, integrations: [] },
      { schemaVersion: 1, integrations: [{ id: 'gamma-board' }] },
      {
        schemaVersion: 1,
        integrations: [
          { id: 'gamma-board', required: true, version: '1.2.3', harnesses: ['claude-code'] },
        ],
      },
    ];
    for (const fixture of acceptedFixtures) {
      expect(validate(schema, fixture), JSON.stringify(fixture)).toEqual({ ok: true, errors: [] });
    }

    // Duplicate ids and control characters are semantic, not shape, so they
    // are pinned by "whole file invalid" above, not by this shape oracle.
    const shapeInvalidFixtures: unknown[] = [
      { schemaVersion: 2, integrations: [] },
      { schemaVersion: 1, integrations: { id: 'gamma-board' } },
      { schemaVersion: 1, integrations: [{ id: 'gamma-board', command: 'rm -rf /' }] },
    ];
    for (const fixture of shapeInvalidFixtures) {
      expect(validate(schema, fixture).ok, JSON.stringify(fixture)).toBe(false);
    }
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
