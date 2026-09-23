import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { packageManagerInvocation, run, runPackageManager } from '../e2e/run.js';
import { removeFixture } from '../helpers/remove-fixture.js';

// RP-158: each case of the `it.each` below is one package-manager CLI start,
// and nothing else. On the hosted windows-latest full-suite job the pnpm start
// took 4 670 ms and 7 023 ms, then 16 525 ms in a run where the whole host
// stalled, which timed out at the template project's 15 000 ms. npm and npx
// took 123 ms and 152 ms in that run. So these cases carry their own budget
// and the file-wide figure stays where it is. Pinned in vitest-timeouts.test.ts
// › "carries its own budget, declared once by name and passed as that
// parametrised case's options".
const PACKAGE_MANAGER_START_CASE_TIMEOUT_MS = 60_000;

// Bounds the child so a stalled start is killed and its own output reaches
// the report instead of leaking a live child into afterEach; not a budget
// raise — strictly below the case timeout above.
const PACKAGE_MANAGER_START_CHILD_TIMEOUT_MS = PACKAGE_MANAGER_START_CASE_TIMEOUT_MS - 10_000;

const literalArgs = ['space value', '&|<>^%!()', 'single "double"', ''];

const windowsNodeExecutable = (work: string): string =>
  path.join(work, 'Node Runtime &', 'node.exe');

const cliBesideNode = (nodeExecutable: string, ...parts: string[]): string =>
  path.join(path.dirname(nodeExecutable), 'node_modules', ...parts);

describe('package-manager transport', () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'caf-package-manager-'));
  });

  afterEach(async () => {
    await removeFixture(work);
  });

  it.each(['npm', 'pnpm', 'npx'] as const)(
    'runs the installed %s CLI directly and returns its version',
    { timeout: PACKAGE_MANAGER_START_CASE_TIMEOUT_MS },
    async (manager) => {
      const { stdout } = await runPackageManager(manager, ['--version'], {
        cwd: work,
        timeout: PACKAGE_MANAGER_START_CHILD_TIMEOUT_MS,
      });

      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/);
    },
  );

  it.each([
    ['npm', 'npm-cli.js'],
    ['npx', 'npx-cli.js'],
  ] as const)('uses the installed Windows %s JavaScript CLI', (manager, cliName) => {
    const nodeExecutable = windowsNodeExecutable(work);
    const cli = cliBesideNode(nodeExecutable, 'npm', 'bin', cliName);

    const invocation = packageManagerInvocation(manager, {}, 'win32', {
      nodeExecutable,
      exists: (candidate) => candidate === cli,
    });

    expect(invocation).toEqual({ file: nodeExecutable, prefix: [cli] });
  });

  it.each(['npm', 'pnpm', 'npx'] as const)(
    'refuses Windows %s execution when no JavaScript CLI can be located',
    (manager) => {
      expect(() =>
        packageManagerInvocation(manager, {}, 'win32', {
          nodeExecutable: windowsNodeExecutable(work),
          exists: () => false,
        }),
      ).toThrow(
        `Cannot locate the JavaScript CLI for ${manager}; npm_execpath must name its installed CLI on Windows`,
      );
    },
  );

  it('prefers a current pnpm npm_execpath over installed pnpm and Corepack', () => {
    const nodeExecutable = windowsNodeExecutable(work);
    const currentCli = path.join(work, 'current pnpm', 'pnpm.cjs');
    const installedPnpm = cliBesideNode(nodeExecutable, 'pnpm', 'bin', 'pnpm.cjs');
    const corepackPnpm = cliBesideNode(nodeExecutable, 'corepack', 'dist', 'pnpm.js');

    const invocation = packageManagerInvocation('pnpm', { npm_execpath: currentCli }, 'win32', {
      nodeExecutable,
      exists: (candidate) => [currentCli, installedPnpm, corepackPnpm].includes(candidate),
    });

    expect(invocation).toEqual({ file: nodeExecutable, prefix: [currentCli] });
  });

  it('prefers installed pnpm over Corepack when no current pnpm CLI is usable', () => {
    const nodeExecutable = windowsNodeExecutable(work);
    const installedPnpm = cliBesideNode(nodeExecutable, 'pnpm', 'bin', 'pnpm.cjs');
    const corepackPnpm = cliBesideNode(nodeExecutable, 'corepack', 'dist', 'pnpm.js');

    const invocation = packageManagerInvocation('pnpm', {}, 'win32', {
      nodeExecutable,
      exists: (candidate) => [installedPnpm, corepackPnpm].includes(candidate),
    });

    expect(invocation).toEqual({ file: nodeExecutable, prefix: [installedPnpm] });
  });

  it('uses Corepack pnpm when no current or installed pnpm CLI is available', () => {
    const nodeExecutable = windowsNodeExecutable(work);
    const corepackPnpm = cliBesideNode(nodeExecutable, 'corepack', 'dist', 'pnpm.js');

    const invocation = packageManagerInvocation('pnpm', {}, 'win32', {
      nodeExecutable,
      exists: (candidate) => candidate === corepackPnpm,
    });

    expect(invocation).toEqual({ file: nodeExecutable, prefix: [corepackPnpm] });
  });

  it('preserves literal argv and reports both streams through the Windows pnpm CLI invocation', async () => {
    const cliDir = path.join(work, 'CLI space & metachar');
    await mkdir(cliDir);
    const cli = path.join(cliDir, 'pnpm.cjs');
    await writeFile(
      cli,
      [
        'process.stdout.write(JSON.stringify(process.argv.slice(2)));',
        "process.stderr.write('transport stderr');",
        'process.exit(7);',
      ].join(''),
    );
    const invocation = packageManagerInvocation(
      'pnpm',
      { ...process.env, npm_execpath: cli },
      'win32',
    );
    expect(invocation).toEqual({ file: process.execPath, prefix: [cli] });

    const failure = await run(invocation.file, [...invocation.prefix, ...literalArgs], {
      cwd: work,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/exit code 7/i);
    expect(message).toContain('transport stderr');
    expect(message).toContain(JSON.stringify(literalArgs));
  });

  // RP-212: a stalled package-manager start has no bound of its own today —
  // `runPackageManager`'s `options` reach `execFile` with no `timeout`, so the
  // only thing that ever gives up is vitest's case budget, and vitest giving up
  // does not touch the child: it keeps the fixture directory open and
  // `afterEach`'s `removeFixture` fails with EBUSY, evidence-free, because the
  // child's own stdout/stderr were never captured by anything that rejected.
  //
  // A child given a `timeout` it overruns must be (a) actually killed — proven
  // by pid, not by inference — (b) rejected with an error that says it timed
  // out, and (c) rejected with that error carrying the output the child
  // produced before it stalled. Node's own `execFile` timeout already kills the
  // child and attaches its buffered output to the rejection; what it does not
  // do is say "timed out" anywhere in the message `run` builds — today's
  // wording only distinguishes "killed by signal" from "exit code", never a
  // deadline.
  it('kills a stalled child on timeout and reports that it timed out, with its output so far', async () => {
    const cliDir = path.join(work, 'stalled pnpm');
    await mkdir(cliDir);
    const cli = path.join(cliDir, 'pnpm.cjs');
    const pidFile = path.join(work, 'stalled-pnpm.pid');
    await writeFile(
      cli,
      [
        "process.stdout.write('FAKE_PNPM_STARTED\\n');",
        "require('node:fs').writeFileSync(process.argv[2], String(process.pid));",
        // The stall: far longer than any timeout this test passes, and far
        // longer than the test's own budget, so a missing kill hangs the test
        // rather than passing it by accident.
        'setTimeout(() => {}, 10 * 60 * 1000);',
      ].join('\n'),
    );

    const invocation = packageManagerInvocation(
      'pnpm',
      { ...process.env, npm_execpath: cli },
      'win32',
    );
    expect(invocation).toEqual({ file: process.execPath, prefix: [cli] });

    const failure = await run(invocation.file, [...invocation.prefix, pidFile], {
      cwd: work,
      timeout: 300,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/timed out/i);
    expect(message).toContain('FAKE_PNPM_STARTED');

    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(Number.isInteger(pid)).toBe(true);
    // The child is actually gone, not merely reported as killed: signalling
    // pid 0 throws ESRCH once nothing holds that pid any more.
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
