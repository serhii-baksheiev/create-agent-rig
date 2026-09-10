import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const currentPnpmCli = (environment: NodeJS.ProcessEnv): string | undefined => {
  const currentCli = environment.npm_execpath;
  if (currentCli && /^pnpm(?:-cli)?\.(?:cjs|js)$/i.test(path.basename(currentCli)) && existsSync(currentCli)) {
    return currentCli;
  }
  return undefined;
};

const pnpmCli = (environment: NodeJS.ProcessEnv): string => {
  const currentCli = currentPnpmCli(environment);
  if (currentCli) return currentCli;

  const installedCli = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'pnpm',
    'bin',
    'pnpm.cjs',
  );
  if (existsSync(installedCli)) return installedCli;

  const corepackCli = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'corepack',
    'dist',
    'pnpm.js',
  );
  if (existsSync(corepackCli)) return corepackCli;

  throw new Error('Cannot locate pnpm JavaScript CLI; npm_execpath must name the installed pnpm CLI');
};

/** Runs the workspace package manager without passing its arguments through a Windows shell. */
export const runPackageManager = (
  args: string[],
  options: Parameters<typeof exec>[2],
): ReturnType<typeof exec> => {
  const environment = options?.env ?? process.env;
  const currentCli = currentPnpmCli(environment);
  if (currentCli) return exec(process.execPath, [currentCli, ...args], options);
  if (process.platform !== 'win32') return exec('pnpm', args, options);
  return exec(process.execPath, [pnpmCli(environment), ...args], options);
};
