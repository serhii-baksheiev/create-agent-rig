import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { packageManagerInvocation, run, runPackageManager } from '../e2e/run.js';

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
    await rm(work, { recursive: true, force: true });
  });

  it.each(['npm', 'pnpm', 'npx'] as const)(
    'runs the installed %s CLI directly and returns its version',
    async (manager) => {
      const { stdout } = await runPackageManager(manager, ['--version'], { cwd: work });

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
});
