import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject } from '../src/commands/init.js';
import { inspectGuards } from '../src/integrations/doctor-guards.js';
import { agentOsUniversalDir } from '../src/templates.js';
import type { ProviderProcessOptions, ProviderProcessResult } from '../src/integrations/spawn.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-doctor-guards-'));
  await initProject(repo, {});
});

afterEach(async () => {
  await removeFixture(repo);
});

const claudeSettings = () => path.join(repo, '.claude', 'settings.json');
const codexHooks = () => path.join(repo, '.codex', 'hooks.json');
const blockNoVerify = () => path.join(repo, '.claude', 'hooks', 'block-no-verify.mjs');

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// Independent oracle for RP-238: reads and parses the candidate flag files
// itself rather than importing unattended-flag.mjs/stop-flag.mjs to ask them
// whether a fixture flag is armed, AND identifies this call's own fixture
// without asking production's own cleanup whether it ran. The fixture run
// root is `mkdtemp(path.join(os.tmpdir(), 'rig-guard-fixtures-'))`, made
// either inside the spawned child (whose env allow-list in spawn.ts forwards
// TEMP/TMP but never TMPDIR) or by `inspectGuards` itself in this process. So
// overriding TMPDIR, TEMP and TMP for the duration of one `inspectGuards` call
// pins `os.tmpdir()` on both sides to a directory this test alone created and
// named — no other call, in this run or a sibling test file, can ever produce
// a runDir under it. A flag whose `runDir`
// starts with that exact directory is therefore this call's fixture, full
// stop: no runDir-existence heuristic, no dependence on a "before" snapshot,
// no dependence on sibling timing.
async function fixtureFlagsUnderRoot(rootPrefix: string): Promise<string[]> {
  const dir = path.join(userInfo().homedir, '.claude');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const name of entries) {
    if (!name.endsWith('-loop-UNATTENDED')) continue;
    const full = path.join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(full, 'utf8'));
    } catch {
      continue;
    }
    const record = parsed as { item?: unknown; runDir?: unknown } | null;
    if (
      record !== null &&
      typeof record === 'object' &&
      record.item === 'fixture' &&
      typeof record.runDir === 'string' &&
      record.runDir.startsWith(rootPrefix)
    ) {
      matches.push(full);
    }
  }
  return matches;
}

// Independent oracle for RP-310: a tiny exact-match scan, distinct from
// fixtureFlagsUnderRoot's prefix match above. Here the simulated child writes
// `runDir` as exactly this test's own fixture root (never a path nested under
// it), so the right comparison is equality, not a prefix — and this reads the
// flag files on disk itself rather than asking unattended-flag.mjs's own
// readUnattended/clearUnattended whether anything is armed.
async function fixtureFlagsForExactRoot(root: string): Promise<string[]> {
  const dir = path.join(userInfo().homedir, '.claude');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const name of entries) {
    if (!name.endsWith('-loop-UNATTENDED')) continue;
    const full = path.join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(full, 'utf8'));
    } catch {
      continue;
    }
    const record = parsed as { item?: unknown; runDir?: unknown } | null;
    if (
      record !== null &&
      typeof record === 'object' &&
      record.item === 'fixture' &&
      record.runDir === root
    ) {
      matches.push(full);
    }
  }
  return matches;
}

function batchResult(
  status: ProviderProcessResult['status'],
  exitCode: number | null,
): ProviderProcessResult {
  return { status, exitCode, stdout: 'private batch stdout', stderr: 'private batch stderr' };
}

describe('doctor guard inspection', () => {
  it('rejects guards moved out of their event even when command strings remain in the file', async () => {
    const settings = JSON.parse(await readFile(claudeSettings(), 'utf8'));
    settings.unused = settings.hooks.PreToolUse;
    settings.hooks.PreToolUse = [];
    await writeFile(claudeSettings(), JSON.stringify(settings));
    const result = await inspectGuards({ repoDir: repo, runner: async () => batchResult('ok', 0) });
    expect(result).toEqual({ status: 'fail', reason: 'hook-wiring-invalid' });
  });

  it('preserves additional foreign hook entries without executing them', async () => {
    const settings = JSON.parse(await readFile(claudeSettings(), 'utf8'));
    settings.hooks.PreToolUse.push({
      matcher: 'Foreign',
      hooks: [{ type: 'command', command: 'foreign-never-run' }],
    });
    const bytes = JSON.stringify(settings);
    await writeFile(claudeSettings(), bytes);
    expect(
      await inspectGuards({ repoDir: repo, runner: async () => batchResult('ok', 0) }),
    ).toEqual({ status: 'pass', reason: 'guards-verified' });
    expect(await readFile(claudeSettings(), 'utf8')).toBe(bytes);
  });
  it('passes a clean initialized rig only after running the package-owned allowed and denied guard fixtures', async () => {
    const claudeBefore = await readFile(claudeSettings(), 'utf8');
    const codexBefore = await readFile(codexHooks(), 'utf8');

    const result = await inspectGuards({ repoDir: repo });

    expect(result).toEqual({ status: 'pass', reason: 'guards-verified' });
    expect(await readFile(claudeSettings(), 'utf8')).toBe(claudeBefore);
    expect(await readFile(codexHooks(), 'utf8')).toBe(codexBefore);
  });

  it("never leaves a fixture unattended flag behind in the invoking user's real home (RP-238)", async () => {
    // Force this call's fixture root under a directory only this test
    // created — see fixtureFlagsUnderRoot's comment for why that removes the
    // dependency on production's own cleanup.
    const uniqueRoot = await mkdtemp(path.join(tmpdir(), 'rig-238-oracle-'));
    const rootPrefix = uniqueRoot + path.sep;
    const savedTmpdir = process.env.TMPDIR;
    const savedTemp = process.env.TEMP;
    const savedTmp = process.env.TMP;
    process.env.TMPDIR = uniqueRoot;
    process.env.TEMP = uniqueRoot;
    process.env.TMP = uniqueRoot;

    // Sanity: the directory is fresh, so nothing should match yet.
    expect(await fixtureFlagsUnderRoot(rootPrefix)).toEqual([]);

    // While the call is in flight, poll for the child's own mkdtemp'd run
    // root appearing under our override — confirming the redirection actually
    // took effect, so the absence check below is not vacuously true because
    // the child used some other, unwatched directory instead.
    let sawFixtureRunDir = false;
    const poll = setInterval(() => {
      try {
        if (readdirSync(uniqueRoot).some((name) => name.startsWith('rig-guard-fixtures-'))) {
          sawFixtureRunDir = true;
        }
      } catch {
        // uniqueRoot briefly unreadable mid mkdtemp/rmSync race; next tick retries.
      }
    }, 5);

    let result: Awaited<ReturnType<typeof inspectGuards>>;
    try {
      result = await inspectGuards({ repoDir: repo });
    } finally {
      clearInterval(poll);
      if (savedTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmpdir;
      if (savedTemp === undefined) delete process.env.TEMP;
      else process.env.TEMP = savedTemp;
      if (savedTmp === undefined) delete process.env.TMP;
      else process.env.TMP = savedTmp;
    }

    // The fixtures still have to run — a fix that just skips arming the flag
    // instead of scoping it to the fixture's own fake HOME must not pass this
    // test either.
    expect(result).toEqual({ status: 'pass', reason: 'guards-verified' });
    expect(sawFixtureRunDir).toBe(true);

    // Anything matching this prefix now is this call's fixture flag, and its
    // mere presence — regardless of whether its runDir still exists on disk —
    // is the leak.
    const leaked = await fixtureFlagsUnderRoot(rootPrefix);

    // Best-effort cleanup of only what this run itself created under its own
    // unique root — never a file this test did not name.
    await Promise.all(leaked.map((file) => rm(file, { force: true })));
    await removeFixture(uniqueRoot);

    expect(leaked).toEqual([]);
  });

  it('clears the fixture unattended flag from the real home when the guard batch is killed before its own cleanup (RP-310)', async () => {
    // `root` is populated by the injected runner below — it stands in for the
    // FIXTURE_WRAPPER child up to the exact moment it is killed, before its
    // own `finally` (clearUnattended + rmSync) ever runs.
    let root: string | undefined;

    const runner = async (options: ProviderProcessOptions): Promise<ProviderProcessResult> => {
      // RP-310's intended fix has the parent pass the fixture root as the
      // 4th arg; today's parent passes none, so this falls back to mkdtemp'ing
      // its own root exactly as the current child does.
      const passedRoot = options.args[3];
      root =
        typeof passedRoot === 'string'
          ? passedRoot
          : await mkdtemp(path.join(tmpdir(), 'rig-guard-fixtures-'));
      const home = path.join(root, 'home');
      const env = { ...process.env, HOME: home, APPDATA: home, CLAUDE_PROJECT_DIR: root };
      const unattendedModulePath = path.join(
        agentOsUniversalDir(),
        '.claude',
        'scripts',
        'unattended-flag.mjs',
      );
      const flag = (await import(pathToFileURL(unattendedModulePath).href)) as {
        writeUnattended: (
          record: { item: string; runDir: string | null; allow: string[] },
          flagEnv: NodeJS.ProcessEnv,
        ) => string[];
      };
      flag.writeUnattended({ item: 'fixture', runDir: root, allow: [] }, env);
      // Killed before reaching its own finally: no clearUnattended, no rmSync.
      return batchResult('timeout', null);
    };

    try {
      const result = await inspectGuards({ repoDir: repo, runner });

      expect(result).toEqual({ status: 'fail', reason: 'guard-fixture-batch-failed' });
      if (root === undefined) throw new Error('the runner never ran — nothing to assert');

      const leaked = await fixtureFlagsForExactRoot(root);
      expect(leaked).toEqual([]);
      expect(await exists(root)).toBe(false);
    } finally {
      // Never leave litter in the real home even on a RED run.
      if (root !== undefined) {
        const leaked = await fixtureFlagsForExactRoot(root);
        await Promise.all(leaked.map((file) => rm(file, { force: true })));
        await removeFixture(root);
      }
    }
  });

  it.each([
    ['an absent Claude block-no-verify hook', 'claude', 'foreign-block-no-verify.mjs'],
    ['malformed Codex hook wiring', 'codex', '{ malformed hooks'],
  ] as const)(
    'fails %s while preserving the foreign wiring bytes',
    async (_case, target, replacement) => {
      const file = target === 'claude' ? claudeSettings() : codexHooks();
      const before = await readFile(file, 'utf8');
      const foreign =
        file === claudeSettings()
          ? before.replace('block-no-verify.mjs', replacement)
          : replacement;
      await writeFile(file, foreign);

      const result = await inspectGuards({ repoDir: repo });

      expect(result).toEqual({ status: 'fail', reason: 'hook-wiring-invalid' });
      expect(await readFile(file, 'utf8')).toBe(foreign);
    },
  );

  it('fails a modified installed guard without executing repository code', async () => {
    const marker = path.join(repo, 'repository-code-must-not-run');
    await writeFile(
      blockNoVerify(),
      `import { writeFile } from 'node:fs/promises';\nawait writeFile(${JSON.stringify(marker)}, 'ran');\n`,
    );

    const result = await inspectGuards({ repoDir: repo });

    expect(result).toEqual({ status: 'fail', reason: 'hook-integrity-invalid' });
    expect(await exists(marker)).toBe(false);
  });

  it('fails when the compiled fixture batch reports a denied guard with the wrong exit', async () => {
    const result = await inspectGuards({
      repoDir: repo,
      runner: async () => batchResult('failed', 1),
    });

    expect(result).toEqual({ status: 'fail', reason: 'guard-fixture-batch-failed' });
  });
});
