import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The modules under test are plain .mjs — one ships to generated projects, the
// other runs before the TypeScript build exists — so they are loaded the same
// way the rest of this suite loads scripts: by URL, at run time.
type EnvFn = (env: Record<string, string | undefined>) => Record<string, string | undefined>;
const load = async (rel: string, name: string): Promise<EnvFn> => {
  const module = await import(pathToFileURL(path.join(repoRoot, rel)).href);
  return module[name] as EnvFn;
};
const gitConfigEnv = await load('scripts/prepare.mjs', 'gitConfigEnv');
const withoutGitLocation = await load(
  'templates/agent-os/universal/.claude/scripts/preflight.mjs',
  'withoutGitLocation',
);

// The defect these guard: a process started under a git hook inherits an
// absolute GIT_DIR, and any git command it spawns then acts on ANOTHER
// repository. Observed here as junk commits on two branches and one repository
// flipped to bare.
describe('prepare.mjs — git config must not be written into another repository', () => {
  it('strips what points `git config` at a different config file', () => {
    const sanitised = gitConfigEnv({
      PATH: '/usr/bin',
      GIT_DIR: '/elsewhere/.git',
      GIT_COMMON_DIR: '/elsewhere/.git',
      GIT_CONFIG: '/elsewhere/config',
    });
    expect(sanitised['GIT_DIR']).toBeUndefined();
    expect(sanitised['GIT_COMMON_DIR']).toBeUndefined();
    expect(sanitised['GIT_CONFIG']).toBeUndefined();
    expect(sanitised['PATH']).toBe('/usr/bin');
  });

  it('does not mutate the environment it was handed', () => {
    const original = { GIT_DIR: '/elsewhere/.git' };
    gitConfigEnv(original);
    expect(original.GIT_DIR).toBe('/elsewhere/.git');
  });

  // Importing the module must not build the CLI or touch git config — if the
  // entry-point guard regresses, this suite would run a compile on import.
  it('is importable without side effects', async () => {
    const source = await readFile(path.join(repoRoot, 'scripts', 'prepare.mjs'), 'utf8');
    expect(source).toMatch(/import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
  });
});

describe('preflight.mjs — the probes must answer about the repository they are in', () => {
  it('strips every variable that locates a repository', () => {
    const inherited: Record<string, string> = { PATH: '/usr/bin', GH_TOKEN: 'secret' };
    for (const key of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_COMMON_DIR',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_NAMESPACE',
      'GIT_PREFIX',
    ]) {
      inherited[key] = '/elsewhere';
    }
    const sanitised = withoutGitLocation(inherited);
    for (const key of Object.keys(inherited)) {
      if (key.startsWith('GIT_')) expect(sanitised[key], key).toBeUndefined();
    }
    // gh runs through the same helper and its credentials must survive
    expect(sanitised['GH_TOKEN']).toBe('secret');
    expect(sanitised['PATH']).toBe('/usr/bin');
  });
});

// The sweep that would have caught this in one pass instead of four: a call
// site that forgets the sanitised environment is unprotected, and no amount of
// care in the shared module can detect that.
describe('every authored git spawn passes an explicit environment', () => {
  const files = [
    'packages/cli/src/commands/create.ts',
    'packages/cli/test/create.test.ts',
    'scripts/prepare.mjs',
    'templates/agent-os/universal/.claude/scripts/preflight.mjs',
    'templates/agent-os/universal/.claude/hooks/gate-stop-dod.mjs',
    'test/template/hooks.test.ts',
  ];

  it.each(files)('%s', async (rel) => {
    const source = await readFile(path.join(repoRoot, rel), 'utf8');
    const calls = source.matchAll(/(?:execFileSync|execFile|spawnSync|spawn|exec)\(\s*'git'/g);
    const offences: string[] = [];
    for (const call of calls) {
      // the call's own option object: from the call site to the next blank line
      const from = call.index ?? 0;
      const window = source.slice(from, from + 400).split('\n\n')[0]!;
      if (!/env[:\s]/.test(window)) offences.push(window.split('\n')[0]!.trim());
    }
    expect(offences, `${rel}: git spawned with the inherited environment`).toEqual([]);
  });

  // execSync takes a command string rather than argv, so it needs its own pass.
  it('gate-stop-dod runs `git status` with a sanitised environment', async () => {
    const source = await readFile(
      path.join(repoRoot, 'templates/agent-os/universal/.claude/hooks/gate-stop-dod.mjs'),
      'utf8',
    );
    const call = /execSync\('git status --porcelain',\s*\{[\s\S]{0,200}?\}\)/.exec(source);
    expect(call, 'the clean-tree probe must still be there').toBeTruthy();
    expect(call![0]).toMatch(/env,?/);
  });
});
