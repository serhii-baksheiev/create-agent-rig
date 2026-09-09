import { spawn } from 'node:child_process';
import path from 'node:path';

export const createBenchmarkEnv = (source, { home, tmp }) => {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|LANG|LC_ALL)$/i.test(key) &&
      typeof value === 'string'
    )
      env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    TMP: tmp,
    TEMP: tmp,
    TMPDIR: tmp,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
};

const terminateTree = async (pid, env) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR;
    if (!systemRoot) throw new Error('Windows process cleanup requires SystemRoot');
    await new Promise((resolve, reject) => {
      const killer = spawn(
        path.join(systemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(pid), '/T', '/F'],
        { env, windowsHide: true, stdio: 'ignore' },
      );
      killer.once('error', reject);
      killer.once('close', resolve);
    });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
};

export const runProcess = (
  file,
  args,
  { cwd, env, input = '', timeoutMs = 10_000, maxBytes = 1024 * 1024, boundaryPid } = {},
) =>
  new Promise((resolve, reject) => {
    if (boundaryPid !== undefined && boundaryPid !== process.pid)
      return reject(new Error('invalid process boundary'));
    const child = spawn(file, args, {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32' && boundaryPid === undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = { stdout: [], stderr: [] };
    let size = 0;
    let timedOut = false;
    let failure;
    let termination;
    const stop = () =>
      (termination ??= terminateTree(boundaryPid ?? child.pid, env).catch((error) => {
        failure = error;
      }));
    const timer = setTimeout(() => {
      timedOut = true;
      void stop();
    }, timeoutMs);
    for (const stream of ['stdout', 'stderr'])
      child[stream].on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          failure = new Error('benchmark process output limit exceeded');
          void stop();
        } else output[stream].push(chunk);
      });
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', async (code) => {
      clearTimeout(timer);
      if (boundaryPid === undefined) await stop();
      else if (termination) await termination;
      if (failure) reject(failure);
      else
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(output.stdout),
          stderr: Buffer.concat(output.stderr),
          timedOut,
        });
    });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') {
        failure = error;
        void stop();
      }
    });
    child.stdin.end(input);
  });

export const runWorker = (file, payload, { cwd, env, timeoutMs = 60_000, onSpawn } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let report;
    let received = false;
    let failure;
    let termination;
    let stderrBytes = 0;
    const stop = () =>
      (termination ??= terminateTree(child.pid, env).catch((error) => {
        failure = error;
      }));
    const timer = setTimeout(() => {
      failure = new Error('benchmark worker timed out');
      void stop();
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) {
        failure = new Error('benchmark worker output limit exceeded');
        void stop();
      }
    });
    child.once('error', (error) => {
      failure = error;
    });
    child.on('message', (message) => {
      if (received) {
        failure = new Error('duplicate benchmark worker result');
        void stop();
        return;
      }
      received = true;
      clearTimeout(timer);
      if (
        message?.type === 'policy-benchmark:result' &&
        message.report &&
        typeof message.report === 'object'
      )
        report = message.report;
      else
        failure = new Error(
          message?.type === 'policy-benchmark:error'
            ? String(message.message)
            : 'invalid benchmark worker result',
        );
      void stop();
    });
    child.once('close', async () => {
      clearTimeout(timer);
      await stop();
      if (failure) reject(failure);
      else if (!received) reject(new Error('benchmark worker exited without a report'));
      else resolve(report);
    });
    child.once('spawn', () => {
      try {
        onSpawn?.(child.pid);
        child.send({ type: 'policy-benchmark:run', payload }, (error) => {
          if (error) {
            failure = error;
            void stop();
          }
        });
      } catch (error) {
        failure = error;
        void stop();
      }
    });
  });
