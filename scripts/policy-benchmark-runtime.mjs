import { spawn } from 'node:child_process';
import path from 'node:path';

export const benchmarkTimeouts = (platform) => {
  if (platform !== 'win32') return { childMs: 10_000, workerMs: 60_000, testMs: 60_000 };
  const childMs = 30_000;
  const workerMs = 6 * childMs + 30_000;
  return { childMs, workerMs, testMs: workerMs + 30_000 };
};

const diagnosticBuffer = () => {
  const bytes = Buffer.alloc(4096);
  let used = 0;
  let truncated = false;
  return {
    append(chunk) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const count = Math.min(value.length, bytes.length - used);
      value.copy(bytes, used, 0, count);
      used += count;
      truncated ||= count < value.length;
    },
    text() {
      return bytes.subarray(0, used).toString('utf8') + (truncated ? ' [truncated]' : '');
    },
  };
};

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

const terminateTree = async (pid, env, timeoutMs) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR;
    if (!systemRoot) throw new Error('Windows process cleanup requires SystemRoot');
    await new Promise((resolve, reject) => {
      const killer = spawn(
        path.join(systemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(pid), '/T', '/F'],
        { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const stdout = diagnosticBuffer();
      const stderr = diagnosticBuffer();
      killer.stdout.on('data', (chunk) => stdout.append(chunk));
      killer.stderr.on('data', (chunk) => stderr.append(chunk));
      const timer = setTimeout(() => {
        const error = new Error('Windows process cleanup taskkill timed out');
        reject(new AggregateError([error, ...releaseFailedChild(killer)], error.message));
      }, timeoutMs);
      killer.once('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`Windows process cleanup taskkill failed: ${error.message}`));
      });
      killer.once('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `Windows process cleanup taskkill failed: exit ${code}, signal ${signal}; ` +
                `stdout: ${stdout.text()}; stderr: ${stderr.text()}`,
            ),
          );
      });
    });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
};

const cleanupProcess = async (pid, env, closed, timeoutMs) => {
  let timer;
  try {
    await Promise.race([
      Promise.all([terminateTree(pid, env, timeoutMs), closed]),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('benchmark process cleanup timed out')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const releaseFailedChild = (child) => {
  // Failure remains a failure: killing the direct child does not prove tree cleanup.
  const errors = [];
  for (const release of [
    () => child.kill(),
    () => {
      if (child.connected) child.disconnect();
    },
    () => child.stdin?.destroy(),
    () => child.stdout?.destroy(),
    () => child.stderr?.destroy(),
    () => child.unref(),
  ]) {
    try {
      release();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
};

export const runProcess = (
  file,
  args,
  {
    cwd,
    env,
    input = '',
    timeoutMs = 10_000,
    cleanupTimeoutMs = 5_000,
    maxBytes = 1024 * 1024,
    boundaryPid,
  } = {},
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
    let markClosed;
    const closed = new Promise((resolveClosed) => {
      markClosed = resolveClosed;
    });
    const stop = () => {
      if (termination) return termination;
      if (boundaryPid !== undefined) {
        termination = Promise.resolve();
        // The controller owns this worker's complete process tree. Keep the
        // worker alive to send its failure; runWorker cleans the tree before
        // settling. Killing our own boundary here would destroy that report.
        failure = new Error(
          `benchmark command ${path.basename(file)}: ${failure?.message ?? 'timed out'}`,
        );
        clearTimeout(timer);
        reject(failure);
        return termination;
      }
      return (termination ??= cleanupProcess(child.pid, env, closed, cleanupTimeoutMs).catch(
        (error) => {
          failure = error;
          clearTimeout(timer);
          reject(new AggregateError([error, ...releaseFailedChild(child)], error.message));
        },
      ));
    };
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
      markClosed();
      clearTimeout(timer);
      if (boundaryPid === undefined && process.platform !== 'win32') await stop();
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

export const runWorker = (
  file,
  payload,
  { cwd, env, timeoutMs = 60_000, cleanupTimeoutMs = 5_000, onSpawn } = {},
) =>
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
    const workerStderr = diagnosticBuffer();
    let markClosed;
    const closed = new Promise((resolveClosed) => {
      markClosed = resolveClosed;
    });
    const stop = () =>
      (termination ??= cleanupProcess(child.pid, env, closed, cleanupTimeoutMs).catch((error) => {
        const primary = failure;
        const message = [primary?.message, error.message, `worker stderr: ${workerStderr.text()}`]
          .filter(Boolean)
          .join('; ');
        failure = new AggregateError(
          [primary, error, ...releaseFailedChild(child)].filter(Boolean),
          message,
        );
        clearTimeout(timer);
        reject(failure);
      }));
    const timer = setTimeout(() => {
      failure = new Error('benchmark worker timed out');
      void stop();
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      workerStderr.append(chunk);
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
      markClosed();
      clearTimeout(timer);
      if (!termination) {
        failure ??= new Error(
          'benchmark worker exited before process cleanup could establish containment',
        );
      }
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
