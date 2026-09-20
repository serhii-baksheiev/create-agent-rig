import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REGISTRY,
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

  it('every shipped descriptor passes validateDescriptor, has an https docsUrl and a verifiedOn date', () => {
    for (const descriptor of REGISTRY) {
      expect(validateDescriptor(descriptor), descriptor.id).toEqual({ ok: true });
      expect(descriptor.source.docsUrl.startsWith('https://'), descriptor.id).toBe(true);
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
});

describe('structural: no process spawn, no network', () => {
  it('registry.ts and declaration.ts import neither child_process nor any net module', async () => {
    const files = [
      path.join(repoRoot, 'packages', 'cli', 'src', 'integrations', 'registry.ts'),
      path.join(repoRoot, 'packages', 'cli', 'src', 'integrations', 'declaration.ts'),
    ];
    for (const file of files) {
      const code = stripComments(await readFile(file, 'utf8'));
      expect(code, file).not.toMatch(/child_process/);
      expect(code, file).not.toMatch(/(?:^|[^-\w])net['"]/);
      expect(code, file).not.toMatch(/\bnode:net\b/);
      expect(code, file).not.toMatch(/\bexecFile\b|\bspawn\b|\bexec\(/);
    }
  });
});
