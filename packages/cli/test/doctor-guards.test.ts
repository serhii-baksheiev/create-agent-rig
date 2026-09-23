import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
// whether a fixture flag is armed.
const FIXTURE_RUN_DIR_PREFIX = path.join(tmpdir(), 'rig-guard-fixtures-');

async function fixtureFlagsInRealHome(): Promise<Map<string, unknown>> {
  const dir = path.join(userInfo().homedir, '.claude');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return new Map();
  }
  const found = new Map<string, unknown>();
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
      record.runDir.startsWith(FIXTURE_RUN_DIR_PREFIX)
    ) {
      found.set(full, parsed);
    }
  }
  return found;
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
    const before = await fixtureFlagsInRealHome();

    const result = await inspectGuards({ repoDir: repo });

    // The fixtures still have to run — a fix that just skips arming the flag
    // instead of scoping it to the fixture's own fake HOME must not pass this
    // test either.
    expect(result).toEqual({ status: 'pass', reason: 'guards-verified' });

    const after = await fixtureFlagsInRealHome();
    const leaked = [...after.keys()].filter((file) => !before.has(file));

    // Best-effort cleanup of only what this run itself created — never a file
    // that was already present before the call.
    await Promise.all(leaked.map((file) => rm(file, { force: true })));

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
