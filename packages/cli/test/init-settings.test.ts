import { describe, expect, it } from 'vitest';
import { settingsForInstalledHooks } from '../src/lib/init-settings.js';

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
});
