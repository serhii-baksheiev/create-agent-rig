import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RP-13: `scripts/memory-conformance.mjs` is the Rig-side, offline half of the
 * conformance matrix. It reads a Memory checkout the caller names with
 * `--from <root>` — the authoritative run lives in the private claude-config
 * repository, which checks out this repository at an exact SHA and points the
 * runner at its own working tree — and prints one JSON report. These tests
 * drive it entirely against a hand-built checkout: no network, no credential,
 * no Memory code imported. The cases that run the whole runner carry
 * `FULL_RUN_BUDGET_MS` instead of the project default, and several assertions
 * share one run rather than each paying for a run of their own.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'memory-conformance.mjs');
const contractsDir = path.join(repoRoot, 'contracts', 'conformance', 'v1');
const FULL_RUN_BUDGET_MS = 30_000;

interface Row {
  id: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
}
interface Report {
  schemaVersion: 1;
  contractVersion: string;
  rigSha: string;
  memorySha: string | null;
  verifierDigest: string;
  rows: Row[];
  passed: boolean;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const ROW_IDS = [
  'contract-document',
  'event-schema',
  'fixtures-present',
  'memory-handshake',
  'memory-doctor',
  'memory-load',
  'rig-handshake',
  'rig-setup',
  'rig-memory-doctor',
  'rig-foreign-major',
];

function run(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [scriptPath, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

interface FixtureOptions {
  contractVersion?: string;
  version?: string;
  doctorStatus?: 'ok' | 'warn' | 'fail';
  /** `missing-fix` drops the `fix` field from the one check record: exit 0, valid JSON, outside the schema. */
  doctorShape?: 'valid' | 'missing-fix';
  loadOutcome?: 'unsupported' | 'integration-failed';
  /** `contract-fixture` answers exactly the load fixture docs/command-contract.md carries: no content, no identity. */
  loadShape?: 'full' | 'contract-fixture';
  missingReject?: boolean;
}

/**
 * A fake `shared-memory/memory.mjs` answering the handshake, doctor and load
 * literals. It leaves a marker when RP13_CANARY reaches it, so a run that sets
 * that variable for the runner can assert the backend never saw it.
 */
const fakeMemoryScript = (options: FixtureOptions, marker: string): string => `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
if (process.env.RP13_CANARY) writeFileSync(${JSON.stringify(marker)}, process.env.RP13_CANARY);
const args = process.argv.slice(2);
const out = (payload) => process.stdout.write(JSON.stringify(payload) + '\\n');
if (args.includes('--version') && args.includes('--json')) {
  out({ schemaVersion: 1, name: 'memory', version: ${JSON.stringify(options.version ?? '0.1.0')}, contractVersion: ${JSON.stringify(options.contractVersion ?? '1.0')} });
  process.exit(0);
}
if (args[0] === 'doctor' && args.includes('--json')) {
  const status = ${JSON.stringify(options.doctorStatus ?? 'ok')};
  const record = { id: 'core', status, detail: 'fine', fix: '' };
  if (${JSON.stringify(options.doctorShape ?? 'valid')} === 'missing-fix') delete record.fix;
  out({ schemaVersion: 1, status, checks: [record] });
  process.exit(0);
}
if (args[0] === 'load' && args.includes('--json') && args.includes('--cwd')) {
  if (${JSON.stringify(options.loadOutcome ?? 'unsupported')} === 'integration-failed') {
    out({ schemaVersion: 1, result: 'integration-failed', reason: 'invalid' });
    process.exit(1);
  }
  if (${JSON.stringify(options.loadShape ?? 'full')} === 'contract-fixture') {
    out({ schemaVersion: 1, result: 'ok', counters: { eligible: 7, injected: 4, budgetSkipped: 3, invalid: 0 }, budget: { limitBytes: 8192, usedBytes: 7681 }, degradation: ['budget-skipped'] });
    process.exit(0);
  }
  out({
    schemaVersion: 1, result: 'unsupported', reason: 'unmapped-identity', empty: true, content: '',
    counters: { eligible: 0, injected: 0, budgetSkipped: 0, invalid: 0 },
    budget: { limitBytes: 0, usedBytes: 0 }, degradation: [],
    identity: { status: 'unresolved', reason: 'unmapped-identity' },
  });
  process.exit(0);
}
process.exit(2);
`;

/** A minimal `shared-memory/` checkout: contract doc, event schema, both fixture trees, a fake backend. */
async function buildMemoryRoot(
  options: FixtureOptions = {},
  parent: string = tmpdir(),
): Promise<string> {
  const root = await mkdtemp(path.join(parent, 'rp13-memory-fixture-'));
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
    fakeMemoryScript(options, markerPath(root)),
  );
  return root;
}

const markerPath = (root: string) => path.join(root, 'leak.marker');
const parseReport = (stdout: string): Report => JSON.parse(stdout.trim()) as Report;
const row = (report: Report, id: string): Row | undefined => report.rows.find((r) => r.id === id);

/** A configuration root of the caller's, so a run that wrote into it would be caught. */
async function callerConfigRoot(): Promise<{ env: NodeJS.ProcessEnv; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'rp13-caller-config-'));
  return { dir, env: { ...process.env, HOME: dir, APPDATA: dir } };
}

describe('scripts/memory-conformance.mjs against a local checkout (RP-13)', () => {
  it(
    'passes every row against a well-formed local fixture root and names both SHAs and the verifier digest',
    async () => {
      const root = await buildMemoryRoot();
      const caller = await callerConfigRoot();
      try {
        // RP13_CANARY is set for the runner and must never reach the backend:
        // the fake writes a marker if it sees it.
        const result = await run(['--json', '--from', root], {
          ...caller.env,
          RP13_CANARY: 'leaked',
        });
        expect(result.stderr, result.stderr).toBe('');
        expect(result.code).toBe(0);
        const lines = result.stdout.trim().split('\n').filter(Boolean);
        expect(lines, 'exactly one JSON object on stdout').toHaveLength(1);
        const report = parseReport(lines[0]!);
        expect(report.schemaVersion).toBe(1);
        expect(report.contractVersion).toBe('1.0');
        expect(report.passed).toBe(true);
        expect(report.rows.map((r) => r.id)).toEqual(ROW_IDS);
        for (const r of report.rows) expect(r.status, `${r.id}: ${r.detail}`).toBe('pass');

        // The exact SHA of the Rig that judged, so the report can be tied to
        // the checkout the authoritative workflow chose.
        const head = (await git(['rev-parse', 'HEAD'], repoRoot)).trim();
        expect(report.rigSha).toBe(head);
        // A fixture root is not a git checkout: the Memory SHA is null, never
        // a guess, never the Rig's own.
        expect(report.memorySha).toBeNull();
        expect(report.verifierDigest).toMatch(/^[0-9a-f]{64}$/);

        for (const r of report.rows)
          expect(r.detail, `${r.id} leaked the fixture path`).not.toContain(root);

        // The backend saw the allow-listed environment end to end.
        expect(existsSync(markerPath(root)), 'RP13_CANARY reached the backend').toBe(false);
        // The rig rows registered Memory somewhere — and that somewhere is the
        // runner's own temporary root, never the caller's configuration root.
        expect(row(report, 'rig-setup')?.status).toBe('pass');
        expect(await readdir(caller.dir)).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(caller.dir, { recursive: true, force: true });
      }
    },
    FULL_RUN_BUDGET_MS,
  );

  it(
    'records the HEAD of a git --from root as memorySha, keeps memory-doctor passing when the doctor answers status fail, passes a load answer shaped like the contract fixture, and cuts a subprocess-chosen value before it enters a detail',
    async () => {
      const longVersion = 'v'.repeat(200);
      const root = await buildMemoryRoot({
        doctorStatus: 'fail',
        version: longVersion,
        loadShape: 'contract-fixture',
      });
      const author = ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t'];
      try {
        await git(['init', '-q'], root);
        await git([...author, 'add', '.'], root);
        await git([...author, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture'], root);
        const head = (await git(['rev-parse', 'HEAD'], root)).trim();

        const result = await run(['--json', '--from', root]);
        expect(result.code).toBe(0);
        const report = parseReport(result.stdout);
        expect(report.memorySha).toBe(head);

        // The row measures the doctor payload's SHAPE, never the backend's status.
        const doctor = row(report, 'memory-doctor');
        expect(doctor?.status).toBe('pass');
        expect(doctor?.detail).toContain('doctor status fail');

        // A load answer shaped exactly like the contract document's own
        // fixture — no `content`, no `identity` — passes, and the detail
        // does not depend on the absent field.
        const load = row(report, 'memory-load');
        expect(load?.status).toBe('pass');
        expect(load?.detail).toContain('identity not reported');

        // A value the subprocess chose is cut before it enters a detail.
        const handshake = row(report, 'memory-handshake');
        expect(handshake?.status).toBe('pass');
        expect(handshake?.detail).toContain('v'.repeat(32));
        expect(handshake?.detail).not.toContain('v'.repeat(33));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    FULL_RUN_BUDGET_MS,
  );

  it(
    'derives verifierDigest from the runner, its validator and the contract files, in that order, and writes the same report to --out',
    async () => {
      const root = await buildMemoryRoot();
      const out = path.join(root, 'report.json');
      try {
        const files = [
          scriptPath,
          path.join(repoRoot, 'scripts', 'lib', 'json-schema-subset.mjs'),
          path.join(contractsDir, 'manifest.json'),
          path.join(contractsDir, 'version-handshake.schema.json'),
          path.join(contractsDir, 'doctor.schema.json'),
          path.join(contractsDir, 'load.schema.json'),
        ];
        const hash = createHash('sha256');
        for (const file of files) hash.update(await readFile(file));
        const result = await run(['--json', '--from', root, '--out', out]);
        expect(result.code).toBe(0);
        const report = parseReport(result.stdout);
        expect(report.verifierDigest).toBe(hash.digest('hex'));
        expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(report);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    FULL_RUN_BUDGET_MS,
  );

  it(
    'fails memory-handshake, and the rig refuses setup with exit 4, when the backend answers a foreign contract major',
    async () => {
      const root = await buildMemoryRoot({ contractVersion: '2.0' });
      try {
        const result = await run(['--json', '--from', root]);
        expect(result.code).toBe(1);
        const report = parseReport(result.stdout);
        expect(report.passed).toBe(false);
        expect(row(report, 'memory-handshake')?.status).toBe('fail');
        expect(row(report, 'rig-setup')?.status).toBe('fail');
        expect(row(report, 'rig-setup')?.detail).toContain('exit 4');
        expect(row(report, 'rig-memory-doctor')?.status).toBe('skip');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    FULL_RUN_BUDGET_MS,
  );

  it(
    'fails a row whose answer is valid JSON outside its schema, one that exits non-zero, and one whose fixture directory is missing — each with its reason',
    async () => {
      const root = await buildMemoryRoot({
        doctorShape: 'missing-fix',
        loadOutcome: 'integration-failed',
        missingReject: true,
      });
      try {
        const result = await run(['--json', '--from', root]);
        expect(result.code).toBe(1);
        const report = parseReport(result.stdout);
        expect(report.passed).toBe(false);

        // Exit 0 and well-formed JSON are not enough: the schema is what judges.
        const doctor = row(report, 'memory-doctor');
        expect(doctor?.status).toBe('fail');
        expect(doctor?.detail).toContain('outside the schema');
        expect(doctor?.detail).toContain('checks[0].fix');
        // ...and the same shape judged again when the rig passes doctor through.
        const through = row(report, 'rig-memory-doctor');
        expect(through?.status).toBe('fail');
        expect(through?.detail).toContain('outside the schema');

        const load = row(report, 'memory-load');
        expect(load?.status).toBe('fail');
        expect(load?.detail).toContain('exit 1');

        expect(row(report, 'fixtures-present')?.status).toBe('fail');
        // The rows the fixture left intact still pass: one failure does not
        // paint the others.
        expect(row(report, 'memory-handshake')?.status).toBe('pass');
        expect(row(report, 'rig-foreign-major')?.status).toBe('pass');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    FULL_RUN_BUDGET_MS,
  );

  it(
    'records null, never an ancestor repository’s HEAD, for a --from root that is not itself a checkout root',
    async () => {
      const outer = await mkdtemp(path.join(tmpdir(), 'rp13-outer-repo-'));
      const author = ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t'];
      try {
        await git(['init', '-q'], outer);
        await writeFile(path.join(outer, 'README'), 'outer\n');
        await git([...author, 'add', '.'], outer);
        await git([...author, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'outer'], outer);
        const inner = await buildMemoryRoot({}, outer);
        const result = await run(['--json', '--from', inner]);
        expect(result.code).toBe(0);
        expect(parseReport(result.stdout).memorySha).toBeNull();
      } finally {
        await rm(outer, { recursive: true, force: true });
      }
    },
    FULL_RUN_BUDGET_MS,
  );

  it(
    'exits 3, not 1, when the runner itself fails — an --out path whose directory does not exist',
    async () => {
      const root = await buildMemoryRoot();
      try {
        const result = await run([
          '--json',
          '--from',
          root,
          '--out',
          path.join(root, 'no-such-dir', 'report.json'),
        ]);
        expect(result.code).toBe(3);
        expect(result.stderr).toContain('memory-conformance:');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    FULL_RUN_BUDGET_MS,
  );

  it('refuses to run without --from, or with a flag where its value should be: there is no fetch to fall back to', async () => {
    for (const args of [['--json'], ['--from', '--json'], ['--json', '--from', 'x', '--out']]) {
      const result = await run(args);
      expect(result.code, args.join(' ')).toBe(2);
      expect(result.stdout, args.join(' ')).toBe('');
      expect(result.stderr, args.join(' ')).toContain('--from');
    }
  });
});

describe('scripts/memory-conformance.mjs spawns Memory with a minimal environment (RP-13)', () => {
  it('gives the spawned Memory process a minimal environment that carries no token-shaped variable', async () => {
    const module = (await import(pathToFileURL(scriptPath).href)) as {
      memoryProcessEnv: (env: NodeJS.ProcessEnv) => Record<string, string>;
    };
    const child = module.memoryProcessEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      GITHUB_TOKEN: 'ghs_example',
      SOME_SECRET: 'x',
    });
    expect(child.PATH).toBe('/usr/bin');
    expect(child.HOME).toBe('/home/u');
    expect(Object.keys(child)).not.toContain('GITHUB_TOKEN');
    expect(Object.keys(child)).not.toContain('SOME_SECRET');
  });
});

describe('scripts/memory-conformance.mjs keeps the Memory boundary of ADR-RP-002 R1 and reaches no network (RP-13)', () => {
  it('imports only node: builtins and its sibling validator, never anything from the Memory checkout', async () => {
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
  });

  it("carries no fetch, clone or credential: the checkout is always the caller's", async () => {
    // Static, like the import scan above, and it measures exactly that much:
    // the runner's own text names no git transport verb, no GitHub URL and no
    // token-shaped variable. The behavioural half — no variable set for the
    // runner reaches the backend — is the RP13_CANARY assertion in › "passes
    // every row against a well-formed local fixture root and names both SHAs
    // and the verifier digest".
    const source = await readFile(scriptPath, 'utf8');
    expect(source).not.toMatch(/'fetch'|'clone'|'remote'|https:\/\/github\.com/);
    expect(source).not.toMatch(/TOKEN|extraheader/);
  });

  it('the repository carries no Memory fixture', async () => {
    const tracked = await git(['ls-files'], repoRoot);
    const memoryOwned = tracked
      .split('\n')
      .filter((file) => /(^|\/)shared-memory\//.test(file) || /event-schema-v1\//.test(file));
    expect(memoryOwned).toEqual([]);
  });
});
