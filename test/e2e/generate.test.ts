import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

describe('create-agent-rig <dir>', () => {
  it('generates a project with substituted tokens', async () => {
    const result = await runCli(['my-app', '--target', 'aws-serverless'], work);
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

  it('ends on the governance summary, counted from the generated tree', async () => {
    const result = await runCli(['gov-app', '--target', 'aws-serverless'], work);
    expect(result.code).toBe(0);

    const claudeDir = path.join(work, 'gov-app', '.claude');
    const rules = (await readdir(path.join(claudeDir, 'rules'))).length;
    const agents = (await readdir(path.join(claudeDir, 'agents'))).length;
    const hooks = (await readdir(path.join(claudeDir, 'hooks'))).length;
    const skills = (await readdir(path.join(claudeDir, 'skills'))).length;

    // the summary reports what actually landed — never a hardcoded list
    expect(result.stdout).toMatch(new RegExp(`Rules\\s+${rules}\\b`));
    expect(result.stdout).toMatch(new RegExp(`Agents\\s+${agents}\\b`));
    expect(result.stdout).toMatch(new RegExp(`Hooks\\s+${hooks}\\b`));
    expect(result.stdout).toMatch(new RegExp(`Skills\\s+${skills}\\b`));
    expect(result.stdout).toContain('cdk-diff-reviewer');
    expect(result.stdout).toContain('pnpm check');
    // calm and exact: no emoji fireworks, no exclamations, no ANSI in a pipe
    expect(result.stdout).not.toMatch(/🎉|!\s*$/m);
    // eslint-disable-next-line no-control-regex
    expect(result.stdout).not.toMatch(/\[/);
  });

  it('refuses a non-empty target directory with a clear message', async () => {
    await mkdir(path.join(work, 'busy'));
    await writeFile(path.join(work, 'busy', 'keep.txt'), 'x');
    const result = await runCli(['busy', '--target', 'node-service'], work);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not empty/i);
    expect(result.stderr).not.toMatch(/at .*create\.js/); // no stack trace for user errors
  });

  it('prints usage and fails when no directory is given', async () => {
    const result = await runCli([], work);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/usage/i);
  });

  it('prints its version', async () => {
    const result = await runCli(['--version'], work);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // CLI polish brief §5 — the provably breakable one: a prompt here would
  // hang CI. Non-interactive + no --target must fail fast, naming the flag.
  it('non-TTY without --target: errors naming the flag, never prompts', async () => {
    const result = await runCli(['no-tty-app'], work);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--target');
    await expect(readFile(path.join(work, 'no-tty-app', 'package.json'))).rejects.toThrow();
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
    expect(paths.some((p) => p.includes('cdk.out'))).toBe(false);

    const appDir = path.join(work, 'from-tarball');
    await mkdir(appDir);
    await exec(
      'npx',
      ['--yes', `--package=${tarball}`, 'create-agent-rig', 'tar-app', '--target', 'node-service'],
      {
        cwd: appDir,
        env: { ...process.env, npm_config_cache: path.join(work, 'npx-cache') },
      },
    );
    const pkg = JSON.parse(await readFile(path.join(appDir, 'tar-app', 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@tar-app/root');
  });
});
