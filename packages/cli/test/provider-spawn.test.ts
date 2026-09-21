// RP-22 safe provider execution.  These tests exercise the small primitive
// consumed by the Spec Kit adapter and doctor, not a provider registry or any
// repository-supplied command declaration.
import { access, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runProviderProcess } from '../src/integrations/spawn.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';
import { onlyOnWindows, skipUnless } from '../../../test/helpers/env.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-provider-spawn-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function run(args: string[], options: { timeoutMs?: number; maxOutputBytes?: number } = {}) {
  return runProviderProcess({
    executable: process.execPath,
    args,
    repoDir: repo,
    ...options,
  });
}

async function pidsFrom(file: string): Promise<number[]> {
  const deadline = Date.now() + 300;
  while (Date.now() < deadline) {
    if (await exists(file)) {
      const pids = (await readFile(file, 'utf8'))
        .trim()
        .split(/\s+/)
        .map(Number)
        .filter(Number.isInteger);
      if (pids.length > 0) return pids;
    }
    await delay(10);
  }
  return [];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function killRecorded(pids: readonly number[]): Promise<void> {
  for (const pid of pids) {
    if (!isAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The fixture's owner has already exited or the platform denied a race
      // with its own process-tree cleanup. Either way, do not mask the test.
    }
  }
}

describe('runProviderProcess', () => {
  it('runs the compiled adapter argv at the repository root', async () => {
    const result = await run(['-e', 'process.stdout.write(process.cwd())'], { timeoutMs: 10_000 });
    if (process.env.RIG_WINDOWS_JOB_PROBE === '1')
      console.error(JSON.stringify({ status: result.status, stages: result.stderr }));

    expect(result).toEqual({ status: 'ok', stdout: await realpath(repo), stderr: '', exitCode: 0 });
  });

  it('bounds both output streams instead of retaining unbounded provider output', async () => {
    const result = await run(
      [
        '-e',
        "process.stdout.write('o'.repeat(4096)); process.stderr.write('e'.repeat(4096)); setInterval(() => {}, 1000);",
      ],
      { maxOutputBytes: 64 },
    );

    expect(result.status).toBe('output-limit');
    expect(result.stdout.length).toBeLessThanOrEqual(64);
    expect(result.stderr.length).toBeLessThanOrEqual(64);
    expect(result.exitCode).toBeNull();
  });

  it('passes metacharacters as a literal argv element without executing a shell', async () => {
    const sentinel = path.join(repo, 'shell-ran');
    const argument = `literal; echo unsafe > "${sentinel}"; $(echo still-literal)`;

    const result = await run(['-e', 'process.stdout.write(process.argv[1])', argument]);

    expect(result).toEqual({ status: 'ok', stdout: argument, stderr: '', exitCode: 0 });
    expect(await exists(sentinel)).toBe(false);
  });

  it('counts Windows job-supervisor startup in a short total deadline before any provider code can run', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
    const sentinel = path.join(repo, 'provider-ran-before-job-control');

    // This is the provider's first operation. If it ever starts before the
    // supervisor owns it in a kill-on-close job, it leaves durable evidence.
    const result = await run(
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`],
      { timeoutMs: 50 },
    );

    expect(['timeout', 'cleanup-unconfirmed']).toContain(result.status);
    // A cold Add-Type helper takes roughly three seconds on this host. Waiting
    // beyond that startup cost proves the provider was not merely delayed into
    // a later, post-return execution after the 50 ms total deadline fired.
    await delay(4500);
    expect(await exists(sentinel)).toBe(false);
  });

  it('reports success when a provider and its normal descendants all exit inside the deadline', async () => {
    const timeoutMs = process.platform === 'win32' ? 6000 : 1500;
    const grandchild = 'setTimeout(() => process.exit(0), 10);';
    const child =
      "const {spawn}=require('node:child_process'); " +
      `const grandchild=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'}); ` +
      "grandchild.on('exit', () => process.exit(0));";
    const root =
      "const {spawn}=require('node:child_process'); " +
      `const child=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'}); ` +
      "child.on('exit', () => process.exit(0));";

    expect(await run(['-e', root], { timeoutMs })).toEqual({
      status: 'ok',
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
  });

  it('returns only after a deadline kills a live child and grandchild on this platform', async () => {
    // Windows starts the fixed PowerShell/Add-Type supervisor inside the same
    // deadline. Cold measurements on this host were 2.98–3.20 s before even
    // launching the fixture, so this remains a bounded execution test while
    // leaving time to observe its two PIDs.
    const timeoutMs = process.platform === 'win32' ? 6000 : 1500;
    const survivorDelayMs = timeoutMs + 1000;
    const pidFile = path.join(repo, 'descendants.txt');
    const sentinel = path.join(repo, 'descendant-survived');
    const grandchild =
      "const fs=require('node:fs'); const [pidFile,sentinel]=process.argv.slice(1); " +
      'fs.appendFileSync(pidFile, `${process.pid}\\n`); ' +
      `setTimeout(() => fs.writeFileSync(sentinel, 'leaked'), ${survivorDelayMs}); setInterval(() => {}, 1000);`;
    const child =
      "const fs=require('node:fs'); const {spawn}=require('node:child_process'); " +
      'const [pidFile,sentinel]=process.argv.slice(1); ' +
      `const grandchild=spawn(process.execPath,['-e',${JSON.stringify(grandchild)},pidFile,sentinel],{stdio:'ignore'}); ` +
      'fs.appendFileSync(pidFile, `${process.pid}\\n`); setInterval(() => {}, 1000);';
    let pids: number[] = [];
    try {
      // Two nested cold Node starts are real fixture work on Windows.  This is
      // still a bounded operation deadline, leaving ample room before the
      // existing unit-test ceiling without changing that ceiling.
      const result = await run(['-e', child, pidFile, sentinel], { timeoutMs });
      pids = await pidsFrom(pidFile);

      expect(result.status).toBe('timeout');
      expect(pids).toHaveLength(2);
      expect(pids.every((pid) => !isAlive(pid))).toBe(true);
      await delay(survivorDelayMs + 100);
      expect(await exists(sentinel)).toBe(false);
    } finally {
      await killRecorded(pids);
    }
  });

  it('never reports success when its root exits while a descendant retains its stdio', async () => {
    const timeoutMs = process.platform === 'win32' ? 6000 : 1500;
    const survivorDelayMs = timeoutMs + 1000;
    const pidFile = path.join(repo, 'stdio-descendant.txt');
    const sentinel = path.join(repo, 'stdio-descendant-survived');
    const descendant =
      "const fs=require('node:fs'); const [pidFile,sentinel]=process.argv.slice(1); " +
      `setTimeout(() => fs.writeFileSync(sentinel, 'leaked'), ${survivorDelayMs}); setInterval(() => {}, 1000);`;
    const rootExits =
      "const fs=require('node:fs'); const {spawn}=require('node:child_process'); const [pidFile,sentinel]=process.argv.slice(1); " +
      `const descendant=spawn(process.execPath,['-e',${JSON.stringify(descendant)},pidFile,sentinel],{stdio:'inherit'}); ` +
      // The root records the child PID immediately, so test cleanup does not
      // rely on the deliberately orphaned child winning a startup race.
      'fs.writeFileSync(pidFile, String(descendant.pid)); ' +
      'process.exit(0);';
    let pids: number[] = [];
    try {
      const result = await run(['-e', rootExits, pidFile, sentinel], { timeoutMs });
      pids = await pidsFrom(pidFile);

      // Once the root is gone, Windows cannot always taskkill its former tree.
      // `cleanup-unconfirmed` is therefore an honest rejection, not a claim
      // that the descendant has certainly been cleaned up.
      expect(result.status).not.toBe('ok');
      expect(result.exitCode).toBeNull();
      expect(pids).toHaveLength(1);
    } finally {
      await killRecorded(pids);
    }
  });
});
