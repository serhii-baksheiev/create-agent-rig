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
const CODEX_WRAPPER_ROOTS_CASE_TIMEOUT_MS = 60_000;
const WRAPPER_SAFETY_NET_TIMEOUT_MS = 20_000;
const FORCE_PUSH = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'git push --force origin master' },
};

function withConsoleOutputEncoding(encodedCommand: string, codePage: number): string {
  const wrapper = Buffer.from(encodedCommand, 'base64').toString('utf16le');
  return Buffer.from(
    `[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(${codePage}); ${wrapper}`,
    'utf16le',
  ).toString('base64');
}

async function rigAt(root: string): Promise<void> {
  await exec('git', ['init', '-q', root], { env: withoutGitLocation() });
  await cp(path.join(universal, '.claude'), path.join(root, '.claude'), { recursive: true });
}

describe('the Windows Codex wrapper runs the guard from a UNC root (RP-321)', () => {
  it(
    'blocks a forbidden command from an ordinary Windows root',
    { timeout: CODEX_WRAPPER_ROOTS_CASE_TIMEOUT_MS },
    async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
      const scratch = await mkdtemp(path.join(tmpdir(), 'codex-wrapper-normal-'));
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
    'blocks a forbidden command from a UTF-8 Git root when the console output encoding is CP437',
    { timeout: CODEX_WRAPPER_ROOTS_CASE_TIMEOUT_MS },
    async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
      const scratch = await mkdtemp(path.join(tmpdir(), 'cp437-\u0442\u0435\u0441\u0442-\u00e9-'));
      try {
        await rigAt(scratch);
        const encoded = await encodedWrapperFor(universal, 'guard-bash.mjs');
        expect(encoded).toBeDefined();
        const result = await runWindowsWrapper(
          withConsoleOutputEncoding(encoded!, 437),
          { ...FORCE_PUSH, cwd: scratch },
          scratch,
          { PATH: `${path.dirname(process.execPath)};${process.env.PATH ?? ''}` },
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
});

describe('the Windows Codex wrapper blocks an unsuccessful root query (RP-321)', () => {
  it(
    'blocks when git rev-parse cannot find a repository',
    { timeout: CODEX_WRAPPER_ROOTS_CASE_TIMEOUT_MS },
    async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
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
});

describe('the Windows Codex wrapper blocks a missing Git executable (RP-321)', () => {
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
