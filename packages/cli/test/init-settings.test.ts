import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { settingsForInstalledHooks } from '../src/lib/init-settings.js';
import { agentOsUniversalDir } from '../src/templates.js';

/**
 * `init` installs the process layer only — four of the six shipped hooks. The
 * wiring it writes must name exactly those four: a `settings.json` pointing at
 * a hook file that was never installed wires an error into every tool call,
 * and one that names none of them wires nothing at all (the finding this
 * function exists to close).
 */
const FULL = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Write|Edit',
        hooks: [
          {
            type: 'command',
            command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-core-purity.mjs"',
          },
          {
            type: 'command',
            command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-web-boundary.mjs"',
          },
        ],
      },
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/block-no-verify.mjs"',
          },
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-bash.mjs"' },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/gate-stop-dod.mjs"',
          },
        ],
      },
    ],
  },
};

const PROCESS_HOOKS = new Set([
  '.claude/hooks/block-no-verify.mjs',
  '.claude/hooks/guard-bash.mjs',
  '.claude/hooks/gate-stop-dod.mjs',
]);

describe('settingsForInstalledHooks', () => {
  it('keeps the entries whose hook file is installed', () => {
    const out = settingsForInstalledHooks(FULL, PROCESS_HOOKS);
    const commands = JSON.stringify(out);
    expect(commands).toContain('block-no-verify.mjs');
    expect(commands).toContain('guard-bash.mjs');
    expect(commands).toContain('gate-stop-dod.mjs');
  });

  it('drops the entries whose hook file is not installed', () => {
    const commands = JSON.stringify(settingsForInstalledHooks(FULL, PROCESS_HOOKS));
    expect(commands).not.toContain('guard-core-purity');
    expect(commands).not.toContain('guard-web-boundary');
  });

  it('drops a matcher group left empty, rather than wiring an empty group', () => {
    const out = settingsForInstalledHooks(FULL, PROCESS_HOOKS) as {
      hooks: { PreToolUse: Array<{ matcher?: string }> };
    };
    expect(out.hooks.PreToolUse.map((g) => g.matcher)).toEqual(['Bash']);
  });

  it('drops an event left empty', () => {
    const out = settingsForInstalledHooks(FULL, new Set(['.claude/hooks/guard-bash.mjs'])) as {
      hooks: Record<string, unknown>;
    };
    expect(Object.keys(out.hooks)).toEqual(['PreToolUse']);
  });

  it('keeps a command that references no hook file at all', () => {
    const other = {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
    };
    expect(settingsForInstalledHooks(other, new Set())).toEqual(other);
  });

  it('never mutates the input', () => {
    const before = JSON.stringify(FULL);
    settingsForInstalledHooks(FULL, PROCESS_HOOKS);
    expect(JSON.stringify(FULL)).toBe(before);
  });

  it('survives a settings shape it does not understand, unchanged', () => {
    expect(settingsForInstalledHooks({ hooks: 'nonsense' }, new Set())).toEqual({
      hooks: 'nonsense',
    });
    expect(settingsForInstalledHooks({}, new Set())).toEqual({});
  });

  // A regression pin for a field nothing here asserted. The shipped Stop entry
  // carries a `timeout` — the second of the two numbers that only work as a
  // pair: it is when the harness KILLS the gate, and a killed Stop hook blocks
  // nothing, so the gate's own budget has to run out first. `init` does not
  // copy that wiring, it derives it, and a derivation that dropped an entry's
  // extra fields would hand every `init` install the harness default while
  // every other assertion in this file stayed green.
  it("keeps the Stop gate's harness timeout when it narrows the shipped wiring", async () => {
    type Wiring = {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: unknown }> }>>;
    };
    const timeoutOf = (wiring: Wiring) =>
      (wiring.hooks.Stop ?? [])
        .flatMap((group) => group.hooks)
        .find((entry) => entry.command.includes('gate-stop-dod.mjs'))?.timeout;

    // read from the file the wiring is derived from, never restated here: the
    // two drifting apart is exactly the failure this pins
    const shipped = JSON.parse(
      await readFile(path.join(agentOsUniversalDir(), '.claude', 'settings.json'), 'utf8'),
    ) as Wiring;
    expect(typeof timeoutOf(shipped), 'the shipped Stop gate must carry a timeout').toBe('number');

    const derived = settingsForInstalledHooks(shipped, PROCESS_HOOKS) as Wiring;
    expect(timeoutOf(derived)).toBe(timeoutOf(shipped));
  });
});
