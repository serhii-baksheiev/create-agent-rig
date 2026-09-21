import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(repoRoot, 'scripts', 'release-acceptance.mjs');
const e2eWorkflow = path.join(repoRoot, '.github', 'workflows', 'e2e.yml');

let fixture: string;

beforeEach(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), 'caf-release-acceptance-'));
  await writeFile(path.join(fixture, 'fixture.txt'), 'unchanged fixture\n');
  await exec('git', ['init', '--quiet'], { cwd: fixture });
  await exec('git', ['add', '--', 'fixture.txt'], { cwd: fixture });
  await exec(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd: fixture },
  );
});

afterEach(async () => {
  await removeFixture(fixture);
});

async function head(): Promise<string> {
  return (await exec('git', ['rev-parse', 'HEAD'], { cwd: fixture })).stdout.trim();
}

async function run(candidate: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [script, '--sha', candidate], {
      cwd: fixture,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return { code: result.code ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }
}

async function fixtureList(): Promise<string[]> {
  return (await readdir(fixture)).sort();
}

async function candidateShaGuard(jobName: 'e2e' | 'windows-e2e'): Promise<string> {
  const yaml = (await readFile(e2eWorkflow, 'utf8')).replace(/\r\n/g, '\n');
  const start = yaml.indexOf(`  ${jobName}:\n`);
  expect(start, `${jobName} job is missing`).toBeGreaterThanOrEqual(0);
  const nextJob = start === -1 ? -1 : yaml.slice(start + 1).search(/\n {2}\S/);
  const end = nextJob === -1 ? undefined : start + 1 + nextJob;
  const job = yaml.slice(start, end);
  const guardAt = job.indexOf('- name: Validate release candidate SHA');
  const checkoutAt = job.indexOf('- uses: actions/checkout@v4');

  expect(guardAt, `${jobName} lacks a fixed candidate SHA guard`).toBeGreaterThanOrEqual(0);
  expect(checkoutAt, `${jobName} lacks candidate checkout`).toBeGreaterThanOrEqual(0);
  expect(guardAt, `${jobName} validates after checkout`).toBeLessThan(checkoutAt);

  const nextStep = job.indexOf('\n      - ', guardAt + 1);
  const guard = job.slice(guardAt, nextStep === -1 ? undefined : nextStep);
  expect(guard).toMatch(/shell:\s*bash/);
  expect(guard).toMatch(/RIG_RELEASE_SHA:\s*\$\{\{ inputs\.release_sha \}\}/);
  const run = guard.match(/^ {8}run: \|\r?\n((?:^ {10}.*(?:\r?\n|$))*)/m);
  expect(run, `${jobName} SHA guard has no executable Bash body`).not.toBeNull();
  return (run?.[1] ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
}

async function runCandidateShaGuard(
  guard: string,
  candidate: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(bashExecutable(), ['-c', guard], {
      env: { ...process.env, RIG_RELEASE_SHA: candidate },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return { code: result.code ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }
}

type FailureFormatter = (phase: unknown, result: unknown) => string;

function bashExecutable(): string {
  // Both platforms execute every guard case; only the shell location differs.
  return process.platform === 'win32'
    ? path.join(
        process.env.ProgramFiles ?? process.env.PROGRAMFILES ?? 'C:\\Program Files',
        'Git',
        'bin',
        'bash.exe',
      )
    : 'bash';
}

async function formatRigFailure(phase: unknown, result: unknown): Promise<string> {
  const module = (await import(pathToFileURL(script).href)) as {
    formatRigFailure?: FailureFormatter;
  };
  expect(module.formatRigFailure).toBeTypeOf('function');
  return module.formatRigFailure!(phase, result);
}

describe('release acceptance candidate preflight', () => {
  it('rejects an invalid candidate SHA before packing or mutating its fixture', async () => {
    const before = await fixtureList();

    const result = await run('not-a-sha');

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'release-acceptance: invalid candidate SHA\n',
    });
    expect(await fixtureList()).toEqual(before);
  });

  it('rejects a well-formed candidate SHA that does not match the checked-out Git HEAD before packing or mutating its fixture', async () => {
    const actual = await head();
    const candidate = actual === '0'.repeat(40) ? '1'.repeat(40) : '0'.repeat(40);
    const before = await fixtureList();

    const result = await run(candidate);

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'release-acceptance: candidate SHA mismatch\n',
    });
    expect(await fixtureList()).toEqual(before);
  });
});

describe('release acceptance workflow candidate guards', () => {
  const jobs = ['e2e', 'windows-e2e'] as const;

  it('accepts a full hexadecimal candidate SHA before checkout in both release jobs', async () => {
    for (const job of jobs) {
      const result = await runCandidateShaGuard(await candidateShaGuard(job), 'aBcD0123'.repeat(5));
      expect(result, job).toMatchObject({ code: 0 });
    }
  });

  it.each([
    ['a ref name', 'master'],
    ['an empty value', ''],
    ['a newline-bearing value', `${'a'.repeat(40)}\nHEAD`],
    ['a shell command string', '$(printf hostile)'],
  ])('refuses %s before candidate checkout in both release jobs', async (_label, candidate) => {
    for (const job of jobs) {
      const result = await runCandidateShaGuard(await candidateShaGuard(job), candidate);
      expect(result.code, job).not.toBe(0);
    }
  });
});

describe('release acceptance packed Rig diagnostics', () => {
  it('reports a finite phase, status and exit without provider output', async () => {
    const privateStdout = 'private stdout sentinel';
    const privateStderr = 'private stderr sentinel';

    const report = await formatRigFailure('spec-kit-add', {
      status: 'failed',
      exitCode: 1,
      stdout: privateStdout,
      stderr: privateStderr,
    });

    expect(report).toBe('packed-rig-command-failed:spec-kit-add:failed:1');
    expect(report).not.toContain(privateStdout);
    expect(report).not.toContain(privateStderr);
  });

  it('maps hostile phase, status and exit values to bounded diagnostics', async () => {
    await expect(
      formatRigFailure('$(private phase)', {
        status: 'private-status',
        exitCode: Number.POSITIVE_INFINITY,
        stdout: 'private stdout sentinel',
        stderr: 'private stderr sentinel',
      }),
    ).resolves.toBe('packed-rig-command-failed:unknown:unknown:unknown');
  });

  it('uses none only for a null exit and rejects out-of-range exits', async () => {
    await expect(
      formatRigFailure('figma-add', { status: 'timeout', exitCode: null }),
    ).resolves.toBe('packed-rig-command-failed:figma-add:timeout:none');
    for (const exitCode of [-1, 0.5, 2 ** 32, '1']) {
      await expect(formatRigFailure('figma-add', { status: 'failed', exitCode })).resolves.toBe(
        'packed-rig-command-failed:figma-add:failed:unknown',
      );
    }
  });
});
