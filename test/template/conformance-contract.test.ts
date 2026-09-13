import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rigHandshake } from '../../packages/cli/src/lib/version.js';

/**
 * RP-13: `contracts/conformance/v1/` is the repository's own contract location
 * for the Rig ↔ Memory conformance schemas — the shapes
 * `scripts/memory-conformance.mjs` checks both bins' answers against. It is a
 * repository contract, not a payload: nothing under `templates/` carries it,
 * so `create`/`init`/`upgrade` never deliver it to a rig (the owner's RP-13
 * disposition of 2026-09-13, point 2).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const contractsDir = path.join(repoRoot, 'contracts', 'conformance', 'v1');
const schemaSubsetPath = path.join(repoRoot, 'scripts', 'lib', 'json-schema-subset.mjs');

interface ValidationResult {
  ok: boolean;
  errors: string[];
}
type Validate = (schema: unknown, value: unknown) => ValidationResult;

const loadValidate = async (): Promise<Validate> =>
  ((await import(pathToFileURL(schemaSubsetPath).href)) as { validate: Validate }).validate;

const readJson = async (...parts: string[]): Promise<unknown> =>
  JSON.parse(await readFile(path.join(contractsDir, ...parts), 'utf8'));

/** Exactly the manifest the runner reads, key order and all. */
const EXPECTED_MANIFEST = {
  schemaVersion: 1,
  contractVersion: '1.0',
  schemas: ['version-handshake.schema.json', 'doctor.schema.json', 'load.schema.json'],
  memory: {
    contractDirectory: 'shared-memory/contract',
    executable: 'shared-memory/memory.mjs',
  },
};

describe('the conformance-v1 contract directory (RP-13)', () => {
  it('carries exactly the manifest and the three schema files, nothing else', async () => {
    const entries = (await readdir(contractsDir)).sort();
    expect(entries).toEqual([
      'doctor.schema.json',
      'load.schema.json',
      'manifest.json',
      'version-handshake.schema.json',
    ]);
  });

  it('writes manifest.json with the pinned shape and key order, and names no Memory repository or ref', async () => {
    const raw = await readFile(path.join(contractsDir, 'manifest.json'), 'utf8');
    // Key order is part of the pin (JSON.stringify preserves it); whitespace is prettier's.
    expect(JSON.stringify(JSON.parse(raw))).toBe(JSON.stringify(EXPECTED_MANIFEST));
    // The Memory checkout is chosen by whoever runs the matrix (the
    // authoritative workflow in claude-config, at an exact SHA of its own),
    // never pinned here: a pin in this repository would be a second copy of
    // a fact the other repository owns.
    expect(raw).not.toContain('"ref"');
    expect(raw).not.toContain('"repository"');
  });

  it('is not delivered to rigs: no template carries a conformance contract', async () => {
    const templateContracts = path.join(
      repoRoot,
      'templates',
      'agent-os',
      'universal',
      '.claude',
      'contracts',
    );
    await expect(readdir(templateContracts)).rejects.toMatchObject({ code: 'ENOENT' });
    const layers = await readFile(
      path.join(repoRoot, 'templates', 'agent-os', 'universal', 'layers.json'),
      'utf8',
    );
    expect(layers).not.toContain('conformance');
  });

  it('keeps every schema inside the documented JSON-Schema-2020-12 subset', async () => {
    const validate = await loadValidate();
    for (const file of EXPECTED_MANIFEST.schemas) {
      const schema = await readJson(file);
      // A schema using a keyword outside the subset makes `validate` throw
      // even on a value it never gets far enough to judge.
      expect(() => validate(schema, {}), file).not.toThrow();
    }
  });

  describe('version-handshake.schema.json', () => {
    it('accepts the real rig bin handshake', async () => {
      const validate = await loadValidate();
      const schema = await readJson('version-handshake.schema.json');
      const handshake = await rigHandshake();
      expect(validate(schema, handshake)).toEqual({ ok: true, errors: [] });
    });

    it('accepts the Memory handshake literal of contract 1.0', async () => {
      const validate = await loadValidate();
      const schema = await readJson('version-handshake.schema.json');
      const memoryHandshake = {
        schemaVersion: 1,
        name: 'memory',
        version: '0.1.0',
        contractVersion: '1.0',
      };
      expect(validate(schema, memoryHandshake)).toEqual({ ok: true, errors: [] });
    });

    it('tolerates an additive field the contract does not enumerate', async () => {
      const validate = await loadValidate();
      const schema = await readJson('version-handshake.schema.json');
      const handshake = {
        schemaVersion: 1,
        name: 'create-agent-rig',
        version: '0.9.0',
        contractVersion: '1.0',
        extraField: true,
      };
      expect(validate(schema, handshake).ok).toBe(true);
    });

    it('rejects an integration-failed payload, which carries no name, version or contractVersion', async () => {
      const validate = await loadValidate();
      const schema = await readJson('version-handshake.schema.json');
      const failure = { schemaVersion: 1, result: 'integration-failed', reason: 'invalid' };
      expect(validate(schema, failure).ok).toBe(false);
    });
  });

  describe('doctor.schema.json', () => {
    const doctorPayload = {
      schemaVersion: 1,
      status: 'ok',
      checks: [
        {
          id: 'manifest-present',
          status: 'ok',
          detail: 'the install manifest was read',
          fix: '',
        },
      ],
    };

    it('accepts a well-formed doctor payload', async () => {
      const validate = await loadValidate();
      const schema = await readJson('doctor.schema.json');
      expect(validate(schema, doctorPayload)).toEqual({ ok: true, errors: [] });
    });

    it('rejects a check record missing fix', async () => {
      const validate = await loadValidate();
      const schema = await readJson('doctor.schema.json');
      const withoutFix = {
        ...doctorPayload,
        checks: [{ id: 'manifest-present', status: 'ok', detail: 'the install manifest was read' }],
      };
      expect(validate(schema, withoutFix).ok).toBe(false);
    });
  });

  describe('load.schema.json', () => {
    const unsupportedLoad = {
      schemaVersion: 1,
      result: 'unsupported',
      reason: 'unmapped-identity',
      empty: true,
      content: '',
      counters: { eligible: 0, injected: 0, budgetSkipped: 0, invalid: 0 },
      budget: { limitBytes: 0, usedBytes: 0 },
      degradation: [],
      identity: { status: 'unresolved', reason: 'unmapped-identity' },
    };

    it('accepts an unsupported load answer — an unmapped checkout is a legitimate non-error outcome', async () => {
      const validate = await loadValidate();
      const schema = await readJson('load.schema.json');
      expect(validate(schema, unsupportedLoad)).toEqual({ ok: true, errors: [] });
    });

    it('accepts an ok load answer with content and a resolved identity', async () => {
      const validate = await loadValidate();
      const schema = await readJson('load.schema.json');
      const ok = {
        ...unsupportedLoad,
        result: 'ok',
        empty: false,
        content: '# memory\n',
        counters: { eligible: 2, injected: 2, budgetSkipped: 0, invalid: 0 },
        identity: { status: 'resolved', remoteName: 'origin', remote: 'r', namespace: 'n' },
      };
      expect(validate(schema, ok)).toEqual({ ok: true, errors: [] });
    });

    it('rejects an error outcome, whose result is outside the two non-error words', async () => {
      const validate = await loadValidate();
      const schema = await readJson('load.schema.json');
      const failed = { schemaVersion: 1, result: 'integration-failed', reason: 'invalid' };
      expect(validate(schema, failed).ok).toBe(false);
    });
  });
});
