import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { describeProbeFailure, probeEnv } from '../helpers/native-vitest-probe.js';
import { removeFixture } from '../helpers/remove-fixture.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configPath = path.join(repoRoot, 'vitest.config.ts');
const PROBE_MARKER = '__RP371_VITEST_CONFIGURATION__';
const vitestCli = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');

interface ResolvedProject {
  name: string;
  maxWorkers: number | undefined;
  testTimeout: number;
  hookTimeout: number;
  groupOrder: number;
}

interface NativeVitestProjects {
  default: ResolvedVitestConfiguration;
  overridden: ResolvedVitestConfiguration;
}

interface ResolvedVitestConfiguration {
  maxWorkers: number | undefined;
  projects: ResolvedProject[];
}

interface WorkerInterval {
  identity: string;
  startedAt: number;
  finishedAt: number;
  availableParallelism: string | undefined;
}

const nativeVitestProjectProbe = String.raw`
  const { createVitest } = await import('vitest/node');
  const configPath = process.argv[1];
  const resolve = async (options) => {
    const vitest = await createVitest({ config: configPath, watch: false, ...options });
    try {
      return {
        maxWorkers: vitest.config.maxWorkers,
        projects: vitest.projects.map((project) => ({
          name: project.config.name,
          maxWorkers: project.config.maxWorkers,
          testTimeout: project.config.testTimeout,
          hookTimeout: project.config.hookTimeout,
          groupOrder: project.config.sequence.groupOrder,
        })),
      };
    } finally {
      await vitest.close();
    }
  };
  process.stdout.write('${PROBE_MARKER}' + JSON.stringify({
    default: await resolve({}),
    overridden: await resolve({ maxWorkers: 4 }),
  }) + '\n');
`;

const sixCpuPreload = `data:text/javascript,${encodeURIComponent(String.raw`
  import os from 'node:os';
  import { syncBuiltinESMExports } from 'node:module';
  os.availableParallelism = () => 6;
  syncBuiltinESMExports();
  process.env.RP371_VITEST_WORKER_PROBE_CPU = String(os.availableParallelism());
`)}`;

// Unchanged from before RP-395: execFile's own default (no timeout kill),
// spelled out so describeProbeFailure has a timeout to report if this ever
// grows one.
const CONFIG_PROBE_TIMEOUT_MS = 0;

function resolveNativeVitestProjects(): Promise<NativeVitestProjects> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--input-type=module', '--eval', nativeVitestProjectProbe, configPath],
      { cwd: repoRoot, timeout: CONFIG_PROBE_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(describeProbeFailure(error, stdout, stderr, CONFIG_PROBE_TIMEOUT_MS)));
          return;
        }

        const payload = stdout
          .split(/\r?\n/)
          .find((line) => line.startsWith(PROBE_MARKER))
          ?.slice(PROBE_MARKER.length);
        if (!payload) {
          reject(new Error(describeProbeFailure(null, stdout, stderr, CONFIG_PROBE_TIMEOUT_MS)));
          return;
        }

        resolve(JSON.parse(payload) as NativeVitestProjects);
      },
    );
  });
}

function projectsByName(projects: ResolvedProject[]): Map<string, ResolvedProject> {
  return new Map(projects.map((project) => [project.name, project]));
}

function workerProbeSource(resultPath: string): string {
  return `
import { writeFile } from 'node:fs/promises';
import { threadId } from 'node:worker_threads';
import { it } from 'vitest';

it('records an overlapping native Vitest worker interval', async () => {
  const startedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 700));
  await writeFile(
    ${JSON.stringify(resultPath)},
    JSON.stringify({
      identity: [process.pid, threadId].join(':'),
      startedAt,
      finishedAt: Date.now(),
      availableParallelism: process.env.RP371_VITEST_WORKER_PROBE_CPU,
    }),
  );
});
`;
}

const WORKER_PROBE_TIMEOUT_MS = 12_000;

function runNativeVitest(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', sixCpuPreload, vitestCli, 'run', ...args],
      { cwd, env, maxBuffer: 1024 * 1024, timeout: WORKER_PROBE_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(describeProbeFailure(error, stdout, stderr, WORKER_PROBE_TIMEOUT_MS)));
          return;
        }
        resolve(stdout + stderr);
      },
    );
  });
}

function maximumOverlap(intervals: WorkerInterval[]): number {
  let active = 0;
  let maximum = 0;
  const events = intervals
    .flatMap((interval) => [
      { at: interval.startedAt, change: 1 },
      { at: interval.finishedAt, change: -1 },
    ])
    .sort((left, right) => left.at - right.at || left.change - right.change);

  for (const event of events) {
    active += event.change;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

async function observeEffectiveWorkers(maxWorkers?: number): Promise<number> {
  const fixtureDir = await mkdtemp(
    path.join(repoRoot, 'test', 'template', 'rp371-vitest-worker-probe-'),
  );
  const env = probeEnv(process.env);

  try {
    const resultPaths = await Promise.all(
      Array.from({ length: 4 }, async (_, index) => {
        const resultPath = path.join(fixtureDir, `result-${index}.json`);
        const fixturePath = path.join(fixtureDir, `worker-${index}.test.ts`);
        await writeFile(fixturePath, workerProbeSource(resultPath));
        return { fixturePath, resultPath };
      }),
    );
    const cliArgs = [
      ...resultPaths.map(({ fixturePath }) => fixturePath),
      '--config',
      configPath,
      '--project',
      'template',
      '--reporter',
      'dot',
    ];
    if (maxWorkers !== undefined) cliArgs.push(`--maxWorkers=${maxWorkers}`);

    await runNativeVitest(cliArgs, repoRoot, env);
    const intervals = await Promise.all(
      resultPaths.map(async ({ resultPath }) => JSON.parse(await readFile(resultPath, 'utf8'))),
    );
    expect(intervals).toHaveLength(4);
    expect(intervals.map((interval) => interval.availableParallelism)).toEqual([
      '6',
      '6',
      '6',
      '6',
    ]);
    expect(new Set(intervals.map((interval) => interval.identity)).size).toBeGreaterThan(1);
    return maximumOverlap(intervals);
  } finally {
    await removeFixture(fixtureDir);
  }
}

it('bounds default native Vitest workers across configured projects without changing test deadlines', async () => {
  const configurations = await resolveNativeVitestProjects();
  const projects = configurations.default.projects;

  expect(projects.map((project) => project.name).sort()).toEqual(['e2e', 'template', 'unit']);
  const defaults = projectsByName(projects);
  expect(defaults.get('unit')).toMatchObject({ testTimeout: 15_000 });
  expect(defaults.get('template')).toMatchObject({ testTimeout: 15_000 });
  expect(defaults.get('e2e')).toMatchObject({
    testTimeout: 300_000,
    hookTimeout: 300_000,
    groupOrder: 1,
  });

  expect(await observeEffectiveWorkers()).toBeLessThanOrEqual(2);
  expect(configurations.default.maxWorkers, 'resolved root default maxWorkers').toBeLessThanOrEqual(
    2,
  );
  for (const project of configurations.default.projects) {
    if (project.maxWorkers !== undefined) {
      expect(project.maxWorkers, `${project.name} resolved default maxWorkers`).toBeLessThanOrEqual(
        2,
      );
    }
  }
  expect(await observeEffectiveWorkers(4)).toBe(4);
  expect(configurations.overridden.maxWorkers, 'resolved root --maxWorkers override').toBe(4);
  for (const project of configurations.overridden.projects) {
    expect(project.maxWorkers, `${project.name} resolved --maxWorkers override`).toBe(4);
  }
});
