import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
    expect(config.hooks.PreToolUse?.some((group) => group.matcher === 'Bash')).toBe(true);
    expect(config.hooks.Stop).toHaveLength(1);
    expect(config.hooks.SessionStart).toHaveLength(1);
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

  it('emits each tool at most once in generated Codex hook matchers', async () => {
    const config = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
      hooks: Record<string, Array<{ matcher?: string }>>;
    };

    for (const groups of Object.values(config.hooks)) {
      for (const group of groups) {
        if (!group.matcher) continue;
        const tools = group.matcher.split('|').map((tool) => tool.trim());
        expect(tools, group.matcher).toHaveLength(new Set(tools).size);
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

  it('declares generated Codex hook wiring as an elevated path', async () => {
    const map = await text(universal, 'CLAUDE.md');
    const elevated = /```elevated-paths\n([\s\S]*?)```/.exec(map)?.[1] ?? '';
    expect(elevated.split(/\r?\n/)).toContain('.codex/');
  });

  it('grounds the string command payload contract in the official Codex hooks documentation', async () => {
    const decision = await text(universal, 'docs', 'decisions', 'codex-adapter.md');

    expect(decision).toContain('https://learn.chatgpt.com/docs/hooks');
    expect(decision).toMatch(/tool_input\.command[^.]{0,120}string/i);
  });

  it('grounds hook trust and re-review guidance in the official Codex hooks documentation', async () => {
    const readme = await text(repoRoot, 'README.md');
    const trustGuidance = readme.match(/After generation or upgrade,[\s\S]*?(?=\n## )/)?.[0] ?? '';

    expect(trustGuidance).toContain('https://learn.chatgpt.com/docs/hooks');
    expect(trustGuidance).toMatch(/changed[^.]*hook[^.]*review again/i);
  });
});

function runGuard(script: string, command: string): Promise<{ code: number; stderr: string }> {
  return runGuardInput(script, {
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: { command },
    cwd: repoRoot,
  });
}

function runGuardInput(
  script: string,
  input: {
    hook_event_name: string;
    tool_name: string;
    tool_input: { command: unknown };
    cwd: string;
  },
  timeout?: number,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(hooksDir, script)],
      { timeout },
      (error, _stdout, stderr) =>
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr }),
    );
    if (!child.stdin) return reject(new Error('no stdin'));
    child.stdin.end(JSON.stringify(input));
  });
}

describe('Codex apply_patch cannot bypass architecture guards', () => {
  it.each([
    ['a number', 42],
    ['a mixed array', ['*** Begin Patch', 42, '*** End Patch']],
    ['an object', { patch: '*** Begin Patch\n*** End Patch' }],
  ])(
    'fails open with a diagnostic when apply_patch command is supplied as %s',
    async (_label, command) => {
      const result = await runGuardInput('guard-core-purity.mjs', {
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: { command },
        cwd: repoRoot,
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toMatch(/cannot safely inspect.*patch|apply_patch.*command/i);
    },
  );

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

  it.each([
    {
      guard: 'guard-core-purity.mjs',
      destination: 'packages/core/./src/note.ts',
      addition: "+import { readFile } from 'node:fs/promises';",
    },
    {
      guard: 'guard-web-boundary.mjs',
      destination: 'apps/./web/src/app/page.tsx',
      addition: "+import { db } from '@app/db';",
    },
  ])('canonicalizes and protects the dotted destination $destination', async (example) => {
    const result = await runGuard(
      example.guard,
      [
        '*** Begin Patch',
        `*** Update File: ${example.destination}`,
        '@@',
        example.addition,
        '*** End Patch',
      ].join('\n'),
    );

    expect(result.code).toBe(2);
  });

  it('protects an Add destination hidden behind an in-repository parent symlink', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-symlink-add-destination-'));
    const alias = path.join(scratch, 'alias');
    const core = path.join(
      repoRoot,
      'templates',
      'skeleton',
      'node-service',
      'packages',
      'core',
      'src',
    );

    try {
      await symlink(core, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await runGuard(
        'guard-core-purity.mjs',
        [
          '*** Begin Patch',
          `*** Add File: ${path.relative(repoRoot, path.join(alias, 'impure.ts'))}`,
          "+import { readFile } from 'node:fs/promises';",
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/core/i);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('protects a Move destination hidden behind an in-repository parent symlink', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-symlink-move-destination-'));
    const source = path.join(scratch, 'impure.ts');
    const alias = path.join(scratch, 'alias');
    const core = path.join(
      repoRoot,
      'templates',
      'skeleton',
      'node-service',
      'packages',
      'core',
      'src',
    );
    await writeFile(source, "import { readFile } from 'node:fs/promises';\n");

    try {
      await symlink(core, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await runGuard(
        'guard-core-purity.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          `*** Move to: ${path.relative(repoRoot, path.join(alias, 'impure.ts'))}`,
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/core/i);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('refuses a destination symlink outside the repository without leaking its target or moved content', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'codex-private-destination-target-'));
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-outside-destination-link-'));
    const source = path.join(scratch, 'source.ts');
    const alias = path.join(scratch, 'alias');
    const contentMarker = 'unique-destination-content-marker';
    await writeFile(source, `export const value = '${contentMarker}';\n`);

    try {
      await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await runGuard(
        'guard-core-purity.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          `*** Move to: ${path.relative(repoRoot, path.join(alias, 'moved.ts'))}`,
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/destination.*(?:outside|unsafe)|unsafe.*destination/i);
      expect(result.stderr).not.toContain(contentMarker);
      expect(result.stderr).not.toContain(outside);
    } finally {
      await rm(scratch, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses an Add destination that is a dangling symlink to a missing outside path without leaking the target', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'codex-missing-add-target-'));
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-dangling-add-link-'));
    const missingTarget = path.join(outside, 'missing-private-target.ts');
    const destination = path.join(scratch, 'destination.ts');

    try {
      await symlink(missingTarget, destination, 'file');
      const result = await runGuard(
        'guard-core-purity.mjs',
        [
          '*** Begin Patch',
          `*** Add File: ${path.relative(repoRoot, destination)}`,
          '+export const safe = true;',
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/destination.*(?:outside|unsafe)|unsafe.*destination/i);
      expect(result.stderr).not.toContain(outside);
    } finally {
      await rm(scratch, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a Move destination below a dangling parent symlink without leaking its missing outside target', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'codex-missing-move-target-'));
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-dangling-move-link-'));
    const missingTarget = path.join(outside, 'missing-private-directory');
    const source = path.join(scratch, 'source.ts');
    const alias = path.join(scratch, 'alias');
    await writeFile(source, 'export const safe = true;\n');

    try {
      await symlink(missingTarget, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await runGuard(
        'guard-core-purity.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          `*** Move to: ${path.relative(repoRoot, path.join(alias, 'moved.ts'))}`,
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/destination.*(?:outside|unsafe)|unsafe.*destination/i);
      expect(result.stderr).not.toContain(outside);
    } finally {
      await rm(scratch, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses absolute and traversal move destinations outside the repository', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-outside-destination-'));
    const source = path.join(scratch, 'source.ts');
    await writeFile(source, 'export const safe = true;\n');

    try {
      for (const destination of [
        path.join(tmpdir(), 'outside.ts'),
        '../outside.ts',
        '..\\outside.ts',
        'C:outside.ts',
        '\\\\server\\share\\outside.ts',
      ]) {
        const result = await runGuard(
          'guard-core-purity.mjs',
          [
            '*** Begin Patch',
            `*** Update File: ${path.relative(repoRoot, source)}`,
            `*** Move to: ${destination}`,
            '*** End Patch',
          ].join('\n'),
        );

        expect(result.code, destination).toBe(2);
        expect(result.stderr, destination).toMatch(/destination.*outside|unsafe.*destination/i);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
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

  it.each(['absolute', 'traversal'])(
    'refuses to inspect a move source outside the repository via %s',
    async (pathKind) => {
      const scratch = await mkdtemp(path.join(tmpdir(), 'codex-outside-'));
      const source = path.join(scratch, 'safe.ts');
      await writeFile(source, 'export const safe = true;\n');
      const sourcePath = pathKind === 'absolute' ? source : path.relative(repoRoot, source);

      try {
        const result = await runGuard(
          'guard-core-purity.mjs',
          [
            '*** Begin Patch',
            `*** Update File: ${sourcePath}`,
            '*** Move to: packages/core/src/safe.ts',
            '*** End Patch',
          ].join('\n'),
        );
        expect(result.code).toBe(2);
        expect(result.stderr).toMatch(/outside|repository|repo root|refus|inspect/i);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  );

  it('does not echo content read from an outside-repository move source', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'codex-outside-content-'));
    const source = path.join(scratch, 'private.ts');
    await writeFile(source, "import '@app/db/unique-private-marker';\n");

    try {
      const result = await runGuard(
        'guard-web-boundary.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${source}`,
          '*** Move to: apps/web/src/private.ts',
          '*** End Patch',
        ].join('\n'),
      );
      expect(result.code).toBe(2);
      expect(result.stderr).not.toContain('unique-private-marker');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('rejects an in-repository symlink that resolves outside without echoing its content', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'codex-symlink-target-'));
    const inside = await mkdtemp(path.join(repoRoot, '.codex-symlink-source-'));
    const link = path.join(inside, 'outside');
    await writeFile(path.join(outside, 'private.ts'), "import '@app/db/unique-symlink-marker';\n");

    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await runGuard(
        'guard-web-boundary.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, path.join(link, 'private.ts'))}`,
          '*** Move to: apps/web/src/private.ts',
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/resolves outside|outside.*repository/i);
      expect(result.stderr).not.toContain('unique-symlink-marker');
    } finally {
      await rm(inside, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('treats a final-component symlink as a recognized unsafe-source refusal', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'codex-final-symlink-target-'));
    const inside = await mkdtemp(path.join(repoRoot, '.codex-final-symlink-'));
    const target = path.join(outside, 'private.ts');
    const link = path.join(inside, 'private.ts');
    await writeFile(target, "import '@app/db/unique-final-symlink-marker';\n");

    try {
      await symlink(target, link, 'file');
      const result = await runGuard(
        'guard-web-boundary.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, link)}`,
          '*** Move to: apps/web/src/private.ts',
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/resolves outside|unsafe.*source/i);
      expect(result.stderr).not.toContain('unique-final-symlink-marker');
    } finally {
      await rm(inside, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('diagnoses a missing move source but leaves the guard fail-open', async () => {
    const result = await runGuard(
      'guard-core-purity.mjs',
      [
        '*** Begin Patch',
        '*** Update File: definitely-missing/move-source.ts',
        '*** Move to: packages/core/src/missing.ts',
        '*** End Patch',
      ].join('\n'),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/could not inspect moved file/i);
    expect(result.stderr).not.toMatch(/BLOCKED/i);
  });

  it('blocks a move-only patch that carries existing impurity into core', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-impure-move-'));
    const source = path.join(scratch, 'impure.ts');
    await writeFile(source, "import { readFile } from 'node:fs/promises';\n");

    try {
      const result = await runGuard(
        'guard-core-purity.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          '*** Move to: packages/core/src/impure.ts',
          '*** End Patch',
        ].join('\n'),
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/core/i);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('resolves a relative move source from the hook payload cwd', async () => {
    const nested = await mkdtemp(
      path.join(
        repoRoot,
        'templates',
        'skeleton',
        'node-service',
        'packages',
        'core',
        'src',
        '.codex-nested-cwd-',
      ),
    );
    await writeFile(
      path.join(nested, 'impure.ts'),
      "import { readFile } from 'node:fs/promises';\n",
    );

    try {
      const result = await runGuardInput('guard-core-purity.mjs', {
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: {
          command: [
            '*** Begin Patch',
            '*** Update File: impure.ts',
            '*** Move to: moved.ts',
            '*** End Patch',
          ].join('\n'),
        },
        cwd: nested,
      });

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/core/i);
    } finally {
      await rm(nested, { recursive: true, force: true });
    }
  });

  it('refuses to inspect a non-regular move source', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-non-regular-'));
    const source = path.join(scratch, 'directory');
    await mkdir(source);

    try {
      const result = await runGuard(
        'guard-core-purity.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          '*** Move to: packages/core/src/directory.ts',
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/not a regular file|cannot safely inspect/i);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('quickly refuses a FIFO move source instead of blocking on it', async () => {
    if (process.platform === 'win32') return;

    const scratch = await mkdtemp(path.join(tmpdir(), 'codex-fifo-move-'));
    const core = path.join(scratch, 'packages', 'core', 'src');
    const source = path.join(core, 'source.ts');

    try {
      await mkdir(core, { recursive: true });
      await exec('git', ['init', '--quiet'], { cwd: scratch });
      try {
        await exec('mkfifo', [source]);
      } catch (error) {
        const stderr = (error as { stderr?: string }).stderr ?? '';
        if (/operation not supported/i.test(stderr)) return;
        throw error;
      }
      const result = await runGuardInput(
        'guard-core-purity.mjs',
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'apply_patch',
          tool_input: {
            command: [
              '*** Begin Patch',
              '*** Update File: packages/core/src/source.ts',
              '*** Move to: packages/core/src/moved.ts',
              '*** End Patch',
            ].join('\n'),
          },
          cwd: scratch,
        },
        1_000,
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/not a regular file|cannot safely inspect/i);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('fails closed on a final-component symlink even when its target is in the repository', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-inside-symlink-'));
    const target = path.join(scratch, 'target.ts');
    const source = path.join(scratch, 'source.ts');
    await writeFile(target, 'export const safe = true;\n');

    try {
      await symlink(target, source, 'file');
      const result = await runGuard(
        'guard-core-purity.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          '*** Move to: packages/core/src/source.ts',
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/cannot safely inspect|unsafe.*source/i);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('reads only a bounded prefix and blocks an oversized move source', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-large-move-'));
    const source = path.join(scratch, 'large.ts');
    await writeFile(source, 'x'.repeat(1024 * 1024 + 1));

    try {
      const result = await runGuard(
        'guard-core-purity.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          '*** Move to: packages/core/src/large.ts',
          '*** End Patch',
        ].join('\n'),
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/large|size|limit|inspect/i);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('refuses an oversized apply_patch command before parsing its contents', async () => {
    const result = await runGuard(
      'guard-core-purity.mjs',
      [
        '*** Begin Patch',
        '*** Update File: packages/core/src/large-patch.ts',
        '@@',
        `+${'x'.repeat(1024 * 1024 + 1)}`,
        '*** End Patch',
      ].join('\n'),
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/patch.*(?:size|limit|large)|(?:size|limit|large).*patch/i);
  });

  it('refuses the whole patch and stops processing after the global section budget is exhausted', async () => {
    const source = await text(hooksDir, 'lib', 'edit-input.mjs');
    const declaration = /const MAX_PATCH_SECTIONS = ([\d_]+);/.exec(source);
    expect(
      declaration,
      'MAX_PATCH_SECTIONS must bound filesystem work independently of patch character size',
    ).not.toBeNull();

    const sectionLimit = Number(declaration?.[1]?.replaceAll('_', ''));
    expect(sectionLimit).toBeGreaterThan(0);
    expect(sectionLimit).toBeLessThanOrEqual(4_096);
    expect([...source.matchAll(/\bMAX_PATCH_SECTIONS\b/g)].length).toBeGreaterThan(1);

    const editInput = (await import(
      pathToFileURL(path.join(hooksDir, 'lib', 'edit-input.mjs')).href
    )) as {
      editFragments(input: unknown): Array<{
        filePath: string;
        fragment: string;
        inspectionRefusal?: string;
        appliesToAll?: boolean;
      }>;
    };
    const sections = Array.from({ length: sectionLimit + 1 }, (_, index) => [
      `*** Add File: packages/core/src/section-${index}.ts`,
      '+export {};',
    ]).flat();
    const fragments = editInput.editFragments({
      tool_name: 'apply_patch',
      cwd: repoRoot,
      tool_input: {
        command: [
          '*** Begin Patch',
          ...sections,
          // If processing continues after exhaustion this path produces a
          // different repository-path refusal and masks the budget failure.
          '*** Add File: ../../must-not-resolve.ts',
          '+export {};',
          '*** End Patch',
        ].join('\n'),
      },
    });
    const refusals = fragments.filter(({ inspectionRefusal }) => inspectionRefusal);

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ appliesToAll: true });
    expect(refusals[0]?.inspectionRefusal).toMatch(
      /section.*(?:budget|limit)|(?:budget|limit).*section/i,
    );
    expect(refusals[0]?.inspectionRefusal).not.toMatch(/destination|repository|path/i);
  });

  it('refuses the whole patch before later sections after the global path-component budget is exhausted', async () => {
    const source = await text(hooksDir, 'lib', 'edit-input.mjs');
    const declaration = /const MAX_PATCH_PATH_COMPONENTS = ([\d_]+);/.exec(source);
    expect(
      declaration,
      'MAX_PATCH_PATH_COMPONENTS must bound destination traversal independently of section count',
    ).not.toBeNull();

    const componentLimit = Number(declaration?.[1]?.replaceAll('_', ''));
    expect(componentLimit).toBeGreaterThan(0);
    expect(componentLimit).toBeLessThanOrEqual(4_096);
    expect([...source.matchAll(/\bMAX_PATCH_PATH_COMPONENTS\b/g)].length).toBeGreaterThan(1);

    const editInput = (await import(
      pathToFileURL(path.join(hooksDir, 'lib', 'edit-input.mjs')).href
    )) as {
      editFragments(input: unknown): Array<{
        filePath: string;
        fragment: string;
        inspectionRefusal?: string;
        appliesToAll?: boolean;
      }>;
    };
    const componentsPerSection = Math.min(32, componentLimit);
    const sectionCount = Math.floor(componentLimit / componentsPerSection) + 1;
    const sections = Array.from({ length: sectionCount }, (_, section) => {
      const components = Array.from(
        { length: componentsPerSection },
        (_unused, component) => `s${section}-${component}`,
      );
      components[components.length - 1] += '.ts';
      return [`*** Add File: ${components.join('/')}`, '+export {};'];
    }).flat();
    const fragments = editInput.editFragments({
      tool_name: 'apply_patch',
      cwd: repoRoot,
      tool_input: {
        command: [
          '*** Begin Patch',
          ...sections,
          '*** Add File: ../../must-not-resolve-after-component-budget.ts',
          '+export {};',
          '*** End Patch',
        ].join('\n'),
      },
    });
    const refusals = fragments.filter(({ inspectionRefusal }) => inspectionRefusal);

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ appliesToAll: true });
    expect(refusals[0]?.inspectionRefusal).toMatch(
      /(?:path|destination).*component.*(?:budget|limit)|(?:budget|limit).*component/i,
    );
    expect(refusals[0]?.inspectionRefusal).not.toMatch(/outside|cannot be resolved safely/i);
  });

  it('caps aggregate source inspection across many move sections', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-many-moves-'));
    const sections: string[] = [];

    try {
      for (let index = 0; index < 17; index += 1) {
        const source = path.join(scratch, `${index}.ts`);
        await writeFile(source, 'x'.repeat(64 * 1024));
        sections.push(
          `*** Update File: ${path.relative(repoRoot, source)}`,
          `*** Move to: packages/core/src/moved-${index}.ts`,
        );
      }
      const result = await runGuard(
        'guard-core-purity.mjs',
        ['*** Begin Patch', ...sections, '*** End Patch'].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/aggregate|total.*(?:move|inspection)|move.*budget/i);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('does not inspect later move sources after refusing the aggregate moved-byte budget', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-move-budget-stop-'));
    const fullBudget = path.join(scratch, 'full-budget.ts');
    const overBudget = path.join(scratch, 'over-budget.ts');
    const laterDirectory = path.join(scratch, 'must-not-open');
    await writeFile(fullBudget, 'x'.repeat(1024 * 1024));
    await writeFile(overBudget, 'x');
    await mkdir(laterDirectory);

    try {
      const result = await runGuard(
        'guard-core-purity.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, fullBudget)}`,
          '*** Move to: packages/core/src/full-budget.ts',
          `*** Update File: ${path.relative(repoRoot, overBudget)}`,
          '*** Move to: packages/core/src/over-budget.ts',
          `*** Update File: ${path.relative(repoRoot, laterDirectory)}`,
          '*** Move to: packages/core/src/must-not-open.ts',
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/aggregate.*move|move.*aggregate/i);
      expect(result.stderr).not.toMatch(/not a regular file|cannot safely inspect moved file/i);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('blocks a move whose patch context does not match its source', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-context-mismatch-'));
    const source = path.join(scratch, 'actual.ts');
    await writeFile(source, 'export const actual = true;\n');

    try {
      const result = await runGuard(
        'guard-core-purity.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          '*** Move to: packages/core/src/actual.ts',
          '@@',
          ' export const expected = true;',
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/context does not match/i);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('blocks a move hunk that exceeds the hunk-line ceiling', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-hunk-lines-'));
    const source = path.join(scratch, 'small.ts');
    await writeFile(source, 'same\n');

    try {
      const result = await runGuard(
        'guard-core-purity.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          '*** Move to: packages/core/src/small.ts',
          '@@',
          ...Array.from({ length: 10_001 }, () => ' same'),
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/hunk.*(?:ceiling|limit)|(?:ceiling|limit).*hunk/i);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('caps total hunk lines across one move', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-total-hunks-'));
    const source = path.join(scratch, 'small.ts');
    await writeFile(source, 'export {};\n');

    try {
      const additions = Array.from({ length: 6_000 }, () => '+const safe = true;');
      const result = await runGuard(
        'guard-core-purity.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          '*** Move to: packages/core/src/many-hunks.ts',
          '@@',
          ...additions,
          '@@',
          ...additions,
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/total.*hunk|hunk.*(?:total|budget)/i);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('caps the total output lines produced by move inspection', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-output-lines-'));
    const source = path.join(scratch, 'many-lines.ts');
    await writeFile(source, `${Array.from({ length: 20_001 }, () => 'safe').join('\n')}\n`);

    try {
      const result = await runGuard(
        'guard-core-purity.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          '*** Move to: packages/core/src/many-lines.ts',
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/output.*(?:budget|limit)|(?:budget|limit).*output/i);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('caps aggregate output lines across multiple move sections', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-aggregate-output-lines-'));
    const sections: string[] = [];

    try {
      for (let index = 0; index < 2; index += 1) {
        const source = path.join(scratch, `${index}.ts`);
        await writeFile(source, `${Array.from({ length: 10_001 }, () => 'safe').join('\n')}\n`);
        sections.push(
          `*** Update File: ${path.relative(repoRoot, source)}`,
          `*** Move to: packages/core/src/output-${index}.ts`,
        );
      }
      const result = await runGuard(
        'guard-core-purity.mjs',
        ['*** Begin Patch', ...sections, '*** End Patch'].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/aggregate.*output|output.*aggregate/i);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('does not inspect later move sources after refusing the aggregate output-line budget', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-output-budget-stop-'));
    const first = path.join(scratch, 'first.ts');
    const overBudget = path.join(scratch, 'over-budget.ts');
    const laterDirectory = path.join(scratch, 'must-not-open');
    await writeFile(first, Array.from({ length: 10_000 }, () => 'safe').join('\n'));
    await writeFile(overBudget, Array.from({ length: 10_001 }, () => 'safe').join('\n'));
    await mkdir(laterDirectory);

    try {
      const result = await runGuard(
        'guard-core-purity.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, first)}`,
          '*** Move to: packages/core/src/output-first.ts',
          `*** Update File: ${path.relative(repoRoot, overBudget)}`,
          '*** Move to: packages/core/src/output-over-budget.ts',
          `*** Update File: ${path.relative(repoRoot, laterDirectory)}`,
          '*** Move to: packages/core/src/output-must-not-open.ts',
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/aggregate.*output|output.*aggregate/i);
      expect(result.stderr).not.toMatch(/not a regular file|cannot safely inspect moved file/i);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('caps the number of splice operations across one move', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-splice-budget-'));
    const source = path.join(scratch, 'small.ts');
    await writeFile(source, 'export {};\n');

    try {
      const hunks = Array.from({ length: 1_001 }, () => ['@@', '+const safe = true;']).flat();
      const result = await runGuard(
        'guard-core-purity.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          '*** Move to: packages/core/src/many-splices.ts',
          ...hunks,
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/splice.*(?:budget|limit)|(?:budget|limit).*splice/i);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('blocks a move when the context-comparison budget is exhausted', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-comparison-budget-'));
    const source = path.join(scratch, 'repetitive.ts');
    const content = `${Array.from({ length: 12_000 }, () => 'same').join('\n')}\n`;
    expect(Buffer.byteLength(content)).toBeLessThan(1024 * 1024);
    await writeFile(source, content);

    try {
      const result = await runGuard(
        'guard-core-purity.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          '*** Move to: packages/core/src/repetitive.ts',
          '@@',
          ...Array.from({ length: 4_999 }, () => ' same'),
          ' needle',
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/comparison.*(?:budget|limit)|(?:budget|limit).*comparison/i);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('keeps move-inspection contracts mechanically self-contained in shipped code', async () => {
    const source = await text(hooksDir, 'lib', 'edit-input.mjs');
    expect(source).not.toMatch(/codex\.test\.ts|test[\\/]template/);

    for (const [name, value] of [
      ['MAX_PATCH_CHARACTERS', '1024 * 1024'],
      ['MAX_MOVED_FILE_BYTES', '1024 * 1024'],
      ['MAX_HUNK_LINES', '10_000'],
      ['MAX_CONTEXT_COMPARISONS', '2_000_000'],
    ]) {
      expect(source, `${name} must be declared in the shipped normalizer`).toContain(
        `const ${name} = ${value};`,
      );
      expect(
        [...source.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length,
        `${name} must be consumed by inspection behavior`,
      ).toBeGreaterThan(1);
    }

    const guards = await Promise.all(
      ['guard-core-purity.mjs', 'guard-web-boundary.mjs'].map((guard) => text(hooksDir, guard)),
    );
    expect(source).toMatch(/inspectionRefusal:\s*reason/);
    for (const guard of guards) expect(guard).toMatch(/inspectionRefusal/);
  });

  it('removes the occurrence selected by the complete hunk, not the first matching line', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-exact-move-'));
    const source = path.join(scratch, 'duplicate.ts');
    await writeFile(
      source,
      [
        'const duplicate = true;',
        'const anchor = true;',
        'const duplicate = true;',
        'export {};',
        '',
      ].join('\n'),
    );

    try {
      const editInput = (await import(
        pathToFileURL(path.join(hooksDir, 'lib', 'edit-input.mjs')).href
      )) as {
        editFragments(input: unknown): Array<{ filePath: string; fragment: string }>;
      };
      const [move] = editInput.editFragments({
        tool_name: 'apply_patch',
        cwd: repoRoot,
        tool_input: {
          command: [
            '*** Begin Patch',
            `*** Update File: ${path.relative(repoRoot, source)}`,
            '*** Move to: packages/core/src/duplicate.ts',
            '@@',
            ' const anchor = true;',
            '-const duplicate = true;',
            ' export {};',
            '*** End Patch',
          ].join('\n'),
        },
      });

      expect(move?.fragment).toBe(
        ['const duplicate = true;', 'const anchor = true;', 'export {};', ''].join('\n'),
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe('Codex oversized apply_patch inspection refusals', () => {
  it.each([
    {
      guard: 'guard-core-purity.mjs',
      falseDiagnosis:
        /packages\/core is a pure module|breaks its purity|usecase layer|into an adapter/i,
    },
    {
      guard: 'guard-web-boundary.mjs',
      falseDiagnosis:
        /apps\/web imports the domain|crosses the web boundary|talks to services|storage stays behind/i,
    },
    {
      guard: 'guard-secret-file.mjs',
      falseDiagnosis:
        /credential file|credential value|writes a credential|repository never carries one/i,
    },
  ])(
    '$guard blocks with a neutral, actionable size-limit refusal',
    async ({ guard, falseDiagnosis }) => {
      const result = await runGuard(
        guard,
        [
          '*** Begin Patch',
          '*** Add File: docs/big.md',
          `+${'x'.repeat(1024 * 1024 + 1)}`,
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/BLOCKED — cannot safely inspect/i);
      expect(result.stderr).toMatch(/1048576-character inspection limit/i);
      expect(result.stderr).toMatch(/split|smaller patch/i);
      expect(result.stderr).not.toMatch(falseDiagnosis);
    },
  );
});
