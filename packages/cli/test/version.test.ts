// RP-19 — the rig's OWN version handshake (the Memory half is RP-147/setup.ts,
// which already exists; this file is the rig bin's side, contract.md
// "## The version handshake": `name`, `version` and `contractVersion`, and the
// consumer compares majors of `contractVersion` alone).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RIG_CONTRACT_VERSION, packageVersion, rigHandshake } from '../src/lib/version.js';

// Same walk `templatesRoot()` uses from `src/`, one level further because this
// file lives in `test/` rather than `src/` (packages/cli/test -> repo root).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('rigHandshake (RP-19)', () => {
  it('answers schemaVersion 1, the rig name, the root package version, and contractVersion 1.0', async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };

    const result = await rigHandshake();

    // The root package.json's version is read here, not hardcoded — a version
    // bump must not need an edit to this test.
    expect(result).toEqual({
      schemaVersion: 1,
      name: 'create-agent-rig',
      version: pkg.version,
      contractVersion: '1.0',
    });
  });

  it('reports the same version packageVersion() reports', async () => {
    const [handshake, version] = await Promise.all([rigHandshake(), packageVersion()]);
    expect(handshake.version).toBe(version);
  });
});

describe('RIG_CONTRACT_VERSION', () => {
  it('is 1.0 — the contract this rig currently implements', () => {
    expect(RIG_CONTRACT_VERSION).toBe('1.0');
  });
});
