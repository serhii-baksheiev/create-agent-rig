import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { GIT_LOCATION_VARS as varsInTheCli } from '../../packages/cli/src/lib/git-env.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const execFileAsync = promisify(execFile);
const PREPARE_TEST_TIMEOUT_MS = 15_000;

// The modules under test are plain .mjs — one ships to generated projects, the
// other runs before the TypeScript build exists — so they are loaded the same
// way the rest of this suite loads scripts: by URL, at run time.
type EnvFn = (env: Record<string, string | undefined>) => Record<string, string | undefined>;
const load = async (rel: string, name: string): Promise<EnvFn> => {
  const module = await import(pathToFileURL(path.join(repoRoot, rel)).href);
  return module[name] as EnvFn;
};
const gitConfigEnv = await load('scripts/prepare.mjs', 'gitConfigEnv');
const { GIT_LOCATION_VARS: varsInTheTemplate } = (await import(
  pathToFileURL(path.join(repoRoot, 'templates/agent-os/universal/.claude/scripts/git-env.mjs'))
    .href
)) as { GIT_LOCATION_VARS: readonly string[] };
const withoutGitLocation = await load(
  'templates/agent-os/universal/.claude/scripts/preflight.mjs',
  'withoutGitLocation',
);

const runPrepare = async (ci: string | undefined): Promise<string[]> => {
  // Exercise the real entrypoint from an isolated checkout-shaped fixture.
  // Keeping the fixture below this repository lets Node resolve the root's
  // TypeScript without copying or installing dependencies during the test.
  const fixture = await mkdtemp(path.join(repoRoot, '.prepare-test-'));
  try {
    const scripts = path.join(fixture, 'scripts');
    const cli = path.join(fixture, 'packages', 'cli');
    const bin = path.join(fixture, 'bin');
    const calls = path.join(fixture, 'git-calls.jsonl');
    await Promise.all([
      mkdir(path.join(fixture, '.git')),
      mkdir(scripts),
      mkdir(cli, { recursive: true }),
      mkdir(bin),
    ]);
    await writeFile(
      path.join(cli, 'tsconfig.build.json'),
      JSON.stringify({ compilerOptions: { noEmit: true }, files: ['input.ts'] }),
    );
    await writeFile(path.join(cli, 'input.ts'), 'export {};\n');
    await writeFile(
      path.join(bin, 'git-script.mjs'),
      "import { appendFileSync } from 'node:fs';\n" +
        "appendFileSync(process.env.GIT_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');\n",
    );
    await writeFile(path.join(bin, 'git'), "#!/usr/bin/env node\nimport './git-script.mjs';\n");
    await chmod(path.join(bin, 'git'), 0o755);
    await writeFile(path.join(bin, 'git.cmd'), '@node "%~dp0\\git-script.mjs" %*\r\n');
    await writeFile(
      path.join(scripts, 'prepare.mjs'),
      await readFile(path.join(repoRoot, 'scripts', 'prepare.mjs'), 'utf8'),
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      GIT_CALLS: calls,
    };
    if (ci === undefined) delete env.CI;
    else env.CI = ci;
    await execFileAsync(process.execPath, [path.join(scripts, 'prepare.mjs')], { env });

    try {
      return (await readFile(calls, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[])
        .flat();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw error;
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
};

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

  it(
    'does not configure checkout hooks when CI is set',
    { timeout: PREPARE_TEST_TIMEOUT_MS },
    async () => {
      expect(await runPrepare('true')).toEqual([]);
    },
  );

  it(
    'still configures checkout hooks outside CI',
    { timeout: PREPARE_TEST_TIMEOUT_MS },
    async () => {
      expect(await runPrepare(undefined)).toEqual(['config', 'core.hooksPath', '.husky']);
    },
  );
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

  // Why the list is named rather than a `GIT_*` prefix sweep, stated as a test
  // because the prefix sweep is the obvious "simplification" and it is wrong:
  // `GIT_CONFIG_*` CONFIGURES git, it does not locate a repository. Containers
  // and CI inject `safe.directory` through exactly these, and a child that loses
  // them gets `fatal: detected dubious ownership` — a failure a caller that
  // falls back on error then hides.
  it('keeps the variables that configure git rather than locate it', () => {
    const sanitised = withoutGitLocation({
      GIT_CONFIG_GLOBAL: '/etc/gitconfig',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '/work',
      GIT_DIR: '/elsewhere/.git',
    });
    expect(sanitised['GIT_CONFIG_GLOBAL']).toBe('/etc/gitconfig');
    expect(sanitised['GIT_CONFIG_COUNT']).toBe('1');
    expect(sanitised['GIT_CONFIG_KEY_0']).toBe('safe.directory');
    expect(sanitised['GIT_CONFIG_VALUE_0']).toBe('/work');
    expect(sanitised['GIT_DIR']).toBeUndefined();
  });
});

// `invariants.md`: "One mechanism, one implementation. If two files enforce the
// same invariant, they will disagree — and the one nobody is looking at is the
// one that is wrong." TWO files state the list today, and the duplication is
// forced: `.claude/scripts/git-env.mjs` for anything that ships into a generated
// project, and `packages/cli/src/lib/git-env.ts` for the generator itself, which
// runs as compiled TypeScript and cannot import the template. Everything else
// imports one of those two — `preflight.mjs` re-exports the function,
// `checkout.mjs` and `gate-stop-dod.mjs` import it. The describes below pin
// each of those, and the equality test pins the one drift the layering forces.
describe('checkout.mjs sanitises through the shared list, not a second one', () => {
  const checkoutSource = () =>
    readFile(
      path.join(repoRoot, 'templates/agent-os/universal/.claude/scripts/queue/checkout.mjs'),
      'utf8',
    );

  it('imports the exported sanitiser', async () => {
    // From `git-env.mjs`, the small shared module — NOT from `preflight.mjs`,
    // which merely re-exports it. The distinction is mechanical, not stylistic:
    // `checkout.mjs` sits on the queue's READ path, and every fixture that
    // exercises the CLI copies `.claude/scripts/queue/` alone. Importing a CLI
    // script from here made four of them die on ERR_MODULE_NOT_FOUND, which is
    // how the module got extracted in the first place.
    expect(await checkoutSource()).toMatch(
      /import\s*\{[^}]*withoutGitLocation[^}]*\}\s*from\s*['"][^'"]*git-env\.mjs['"]/,
    );
  });

  it('carries no GIT_ prefix sweep of its own', async () => {
    expect(await checkoutSource()).not.toMatch(/startsWith\(\s*['"]GIT_['"]\s*\)/);
  });
});

// The duplication is legitimate and it stays: the template module must stand
// alone inside a generated project, the CLI module ships as compiled
// TypeScript, and neither can import the other. What does NOT follow is that
// the two may drift. `invariants.md`: "If two files enforce the same
// invariant, they will disagree — and the one nobody is looking at is the one
// that is wrong." Nothing fails today when a ninth variable is added to one of
// them; this is the thing that fails.
describe('the two copies of the location list are one list', () => {
  it('the template module and the CLI module name exactly the same variables', () => {
    expect([...varsInTheTemplate].sort()).toEqual([...varsInTheCli].sort());
  });
});

// The copy nobody named, now removed. `gate-stop-dod.mjs` USED TO carry four of
// the eight inline, justified by "this file ships into generated projects, so it
// cannot import the canonical list from the generator" — a reason that expired
// the day `layers.json` started shipping `.claude/scripts/git-env.mjs` into
// generated projects too. Both files are in the SAME layer, one directory apart.
//
// The shorter list is not a smaller opinion either: `GIT_OBJECT_DIRECTORY` is
// on the canonical list, is missing from these four, and makes `git status`
// exit 128 — which this gate catches and reads as "not a git repo, run the
// checks anyway".
describe('the stop gate sanitises through the shared list, not a fourth copy', () => {
  const hookSource = () =>
    readFile(
      path.join(repoRoot, 'templates/agent-os/universal/.claude/hooks/gate-stop-dod.mjs'),
      'utf8',
    );

  it('imports the exported sanitiser', async () => {
    expect(await hookSource()).toMatch(
      /import\s*\{[^}]*withoutGitLocation[^}]*\}\s*from\s*['"][^'"]*git-env\.mjs['"]/,
    );
  });

  it('carries no list of git variables of its own', async () => {
    // an array literal whose first member is a quoted GIT_ name — the shape a
    // second copy takes. Prose that mentions GIT_DIR is left alone on purpose.
    expect(await hookSource()).not.toMatch(/\[\s*['"]GIT_[A-Z_]+['"]/);
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
    'templates/agent-os/universal/.claude/scripts/decision-router.mjs',
    'templates/agent-os/universal/.claude/hooks/gate-stop-dod.mjs',
    'templates/agent-os/universal/.claude/scripts/queue/checkout.mjs',
    'test/template/hooks.test.ts',
    'test/template/queue.test.ts',
    // Added the day these spawns were written, which is what this file's own
    // header asks for. Both were invisible to the matcher before: the hook kept
    // its `env` 573 characters past the call, behind a comment, and the test
    // passed a named options object carrying no `env` token at all. A sweep that
    // cannot see a call site is a sweep that reports it clean.
    'test/template/codex.test.ts',
    'templates/agent-os/universal/.claude/hooks/lib/edit-input.mjs',
    '.claude/hooks/lib/edit-input.mjs',
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

  // 🔴 The sweep above reads the SOURCE files listed there, and a rule layer's commands do
  // not all live in source. The `recordCompletedTier` snippet in the loop skill
  // is executed verbatim by every session that closes an item — from a shell
  // whose `GIT_DIR` is whatever fired it — and it shipped, in the very branch
  // that wrote this rule, spawning git with no `env`. A documented command is a
  // call site, and nothing was watching this kind.
  //
  // Deliberately general rather than one string match, so the next snippet is
  // covered too: every fenced block in the shipped markdown, both spawn forms.
  //
  // ⚠ Scope, stated because it is a real limit and not an oversight: shell
  // `git …` LINES in bash blocks are not checked. A bash snippet runs in the
  // session's own shell and its environment is not ours to rewrite. Only
  // programmatic spawns — where the snippet chooses the child's environment —
  // are in scope. That boundary is also what keeps false positives at zero
  // across all 21 documents here.
  it('every fenced snippet that spawns git names its environment', async () => {
    const docs = path.join(repoRoot, 'templates', 'agent-os');
    const entries = await readdir(docs, { recursive: true, withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => path.join(entry.parentPath, entry.name));
    expect(files.length, 'the sweep must have documents to read').toBeGreaterThan(5);

    const offences: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const blocks = [...source.matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gm)].map(
        (fence) => fence[1] ?? '',
      );
      for (const block of blocks) {
        // Both forms: argv (`exec…('git', [...])`) and the command string
        // (`execSync('git diff …')`). The source sweep needs a second pass for
        // the string form; here one alternation covers it, and missing it would
        // have left the commonest shape in a document invisible.
        const calls = block.matchAll(
          /(?:execFileSync|execFile|spawnSync|spawn|execSync|exec)\(\s*["']git(?:["']|\s)/g,
        );
        for (const call of calls) {
          const window = block.slice(call.index ?? 0, (call.index ?? 0) + 400).split('\n\n')[0]!;
          if (!/env[:\s]/.test(window)) {
            offences.push(`${path.relative(repoRoot, file)}: ${window.split('\n')[0]!.trim()}`);
          }
        }
      }
    }
    expect(offences, 'a documented command spawns git with the inherited environment').toEqual([]);
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
