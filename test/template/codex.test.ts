import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const agentOs = path.join(repoRoot, 'templates', 'agent-os');
const universal = path.join(agentOs, 'universal');
const hooksDir = path.join(universal, '.claude', 'hooks');

const text = (...parts: string[]) => readFile(path.join(...parts), 'utf8');

describe('Codex adapter is generated from the Claude Code Agent OS', () => {
  it('is in sync with its Claude Code sources', async () => {
    await expect(
      exec(process.execPath, [path.join(repoRoot, 'scripts', 'sync-codex-adapter.mjs'), '--check']),
    ).resolves.toBeTruthy();
  });

  it.each(['universal', 'init'])(
    '%s exposes the same repository map as AGENTS.md',
    async (layer) => {
      const dir = path.join(agentOs, layer);
      await expect(text(dir, 'AGENTS.md')).resolves.toBe(await text(dir, 'CLAUDE.md'));
      await expect(text(dir, 'AGENTS.md')).resolves.toMatch(/Claude Code and Codex/);
    },
  );

  it('publishes every shared skill through the Codex repository skill location', async () => {
    const claudeSkills = await readdir(path.join(universal, '.claude', 'skills'));
    const codexSkills = await readdir(path.join(universal, '.agents', 'skills'));
    expect(codexSkills.sort()).toEqual(claudeSkills.sort());

    for (const skill of claudeSkills) {
      await expect(text(universal, '.agents', 'skills', skill, 'SKILL.md')).resolves.toBe(
        await text(universal, '.claude', 'skills', skill, 'SKILL.md'),
      );
    }
  });

  it('publishes every Claude agent as a project-scoped Codex custom agent', async () => {
    const claudeAgents = (await readdir(path.join(universal, '.claude', 'agents'))).map((name) =>
      name.replace(/\.md$/, ''),
    );
    const codexAgents = (await readdir(path.join(universal, '.codex', 'agents'))).map((name) =>
      name.replace(/\.toml$/, ''),
    );
    expect(codexAgents.sort()).toEqual(claudeAgents.sort());

    for (const agent of codexAgents) {
      const profile = await text(universal, '.codex', 'agents', `${agent}.toml`);
      expect(profile).toContain(`name = "${agent}"`);
      expect(profile).toMatch(/^description = ".+"$/m);
      expect(profile).toMatch(/^developer_instructions = /m);
      if (agent !== 'test-writer') expect(profile).toContain('sandbox_mode = "read-only"');
    }
  });

  it('wires native Codex hooks with portable commands and apply_patch coverage', async () => {
    const config = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
      hooks: Record<
        string,
        Array<{
          matcher?: string;
          hooks: Array<{ command: string; commandWindows?: string }>;
        }>
      >;
    };
    const editGroup = config.hooks.PreToolUse?.find((group) =>
      group.matcher?.includes('apply_patch'),
    );
    expect(editGroup).toBeDefined();
    expect(editGroup?.hooks.some((hook) => hook.command.includes('guard-core-purity.mjs'))).toBe(
      true,
    );
    for (const groups of Object.values(config.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          expect(hook.command).toContain('git rev-parse --show-toplevel');
          expect(hook.commandWindows).not.toBe(hook.command);
          const windowsCommand = hook.commandWindows?.match(
            /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
          );
          expect(windowsCommand).toBeDefined();
          const windowsScript = Buffer.from(windowsCommand?.[1] ?? '', 'base64').toString(
            'utf16le',
          );
          expect(windowsScript).toContain('git rev-parse --show-toplevel');
          expect(windowsScript).toMatch(
            /Join-Path \$repoRoot '\.claude\/hooks\/[A-Za-z0-9._-]+\.mjs'/,
          );
          expect(hook.command).not.toContain('CLAUDE_PROJECT_DIR');
          // `command` is what Codex executes on macOS and Linux. Keep it valid
          // for the platform-provided POSIX shell and independent of GNU tools.
          expect(hook.command).toMatch(
            /^node "\$\(git rev-parse --show-toplevel\)\/\.claude\/hooks\/[A-Za-z0-9._-]+\.mjs"$/,
          );
          expect(hook.command).not.toMatch(/powershell|cmd\.exe|%CD%|\\/i);
        }
      }
    }
  });

  it('refuses to expose a Claude edit guard to apply_patch without the shared normalizer', async () => {
    const config = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
      hooks: {
        PreToolUse: Array<{
          matcher?: string;
          hooks: Array<{ command: string }>;
        }>;
      };
    };

    for (const group of config.hooks.PreToolUse) {
      if (!group.matcher?.includes('apply_patch')) continue;
      for (const hook of group.hooks) {
        const relativeHook = hook.command.match(/\.claude\/hooks\/[A-Za-z0-9._-]+\.mjs/)?.[0];
        expect(relativeHook, `cannot locate the hook in: ${hook.command}`).toBeDefined();
        const source = await text(universal, ...(relativeHook?.split('/') ?? []));
        expect(source, `${relativeHook} bypasses the shared edit normalizer`).toMatch(
          /from ['"]\.\/lib\/edit-input\.mjs['"]/,
        );
      }
    }
  });
});

function runGuard(script: string, command: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(hooksDir, script)],
      (error, _stdout, stderr) =>
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr }),
    );
    if (!child.stdin) return reject(new Error('no stdin'));
    child.stdin.end(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: { command },
      }),
    );
  });
}

describe('Codex apply_patch cannot bypass architecture guards', () => {
  it('blocks impurity added to core', async () => {
    const result = await runGuard(
      'guard-core-purity.mjs',
      [
        '*** Begin Patch',
        '*** Update File: packages/core/src/note.ts',
        '@@',
        "+import { readFile } from 'node:fs/promises';",
        '*** End Patch',
      ].join('\n'),
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/core/i);
  });

  it('blocks a backend import added to the web app', async () => {
    const result = await runGuard(
      'guard-web-boundary.mjs',
      [
        '*** Begin Patch',
        '*** Update File: apps/web/src/app/page.tsx',
        '@@',
        "+import { db } from '@app/db';",
        '*** End Patch',
      ].join('\n'),
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/web/i);
  });

  it('does not inspect removed patch lines as newly introduced code', async () => {
    const result = await runGuard(
      'guard-core-purity.mjs',
      [
        '*** Begin Patch',
        '*** Update File: packages/core/src/note.ts',
        '@@',
        "-import { readFile } from 'node:fs/promises';",
        '+export const pure = true;',
        '*** End Patch',
      ].join('\n'),
    );
    expect(result.code).toBe(0);
  });

  it('blocks a move-only patch that carries existing impurity into core', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'codex-move-'));
    const source = path.join(scratch, 'impure.ts');
    await writeFile(source, "import { readFile } from 'node:fs/promises';\n");

    try {
      const result = await runGuard(
        'guard-core-purity.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${source}`,
          '*** Move to: packages/core/src/impure.ts',
          '*** End Patch',
        ].join('\n'),
      );
      expect(result.code).toBe(2);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
