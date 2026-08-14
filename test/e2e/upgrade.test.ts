import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const exec = promisify(execFile);
const sha256 = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

// U-0: the upgrade path, walked the way a user walks it — the published
// tarball, a rig installed from it, and then a *release that changed files*.
// The manual "delete these six and re-run init" instruction in the 0.3.2
// CHANGELOG is what this replaces, so nothing short of the packed path proves
// it: the template files have to travel in the tarball to be delivered at all.
describe('npm pack → init → upgrade (the delivery path for a changed file)', () => {
  let work: string;
  let cliBin: string;
  let installedTemplates: string;
  /** A process-layer file whose current bytes are a released version. */
  let recognisable: string;

  const runCli = async (
    repo: string,
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await exec(process.execPath, [cliBin, ...args], { cwd: repo });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  };

  /** A repo with the rig installed from the packed CLI, as a user would. */
  const freshRig = async (): Promise<string> => {
    const repo = await mkdtemp(path.join(tmpdir(), 'caf-upgrade-rig-'));
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runCli(repo, ['init'])).code).toBe(0);
    return repo;
  };

  const templateFile = (rel: string): string =>
    path.join(installedTemplates, 'agent-os', 'universal', ...rel.split('/'));

  beforeAll(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'caf-upgrade-e2e-'));
    // Packed once for the whole e2e project — see test/e2e/pack-once.ts.
    const tarball = inject('tarball');

    const prefix = path.join(work, 'install');
    await mkdir(prefix);
    await exec('npm', ['install', '--no-audit', '--no-fund', '--prefix', prefix, tarball], {
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, npm_config_cache: path.join(work, 'npm-cache') },
    });
    const pkgRoot = path.join(prefix, 'node_modules', 'create-agent-rig');
    cliBin = path.join(pkgRoot, 'packages', 'cli', 'dist', 'index.js');
    installedTemplates = path.join(pkgRoot, 'templates');

    // Pick the file to "change in the next release" from the shipped table:
    // one whose bytes today are also the bytes of a released version, so the
    // manifest-less path has something to recognise. A release that rewrote
    // every single file would leave none — that has never happened, and the
    // assertion below says so out loud rather than skipping.
    const history = JSON.parse(
      await readFile(path.join(installedTemplates, 'hash-history.json'), 'utf8'),
    ) as { files: Record<string, { since: string; hashes: string[] }> };
    const probe = await freshRig();
    for (const [rel, { hashes }] of Object.entries(history.files)) {
      // it has to be a file `init` actually installs — the architecture rules
      // ship in the same layer and deliberately stay out of an existing repo
      const installed = await readFile(path.join(probe, ...rel.split('/')), 'utf8').catch(
        () => null,
      );
      if (installed === null) continue;
      const template = await readFile(templateFile(rel), 'utf8').catch(() => null);
      if (template !== null && hashes.includes(sha256(template))) {
        recognisable = rel;
        break;
      }
    }
    await rm(probe, { recursive: true, force: true });
    expect(recognisable, 'no installed file matches any released version').toBeTruthy();
  }, 300_000);

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  /**
   * Run `body` with the next release simulated: one template file in the
   * installed package changed. Restored in `finally` — a failure that leaked a
   * modified template into the next test would make the suite lie about which
   * change broke it.
   */
  const withChangedTemplate = async (
    body: (repo: string, before: string) => Promise<void>,
  ): Promise<void> => {
    const repo = await freshRig();
    const before = await readFile(templateFile(recognisable), 'utf8');
    await writeFile(templateFile(recognisable), `${before}\n<!-- 0.4.0 -->\n`);
    try {
      await body(repo, before);
    } finally {
      await writeFile(templateFile(recognisable), before);
      await rm(repo, { recursive: true, force: true });
    }
  };

  it('delivers a file the release changed, and keeps the one the user edited', async () => {
    await withChangedTemplate(async (repo, before) => {
      const edited = '.claude/rules/invariants.md';
      const mine = `${await readFile(path.join(repo, ...edited.split('/')), 'utf8')}\n<!-- mine -->\n`;
      await writeFile(path.join(repo, ...edited.split('/')), mine);

      const dry = await runCli(repo, ['upgrade', '--dry-run']);
      expect(dry.code).toBe(0);
      expect(dry.stdout).toContain(recognisable);
      expect(dry.stdout).toMatch(/dry run/i);
      expect(await readFile(path.join(repo, ...recognisable.split('/')), 'utf8')).toBe(before);

      const run = await runCli(repo, ['upgrade', '--yes']);
      expect(run.code).toBe(0);
      expect(await readFile(path.join(repo, ...recognisable.split('/')), 'utf8')).toContain(
        '<!-- 0.4.0 -->',
      );
      expect(await readFile(path.join(repo, ...edited.split('/')), 'utf8')).toBe(mine);
      expect(run.stdout).toContain(edited);
    });
  });

  it('upgrades a rig that predates the manifest, and leaves one behind', async () => {
    await withChangedTemplate(async (repo) => {
      await rm(path.join(repo, '.claude', '.rig-manifest.json'));

      const run = await runCli(repo, ['upgrade', '--yes']);
      expect(run.code).toBe(0);
      expect(run.stdout).toMatch(/no manifest/i);
      expect(await readFile(path.join(repo, ...recognisable.split('/')), 'utf8')).toContain(
        '<!-- 0.4.0 -->',
      );
      const manifest = JSON.parse(
        await readFile(path.join(repo, '.claude', '.rig-manifest.json'), 'utf8'),
      ) as { version: string; files: Record<string, string> };
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(manifest.files[recognisable]).toBeTruthy();
    });
  });

  it('refuses to write in a non-interactive run that did not say --yes', async () => {
    await withChangedTemplate(async (repo, before) => {
      const run = await runCli(repo, ['upgrade']);
      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/--yes/);
      expect(await readFile(path.join(repo, ...recognisable.split('/')), 'utf8')).toBe(before);
    });
  });

  it('refuses a repo that has no rig, as a message not a trace', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'caf-upgrade-bare-'));
    // not empty: a CLAUDE.md is in the install set and in nearly every repo an
    // agent has touched — it must not be mistaken for a rig to bring forward
    await writeFile(path.join(empty, 'CLAUDE.md'), '# some other project\n');
    const run = await runCli(empty, ['upgrade', '--yes']);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/No rig found/);
    expect(run.stderr).not.toMatch(/at .*upgrade\.js/);
    await expect(readFile(path.join(empty, '.claude', 'rules', 'workflow.md'))).rejects.toThrow();
    expect(await readFile(path.join(empty, 'CLAUDE.md'), 'utf8')).toBe('# some other project\n');
    await rm(empty, { recursive: true, force: true });
  });
});
