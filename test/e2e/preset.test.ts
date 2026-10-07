// RP-314: `--preset <name>` on `init` and `create` — not `--profile` (the 1.0
// command contract already uses "profile" for Codex agent profiles, and no
// named configuration profile exists in the public surface before this).
// `templates/agent-os/profiles.json` names two presets this release ships:
// `minimal` (exactly the default install) and `sdd` (the workflow layer plus
// the Spec Kit integration NAME, for doctor to expect — not to install). This
// file pins:
//   - validation happens before any write, for both commands;
//   - `--preset minimal` installs byte-identical files to a plain `init`/
//     `create`, differing only by the manifest's added `preset` key;
//   - `--preset` composes with `--layer workflow` (union, additive only);
//   - `--preset sdd` installs exactly what `--layer workflow` installs —
//     byte-identical, manifest differing only by `preset` — writes NO
//     `.rig/integrations.json`, and prints `setup add spec-kit` as the next
//     step.
//
// Jira RP-314 comment 23375 (owner decision) resolved what an earlier pass
// over this item flagged as a tension between "same effective payload as …
// setup add spec-kit" and `runSpecKitLifecycle`'s dirty-working-tree refusal
// (`packages/cli/src/integrations/spec-kit.ts`): `init`/`create` never
// install, declare or run a preset's integrations at all. A preset's
// `integrations` list is what DOCTOR expects (see
// `packages/cli/test/preset-doctor.test.ts`), never something `init`/
// `create` act on — so the dirty-tree question above does not arise.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliBin = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

type Run = { code: number; stdout: string; stderr: string };

/**
 * A fresh install target, one mkdtemp parent deep so the directory ITSELF
 * is always named `rig` — several installed files substitute the PROJECT
 * NAME `projectNameFor` (`packages/cli/src/commands/init.ts`) derives from
 * the install directory's own basename (AGENTS.md's title, PLAN.md,
 * `stop-flag.mjs`'s kill-switch filename, `unattended-flag.mjs`, the loop
 * skill, `.codex/hooks.json`, `.claude/settings.json`). `mkdtemp` itself
 * never returns the same basename twice, so comparing two bare mkdtemp
 * results for byte-identical output always differs by exactly that name —
 * nesting one fixed name under mkdtemp's own unique parent keeps the
 * fixtures isolated while giving every fixture in this file the same
 * derived project name.
 */
async function freshRepoDir(prefix: string): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), prefix));
  const dir = path.join(parent, 'rig');
  await mkdir(dir);
  return dir;
}

let repo: string;

beforeEach(async () => {
  repo = await freshRepoDir('caf-preset-e2e-');
});

afterEach(async () => {
  await removeFixture(path.dirname(repo));
});

/**
 * The realpath of the OS temp root, resolved once and cached — `mkdtemp`
 * itself can return a path that is a symlink away from `os.tmpdir()` on
 * macOS (`/tmp` → `/private/tmp`), so comparing the raw strings would refuse
 * every legitimate fixture.
 */
let tmpRootReal: string | undefined;

/**
 * Refuses to spawn the CLI anywhere outside the OS temp tree. This exists
 * because of a real incident: a debugging command run outside this file,
 * against the worktree's own `packages/cli/dist/index.js`, was missing a
 * `cd` into its own fixture directory and ran `init` with cwd = the
 * worktree root — appending a managed region to the worktree's own
 * AGENTS.md and writing a manifest there. Every CLI spawn in this file goes
 * through `runCli`, so this is the one place that has to hold the line.
 */
async function assertTempCwd(cwd: string): Promise<void> {
  if (tmpRootReal === undefined) tmpRootReal = await realpath(tmpdir());
  let real: string;
  try {
    real = await realpath(cwd);
  } catch (error) {
    throw new Error(`refusing to spawn the CLI: cwd does not exist (${cwd})`, { cause: error });
  }
  if (real !== tmpRootReal && !real.startsWith(`${tmpRootReal}${path.sep}`)) {
    throw new Error(
      `refusing to spawn the CLI with cwd outside the OS temp root: ${cwd} (resolved ${real}, temp root ${tmpRootReal})`,
    );
  }
}

async function runCli(args: string[], cwd: string): Promise<Run> {
  await assertTempCwd(cwd);
  try {
    const { stdout, stderr } = await exec(process.execPath, [cliBin, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const runInit = (args: string[], cwd = repo): Promise<Run> => runCli(['init', ...args], cwd);

/**
 * Every file under `root`, as repo-relative POSIX paths, sorted — an
 * independent walk, not a production helper.
 *
 * Collects ABSOLUTE paths through the recursion and relativizes exactly
 * once, at the end, against `root`. A prior version relativized at every
 * recursion level — `return files.flat().map((f) => path.relative(root,
 * f)...)` inside the recursive function itself — which re-applied
 * `path.relative` to strings that were already relative once they came back
 * up from a nested call. `path.relative` resolves a relative input against
 * `process.cwd()` before comparing, so each extra application silently
 * re-rooted the path at the test RUNNER's cwd (the worktree) instead of the
 * fixture root, compounding with depth: a file 3 directories deep came out
 * as `../../../../../../Users/Users/Users/eru/…` — three "Users" for three
 * redundant re-relativizations — and `hashTree` then tried to open that
 * bogus path and got ENOENT. Reproduced and fixed in isolation before this
 * edit; not a production defect.
 */
async function walkAbsolute(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walkAbsolute(full) : Promise.resolve([full]);
    }),
  );
  return files.flat();
}

async function walk(root: string): Promise<string[]> {
  const absolutes = await walkAbsolute(root);
  return absolutes.map((f) => path.relative(root, f).split(path.sep).join('/')).sort();
}

/** sha256 of each file's bytes, keyed by its repo-relative path. */
async function hashTree(root: string, rels: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of rels) {
    out[rel] = createHash('sha256')
      .update(await readFile(path.join(root, ...rel.split('/'))))
      .digest('hex');
  }
  return out;
}

async function manifestOf(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.join(root, '.claude', '.rig-manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
}

describe('create-agent-rig init --preset validation (RP-314)', () => {
  it('refuses an unknown preset name, naming the known presets, and writes nothing', async () => {
    const result = await runInit(['--preset', 'nope']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/nope/);
    expect(result.stderr).toMatch(/minimal/);
    expect(result.stderr).toMatch(/sdd/);
    expect(await readdir(repo)).toEqual([]);
  });

  it('refuses an empty --preset value, and writes nothing', async () => {
    const result = await runInit(['--preset', '']);
    expect(result.code).toBe(1);
    expect(await readdir(repo)).toEqual([]);
  });

  it('refuses a repeated --preset flag, and writes nothing', async () => {
    const result = await runInit(['--preset', 'minimal', '--preset', 'sdd']);
    expect(result.code).toBe(1);
    expect(await readdir(repo)).toEqual([]);
  });

  it('refuses a bare --preset with no value, and writes nothing', async () => {
    const result = await runInit(['--preset']);
    expect(result.code).toBe(1);
    expect(await readdir(repo)).toEqual([]);
  });

  it('never mentions --profile in its own usage text — "profile" already means a Codex agent profile', async () => {
    const result = await runInit(['--help']);
    expect(`${result.stdout}${result.stderr}`).not.toContain('--profile');
  });
});

describe('create-agent-rig <dir> --preset validation (RP-314)', () => {
  const runCreate = (args: string[]): Promise<Run> => runCli([...args], repo);

  it('refuses an unknown preset name before creating the target directory', async () => {
    const result = await runCreate(['app', '--preset', 'nope']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/nope/);
    expect(result.stderr).toMatch(/minimal/);
    expect(result.stderr).toMatch(/sdd/);
    await expect(readdir(path.join(repo, 'app'))).rejects.toThrow();
  });

  it('refuses a repeated --preset flag before creating the target directory', async () => {
    const result = await runCreate(['app', '--preset', 'minimal', '--preset', 'sdd']);
    expect(result.code).toBe(1);
    await expect(readdir(path.join(repo, 'app'))).rejects.toThrow();
  });
});

describe('--preset minimal is exactly the default install (RP-314)', () => {
  it('installs the same file tree and bytes as a plain init, manifest differing only by the added preset key', async () => {
    const repoB = await freshRepoDir('caf-preset-e2e-b-');
    try {
      const plain = await runInit([], repo);
      expect(plain.code, plain.stderr).toBe(0);
      const presetRun = await runInit(['--preset', 'minimal'], repoB);
      expect(presetRun.code, presetRun.stderr).toBe(0);

      const treeA = await walk(repo);
      const treeB = await walk(repoB);
      expect(treeB).toEqual(treeA);

      const nonManifest = treeA.filter((rel) => rel !== '.claude/.rig-manifest.json');
      expect(await hashTree(repoB, nonManifest)).toEqual(await hashTree(repo, nonManifest));

      const manifestA = await manifestOf(repo);
      const manifestB = await manifestOf(repoB);
      expect(manifestA.preset).toBeUndefined();
      expect(manifestB.preset).toBe('minimal');
      expect({ ...manifestB, preset: undefined }).toEqual({ ...manifestA, preset: undefined });
    } finally {
      await removeFixture(path.dirname(repoB));
    }
  });

  it('composes with --layer workflow — the union of both, never one replacing the other', async () => {
    const result = await runInit(['--preset', 'minimal', '--layer', 'workflow']);
    expect(result.code, result.stderr).toBe(0);
    const manifest = await manifestOf(repo);
    expect((manifest.layers as string[]).sort()).toEqual(['process', 'workflow']);
    expect(manifest.preset).toBe('minimal');
    await expect(
      readFile(path.join(repo, '.claude', 'skills', 'loop', 'SKILL.md')),
    ).resolves.toBeTruthy();
  });
});

// Jira RP-314 comment 23375 (owner decision): `init --preset sdd` is exactly
// the `--layer workflow` payload plus the recorded `preset` key and a printed
// next step — never an install, a declaration, or a run of Spec Kit itself.
describe('--preset sdd is exactly --layer workflow, plus the recorded name and a printed next step (RP-314)', () => {
  it('installs the same file tree and bytes as --layer workflow, manifest differing only by the added preset key, and writes no .rig/integrations.json', async () => {
    const repoB = await freshRepoDir('caf-preset-e2e-sdd-');
    try {
      const layerOnly = await runInit(['--layer', 'workflow'], repo);
      expect(layerOnly.code, layerOnly.stderr).toBe(0);
      const presetRun = await runInit(['--preset', 'sdd'], repoB);
      expect(presetRun.code, presetRun.stderr).toBe(0);

      const treeA = await walk(repo);
      const treeB = await walk(repoB);
      expect(treeB).toEqual(treeA);

      const nonManifest = treeA.filter((rel) => rel !== '.claude/.rig-manifest.json');
      expect(await hashTree(repoB, nonManifest)).toEqual(await hashTree(repo, nonManifest));

      const manifestA = await manifestOf(repo);
      const manifestB = await manifestOf(repoB);
      expect(manifestA.preset).toBeUndefined();
      expect(manifestB.preset).toBe('sdd');
      expect({ ...manifestB, preset: undefined }).toEqual({ ...manifestA, preset: undefined });

      // Explicit, on top of the tree-equality check above: --layer workflow
      // never creates `.rig/`, and `--preset sdd` must not either.
      await expect(
        readFile(path.join(repoB, '.rig', 'integrations.json'), 'utf8'),
      ).rejects.toThrow();
    } finally {
      await removeFixture(path.dirname(repoB));
    }
  });

  it('tells the operator to run setup add spec-kit as the next step', async () => {
    const result = await runInit(['--preset', 'sdd']);
    expect(result.code, result.stderr).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('setup add spec-kit');
  });
});
