import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliBin = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'caf-e2e-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
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

describe('create-agent-factory <dir>', () => {
  it('generates a project with substituted tokens', async () => {
    const result = await runCli(['my-app'], work);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('my-app');

    const projectDir = path.join(work, 'my-app');
    const pkg = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@my-app/root');
    const readme = await readFile(path.join(projectDir, 'README.md'), 'utf8');
    expect(readme).toContain('# my-app');
    expect(readme).not.toContain('__PROJECT_NAME__');
    expect(readme).not.toContain('__REGION__');
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
});

describe('npm pack tarball (distribution path)', () => {
  it('a packed tarball generates the same tree via npx', async () => {
    const packDir = path.join(work, 'pack');
    await mkdir(packDir);
    const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', packDir], {
      cwd: repoRoot,
    });
    const [packed] = JSON.parse(stdout) as Array<{ filename: string; files: { path: string }[] }>;
    expect(packed).toBeDefined();
    const tarball = path.join(packDir, packed!.filename);

    // The tarball must carry the compiled CLI and the templates, nothing heavy.
    const paths = packed!.files.map((f) => f.path);
    expect(paths).toContain('packages/cli/dist/index.js');
    expect(paths.some((p) => p.startsWith('templates/skeleton/aws-serverless/'))).toBe(true);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);

    const appDir = path.join(work, 'from-tarball');
    await mkdir(appDir);
    await exec('npx', ['--yes', `--package=${tarball}`, 'create-agent-factory', 'tar-app'], {
      cwd: appDir,
      env: { ...process.env, npm_config_cache: path.join(work, 'npx-cache') },
    });
    const pkg = JSON.parse(await readFile(path.join(appDir, 'tar-app', 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@tar-app/root');
  });
});
