import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject } from '../src/commands/init.js';
import { inspectGuards } from '../src/integrations/doctor-guards.js';
import type { ProviderProcessResult } from '../src/integrations/spawn.js';
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
// without asking production's own cleanup whether it ran. doctor-guards.ts's
// FIXTURE_WRAPPER computes its run root as
// `fs.mkdtempSync(path.join(os.tmpdir(), 'rig-guard-fixtures-'))` *inside the
// spawned child*, and spawn.ts's env allow-list forwards TEMP/TMP to that
// child but never TMPDIR. So overriding TEMP and TMP for the duration of one
// `inspectGuards` call pins the child's `os.tmpdir()` (TMPDIR is stripped
// regardless of the outer process's own environment) to a directory this
// test alone created and named — no other call, in this run or a sibling
// test file, can ever produce a runDir under it. A flag whose `runDir`
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
    const savedTemp = process.env.TEMP;
    const savedTmp = process.env.TMP;
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
