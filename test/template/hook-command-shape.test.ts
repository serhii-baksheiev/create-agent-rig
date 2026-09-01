import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * RP-80 — one input-shape contract for the Never-tier shell guards.
 *
 * `.claude/rules/invariants.md` ("Refusing to inspect is a third outcome, not a
 * match and not an error") already states the rule: a field that is ABSENT is
 * the fail-open case, because there is nothing to judge; a field that is
 * PRESENT in a shape the guard cannot read is a REFUSAL — it blocks, names the
 * shape it expected, and tells the caller to resend in that shape.
 *
 * Both shell guards did the opposite. Measured on `master` at `254b25c8`, with
 * the kill switch armed through the additive `AGENT_LOOP_STOP` path:
 *
 * | payload                                                   | guard-bash | block-no-verify |
 * | --------------------------------------------------------- | ---------- | --------------- |
 * | `command: "gh pr merge 1"`                                | exit 2     | —               |
 * | `command: ["gh","pr","merge","1"]`                        | **exit 0** | —               |
 * | `command: "git commit --no-verify -m x"`                  | —          | exit 2          |
 * | `command: ["git","commit","--no-verify","-m","x"]`        | —          | **exit 0**      |
 *
 * So an armed brake was walked past by spelling the same command as an argv
 * array, on BOTH shell surfaces. `block-no-verify` has the hole by a different
 * road: `String(argv)` comma-joins, and its tokeniser never splits on a comma,
 * so the flag it exists to refuse becomes invisible rather than unreadable.
 *
 * The owner ruling of 2026-09-01 accepted the rulebook's side, so the contract
 * below is what both guards must satisfy — and `guard-bash.test.ts` ›
 * "refuses a command present in a shape it cannot read" is the test that moved.
 *
 * 🔴 The trust boundary is accidental discipline violations plus malformed or
 * untrusted hook input. Neither guard claims to stop an adversary who can edit
 * this repository.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const universalHook = (name: string) =>
  path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'hooks', name);

/** Both Never-tier shell guards, by the name a failure message should carry. */
const GUARDS: Array<[string, string]> = [
  ['guard-bash', universalHook('guard-bash.mjs')],
  ['block-no-verify', universalHook('block-no-verify.mjs')],
];

/**
 * The list, read from the SAME tree the guards under test come from. Reading it
 * from the dogfooded `.claude/` copy while spawning the authored ones would make
 * this file's matrix depend on two trees agreeing — which `dogfood.test.ts` does
 * pin, but that is its job, not this one's.
 */
const shellTools = async (): Promise<string[]> => {
  const mod = (await import(
    path
      .join(
        repoRoot,
        'templates',
        'agent-os',
        'universal',
        '.claude',
        'scripts',
        'lib',
        'shell-tools.mjs',
      )
      .replace(/\\/g, '/')
  )) as { SHELL_TOOLS: string[] };
  return mod.SHELL_TOOLS;
};

/** Every shell surface the one module names — the matrix widens when that list does. */
const SHELL_TOOL_NAMES = await shellTools();

let absentFlag: string;
let armedFlag: string;

beforeAll(async () => {
  // The brake is machine-level; `stop-flag.mjs` lets an extra path ADD one
  // (never remove one), so this arms it without going near the operator's real
  // `~/.claude/create-agent-rig-loop-STOP`.
  const dir = await mkdtemp(path.join(tmpdir(), 'hook-command-shape-'));
  absentFlag = path.join(dir, 'not-here');
  armedFlag = path.join(dir, 'STOP');
  await writeFile(armedFlag, '');
});

/** Spawn a guard with a WHOLE payload, so a test can send a shape `{command}` cannot express. */
function runHookWith(
  hookPath: string,
  payload: unknown,
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
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

const payloadFor = (toolName: string, toolInput: unknown) => ({
  hook_event_name: 'PreToolUse',
  tool_name: toolName,
  tool_input: toolInput,
});

/**
 * The shapes a `command` can arrive in that no guard here can read. Kept to
 * literal values a harness could plausibly send — an argv array is the one that
 * was measured walking past an armed brake.
 */
const UNREADABLE_COMMANDS: Array<[string, unknown]> = [
  ['an argv array', ['gh', 'pr', 'merge', '1']],
  ['an argv array spelling a force-push', ['git', 'push', '--force', 'origin', 'master']],
  ['an argv array spelling a pre-commit bypass', ['git', 'commit', '--no-verify', '-m', 'x']],
  ['an object', { exec: 'gh pr merge 1' }],
  ['a number', 12],
  ['a boolean', true],
];

describe('a command present in a shape the guard cannot read is refused, not allowed', () => {
  for (const [guardName, hookPath] of GUARDS) {
    describe(guardName, () => {
      it.each(
        SHELL_TOOL_NAMES.flatMap((tool) =>
          UNREADABLE_COMMANDS.map(([label, value]) => [tool, label, value] as const),
        ),
      )('refuses %s command that is %s', async (tool, _label, value) => {
        const result = await runHookWith(hookPath, payloadFor(tool, { command: value }));
        expect(result.code).toBe(2);
      });

      it.each(SHELL_TOOL_NAMES)(
        'refuses a tool_input that is present and not an object through %s',
        async (tool) => {
          const result = await runHookWith(hookPath, payloadFor(tool, 'gh pr merge 1'));
          expect(result.code).toBe(2);
        },
      );

      /**
       * The whole point of the ticket: the refusal has to happen BEFORE the
       * brake would be consulted, or arming the brake buys nothing against a
       * caller who sends argv.
       */
      it.each(SHELL_TOOL_NAMES)(
        'refuses an unreadable command through %s while the kill switch is armed',
        async (tool) => {
          const result = await runHookWith(
            hookPath,
            payloadFor(tool, { command: ['gh', 'pr', 'merge', '1'] }),
            armedFlag,
          );
          expect(result.code).toBe(2);
        },
      );
    });
  }
});

describe('the refusal names the shape it expected and a remedy the caller can act on', () => {
  it.each(GUARDS)('%s says what it expected', async (_name, hookPath) => {
    const { stderr } = await runHookWith(
      hookPath,
      payloadFor('Bash', { command: ['gh', 'pr', 'merge', '1'] }),
    );
    expect(stderr).toMatch(/string/i);
    expect(stderr).toMatch(/array/i);
  });

  /**
   * `invariants.md` distinguishes the two refusals precisely: a BOUND crossed
   * says "split the change and retry", because a smaller edit really does fit.
   * An unreadable CONTAINER must not, because nothing about splitting changes a
   * shape — a remedy the caller cannot act on turns a refusal into a loop.
   */
  it.each(GUARDS)('%s does not tell the caller to split and retry', async (_name, hookPath) => {
    const { stderr } = await runHookWith(
      hookPath,
      payloadFor('Bash', { command: ['gh', 'pr', 'merge', '1'] }),
    );
    expect(stderr).not.toMatch(/split/i);
    expect(stderr).toMatch(/resend|as a string|single string/i);
  });

  it('both guards refuse in the same words, because the contract is one module', async () => {
    const reasons = await Promise.all(
      GUARDS.map(async ([, hookPath]) => {
        const { stderr } = await runHookWith(
          hookPath,
          payloadFor('Bash', { command: ['gh', 'pr', 'merge', '1'] }),
        );
        return stderr.trim();
      }),
    );
    expect(reasons[0]).toBe(reasons[1]);
  });
});

describe('what stays fail-open, because there is nothing to judge', () => {
  for (const [guardName, hookPath] of GUARDS) {
    describe(guardName, () => {
      it.each(SHELL_TOOL_NAMES)('allows an ABSENT command through %s', async (tool) => {
        const result = await runHookWith(hookPath, payloadFor(tool, {}));
        expect(result.code).toBe(0);
      });

      it.each(SHELL_TOOL_NAMES)('allows an absent tool_input through %s', async (tool) => {
        const result = await runHookWith(hookPath, {
          hook_event_name: 'PreToolUse',
          tool_name: tool,
        });
        expect(result.code).toBe(0);
      });

      it.each(SHELL_TOOL_NAMES)('allows an empty command through %s', async (tool) => {
        const result = await runHookWith(hookPath, payloadFor(tool, { command: '   ' }));
        expect(result.code).toBe(0);
      });

      it('allows a malformed payload it cannot parse at all', async () => {
        const code = await new Promise<number>((resolve, reject) => {
          const child = execFile(process.execPath, [hookPath], (error) =>
            resolve(error ? ((error as { code?: number }).code ?? 1) : 0),
          );
          if (!child.stdin) return reject(new Error('no stdin'));
          child.stdin.write('{not json');
          child.stdin.end();
        });
        expect(code).toBe(0);
      });

      /**
       * A non-shell tool is not this guard's to judge in ANY shape. Refusing
       * here would fire the Never tier on tools that execute nothing, which is
       * how a guard gets unwired.
       */
      it('allows an unreadable command on a tool that is not a shell', async () => {
        const result = await runHookWith(
          hookPath,
          payloadFor('Write', { command: ['gh', 'pr', 'merge', '1'] }),
        );
        expect(result.code).toBe(0);
      });
    });
  }
});

describe('the readable cases are unchanged', () => {
  it.each(SHELL_TOOL_NAMES)(
    'guard-bash still refuses a force-push string through %s',
    async (t) => {
      const result = await runHookWith(
        universalHook('guard-bash.mjs'),
        payloadFor(t, { command: 'git push --force origin master' }),
      );
      expect(result.code).toBe(2);
    },
  );

  it.each(SHELL_TOOL_NAMES)('guard-bash still allows a harmless string through %s', async (t) => {
    const result = await runHookWith(
      universalHook('guard-bash.mjs'),
      payloadFor(t, { command: 'git status' }),
    );
    expect(result.code).toBe(0);
  });

  it.each(SHELL_TOOL_NAMES)(
    'block-no-verify still refuses a bypass string through %s',
    async (t) => {
      const result = await runHookWith(
        universalHook('block-no-verify.mjs'),
        payloadFor(t, { command: 'git commit --no-verify -m x' }),
      );
      expect(result.code).toBe(2);
    },
  );

  it.each(SHELL_TOOL_NAMES)(
    'block-no-verify still allows a harmless string through %s',
    async (t) => {
      const result = await runHookWith(
        universalHook('block-no-verify.mjs'),
        payloadFor(t, { command: 'git status' }),
      );
      expect(result.code).toBe(0);
    },
  );
});
