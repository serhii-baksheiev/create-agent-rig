import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rigHandshake } from '../../packages/cli/src/lib/version.js';

/**
 * RP-13, spec point A: `templates/agent-os/universal/.claude/contracts/conformance-v1/`
 * carries the versioned conformance payload every `create`/`init`/`upgrade`
 * delivers, and the dogfood sync mirrors into this repo's own `.claude/`.
 *
 * `session-identity.schema.json` is GENERATED from
 * `contracts/session-messaging/v1/schema.ts` by `scripts/conformance-payload.mjs`
 * (spec point C) — that correspondence is pinned here, both directions.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const contractsDir = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'universal',
  '.claude',
  'contracts',
  'conformance-v1',
);
const schemaSubsetPath = path.join(repoRoot, 'scripts', 'lib', 'json-schema-subset.mjs');
const conformancePayloadScript = path.join(repoRoot, 'scripts', 'conformance-payload.mjs');

interface ValidationResult {
  ok: boolean;
  errors: string[];
}
type Validate = (schema: unknown, value: unknown) => ValidationResult;

const loadValidate = async (): Promise<Validate> =>
  ((await import(pathToFileURL(schemaSubsetPath).href)) as { validate: Validate }).validate;

const readJson = async (...parts: string[]): Promise<unknown> =>
  JSON.parse(await readFile(path.join(contractsDir, ...parts), 'utf8'));

/** Exactly the manifest spec point A pins, key order and all. */
const EXPECTED_MANIFEST = {
  schemaVersion: 1,
  contractVersion: '1.0',
  payload: ['version-handshake.schema.json', 'doctor.schema.json', 'session-identity.schema.json'],
  memory: {
    repository: 'serhii-baksheiev/claude-config',
    ref: '4b5cee73399765808a2648343057676523005d83',
    contractDirectory: 'shared-memory/contract',
    executable: 'shared-memory/memory.mjs',
  },
};

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runConformancePayload(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [conformancePayloadScript, ...args], (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

/** A scratch copy of just what `conformance-payload.mjs --root` needs to read and write. */
async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'rp13-conformance-payload-'));
  await cp(path.join(repoRoot, 'contracts'), path.join(root, 'contracts'), { recursive: true });
  await cp(
    path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'contracts'),
    path.join(root, 'templates', 'agent-os', 'universal', '.claude', 'contracts'),
    { recursive: true },
  );
  return root;
}

describe('the conformance-v1 payload directory the universal template ships (RP-13)', () => {
  it('carries exactly the manifest and the three schema files, nothing else', async () => {
    const entries = (await readdir(contractsDir)).sort();
    expect(entries).toEqual([
      'doctor.schema.json',
      'manifest.json',
      'session-identity.schema.json',
      'version-handshake.schema.json',
    ]);
  });

  it('writes manifest.json with the pinned shape, key order and a real commit SHA as the ref', async () => {
    const raw = await readFile(path.join(contractsDir, 'manifest.json'), 'utf8');
    expect(raw).toBe(`${JSON.stringify(EXPECTED_MANIFEST, null, 2)}\n`);
    const parsed = JSON.parse(raw) as typeof EXPECTED_MANIFEST;
    expect(parsed).toEqual(EXPECTED_MANIFEST);
    // A tag or branch name is refused: the pin has to be a commit.
    expect(parsed.memory.ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it('keeps both hand-authored schemas inside the documented JSON-Schema-2020-12 subset', async () => {
    const validate = await loadValidate();
    for (const file of ['version-handshake.schema.json', 'doctor.schema.json']) {
      const schema = await readJson(file);
      // A schema using a keyword outside the subset makes `validate` throw
      // even on a value it never gets far enough to judge.
      expect(() => validate(schema, {}), file).not.toThrow();
    }
  });

  describe('session-identity.schema.json (generated)', () => {
    it('carries a SessionIdentity subschema inside the subset that accepts a full identity and rejects one missing a required field', async () => {
      const validate = await loadValidate();
      const payload = (await readJson('session-identity.schema.json')) as {
        sessionIdentity: unknown;
        contractMajor: unknown;
      };
      const full = { engineerId: 'e1', harness: 'claude', projectId: 'p', instanceId: 'i1' };
      expect(validate(payload.sessionIdentity, full)).toEqual({ ok: true, errors: [] });
      const partial = {
        engineerId: full.engineerId,
        harness: full.harness,
        projectId: full.projectId,
      };
      expect(validate(payload.sessionIdentity, partial).ok).toBe(false);
      expect(validate(payload.sessionIdentity, { ...full, extra: 1 }).ok).toBe(false);
      expect(validate(payload.contractMajor, 1)).toEqual({ ok: true, errors: [] });
      expect(validate(payload.contractMajor, 2).ok).toBe(false);
    });
  });

  describe('version-handshake.schema.json', () => {
    it('accepts the real rig bin handshake', async () => {
      const validate = await loadValidate();
      const schema = await readJson('version-handshake.schema.json');
      const handshake = await rigHandshake();
      expect(validate(schema, handshake)).toEqual({ ok: true, errors: [] });
    });

    it('accepts the pinned Memory handshake literal', async () => {
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
        checks: [
          {
            id: 'manifest-present',
            status: 'ok',
            detail: 'the install manifest was read',
          },
        ],
      };
      expect(validate(schema, withoutFix).ok).toBe(false);
    });
  });

  // The synced copy at the repo root, `.claude/contracts/conformance-v1/`, is
  // covered by test/template/dogfood.test.ts › "CLAUDE.md and .claude/ are in
  // sync with templates/agent-os": that check runs `sync-agent-os.mjs --check`
  // over the WHOLE `.claude` tree, this directory included, so a byte-for-byte
  // comparison here would duplicate it rather than add reach.

  describe('session-identity.schema.json is generated from contracts/session-messaging/v1/schema.ts', () => {
    it('passes --check against the committed pair as it stands in this repository', async () => {
      const result = await runConformancePayload(['--check']);
      expect(result.stderr, result.stderr).toBe('');
      expect(result.code).toBe(0);
    });

    it('fails --check when schema.ts changes underneath the committed JSON, and --write repairs it', async () => {
      const root = await scratchRoot();
      try {
        const scratchSchemaTs = path.join(
          root,
          'contracts',
          'session-messaging',
          'v1',
          'schema.ts',
        );
        const before = await readFile(scratchSchemaTs, 'utf8');
        expect(before).toContain('engineerId');
        await writeFile(scratchSchemaTs, before.replaceAll('engineerId', 'engineerIdentifier'));

        const checked = await runConformancePayload(['--check', '--root', root]);
        expect(checked.code).not.toBe(0);

        const written = await runConformancePayload(['--write', '--root', root]);
        expect(written.code).toBe(0);

        const rechecked = await runConformancePayload(['--check', '--root', root]);
        expect(rechecked.code).toBe(0);

        const scratchJson = path.join(
          root,
          'templates',
          'agent-os',
          'universal',
          '.claude',
          'contracts',
          'conformance-v1',
          'session-identity.schema.json',
        );
        expect(await readFile(scratchJson, 'utf8')).toContain('engineerIdentifier');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('fails --check when the committed JSON is hand-edited out from under schema.ts', async () => {
      const root = await scratchRoot();
      try {
        const scratchJsonPath = path.join(
          root,
          'templates',
          'agent-os',
          'universal',
          '.claude',
          'contracts',
          'conformance-v1',
          'session-identity.schema.json',
        );
        await writeFile(scratchJsonPath, '{"hand":"edited"}\n');

        const result = await runConformancePayload(['--check', '--root', root]);
        expect(result.code).not.toBe(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it('is named in scripts/sync-agent-os.mjs, so nobody forgets to keep it current', async () => {
    const source = await readFile(path.join(repoRoot, 'scripts', 'sync-agent-os.mjs'), 'utf8');
    expect(source).toContain('conformance-payload.mjs');
  });
});
