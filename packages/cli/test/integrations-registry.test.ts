import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REGISTRY,
  isHttpsUrl,
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

  it('tolerates a non-https locator when source.kind is not https', () => {
    expect(
      validateDescriptor({
        ...baseDescriptor,
        source: { ...baseDescriptor.source, kind: 'github', locator: 'owner/repo' },
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

describe('structural: what registry.ts and declaration.ts may import', () => {
  // Text scan, not a parser: `stripComments` and every regex below are blind
  // to a specifier or call assembled at runtime (a template literal, string
  // concatenation, `["node:" + "fs"]`, `globalThis["fetch"]`) — see
  // test/template/lib/source-scan.ts's own header. Good enough here because
  // both files are hand-authored, reviewed source, not a code-generation
  // target. The checks: only the allow-listed `from '...'` specifiers; no
  // `require(`, dynamic `import(`, `fetch(`, `createRequire`, or
  // `process.binding` (a lower-level escape hatch to the same native
  // capabilities `require`/`import()` reach); no bare side-effect import
  // (`import 'x';` — no binding, so the specifier-allow-list loop above never
  // sees it); no re-export (`export … from '...'` — a second way to pull in
  // a module the specifier loop does not walk).
  const ALLOWED_IMPORT_SPECIFIERS = new Set(['../lib/safe-text.js', './registry.js']);

  it('registry.ts and declaration.ts import only their declared relative modules, and never require, dynamically import, fetch, createRequire, process.binding, bare-import, or re-export', async () => {
    const files = [
      path.join(repoRoot, 'packages', 'cli', 'src', 'integrations', 'registry.ts'),
      path.join(repoRoot, 'packages', 'cli', 'src', 'integrations', 'declaration.ts'),
    ];
    for (const file of files) {
      const code = stripComments(await readFile(file, 'utf8'));
      const specifiers = [...code.matchAll(/\bimport\s+[^;]*?\bfrom\s+['"]([^'"]+)['"]/g)].map(
        (match) => match[1],
      );
      for (const specifier of specifiers) {
        expect(ALLOWED_IMPORT_SPECIFIERS.has(specifier!), `${file} imports "${specifier}"`).toBe(
          true,
        );
      }
      expect(code, file).not.toMatch(/\brequire\s*\(/);
      expect(code, file).not.toMatch(/\bimport\s*\(/);
      expect(code, file).not.toMatch(/\bfetch\s*\(/);
      expect(code, file).not.toMatch(/\bcreateRequire\b/);
      expect(code, file).not.toMatch(/\bprocess\s*\.\s*binding\b/);
      // A bare side-effect import carries no `from`, so it never appears in
      // `specifiers` above; caught here instead.
      expect(code, file).not.toMatch(/\bimport\s*['"]/);
      // A re-export pulls in a module without ever being an `import` at all.
      expect(code, file).not.toMatch(/\bexport\b[^;]*\bfrom\s*['"]/);
    }
  });

  it('registry.ts has no imports at all, and declaration.ts imports exactly its two siblings', async () => {
    const registryCode = stripComments(
      await readFile(
        path.join(repoRoot, 'packages', 'cli', 'src', 'integrations', 'registry.ts'),
        'utf8',
      ),
    );
    expect([...registryCode.matchAll(/\bimport\b/g)]).toHaveLength(0);

    const declarationCode = stripComments(
      await readFile(
        path.join(repoRoot, 'packages', 'cli', 'src', 'integrations', 'declaration.ts'),
        'utf8',
      ),
    );
    const specifiers = [
      ...declarationCode.matchAll(/\bimport\s+[^;]*?\bfrom\s+['"]([^'"]+)['"]/g),
    ].map((match) => match[1]);
    expect(new Set(specifiers)).toEqual(ALLOWED_IMPORT_SPECIFIERS);
  });
});
