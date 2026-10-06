import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Drive a generated Windows Codex wrapper (`powershell.exe -EncodedCommand`)
 * the way Codex does: the hook payload on stdin, the exit code as the verdict.
 * Shared by the win32 wrapper cases in `test/template/codex-wrapper-*.test.ts`.
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
