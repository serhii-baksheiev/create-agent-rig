import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GITHUB_LOCATOR_PATTERN,
  MARKETPLACE_LOCATOR_PATTERN,
  MAX_LICENSE_ID_LENGTH,
  MAX_LOCATOR_LENGTH,
  NPM_LOCATOR_PATTERN,
  PYPI_LOCATOR_PATTERN,
  REGISTRY,
  SPDX_EXPRESSION_PATTERN,
  deepFreeze,
  isHttpsUrl,
  isRealDateString,
  isValidLocator,
  isValidSpdxExpression,
  validateDescriptor,
  type ProviderDescriptor,
} from '../src/integrations/registry.js';
import { stripComments } from '../../../test/template/lib/source-scan.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const baseDescriptor: ProviderDescriptor = {
  id: 'fixture-provider',
  displayName: 'Fixture Provider',
  capability: 'board',
  mode: 'hosted-service',
  source: {
    kind: 'https',
    locator: 'https://fixture.example/mcp',
    official: true,
    verifiedOn: '2026-01-01',
    docsUrl: 'https://fixture.example/docs',
  },
  license: { kind: 'spdx', id: 'MIT' },
  versionPolicy: { kind: 'floating', reason: 'fixture' },
  routes: { 'claude-code': { route: 'mcp-config', automation: 'automatic' } },
  stability: 'supported',
};

describe('isHttpsUrl', () => {
  it('accepts a plain https URL', () => {
    expect(isHttpsUrl('https://example.com/docs')).toBe(true);
  });

  it('accepts any casing of the scheme, because URL itself lower-cases it', () => {
    expect(isHttpsUrl('HTTPS://example.com')).toBe(true);
  });

  it('refuses a URL carrying userinfo (a credential-shaped value has no business in a docs/license link)', () => {
    expect(isHttpsUrl('https://user:pass@example.com')).toBe(false);
    expect(isHttpsUrl('https://user@example.com')).toBe(false);
  });

  it('refuses a bare "https://" with no host', () => {
    expect(isHttpsUrl('https://')).toBe(false);
  });

  it('refuses a non-https scheme', () => {
    expect(isHttpsUrl('http://example.com')).toBe(false);
    expect(isHttpsUrl('ftp://example.com')).toBe(false);
  });

  it('refuses a value that is not a URL at all', () => {
    expect(isHttpsUrl('not a url')).toBe(false);
    expect(isHttpsUrl('')).toBe(false);
  });
});

describe('isValidLocator — the one grammar shared by validateDescriptor and receipt.ts', () => {
  describe('github: owner/repo', () => {
    it.each([
      ['a plain owner/repo', 'serhii-baksheiev/create-agent-rig'],
      ['single-character owner and repo', 'a/b'],
    ])('accepts %s', (_label, locator) => {
      expect(isValidLocator('github', locator)).toBe(true);
    });

    it.each([
      ['an absolute unix path', '/etc/passwd'],
      ['a parent-traversal segment as the whole repo name', 'owner/..'],
      ['a Windows absolute path', 'C:\\Users\\evil\\tool.exe'],
      ['a URL scheme', 'https://github.com/owner/repo'],
      ['userinfo-shaped text', 'user@host'],
      ['a bare hostname, no slash at all', 'example.com'],
      ['whitespace', 'owner /repo'],
      ['no slash at all', 'ownerrepo'],
      ['two slashes', 'owner/repo/extra'],
      ['empty string', ''],
      ['longer than the 128-character cap', 'a'.repeat(129)],
    ])('refuses %s', (_label, locator) => {
      expect(isValidLocator('github', locator)).toBe(false);
    });
  });

  describe('npm: name or @scope/name', () => {
    it.each([
      ['an unscoped name', 'left-pad'],
      ['a scoped name', '@rig/cli'],
    ])('accepts %s', (_label, locator) => {
      expect(isValidLocator('npm', locator)).toBe(true);
    });

    it.each([
      ['uppercase (npm names are lowercase)', 'Left-Pad'],
      ['an absolute path', '/etc/passwd'],
      ['a parent-traversal segment', '..'],
      ['a bare @ with nothing after it', '@'],
      ['userinfo-shaped text', 'user@host'],
      ['a Windows path', 'C:\\Users\\evil'],
      ['a URL scheme', 'https://registry.npmjs.org/left-pad'],
    ])('refuses %s', (_label, locator) => {
      expect(isValidLocator('npm', locator)).toBe(false);
    });
  });

  describe('pypi: one opaque name segment', () => {
    it('accepts a plain project name', () => {
      expect(isValidLocator('pypi', 'requests')).toBe(true);
    });

    it.each([
      ['an absolute path', '/etc/passwd'],
      ['a slash at all', 'a/b'],
      ['userinfo-shaped text', 'user@host'],
      ['a Windows path', 'C:\\Users\\evil'],
    ])('refuses %s', (_label, locator) => {
      expect(isValidLocator('pypi', locator)).toBe(false);
    });
  });

  describe('marketplace: the same conservative opaque-slug shape as pypi (no real descriptor ships one yet)', () => {
    it('accepts a plain slug', () => {
      expect(isValidLocator('marketplace', 'some-extension')).toBe(true);
    });

    it.each([
      ['an @ (no two-part grammar exists yet)', 'name@marketplace'],
      ['userinfo-shaped text', 'user@host'],
      ['an absolute path', '/etc/passwd'],
    ])('refuses %s', (_label, locator) => {
      expect(isValidLocator('marketplace', locator)).toBe(false);
    });
  });

  describe('https: a real https URL with no query string or fragment', () => {
    it('accepts a plain https URL', () => {
      expect(isValidLocator('https', 'https://mcp.example.com/mcp')).toBe(true);
    });

    it.each([
      ['a query string', 'https://mcp.example.com/mcp?token=x'],
      ['a fragment', 'https://mcp.example.com/mcp#x'],
      ['a non-https scheme', 'http://mcp.example.com/mcp'],
      ['a file scheme', 'file:///etc/passwd'],
      ['userinfo', 'https://user:pass@mcp.example.com'],
      // RP-22 S3 carry-over from S2: the https branch used to accept a raw
      // space, because isHttpsUrl's real URL parse percent-encodes a space
      // into the path rather than throwing — so isValidLocator was LAXER
      // here than the schema's own `^https://[^\s?#]{1,121}$` pattern, which
      // excludes `\s` outright. `contracts/integrations/v1/receipt.schema.
      // json`'s `license.url` pattern is the oracle this closes the gap
      // against — see `integrations-receipt.test.ts` › "closed divergence
      // (whitespace): a raw space in the path now fails both the schema
      // pattern and isValidLocator".
      ['a raw space', 'https://mcp.example.com/te rms'],
      // A backslash is refused here too, but NOT because it closes a gap the
      // way the space above does — the schema's character class does not
      // exclude a backslash at all, so this makes the parser STRICTER than
      // the schema, a named divergence in the opposite direction (gate cycle
      // 1, blocker 9) — see `integrations-receipt.test.ts` › "named
      // divergence 3 (backslash): isValidLocator is STRICTER than the schema
      // pattern here — the schema's character class does not exclude a
      // backslash at all".
      ['a backslash', 'https://mcp.example.com/te\\rms'],
      // The schema's literal `^https://` prefix always refused an
      // uppercase-scheme URL; isHttpsUrl's real URL parse used to accept any
      // casing (URL itself lower-cases `.protocol`), so isValidLocator was
      // LAXER here — now closed by requiring the raw locator to literally
      // start with lowercase `https://` — see `integrations-receipt.test.ts`
      // › "closed divergence (uppercase scheme): HTTPS://… now fails
      // isValidLocator too, matching the schema pattern's literal lowercase
      // prefix".
      ['an uppercase scheme', 'HTTPS://mcp.example.com/mcp'],
    ])('refuses %s', (_label, locator) => {
      expect(isValidLocator('https', locator)).toBe(false);
    });
  });

  it('every per-kind pattern is anchored full-string (a leading or trailing hostile fragment cannot sneak in)', () => {
    for (const pattern of [
      GITHUB_LOCATOR_PATTERN,
      NPM_LOCATOR_PATTERN,
      PYPI_LOCATOR_PATTERN,
      MARKETPLACE_LOCATOR_PATTERN,
    ]) {
      expect(pattern.source.startsWith('^'), pattern.source).toBe(true);
      expect(pattern.source.endsWith('$'), pattern.source).toBe(true);
    }
  });

  it('MAX_LOCATOR_LENGTH is enforced before any per-kind pattern runs, for every kind', () => {
    const tooLong = 'a'.repeat(MAX_LOCATOR_LENGTH + 1);
    for (const kind of ['github', 'npm', 'pypi', 'marketplace'] as const) {
      expect(isValidLocator(kind, tooLong), kind).toBe(false);
    }
  });
});

describe('isValidSpdxExpression', () => {
  it.each([
    ['a single license id', 'MIT'],
    ['a license id with digits and a dot', 'Apache-2.0'],
    ['a compound OR expression', 'MIT OR Apache-2.0'],
    ['a compound AND expression', 'MIT AND Apache-2.0'],
    ['a compound WITH expression', 'GPL-2.0 WITH Classpath-exception-2.0'],
  ])('accepts %s', (_label, value) => {
    expect(isValidSpdxExpression(value)).toBe(true);
  });

  it.each([
    ['empty string', ''],
    ['longer than the 64-character cap', 'A'.repeat(MAX_LICENSE_ID_LENGTH + 1)],
    ['a stray operator with nothing after it', 'MIT OR'],
    ['a lowercase operator (SPDX operators are uppercase)', 'MIT or Apache-2.0'],
    ['a control character', 'MIT\u0007'],
    ['whitespace-only', '   '],
  ])('refuses %s', (_label, value) => {
    expect(isValidSpdxExpression(value)).toBe(false);
  });

  it('the pattern is anchored full-string', () => {
    expect(SPDX_EXPRESSION_PATTERN.source.startsWith('^')).toBe(true);
    expect(SPDX_EXPRESSION_PATTERN.source.endsWith('$')).toBe(true);
  });
});

describe('isRealDateString', () => {
  it.each([
    ['a real date', '2026-01-01'],
    ['a leap day', '2024-02-29'],
  ])('accepts %s', (_label, value) => {
    expect(isRealDateString(value)).toBe(true);
  });

  it.each([
    ['not a date at all', 'not-a-date'],
    ['a non-leap-year Feb 29', '2023-02-29'],
    ['a real-looking but non-existent date (30 Feb)', '2026-02-30'],
    ['the wrong number of digits', '2026-1-1'],
    ['empty string', ''],
  ])('refuses %s', (_label, value) => {
    expect(isRealDateString(value)).toBe(false);
  });
});

describe('validateDescriptor', () => {
  it('accepts a well-formed descriptor', () => {
    expect(validateDescriptor(baseDescriptor)).toEqual({ ok: true });
  });

  it('refuses a null license as unknown-license', () => {
    expect(validateDescriptor({ ...baseDescriptor, license: null })).toEqual({
      ok: false,
      reason: 'unknown-license',
    });
  });

  it('refuses a terms license whose url is not https, as unknown-license', () => {
    expect(
      validateDescriptor({
        ...baseDescriptor,
        license: { kind: 'terms', url: 'http://fixture.example/terms' },
      }),
    ).toEqual({ ok: false, reason: 'unknown-license' });
  });

  it('accepts a terms license whose url is https', () => {
    expect(
      validateDescriptor({
        ...baseDescriptor,
        license: { kind: 'terms', url: 'https://fixture.example/terms' },
      }),
    ).toEqual({ ok: true });
  });

  it('refuses source.official !== true as non-official-source', () => {
    expect(
      validateDescriptor({
        ...baseDescriptor,
        source: { ...baseDescriptor.source, official: false },
      }),
    ).toEqual({ ok: false, reason: 'non-official-source' });
  });

  it('refuses a non-https docsUrl as non-official-source', () => {
    expect(
      validateDescriptor({
        ...baseDescriptor,
        source: { ...baseDescriptor.source, docsUrl: 'http://fixture.example/docs' },
      }),
    ).toEqual({ ok: false, reason: 'non-official-source' });
  });

  it('refuses a non-https locator when source.kind is https, as non-official-source', () => {
    expect(
      validateDescriptor({
        ...baseDescriptor,
        source: { ...baseDescriptor.source, kind: 'https', locator: 'ftp://fixture.example/mcp' },
      }),
    ).toEqual({ ok: false, reason: 'non-official-source' });
  });

  // RP-22 gate cycle 3, cheap survivor (a): pins that the https branch of
  // validateDescriptor routes through isValidLocator('https', …), not a bare
  // isHttpsUrl(…) — reverting that branch to isHttpsUrl alone leaves both of
  // these green, since isHttpsUrl does not look at the query string or
  // fragment at all.
  it.each([
    ['a query string', 'https://fixture.example/mcp?x=1'],
    ['a fragment', 'https://fixture.example/mcp#f'],
  ])('refuses an https locator carrying %s, as non-official-source', (_label, locator) => {
    expect(
      validateDescriptor({
        ...baseDescriptor,
        source: { ...baseDescriptor.source, kind: 'https', locator },
      }),
    ).toEqual({ ok: false, reason: 'non-official-source' });
  });

  it('tolerates a non-https locator when source.kind is not https', () => {
    expect(
      validateDescriptor({
        ...baseDescriptor,
        source: { ...baseDescriptor.source, kind: 'github', locator: 'owner/repo' },
      }),
    ).toEqual({ ok: true });
  });

  it('refuses a github-kind locator that is not owner/repo shaped, as malformed', () => {
    expect(
      validateDescriptor({
        ...baseDescriptor,
        source: { ...baseDescriptor.source, kind: 'github', locator: '/etc/passwd' },
      }),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a spdx license id that is not a bounded SPDX-expression-shaped string, as malformed', () => {
    expect(
      validateDescriptor({
        ...baseDescriptor,
        license: { kind: 'spdx', id: 'not a real spdx id!' },
      }),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('accepts a compound spdx license expression', () => {
    expect(
      validateDescriptor({
        ...baseDescriptor,
        license: { kind: 'spdx', id: 'MIT OR Apache-2.0' },
      }),
    ).toEqual({ ok: true });
  });

  it.each([
    ['not a date at all', 'not-a-date'],
    ['a real-looking but non-existent date (30 Feb)', '2026-02-30'],
    ['the wrong number of digits', '2026-1-1'],
  ])('refuses a verifiedOn that is %s, as malformed', (_label, verifiedOn) => {
    expect(
      validateDescriptor({ ...baseDescriptor, source: { ...baseDescriptor.source, verifiedOn } }),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('accepts a real verifiedOn date, including a leap-day', () => {
    expect(
      validateDescriptor({
        ...baseDescriptor,
        source: { ...baseDescriptor.source, verifiedOn: '2024-02-29' },
      }),
    ).toEqual({ ok: true });
  });

  it('refuses external-installer mode with a floating version policy, as unpinnable-version', () => {
    expect(
      validateDescriptor({
        ...baseDescriptor,
        mode: 'external-installer',
        versionPolicy: { kind: 'floating', reason: 'fixture' },
      }),
    ).toEqual({ ok: false, reason: 'unpinnable-version' });
  });

  it('accepts external-installer mode with a pinned version policy', () => {
    expect(
      validateDescriptor({
        ...baseDescriptor,
        mode: 'external-installer',
        versionPolicy: { kind: 'pinned', default: '1.0.0' },
      }),
    ).toEqual({ ok: true });
  });
});

describe('REGISTRY', () => {
  it('holds exactly one entry in this slice: memory-custom-executable', () => {
    expect(REGISTRY.map((descriptor) => descriptor.id)).toEqual(['memory-custom-executable']);
  });

  it('every shipped descriptor passes validateDescriptor, has an https docsUrl and a real verifiedOn date', () => {
    for (const descriptor of REGISTRY) {
      expect(validateDescriptor(descriptor), descriptor.id).toEqual({ ok: true });
      expect(isHttpsUrl(descriptor.source.docsUrl), descriptor.id).toBe(true);
      expect(descriptor.source.verifiedOn, descriptor.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('routes memory-custom-executable through subsystem-manifest for both harnesses', () => {
    const memory = REGISTRY.find((descriptor) => descriptor.id === 'memory-custom-executable');
    expect(memory?.routes).toEqual({
      'claude-code': { route: 'subsystem-manifest', automation: 'automatic' },
      codex: { route: 'subsystem-manifest', automation: 'automatic' },
    });
    expect(memory?.mode).toBe('external-executable');
    expect(memory?.license).toEqual({
      kind: 'terms',
      url: 'https://github.com/serhii-baksheiev/create-agent-rig/blob/master/LICENSE',
    });
    expect(memory?.versionPolicy).toEqual({
      kind: 'floating',
      reason: 'compatibility is the handshake, not a range',
    });
  });

  it('is deeply frozen: mutating the array, an entry, or a nested object throws in strict mode', () => {
    expect(() => {
      (REGISTRY as ProviderDescriptor[]).push(REGISTRY[0]!);
    }).toThrow();
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- proving a frozen-object write throws
      (REGISTRY[0] as any).id = 'mutated';
    }).toThrow();
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- proving a frozen nested object write throws
      (REGISTRY[0]!.source as any).official = false;
    }).toThrow();
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- proving a frozen nested-of-nested object write throws
      (REGISTRY[0]!.routes as any)['claude-code'].automation = 'guided';
    }).toThrow();
  });
});

describe('deepFreeze', () => {
  // Backs the limit stated in deepFreeze's own header comment: it stops
  // descending as soon as it meets a value that is ALREADY frozen, so it
  // never looks inside one. A descriptor that reused a pre-frozen shared
  // object (rather than a fresh literal) would have its own nested contents
  // left mutable — this is that scenario, constructed directly rather than
  // relying on REGISTRY happening to contain one (RP-22 S2 carry-over).
  it('does not descend into a value that arrives already frozen, so a nested mutable property inside a pre-frozen shared object is left mutable', () => {
    const sharedChild = Object.freeze({ mutable: { value: 1 } });
    const outer = { child: sharedChild };

    deepFreeze(outer);

    expect(Object.isFrozen(outer)).toBe(true);
    expect(Object.isFrozen(sharedChild)).toBe(true); // was already frozen
    expect(Object.isFrozen(sharedChild.mutable)).toBe(false); // the stated limit
    sharedChild.mutable.value = 2; // proves it is genuinely still writable
    expect(sharedChild.mutable.value).toBe(2);
  });

  it('does descend into a fresh (not pre-frozen) nested object', () => {
    const outer = { child: { grandchild: { value: 1 } } };
    deepFreeze(outer);
    expect(Object.isFrozen(outer.child)).toBe(true);
    expect(Object.isFrozen(outer.child.grandchild)).toBe(true);
  });
});

describe('structural: what every integrations/ module may import (RP-22 S2 gate finding B5: this used to cover only registry.ts and declaration.ts)', () => {
  // Text scan, not a parser: `stripComments` and every regex below are blind
  // to a specifier or call assembled at runtime (a template literal, string
  // concatenation, `["node:" + "fs"]`, `globalThis["fetch"]`) — see
  // test/template/lib/source-scan.ts's own header. Good enough here because
  // every file below is hand-authored, reviewed source, not a code-generation
  // target. The checks: only the allow-listed `from '...'` specifiers; no
  // `require(`, dynamic `import(`, `fetch(`, `createRequire`, or
  // `process.binding` (a lower-level escape hatch to the same native
  // capabilities `require`/`import()` reach); no bare side-effect import
  // (`import 'x';` — no binding, so the specifier-allow-list loop above never
  // sees it); no re-export (`export … from '...'` — a second way to pull in
  // a module the specifier loop does not walk).
  const FILES: Record<string, ReadonlySet<string>> = {
    'registry.ts': new Set(),
    'declaration.ts': new Set(['../lib/safe-text.js', './registry.js']),
    'receipt.ts': new Set([
      '../lib/safe-text.js',
      './declaration.js',
      './registry.js',
      './state.js',
    ]),
    'state.ts': new Set(),
  };

  it('every integrations/ module imports only its declared relative modules, and never requires, dynamically imports, fetches, createRequires, process.bindings, bare-imports, or re-exports', async () => {
    for (const name of Object.keys(FILES)) {
      const file = path.join(repoRoot, 'packages', 'cli', 'src', 'integrations', name);
      const code = stripComments(await readFile(file, 'utf8'));
      const allowed = FILES[name]!;
      const specifiers = [...code.matchAll(/\bimport\s+[^;]*?\bfrom\s+['"]([^'"]+)['"]/g)].map(
        (match) => match[1],
      );
      for (const specifier of specifiers) {
        expect(allowed.has(specifier!), `${name} imports "${specifier}"`).toBe(true);
      }
      expect(code, name).not.toMatch(/\brequire\s*\(/);
      expect(code, name).not.toMatch(/\bimport\s*\(/);
      expect(code, name).not.toMatch(/\bfetch\s*\(/);
      expect(code, name).not.toMatch(/\bcreateRequire\b/);
      expect(code, name).not.toMatch(/\bprocess\s*\.\s*binding\b/);
      // A bare side-effect import carries no `from`, so it never appears in
      // `specifiers` above; caught here instead.
      expect(code, name).not.toMatch(/\bimport\s*['"]/);
      // A re-export pulls in a module without ever being an `import` at all.
      expect(code, name).not.toMatch(/\bexport\b[^;]*\bfrom\s*['"]/);
    }
  });

  it('each module imports EXACTLY its declared set — registry.ts and state.ts import nothing at all', async () => {
    for (const [name, allowed] of Object.entries(FILES)) {
      const file = path.join(repoRoot, 'packages', 'cli', 'src', 'integrations', name);
      const code = stripComments(await readFile(file, 'utf8'));
      if (allowed.size === 0) {
        expect([...code.matchAll(/\bimport\b/g)], name).toHaveLength(0);
        continue;
      }
      const specifiers = [...code.matchAll(/\bimport\s+[^;]*?\bfrom\s+['"]([^'"]+)['"]/g)].map(
        (match) => match[1],
      );
      expect(new Set(specifiers), name).toEqual(allowed);
    }
  });
});
