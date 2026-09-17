import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';

import { installEnv, runPackageManager } from './run.js';
import { removeFixture } from '../helpers/remove-fixture.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliBin = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'caf-e2e-'));
});

afterEach(async () => {
  await removeFixture(work);
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], cwd: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cliBin, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

// RP-177: `create <dir>` scaffolds a Git repository plus the harness payload —
// no application code, no `--target`.
describe('create-agent-rig <dir>', () => {
  it('generates a project with substituted tokens', async () => {
    const result = await runCli(['my-app'], work);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('my-app');

    const projectDir = path.join(work, 'my-app');
    const claudeMd = await readFile(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('my-app');
    expect(claudeMd).not.toContain('__PROJECT_NAME__');
    // no application scaffolding of any kind
    await expect(readFile(path.join(projectDir, 'package.json'), 'utf8')).rejects.toThrow();
  });

  it('ends on the governance summary, counted from the generated tree', async () => {
    const result = await runCli(['gov-app'], work);
    expect(result.code).toBe(0);

    const claudeDir = path.join(work, 'gov-app', '.claude');
    const rules = (await readdir(path.join(claudeDir, 'rules'))).length;
    const agents = (await readdir(path.join(claudeDir, 'agents'))).length;
    // `.mjs` only: a config file counted as an enforced hook would inflate the
    // one number this tool exists to make credible.
    const hooks = (await readdir(path.join(claudeDir, 'hooks'))).filter((f) =>
      f.endsWith('.mjs'),
    ).length;
    const skills = (await readdir(path.join(claudeDir, 'skills'))).length;

    // the summary reports what actually landed — never a hardcoded list
    expect(result.stdout).toMatch(new RegExp(`Rules\\s+${rules}\\b`));
    expect(result.stdout).toMatch(new RegExp(`Agents\\s+${agents}\\b`));
    expect(result.stdout).toMatch(new RegExp(`Hooks\\s+${hooks}\\b`));
    expect(result.stdout).toMatch(new RegExp(`Skills\\s+${skills}\\b`));
    // A thin rig has no package.json, so package-manager commands would be
    // false instructions. The only useful next step is to open it in either
    // harness the rig configures.
    expect(result.stdout).toContain('codex');
    expect(result.stdout).toContain('claude');
    expect(result.stdout).not.toContain('pnpm install');
    expect(result.stdout).not.toContain('pnpm check');
    // calm and exact: no emoji fireworks, no exclamations, no ANSI in a pipe
    expect(result.stdout).not.toMatch(/🎉|!\s*$/m);
    expect(result.stdout).not.toMatch(/\[/);
  });

  it('refuses a non-empty target directory with a clear message', async () => {
    await mkdir(path.join(work, 'busy'));
    await writeFile(path.join(work, 'busy', 'keep.txt'), 'x');
    const result = await runCli(['busy'], work);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not empty/i);
    expect(result.stderr).not.toMatch(/at .*create\.js/); // no stack trace for user errors
  });

  it('prints usage and fails when no directory is given', async () => {
    const result = await runCli([], work);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/usage/i);
  });

  it('rejects retired --target without creating the requested directory', async () => {
    const dir = 'retired-target';
    const result = await runCli([dir, '--target', 'node-service'], work);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/unknown option.*target/i);
    expect(result.stderr).toMatch(/usage/i);
    expect(await readdir(work)).not.toContain(dir);
  });

  it('prints its version', async () => {
    const result = await runCli(['--version'], work);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // There is nothing left to prompt for (RP-177 retired `--target` along with
  // the skeletons it selected), so a non-interactive run behaves exactly like
  // an interactive one — this is the regression test for that claim.
  it('a non-TTY run needs no flag at all', async () => {
    const result = await runCli(['no-tty-app'], work);
    expect(result.code, result.stderr).toBe(0);
    await expect(
      readFile(path.join(work, 'no-tty-app', 'CLAUDE.md'), 'utf8'),
    ).resolves.toBeTruthy();
  });
});

describe('npm pack tarball (distribution path)', () => {
  it('a packed tarball generates the same tree via npx', async () => {
    // Packed once for the whole e2e project — see test/e2e/pack-once.ts.
    const tarball = inject('tarball');

    // The tarball must carry the compiled CLI and the templates, nothing heavy.
    const paths = inject('packedPaths');
    expect(paths).toContain('packages/cli/dist/index.js');
    expect(paths.some((p) => p.startsWith('templates/agent-os/universal/'))).toBe(true);
    expect(paths.some((p) => p.startsWith('templates/skeleton/'))).toBe(false);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);

    const appDir = path.join(work, 'from-tarball');
    await mkdir(appDir);
    await runPackageManager(
      'npx',
      ['--yes', `--package=${tarball}`, 'create-agent-rig', 'tar-app'],
      {
        cwd: appDir,
        env: installEnv(path.join(work, 'npx-cache')),
      },
    );
    const claudeMd = await readFile(path.join(appDir, 'tar-app', 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('tar-app');
  });
});
