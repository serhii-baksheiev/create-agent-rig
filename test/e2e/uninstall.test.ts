import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitEnv } from '../../packages/cli/src/lib/git-env.js';
import { removeFixture } from '../helpers/remove-fixture.js';
import { modeBitsDeny, skipUnless, symlinksAvailable } from '../helpers/env.js';

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

  // RP-260: a `kept` path (here, the user's own root CLAUDE.md, recorded
  // under `manifest.kept` by the nested-placement install — RP-256 slice 1)
  // is still reported `preserved`, but on its own it must not make the CLI
  // claim the rig is still installed — that wording belongs to a `preserved`
  // path the rig actually still owns bytes for, never a file that was
  // always the user's.
  it('a kept CLAUDE.md alone does not report the rig as still installed', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    await writeFile(path.join(repo, 'CLAUDE.md'), '# host rules\n');
    expect((await runCli(['init'])).code).toBe(0);

    const result = await runCli(['uninstall', '--yes']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toMatch(/still installed/i);
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe('# host rules\n');
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

  // UX/code-lens review, RP-181, cycle 7: a superset-caught dependency now
  // gets its own ("unverified") reason, and the plain-text summary rolls up
  // how many `preserved` paths were genuinely traced versus kept only as a
  // precaution. `guard-secret-file.mjs` symlinked, with `.claude/settings.json`
  // also preserved as edited, is the exact scenario that produces a large
  // unverified sweep — real, on the built CLI, not only in the unit suite.
  // Cycle-8 review (code, security and UX lenses independently): the FIRST
  // version of this test asserted only that the two roll-up phrases and the
  // unverified reason APPEARED, never that either count was right, and
  // never that a genuinely wiring-named hook got the direct wording — which
  // is exactly why a precedence bug (an unreadable seed's sweep retroactively
  // marking six OTHER, already-wiring-named hooks as merely "unverified",
  // because nothing cleared the mark when they were later read and traced
  // as their own seed) shipped and still passed. This test now pins the EXACT numbers
  // security measured against the built CLI (15 genuinely referenced or
  // imported — 7 direct hooks + 6 real imports + the two non-dependency
  // entries `settings.json` and `guard-secret-file.mjs` themselves, neither
  // of whose OWN reasons start with "protected because" — and 10 kept only
  // as a precaution) and that a directly-wired hook the sweep used to
  // swallow gets the DIRECT wording back, not the caution one.
  //
  // The precaution-only count was 29 before RP-180: `init` here installs Lean
  // Core only (no `--layer workflow`), and the superset sweep's precaution
  // bucket is every owned `.mjs` path the direct/imported trace does not
  // already account for — a smaller Core install set means fewer such paths,
  // not a change in how the sweep itself works. The 15 genuinely-traced count
  // is unchanged: every hook `.claude/settings.json` wires, and their real
  // imports, are unaffected by which OTHER files moved to the opt-in layer.
  it('a run with a symlinked, single-seeded hook dependency rolls up the EXACT genuinely-traced versus precaution-only counts', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runCli(['init'])).code).toBe(0);

    const settingsPath = path.join(repo, '.claude', 'settings.json');
    const settings = await readFile(settingsPath, 'utf8');
    await writeFile(settingsPath, settings.replace('"hooks"', '"mine": true, "hooks"'));

    const guardSecretFile = path.join(repo, '.claude', 'hooks', 'guard-secret-file.mjs');
    const original = await readFile(guardSecretFile, 'utf8');
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-uninstall-e2e-outside-'));
    try {
      const target = path.join(outside, 'external-guard-secret-file.mjs');
      await writeFile(target, original);
      await rm(guardSecretFile);
      await symlink(target, guardSecretFile);

      const result = await runCli(['uninstall', '--yes']);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        '(15 genuinely referenced or imported; 10 kept only as a precaution',
      );
      expect(result.stdout).toContain(
        'protected because .claude/hooks/guard-secret-file.mjs could not be read',
      );
      // The exact defect this test now guards: guard-bash.mjs (and the other
      // six hooks .claude/settings.json wires directly) must carry the
      // DIRECT wording, not the precaution one — the sweep triggered by the
      // symlinked guard-secret-file.mjs used to swallow them.
      expect(result.stdout).toMatch(
        /! \.claude\/hooks\/guard-bash\.mjs — still referenced by \.claude\/settings\.json, which was preserved as edited/,
      );
      expect(result.stdout).not.toMatch(/! \.claude\/hooks\/guard-bash\.mjs — protected because/);
      await expect(
        readFile(path.join(repo, '.claude', 'scripts', 'lib', 'secrets.mjs')),
      ).resolves.toBeTruthy();
    } finally {
      await removeFixture(outside);
    }
  });

  // Cycle-9 review (code, security and UX lenses independently): the test
  // above pins the ONE position the cycle-8 fix handled — the unreadable
  // seed first in `.claude/settings.json`'s text order. With it LAST, all
  // seven other wired hooks went back to the precaution wording and the
  // roll-up printed 9/35. The roll-up is checked here against a count made
  // from the report's own per-path lines, not against a number production
  // computed: the two are printed by different code, and they must agree.
  it('the roll-up matches the per-path reasons when the unreadable hook is the LAST one the wiring names', async (ctx) => {
    skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runCli(['init'])).code).toBe(0);

    const settingsPath = path.join(repo, '.claude', 'settings.json');
    const settings = await readFile(settingsPath, 'utf8');
    await writeFile(settingsPath, settings.replace('"hooks"', '"mine": true, "hooks"'));
    const wired = [...settings.matchAll(/\.claude\/hooks\/([\w-]+)\.mjs/g)].map((m) => m[1]!);
    const last = wired.at(-1)!;
    const others = [...new Set(wired)].filter((name) => name !== last);
    expect(others.length).toBeGreaterThanOrEqual(6);

    const lastHook = path.join(repo, '.claude', 'hooks', `${last}.mjs`);
    const outside = await mkdtemp(path.join(tmpdir(), 'caf-uninstall-e2e-outside-'));
    try {
      const target = path.join(outside, 'external.mjs');
      await writeFile(target, await readFile(lastHook, 'utf8'));
      await rm(lastHook);
      await symlink(target, lastHook);

      const result = await runCli(['uninstall', '--yes']);
      expect(result.code, result.stderr).toBe(0);
      for (const name of others) {
        expect(result.stdout).toContain(
          `! .claude/hooks/${name}.mjs — still referenced by .claude/settings.json, which was preserved as edited`,
        );
      }
      // the report lists the preserved paths twice — once in the plan, once
      // in the result — so count each PATH once
      const reasonByPath = new Map<string, string>();
      for (const line of result.stdout.split('\n')) {
        const entry = /^\s*! (\S+)\s+— (.*)$/.exec(line);
        if (entry) reasonByPath.set(entry[1]!, entry[2]!);
      }
      const precaution = [...reasonByPath.values()].filter((reason) =>
        reason.startsWith('protected because'),
      );
      expect(precaution.length).toBeGreaterThan(0);
      expect(result.stdout).toContain(
        `(${reasonByPath.size - precaution.length} genuinely referenced or imported; ${precaution.length} kept only as a precaution`,
      );
    } finally {
      await removeFixture(outside);
    }
  });

  // The control the UX lens ran independently: no unreadable seed at all, so
  // every one of the seven hooks `.claude/settings.json` wires directly must
  // get the DIRECT wording and NONE of the preserved set is merely
  // "unverified" — this is what proves the direct-wording logic itself was
  // always fine, and only broke when an unreadable sibling swept first.
  it('deleting a hook file (no unreadable seed at all) leaves every remaining wired hook with the direct wording and zero unverified entries', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runCli(['init'])).code).toBe(0);

    const settingsPath = path.join(repo, '.claude', 'settings.json');
    const settings = await readFile(settingsPath, 'utf8');
    await writeFile(settingsPath, settings.replace('"hooks"', '"mine": true, "hooks"'));
    await rm(path.join(repo, '.claude', 'hooks', 'block-no-verify.mjs'));

    const result = await runCli(['uninstall', '--yes']);
    expect(result.code, result.stderr).toBe(0);
    // no roll-up line at all — nothing was kept only as a precaution
    expect(result.stdout).not.toMatch(/kept only as a precaution/);
    expect(result.stdout).not.toContain('protected because');
    for (const hook of [
      'gate-stop-dod',
      'guard-bash',
      'guard-rulebook',
      'guard-subagent-model',
      'inject-rules',
      'warn-subagent-routing',
    ]) {
      expect(result.stdout).toMatch(
        new RegExp(
          `! \\.claude/hooks/${hook}\\.mjs — still referenced by \\.claude/settings\\.json, which was preserved as edited`,
        ),
      );
    }
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

// RP-180 round 4, blocker B: round 3's decision record said "uninstall, then
// a fresh init" reaches Core-only. Measured on the built CLI, that is true
// only when nothing on the rig was ever edited — the moment `uninstall`
// has to preserve even one file, it keeps the manifest (still recording
// both layers), and a plain `init` afterward reads that surviving manifest
// and reinstalls the entire workflow layer right back (measured: 87 -> 2 ->
// 87 again). `--detach` is the procedure that actually reaches Core-only in
// that case: it removes the manifest regardless of what it had to preserve,
// so the next plain `init` finds no manifest and installs Core only.
describe('the opt-out procedure to Core-only, measured (RP-180 round 4, blocker B)', () => {
  const manifestPath = (): string => path.join(repo, '.claude', '.rig-manifest.json');

  async function readManifestJson(): Promise<{ layers: string[] } | null> {
    try {
      return JSON.parse(await readFile(manifestPath(), 'utf8')) as { layers: string[] };
    } catch {
      return null;
    }
  }

  it('nothing edited: uninstall --yes then a plain init reaches Core-only on its own', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runCli(['init', '--layer', 'workflow'])).code).toBe(0);

    const uninstallResult = await runCli(['uninstall', '--yes']);
    expect(uninstallResult.code, uninstallResult.stderr).toBe(0);
    // nothing preserved -> the manifest itself is gone
    await expect(readFile(manifestPath())).rejects.toThrow();

    const initResult = await runCli(['init']);
    expect(initResult.code, initResult.stderr).toBe(0);

    const manifest = await readManifestJson();
    expect(manifest?.layers).toEqual(['process']);
    await expect(readFile(path.join(repo, '.claude', 'queue.json'))).rejects.toThrow();
    await expect(readFile(path.join(repo, 'journal', 'README.md'))).rejects.toThrow();
  });

  it('one file edited: plain uninstall + plain init does NOT reach Core-only (measured, for the record)', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runCli(['init', '--layer', 'workflow'])).code).toBe(0);
    const journalPath = path.join(repo, 'journal', 'README.md');
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}\n<!-- edited -->\n`);

    expect((await runCli(['uninstall', '--yes'])).code).toBe(0);
    // something preserved -> the manifest survives, still naming both layers
    const survived = await readManifestJson();
    expect(survived?.layers?.sort()).toEqual(['process', 'workflow']);

    expect((await runCli(['init'])).code).toBe(0);
    const after = await readManifestJson();
    // the documented-in-round-3 procedure does NOT reach Core-only here
    expect(after?.layers?.sort()).toEqual(['process', 'workflow']);
    await expect(readFile(path.join(repo, '.claude', 'queue.json'))).resolves.toBeTruthy();
  });

  it('one file edited: uninstall --yes --detach then a plain init reaches Core-only, preserving only the edited file', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runCli(['init', '--layer', 'workflow'])).code).toBe(0);
    const journalPath = path.join(repo, 'journal', 'README.md');
    const edited = `${await readFile(journalPath, 'utf8')}\n<!-- edited -->\n`;
    await writeFile(journalPath, edited);

    const detachResult = await runCli(['uninstall', '--yes', '--detach']);
    expect(detachResult.code, detachResult.stderr).toBe(0);
    // --detach removes the manifest regardless of what it preserved
    await expect(readFile(manifestPath())).rejects.toThrow();
    // the edited file is handed over, not deleted
    expect(await readFile(journalPath, 'utf8')).toBe(edited);

    const initResult = await runCli(['init']);
    expect(initResult.code, initResult.stderr).toBe(0);

    const manifest = await readManifestJson();
    expect(manifest?.layers).toEqual(['process']);
    // no OTHER (un-preserved) workflow file reappeared
    await expect(readFile(path.join(repo, '.claude', 'queue.json'))).rejects.toThrow();
    await expect(
      readFile(path.join(repo, '.claude', 'scripts', 'run-state.mjs')),
    ).rejects.toThrow();
    // the one preserved file is exactly, and only, what survives
    expect(await readFile(journalPath, 'utf8')).toBe(edited);
  });
});
