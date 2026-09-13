import { spawn } from 'node:child_process';
import path from 'node:path';

export const benchmarkTimeouts = (platform) => {
  if (platform !== 'win32') return { childMs: 10_000, workerMs: 60_000, testMs: 60_000 };
  const childMs = 30_000;
  const workerMs = 6 * childMs + 30_000;
  return { childMs, workerMs, testMs: workerMs + 30_000 };
};

// The durations of the commands one worker ran, so a timeout can say whether
// every command was slow or only the one that hit the deadline. It keeps a
// sanitised basename, the elapsed time and the outcome — never arguments,
// input, environment, cwd or output text.
const UNSAFE_NAME_CHARACTER = /[^A-Za-z0-9._-]/g;
const MAX_NOTE_CHARACTERS = 512;
const safeName = (value) =>
  path.basename(String(value)).replace(UNSAFE_NAME_CHARACTER, '?').slice(0, 64);
// One forward pass: every run of control characters (C0 and DEL) becomes one
// space, so a note stays one line whatever the traced process wrote.
const collapseControlCharacters = (text) => {
  let out = '';
  let inRun = false;
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code < 0x20 || code === 0x7f) {
      if (!inRun) out += ' ';
      inRun = true;
    } else {
      out += character;
      inRun = false;
    }
  }
  return out;
};

// The child-lifecycle phases of one command, in milliseconds since its spawn,
// always rendered in this order so two entries can be read against each other:
// stdin flushed, first stdout byte, first stderr byte, the 'exit' event, both
// stdio streams ended, the 'close' event. A phase that never happened is `none`.
// This is the split the hosted Windows timeout could not show: a guard that
// wrote its refusal and then did not exit (PR #202, head 315ad8f) reads as
// `stderr N ms, exit none`, while a guard that exited and whose pipes stayed
// open reads as `exit N ms, ended none`.
const PHASE_KEYS = ['stdin', 'stdout', 'stderr', 'exit', 'ended', 'close'];
export const describePhases = (phases = {}) =>
  PHASE_KEYS.map((key) => {
    const value = phases[key];
    return Number.isFinite(value) ? `${key} ${Math.round(value)} ms` : `${key} none`;
  }).join(', ');

export const createCommandHistory = ({ limit, now = () => performance.now() } = {}) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 64)
    throw new Error('command history limit must be an integer from 1 to 64');
  const entries = [];
  const push = (entry) => {
    entries.push(entry);
    if (entries.length > limit) entries.shift();
  };
  return {
    start(file) {
      const name = safeName(file);
      const startedAt = now();
      return (outcome, phases) => {
        push({ kind: 'command', name, elapsedMs: Math.round(now() - startedAt), outcome, phases });
      };
    },
    // A free-form observation recorded in sequence with the commands — for the
    // exit trace a probed guard writes about itself. Control characters
    // collapse to one space and the text is cut, so a note can never carry a
    // multi-line payload into the one-line timeout message.
    note(label, text) {
      const collapsed = collapseControlCharacters(String(text).slice(0, 4 * MAX_NOTE_CHARACTERS))
        .trim()
        .slice(0, MAX_NOTE_CHARACTERS);
      push({ kind: 'note', name: safeName(label), text: collapsed === '' ? '(empty)' : collapsed });
    },
    summary() {
      if (entries.length === 0) return '';
      const described = entries.map((entry) => {
        if (entry.kind === 'note') return `${entry.name}: ${entry.text}`;
        const { name, elapsedMs, outcome, phases } = entry;
        const result = outcome === 'timed out' ? 'timed out' : `exit ${outcome}`;
        return `${name} ${elapsedMs} ms ${result}${phases ? ` [${describePhases(phases)}]` : ''}`;
      });
      return `earlier commands in this worker: ${described.join('; ')}`;
    },
  };
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
    history,
    now = () => performance.now(),
  } = {},
) =>
  new Promise((resolve, reject) => {
    if (boundaryPid !== undefined && boundaryPid !== process.pid)
      return reject(new Error('invalid process boundary'));
    const finishCommand = history?.start(file);
    // Lifecycle phases, ms since spawn — see describePhases. Recorded once each.
    const phases = {};
    let recorded = false;
    const record = (outcome) => {
      if (recorded || finishCommand === undefined) return;
      recorded = true;
      finishCommand(outcome, phases);
    };
    const streamBytes = { stdout: 0, stderr: 0 };
    const child = spawn(file, args, {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32' && boundaryPid === undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const spawnedAt = now();
    const mark = (phase) => {
      if (phases[phase] === undefined) phases[phase] = now() - spawnedAt;
    };
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
        // Taken before this command is recorded, so it lists only earlier ones.
        const earlier = failure === undefined ? (history?.summary() ?? '') : '';
        const reason =
          failure?.message ??
          `timed out after ${timeoutMs} ms (stdout ${streamBytes.stdout} B, stderr ${streamBytes.stderr} B; ${describePhases(phases)})` +
            (earlier ? `; ${earlier}` : '');
        if (timedOut) record('timed out');
        failure = new Error(`benchmark command ${path.basename(file)}: ${reason}`);
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
    let endedStreams = 0;
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (chunk) => {
        mark(stream);
        size += chunk.length;
        streamBytes[stream] += chunk.length;
        if (size > maxBytes) {
          failure = new Error('benchmark process output limit exceeded');
          void stop();
        } else output[stream].push(chunk);
      });
      child[stream].once('end', () => {
        endedStreams += 1;
        if (endedStreams === 2) mark('ended');
      });
    }
    child.once('error', (error) => {
      failure = error;
    });
    child.once('exit', () => mark('exit'));
    child.once('close', async (code) => {
      mark('close');
      markClosed();
      clearTimeout(timer);
      record(timedOut ? 'timed out' : (code ?? 1));
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
    child.stdin.once('finish', () => mark('stdin'));
    child.stdin.end(input);
  });

// One worker per harness — and whether they run at once is a measured decision,
// not a default. On the hosted Windows runner, with two workers per benchmark
// and two benchmark files in flight, guard commands took 20–28 s each or passed
// the 30 s child deadline with nothing written, while every probed ingredient in
// the same worker — node start, stdin to EOF, the guard's module graph, git —
// stayed under 200 ms (PR #202, heads d43778e, d787770, 0ea2349). So on win32
// the workers run one after another; elsewhere they still start together. The
// result keeps `Promise.allSettled`'s shape, in adapter order, on both
// platforms, so a caller's failure handling reads the same list either way.
export const runHarnessWorkers = async (adapters, run, { platform }) => {
  if (platform !== 'win32') return Promise.allSettled(adapters.map((adapter) => run(adapter)));
  const settled = [];
  for (const adapter of adapters) settled.push(...(await Promise.allSettled([run(adapter)])));
  return settled;
};

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
