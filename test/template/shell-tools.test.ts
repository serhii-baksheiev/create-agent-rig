import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

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

/*
 * ── The wiring above is not the enforcement ─────────────────────────────────
 *
 * Everything before this line reads JSON. It proves the harness LAUNCHES the two
 * guards for every tool the module names; it spawns neither guard and sends
 * neither a payload, so a guard that is launched and then returns "allow" for a
 * tool it does not recognise passes all of it. That is the shape RP-65 shipped:
 * the matcher was widened and both hooks kept an opening line that excludes any
 * `tool_name` other than `Bash`, where the exclusion resolves to exit 0 = allow.
 *
 * The tests below therefore run the real hooks, once per tool name in
 * SHELL_TOOLS, and assert the verdict rather than the wiring. The hooks under
 * test are the authored copies in `templates/agent-os/universal/` — the same
 * files `test/template/guard-bash.test.ts` invokes; `test/template/dogfood.test.ts`
 * is what pins this repository's installed `.claude/hooks/` copies to them.
 *
 * Payload shape: `tool_input.command`, the field both guards read today. A
 * surface that names its command field differently is the fix's problem, not a
 * reason for these tests to send something the guards were never given.
 */

const universalHook = (name: string) =>
  path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'hooks', name);

const GUARD_BASH = universalHook('guard-bash.mjs');
const BLOCK_NO_VERIFY = universalHook('block-no-verify.mjs');

/** Every shell tool the one module names — the matrix widens when that list does. */
const SHELL_TOOL_NAMES = await shellTools();

let absentFlag: string;
let armedFlag: string;

beforeAll(async () => {
  // The brake is machine-level, but `.claude/scripts/stop-flag.mjs` lets an extra
  // path ADD one (never remove one), so a test arms it without going near the
  // operator's real `~/.claude/create-agent-rig-loop-STOP`.
  const dir = await mkdtemp(path.join(tmpdir(), 'shell-tools-killswitch-'));
  absentFlag = path.join(dir, 'not-here');
  armedFlag = path.join(dir, 'STOP');
  await writeFile(armedFlag, '');
});

function runHook(
  hookPath: string,
  toolName: string,
  command: string,
  flag?: string,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookPath],
      { env: { ...process.env, AGENT_LOOP_STOP: flag ?? absentFlag } },
      (error, _stdout, stderr) => {
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr });
      },
    );
    if (!child.stdin) return reject(new Error('no stdin'));
    child.stdin.write(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: { command },
      }),
    );
    child.stdin.end();
  });
}

const denies = async (hookPath: string, tool: string, command: string, flag?: string) => {
  const result = await runHook(hookPath, tool, command, flag);
  expect(result.code, `${path.basename(hookPath)} should DENY through ${tool}: ${command}`).toBe(2);
  expect(result.stderr, `a refusal through ${tool} must say why`).not.toBe('');
};

const allows = async (hookPath: string, tool: string, command: string, flag?: string) => {
  const result = await runHook(hookPath, tool, command, flag);
  expect(
    result.code,
    `${path.basename(hookPath)} should ALLOW through ${tool}: ${command}\nstderr: ${result.stderr}`,
  ).toBe(0);
};

describe('guard-bash reaches its verdict on every shell tool, not just the one it was written for', () => {
  it.each(SHELL_TOOL_NAMES)('refuses a force-push of a shared branch through %s', async (tool) => {
    await denies(GUARD_BASH, tool, 'git push --force origin master');
  });

  it.each(SHELL_TOOL_NAMES)('refuses a filesystem wipe through %s', async (tool) => {
    await denies(GUARD_BASH, tool, 'rm -rf /');
  });

  it.each(SHELL_TOOL_NAMES)(
    'refuses a merge while the kill switch is armed through %s',
    async (tool) => {
      await denies(GUARD_BASH, tool, 'gh pr merge 12 --squash', armedFlag);
    },
  );

  // The positive control: without it, a guard that denied everything would pass
  // every row above, and a guard nobody can work under is a guard that gets
  // unwired.
  it.each(SHELL_TOOL_NAMES)('still allows a harmless command through %s', async (tool) => {
    await allows(GUARD_BASH, tool, 'git status');
  });
});

describe('block-no-verify reaches its verdict on every shell tool', () => {
  it.each(SHELL_TOOL_NAMES)('refuses a pre-commit bypass through %s', async (tool) => {
    await denies(BLOCK_NO_VERIFY, tool, 'git commit --no-verify -m x');
  });

  it.each(SHELL_TOOL_NAMES)('still allows a harmless command through %s', async (tool) => {
    await allows(BLOCK_NO_VERIFY, tool, 'git status');
  });
});
