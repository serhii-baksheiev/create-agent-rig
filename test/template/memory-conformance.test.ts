import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const fakeMemoryScript = (
  contractVersion: string,
  doctorStatus = 'ok',
): string => `#!/usr/bin/env node
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
    status: ${JSON.stringify(doctorStatus)},
    checks: [{ id: 'core', status: ${JSON.stringify(doctorStatus)}, detail: 'fine', fix: '' }],
  }) + '\\n');
  process.exit(0);
}
process.exit(2);
`;

interface FixtureOptions {
  contractVersion?: string;
  missingReject?: boolean;
  doctorStatus?: 'ok' | 'warn' | 'fail';
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
    fakeMemoryScript(options.contractVersion ?? '1.0', options.doctorStatus ?? 'ok'),
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

describe('scripts/memory-conformance.mjs measures the doctor payload shape, not the backend status (RP-13 constraint)', () => {
  it('keeps memory-doctor an ok conformance row when the Memory doctor answers status fail, and says so in the detail', async () => {
    const root = await buildMemoryRoot({ doctorStatus: 'fail' });
    try {
      const result = await run(['--json', '--from', root]);
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as Report;
      const doctor = report.checks.find((c) => c.id === 'memory-doctor');
      expect(doctor?.status).toBe('ok');
      expect(doctor?.detail).toContain('doctor status fail');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
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

describe('scripts/memory-conformance.mjs authenticates the fetch from the environment, never from its arguments (RP-13)', () => {
  it('hands MEMORY_CONFORMANCE_TOKEN to git through GIT_CONFIG_* environment entries, never through argv, and says so when it is absent', async () => {
    const module = (await import(pathToFileURL(scriptPath).href)) as {
      gitAuthConfig: (env: NodeJS.ProcessEnv) => { env: Record<string, string>; source: string };
      planFetch: (manifest: { memory: { repository: string; ref: string } }) => string[][];
    };
    const withToken = module.gitAuthConfig({ MEMORY_CONFORMANCE_TOKEN: 'ghp_example' });
    const expected = Buffer.from('x-access-token:ghp_example').toString('base64');
    expect(withToken.env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${expected}`,
    });
    expect(withToken.source).toBe('MEMORY_CONFORMANCE_TOKEN');
    // The command list is the same with or without a token: nothing secret is an argument.
    const plan = module.planFetch({
      memory: { repository: 'o/r', ref: '4b5cee73399765808a2648343057676523005d83' },
    });
    expect(JSON.stringify(plan)).not.toContain('ghp_example');
    expect(JSON.stringify(plan)).not.toContain(expected);

    const without = module.gitAuthConfig({});
    expect(without.env).toEqual({});
    expect(without.source).toBe('none');
  });

  it('gives the spawned Memory process a minimal environment that carries no token', async () => {
    const module = (await import(pathToFileURL(scriptPath).href)) as {
      memoryProcessEnv: (env: NodeJS.ProcessEnv) => Record<string, string>;
    };
    const child = module.memoryProcessEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      MEMORY_CONFORMANCE_TOKEN: 'ghp_example',
      GITHUB_TOKEN: 'ghs_example',
      SOME_SECRET: 'x',
    });
    expect(child.PATH).toBe('/usr/bin');
    expect(child.HOME).toBe('/home/u');
    expect(Object.keys(child)).not.toContain('MEMORY_CONFORMANCE_TOKEN');
    expect(Object.keys(child)).not.toContain('GITHUB_TOKEN');
    expect(Object.keys(child)).not.toContain('SOME_SECRET');
  });
});

describe('scripts/memory-conformance.mjs enforces the pin before it runs anything from the tree (RP-13)', () => {
  const importScript = async () =>
    (await import(pathToFileURL(scriptPath).href)) as {
      runConformance: (options: {
        from: string;
        manifest: {
          contractVersion: string;
          memory: {
            repository: string;
            ref: string;
            contractDirectory: string;
            executable: string;
          };
        };
        schemas: { handshake: unknown; doctor: unknown };
        rigBin: string;
      }) => Promise<Report>;
    };
  const schemas = async () => ({
    handshake: JSON.parse(
      await readFile(
        path.join(
          repoRoot,
          '.claude',
          'contracts',
          'conformance-v1',
          'version-handshake.schema.json',
        ),
        'utf8',
      ),
    ) as unknown,
    doctor: JSON.parse(
      await readFile(
        path.join(repoRoot, '.claude', 'contracts', 'conformance-v1', 'doctor.schema.json'),
        'utf8',
      ),
    ) as unknown,
  });

  it('refuses a ref that is not a 40-hex commit SHA with every other row skipped, and spawns nothing', async () => {
    const root = await buildMemoryRoot();
    const marker = path.join(root, 'spawned.marker');
    // A backend that leaves a footprint when it runs: the assertion is its absence.
    await writeFile(
      path.join(root, 'shared-memory', 'memory.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.stdout.write(JSON.stringify({ schemaVersion: 1, name: 'memory', version: '0.1.0', contractVersion: '1.0' }));\n`,
    );
    try {
      const { runConformance } = await importScript();
      const report = await runConformance({
        from: root,
        manifest: {
          contractVersion: '1.0',
          memory: {
            repository: 'serhii-baksheiev/claude-config',
            ref: 'main',
            contractDirectory: 'shared-memory/contract',
            executable: 'shared-memory/memory.mjs',
          },
        },
        schemas: await schemas(),
        rigBin: path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js'),
      });
      expect(report.passed).toBe(false);
      expect(report.checks.find((c) => c.id === 'ref-pinned')?.status).toBe('fail');
      for (const check of report.checks)
        if (check.id !== 'ref-pinned') expect(check.status, check.id).toBe('skip');
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('scripts/memory-conformance.mjs keeps the Memory boundary of ADR-RP-002 R1 (RP-13)', () => {
  it('imports nothing from the fetched tree and copies no Memory fixture into the repository', async () => {
    const source = await readFile(scriptPath, 'utf8');
    // Static, on purpose: the boundary is decidable from the text. Every
    // import is a node: builtin or the sibling validator, and nothing under
    // shared-memory/ is imported, required or read as code.
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1] ?? '');
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports)
      expect(
        specifier.startsWith('node:') || specifier === './lib/json-schema-subset.mjs',
        `unexpected import ${specifier}`,
      ).toBe(true);
    expect(source).not.toMatch(/import\([^)]*shared-memory/);
    expect(source).not.toMatch(/require\(/);
    // And the repository carries no Memory fixture: the contract directory's
    // file names exist only in the fetched tree, never under this checkout.
    const { execFile: exec } = await import('node:child_process');
    const tracked = await new Promise<string>((resolve, reject) => {
      exec('git', ['ls-files'], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      );
    });
    const memoryOwned = tracked
      .split('\n')
      .filter((file) => /(^|\/)shared-memory\//.test(file) || /event-schema-v1\//.test(file));
    expect(memoryOwned).toEqual([]);
  });
});
