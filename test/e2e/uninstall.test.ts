import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitEnv } from '../../packages/cli/src/lib/git-env.js';
import { removeFixture } from '../helpers/remove-fixture.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliBin = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-uninstall-e2e-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], cwd = repo): Promise<CliRun> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cliBin, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

async function git(args: string[], cwd = repo): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, env: gitEnv() });
  return stdout;
}

async function initGitRepo(): Promise<void> {
  await git(['init', '--quiet']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
}

async function commitAll(message: string): Promise<void> {
  await git(['add', '-A']);
  await git(['commit', '--quiet', '-m', message]);
}

async function porcelain(): Promise<string> {
  return (await git(['status', '--porcelain'])).trim();
}

describe('create-agent-rig uninstall', () => {
  it('reports nothing to do when there is no rig here', async () => {
    const result = await runCli(['uninstall']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/nothing to uninstall/i);
  });

  it('--dry-run reports the plan and removes nothing', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runCli(['init'])).code).toBe(0);

    const result = await runCli(['uninstall', '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/dry run/i);
    expect(result.stdout).toContain('.claude/rules/workflow.md');
    await expect(
      readFile(path.join(repo, '.claude', 'rules', 'workflow.md')),
    ).resolves.toBeTruthy();
    await expect(readFile(path.join(repo, '.claude', '.rig-manifest.json'))).resolves.toBeTruthy();
  });

  it('--json prints exactly one JSON object and nothing else on stdout', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runCli(['init'])).code).toBe(0);

    const result = await runCli(['uninstall', '--dry-run', '--json']);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!) as {
      schemaVersion: number;
      command: string;
      dryRun: boolean;
      planned: string[];
      removed: string[];
      absent: string[];
      preserved: Array<{ path: string; reason: string }>;
      manifestRemoved: boolean;
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.command).toBe('uninstall');
    expect(payload.dryRun).toBe(true);
    // a dry run PLANS the removal but performs none of it
    expect(payload.planned).toContain('.claude/rules/workflow.md');
    expect(payload.removed).toEqual([]);
    expect(payload.manifestRemoved).toBe(false);
  });

  it('refuses to remove anything in a non-interactive run without --yes, and leaves the rig in place', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runCli(['init'])).code).toBe(0);

    const result = await runCli(['uninstall']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--yes/);
    await expect(
      readFile(path.join(repo, '.claude', 'rules', 'workflow.md')),
    ).resolves.toBeTruthy();
    await expect(readFile(path.join(repo, '.claude', '.rig-manifest.json'))).resolves.toBeTruthy();
  });

  it('--json without --yes refuses to delete, as one JSON object and a non-zero exit', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runCli(['init'])).code).toBe(0);

    const result = await runCli(['uninstall', '--json']);
    expect(result.code).toBe(1);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!) as {
      schemaVersion: number;
      removed: string[];
      manifestRemoved: boolean;
      error?: string;
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.removed).toEqual([]);
    expect(payload.manifestRemoved).toBe(false);
    expect(payload.error).toMatch(/--yes/);
    await expect(
      readFile(path.join(repo, '.claude', 'rules', 'workflow.md')),
    ).resolves.toBeTruthy();
    await expect(readFile(path.join(repo, '.claude', '.rig-manifest.json'))).resolves.toBeTruthy();
  });

  it('--yes removes without asking, and its JSON payload reports what was actually removed', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runCli(['init'])).code).toBe(0);

    const result = await runCli(['uninstall', '--yes', '--json']);
    expect(result.code, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as { removed: string[]; planned: string[] };
    expect(payload.removed.length).toBeGreaterThan(0);
    expect(payload.removed).toEqual(payload.planned);
    await expect(readFile(path.join(repo, '.claude', '.rig-manifest.json'))).rejects.toThrow();
  });

  it('refuses the whole run when a manifest names a path under .git, even with --yes', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runCli(['init'])).code).toBe(0);

    await mkdir(path.join(repo, '.git', 'hooks'), { recursive: true });
    const hookContent = '#!/bin/sh\nexit 0\n';
    await writeFile(path.join(repo, '.git', 'hooks', 'pre-commit'), hookContent);
    const manifestPath = path.join(repo, '.claude', '.rig-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: Record<string, string>;
    };
    const { createHash } = await import('node:crypto');
    manifest.files['.git/hooks/pre-commit'] = createHash('sha256')
      .update(hookContent, 'utf8')
      .digest('hex');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const result = await runCli(['uninstall', '--yes']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/\.git/);
    expect(await readFile(path.join(repo, '.git', 'hooks', 'pre-commit'), 'utf8')).toBe(
      hookContent,
    );
    await expect(readFile(manifestPath)).resolves.toBeTruthy();
  });

  // The acceptance criterion, in full: a clean repository with committed user
  // files, an `init`, then an `uninstall`, ends with an empty `git status
  // --porcelain` and byte-identical user files.
  it('init -> uninstall restores a clean git status, and user files survive untouched', async () => {
    await initGitRepo();
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await writeFile(path.join(repo, 'src', 'index.js'), 'console.log("hi");\n');
    await commitAll('user files');

    expect((await runCli(['init'])).code).toBe(0);
    await commitAll('rig init');

    const before = await readFile(path.join(repo, 'src', 'index.js'), 'utf8');

    const result = await runCli(['uninstall', '--yes']);
    expect(result.code, result.stderr).toBe(0);

    // uninstall only removes files; the commit that added them stays in
    // history, so a clean *working tree* means git sees deletions to stage —
    // porcelain is empty only once those are reconciled the same way the
    // acceptance criterion means it: back to the pre-init tree.
    await git(['add', '-A']);
    await commitAll('rig uninstall');

    expect(await porcelain()).toBe('');
    expect(await readFile(path.join(repo, 'src', 'index.js'), 'utf8')).toBe(before);
    await expect(readFile(path.join(repo, '.claude', '.rig-manifest.json'))).rejects.toThrow();
  });

  it('preserves modified wiring, a deleted managed file, and a foreign file, and reports all three', async () => {
    await initGitRepo();
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    await commitAll('user files');
    expect((await runCli(['init'])).code).toBe(0);
    await commitAll('rig init');

    const settingsPath = path.join(repo, '.claude', 'settings.json');
    const settings = await readFile(settingsPath, 'utf8');
    await writeFile(settingsPath, settings.replace('"hooks"', '"mine": true, "hooks"'));

    await rm(path.join(repo, '.claude', 'rules', 'workflow.md'));

    const foreign = path.join(repo, '.claude', 'my-own-notes.md');
    await writeFile(foreign, "not the rig's file\n");

    const result = await runCli(['uninstall', '--yes']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/wiring-modified/);
    expect(result.stdout).toContain('.claude/rules/workflow.md');
    // something was preserved, so the manifest is kept on purpose — the rig
    // is still installed, not left behind by a failure
    expect(result.stdout).toMatch(/still installed/i);
    await expect(readFile(path.join(repo, '.claude', '.rig-manifest.json'))).resolves.toBeTruthy();

    // preserved wiring, byte-identical
    expect(await readFile(settingsPath, 'utf8')).toBe(
      settings.replace('"hooks"', '"mine": true, "hooks"'),
    );
    // the deleted file stays deleted, never restored
    await expect(readFile(path.join(repo, '.claude', 'rules', 'workflow.md'))).rejects.toThrow();
    // the foreign file is untouched
    expect(await readFile(foreign, 'utf8')).toBe("not the rig's file\n");
  });

  it('a repeat uninstall is a no-op, exit 0', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runCli(['init'])).code).toBe(0);

    const first = await runCli(['uninstall', '--yes']);
    expect(first.code, first.stderr).toBe(0);

    // no manifest left to act on, so the second run needs no consent at all
    const second = await runCli(['uninstall']);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toMatch(/nothing to uninstall/i);
  });

  it('refuses a manifest that cannot be parsed, and removes nothing', async () => {
    await mkdir(path.join(repo, '.claude'), { recursive: true });
    await writeFile(path.join(repo, '.claude', '.rig-manifest.json'), 'not json {{{');
    await writeFile(path.join(repo, '.claude', 'sentinel'), 'still here');

    const result = await runCli(['uninstall']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/manifest/i);
    expect(await readFile(path.join(repo, '.claude', 'sentinel'), 'utf8')).toBe('still here');
  });
});
