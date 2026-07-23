import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hooksDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'hooks');

interface HookResult {
  code: number;
  stderr: string;
}

/** Feed a synthetic PreToolUse payload to a hook script, exactly as Claude Code does. */
function runHook(script: string, payload: object): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(hooksDir, script)],
      (error, _stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, stderr });
      },
    );
    if (!child.stdin) return reject(new Error('no stdin'));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

const write = (filePath: string, content: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: filePath, content },
});

const edit = (filePath: string, newString: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: filePath, old_string: 'x', new_string: newString },
});

const bash = (command: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
});

describe('guard-core-purity hook (the genuinely blocking gate)', () => {
  const core = 'packages/core/src/note.ts';

  it('blocks I/O imports in core', async () => {
    const result = await runHook(
      'guard-core-purity.mjs',
      write(core, "import { readFile } from 'node:fs/promises';"),
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/core/i);
  });

  it('blocks non-allowlisted package imports in core', async () => {
    const result = await runHook(
      'guard-core-purity.mjs',
      write(core, "import { DynamoDBClient } from '@aws-sdk/client-dynamodb';"),
    );
    expect(result.code).toBe(2);
  });

  it('blocks environment access in core', async () => {
    const result = await runHook(
      'guard-core-purity.mjs',
      write(core, 'const stage = process.env.STAGE;'),
    );
    expect(result.code).toBe(2);
  });

  it('blocks clock and randomness in core', async () => {
    for (const line of ['const t = Date.now();', 'const d = new Date();', 'Math.random();']) {
      const result = await runHook('guard-core-purity.mjs', write(core, line));
      expect(result.code, line).toBe(2);
    }
  });

  it('blocks violations introduced via Edit as well', async () => {
    const result = await runHook('guard-core-purity.mjs', edit(core, "const fs = require('fs');"));
    expect(result.code).toBe(2);
  });

  it('allows pure core code (relative imports, allowlisted schema lib, type-only imports)', async () => {
    const content = [
      "import { z } from 'zod';",
      "import { slugify } from './slug.js';",
      "import type { Logger } from '@app/shared';",
      'export const NoteSchema = z.object({ title: z.string() });',
    ].join('\n');
    const result = await runHook('guard-core-purity.mjs', write(core, content));
    expect(result.code).toBe(0);
  });

  it('does not police files outside core', async () => {
    const result = await runHook(
      'guard-core-purity.mjs',
      write('packages/db/src/client.ts', "import { readFile } from 'node:fs';"),
    );
    expect(result.code).toBe(0);
  });
});

describe('block-no-verify hook', () => {
  it('blocks git commit --no-verify', async () => {
    const result = await runHook('block-no-verify.mjs', bash('git commit --no-verify -m "x"'));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/no-verify|pre-commit/i);
  });

  it('blocks git push --no-verify and the -n short form', async () => {
    expect((await runHook('block-no-verify.mjs', bash('git push --no-verify'))).code).toBe(2);
    expect((await runHook('block-no-verify.mjs', bash('git commit -n -m "x"'))).code).toBe(2);
  });

  it('allows normal git usage and unrelated flags', async () => {
    expect((await runHook('block-no-verify.mjs', bash('git commit -m "x"'))).code).toBe(0);
    expect((await runHook('block-no-verify.mjs', bash('echo --no-verify'))).code).toBe(0);
    expect((await runHook('block-no-verify.mjs', bash('git log -n 3'))).code).toBe(0);
  });

  it('does not block a commit whose message merely MENTIONS the flag (quoted text)', async () => {
    // agent-os v2 brief §2b: strip quoted segments before matching — a guard
    // that fires on prose produces false blocks and trains people to fight it.
    for (const command of [
      'git commit -m "docs: explain why --no-verify is forbidden"',
      "git commit -m 'never bypass hooks with --no-verify'",
      'git commit -m "note" -m "the -n shorthand is banned too"',
    ]) {
      expect((await runHook('block-no-verify.mjs', bash(command))).code, command).toBe(0);
    }
  });

  it('still blocks the real flag even when quoted text is also present', async () => {
    const result = await runHook(
      'block-no-verify.mjs',
      bash('git commit --no-verify -m "fix: mention --no-verify in docs"'),
    );
    expect(result.code).toBe(2);
  });
});

describe('hook wiring (settings.json)', () => {
  it('registers both hooks under PreToolUse with existing scripts', async () => {
    const settingsPath = path.join(
      repoRoot,
      'templates',
      'agent-os',
      'universal',
      '.claude',
      'settings.json',
    );
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    const commands = settings.hooks.PreToolUse.flatMap((h) => h.hooks.map((x) => x.command));
    expect(commands.some((c) => c.includes('guard-core-purity.mjs'))).toBe(true);
    expect(commands.some((c) => c.includes('block-no-verify.mjs'))).toBe(true);
  });
});
