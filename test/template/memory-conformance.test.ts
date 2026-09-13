import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RP-13, spec point D: `scripts/memory-conformance.mjs` runs the pinned-ref
 * Memory conformance checks and prints one JSON report. These tests drive it
 * entirely against a local, hand-built checkout (`--from <dir>`), never the
 * network — the fetch path is pinned separately below by injecting `run`
 * through the module's own export rather than by spawning git.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'memory-conformance.mjs');

interface CheckRecord {
  id: string;
  status: 'ok' | 'fail' | 'skip';
  detail: string;
}
interface Report {
  schemaVersion: 1;
  ref: string;
  contractVersion: string;
  source: 'fetched' | 'local';
  checks: CheckRecord[];
  passed: boolean;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [scriptPath, ...args], (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

/** A fake `shared-memory/memory.mjs` answering the handshake and doctor literals. */
const fakeMemoryScript = (contractVersion: string): string => `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version') && args.includes('--json')) {
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    name: 'memory',
    version: '0.1.0',
    contractVersion: ${JSON.stringify(contractVersion)},
  }) + '\\n');
  process.exit(0);
}
if (args[0] === 'doctor' && args.includes('--json')) {
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    status: 'ok',
    checks: [{ id: 'core', status: 'ok', detail: 'fine', fix: '' }],
  }) + '\\n');
  process.exit(0);
}
process.exit(2);
`;

interface FixtureOptions {
  contractVersion?: string;
  missingReject?: boolean;
}

/** A minimal `shared-memory/` checkout: contract doc, event schema, both fixture trees, a fake backend. */
async function buildMemoryRoot(options: FixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'rp13-memory-fixture-'));
  const contractDir = path.join(root, 'shared-memory', 'contract');
  await mkdir(path.join(contractDir, 'fixtures', 'event-schema-v1', 'accept'), { recursive: true });
  await writeFile(
    path.join(contractDir, 'fixtures', 'event-schema-v1', 'accept', 'a.md'),
    '# accept case\n',
  );
  if (!options.missingReject) {
    await mkdir(path.join(contractDir, 'fixtures', 'event-schema-v1', 'reject'), {
      recursive: true,
    });
    await writeFile(
      path.join(contractDir, 'fixtures', 'event-schema-v1', 'reject', 'r.md'),
      '# reject case\n',
    );
  }
  await writeFile(
    path.join(contractDir, 'contract-1.0.md'),
    '# Memory contract\n\nThis document fixes contractVersion 1.0.\n',
  );
  await writeFile(
    path.join(contractDir, 'event-schema-v1.json'),
    JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }),
  );
  await writeFile(
    path.join(root, 'shared-memory', 'memory.mjs'),
    fakeMemoryScript(options.contractVersion ?? '1.0'),
  );
  return root;
}

describe('scripts/memory-conformance.mjs against a local checkout (RP-13)', () => {
  it('passes every check against a well-formed local fixture root', async () => {
    const root = await buildMemoryRoot();
    try {
      const result = await run(['--json', '--from', root]);
      expect(result.stderr, result.stderr).toBe('');
      expect(result.code).toBe(0);
      const lines = result.stdout.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      const report = JSON.parse(lines[0]!) as Report;
      expect(report.schemaVersion).toBe(1);
      expect(report.source).toBe('local');
      expect(report.passed).toBe(true);

      const ids = report.checks.map((c) => c.id).sort();
      expect(ids).toEqual(
        [
          'contract-document',
          'event-schema',
          'fixtures-present',
          'memory-doctor',
          'memory-handshake',
          'ref-pinned',
          'rig-handshake',
        ].sort(),
      );

      const refPinned = report.checks.find((c) => c.id === 'ref-pinned');
      expect(refPinned?.status).toBe('skip');
      expect(refPinned?.detail).toBe('local checkout, ref not verified');

      for (const check of report.checks) {
        expect(check.detail, `${check.id} leaked the fixture path`).not.toContain(root);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('fails memory-handshake and the whole run when the backend answers a foreign contract major', async () => {
    const root = await buildMemoryRoot({ contractVersion: '2.0' });
    try {
      const result = await run(['--json', '--from', root]);
      expect(result.code).not.toBe(0);
      const report = JSON.parse(result.stdout.trim()) as Report;
      expect(report.passed).toBe(false);
      expect(report.checks.find((c) => c.id === 'memory-handshake')?.status).toBe('fail');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('fails fixtures-present when the reject fixture directory is missing', async () => {
    const root = await buildMemoryRoot({ missingReject: true });
    try {
      const result = await run(['--json', '--from', root]);
      expect(result.code).not.toBe(0);
      const report = JSON.parse(result.stdout.trim()) as Report;
      expect(report.checks.find((c) => c.id === 'fixtures-present')?.status).toBe('fail');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('validates the real rig bin handshake against the shipped conformance schema', async () => {
    const root = await buildMemoryRoot();
    try {
      const result = await run(['--json', '--from', root]);
      const report = JSON.parse(result.stdout.trim()) as Report;
      expect(report.checks.find((c) => c.id === 'rig-handshake')?.status).toBe('ok');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('prints exactly one JSON object on stdout under --json', async () => {
    const root = await buildMemoryRoot();
    try {
      const result = await run(['--json', '--from', root]);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      const lines = result.stdout.split('\n').filter((line) => line.trim() !== '');
      expect(lines).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('scripts/memory-conformance.mjs plans its fetch from the manifest, without touching the network', () => {
  it('builds git init, remote add, fetch and checkout from the manifest repository and ref', async () => {
    const module = (await import(pathToFileURL(scriptPath).href)) as {
      planFetch: (manifest: { memory: { repository: string; ref: string } }) => string[][];
    };
    const manifest = {
      memory: {
        repository: 'serhii-baksheiev/claude-config',
        ref: '4b5cee73399765808a2648343057676523005d83',
      },
    };
    const steps = module.planFetch(manifest);
    expect(steps).toEqual([
      ['init'],
      ['remote', 'add', 'origin', 'https://github.com/serhii-baksheiev/claude-config.git'],
      ['fetch', '--depth', '1', 'origin', manifest.memory.ref],
      ['checkout', 'FETCH_HEAD', '--', 'shared-memory'],
    ]);
  });
});
