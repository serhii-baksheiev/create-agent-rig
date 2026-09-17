import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { installEnv, runPackageManager } from './run.js';
import { removeFixture } from '../helpers/remove-fixture.js';

const exec = promisify(execFile);
const sha256 = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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
    // The CLI flags are redundant with the env — npm's precedence puts CLI above
    // env and both say the same thing — and they are kept because this is the
    // one call site where they were already right: it took 2.8 s in the very CI
    // run where pack-install timed out at 300 s, which is the observation that
    // pointed at audit in the first place.
    await runPackageManager(
      'npm',
      ['install', '--no-audit', '--no-fund', '--prefix', prefix, tarball],
      {
        maxBuffer: 64 * 1024 * 1024,
        env: installEnv(path.join(work, 'npm-cache')),
      },
    );
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
    await removeFixture(probe);
    expect(recognisable, 'no installed file matches any released version').toBeTruthy();
  }, 300_000);

  afterAll(async () => {
    await removeFixture(work);
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
      await removeFixture(repo);
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

  it('upgrades a rig with no readable manifest, and leaves one behind', async () => {
    await withChangedTemplate(async (repo) => {
      // Deleting it is one of the three ways to reach the bootstrapped branch;
      // the others are a rig from before 0.4.0, which never had one, and a
      // manifest on disk that `parseManifest` voids. The header may not name
      // which of the three this is — see cli-report.test.ts › "does not tell a
      // rig whose manifest was deleted that it predates 0.4.0".
      await rm(path.join(repo, '.claude', '.rig-manifest.json'));

      const run = await runCli(repo, ['upgrade', '--yes']);
      expect(run.code).toBe(0);
      expect(run.stdout).toMatch(/no readable manifest/i);
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
    await removeFixture(empty);
  });
});

// RP-177 acceptance: "upgrade of a pre-0.10 generated repository preserves
// application and retired-layer files" — walked against a REAL pre-0.10 rig
// rather than a hand-typed manifest, by rebuilding what release 0.9.1's
// `create --target node-service` would have written from that release's own
// templates (`git show`, not a fixture file this repo would otherwise have
// to keep in sync by hand). CI checks this repo out with `fetch-depth: 0`
// specifically so this history is reachable.
describe('upgrade of a pre-0.10 rig, built from the last release that shipped one (RP-177)', () => {
  // The commit that shipped release 0.9.1 — the last line before RP-177
  // deleted the skeletons and the stack overlays it composed.
  const LEGACY_SHA = 'f5a771b';
  const cliBin = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

  let repo: string;
  let stackRule: string;
  let workflow: string;
  let appPackageJson: string;
  let appNote: string;

  const runCli = async (
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

  const gitShow = async (rel: string): Promise<string> => {
    const { stdout } = await exec('git', ['show', `${LEGACY_SHA}:${rel}`], {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  };

  const plant = async (rel: string, content: string): Promise<void> => {
    const dest = path.join(repo, ...rel.split('/'));
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content);
  };

  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'caf-pre010-'));

    appPackageJson = (await gitShow('templates/skeleton/node-service/package.json')).replaceAll(
      '@app/',
      '@legacy-app/',
    );
    appNote = await gitShow('templates/skeleton/node-service/packages/core/src/note.ts');
    // The retired layer: a stack overlay 0.9.1 composed and RP-177 deleted —
    // never shipped again by any later release.
    stackRule = await gitShow('templates/agent-os/stack/node-ts/.claude/rules/node-ts.md');
    // A still-shipped process file, unchanged between 0.9.1 and today —
    // proof this is not merely "the diff was empty everywhere".
    workflow = await gitShow('templates/agent-os/universal/.claude/rules/workflow.md');

    await plant('package.json', appPackageJson);
    await plant('packages/core/src/note.ts', appNote);
    await plant('.claude/rules/node-ts.md', stackRule);
    await plant('.claude/rules/workflow.md', workflow);

    // Exactly the manifest 0.9.1's `create --target node-service` wrote: kind
    // 'create', the node-ts stack, and a hash per agent-os file it installed
    // (never the skeleton — `recordInstall`'s docstring is explicit that the
    // skeleton is never recorded).
    await plant(
      '.claude/.rig-manifest.json',
      `${JSON.stringify(
        {
          version: '0.9.1',
          kind: 'create',
          project: { name: 'legacy-app', scope: 'legacy-app', region: '' },
          stacks: ['node-ts'],
          files: {
            '.claude/rules/node-ts.md': sha256(stackRule),
            '.claude/rules/workflow.md': sha256(workflow),
          },
        },
        null,
        2,
      )}\n`,
    );
  }, 60_000);

  afterAll(async () => {
    await removeFixture(repo);
  });

  it('retires the deleted stack overlay, and preserves the application and the process layer', async () => {
    const dry = await runCli(['upgrade', '--dry-run']);
    expect(dry.code, dry.stderr).toBe(0);
    // reported, with its own mark — never as `deleted` (nothing was removed)
    // and never as `conflict` (nobody edited it)
    const retiredLine = dry.stdout
      .split('\n')
      .find((line) => line.includes('.claude/rules/node-ts.md'));
    expect(retiredLine, dry.stdout).toMatch(/^\s*x /);
    expect(retiredLine).toMatch(/no longer shipped/i);

    const run = await runCli(['upgrade', '--yes']);
    expect(run.code, run.stderr).toBe(0);

    // never written, never deleted — byte-identical to what 0.9.1 installed
    expect(await readFile(path.join(repo, '.claude', 'rules', 'node-ts.md'), 'utf8')).toBe(
      stackRule,
    );
    // the application code the skeleton generated — never in any install set,
    // in 0.9.1 or today — is untouched
    expect(await readFile(path.join(repo, 'package.json'), 'utf8')).toBe(appPackageJson);
    expect(await readFile(path.join(repo, 'packages', 'core', 'src', 'note.ts'), 'utf8')).toBe(
      appNote,
    );
    // the still-shipped process file was brought forward to what this release
    // ships — here, unchanged since 0.9.1, so recognisably still current
    const current = await readFile(
      path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'rules', 'workflow.md'),
      'utf8',
    );
    expect(await readFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'utf8')).toBe(
      current,
    );

    const manifest = JSON.parse(
      await readFile(path.join(repo, '.claude', '.rig-manifest.json'), 'utf8'),
    ) as { kind: string; stacks: string[]; files: Record<string, string> };
    // `kind` is preserved rather than re-described; `stacks` is written empty —
    // the single payload has no overlays left to record
    expect(manifest.kind).toBe('create');
    expect(manifest.stacks).toEqual([]);
    // the rig no longer vouches for the retired path
    expect(manifest.files['.claude/rules/node-ts.md']).toBeUndefined();
    expect(manifest.files['.claude/rules/workflow.md']).toBeTruthy();
  });
});
