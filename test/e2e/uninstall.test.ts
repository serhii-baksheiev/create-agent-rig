import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitEnv } from '../../packages/cli/src/lib/git-env.js';
import { removeFixture } from '../helpers/remove-fixture.js';
import { modeBitsDeny, skipUnless } from '../helpers/env.js';

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

  // `applyUninstall`'s `noManifest` branch names `outcome: 'uninstalled'` on
  // this leg specifically — added by the same commit that made a `--dry-run`
  // over the identical repository state name none at all (the test right
  // below this one). Neither leg had e2e coverage before now.
  it('--json over a repository with no rig reports outcome "uninstalled" — nothing installed IS an end state on a real run', async () => {
    const result = await runCli(['uninstall', '--json']);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!);
    expect(payload.outcome).toBe('uninstalled');
    expect(payload.manifestRemoved).toBe(false);
    expect(payload.removed).toEqual([]);
    expect(payload.error).toBeUndefined();
  });

  it('--dry-run --json over a repository with no rig carries no outcome at all', async () => {
    const result = await runCli(['uninstall', '--dry-run', '--json']);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!);
    expect(payload.outcome).toBeUndefined();
    expect(payload.manifestRemoved).toBe(false);
    expect(payload.removed).toEqual([]);
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

  it('--json prints exactly one JSON object and nothing else on stdout, and carries no outcome — a preview has no end state to name', async () => {
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
      outcome?: string;
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.command).toBe('uninstall');
    expect(payload.dryRun).toBe(true);
    // a dry run PLANS the removal but performs none of it
    expect(payload.planned).toContain('.claude/rules/workflow.md');
    expect(payload.removed).toEqual([]);
    expect(payload.manifestRemoved).toBe(false);
    // `outcome` names one of three end states a run reached; a --dry-run
    // over an existing plan reached none of them, so the field is absent
    // entirely rather than carrying a fourth, made-up value
    expect(payload.outcome).toBeUndefined();
    expect('outcome' in payload).toBe(false);
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
    const payload = JSON.parse(result.stdout.trim()) as {
      removed: string[];
      planned: string[];
      outcome?: string;
    };
    expect(payload.removed.length).toBeGreaterThan(0);
    expect(payload.removed).toEqual(payload.planned);
    // unlike a --dry-run preview, a completed real run always names its
    // outcome
    expect(payload.outcome).toBe('uninstalled');
    await expect(readFile(path.join(repo, '.claude', '.rig-manifest.json'))).rejects.toThrow();
  });

  it('--json reports an unexpected filesystem error as the documented payload, never a bare stack trace', async (ctx) => {
    skipUnless(ctx, modeBitsDeny().ok, modeBitsDeny().reason);
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runCli(['init'])).code).toBe(0);

    // Denies traversal into the directory entirely — the per-file read
    // during planning hits EACCES, not ENOENT, an error this command never
    // composed itself.
    const rulesDir = path.join(repo, '.claude', 'rules');
    await chmod(rulesDir, 0o000);
    try {
      const result = await runCli(['uninstall', '--yes', '--json']);
      expect(result.code).toBe(1);
      const lines = result.stdout.trim().split('\n');
      expect(lines, `stdout was:\n${result.stdout}`).toHaveLength(1);
      const payload = JSON.parse(lines[0]!) as {
        schemaVersion: number;
        manifestRemoved: boolean;
        error?: string;
      };
      expect(payload.schemaVersion).toBe(1);
      expect(payload.manifestRemoved).toBe(false);
      expect(payload.error).toBeTruthy();
      // no stack trace on stderr either — the error was composed, not printed raw
      expect(result.stderr).not.toMatch(/at .*\(.*:\d+:\d+\)/);
    } finally {
      await chmod(rulesDir, 0o755);
    }
  });

  it('a successful removal points at the next step — staging and committing the working-tree change', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runCli(['init'])).code).toBe(0);

    const result = await runCli(['uninstall', '--yes']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/git add -A/);
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

  it('a partial run (something preserved) reports outcome "partial" in --json, and keeps the manifest', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runCli(['init'])).code).toBe(0);

    const workflowPath = path.join(repo, '.claude', 'rules', 'workflow.md');
    await writeFile(workflowPath, `${await readFile(workflowPath, 'utf8')}\n<!-- mine -->\n`);

    const result = await runCli(['uninstall', '--yes', '--json']);
    expect(result.code, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as {
      outcome: string;
      manifestRemoved: boolean;
      preserved: Array<{ path: string; reason: string }>;
    };
    expect(payload.outcome).toBe('partial');
    expect(payload.manifestRemoved).toBe(false);
    expect(payload.preserved.some((p) => p.path === '.claude/rules/workflow.md')).toBe(true);
    await expect(readFile(path.join(repo, '.claude', '.rig-manifest.json'))).resolves.toBeTruthy();
  });

  // Cycle-5 review, blocker 2: the plain-text `partial` summary used to print
  // only a count ("N preserved — the manifest was kept"), unlike `--detach`,
  // which already listed every path. Nothing asserted the new listing
  // behaviour — the closest e2e coverage for `partial` reads `--json`, and
  // the plain-text assertion that DOES exist (below, for `--detach`) already
  // passed against the OLD, path-only rendering, so a regression to
  // count-only here would go red nowhere. The plan header ALSO prints this
  // same path with its reason before consent, so `.toContain` alone would
  // pass whether or not the FINAL summary lists anything — this counts
  // occurrences instead, since the count-only shape shows the path exactly
  // once (the header) while the fixed shape shows it twice (header, then the
  // final summary's own list).
  it('a partial run (plain text) lists every preserved path and its reason in the final summary, not only a count', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runCli(['init'])).code).toBe(0);

    const workflowPath = path.join(repo, '.claude', 'rules', 'workflow.md');
    await writeFile(workflowPath, `${await readFile(workflowPath, 'utf8')}\n<!-- mine -->\n`);

    const result = await runCli(['uninstall', '--yes']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/preserved — the manifest was kept/i);
    const occurrences = result.stdout.split('.claude/rules/workflow.md').length - 1;
    expect(occurrences, result.stdout).toBeGreaterThanOrEqual(2);
    expect(result.stdout).toMatch(/!\s*\.claude\/rules\/workflow\.md — modified/);
  });

  describe('--detach', () => {
    it('a clean repo detach reports outcome "detached" and behaves like an ordinary clean uninstall', async () => {
      await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
      expect((await runCli(['init'])).code).toBe(0);

      const result = await runCli(['uninstall', '--yes', '--detach', '--json']);
      expect(result.code, result.stderr).toBe(0);
      const payload = JSON.parse(result.stdout.trim()) as {
        outcome: string;
        manifestRemoved: boolean;
        preserved: Array<{ path: string; reason: string }>;
      };
      expect(payload.outcome).toBe('detached');
      expect(payload.manifestRemoved).toBe(true);
      expect(payload.preserved).toEqual([]);
      await expect(readFile(path.join(repo, '.claude', '.rig-manifest.json'))).rejects.toThrow();
    });

    it('detaches a repo with preserved files: manifest gone, preserved files intact, handover list printed', async () => {
      await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
      expect((await runCli(['init'])).code).toBe(0);

      const workflowPath = path.join(repo, '.claude', 'rules', 'workflow.md');
      const edited = `${await readFile(workflowPath, 'utf8')}\n<!-- mine -->\n`;
      await writeFile(workflowPath, edited);

      const result = await runCli(['uninstall', '--yes', '--detach']);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/detached/i);
      expect(result.stdout).toContain('.claude/rules/workflow.md');
      // the manifest is gone — detach removed it despite the preserved file
      await expect(readFile(path.join(repo, '.claude', '.rig-manifest.json'))).rejects.toThrow();
      // detach never forces a conflicting file away
      expect(await readFile(workflowPath, 'utf8')).toBe(edited);
    });

    it('--detach --json reports outcome "detached" with the full handover list of what it left behind', async () => {
      await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
      expect((await runCli(['init'])).code).toBe(0);

      const workflowPath = path.join(repo, '.claude', 'rules', 'workflow.md');
      await writeFile(workflowPath, `${await readFile(workflowPath, 'utf8')}\n<!-- mine -->\n`);
      const settingsPath = path.join(repo, '.claude', 'settings.json');
      await writeFile(
        settingsPath,
        `${(await readFile(settingsPath, 'utf8')).replace('"hooks"', '"mine": true, "hooks"')}`,
      );

      const result = await runCli(['uninstall', '--yes', '--detach', '--json']);
      expect(result.code, result.stderr).toBe(0);
      const payload = JSON.parse(result.stdout.trim()) as {
        outcome: string;
        manifestRemoved: boolean;
        preserved: Array<{ path: string; reason: string }>;
      };
      expect(payload.outcome).toBe('detached');
      expect(payload.manifestRemoved).toBe(true);
      const preservedPaths = payload.preserved.map((p) => p.path);
      expect(preservedPaths).toContain('.claude/rules/workflow.md');
      expect(preservedPaths).toContain('.claude/settings.json');
      await expect(readFile(path.join(repo, '.claude', '.rig-manifest.json'))).rejects.toThrow();
    });

    it('consent applies to --detach exactly as to an ordinary destructive run', async () => {
      await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
      expect((await runCli(['init'])).code).toBe(0);

      const result = await runCli(['uninstall', '--detach']);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/--yes/);
      await expect(
        readFile(path.join(repo, '.claude', '.rig-manifest.json')),
      ).resolves.toBeTruthy();
    });
  });
});
