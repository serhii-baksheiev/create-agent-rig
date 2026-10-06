// RP-321 — the generated Windows Codex wrapper for a bounded guard must run
// the guard whatever the repository root looks like. A security scanner
// measured natively on Windows that for a non-ASCII root (git's UTF-8 output
// decoded with the console code page) and for a UNC working directory (git
// started through cmd.exe, which refuses a UNC current directory) the wrapper
// never reached the guard and exited with a code other than 2, which Codex
// reads as non-blocking. Each case drives a genuinely forbidden command through
// the REAL guard-bash wrapper and asserts guard-bash's own denial, so a pass
// proves the guard ran and blocked.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { gitEnv as withoutGitLocation } from '../../packages/cli/src/lib/git-env.js';
import { encodedWrapperFor, runWindowsWrapper } from '../helpers/codex-windows-wrapper.js';
import { onlyOnWindows, skipUnless } from '../helpers/env.js';
import { removeFixture } from '../helpers/remove-fixture.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');

// One powershell.exe start per case, the cost RP-162 measured at up to 15 s on
// a loaded hosted Windows runner; the same 60 s ceiling codex-wrapper-bounds
// uses for the same operation.
const CODEX_WRAPPER_ROOTS_CASE_TIMEOUT_MS = 60_000;
// Only a safety net, never a production bound.
const WRAPPER_SAFETY_NET_TIMEOUT_MS = 20_000;

const FORCE_PUSH = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'git push --force origin master' },
};

async function rigAt(root: string): Promise<void> {
  await exec('git', ['init', '-q', root], { env: withoutGitLocation() });
  await cp(path.join(universal, '.claude'), path.join(root, '.claude'), { recursive: true });
}

describe('the Windows Codex wrapper runs the guard from a non-ASCII or UNC root (RP-321)', () => {
  it(
    'blocks a forbidden command when the repository root is non-ASCII',
    { timeout: CODEX_WRAPPER_ROOTS_CASE_TIMEOUT_MS },
    async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
      const scratch = await mkdtemp(path.join(tmpdir(), 'u-тест-é-'));
      try {
        await rigAt(scratch);
        const encoded = await encodedWrapperFor(universal, 'guard-bash.mjs');
        expect(encoded).toBeDefined();
        const result = await runWindowsWrapper(
          encoded!,
          { ...FORCE_PUSH, cwd: scratch },
          scratch,
          {},
          WRAPPER_SAFETY_NET_TIMEOUT_MS,
        );
        expect(result.code, result.stderr).toBe(2);
        expect(result.stderr).toMatch(/BLOCKED.*force-pushing a shared branch/i);
      } finally {
        await removeFixture(scratch);
      }
    },
  );

  it(
    'blocks a forbidden command when the working directory is a UNC path',
    { timeout: CODEX_WRAPPER_ROOTS_CASE_TIMEOUT_MS },
    async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
      const scratch = await mkdtemp(path.join(tmpdir(), 'codex-wrapper-unc-'));
      const driveMatch = /^([A-Za-z]):(\\.*)$/.exec(scratch);
      // 127.0.0.1, not localhost: Node turns a hook path into a file: URL,
      // and the URL standard drops a `localhost` host (file://localhost/C$/x
      // is file:///C$/x), which no real UNC root such as \\wsl$\... hits.
      const unc = driveMatch ? `\\\\127.0.0.1\\${driveMatch[1]}$${driveMatch[2]}` : null;
      skipUnless(
        ctx,
        unc !== null && existsSync(unc),
        `the admin-share UNC form of ${scratch} is not reachable on this host`,
      );
      try {
        await rigAt(scratch);
        const encoded = await encodedWrapperFor(universal, 'guard-bash.mjs');
        expect(encoded).toBeDefined();
        const result = await runWindowsWrapper(
          encoded!,
          { ...FORCE_PUSH, cwd: unc! },
          unc!,
          {},
          WRAPPER_SAFETY_NET_TIMEOUT_MS,
        );
        expect(result.code, result.stderr).toBe(2);
        expect(result.stderr).toMatch(/BLOCKED.*force-pushing a shared branch/i);
      } finally {
        await removeFixture(scratch);
      }
    },
  );
});

// RP-321: a wrapper-internal failure that means the guard never ran must
// block (exit 2), never pass the guard's own exit code through — there is no
// guard exit code in that case, only the wrapper's own failure to reach it.
// Today the bounded script exits 1 (an uncaught node error, or PowerShell's
// own terminating error under `$ErrorActionPreference = 'Stop'`) or passes
// git's own non-zero exit through unchanged, both of which Codex reads as
// non-blocking.
describe('the Windows Codex wrapper blocks when it cannot run the guard (RP-321)', () => {
  it(
    'blocks when the guard file is missing from the repository',
    { timeout: CODEX_WRAPPER_ROOTS_CASE_TIMEOUT_MS },
    async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
      const scratch = await mkdtemp(path.join(tmpdir(), 'codex-wrapper-missing-guard-'));
      try {
        await rigAt(scratch);
        await removeFixture(path.join(scratch, '.claude', 'hooks', 'guard-bash.mjs'));
        const encoded = await encodedWrapperFor(universal, 'guard-bash.mjs');
        expect(encoded).toBeDefined();
        const result = await runWindowsWrapper(
          encoded!,
          { ...FORCE_PUSH, cwd: scratch },
          scratch,
          {},
          WRAPPER_SAFETY_NET_TIMEOUT_MS,
        );
        expect(result.code, result.stderr).toBe(2);
        expect(result.stderr.startsWith('codex wrapper:')).toBe(true);
        expect(result.stderr).toMatch(/codex wrapper: .*guard did not run/i);
      } finally {
        await removeFixture(scratch);
      }
    },
  );

  it(
    'blocks when git rev-parse cannot find a repository',
    { timeout: CODEX_WRAPPER_ROOTS_CASE_TIMEOUT_MS },
    async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
      // Deliberately not `rigAt`: this scratch directory is never `git init`'d,
      // so `git rev-parse --show-toplevel` itself fails before the wrapper
      // can even look for the guard.
      const scratch = await mkdtemp(path.join(tmpdir(), 'codex-wrapper-no-repo-'));
      try {
        const encoded = await encodedWrapperFor(universal, 'guard-bash.mjs');
        expect(encoded).toBeDefined();
        const result = await runWindowsWrapper(
          encoded!,
          { ...FORCE_PUSH, cwd: scratch },
          scratch,
          {},
          WRAPPER_SAFETY_NET_TIMEOUT_MS,
        );
        expect(result.code, result.stderr).toBe(2);
        expect(result.stderr.startsWith('codex wrapper:')).toBe(true);
        expect(result.stderr).toMatch(/codex wrapper: .*guard did not run/i);
      } finally {
        await removeFixture(scratch);
      }
    },
  );

  it(
    'blocks when git is not on PATH',
    { timeout: CODEX_WRAPPER_ROOTS_CASE_TIMEOUT_MS },
    async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
      const scratch = await mkdtemp(path.join(tmpdir(), 'codex-wrapper-no-git-'));
      try {
        await rigAt(scratch);
        const encoded = await encodedWrapperFor(universal, 'guard-bash.mjs');
        expect(encoded).toBeDefined();
        // Only what powershell.exe and node.exe themselves need to start —
        // no git. Windows env lookups are case-insensitive but Node's env
        // object is not, so both spellings carry the same restricted value;
        // `runWindowsWrapper` merges this object OVER `process.env`.
        const restrictedPath = [
          path.dirname(process.execPath),
          path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
          path.join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
          ),
        ].join(';');
        const result = await runWindowsWrapper(
          encoded!,
          { ...FORCE_PUSH, cwd: scratch },
          scratch,
          { PATH: restrictedPath, Path: restrictedPath },
          WRAPPER_SAFETY_NET_TIMEOUT_MS,
        );
        expect(result.code, result.stderr).toBe(2);
        expect(result.stderr.startsWith('codex wrapper:')).toBe(true);
        expect(result.stderr).toMatch(/codex wrapper: .*guard did not run/i);
      } finally {
        await removeFixture(scratch);
      }
    },
  );
});
