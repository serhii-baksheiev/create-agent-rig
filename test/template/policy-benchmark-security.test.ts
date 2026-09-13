import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { gitEnv as withoutGitLocation } from '../../packages/cli/src/lib/git-env.js';

type BenchmarkEnvironment = Record<string, string>;
type SchemaModule = {
  parseSessionSchema(source: string): Record<string, unknown>;
  parseFlagBasename(source: string): string;
};
type SnapshotModule = {
  materializeSnapshot(options: {
    root: string;
    head: string;
    destination: string;
    env: BenchmarkEnvironment;
  }): Promise<{ surfaceRoot: string; contractRoot: string }>;
};
type RuntimeModule = {
  createBenchmarkEnv(
    source: NodeJS.ProcessEnv,
    locations: { home: string; tmp: string },
  ): BenchmarkEnvironment;
  runProcess(
    file: string,
    args: string[],
    options: {
      cwd: string;
      env: BenchmarkEnvironment;
      input: string;
      timeoutMs: number;
      maxBytes: number;
    },
  ): Promise<{ code: number; stdout: Buffer; stderr: Buffer; timedOut: boolean }>;
  runWorker(
    file: string,
    payload: unknown,
    options: {
      cwd: string;
      env: BenchmarkEnvironment;
      timeoutMs: number;
      onSpawn: (pid: number) => void;
    },
  ): Promise<unknown>;
};

let parseSessionSchema: SchemaModule['parseSessionSchema'];
let parseFlagBasename: SchemaModule['parseFlagBasename'];
let materializeSnapshot: SnapshotModule['materializeSnapshot'];
let createBenchmarkEnv: RuntimeModule['createBenchmarkEnv'];
let runProcess: RuntimeModule['runProcess'];
let runWorker: RuntimeModule['runWorker'];

beforeAll(async () => {
  ({ parseSessionSchema, parseFlagBasename } = (await import(
    new URL('../../scripts/policy-benchmark-schema.mjs', import.meta.url).href
  )) as SchemaModule);
  ({ materializeSnapshot } = (await import(
    new URL('../../scripts/policy-benchmark-snapshot.mjs', import.meta.url).href
  )) as SnapshotModule);
  ({ createBenchmarkEnv, runProcess, runWorker } = (await import(
    new URL('../../scripts/policy-benchmark-runtime.mjs', import.meta.url).href
  )) as RuntimeModule);
});

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const sessionContract = path.join(repoRoot, 'contracts', 'session-messaging', 'v1');
const runner = path.join(repoRoot, 'scripts', 'policy-benchmark.mjs');
const { benchmarkTimeouts } = (await import(
  new URL('../../scripts/policy-benchmark-runtime.mjs', import.meta.url).href
)) as { benchmarkTimeouts(platform: string): { testMs: number } };
const BENCHMARK_TIMEOUT_MS = benchmarkTimeouts(process.platform).testMs;

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', args, { cwd, env: withoutGitLocation() });
  return stdout.trim();
};

const gitWithInput = (cwd: string, args: string[], input: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: withoutGitLocation(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `git exited ${String(code ?? 1)}`));
    });
    child.stdin.end(input);
  });

const createRepository = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'policy-benchmark-security-'));
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'benchmark@example.invalid');
  await git(root, 'config', 'user.name', 'Policy benchmark security fixture');
  return root;
};

const commitFixture = async (root: string): Promise<string> => {
  const guard = path.join(
    root,
    'templates',
    'agent-os',
    'universal',
    '.claude',
    'hooks',
    'guard.mjs',
  );
  const schema = path.join(root, 'contracts', 'session-messaging', 'v1', 'schema.ts');
  await mkdir(path.dirname(guard), { recursive: true });
  await mkdir(path.dirname(schema), { recursive: true });
  await writeFile(guard, "export const guard = 'committed bytes';\n");
  await writeFile(schema, "export const sessionMessagingSchema = { $id: 'fixture' };\n");
  await writeFile(path.join(root, '.gitignore'), 'ignored-helper.mjs\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'fixture');
  return git(root, 'rev-parse', 'HEAD');
};

const createBenchmarkFixture = async (): Promise<string> => {
  const root = await createRepository();
  await cp(path.join(universal, '.claude', 'hooks'), path.join(root, '.claude', 'hooks'), {
    recursive: true,
  });
  await cp(path.join(universal, '.claude', 'scripts'), path.join(root, '.claude', 'scripts'), {
    recursive: true,
  });
  await cp(
    path.join(universal, '.claude', 'settings.json'),
    path.join(root, '.claude', 'settings.json'),
  );
  await mkdir(path.join(root, '.codex'), { recursive: true });
  await cp(path.join(universal, '.codex', 'hooks.json'), path.join(root, '.codex', 'hooks.json'));
  await cp(sessionContract, path.join(root, 'contracts', 'session-messaging', 'v1'), {
    recursive: true,
  });
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'fixture');
  return root;
};

const runBenchmark = async (
  root: string,
  head: string,
  benchmarkRunner = runner,
  cwd = repoRoot,
): Promise<{ code: number; out: string; err: string }> => {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [benchmarkRunner, '--root', root, '--head', head],
      { cwd, env: withoutGitLocation() },
    );
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, out: failed.stdout ?? '', err: failed.stderr ?? '' };
  }
};

const createVerifierFixture = async (): Promise<string> => {
  const verifier = await mkdtemp(path.join(os.tmpdir(), 'policy-benchmark-verifier-'));
  await cp(
    path.join(repoRoot, 'scripts', 'policy-benchmark.mjs'),
    path.join(verifier, 'scripts', 'policy-benchmark.mjs'),
  );
  for (const file of [
    'policy-benchmark-worker.mjs',
    'policy-benchmark-schema.mjs',
    'policy-benchmark-runtime.mjs',
    'policy-benchmark-snapshot.mjs',
  ])
    await cp(path.join(repoRoot, 'scripts', file), path.join(verifier, 'scripts', file));
  const controller = path.join(repoRoot, 'scripts', 'policy-benchmark-controller.mjs');
  if (existsSync(controller))
    await cp(controller, path.join(verifier, 'scripts', 'policy-benchmark-controller.mjs'));
  await cp(path.join(repoRoot, '.claude', 'scripts'), path.join(verifier, '.claude', 'scripts'), {
    recursive: true,
  });
  await cp(
    path.join(repoRoot, 'packages', 'cli', 'dist', 'policy'),
    path.join(verifier, 'packages', 'cli', 'dist', 'policy'),
    {
      recursive: true,
    },
  );
  await cp(path.join(repoRoot, 'package.json'), path.join(verifier, 'package.json'));
  await cp(path.join(repoRoot, 'pnpm-lock.yaml'), path.join(verifier, 'pnpm-lock.yaml'));
  await symlink(
    path.join(repoRoot, 'node_modules'),
    path.join(verifier, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await git(verifier, 'init', '-q');
  await git(verifier, 'config', 'user.email', 'benchmark@example.invalid');
  await git(verifier, 'config', 'user.name', 'Policy benchmark verifier fixture');
  await git(
    verifier,
    'add',
    'scripts',
    '.claude/scripts',
    'packages/cli/dist/policy',
    'package.json',
    'pnpm-lock.yaml',
  );
  await git(verifier, 'commit', '--quiet', '-m', 'verifier fixture');
  return verifier;
};

const expectIsolatedVerifier = async (verifier: string): Promise<void> => {
  expect(path.resolve(verifier)).not.toBe(path.resolve(repoRoot));
  expect(
    await readFile(path.join(verifier, 'scripts', 'policy-benchmark-schema.mjs'), 'utf8'),
  ).toBe(await readFile(path.join(repoRoot, 'scripts', 'policy-benchmark-schema.mjs'), 'utf8'));
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitForFile = async (file: string, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file) && Date.now() < deadline) await delay(25);
  return existsSync(file);
};

describe('policy benchmark security boundaries', () => {
  it('refuses a schema program with top-level effects without executing it', async () => {
    const marker = '__policyBenchmarkSchemaEffect';
    delete (globalThis as Record<string, unknown>)[marker];
    const source = [
      `globalThis.${marker} = 'executed';`,
      "export const sessionMessagingSchema = { $id: 'urn:malicious' };",
    ].join('\n');

    expect(() => parseSessionSchema(source)).toThrow(/top.level|statement|inert/i);
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });

  it('extracts the RP-12 session schema as data without importing its module', async () => {
    const source = await readFile(
      path.join(repoRoot, 'contracts', 'session-messaging', 'v1', 'schema.ts'),
      'utf8',
    );

    expect(parseSessionSchema(source)).toMatchObject({
      $id: 'urn:create-agent-rig:session-messaging:v1',
      $defs: {
        ContractMajor: { const: 1 },
        Envelope: { type: 'object' },
        SessionCapabilities: { type: 'object' },
      },
    });
  });

  it('refuses repeated array spreads before an inert schema expansion exceeds its value budget', async () => {
    const declarations = ['const value0 = [0] as const;'];
    for (let index = 1; index <= 20; index += 1)
      declarations.push(
        `const value${index} = [...value${index - 1}, ...value${index - 1}] as const;`,
      );
    declarations.push('export const sessionMessagingSchema = value20;');

    expect(() => parseSessionSchema(declarations.join('\n'))).toThrow(/budget|limit/i);
  });

  it('refuses a nested shared-alias graph before its semantic value-node budget is exhausted', async () => {
    const declarations = ["const value0 = { type: 'string' } as const;"];
    for (let index = 1; index <= 20; index += 1)
      declarations.push(
        `const value${index} = { left: value${index - 1}, right: value${index - 1} } as const;`,
      );
    declarations.push('export const sessionMessagingSchema = value20;');

    expect(() => parseSessionSchema(declarations.join('\n'))).toThrow(/budget|limit/i);
  });

  it('refuses a traversal basename even when a comment carries a safe decoy export', () => {
    const source = [
      "/* export const FLAG_BASENAME = 'safe-loop-UNATTENDED'; */",
      "export const FLAG_BASENAME = '../../outside-loop-UNATTENDED';",
    ].join('\n');

    expect(() => parseFlagBasename(source)).toThrow(/flag.basename|literal|inert/i);
  });

  it('reads the actual exported flag basename instead of a safe template-literal decoy', () => {
    const source = [
      "const note = `export const FLAG_BASENAME = 'decoy-loop-UNATTENDED'`;",
      "export const FLAG_BASENAME = 'actual-loop-UNATTENDED';",
    ].join('\n');

    expect(parseFlagBasename(source)).toBe('actual-loop-UNATTENDED');
  });

  it('passes a minimal benchmark environment without host credentials, loaders, Git configuration, or run paths', () => {
    const environment = createBenchmarkEnv(
      {
        PATH: 'fixture-path',
        GITHUB_TOKEN: 'host-credential',
        NODE_OPTIONS: '--require host-loader.cjs',
        GIT_CONFIG_PARAMETERS: "'core.fsmonitor=host-command'",
        RIG_RUN_DIR: 'C:\\real-run',
        HOME: 'C:\\Users\\real-user',
        USERPROFILE: 'C:\\Users\\real-user',
      },
      { home: 'C:\\fixture-home', tmp: 'C:\\fixture-tmp' },
    );

    expect(environment).toMatchObject({
      PATH: 'fixture-path',
      HOME: 'C:\\fixture-home',
      USERPROFILE: 'C:\\fixture-home',
    });
    expect(environment).not.toHaveProperty('GITHUB_TOKEN');
    expect(environment).not.toHaveProperty('NODE_OPTIONS');
    expect(environment).not.toHaveProperty('GIT_CONFIG_PARAMETERS');
    expect(environment).not.toHaveProperty('RIG_RUN_DIR');
    expect(Object.values(environment)).not.toContain('C:\\Users\\real-user');
  });

  it('measures committed target bytes even when the live target is edited and carries ignored helpers', async () => {
    const root = await createRepository();
    const destination = await mkdtemp(path.join(os.tmpdir(), 'policy-benchmark-snapshot-'));
    try {
      const head = await commitFixture(root);
      const guard = path.join(
        root,
        'templates',
        'agent-os',
        'universal',
        '.claude',
        'hooks',
        'guard.mjs',
      );
      await writeFile(guard, "export const guard = 'live edit';\n");
      await writeFile(path.join(root, 'ignored-helper.mjs'), "throw new Error('must not run');\n");

      const snapshot = await materializeSnapshot({
        root,
        head,
        destination,
        env: createBenchmarkEnv(process.env, {
          home: path.join(destination, 'home'),
          tmp: path.join(destination, 'tmp'),
        }),
      });

      expect(
        await readFile(path.join(snapshot.surfaceRoot, '.claude', 'hooks', 'guard.mjs'), 'utf8'),
      ).toBe("export const guard = 'committed bytes';\n");
      expect(existsSync(path.join(snapshot.surfaceRoot, 'ignored-helper.mjs'))).toBe(false);
      expect(await readFile(path.join(snapshot.contractRoot, 'schema.ts'), 'utf8')).toContain(
        "sessionMessagingSchema = { $id: 'fixture' }",
      );
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      await rm(destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('rejects a measured Git symlink before a snapshot can dereference it', async () => {
    const root = await createRepository();
    const destination = await mkdtemp(path.join(os.tmpdir(), 'policy-benchmark-snapshot-'));
    try {
      await commitFixture(root);
      const linkPath = 'templates/agent-os/universal/.claude/hooks/guard-link.mjs';
      const blob = await gitWithInput(
        root,
        ['hash-object', '-w', '--stdin'],
        '../../../../outside',
      );
      await git(root, 'update-index', '--add', '--cacheinfo', `120000,${blob},${linkPath}`);
      await git(root, 'commit', '--quiet', '-m', 'add measured link');
      const head = await git(root, 'rev-parse', 'HEAD');

      await expect(
        materializeSnapshot({
          root,
          head,
          destination,
          env: createBenchmarkEnv(process.env, {
            home: path.join(destination, 'home'),
            tmp: path.join(destination, 'tmp'),
          }),
        }),
      ).rejects.toThrow(/symlink|symbolic link/i);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      await rm(destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('does not execute a target repository core.fsmonitor command while materializing its snapshot', async () => {
    const root = await createRepository();
    const destination = await mkdtemp(path.join(os.tmpdir(), 'policy-benchmark-snapshot-'));
    try {
      const head = await commitFixture(root);
      const marker = path.join(root, 'fsmonitor-ran');
      const sentinel = path.join(root, 'fsmonitor-sentinel.mjs');
      await writeFile(
        sentinel,
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`,
      );
      await git(root, 'config', 'core.fsmonitor', `"${process.execPath}" "${sentinel}"`);

      await materializeSnapshot({
        root,
        head,
        destination,
        env: createBenchmarkEnv(process.env, {
          home: path.join(destination, 'home'),
          tmp: path.join(destination, 'tmp'),
        }),
      });

      expect(existsSync(marker), 'the target repository must never run Git hook-like config').toBe(
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      await rm(destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it(
    'refuses a target unattended flag basename that traverses outside its isolated home',
    { timeout: 60_000 },
    async () => {
      const root = await createBenchmarkFixture();
      const outsideBasename = `${path.basename(root)}-outside-loop-UNATTENDED`;
      const sentinel = path.join(root, '..', outsideBasename);
      try {
        await writeFile(sentinel, 'must survive malicious target metadata\n');
        await writeFile(
          path.join(root, '.claude', 'scripts', 'unattended-flag.mjs'),
          `export const FLAG_BASENAME = '../../${outsideBasename}';\n`,
        );
        await git(root, 'add', '.claude/scripts/unattended-flag.mjs');
        await git(root, 'commit', '--quiet', '-m', 'malicious target flag basename');
        const head = await git(root, 'rev-parse', 'HEAD');

        const result = await runBenchmark(root, head);
        expect(result.code).not.toBe(0);
        expect(`${result.out}\n${result.err}`).toMatch(
          /flag.basename|unattended|invalid metadata/i,
        );
        expect(await readFile(sentinel, 'utf8')).toBe('must survive malicious target metadata\n');
      } finally {
        await rm(sentinel, { force: true });
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    },
  );

  it(
    'refuses adapter-process evidence when the measured target head moves after a worker has begun',
    { timeout: BENCHMARK_TIMEOUT_MS },
    async () => {
      const root = await createBenchmarkFixture();
      const synchronised = path.join(root, '..', `${path.basename(root)}-hook-started`);
      const release = path.join(root, '..', `${path.basename(root)}-hook-release`);
      try {
        const guard = path.join(root, '.claude', 'hooks', 'guard-secret-file.mjs');
        await writeFile(
          guard,
          [
            "import { appendFileSync, existsSync } from 'node:fs';",
            `appendFileSync(${JSON.stringify(synchronised)}, \`${'${process.pid},${process.ppid}'}\\n\`);`,
            `while (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 25));`,
            'process.exitCode = 2;',
          ].join('\n'),
        );
        await git(root, 'add', '.claude/hooks/guard-secret-file.mjs');
        await git(root, 'commit', '--quiet', '-m', 'synchronised guard');
        const head = await git(root, 'rev-parse', 'HEAD');

        const running = runBenchmark(root, head);
        let released = false;
        try {
          expect(
            await waitForFile(synchronised, 15_000),
            'a snapshot worker must reach its hook',
          ).toBe(true);
          const observedHookProcesses = (await readFile(synchronised, 'utf8'))
            .trim()
            .split('\n')
            .filter(Boolean);
          expect(
            observedHookProcesses,
            'adapter-process evidence requires an actual hook child, not an execution label',
          ).toEqual(expect.arrayContaining([expect.stringMatching(/^\d+,\d+$/)]));
          await writeFile(path.join(root, 'head-moved'), 'target moved during benchmark\n');
          await git(root, 'add', 'head-moved');
          await git(root, 'commit', '--quiet', '-m', 'move target during measurement');
          await writeFile(release, 'continue\n');
          released = true;

          const result = await running;
          expect(result.code).not.toBe(0);
          expect(`${result.out}\n${result.err}`).toMatch(/target tree changed/);
        } finally {
          if (!released) await writeFile(release, 'continue after assertion failure\n');
          await running.catch(() => undefined);
        }
      } finally {
        await rm(synchronised, { force: true });
        await rm(release, { force: true });
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    },
  );

  it(
    'refuses adapter-process evidence when the isolated verifier bytes change after a worker has begun',
    { timeout: BENCHMARK_TIMEOUT_MS },
    async () => {
      const root = await createBenchmarkFixture();
      const verifier = await createVerifierFixture();
      const synchronised = path.join(root, '..', `${path.basename(root)}-verifier-hook-started`);
      const release = path.join(root, '..', `${path.basename(root)}-verifier-hook-release`);
      try {
        await expectIsolatedVerifier(verifier);
        const guard = path.join(root, '.claude', 'hooks', 'guard-secret-file.mjs');
        await writeFile(
          guard,
          [
            "import { appendFileSync, existsSync } from 'node:fs';",
            `appendFileSync(${JSON.stringify(synchronised)}, \`${'${process.pid},${process.ppid}'}\\n\`);`,
            `while (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 25));`,
            'process.exitCode = 2;',
          ].join('\n'),
        );
        await git(root, 'add', '.claude/hooks/guard-secret-file.mjs');
        await git(root, 'commit', '--quiet', '-m', 'synchronised guard');
        const head = await git(root, 'rev-parse', 'HEAD');

        const running = runBenchmark(
          root,
          head,
          path.join(verifier, 'scripts', 'policy-benchmark.mjs'),
          verifier,
        );
        let released = false;
        try {
          expect(
            await waitForFile(synchronised, 15_000),
            'an isolated verifier worker must reach its hook',
          ).toBe(true);
          await writeFile(
            path.join(verifier, 'scripts', 'policy-benchmark-schema.mjs'),
            '// verifier changed during measurement\n',
            { flag: 'a' },
          );
          await writeFile(release, 'continue\n');
          released = true;

          const result = await running;
          expect(result.code).not.toBe(0);
          expect(`${result.out}\n${result.err}`).toMatch(/verifier changed/);
        } finally {
          if (!released) await writeFile(release, 'continue after assertion failure\n');
          await running.catch(() => undefined);
        }
      } finally {
        await rm(synchronised, { force: true });
        await rm(release, { force: true });
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        await rm(verifier, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    },
  );

  it(
    "names the deadline and earlier commands' timings when a real guard command times out inside a benchmark run",
    { timeout: BENCHMARK_TIMEOUT_MS },
    async () => {
      const root = await createBenchmarkFixture();
      try {
        const guard = path.join(root, '.claude', 'hooks', 'guard-secret-file.mjs');
        await writeFile(guard, '// never exits on its own\nsetInterval(() => {}, 0x7fffffff);\n');
        await git(root, 'add', '.claude/hooks/guard-secret-file.mjs');
        await git(root, 'commit', '--quiet', '-m', 'guard that never exits');
        const head = await git(root, 'rev-parse', 'HEAD');

        const result = await runBenchmark(root, head);

        expect(result.code).not.toBe(0);
        expect(result.err).toMatch(
          /benchmark command .+: timed out after \d+ ms \(stdout \d+ B, stderr \d+ B\); earlier commands in this worker: .*git(\.exe)? \d+ ms exit 0; node(\.exe)? \d+ ms exit 0/,
        );
        expect(result.err).not.toContain(root);
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    },
  );

  it(
    'holds when a copied verifier runtime restores its benign bytes before the controller first fingerprints it',
    { timeout: 60_000 },
    async () => {
      const root = await createBenchmarkFixture();
      const verifier = await createVerifierFixture();
      try {
        await expectIsolatedVerifier(verifier);
        const runtime = path.join(verifier, 'scripts', 'policy-benchmark-runtime.mjs');
        const benignRuntime = await readFile(runtime, 'utf8');
        await writeFile(
          runtime,
          [
            "import { writeFileSync as restoreVerifierRuntime } from 'node:fs';",
            `restoreVerifierRuntime(${JSON.stringify(runtime)}, ${JSON.stringify(benignRuntime)});`,
            benignRuntime,
          ].join('\n'),
        );
        const head = await git(root, 'rev-parse', 'HEAD');

        const result = await runBenchmark(
          root,
          head,
          path.join(verifier, 'scripts', 'policy-benchmark.mjs'),
          verifier,
        );

        expect(result.code).not.toBe(0);
        expect(`${result.out}\n${result.err}`).toMatch(/verifier changed|hold|fingerprint/i);
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        await rm(verifier, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    },
  );

  it(
    'uses Node IPC for a worker result and kills its tree before resolving that result',
    { timeout: 10_000 },
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'policy-benchmark-runtime-'));
      try {
        const marker = path.join(root, 'worker-descendant-survived');
        const descendant = path.join(root, 'worker-descendant.mjs');
        const worker = path.join(root, 'worker.mjs');
        await writeFile(
          descendant,
          `import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'escaped'), 500);`,
        );
        await writeFile(
          worker,
          [
            "import { spawn } from 'node:child_process';",
            "process.on('message', (message) => {",
            "  if (message?.type !== 'policy-benchmark:run') throw new Error('unexpected IPC envelope');",
            `  spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: 'ignore' });`,
            "  process.send?.({ type: 'policy-benchmark:result', report: { payload: message.payload } });",
            '});',
          ].join('\n'),
        );
        let spawnedPid: number | undefined;
        const payload = { harness: 'claude', scenario: 'real-wiring' };

        await expect(
          runWorker(worker, payload, {
            cwd: root,
            env: createBenchmarkEnv(process.env, {
              home: path.join(root, 'home'),
              tmp: path.join(root, 'tmp'),
            }),
            timeoutMs: 1_000,
            onSpawn: (pid: number) => {
              spawnedPid = pid;
            },
          }),
        ).resolves.toEqual({ payload });
        expect(spawnedPid).toEqual(expect.any(Number));
        await delay(800);
        expect(existsSync(marker), 'the reported worker must not leave a live descendant').toBe(
          false,
        );
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    },
  );

  it(
    'terminates descendants when a bounded benchmark process times out',
    { timeout: 10_000 },
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'policy-benchmark-runtime-'));
      try {
        const marker = path.join(root, 'descendant-survived');
        const ready = path.join(root, 'descendant-started');
        const descendant = path.join(root, 'descendant.mjs');
        const parent = path.join(root, 'parent.mjs');
        await writeFile(
          descendant,
          `import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'escaped'), 1_500);`,
        );
        await writeFile(
          parent,
          `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: 'ignore' }); writeFileSync(${JSON.stringify(ready)}, 'started'); setTimeout(() => {}, 5_000);`,
        );

        const running = runProcess(process.execPath, [parent], {
          cwd: root,
          env: createBenchmarkEnv(process.env, {
            home: path.join(root, 'home'),
            tmp: path.join(root, 'tmp'),
          }),
          input: '',
          timeoutMs: 750,
          maxBytes: 1_024,
        });

        expect(await waitForFile(ready, 500), 'the descendant must start before the timeout').toBe(
          true,
        );
        const result = await running;
        expect(result.timedOut).toBe(true);
        await delay(1_000);
        expect(existsSync(marker), 'the timed-out process must not leave a live descendant').toBe(
          false,
        );
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    },
  );
});
