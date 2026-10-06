// RP-266 follow-up (rounds 2 and 3). These cases drive the REAL generated
// Windows Codex wrapper (decoded from `.codex/hooks.json`, exactly as
// codex.test.ts's content-level RP-266 cases inspect it as text) against
// stand-in guards, proving the wrapper actually bounds and fails closed under
// conditions a content-only check cannot see: a guard that exits moments
// AFTER its bound (the taskkill race code-reviewer and security-scanner both
// reproduced on PR #353 round 1), an override value a human could plausibly
// mistype, a `git.cmd` planted at the repository root to hijack `$repoRoot`
// itself (round 3), and a guard that exits before draining a large stdin
// write (round 3).
//
// Every case here starts a real `powershell.exe` with an `-EncodedCommand`,
// which is the one expensive operation `vitest-timeouts.test.ts`'s RP-162
// comment (in codex.test.ts) already measured at 817 ms–over 15 000 ms on a
// loaded hosted Windows runner for a SINGLE start. RP-266's win32 behavioural
// cases used to live in codex.test.ts asserting `elapsedMs < 7_000` on top of
// an 8 s child-process safety net — exactly the load-sensitive shape RP-162
// already flagged as a case-of-its-own problem, and here every case pays that
// cost, some of them (the taskkill-race loop) several times over. So this
// file exists to give ALL of them the same treatment RP-162 gave the one case
// in codex.test.ts: dropped wall-clock assertions (the exit code and the
// `timed out after <ms> ms` message already prove the bound fired) and a
// named per-case budget, comfortably above the lane's default and at the same
// ceiling RP-162 already established as safe for this exact operation. Round
// 3 adds enough scenarios that one budget would risk exceeding that ceiling
// (RP-162's own worst case was for a SINGLE start), so the newer, heavier
// scenarios get a second case and a second named budget instead of stretching
// the first one further.
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gitEnv as withoutGitLocation } from '../../packages/cli/src/lib/git-env.js';
import { onlyOnWindows, skipUnless } from '../helpers/env.js';
import { removeFixture } from '../helpers/remove-fixture.js';
import { runWindowsWrapper } from '../helpers/codex-windows-wrapper.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const text = (...parts: string[]) => readFile(path.join(...parts), 'utf8');

// Same irreducible cost as codex.test.ts's own WINDOWS_POWERSHELL_CASE_TIMEOUT_MS
// (RP-162: starting powershell.exe with an -EncodedCommand, measured
// 817 ms–over 15 000 ms on a loaded hosted Windows runner) — every scenario
// below pays that cost at least once, and the taskkill-race scenario pays it
// four times in a row (one powershell.exe start per delay). 60_000 is the
// same ceiling RP-162 already established as safe for this exact operation,
// so a genuine hang still fails within a minute rather than riding the
// lane's own default to a vaguer report.
const CODEX_WRAPPER_BOUNDS_CASE_TIMEOUT_MS = 60_000;

// Round 3's three heavier scenarios (the git.cmd hijack repro, the restored
// never-exiting-guard tree-kill proof with its own process-list query, and
// the large-stdin fail-open repro) each start at least one more
// powershell.exe than the scenarios above, on top of the same per-start cost
// RP-162 measured. Same ceiling, a separate case so this file's total worst
// case does not compound past what RP-162 established as safe for one case.
const CODEX_WRAPPER_BOUNDS_SECURITY_CASE_TIMEOUT_MS = 60_000;

// Never a production bound — only a safety net so a wrapper that still fails
// to bound itself does not hold this test open for the full case budget.
const WRAPPER_SAFETY_NET_TIMEOUT_MS = 20_000;

// One case, several scenarios run in sequence inside it — not `it.each`:
// this file's ENTIRE per-case budget is this one usage (mirroring RP-162's
// "the only case in that file with a budget of its own" pattern, pinned for
// this file in vitest-timeouts.test.ts), and every scenario here starts its
// own real powershell.exe, so splitting them into separate `it()`s would
// each need the same generous budget — multiplying, not sharing, the cost
// RP-162 already measured.
const PROMPT_GUARD_SOURCE = [
  "import { readFileSync } from 'node:fs';",
  'try { readFileSync(0); } catch {}',
  "process.stdout.write('RP266-PROBE-OK\\n');",
  'process.exit(7);',
].join('\n');

describe('the Windows Codex wrapper bounds its timeout stages without failing open (RP-266 follow-up)', () => {
  it(
    'always fails closed under a lowered bound, and never throws on a malformed override (RP-266 follow-up)',
    { timeout: CODEX_WRAPPER_BOUNDS_CASE_TIMEOUT_MS },
    async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);

      const scratch = await mkdtemp(path.join(tmpdir(), 'codex-wrapper-bounds-'));
      try {
        await exec('git', ['init', '-q', scratch], { env: withoutGitLocation() });
        await cp(path.join(universal, '.claude'), path.join(scratch, '.claude'), {
          recursive: true,
        });

        const config = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
          hooks: {
            PreToolUse: Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>;
          };
        };
        const encoded = config.hooks.PreToolUse.flatMap((group) => group.hooks)
          .find((hook) => hook.command.includes('guard-rulebook.mjs'))
          ?.commandWindows?.match(
            /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
          )?.[1];
        expect(encoded).toBeDefined();

        const guardPath = path.join(scratch, '.claude', 'hooks', 'guard-rulebook.mjs');
        const payload = {
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          tool_input: { file_path: path.join(scratch, '.claude', 'rules', 'autonomy.md') },
          cwd: scratch,
        };

        // PR #353 round 1: code-reviewer and security-scanner reproduced
        // 5/6 and 6/8 with a guard that exits ~0.1–0.6 s AFTER the bound —
        // late enough that by the time the wrapper's `taskkill` runs, the
        // process (or a tree member) has already vanished, and in PS 5.1
        // ANY stderr line from taskkill under `$ErrorActionPreference =
        // 'Stop'` is a terminating error the wrapper never catches, so it
        // exits 1 — which Codex treats as non-blocking. Exit 2 must be
        // unconditional across every one of these delays, not just the
        // guards that overrun by a wide, race-free margin.
        for (const delayMs of [1000, 1100, 1200, 1400]) {
          await writeFile(
            guardPath,
            `const started = Date.now(); while (Date.now() - started < ${delayMs}) {} process.exit(2);\n`,
          );
          const raced = await runWindowsWrapper(
            encoded!,
            payload,
            scratch,
            { CLAUDE_PROJECT_DIR: '', RIG_CODEX_WRAPPER_TIMEOUT_MS: '1000' },
            WRAPPER_SAFETY_NET_TIMEOUT_MS,
          );
          expect(raced.code, `guard exits at ${delayMs} ms: ${raced.stderr}`).toBe(2);
          expect(raced.stderr, `guard exits at ${delayMs} ms`).toMatch(
            /codex wrapper: .*timed out after 1000 ms/i,
          );
        }

        // A lowered override must still let a promptly-exiting guard's own
        // exit code and stdout through untouched.
        await writeFile(guardPath, PROMPT_GUARD_SOURCE);
        const passthrough = await runWindowsWrapper(
          encoded!,
          payload,
          scratch,
          { CLAUDE_PROJECT_DIR: '', RIG_CODEX_WRAPPER_TIMEOUT_MS: '2000' },
          WRAPPER_SAFETY_NET_TIMEOUT_MS,
        );
        expect(passthrough.code, passthrough.stderr).toBe(7);
        expect(passthrough.stdout).toContain('RP266-PROBE-OK');

        // 99 999 999 999 is eleven digits — a plausible fat-fingered zero too
        // many — and must be rejected by the wrapper's own validity shape
        // (`^[0-9]{1,9}$`, pinned in content in codex.test.ts), falling back
        // to the real production defaults: never throw, never exit 1 the way
        // an unhandled `[int]` cast overflow would.
        await writeFile(guardPath, PROMPT_GUARD_SOURCE);
        const invalidOverride = await runWindowsWrapper(
          encoded!,
          payload,
          scratch,
          { CLAUDE_PROJECT_DIR: '', RIG_CODEX_WRAPPER_TIMEOUT_MS: '99999999999' },
          WRAPPER_SAFETY_NET_TIMEOUT_MS,
        );
        expect(invalidOverride.code, invalidOverride.stderr).toBe(7);
        expect(invalidOverride.stdout).toContain('RP266-PROBE-OK');
      } finally {
        await removeFixture(scratch);
      }
    },
  );
});

describe('the Windows Codex wrapper resists a hijacked $repoRoot and a faulted stdin copy (RP-266 round 3)', () => {
  it(
    'never runs a planted guard.cmd-fed fake guard, never leaks a killed guard process, and never treats a guard that exits early on a large payload as a wrapper failure (RP-266 round 3)',
    { timeout: CODEX_WRAPPER_BOUNDS_SECURITY_CASE_TIMEOUT_MS },
    async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);

      // --- (1) git.cmd $repoRoot hijack, reproduced against the REAL
      // guard-bash.mjs with a genuinely forbidden payload -------------------
      //
      // cmd.exe resolves a bare command name in the CURRENT DIRECTORY first,
      // before PATH, unless NoDefaultCurrentDirectoryInExePath is set. A
      // text `git.cmd` at the wrapper's own cwd (the repository root, in an
      // ordinary session) intercepts `git rev-parse --show-toplevel`,
      // replacing $repoRoot — and with it, `$hookPath`, and with it, the
      // guard script node actually runs. Measured on PR #353 round 2: exit 0
      // on `git push --force origin master` through the generated
      // guard-bash wrapper, while an unhijacked run exits 2.
      const attackerRoot = await mkdtemp(path.join(tmpdir(), 'codex-wrapper-attacker-'));
      const scratch = await mkdtemp(path.join(tmpdir(), 'codex-wrapper-hijack-'));
      try {
        await mkdir(path.join(attackerRoot, '.claude', 'hooks'), { recursive: true });
        // The fake guard an attacker would plant: always allows.
        await writeFile(
          path.join(attackerRoot, '.claude', 'hooks', 'guard-bash.mjs'),
          'process.exit(0);\n',
        );

        await exec('git', ['init', '-q', scratch], { env: withoutGitLocation() });
        await cp(path.join(universal, '.claude'), path.join(scratch, '.claude'), {
          recursive: true,
        });
        // cmd.exe checks every PATHEXT extension in the current directory
        // before it ever reaches PATH, so a plain batch file answers before
        // the real git.exe is even considered.
        await writeFile(path.join(scratch, 'git.cmd'), `@echo off\r\necho ${attackerRoot}\r\n`);

        const bashConfig = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
          hooks: {
            PreToolUse: Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>;
          };
        };
        const bashEncoded = bashConfig.hooks.PreToolUse.flatMap((group) => group.hooks)
          .find((hook) => hook.command.includes('guard-bash.mjs'))
          ?.commandWindows?.match(
            /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
          )?.[1];
        expect(bashEncoded).toBeDefined();

        const hijack = await runWindowsWrapper(
          bashEncoded!,
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'git push --force origin master' },
            cwd: scratch,
          },
          scratch,
          {},
          WRAPPER_SAFETY_NET_TIMEOUT_MS,
        );
        expect(hijack.code, hijack.stderr).toBe(2);
        expect(hijack.stderr).toMatch(/BLOCKED.*force-pushing a shared branch/i);
      } finally {
        await removeFixture(attackerRoot);
        await removeFixture(scratch);
      }

      // --- (3) restored never-exiting guard: proves the tree kill under a
      // lowered override, and leaves no leftover process behind -----------
      const hangScratch = await mkdtemp(path.join(tmpdir(), 'codex-wrapper-hang-'));
      try {
        await exec('git', ['init', '-q', hangScratch], { env: withoutGitLocation() });
        await cp(path.join(universal, '.claude'), path.join(hangScratch, '.claude'), {
          recursive: true,
        });

        const rulebookConfig = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
          hooks: {
            PreToolUse: Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>;
          };
        };
        const rulebookEncoded = rulebookConfig.hooks.PreToolUse.flatMap((group) => group.hooks)
          .find((hook) => hook.command.includes('guard-rulebook.mjs'))
          ?.commandWindows?.match(
            /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
          )?.[1];
        expect(rulebookEncoded).toBeDefined();

        const guardPath = path.join(hangScratch, '.claude', 'hooks', 'guard-rulebook.mjs');
        // Never reads stdin and never exits on its own — the interval never
        // elapses, so only the wrapper's own tree kill can end this process.
        await writeFile(guardPath, 'setInterval(() => {}, 1 << 30);\n');

        const hung = await runWindowsWrapper(
          rulebookEncoded!,
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Write',
            tool_input: { file_path: path.join(hangScratch, '.claude', 'rules', 'autonomy.md') },
            cwd: hangScratch,
          },
          hangScratch,
          { CLAUDE_PROJECT_DIR: '', RIG_CODEX_WRAPPER_TIMEOUT_MS: '2000' },
          WRAPPER_SAFETY_NET_TIMEOUT_MS,
        );
        expect(hung.code, hung.stderr).toBe(2);
        // RP-266 round 3 code blocker: the message must report the
        // CONFIGURED bound (the lowered override in effect), not whatever
        // was left of the shared deadline after the stdin copy — that
        // leftover is a few ms below 2000, never exactly 2000.
        expect(hung.stderr).toMatch(/codex wrapper: guard timed out after 2000 ms/i);

        const leftover = await findLeftoverNodeProcesses(guardPath);
        expect(leftover, `leftover node.exe process id(s) for ${guardPath}: ${leftover}`).toBe('');
      } finally {
        await removeFixture(hangScratch);
      }

      // --- (5) large stdin, guard exits before draining it -----------------
      //
      // If the guard exits before the parent finishes writing its stdin,
      // the pipe closes on the child's end and `$copyTask.Wait(...)` faults.
      // Calling `.Wait` on a faulted Task re-throws synchronously, and under
      // `$ErrorActionPreference = 'Stop'` that is an unhandled terminating
      // error — the wrapper exits 1 instead of reporting the guard's own
      // exit code, even though the guard already rendered a clean verdict.
      const largeScratch = await mkdtemp(path.join(tmpdir(), 'codex-wrapper-largestdin-'));
      try {
        await exec('git', ['init', '-q', largeScratch], { env: withoutGitLocation() });
        await cp(path.join(universal, '.claude'), path.join(largeScratch, '.claude'), {
          recursive: true,
        });

        const rulebookConfig = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
          hooks: {
            PreToolUse: Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>;
          };
        };
        const rulebookEncoded = rulebookConfig.hooks.PreToolUse.flatMap((group) => group.hooks)
          .find((hook) => hook.command.includes('guard-rulebook.mjs'))
          ?.commandWindows?.match(
            /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
          )?.[1];
        expect(rulebookEncoded).toBeDefined();

        const guardPath = path.join(largeScratch, '.claude', 'hooks', 'guard-rulebook.mjs');
        // Exits immediately, WITHOUT reading stdin at all — this is the
        // guard's own genuine verdict (2, same code the real guard returns
        // when it blocks), and the wrapper must report exactly that, not an
        // exit 1 the broken-pipe exception would otherwise produce.
        await writeFile(guardPath, 'process.exit(2);\n');

        const oversized = await runWindowsWrapper(
          rulebookEncoded!,
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Write',
            tool_input: {
              file_path: path.join(largeScratch, '.claude', 'rules', 'autonomy.md'),
              // Comfortably past a pipe's internal buffer, so the write
              // cannot complete atomically once the reader has gone away.
              filler: 'x'.repeat(500 * 1024),
            },
            cwd: largeScratch,
          },
          largeScratch,
          { CLAUDE_PROJECT_DIR: '' },
          WRAPPER_SAFETY_NET_TIMEOUT_MS,
        );
        expect(oversized.code, oversized.stderr).toBe(2);
        // RP-321: the wrapper's own failures also exit 2 now, so the 2 above
        // is the guard's only if the wrapper reported nothing of its own.
        expect(oversized.stderr).not.toContain('codex wrapper:');
      } finally {
        await removeFixture(largeScratch);
      }
    },
  );
});

/**
 * Process ids of any `node.exe` whose command line contains `marker` (here,
 * a guard's own path inside a unique scratch directory) — queried through
 * WMI/CIM rather than `tasklist`, which does not expose the full command
 * line. An empty string means no leftover process was found.
 */
function findLeftoverNodeProcesses(marker: string): Promise<string> {
  const escaped = marker.replace(/'/g, "''");
  const psCommand =
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
    `Where-Object { $_.CommandLine -like '*${escaped}*' } | ` +
    'Select-Object -ExpandProperty ProcessId';
  const timeout = WRAPPER_SAFETY_NET_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psCommand],
      { timeout },
      (error, stdout) => {
        if (error && !stdout) return reject(error);
        resolve(stdout.toString().trim());
      },
    );
  });
}
