import { EventEmitter } from 'node:events';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => childProcess);

type BenchmarkEnvironment = Record<string, string>;

type RuntimeModule = {
  runProcess(
    file: string,
    args: string[],
    options?: {
      cleanupTimeoutMs?: number;
      cwd?: string;
      env?: BenchmarkEnvironment;
      input?: string;
      maxBytes?: number;
      timeoutMs?: number;
    },
  ): Promise<{ code: number; stderr: Buffer; stdout: Buffer; timedOut: boolean }>;
  runWorker(
    file: string,
    payload: unknown,
    options?: {
      cleanupTimeoutMs?: number;
      cwd?: string;
      env?: BenchmarkEnvironment;
      onSpawn?: (pid: number) => void;
      timeoutMs?: number;
    },
  ): Promise<unknown>;
};

let runProcess: RuntimeModule['runProcess'];
let runWorker: RuntimeModule['runWorker'];

type FakeStream = EventEmitter & { destroy(error?: Error): void };

type FakeChild = EventEmitter & {
  connected: boolean;
  pid: number;
  stderr: FakeStream;
  stdin: FakeStream & { end(input?: string): void };
  stdout: FakeStream;
  disconnect(): void;
  kill(signal?: string): boolean;
  send(message: unknown, callback?: (error: Error | null) => void): void;
  unref(): void;
};

const WINDOWS_ENV = { SystemRoot: 'C:\\Windows' };
const CLEANUP_DEADLINE_MS = 250;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitForSpawnCount = async (count: number): Promise<void> => {
  const deadline = Date.now() + CLEANUP_DEADLINE_MS;
  while (childProcess.spawn.mock.calls.length < count && Date.now() < deadline) await delay(1);
  if (childProcess.spawn.mock.calls.length < count)
    throw new Error(`expected ${String(count)} spawned processes before cleanup deadline`);
};

const createChild = (
  pid: number,
  { onInput, onSend }: { onInput?: (input?: string) => void; onSend?: () => void } = {},
): FakeChild => {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.connected = true;
  child.stdout = Object.assign(new EventEmitter(), { destroy: () => undefined });
  child.stderr = Object.assign(new EventEmitter(), { destroy: () => undefined });
  child.stdin = Object.assign(new EventEmitter(), {
    destroy: () => undefined,
    end: onInput ?? (() => undefined),
  });
  child.disconnect = () => {
    child.connected = false;
  };
  child.kill = () => true;
  child.send = (_message, callback) => {
    onSend?.();
    callback?.(null);
  };
  child.unref = () => undefined;
  return child;
};

const rejectsWithin = (promise: Promise<unknown>, description: string): Promise<never> =>
  new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${description} did not settle by its bounded deadline`)),
      CLEANUP_DEADLINE_MS,
    );
    void promise.then(
      () => {
        clearTimeout(timer);
        reject(new Error(`${description} unexpectedly resolved`));
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const resolvesWithin = (promise: Promise<unknown>, description: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${description} did not settle by its bounded deadline`)),
      CLEANUP_DEADLINE_MS,
    );
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

beforeEach(() => {
  if (!platformDescriptor) throw new Error('process.platform must be configurable for this mock');
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  childProcess.spawn.mockReset();
});

beforeAll(async () => {
  ({ runProcess, runWorker } = (await import(
    new URL('../../scripts/policy-benchmark-runtime.mjs', import.meta.url).href
  )) as RuntimeModule);
});

afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
});

describe('policy benchmark Windows runtime cleanup', () => {
  it('does not resolve process evidence after active-process taskkill exits nonzero', async () => {
    const process = createChild(101, {
      onInput: () => process.stdout.emit('data', Buffer.from('too much output')),
    });
    const taskkill = createChild(102);
    childProcess.spawn.mockImplementationOnce(() => process).mockImplementationOnce(() => taskkill);

    const running = runProcess('benchmark-command', [], {
      cleanupTimeoutMs: 10,
      env: WINDOWS_ENV,
      input: '',
      maxBytes: 1,
    });
    queueMicrotask(() => taskkill.emit('close', 1));

    await expect(rejectsWithin(running, 'process evidence')).rejects.toThrow(
      /(?:taskkill|Windows process cleanup).*(?:failed|exit|status|code)/i,
    );
  });

  it('rejects a live worker result when taskkill exits nonzero instead of hanging for worker close', async () => {
    const worker = createChild(201, {
      onSend: () =>
        queueMicrotask(() =>
          worker.emit('message', { type: 'policy-benchmark:result', report: { ok: true } }),
        ),
    });
    const taskkill = createChild(202);
    childProcess.spawn.mockImplementationOnce(() => worker).mockImplementationOnce(() => taskkill);

    const running = runWorker(
      'worker.mjs',
      { scenario: 'cleanup' },
      {
        cleanupTimeoutMs: 10,
        env: WINDOWS_ENV,
      },
    );
    queueMicrotask(() => worker.emit('spawn'));
    await waitForSpawnCount(2);
    queueMicrotask(() => taskkill.emit('close', 1));

    await expect(rejectsWithin(running, 'worker evidence')).rejects.toThrow(
      /(?:taskkill|Windows process cleanup).*(?:failed|exit|status|code)/i,
    );
  });

  it('rejects boundedly when taskkill never exits while an active process times out', async () => {
    const process = createChild(301);
    const taskkill = createChild(302);
    childProcess.spawn.mockImplementationOnce(() => process).mockImplementationOnce(() => taskkill);

    const running = runProcess('benchmark-command', [], {
      cleanupTimeoutMs: 10,
      env: WINDOWS_ENV,
      input: '',
      timeoutMs: 1,
    });

    await expect(rejectsWithin(running, 'timed-out process evidence')).rejects.toThrow(
      /(?:taskkill|Windows process cleanup).*(?:failed|exit|status|code|timed out)/i,
    );
  });

  it('rejects a worker that closes before reporting a result can begin cleanup', async () => {
    const worker = createChild(401, {
      onSend: () => queueMicrotask(() => worker.emit('close', 0)),
    });
    const taskkill = createChild(402);
    childProcess.spawn.mockImplementationOnce(() => worker).mockImplementationOnce(() => taskkill);

    const running = runWorker(
      'worker.mjs',
      { scenario: 'close-before-result' },
      {
        cleanupTimeoutMs: 10,
        env: WINDOWS_ENV,
      },
    );
    queueMicrotask(() => worker.emit('spawn'));
    await waitForSpawnCount(2);
    queueMicrotask(() => taskkill.emit('close', 0));

    await expect(rejectsWithin(running, 'worker closed before its result')).rejects.toThrow(
      /worker.*(?:exited|closed).*(?:without|before)|(?:without|before).*worker/i,
    );
  });

  it('accepts a worker report when the worker closes after cleanup begins and before taskkill exits', async () => {
    const worker = createChild(451, {
      onSend: () =>
        queueMicrotask(() =>
          worker.emit('message', {
            type: 'policy-benchmark:result',
            report: { order: 'worker-first' },
          }),
        ),
    });
    const taskkill = createChild(452);
    childProcess.spawn.mockImplementationOnce(() => worker).mockImplementationOnce(() => taskkill);

    const running = runWorker(
      'worker.mjs',
      { scenario: 'worker-first' },
      { cleanupTimeoutMs: 10, env: WINDOWS_ENV },
    );
    queueMicrotask(() => worker.emit('spawn'));
    await waitForSpawnCount(2);
    worker.emit('close', 0);
    queueMicrotask(() => taskkill.emit('close', 0));

    await expect(resolvesWithin(running, 'worker-first result')).resolves.toEqual({
      order: 'worker-first',
    });
  });

  it('accepts a worker report when taskkill exits before the worker closes', async () => {
    const worker = createChild(461, {
      onSend: () =>
        queueMicrotask(() =>
          worker.emit('message', {
            type: 'policy-benchmark:result',
            report: { order: 'taskkill-first' },
          }),
        ),
    });
    const taskkill = createChild(462);
    childProcess.spawn.mockImplementationOnce(() => worker).mockImplementationOnce(() => taskkill);

    const running = runWorker(
      'worker.mjs',
      { scenario: 'taskkill-first' },
      { cleanupTimeoutMs: 10, env: WINDOWS_ENV },
    );
    queueMicrotask(() => worker.emit('spawn'));
    await waitForSpawnCount(2);
    taskkill.emit('close', 0);
    queueMicrotask(() => worker.emit('close', 0));

    await expect(resolvesWithin(running, 'taskkill-first result')).resolves.toEqual({
      order: 'taskkill-first',
    });
  });

  it('accepts an already-exited command without invoking taskkill for its gone PID', async () => {
    const process = createChild(501, {
      onInput: () => queueMicrotask(() => process.emit('close', 0)),
    });
    childProcess.spawn.mockReturnValueOnce(process);

    await expect(
      runProcess('benchmark-command', [], { cleanupTimeoutMs: 10, env: WINDOWS_ENV, input: '' }),
    ).resolves.toMatchObject({ code: 0, timedOut: false });
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
  });
});
