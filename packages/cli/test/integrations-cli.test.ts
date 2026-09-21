import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { skipUnless } from '../../../test/helpers/env.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let buildRoot: string;
let repo: string;
let cliBin: string;

beforeAll(async () => {
  buildRoot = await mkdtemp(path.join(tmpdir(), 'caf-integrations-cli-build-'));
  const outDir = path.join(buildRoot, 'packages', 'cli', 'dist');
  await mkdir(path.join(buildRoot, 'packages', 'cli'), { recursive: true });
  await copyFile(path.join(repoRoot, 'package.json'), path.join(buildRoot, 'package.json'));
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
  await removeFixture(buildRoot);
});

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-integrations-cli-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

async function runCli(
  args: string[],
  cwd = repo,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cliBin, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const run = error as { code?: number; stdout?: string; stderr?: string };
    return { code: run.code ?? 1, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
  }
}

function oneJson(stdout: string): Record<string, unknown> {
  const payload = JSON.parse(stdout) as Record<string, unknown>;
  expect(stdout).toBe(`${JSON.stringify(payload)}\n`);
  return payload;
}

async function spawnWithClosedStdout(
  args: string[],
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliBin, ...args], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.destroy();
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('setup integrations through the built CLI', () => {
  it('lists the supported integrations as one JSON object', async () => {
    const run = await runCli(['setup', 'list', '--json']);

    expect(run.code, run.stderr).toBe(0);
    expect(oneJson(run.stdout).integrations).toEqual(expect.any(Array));
    expect(run.stderr).toBe('');
  });

  it.each(['add', 'apply', 'remove'] as const)(
    'requires explicit consent before setup %s mutates',
    async (verb) => {
      let declarationBefore: string | undefined;
      let mcpBefore: string | undefined;
      if (verb !== 'add') {
        const seeded = await runCli([
          'setup',
          'add',
          'figma-mcp',
          '--harness',
          'claude-code',
          '--yes',
          '--json',
        ]);
        expect(seeded.code, seeded.stderr).toBe(0);
        declarationBefore = await readFile(path.join(repo, '.rig', 'integrations.json'), 'utf8');
        mcpBefore = await readFile(path.join(repo, '.mcp.json'), 'utf8');
      }

      const args =
        verb === 'add'
          ? ['setup', verb, 'figma-mcp', '--harness', 'claude-code', '--json']
          : ['setup', verb, 'figma-mcp', '--json'];
      const run = await runCli(args);

      expect(run.code).toBe(1);
      expect(oneJson(run.stdout)).toMatchObject({
        outcome: 'refused',
        reason: 'yes-required-for-json-or-noninteractive',
      });
      if (verb === 'add') {
        await expect(
          readFile(path.join(repo, '.rig', 'integrations.json'), 'utf8'),
        ).rejects.toThrow();
        await expect(readFile(path.join(repo, '.mcp.json'), 'utf8')).rejects.toThrow();
      } else {
        expect(await readFile(path.join(repo, '.rig', 'integrations.json'), 'utf8')).toBe(
          declarationBefore,
        );
        expect(await readFile(path.join(repo, '.mcp.json'), 'utf8')).toBe(mcpBefore);
      }
    },
  );

  it('applies then removes an owned integration through the built CLI', async () => {
    const added = await runCli([
      'setup',
      'add',
      'figma-mcp',
      '--harness',
      'claude-code',
      '--yes',
      '--json',
    ]);
    expect(added.code, added.stderr).toBe(0);

    const applied = await runCli(['setup', 'apply', 'figma-mcp', '--yes', '--json']);
    expect(applied.code, applied.stderr).toBe(0);
    expect(oneJson(applied.stdout)).toMatchObject({ outcome: 'written', id: 'figma-mcp' });

    const removed = await runCli(['setup', 'remove', 'figma-mcp', '--yes', '--json']);
    expect(removed.code, removed.stderr).toBe(0);
    expect(oneJson(removed.stdout)).toMatchObject({ outcome: 'removed', id: 'figma-mcp' });
    expect(
      JSON.parse(await readFile(path.join(repo, '.mcp.json'), 'utf8')).mcpServers,
    ).not.toHaveProperty('figma');
    expect(
      JSON.parse(await readFile(path.join(repo, '.rig', 'integrations.json'), 'utf8')),
    ).toEqual({
      schemaVersion: 1,
      integrations: [],
    });
  });

  it('keeps legacy --memory-root dispatch valid and its absent-executable refusal distinct', async () => {
    const memoryRoot = await mkdtemp(path.join(tmpdir(), 'caf-memory-root-'));
    try {
      await mkdir(path.join(memoryRoot, 'shared-memory'), { recursive: true });
      await writeFile(
        path.join(memoryRoot, 'shared-memory', 'memory.mjs'),
        'console.log(JSON.stringify({ schemaVersion: 1, name: "memory", version: "1.0.0", contractVersion: "1.0" }));\n',
      );
      const valid = await runCli(['setup', '--memory-root', memoryRoot, '--dry-run']);
      const refused = await runCli([
        'setup',
        '--memory-root',
        path.join(repo, 'missing-memory-root'),
      ]);

      expect(valid.code, valid.stderr).toBe(0);
      expect(valid.stdout).toContain('Dry run');
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(/^setup: /);
      expect(refused.stderr).not.toContain('Unknown setup verb');
    } finally {
      await removeFixture(memoryRoot);
    }
  });

  it('keeps legacy equals-form --memory-root dispatch on the memory setup command', async () => {
    const memoryRoot = await mkdtemp(path.join(tmpdir(), 'caf-memory-root-equals-'));
    try {
      await mkdir(path.join(memoryRoot, 'shared-memory'), { recursive: true });
      await writeFile(
        path.join(memoryRoot, 'shared-memory', 'memory.mjs'),
        'console.log(JSON.stringify({ schemaVersion: 1, name: "memory", version: "1.0.0", contractVersion: "1.0" }));\n',
      );

      const run = await runCli(['setup', `--memory-root=${memoryRoot}`, '--dry-run']);

      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toContain('Dry run');
      expect(run.stderr).toBe('');
    } finally {
      await removeFixture(memoryRoot);
    }
  });

  it('keeps a successful list exit code when the stdout reader closes early', async (ctx) => {
    skipUnless(
      ctx,
      process.platform !== 'win32',
      'EPIPE semantics on Windows pipes are unverified here',
    );
    const run = await spawnWithClosedStdout(['setup', 'list', '--json']);

    expect(run.code).toBe(0);
    expect(run.stderr).not.toContain('EPIPE');
    expect(run.stderr).not.toContain('    at ');
  });

  it('keeps a refused add exit code when the stdout reader closes early', async (ctx) => {
    skipUnless(
      ctx,
      process.platform !== 'win32',
      'EPIPE semantics on Windows pipes are unverified here',
    );
    const run = await spawnWithClosedStdout(['setup', 'add', 'unknown-provider', '--json']);

    expect(run.code).toBe(1);
    expect(run.stderr).not.toContain('EPIPE');
    expect(run.stderr).not.toContain('    at ');
  });
});
