import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { onlyOnWindows, skipUnless } from '../helpers/env.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runner = path.join(repoRoot, 'scripts', 'run-without-git-location.mjs');

// The list is imported from the ONE module that owns it, never restated here:
// a test that hard-codes the names is a third copy of the list.
const { GIT_LOCATION_VARS } = (await import(
  pathToFileURL(path.join(repoRoot, '.claude/scripts/git-env.mjs')).href
)) as { GIT_LOCATION_VARS: readonly string[] };

// The environment a git hook hands to pre-commit — a linked worktree exports
// GIT_DIR/GIT_WORK_TREE, `commit -a` exports GIT_INDEX_FILE. Test fixtures that
// spawn git under these act on the SHARED repository (journal/2026-08.md).
const hookEnv = {
  ...process.env,
  GIT_DIR: '/nowhere/.git',
  GIT_INDEX_FILE: '/nowhere/index',
  GIT_WORK_TREE: '/nowhere',
};

const run = (args: string[], env: NodeJS.ProcessEnv = hookEnv) =>
  spawnSync(process.execPath, [runner, ...args], { env, encoding: 'utf8' });

describe('scripts/run-without-git-location.mjs', () => {
  it('runs the command with every git location variable removed', () => {
    const script =
      `const vars = ${JSON.stringify([...GIT_LOCATION_VARS])};` +
      'const leaked = vars.filter((k) => k in process.env);' +
      'if (leaked.length) { console.error("leaked: " + leaked.join(",")); process.exit(1); }' +
      'process.exit(0);';
    const result = run([process.execPath, '-e', script]);
    expect(result.status, result.stderr).toBe(0);
  });

  it("propagates the child's exit code", () => {
    const result = run([process.execPath, '-e', 'process.exit(3)']);
    expect(result.status).toBe(3);
  });

  // The shim branch exists for pnpm.cmd on Windows and is measured only there:
  // a `.cmd` on PATH runs, and an argument the shell would re-parse is refused.
  it('runs a .cmd shim on Windows', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const dir = await mkdtemp(path.join(tmpdir(), 'shim-'));
    await writeFile(path.join(dir, 'hello.cmd'), '@echo off\r\nexit /b 0\r\n');
    const result = run(['hello'], { ...hookEnv, PATH: `${dir};${process.env.PATH ?? ''}` });
    expect(result.status, result.stderr).toBe(0);
  });

  it('refuses an argument a shell would re-parse when the command is a shim', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    {
      const dir = await mkdtemp(path.join(tmpdir(), 'shim-'));
      await writeFile(path.join(dir, 'hello.cmd'), '@echo off\r\nexit /b 0\r\n');
      const result = run(['hello', 'a b'], {
        ...hookEnv,
        PATH: `${dir};${process.env.PATH ?? ''}`,
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/no quoting is attempted/);
    }
  });

  it('never uses a shell for a command that is an executable, on any platform', async () => {
    const { resolvesToShim } = (await import(pathToFileURL(runner).href)) as {
      resolvesToShim: (command: string) => boolean;
    };
    expect(resolvesToShim(process.execPath)).toBe(false);
  });

  it('refuses with no command', () => {
    const result = run([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/usage/i);
  });
});

describe('.husky/pre-commit', () => {
  it('runs the checks through the runner, after the staged secret sweep', async () => {
    const lines = (await readFile(path.join(repoRoot, '.husky', 'pre-commit'), 'utf8'))
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('#'));
    const sweep = lines.findIndex((line) => line.includes('validate-no-secrets.mjs --staged'));
    expect(sweep, 'the staged secret sweep must still run').toBeGreaterThanOrEqual(0);

    const runnerLines = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.includes('scripts/run-without-git-location.mjs'));
    expect(runnerLines.length, 'the checks must go through the runner').toBeGreaterThan(0);

    // The sweep reads GIT_INDEX_FILE and must keep it, so it runs BEFORE the runner.
    for (const { index } of runnerLines) expect(index).toBeGreaterThan(sweep);

    // Either one runner invocation naming all three, or three chained with &&.
    const joined = runnerLines.map(({ line }) => line).join('\n');
    expect(joined).toMatch(/pnpm lint/);
    expect(joined).toMatch(/typecheck/);
    expect(joined).toMatch(/test:unit/);
    // and none of the three runs outside the runner
    for (const { line } of lines
      .map((line) => ({ line }))
      .filter(({ line }) => /pnpm (lint|typecheck|test:unit)/.test(line))) {
      expect(line).toContain('scripts/run-without-git-location.mjs');
    }
  });
});
