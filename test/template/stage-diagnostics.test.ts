import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const load = () =>
  import(
    pathToFileURL(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'stage-diagnostics.mjs'),
    ).href
  );

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('stage diagnostics', () => {
  it('refuses an unsafe or unbounded stage label before emitting it', async () => {
    const { createStageDiagnostics } = await load();
    const lines: string[] = [];
    const diagnostics = createStageDiagnostics({
      now: () => 100,
      emit: (line: string) => lines.push(line),
    });
    const unsafe = `fixture-setup\nsecret=${'x'.repeat(128)}`;

    expect(() => diagnostics.runSync(unsafe, () => 'should not run')).toThrow(/stage label/i);
    expect(lines).toEqual([]);
  });

  it.each([
    ['LF', 'fixture-setup\n'],
    ['CR', 'fixture-setup\r'],
    ['CRLF', 'fixture-setup\r\n'],
  ])('refuses a stage label with a terminal %s before emitting it', async (_ending, label) => {
    const { createStageDiagnostics } = await load();
    const lines: string[] = [];
    const diagnostics = createStageDiagnostics({
      now: () => 100,
      emit: (line: string) => lines.push(line),
    });

    expect(() => diagnostics.runSync(label, () => 'should not run')).toThrow(/stage label/i);
    expect(lines).toEqual([]);
  });

  it('returns a synchronous stage result after recording its bounded start and completion', async () => {
    const { createStageDiagnostics } = await load();
    const lines: string[] = [];
    let elapsedMs = 100;
    const diagnostics = createStageDiagnostics({
      now: () => elapsedMs,
      emit: (line: string) => lines.push(line),
    });

    const value = diagnostics.runSync('fixture-setup', () => {
      elapsedMs = 135;
      return { checkout: 'ready' };
    });

    expect(value).toEqual({ checkout: 'ready' });
    expect(lines).toEqual([
      'stage=fixture-setup event=START',
      'stage=fixture-setup event=COMPLETE elapsedMs=35',
    ]);
  });

  it('distinguishes fixture setup, every CLI execution, child cleanup, and teardown', async () => {
    const { createStageDiagnostics } = await load();
    const lines: string[] = [];
    let elapsedMs = 150;
    const diagnostics = createStageDiagnostics({
      now: () => elapsedMs,
      emit: (line: string) => lines.push(line),
    });

    for (const stage of [
      'fixture-setup',
      'gate-round-cli',
      'gate-round-cli',
      'child-cleanup',
      'teardown',
    ]) {
      diagnostics.runSync(stage, () => {
        elapsedMs += 5;
      });
    }

    expect(lines).toEqual([
      'stage=fixture-setup event=START',
      'stage=fixture-setup event=COMPLETE elapsedMs=5',
      'stage=gate-round-cli event=START',
      'stage=gate-round-cli event=COMPLETE elapsedMs=5',
      'stage=gate-round-cli event=START',
      'stage=gate-round-cli event=COMPLETE elapsedMs=5',
      'stage=child-cleanup event=START',
      'stage=child-cleanup event=COMPLETE elapsedMs=5',
      'stage=teardown event=START',
      'stage=teardown event=COMPLETE elapsedMs=5',
    ]);
  });

  it('records a stalled asynchronous stage before it settles', async () => {
    const { createStageDiagnostics } = await load();
    const lines: string[] = [];
    let elapsedMs = 200;
    const diagnostics = createStageDiagnostics({
      now: () => elapsedMs,
      emit: (line: string) => lines.push(line),
    });
    const operation = deferred<string>();

    const running = diagnostics.run('gate-round-cli', () => operation.promise);
    expect(lines).toEqual(['stage=gate-round-cli event=START']);

    elapsedMs = 260;
    operation.resolve('round recorded');

    await expect(running).resolves.toBe('round recorded');
    expect(lines).toEqual([
      'stage=gate-round-cli event=START',
      'stage=gate-round-cli event=COMPLETE elapsedMs=60',
    ]);
  });

  it('reports a failed synchronous child stage with bounded safe child metadata', async () => {
    const { createStageDiagnostics } = await load();
    const lines: string[] = [];
    let elapsedMs = 300;
    const diagnostics = createStageDiagnostics({
      now: () => elapsedMs,
      emit: (line: string) => lines.push(line),
    });
    const secret = ['to', 'ken', '=', 'do-not-log'].join('');
    const childFailure = Object.assign(new Error(`child failed: ${secret}`), {
      status: 1,
      signal: 'SIGTERM',
      stdout: Buffer.from(secret.repeat(256)),
      stderr: Buffer.from(secret.repeat(512)),
    });

    let thrown: unknown;
    try {
      diagnostics.runSync('fixture-setup', () => {
        elapsedMs = 345;
        throw childFailure;
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(childFailure);

    expect(lines).toEqual([
      'stage=fixture-setup event=START',
      'stage=fixture-setup event=FAILED elapsedMs=45 status=1 signal=SIGTERM stdoutBytes=4096 stderrBytes=8192',
    ]);
    expect(lines.join('\n')).not.toContain(secret);
  });

  it.each([
    ['LF', 'SIGTERM\n'],
    ['CR', 'SIGTERM\r'],
    ['CRLF', 'SIGTERM\r\n'],
  ])(
    'reports a child signal with a terminal %s as none while preserving its failure',
    async (_ending, signal) => {
      const { createStageDiagnostics } = await load();
      const lines: string[] = [];
      let elapsedMs = 350;
      const diagnostics = createStageDiagnostics({
        now: () => elapsedMs,
        emit: (line: string) => lines.push(line),
      });
      const childFailure = Object.assign(new Error('child failed'), { status: 1, signal });

      let thrown: unknown;
      try {
        diagnostics.runSync('child-cleanup', () => {
          elapsedMs = 355;
          throw childFailure;
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(childFailure);
      expect(lines).toEqual([
        'stage=child-cleanup event=START',
        'stage=child-cleanup event=FAILED elapsedMs=5 status=1 signal=none stdoutBytes=0 stderrBytes=0',
      ]);
    },
  );

  it('reports a failed asynchronous child stage with its status while preserving the rejection', async () => {
    const { createStageDiagnostics } = await load();
    const lines: string[] = [];
    let elapsedMs = 400;
    const diagnostics = createStageDiagnostics({
      now: () => elapsedMs,
      emit: (line: string) => lines.push(line),
    });
    const secret = ['pass', 'word', '=', 'do-not-log'].join('');
    const childFailure = Object.assign(new Error(`child failed: ${secret}`), {
      status: 9,
      signal: null,
      stdout: Buffer.from(secret.repeat(384)),
      stderr: Buffer.from(secret.repeat(640)),
    });

    const running = diagnostics.run('gate-round-cli', async () => {
      elapsedMs = 470;
      throw childFailure;
    });

    await expect(running).rejects.toBe(childFailure);
    expect(lines).toEqual([
      'stage=gate-round-cli event=START',
      'stage=gate-round-cli event=FAILED elapsedMs=70 status=9 signal=none stdoutBytes=7296 stderrBytes=12160',
    ]);
    expect(lines.join('\n')).not.toContain(secret);
  });
});
