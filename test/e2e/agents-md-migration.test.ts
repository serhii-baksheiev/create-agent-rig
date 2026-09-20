import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installEnv, runNpx } from './run.js';
import { removeFixture } from '../helpers/remove-fixture.js';
import { AGENTS_MD_RESCUE } from '../../packages/cli/src/commands/upgrade.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const currentCliDist = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

// PR #241 round 3, blocker 1 (item 4): the in-memory `pretendInstalled`
// fixture in `packages/cli/test/upgrade.test.ts` proves the verdict
// machinery is correct GIVEN a manifest — it cannot prove the migration is
// reachable from a rig a real, previously-released payload actually
// installed, which is exactly the gap gate cycle 2 found. This file installs
// the LAST commit before RP-186 merged (`fc75fe2`, master tip at the time
// this branch forked) through the same `git+file://…#<ref>` mechanism
// `git-install.test.ts` already uses for the current tip, then runs THIS
// branch's own built CLI (`packages/cli/dist/index.js`, built by `pnpm
// test`'s `pnpm build` step before vitest runs) against it — the real
// `create-agent-rig upgrade` a user would type, not a direct import of
// `planUpgrade`.
let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'caf-agents-md-migration-'));
});

afterEach(async () => {
  await removeFixture(work);
});

/** Installs the pre-RP-186 payload (`fc75fe2`) into `appDir/name`. */
async function installLegacyRig(appDir: string, name: string): Promise<string> {
  await mkdir(appDir, { recursive: true });
  await runNpx(['--yes', `--package=git+file://${repoRoot}#fc75fe2`, 'create-agent-rig', name], {
    cwd: appDir,
    env: installEnv(path.join(appDir, 'npx-cache')),
  });
  return path.join(appDir, name);
}

/** THIS branch's own built CLI, run as `command extraArgs...` in `cwd`. */
async function runCurrentCli(
  cwd: string,
  command: string,
  extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await exec(
      process.execPath,
      [currentCliDist, command, ...extraArgs],
      {
        cwd,
      },
    );
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 };
  }
}

/** The real `create-agent-rig upgrade` from THIS branch's build, in `cwd`. */
const runCurrentUpgrade = (
  cwd: string,
  extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; code: number }> =>
  runCurrentCli(cwd, 'upgrade', extraArgs);

/** The real `create-agent-rig uninstall` from THIS branch's build, in `cwd`. */
const runCurrentUninstall = (
  cwd: string,
  extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; code: number }> =>
  runCurrentCli(cwd, 'uninstall', extraArgs);

describe('the RP-186 migration against a rig built from the actual pre-RP-186 payload', () => {
  it('an untouched legacy rig upgrades cleanly: CLAUDE.md becomes the shim, AGENTS.md becomes canonical', async () => {
    const rig = await installLegacyRig(work, 'legacy-app');

    // Confirms the fixture really is the OLD, pre-RP-186 shape before
    // exercising the migration against it — a fixture that silently
    // installed something else would make every assertion below vacuous.
    const legacyClaudeMd = await readFile(path.join(rig, 'CLAUDE.md'), 'utf8');
    const legacyAgentsMd = await readFile(path.join(rig, 'AGENTS.md'), 'utf8');
    expect(legacyClaudeMd).toBe(legacyAgentsMd);
    expect(legacyClaudeMd.trimStart().startsWith('@AGENTS.md')).toBe(false);

    const result = await runCurrentUpgrade(rig, ['--yes']);
    expect(result.code, result.stderr).toBe(0);

    const claudeMd = await readFile(path.join(rig, 'CLAUDE.md'), 'utf8');
    const agentsMd = await readFile(path.join(rig, 'AGENTS.md'), 'utf8');
    expect(claudeMd.split(/\r?\n/, 1)[0]).toBe('@AGENTS.md');
    expect(agentsMd).toContain('## One operating system, two harnesses');
    expect(agentsMd).toContain('```elevated-paths');
  });

  it('a legacy rig whose AGENTS.md was edited before upgrading: CLAUDE.md is held back, never shimmed over an unreadable rulebook — and the rescue file resolves it end to end', async () => {
    const rig = await installLegacyRig(work, 'legacy-edited-app');

    // Simulates the real-world trigger for the security fix: something
    // other than this upgrade already left AGENTS.md broken.
    await writeFile(path.join(rig, 'AGENTS.md'), '# not the rulebook at all\n');
    const originalClaudeMd = await readFile(path.join(rig, 'CLAUDE.md'), 'utf8');

    const result = await runCurrentUpgrade(rig, ['--yes']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/held back/i);
    expect(result.stdout).toMatch(/AGENTS\.md/);
    // Round 4, blocker 1: the previous remedy printed rendered content to
    // stdout and asked for a verbatim paste — measured not to work. Nothing
    // resembling the rulebook's own text should be in this run's output at
    // all; the remedy is a real file on disk instead.
    expect(result.stdout).not.toContain('## One operating system, two harnesses');
    expect(result.stdout).toContain(AGENTS_MD_RESCUE);

    // The one thing that must never happen: CLAUDE.md is NOT replaced with
    // the shim while AGENTS.md is unreadable, so the rulebook stays exactly
    // where it was — old, but complete and still declaring its
    // `elevated-paths` block.
    const claudeMd = await readFile(path.join(rig, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toBe(originalClaudeMd);
    expect(claudeMd).toContain('```elevated-paths');
    expect(claudeMd.trimStart().startsWith('@AGENTS.md')).toBe(false);

    // AGENTS.md is untouched — a real `upgrade` never overwrites a
    // conflicted file either.
    expect(await readFile(path.join(rig, 'AGENTS.md'), 'utf8')).toBe('# not the rulebook at all\n');

    // The remedy, followed end to end, from the real payload — `mv` (via
    // `fs.rename`, no shell), then run `upgrade` again exactly as the
    // printed instruction says.
    const rescuePath = path.join(rig, AGENTS_MD_RESCUE);
    await expect(readFile(rescuePath, 'utf8')).resolves.toBeTruthy();
    await rename(rescuePath, path.join(rig, 'AGENTS.md'));

    const finish = await runCurrentUpgrade(rig, ['--yes']);
    expect(finish.code, finish.stderr).toBe(0);

    const finalClaudeMd = await readFile(path.join(rig, 'CLAUDE.md'), 'utf8');
    const finalAgentsMd = await readFile(path.join(rig, 'AGENTS.md'), 'utf8');
    expect(finalClaudeMd.split(/\r?\n/, 1)[0]).toBe('@AGENTS.md');
    expect(finalAgentsMd).toContain('## One operating system, two harnesses');
    expect(finalAgentsMd).toContain('```elevated-paths');
    // No leftover — the rescue file did its job.
    await expect(readFile(rescuePath, 'utf8')).rejects.toThrow();
  });

  // PR #241 round 3 blocker/item 5: the migration e2e above only ever
  // upgrades. This is the rest of the lifecycle a real user reaches next —
  // `uninstall` against the pair `upgrade` just wrote — built from the SAME
  // real pre-RP-186 payload as the other two cases, not the in-memory
  // `pretendInstalled` idiom, and it is exactly the gap that hid blocker 1 in
  // round 2 (`pretendInstalled` can make a manifest say things a real
  // `upgrade` never would).
  it('an untouched legacy rig, upgraded then uninstalled: both AGENTS.md and CLAUDE.md — the pair upgrade just wrote — are removed', async () => {
    const rig = await installLegacyRig(work, 'legacy-uninstall-app');

    const upgradeResult = await runCurrentUpgrade(rig, ['--yes']);
    expect(upgradeResult.code, upgradeResult.stderr).toBe(0);
    // Confirms the upgrade really did finish the migration before
    // uninstall is asked to clean up after it.
    const claudeMdAfterUpgrade = await readFile(path.join(rig, 'CLAUDE.md'), 'utf8');
    expect(claudeMdAfterUpgrade.split(/\r?\n/, 1)[0]).toBe('@AGENTS.md');

    const uninstallResult = await runCurrentUninstall(rig, ['--yes']);
    expect(uninstallResult.code, uninstallResult.stderr).toBe(0);

    // Both are rig-owned and unedited since the upgrade that wrote them —
    // the ordinary `remove` path, same as any other untouched process file.
    await expect(readFile(path.join(rig, 'CLAUDE.md'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(rig, 'AGENTS.md'), 'utf8')).rejects.toThrow();
  });
});
