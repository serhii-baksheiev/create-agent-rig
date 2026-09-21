import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WINDOWS_JOB_SUPERVISOR } from './windows-job.js';

export type ProviderProcessResult = {
  status: 'ok' | 'failed' | 'timeout' | 'output-limit' | 'cleanup-unconfirmed';
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type ProviderProcessOptions = {
  executable: string;
  args: string[];
  repoDir: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

// Only compiled adapters choose executable/argv. Repository declarations never
// flow into these fields. The caller parses output; it must not log raw output.
export async function runProviderProcess(
  options: ProviderProcessOptions,
): Promise<ProviderProcessResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
  const failed = (): ProviderProcessResult => ({
    status: 'failed',
    stdout: '',
    stderr: '',
    exitCode: null,
  });
  if (
    !path.isAbsolute(options.executable) ||
    !path.isAbsolute(options.repoDir) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 1024 * 1024
  )
    return failed();
  let cwd: string;
  try {
    cwd = await realpath(options.repoDir);
    if (!(await stat(cwd)).isDirectory()) return failed();
  } catch {
    return failed();
  }
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1', UV_NO_PROGRESS: '1', PYTHONUTF8: '1' };
  const allowed = new Set([
    'PATH',
    // uv resolves git through PATHEXT on Windows; without it the job
    // supervisor leaves only `.CPL` and every git-sourced provider fails.
    'PATHEXT',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    'SYSTEMROOT',
    'LANG',
    'LC_ALL',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'XDG_CACHE_HOME',
    'UV_CACHE_DIR',
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toUpperCase())) env[key] = value;
  }
  const isWindows = process.platform === 'win32';
  let powershell: string | undefined;
  if (isWindows) {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (systemRoot === undefined || !path.isAbsolute(systemRoot)) return failed();
    powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // PowerShell 7 compiles this fixed C# source in-process. Prefer the standard
    // installed runtime: Windows PowerShell's external CodeDom compiler stalls
    // on the hosted image before provider creation. Do not install a runtime or
    // search repository-controlled PATH entries for this supervisor.
    const programFiles = process.env.ProgramFiles ?? process.env.PROGRAMFILES;
    if (programFiles !== undefined && path.isAbsolute(programFiles)) {
      const modern = path.join(programFiles, 'PowerShell', '7', 'pwsh.exe');
      try {
        const resolved = await realpath(modern);
        const relative = path.relative(cwd, resolved);
        if (
          (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) &&
          (await stat(resolved)).isFile()
        )
          powershell = resolved;
      } catch {
        // The built-in Windows PowerShell remains the baseline on machines
        // without PowerShell 7; the same operation deadline still applies.
      }
    }
  }
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      if (isWindows)
        env.RIG_WINDOWS_JOB_PAYLOAD = Buffer.from(
          JSON.stringify({ executable: options.executable, cwd, args: options.args }),
        ).toString('base64');
      child = spawn(
        isWindows ? powershell! : options.executable,
        isWindows
          ? ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_JOB_SUPERVISOR]
          : options.args,
        {
          cwd,
          env,
          shell: false,
          windowsHide: true,
          detached: !isWindows,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch {
      resolve(failed());
      return;
    }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let stopping = false;
    let exited = false;
    let closed = false;
    let exitCode: number | null = null;
    const text = (bytes: Buffer): string => {
      let result = bytes.toString('utf8');
      while (Buffer.byteLength(result) > maxOutputBytes) result = result.slice(0, -1);
      return result;
    };
    const finish = (status: ProviderProcessResult['status']) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve({
        status,
        stdout: text(stdout),
        stderr: text(stderr),
        exitCode: status === 'ok' || status === 'failed' ? exitCode : null,
      });
    };
    const groupAlive = (): boolean => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
      }
    };
    const terminate = async (status: 'timeout' | 'output-limit' | 'cleanup-unconfirmed') => {
      if (stopping || settled) return;
      stopping = true;
      const pid = child.pid;
      if (!pid) {
        finish('failed');
        return;
      }
      let confirmed: boolean;
      if (process.platform === 'win32') {
        // The fixed supervisor owns a KILL_ON_JOB_CLOSE job before the provider
        // is resumed. Terminating it closes that handle and kills every member.
        try {
          child.kill();
          confirmed = true;
        } catch {
          confirmed = false;
        }
      } else {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            finish('cleanup-unconfirmed');
            return;
          }
        }
        const deadline = Date.now() + 2000;
        while (groupAlive() && Date.now() < deadline) await delay(20);
        confirmed = !groupAlive();
      }
      if (confirmed && !closed) {
        const deadline = Date.now() + 500;
        while (!closed && Date.now() < deadline) await delay(10);
      }
      finish(confirmed && closed ? status : 'cleanup-unconfirmed');
    };
    const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const old = stream === 'stdout' ? stdout : stderr;
      const next = Buffer.concat([
        old,
        chunk.subarray(0, Math.max(0, maxOutputBytes - old.length)),
      ]);
      if (stream === 'stdout') stdout = next;
      else stderr = next;
      if (old.length + chunk.length > maxOutputBytes) void terminate('output-limit');
    };
    child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.on('error', () => {
      if (!stopping) finish('failed');
    });
    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
    });
    child.on('close', (code) => {
      closed = true;
      exitCode = code;
      if (stopping) return;
      if (process.platform === 'win32' && code === 125) {
        finish('cleanup-unconfirmed');
        return;
      }
      if (process.platform !== 'win32' && groupAlive()) {
        void terminate('cleanup-unconfirmed');
      } else finish(code === 0 ? 'ok' : 'failed');
    });
    const timer = setTimeout(
      () => void terminate(exited ? 'cleanup-unconfirmed' : 'timeout'),
      timeoutMs,
    );
  });
}
