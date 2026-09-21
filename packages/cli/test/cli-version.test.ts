// RP-19 — the rig bin's own `--version --json` handshake, and the invocation-
// level wiring of `create-agent-rig memory <verb>`. Both live behind `main()`
// in src/index.ts, which is not exported (same reason cli-report.test.ts spawns
// the binary rather than importing a function): the only honest entry point is
// the built CLI.
//
// 🔴 The build lands OUTSIDE `packages/cli/dist`, mirroring cli-report.test.ts
// exactly and for the same reason: `test/template/e2e-pack.test.ts` documents a
// measured race where a concurrent `tsc` rewrites the shared `dist` while
// `npm pack` reads it. This file builds its own sandbox rather than sharing
// cli-report.test.ts's, so it never depends on suite ordering.
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let sandbox: string;
let cliBin: string;
let repo: string;

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

const runCli = async (cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CliRun> => {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cliBin, ...args], {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
};

it('routes doctor --json to read-only aggregate diagnosis instead of creating a directory', async () => {
  const env = { HOME: repo, APPDATA: repo };
  expect((await runCli(repo, ['init'], env)).code).toBe(0);
  const before = await readFile(path.join(repo, 'AGENTS.md'));
  const entries = await readdir(repo);
  const result = await runCli(repo, ['doctor', '--json'], env);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, checks: expect.any(Array) });
  expect(await readFile(path.join(repo, 'AGENTS.md'))).toEqual(before);
  expect(await readdir(repo)).toEqual(entries);
});

beforeAll(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'caf-cli-version-build-'));
  const outDir = path.join(sandbox, 'packages', 'cli', 'dist');
  await mkdir(path.join(sandbox, 'packages', 'cli'), { recursive: true });
  await symlink(path.join(repoRoot, 'templates'), path.join(sandbox, 'templates'), 'dir');
  await copyFile(path.join(repoRoot, 'package.json'), path.join(sandbox, 'package.json'));
  await exec(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      path.join(repoRoot, 'packages', 'cli', 'tsconfig.build.json'),
      '--outDir',
      outDir,
    ],
    { cwd: repoRoot },
  );
  cliBin = path.join(outDir, 'index.js');
}, 120_000);

afterAll(async () => {
  await removeFixture(sandbox);
});

beforeEach(async () => {
  repo = await realpath(await mkdtemp(path.join(tmpdir(), 'caf-cli-version-')));
});

afterEach(async () => {
  await removeFixture(repo);
});

describe("--version --json answers the rig's own handshake (RP-19)", () => {
  it('writes exactly one handshake JSON line to stdout and exits 0', async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };

    const run = await runCli(repo, ['--version', '--json']);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe(
      `${JSON.stringify({
        schemaVersion: 1,
        name: 'create-agent-rig',
        version: pkg.version,
        contractVersion: '1.0',
      })}\n`,
    );
  });

  it('keeps plain --version printing the bare version line, unaffected by the new flag', async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };

    const run = await runCli(repo, ['--version']);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe(`${pkg.version}\n`);
  });
});

describe('create-agent-rig memory <verb> is wired into the CLI (RP-19)', () => {
  it('exits 2 with no verb, and prints nothing to stdout', async () => {
    const run = await runCli(repo, ['memory']);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/doctor/);
    expect(run.stderr).toMatch(/load/);
  });

  it('answers doctor --json with the absent-manifest payload and exit 0 when this machine has no manifest', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'caf-cli-version-home-'));
    try {
      const run = await runCli(repo, ['memory', 'doctor', '--json'], {
        HOME: home,
        APPDATA: home,
      });

      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toBe(
        `${JSON.stringify({ schemaVersion: 1, result: 'unsupported', reason: 'absent' })}\n`,
      );
    } finally {
      await removeFixture(home);
    }
  });
});
