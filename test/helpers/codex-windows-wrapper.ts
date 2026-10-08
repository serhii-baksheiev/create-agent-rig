import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function runWindowsWrapper(
  encodedCommand: string,
  input: Record<string, unknown>,
  cwd: string,
  env: Record<string, string>,
  timeout?: number,
): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
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
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

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
