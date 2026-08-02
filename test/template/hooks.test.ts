import { execFile } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as fsp from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { gitEnv } from '../../packages/cli/src/lib/git-env.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hooksDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'hooks');

interface HookResult {
  code: number;
  stderr: string;
  stdout: string;
}

/** Feed a synthetic hook payload to a hook script, exactly as Claude Code does. */
function runHookFull(
  script: string,
  payload: object,
  env?: Record<string, string>,
): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(hooksDir, script)],
      { env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, stderr, stdout });
      },
    );
    if (!child.stdin) return reject(new Error('no stdin'));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

const runHook = runHookFull;

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

describe('guard-web-boundary hook (web imports core/shared only)', () => {
  const web = 'apps/web/src/app/page.tsx';

  it('blocks db imports from the web app — under any scope', async () => {
    for (const spec of ['@app/db', '@my-cool-app/db']) {
      const result = await runHook(
        'guard-web-boundary.mjs',
        write(web, `import { NoteModel } from '${spec}';`),
      );
      expect(result.code, spec).toBe(2);
      expect(result.stderr).toMatch(/web/i);
    }
  });

  it('blocks service imports from the web app', async () => {
    for (const spec of ['@app/api', '@app/worker']) {
      const result = await runHook(
        'guard-web-boundary.mjs',
        write(web, `import { something } from '${spec}';`),
      );
      expect(result.code, spec).toBe(2);
    }
  });

  it('blocks relative reaches into db and services', async () => {
    for (const spec of ['../../../packages/db/src/index.js', '../../../services/api/src/main.js']) {
      const result = await runHook(
        'guard-web-boundary.mjs',
        edit(web, `import { x } from '${spec}';`),
      );
      expect(result.code, spec).toBe(2);
    }
  });

  it('allows core, shared, react and next imports', async () => {
    const content = [
      "import { NewNoteSchema } from '@app/core';",
      "import type { Logger } from '@app/shared';",
      "import { useState } from 'react';",
      "import Link from 'next/link';",
      "import { validateNewNote } from '../lib/validate.js';",
    ].join('\n');
    expect((await runHook('guard-web-boundary.mjs', write(web, content))).code).toBe(0);
  });

  it('does not police files outside apps/web', async () => {
    const result = await runHook(
      'guard-web-boundary.mjs',
      write('services/api/src/main.ts', "import { NoteModel } from '@app/db';"),
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

  // Round 5: `git commit -nm "msg"` bypassed the gate outright — the one thing
  // this hook exists to stop, in the spelling people actually type.
  it('blocks -n bundled into a combined short-flag cluster', async () => {
    const bundled = ['-nm "combined"', '-qn -m x', '-amn "x"', '-n -m x'];
    for (const flags of bundled) {
      const command = `git commit ${flags}`;
      expect((await runHook('block-no-verify.mjs', bash(command))).code, command).toBe(2);
    }
  });

  it('still allows clusters that do not contain n', async () => {
    for (const command of [
      'git commit -am "x"',
      'git commit -S -m "x"',
      'git log -n 3',
      'git status',
    ]) {
      expect((await runHook('block-no-verify.mjs', bash(command))).code, command).toBe(0);
    }
  });
});

// extraction brief §3 Tier A: the Never-tier deny-list is the one guard that is
// near-universal. It is a SECOND Bash guard on purpose — block-no-verify owns the
// pre-commit bypass; this one owns the irreversible actions and the kill switch.
describe('guard-bash hook (the Never tier, made mechanical)', () => {
  const KILL = 'AGENT_LOOP_STOP';
  const noKillSwitch = { [KILL]: path.join(tmpdir(), 'definitely-absent-loop-STOP') };

  const run = (command: string, env?: Record<string, string>) =>
    runHookFull('guard-bash.mjs', bash(command), { ...noKillSwitch, ...env });

  it('blocks a force-push that names a protected branch', async () => {
    for (const command of [
      'git push --force origin main',
      'git push -f origin master',
      'git push --force-with-lease origin develop',
      'git push origin +main',
    ]) {
      const result = await run(command);
      expect(result.code, command).toBe(2);
      expect(result.stderr).toMatch(/force/i);
    }
  });

  it('blocks pushing straight to a protected branch, and deleting one', async () => {
    for (const command of [
      'git push origin main',
      'git push origin HEAD:master',
      'git push origin --delete main',
    ]) {
      expect((await run(command)).code, command).toBe(2);
    }
  });

  it('blocks --all and --mirror pushes, which carry protected refs implicitly', async () => {
    for (const command of ['git push --all --force origin', 'git push --mirror origin']) {
      expect((await run(command)).code, command).toBe(2);
    }
  });

  it('blocks a production deploy trigger — workflow dispatch or API', async () => {
    for (const command of [
      'gh workflow run deploy.yml -f stage=prod',
      'gh workflow run deploy --ref main -f environment=production',
      'gh api repos/o/r/actions/workflows/deploy.yml/dispatches -f inputs[stage]=prod',
    ]) {
      const result = await run(command);
      expect(result.code, command).toBe(2);
      expect(result.stderr).toMatch(/prod/i);
    }
  });

  it('blocks catastrophic filesystem wipes', async () => {
    for (const command of [
      'rm -rf /',
      'rm -rf /*',
      'rm -rf ~',
      'rm -rf "$HOME"',
      'rm -fr $HOME/',
    ]) {
      expect((await run(command)).code, command).toBe(2);
    }
  });

  it('allows the ordinary, reversible day-to-day commands', async () => {
    for (const command of [
      'git push origin feat/my-branch',
      'git push --force-with-lease origin feat/my-branch',
      'git push -u origin HEAD',
      'gh pr create --fill',
      'gh workflow run ci.yml',
      'gh workflow run deploy.yml -f stage=dev',
      'rm -rf node_modules',
      'rm -rf ./dist',
      'pnpm test',
    ]) {
      expect((await run(command)).code, command).toBe(0);
    }
  });

  it('does not fire on prose: a message that merely mentions a forbidden action', async () => {
    for (const command of [
      'git commit -m "docs: explain why force-push to main is banned"',
      `git commit -m 'never rm -rf / and never deploy prod by hand'`,
      'gh pr create --title "chore: guard prod deploys"',
    ]) {
      expect((await run(command)).code, command).toBe(0);
    }
  });

  it('is the kill switch: while the stop flag exists, no merge lands', async () => {
    const flag = path.join(await fsp.mkdtemp(path.join(tmpdir(), 'kill-')), 'STOP');
    await fsp.writeFile(flag, '');
    const result = await run('gh pr merge 12 --squash', { [KILL]: flag });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(flag);
    // "stop cleanly" must not mean "lose the work": everything short of the
    // merge stays allowed while the brake is on.
    for (const command of ['git push origin feat/x', 'gh pr create --fill']) {
      expect((await run(command, { [KILL]: flag })).code, command).toBe(0);
    }
  });

  it('a malformed payload or a non-Bash tool is none of its business', async () => {
    expect((await runHookFull('guard-bash.mjs', { tool_name: 'Write' }, noKillSwitch)).code).toBe(
      0,
    );
    expect((await run('')).code).toBe(0);
  });
});

describe('gate-stop-dod hook (the Definition of Done as a mechanical gate)', () => {
  // The hook runs from a project dir: copy it + a checks config into a tmp
  // git repo, exactly as it would live in a generated project.
  const { mkdtemp, mkdir: mkdirP, copyFile, writeFile: writeF, rm: rmP } = fsp;
  let projectDir: string;

  async function setUpProject(options: {
    checks?: unknown;
    dirty?: boolean;
    rawConfig?: string;
  }): Promise<void> {
    projectDir = await mkdtemp(path.join(tmpdir(), 'dod-gate-'));
    const hookDir = path.join(projectDir, '.claude', 'hooks');
    await mkdirP(hookDir, { recursive: true });
    await copyFile(
      path.join(hooksDir, 'gate-stop-dod.mjs'),
      path.join(hookDir, 'gate-stop-dod.mjs'),
    );
    if (options.rawConfig !== undefined) {
      await writeF(path.join(hookDir, 'dod-checks.json'), options.rawConfig);
    } else if (options.checks !== undefined) {
      await writeF(path.join(hookDir, 'dod-checks.json'), JSON.stringify(options.checks));
    }
    // Same sanitised environment the CLI uses, and for the same reason: run
    // under an inherited GIT_DIR (which is what a pre-commit hook gets from a
    // linked worktree) these commands would `git init` and commit into the
    // REPOSITORY RUNNING THE SUITE instead of this scratch project. It wrote a
    // junk commit onto a real branch here before it was caught.
    const git = (...args: string[]) =>
      new Promise<void>((resolve, reject) => {
        execFile('git', args, { cwd: projectDir, env: gitEnv() }, (error) =>
          error ? reject(error) : resolve(),
        );
      });
    await git('init', '--quiet');
    await writeF(path.join(projectDir, 'work.txt'), 'x');
    if (!options.dirty) {
      await git('add', '-A');
      await git(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '--quiet',
        '--no-verify',
        '-m',
        'clean',
      );
    }
  }

  function runStopHook(payload: object, extraEnv: NodeJS.ProcessEnv = {}): Promise<HookResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [path.join(projectDir, '.claude', 'hooks', 'gate-stop-dod.mjs')],
        { cwd: projectDir, env: { ...gitEnv(), ...extraEnv } },
        (error, stdout, stderr) => {
          const code = error ? ((error as { code?: number }).code ?? 1) : 0;
          resolve({ code, stderr, stdout });
        },
      );
      if (!child.stdin) return reject(new Error('no stdin'));
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  }

  const stop = (active = false) => ({ hook_event_name: 'Stop', stop_hook_active: active });

  afterEach(async () => {
    if (projectDir) await rmP(projectDir, { recursive: true, force: true });
  });

  it('refuses the stop while a named DoD check fails', async () => {
    await setUpProject({
      checks: ['node -e "process.exit(0)"', 'node -e "process.exit(1)"'],
      dirty: true,
    });
    const result = await runStopHook(stop());
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('process.exit(1)');
    expect(result.stderr).toMatch(/diagnosis/i); // pairs with the N-strike rule
  });

  it('lets a passing suite stop', async () => {
    await setUpProject({ checks: ['node -e "process.exit(0)"'], dirty: true });
    expect((await runStopHook(stop())).code).toBe(0);
  });

  it('never blocks twice in a row (stop_hook_active) — the anti-loop rule', async () => {
    await setUpProject({ checks: ['node -e "process.exit(1)"'], dirty: true });
    expect((await runStopHook(stop(true))).code).toBe(0);
  });

  it('a clean tree stops instantly — nothing changed, nothing to gate', async () => {
    await setUpProject({ checks: ['node -e "process.exit(1)"'], dirty: false });
    expect((await runStopHook(stop())).code).toBe(0);
  });

  // The gate decides "is this tree clean?" by asking git. Asked with an
  // inherited GIT_DIR — which is what any process started under a git hook
  // gets — it answers about a DIFFERENT repository, and the session is gated on
  // somebody else's uncommitted work (or waved through despite its own).
  it('judges the tree it is in, not whatever GIT_DIR points at', async () => {
    await setUpProject({ checks: ['node -e "process.exit(1)"'], dirty: false });
    const elsewhere = path.join(tmpdir(), `dod-elsewhere-${process.pid}`);
    await fsp.mkdir(elsewhere, { recursive: true });
    const git = (...args: string[]) =>
      new Promise<void>((resolve, reject) => {
        execFile('git', args, { cwd: elsewhere, env: gitEnv() }, (error) =>
          error ? reject(error) : resolve(),
        );
      });
    try {
      await git('init', '--quiet');
      await fsp.writeFile(path.join(elsewhere, 'dirty.txt'), 'uncommitted\n');
      // this project is clean, so the gate must stop instantly — the failing
      // check must never run, however dirty the repository GIT_DIR names
      const result = await runStopHook(stop(), { GIT_DIR: path.join(elsewhere, '.git') });
      expect(result.code).toBe(0);
    } finally {
      await fsp.rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('fails open: no config, or a corrupt one, must not make the session unquittable', async () => {
    await setUpProject({ dirty: true });
    expect((await runStopHook(stop())).code).toBe(0);
    await setUpProject({ rawConfig: '{not json', dirty: true });
    expect((await runStopHook(stop())).code).toBe(0);
  });
});

describe('inject-rules hook (rules survive compaction and resumes)', () => {
  it('injects the autonomy rules into context on SessionStart', async () => {
    for (const source of ['startup', 'resume', 'compact']) {
      const result = await runHookFull('inject-rules.mjs', {
        hook_event_name: 'SessionStart',
        source,
      });
      expect(result.code, source).toBe(0);
      expect(result.stdout, source).toContain('Tier 0');
      expect(result.stdout, source).toContain('Stop rules');
    }
  });

  it('injected content is stateless — no timestamps, no commit SHAs', async () => {
    const result = await runHookFull('inject-rules.mjs', {
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    expect(result.stdout).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(result.stdout).not.toMatch(/\b[0-9a-f]{40}\b/);
  });

  it('stays silent on unrelated events', async () => {
    const result = await runHookFull('inject-rules.mjs', { hook_event_name: 'Notification' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
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
    expect(commands.some((c) => c.includes('guard-web-boundary.mjs'))).toBe(true);
    expect(commands.some((c) => c.includes('block-no-verify.mjs'))).toBe(true);
    expect(commands.some((c) => c.includes('guard-bash.mjs'))).toBe(true);
  });

  it('registers the DoD stop gate and the rules injector', async () => {
    const settingsPath = path.join(
      repoRoot,
      'templates',
      'agent-os',
      'universal',
      '.claude',
      'settings.json',
    );
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const commandsOf = (event: string) =>
      (settings.hooks[event] ?? []).flatMap((h) => h.hooks.map((x) => x.command));
    expect(commandsOf('Stop').some((c) => c.includes('gate-stop-dod.mjs'))).toBe(true);
    expect(commandsOf('SessionStart').some((c) => c.includes('inject-rules.mjs'))).toBe(true);
  });
});
