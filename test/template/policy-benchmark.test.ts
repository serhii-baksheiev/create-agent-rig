import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gitEnv as withoutGitLocation } from '../../packages/cli/src/lib/git-env.js';
import { BENCHMARK_CORPUS } from '../../packages/cli/src/policy/benchmark/corpus.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const sessionContract = path.join(repoRoot, 'contracts', 'session-messaging', 'v1');
const runner = path.join(repoRoot, 'scripts', 'policy-benchmark.mjs');
const { benchmarkTimeouts } = (await import(
  new URL('../../scripts/policy-benchmark-runtime.mjs', import.meta.url).href
)) as { benchmarkTimeouts(platform: string): { testMs: number } };
const BENCHMARK_TIMEOUT_MS = benchmarkTimeouts(process.platform).testMs;

type ScenarioReport = {
  id: string;
  capabilityState: string;
  classification: string;
  integrationFailed: boolean;
  passed: boolean;
};

type BenchmarkReport = {
  headSha: string;
  verifier: {
    headSha: string;
    contentSha256: string;
  };
  evidenceKind: string;
  harnesses: Array<{
    harness: string;
    evidence: { kind: string };
    execution: string;
    passed: boolean;
    scenarios: ScenarioReport[];
  }>;
  passed: boolean;
  deferredIntegration: string[];
};

type NativeProcessObservation = {
  pid: number;
  ppid: number;
  parentImage?: string;
};

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', args, { cwd, env: withoutGitLocation() });
  return stdout.trim();
};

const createFixture = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'policy-benchmark-'));
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
  await git(root, 'init');
  await git(root, 'config', 'user.email', 'benchmark@example.invalid');
  await git(root, 'config', 'user.name', 'Policy benchmark fixture');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'fixture');
  return root;
};

const run = async (
  root: string,
  head: string,
): Promise<{ code: number; out: string; err: string }> => {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [runner, '--root', root, '--head', head],
      { cwd: repoRoot, env: withoutGitLocation() },
    );
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, out: failed.stdout ?? '', err: failed.stderr ?? '' };
  }
};

const reportOf = (out: string): BenchmarkReport => JSON.parse(out) as BenchmarkReport;

const observeNativeDispatch = async (root: string, observationFile: string): Promise<void> => {
  const hook = path.join(root, '.claude', 'hooks', 'guard-secret-file.mjs');
  const original = await readFile(hook, 'utf8');
  expect(
    original,
    'the fixture must retain the real secret-write guard while observing it',
  ).toMatch(/guard-secret-file/);
  const observation = `import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const parentImage = process.platform === 'win32'
  ? execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '& { $parent = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = " + [int]$args[0]); [Console]::Out.Write($parent.Name) }',
        String(process.ppid),
      ],
      { encoding: 'utf8', windowsHide: true },
    ).trim()
  : undefined;
appendFileSync(
  ${JSON.stringify(observationFile)},
  JSON.stringify({ pid: process.pid, ppid: process.ppid, parentImage }) + '\\n',
);
`;
  await writeFile(hook, `${observation}\n${original}`);
  await git(root, 'add', '.claude/hooks/guard-secret-file.mjs');
  await git(root, 'commit', '--quiet', '-m', 'observe native harness dispatch');
};

const nativeObservations = async (file: string): Promise<NativeProcessObservation[]> =>
  (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as NativeProcessObservation);

type HookEntry = Record<string, unknown>;
type HookSnapshot = {
  hooks: Record<string, Array<{ hooks?: HookEntry[] }> | undefined>;
};

const prefixTargetCommand = async (
  snapshotFile: string,
  hookPath: string,
): Promise<Array<'command' | 'commandWindows'>> => {
  const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8')) as HookSnapshot;
  const prefixed: Array<'command' | 'commandWindows'> = [];

  for (const groups of Object.values(snapshot.hooks)) {
    for (const group of groups ?? []) {
      for (const entry of group.hooks ?? []) {
        if (
          !Object.values(entry).some(
            (value) => typeof value === 'string' && value.includes(hookPath),
          )
        )
          continue;
        for (const key of ['command', 'commandWindows'] as const) {
          const command = entry[key];
          if (typeof command !== 'string') continue;
          entry[key] = `true || ${command}`;
          prefixed.push(key);
        }
      }
    }
  }

  await writeFile(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`);
  return prefixed;
};

describe('policy benchmark runner', () => {
  it(
    'runs the same versioned corpus in one process per harness and reports adapter-process evidence, not live-harness proof',
    { timeout: process.platform === 'win32' ? 2 * BENCHMARK_TIMEOUT_MS : BENCHMARK_TIMEOUT_MS },
    async () => {
      const root = await createFixture();
      try {
        const head = await git(root, 'rev-parse', 'HEAD');
        const result = await run(root, head);
        expect(result.code, result.err).toBe(0);
        const second = await run(root, head);
        expect(second.code, second.err).toBe(0);
        expect(second.out, 'the same head and snapshots must report deterministically').toBe(
          result.out,
        );

        const report = reportOf(result.out);
        expect(report.headSha).toBe(head);
        expect(report.verifier).toEqual({
          headSha: await git(repoRoot, 'rev-parse', 'HEAD'),
          contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(report.evidenceKind).toBe('adapter-process');
        expect(report.harnesses.map((entry) => entry.harness).sort()).toEqual(['claude', 'codex']);
        expect(report.harnesses.map((entry) => entry.evidence.kind)).toEqual([
          'adapter-process',
          'adapter-process',
        ]);
        expect(report.harnesses.find((entry) => entry.harness === 'codex')?.execution).toBe(
          'configured-adapter-command',
        );
        for (const harness of report.harnesses) {
          expect(harness.scenarios.map((scenario) => scenario.id)).toEqual(
            BENCHMARK_CORPUS.scenarios.map((scenario) => scenario.id),
          );
          expect(
            harness.scenarios.every((scenario) => scenario.passed),
            `${harness.harness} left an expected scenario unmeasured or failing`,
          ).toBe(true);
        }
        expect(report.passed).toBe(true);
        expect(report.deferredIntegration).toEqual(['RP-13', 'RP-14-memory']);
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    },
  );

  it(
    'records an expected integration failure as unsupported evidence instead of a passing enforcement result',
    { timeout: BENCHMARK_TIMEOUT_MS },
    async () => {
      const root = await createFixture();
      try {
        const head = await git(root, 'rev-parse', 'HEAD');
        const result = await run(root, head);
        expect(result.code, result.err).toBe(0);

        const scenarios = reportOf(result.out).harnesses.flatMap((entry) => entry.scenarios);
        const unreadable = scenarios.filter((scenario) => scenario.id === 'unreadable-input');
        expect(unreadable, 'each adapter must measure unreadable input').toHaveLength(2);
        for (const scenario of unreadable) {
          expect(scenario.capabilityState).toBe('INTEGRATION-FAILED');
          expect(scenario.classification).toBe('unsupported');
          expect(scenario.integrationFailed).toBe(true);
          expect(
            scenario.passed,
            'the expected negative must be recognised, not treated as working',
          ).toBe(true);
        }
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    },
  );

  it(
    'observes the native process boundary of each configured harness command',
    { timeout: BENCHMARK_TIMEOUT_MS },
    async () => {
      const root = await createFixture();
      const observationFile = `${root}.native-dispatch.ndjson`;
      try {
        await observeNativeDispatch(root, observationFile);
        const head = await git(root, 'rev-parse', 'HEAD');

        const result = await run(root, head);
        expect(result.code, result.err).toBe(0);
        const observations = await nativeObservations(observationFile);
        expect(observations).toHaveLength(2);
        expect(new Set(observations.map((observation) => observation.pid)).size).toBe(2);

        if (process.platform === 'win32') {
          expect(
            observations.map((observation) => observation.parentImage?.toLowerCase()),
            'Codex must invoke the hook through its configured PowerShell wrapper and Claude directly through Node',
          ).toEqual(
            expect.arrayContaining([
              'powershell.exe',
              path.basename(process.execPath).toLowerCase(),
            ]),
          );
        } else {
          expect(
            observations.every(
              (observation) => Number.isSafeInteger(observation.ppid) && observation.ppid > 0,
            ),
            'each native hook process must expose its observed parent process id',
          ).toBe(true);
        }
      } finally {
        await Promise.all([
          rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
          rm(observationFile, { force: true }),
        ]);
      }
    },
  );

  it(
    'fails the whole benchmark when a committed hook disables the real-wiring baseline',
    { timeout: BENCHMARK_TIMEOUT_MS },
    async () => {
      const root = await createFixture();
      try {
        const hook = path.join(root, '.claude', 'hooks', 'guard-secret-file.mjs');
        const original = await readFile(hook, 'utf8');
        expect(original, 'the fixture must contain the real guard before disabling it').toMatch(
          /guard-secret-file/,
        );
        await writeFile(hook, 'process.stdin.resume();\n');
        await git(root, 'add', '.claude/hooks/guard-secret-file.mjs');
        await git(root, 'commit', '--quiet', '-m', 'disable baseline guard');
        const head = await git(root, 'rev-parse', 'HEAD');

        const result = await run(root, head);
        expect(result.code, 'a broken baseline must fail the runner for CI').not.toBe(0);
        const report = reportOf(result.out);
        expect(report.passed).toBe(false);
        expect(
          report.harnesses
            .find((entry) => entry.harness === 'claude')
            ?.scenarios.find((scenario) => scenario.id === 'real-wiring'),
        ).toMatchObject({ passed: false, classification: 'unsupported' });
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    },
  );

  it(
    'fails both harnesses when committed target wiring bypasses the secret-write guard',
    { timeout: BENCHMARK_TIMEOUT_MS },
    async () => {
      const root = await createFixture();
      try {
        const hookPath = '.claude/hooks/guard-secret-file.mjs';
        expect(
          await prefixTargetCommand(path.join(root, '.claude', 'settings.json'), hookPath),
          'the Claude snapshot must carry the target command before the bypass mutation',
        ).toContain('command');
        expect(
          await prefixTargetCommand(path.join(root, '.codex', 'hooks.json'), hookPath),
          'the Codex snapshot must carry both platform command forms before the bypass mutation',
        ).toEqual(expect.arrayContaining(['command', 'commandWindows']));
        await git(root, 'add', '.claude/settings.json', '.codex/hooks.json');
        await git(root, 'commit', '--quiet', '-m', 'bypass target enforcement wiring');
        const head = await git(root, 'rev-parse', 'HEAD');

        const result = await run(root, head);
        expect(result.code, 'a committed target-wiring bypass must fail the aggregate').not.toBe(0);
        const realWiring = reportOf(result.out)
          .harnesses.flatMap((entry) => entry.scenarios)
          .filter((scenario) => scenario.id === 'real-wiring');
        expect(realWiring).toEqual([
          expect.objectContaining({
            capabilityState: 'INTEGRATION-FAILED',
            classification: 'unsupported',
            integrationFailed: true,
            passed: false,
          }),
          expect.objectContaining({
            capabilityState: 'INTEGRATION-FAILED',
            classification: 'unsupported',
            integrationFailed: true,
            passed: false,
          }),
        ]);
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    },
  );

  it.each([
    {
      hookFile: 'block-no-verify.mjs',
      scenarioId: 'hook-input',
      description: 'no-verify refusal',
    },
    {
      hookFile: 'guard-rulebook.mjs',
      scenarioId: 'protected-rulebook',
      description: 'protected-rulebook refusal',
    },
  ])(
    'fails the whole benchmark when a committed no-op disables $description',
    { timeout: BENCHMARK_TIMEOUT_MS },
    async ({ hookFile, scenarioId }) => {
      const root = await createFixture();
      try {
        const hook = path.join(root, '.claude', 'hooks', hookFile);
        await writeFile(hook, 'process.stdin.resume();\n');
        await git(root, 'add', `.claude/hooks/${hookFile}`);
        await git(root, 'commit', '--quiet', '-m', `disable ${scenarioId} guard`);
        const head = await git(root, 'rev-parse', 'HEAD');

        const result = await run(root, head);
        expect(result.code, `a disabled ${scenarioId} guard must fail the runner for CI`).not.toBe(
          0,
        );
        const report = reportOf(result.out);
        expect(report.passed).toBe(false);
        expect(
          report.harnesses
            .flatMap((entry) => entry.scenarios)
            .filter((scenario) => scenario.id === scenarioId),
        ).toEqual([
          expect.objectContaining({ passed: false, classification: 'unsupported' }),
          expect.objectContaining({ passed: false, classification: 'unsupported' }),
        ]);
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    },
  );

  it(
    'fails compatibility rejection when the foreign-major fixture becomes a valid-major envelope',
    { timeout: BENCHMARK_TIMEOUT_MS },
    async () => {
      const root = await createFixture();
      try {
        const foreignFixture = path.join(
          root,
          'contracts',
          'session-messaging',
          'v1',
          'fixtures',
          'negative',
          'envelope-foreign-major.json',
        );
        const original = JSON.parse(await readFile(foreignFixture, 'utf8')) as {
          value: { contractMajor: number };
        };
        expect(
          original.value.contractMajor,
          'the golden negative remains the positive control',
        ).not.toBe(BENCHMARK_CORPUS.contractMajor);

        const baselineHead = await git(root, 'rev-parse', 'HEAD');
        const baseline = await run(root, baselineHead);
        expect(baseline.code, baseline.err).toBe(0);
        expect(
          reportOf(baseline.out)
            .harnesses.flatMap((entry) => entry.scenarios)
            .filter((scenario) => scenario.id === 'foreign-major'),
        ).toEqual([
          expect.objectContaining({ capabilityState: 'UNSUPPORTED', passed: true }),
          expect.objectContaining({ capabilityState: 'UNSUPPORTED', passed: true }),
        ]);

        original.value.contractMajor = BENCHMARK_CORPUS.contractMajor;
        await writeFile(foreignFixture, `${JSON.stringify(original, null, 2)}\n`);
        await git(
          root,
          'add',
          'contracts/session-messaging/v1/fixtures/negative/envelope-foreign-major.json',
        );
        await git(root, 'commit', '--quiet', '-m', 'make foreign-major fixture valid');
        const head = await git(root, 'rev-parse', 'HEAD');

        const result = await run(root, head);
        expect(
          result.code,
          'a valid-major envelope cannot satisfy a compatibility-rejection scenario',
        ).not.toBe(0);
        const report = reportOf(result.out);
        expect(report.passed).toBe(false);
        expect(
          report.harnesses
            .flatMap((entry) => entry.scenarios)
            .filter((scenario) => scenario.id === 'foreign-major'),
        ).toEqual([
          expect.objectContaining({ passed: false }),
          expect.objectContaining({ passed: false }),
        ]);
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    },
  );

  it(
    'refuses an exact head that no longer names the tree it was asked to label before starting child processes',
    { timeout: BENCHMARK_TIMEOUT_MS },
    async () => {
      const root = await createFixture();
      try {
        const oldHead = await git(root, 'rev-parse', 'HEAD');
        await writeFile(path.join(root, 'unrelated.txt'), 'new tree\n');
        await git(root, 'add', 'unrelated.txt');
        await git(root, 'commit', '--quiet', '-m', 'new fixture tree');

        const result = await run(root, oldHead);
        expect(result.code).not.toBe(0);
        expect(`${result.out}\n${result.err}`).toMatch(/head|sha|tree/i);
        expect(result.out, 'a rejected tree must not publish child-process evidence').not.toContain(
          'adapter-process',
        );
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    },
  );

  it(
    'refuses to label adapter-process evidence while a tracked enforcement input is dirty',
    { timeout: BENCHMARK_TIMEOUT_MS },
    async () => {
      const root = await createFixture();
      try {
        const head = await git(root, 'rev-parse', 'HEAD');
        const hook = path.join(root, '.claude', 'hooks', 'guard-secret-file.mjs');
        await writeFile(hook, `${await readFile(hook, 'utf8')}\n// dirty benchmark fixture\n`);

        const result = await run(root, head);
        expect(result.code).not.toBe(0);
        expect(`${result.out}\n${result.err}`).toMatch(/dirty|tracked|evidence/i);
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    },
  );
});
