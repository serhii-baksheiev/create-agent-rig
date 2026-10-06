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
      const unc = driveMatch ? `\\\\localhost\\${driveMatch[1]}$${driveMatch[2]}` : null;
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
