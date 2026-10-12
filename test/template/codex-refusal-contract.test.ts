// RP-498. Codex 0.162.1 starts commandWindows through an outer
// `powershell.exe -NoProfile -Command <commandWindows>` host. That outer
// PowerShell normalises an inner `exit 2` to exit 1, which Codex reads as a
// non-blocking hook failure. These tests exercise that outer invocation, not
// the direct `-EncodedCommand` fixture used by the wrapper-bound tests.
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gitEnv as withoutGitLocation } from '../../packages/cli/src/lib/git-env.js';
import { onlyOnWindows, skipUnless } from '../helpers/env.js';
import { removeFixture } from '../helpers/remove-fixture.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');

// A single case owns the expensive native PowerShell starts below. The
// generated wrapper itself has a 35 s guard deadline; this remains a hard
// ceiling for the whole behavioural contract rather than relying on the
// template lane's 15 s default while the Windows host is busy.
const CODEX_REFUSAL_CONTRACT_CASE_TIMEOUT_MS = 60_000;
const OUTER_POWERSHELL_TIMEOUT_MS = 45_000;

interface HookEntry {
  command: string;
  commandWindows?: string;
}

interface Exit {
  code: number;
  stdout: string;
  stderr: string;
}

async function commandWindowsFor(hookFile: string): Promise<string> {
  const config = JSON.parse(
    await readFile(path.join(universal, '.codex', 'hooks.json'), 'utf8'),
  ) as {
    hooks: { PreToolUse: Array<{ hooks: HookEntry[] }> };
  };
  const command = config.hooks.PreToolUse.flatMap((group) => group.hooks).find((hook) =>
    hook.command.includes(hookFile),
  )?.commandWindows;
  expect(command, `${hookFile} has a PreToolUse commandWindows entry`).toBeDefined();
  return command!;
}

/**
 * Codex's Windows hook host receives the complete commandWindows string as a
 * `-Command` argument. Running the inner encoded command directly would miss
 * the exit-code translation that caused RP-498.
 */
function runAsCodexWindowsHost(
  commandWindows: string,
  payload: object,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', commandWindows],
      { cwd, env, timeout: OUTER_POWERSHELL_TIMEOUT_MS },
      (error, stdout, stderr) =>
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout,
          stderr,
        }),
    );
    if (!child.stdin) return reject(new Error('no stdin'));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

function preToolDeny(stdout: string): {
  hookSpecificOutput?: {
    hookEventName?: unknown;
    permissionDecision?: unknown;
    permissionDecisionReason?: unknown;
  };
} {
  const line = stdout
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .reverse()
    .find((candidate) => candidate.startsWith('{'));
  expect(line, `expected a structured Codex refusal on stdout, received: ${stdout}`).toBeDefined();
  return JSON.parse(line!) as {
    hookSpecificOutput?: {
      hookEventName?: unknown;
      permissionDecision?: unknown;
      permissionDecisionReason?: unknown;
    };
  };
}

function expectPreToolDeny(result: Exit): void {
  expect(result.code, result.stderr).toBe(0);
  const parsed = preToolDeny(result.stdout);
  expect(parsed.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
  expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
  expect(parsed.hookSpecificOutput?.permissionDecisionReason).toEqual(expect.any(String));
  expect(parsed.hookSpecificOutput?.permissionDecisionReason).not.toBe('');
}

const write = (filePath: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: filePath, content: 'SAFE_CONTROL=1\n' },
});

const bash = (command: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
});

describe('Windows Codex PreToolUse refusals retain their meaning through the real outer PowerShell host (RP-498)', () => {
  it(
    'returns exit 0 plus a structured deny for guards and bounded wrapper failures, while safe controls and lifecycle hooks retain their contracts',
    { timeout: CODEX_REFUSAL_CONTRACT_CASE_TIMEOUT_MS },
    async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);

      const scratch = await mkdtemp(path.join(tmpdir(), 'codex-refusal-contract-'));
      const home = await mkdtemp(path.join(tmpdir(), 'codex-refusal-home-'));
      try {
        await exec('git', ['init', '-q', scratch], { env: withoutGitLocation() });
        await cp(path.join(universal, '.claude'), path.join(scratch, '.claude'), {
          recursive: true,
        });

        const isolatedEnv = {
          ...withoutGitLocation(process.env),
          HOME: home,
          APPDATA: home,
          LOCALAPPDATA: home,
          CLAUDE_PROJECT_DIR: '',
        };

        const fixtures: Array<{
          hook: string;
          allowed: object;
          denied: object;
        }> = [
          {
            hook: 'guard-secret-file.mjs',
            allowed: write('notes/rp498-safe.md'),
            denied: write('.env.rp498'),
          },
          {
            hook: 'guard-bash.mjs',
            allowed: bash('git status'),
            denied: bash('git push --force origin master'),
          },
          {
            hook: 'block-no-verify.mjs',
            allowed: bash('git commit -m "ordinary commit"'),
            denied: bash('git commit --no-verify -m "bypass"'),
          },
        ];

        for (const fixture of fixtures) {
          const commandWindows = await commandWindowsFor(fixture.hook);
          const allowed = await runAsCodexWindowsHost(
            commandWindows,
            fixture.allowed,
            scratch,
            isolatedEnv,
          );
          expect(allowed.code, `${fixture.hook} safe control: ${allowed.stderr}`).toBe(0);
          expect(allowed.stdout).not.toContain('"permissionDecision":"deny"');

          const denied = await runAsCodexWindowsHost(
            commandWindows,
            fixture.denied,
            scratch,
            isolatedEnv,
          );
          expectPreToolDeny(denied);
        }

        // Rulebook denial needs a real scoped unattended record. This follows
        // the installed helper's own naming algorithm, so the outer wrapper,
        // not a hand-written flag path, decides the fixture.
        const { unattendedFlags } = (await import(
          pathToFileURL(path.join(scratch, '.claude', 'scripts', 'unattended-flag.mjs')).href
        )) as { unattendedFlags: (env: NodeJS.ProcessEnv) => string[] };
        const flag = unattendedFlags(isolatedEnv).find((candidate) =>
          path.resolve(candidate).toLowerCase().startsWith(path.resolve(home).toLowerCase()),
        );
        expect(flag, 'an isolated HOME-scoped unattended flag').toBeDefined();
        await mkdir(path.dirname(flag!), { recursive: true });
        await writeFile(
          flag!,
          JSON.stringify({
            item: 'RP-498',
            runDir: path.join(home, 'run'),
            allow: [],
            root: scratch,
          }),
        );
        const rulebookCommand = await commandWindowsFor('guard-rulebook.mjs');
        const rulebookAllowed = await runAsCodexWindowsHost(
          rulebookCommand,
          write('README.md'),
          scratch,
          isolatedEnv,
        );
        expect(rulebookAllowed.code, rulebookAllowed.stderr).toBe(0);
        const rulebookDenied = await runAsCodexWindowsHost(
          rulebookCommand,
          write('.claude/rules/autonomy.md'),
          scratch,
          isolatedEnv,
        );
        expectPreToolDeny(rulebookDenied);

        // The wrapper's own bounded-failure path must use the same Codex
        // refusal protocol: a guard that exceeds its configured deadline is
        // not an allow simply because the outer PowerShell maps exit 2 to 1.
        const bashGuard = path.join(scratch, '.claude', 'hooks', 'guard-bash.mjs');
        await writeFile(bashGuard, 'setInterval(() => {}, 1 << 30);\n');
        const timedOut = await runAsCodexWindowsHost(
          await commandWindowsFor('guard-bash.mjs'),
          bash('git status'),
          scratch,
          { ...isolatedEnv, RIG_CODEX_WRAPPER_TIMEOUT_MS: '1000' },
        );
        expectPreToolDeny(timedOut);

        // A missing PreToolUse guard is another wrapper failure: the adapter
        // must refuse it through the same machine-readable contract.
        await rm(path.join(scratch, '.claude', 'hooks', 'guard-secret-file.mjs'));
        const missing = await runAsCodexWindowsHost(
          await commandWindowsFor('guard-secret-file.mjs'),
          write('.env.missing-guard'),
          scratch,
          isolatedEnv,
        );
        expectPreToolDeny(missing);

        // Lifecycle hooks are informational/recording contracts, never
        // permission decisions. The PreToolUse translation must not bleed
        // into their separately generated Windows commands.
        const config = JSON.parse(
          await readFile(path.join(universal, '.codex', 'hooks.json'), 'utf8'),
        ) as { hooks: Record<string, Array<{ hooks: HookEntry[] }>> };
        for (const event of ['SessionStart', 'Stop', 'SubagentStart', 'SubagentStop']) {
          for (const entry of config.hooks[event]?.flatMap((group) => group.hooks) ?? []) {
            const encoded = entry.commandWindows?.match(
              /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
            )?.[1];
            expect(encoded, `${event} has an encoded Windows command`).toBeDefined();
            const script = Buffer.from(encoded!, 'base64').toString('utf16le');
            expect(script, `${event} must not become a PreToolUse decision`).not.toMatch(
              /hookSpecificOutput|permissionDecision/,
            );
            expect(script, `${event} still forwards its child exit code`).toContain(
              'exit $child.ExitCode',
            );
          }
        }
      } finally {
        await removeFixture(scratch);
        await removeFixture(home);
      }
    },
  );
});

describe('Windows Codex lifecycle wrappers preserve their independent command contract (RP-498)', () => {
  it(
    'runs SessionStart and an inert Stop hook through the outer PowerShell host',
    { timeout: CODEX_REFUSAL_CONTRACT_CASE_TIMEOUT_MS },
    async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);

      const scratch = await mkdtemp(path.join(tmpdir(), 'codex-lifecycle-contract-'));
      try {
        await exec('git', ['init', '-q', scratch], { env: withoutGitLocation() });
        await cp(path.join(universal, '.claude'), path.join(scratch, '.claude'), {
          recursive: true,
        });
        const config = JSON.parse(
          await readFile(path.join(universal, '.codex', 'hooks.json'), 'utf8'),
        ) as { hooks: Record<string, Array<{ hooks: HookEntry[] }>> };
        const commandFor = (event: 'SessionStart' | 'Stop'): string => {
          const command = config.hooks[event]?.[0]?.hooks[0]?.commandWindows;
          expect(command, `${event} has a generated Windows command`).toBeDefined();
          return command!;
        };
        const env = { ...withoutGitLocation(process.env), CLAUDE_PROJECT_DIR: '' };

        const started = await runAsCodexWindowsHost(
          commandFor('SessionStart'),
          { hook_event_name: 'SessionStart', cwd: scratch },
          scratch,
          env,
        );
        expect(started.code, started.stderr).toBe(0);
        expect(started.stdout).toContain('hookSpecificOutput');
        expect(started.stdout).toContain('SessionStart');
        expect(`${started.stdout}\n${started.stderr}`).not.toMatch(
          /Cannot find module|node:internal|undefined/i,
        );

        const stopped = await runAsCodexWindowsHost(
          commandFor('Stop'),
          { hook_event_name: 'Stop', cwd: scratch },
          scratch,
          env,
        );
        expect(stopped.code, stopped.stderr).toBe(0);
        expect(`${stopped.stdout}\n${stopped.stderr}`).not.toMatch(
          /Cannot find module|node:internal|undefined/i,
        );
      } finally {
        await removeFixture(scratch);
      }
    },
  );
});
