import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * RP-65: `.claude/settings.json` wired `block-no-verify` and `guard-bash` under
 * the matcher `Bash` alone, so a command issued through the harness's OTHER
 * shell-executing tool traversed neither. The Never tier and the kill switch
 * were, on that surface, prose.
 *
 * Measured on the live harness before the fix: `git commit --no-verify
 * --dry-run` was BLOCKED through the `Bash` tool and RAN through the
 * `PowerShell` tool, in the same session, in the same checkout.
 *
 * The fix widens the matcher from one enumerated tool to the enumerated SET,
 * `.claude/scripts/lib/shell-tools.mjs`. It is an explicit list rather than a
 * wildcard on purpose — an open-ended matcher would hand these guards tools that
 * execute nothing, and a guard that fires on a non-shell tool is one someone
 * turns off.
 *
 * 🔴 **What this cannot claim.** Widening the matcher makes the same RULES run
 * on both surfaces; it does not make the parsing identical. `guard-bash`
 * tokenises POSIX shell, and PowerShell's quoting, escaping and separators are
 * its own — so a command whose danger is only visible after PowerShell-specific
 * parsing may read differently there. The coarse checks (the kill switch, which
 * refuses on the presence of the operation at all) do not depend on that. This
 * is stated in the guard's own limits block rather than left for a reader to
 * discover, and it is the reason the file was NOT renamed: the name would
 * promise a parity the parser does not have.
 */
const SETTINGS = ['.claude/settings.json', 'templates/agent-os/universal/.claude/settings.json'];

const readSettings = async (rel: string) =>
  JSON.parse(await readFile(path.join(repoRoot, rel), 'utf8')) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
  };

const shellTools = async (): Promise<string[]> => {
  const mod = (await import(
    path.join(repoRoot, '.claude', 'scripts', 'lib', 'shell-tools.mjs').replace(/\\/g, '/')
  )) as { SHELL_TOOLS: string[] };
  return mod.SHELL_TOOLS;
};

describe('every shell-executing tool traverses the same Never-tier guards', () => {
  it('names the supported shell tools in one place, and that place is not empty', async () => {
    const tools = await shellTools();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
    expect(new Set(tools).size, 'a duplicate would silently widen the matcher').toBe(tools.length);
    // Bash is the surface the guards were written for; losing it is a regression
    expect(tools).toContain('Bash');
    // and the one the measurement above found unguarded
    expect(tools).toContain('PowerShell');
  });

  it.each(SETTINGS)('%s wires both shell guards for EVERY named tool', async (rel) => {
    const tools = await shellTools();
    const settings = await readSettings(rel);
    const groups = settings.hooks.PreToolUse ?? [];

    for (const tool of tools) {
      const covering = groups.filter((group) => (group.matcher ?? '').split('|').includes(tool));
      const commands = covering.flatMap((group) => group.hooks.map((h) => h.command));
      for (const guard of ['block-no-verify.mjs', 'guard-bash.mjs']) {
        expect(
          commands.some((command) => command.includes(guard)),
          `${tool} is not covered by ${guard} in ${rel}`,
        ).toBe(true);
      }
    }
  });

  it.each(SETTINGS)('%s gives those guards no tool the module does not name', async (rel) => {
    const tools = await shellTools();
    const settings = await readSettings(rel);
    for (const group of settings.hooks.PreToolUse ?? []) {
      const guardsShell = group.hooks.some(
        (h) => h.command.includes('guard-bash.mjs') || h.command.includes('block-no-verify.mjs'),
      );
      if (!guardsShell) continue;
      for (const tool of (group.matcher ?? '').split('|').filter(Boolean)) {
        expect(tools, `${rel} hands the shell guards a tool the module does not name`).toContain(
          tool,
        );
      }
    }
  });

  it.each(SETTINGS)('%s leaves the edit-tool guards on their own matcher', async (rel) => {
    const settings = await readSettings(rel);
    const editGroup = (settings.hooks.PreToolUse ?? []).find((group) =>
      group.hooks.some((h) => h.command.includes('guard-core-purity.mjs')),
    );
    expect(editGroup?.matcher).toBe('Write|Edit|MultiEdit|NotebookEdit|apply_patch');
  });

  it('is non-vacuous: the coverage check fails when a named tool is missing from a matcher', async () => {
    const tools = ['Bash', 'PowerShell', 'AbsentShell'];
    const groups = [
      { matcher: 'Bash|PowerShell', hooks: [{ command: 'node .claude/hooks/guard-bash.mjs' }] },
    ];
    const uncovered = tools.filter(
      (tool) => !groups.some((group) => group.matcher.split('|').includes(tool)),
    );
    expect(uncovered).toEqual(['AbsentShell']);
  });
});
