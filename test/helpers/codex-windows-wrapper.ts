import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Drive the inner generated Windows wrapper (`powershell.exe -EncodedCommand`)
 * directly. This preserves tests for child exit-code passthrough (for example
 * a probe's deliberate exit 7); Codex itself starts `commandWindows` through
 * an outer `powershell.exe -NoProfile -Command`, which has a distinct refusal
 * contract covered by `runWindowsCodexHost` below.
 */
export function runWindowsWrapper(
  encodedCommand: string,
  input: Record<string, unknown>,
  cwd: string,
  env: Record<string, string>,
  timeout?: number,
): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    // Never let an ambient value from the test host's own environment stand
    // in for the wrapper's own fix — RP-266 round 3's security case relies
    // on this var being genuinely absent unless the generated script itself
    // sets it.
    const merged: NodeJS.ProcessEnv = { ...process.env, ...env };
    delete merged.NoDefaultCurrentDirectoryInExePath;
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
      { cwd, env: merged, timeout },
      (error, stdout, stderr) =>
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
    if (!child.stdin) return reject(new Error('no stdin'));
    // The large-stdin case has the wrapper exit before it reads all of its
    // own input, so this write can fail with EOF/EPIPE. That is the scenario
    // under test, not a harness failure: the verdict is the exit code the
    // callback resolves with.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

/**
 * Drive a PreToolUse `commandWindows` string through the outer PowerShell host
 * Codex 0.162.1 actually uses. Unlike the direct helper above, this is the
 * observable harness boundary: refusals must be structured JSON with exit 0,
 * because outer PowerShell maps an inner exit 2 to its non-blocking exit 1.
 */
export function runWindowsCodexHost(
  commandWindows: string,
  input: Record<string, unknown>,
  cwd: string,
  env: Record<string, string>,
  timeout?: number,
): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', commandWindows],
      { cwd, env: { ...process.env, ...env }, timeout },
      (error, stdout, stderr) =>
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout,
          stderr,
        }),
    );
    if (!child.stdin) return reject(new Error('no stdin'));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

/** The last JSON record on stdout, if it is a Codex PreToolUse deny envelope. */
export function preToolUseDeny(stdout: string):
  | {
      hookSpecificOutput?: {
        hookEventName?: unknown;
        permissionDecision?: unknown;
        permissionDecisionReason?: unknown;
      };
    }
  | undefined {
  for (const line of stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .reverse()) {
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as {
        hookSpecificOutput?: {
          hookEventName?: unknown;
          permissionDecision?: unknown;
          permissionDecisionReason?: unknown;
        };
      };
      if (parsed.hookSpecificOutput?.permissionDecision === 'deny') return parsed;
    } catch {
      // A non-JSON stdout line is not a hook decision; keep looking.
    }
  }
  return undefined;
}

/**
 * The `-EncodedCommand` payload of the generated Windows wrapper for one
 * PreToolUse hook, read from the committed `.codex/hooks.json` under
 * `universal`. `undefined` when no entry names `hookFile`.
 */
export async function encodedWrapperFor(
  universal: string,
  hookFile: string,
): Promise<string | undefined> {
  const config = JSON.parse(
    await readFile(path.join(universal, '.codex', 'hooks.json'), 'utf8'),
  ) as {
    hooks: {
      PreToolUse: Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>;
    };
  };
  return config.hooks.PreToolUse.flatMap((group) => group.hooks)
    .find((hook) => hook.command.includes(hookFile))
    ?.commandWindows?.match(
      /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
    )?.[1];
}

/** The complete generated PreToolUse command Windows Codex gives to its host. */
export async function commandWindowsFor(
  universal: string,
  hookFile: string,
): Promise<string | undefined> {
  const config = JSON.parse(
    await readFile(path.join(universal, '.codex', 'hooks.json'), 'utf8'),
  ) as {
    hooks: {
      PreToolUse: Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>;
    };
  };
  return config.hooks.PreToolUse.flatMap((group) => group.hooks).find((hook) =>
    hook.command.includes(hookFile),
  )?.commandWindows;
}
