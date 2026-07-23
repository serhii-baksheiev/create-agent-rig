import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('refuses to clobber an existing CLAUDE.md, as a message not a trace', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), '# host rules');
    const result = await runInit([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/CLAUDE\.md/);
    expect(result.stderr).not.toMatch(/at .*init\.js/);
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe('# host rules');
  });
});
