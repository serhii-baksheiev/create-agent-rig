import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
