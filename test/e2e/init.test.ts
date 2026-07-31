import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliBin = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-init-e2e-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function runInit(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cliBin, 'init', ...args], {
      cwd: repo,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('create-agent-rig init (into an existing repo)', () => {
  it('installs the process layer and leaves architecture rules out', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    const result = await runInit([]);
    expect(result.code).toBe(0);
    expect(await readFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'utf8')).toContain(
      'TDD',
    );
    await expect(
      readFile(path.join(repo, '.claude', 'rules', 'architecture.md')),
    ).rejects.toThrow();
  });

  it('a dry run writes nothing', async () => {
    const result = await runInit(['--dry-run']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/dry run/i);
    await expect(readFile(path.join(repo, '.claude', 'rules', 'workflow.md'))).rejects.toThrow();
  });

  it('leaves a rig whose hooks are wired and whose scripts parse', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runInit([])).code).toBe(0);

    const settings = JSON.parse(
      await readFile(path.join(repo, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks).length).toBeGreaterThan(0);

    const hooks = await readdir(path.join(repo, '.claude', 'hooks'));
    expect(hooks.sort()).toEqual(
      ['block-no-verify.mjs', 'gate-stop-dod.mjs', 'guard-bash.mjs', 'inject-rules.mjs'].sort(),
    );
    for (const hook of hooks) {
      await exec(process.execPath, ['--check', path.join(repo, '.claude', 'hooks', hook)]);
    }

    // the kill switch is a filename: an unsubstituted token means the brake
    // looks for a file the operator will never create
    const stopFlag = await readFile(path.join(repo, '.claude', 'scripts', 'stop-flag.mjs'), 'utf8');
    expect(stopFlag).toContain(`${path.basename(repo).toLowerCase()}-loop-STOP`);
    expect(stopFlag).not.toContain('__PROJECT_NAME__');
  });

  it('tells the operator when it could not wire the hooks itself', async () => {
    await mkdir(path.join(repo, '.claude'), { recursive: true });
    await writeFile(path.join(repo, '.claude', 'settings.json'), '{}');
    const result = await runInit([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/settings\.json/);
    expect(result.stdout).toMatch(/not wired|merge/i);
    expect(await readFile(path.join(repo, '.claude', 'settings.json'), 'utf8')).toBe('{}');
  });

  it('refuses to clobber an existing CLAUDE.md, as a message not a trace', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), '# host rules');
    const result = await runInit([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/CLAUDE\.md/);
    expect(result.stderr).not.toMatch(/at .*init\.js/);
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe('# host rules');
  });
});
