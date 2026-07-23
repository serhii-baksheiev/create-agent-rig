#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CreateError, createProject } from './commands/create.js';
import { InitError, initProject, planInit } from './commands/init.js';
import { makePalette } from './lib/colors.js';
import { promptTarget } from './lib/prompts.js';
import { collectGovernance, renderSummary } from './lib/summary.js';
import { DEFAULT_TARGET, TARGET_NAMES } from './lib/targets.js';

const USAGE = `Usage: create-agent-rig <dir> [options]

Scaffolds a new project into <dir>: agent operating system (.claude/, CLAUDE.md)
plus a runnable code skeleton. Refuses to write into a non-empty directory.

Options
  --target <name>   ${TARGET_NAMES.join(' | ')}
                    (interactive selection when omitted on a terminal;
                    required when not a terminal — default: ${DEFAULT_TARGET})
  --no-git          skip git init + the pristine-template baseline commit
  --no-color        plain output (NO_COLOR is respected too)
  --version         print the version
  -h, --help        this text

Also: create-agent-rig init [--dry-run] [--force]
  Install the process layer (rules, gates, stop rules — no architecture
  assumptions) into the CURRENT existing repo. Refuses to clobber CLAUDE.md.`;

async function packageVersion(): Promise<string> {
  // dist/index.js lives three levels under the package root — same walk as
  // the templates resolver, valid in the repo and in the published package.
  const pkgPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'package.json',
  );
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

async function runInit(rawArgs: string[]): Promise<number> {
  let values: { 'dry-run'?: boolean; force?: boolean };
  try {
    ({ values } = parseArgs({
      args: rawArgs,
      options: { 'dry-run': { type: 'boolean' }, force: { type: 'boolean' } },
      allowPositionals: false,
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 1;
  }
  const cwd = process.cwd();
  const dryRun = values['dry-run'] === true;

  const plan = await planInit(cwd);
  process.stdout.write(
    `agent-rig init — process layer into ${cwd}\n\n` +
      plan.files.map((f) => `  + ${f.path}`).join('\n') +
      '\n',
  );
  if (plan.conflicts.length > 0) {
    process.stdout.write(
      `\nAlready present (kept, not overwritten):\n` +
        plan.conflicts.map((c) => `  · ${c}`).join('\n') +
        '\n',
    );
  }

  const result = await initProject(cwd, { dryRun, force: values.force === true });
  if (dryRun) {
    process.stdout.write(`\nDry run — nothing written (${result.plannedCount} files planned).\n`);
    return 0;
  }
  process.stdout.write(
    `\nInstalled ${result.written.length} files` +
      (result.skipped.length ? `, kept ${result.skipped.length} existing` : '') +
      '.\n',
  );
  return 0;
}

async function main(): Promise<number> {
  if (process.argv[2] === 'init') {
    return runInit(process.argv.slice(3));
  }

  let positionals: string[];
  let values: {
    help?: boolean;
    target?: string;
    version?: boolean;
    'no-git'?: boolean;
    'no-color'?: boolean;
  };
  try {
    ({ positionals, values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        help: { type: 'boolean', short: 'h' },
        target: { type: 'string' },
        version: { type: 'boolean' },
        'no-git': { type: 'boolean' },
        'no-color': { type: 'boolean' },
      },
      allowPositionals: true,
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 1;
  }

  if (values.version) {
    process.stdout.write(`${await packageVersion()}\n`);
    return 0;
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const dirArg = positionals[0];
  if (!dirArg || positionals.length > 1) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  // Non-TTY correctness (polish brief §5): never prompt into a pipe — a
  // prompt would hang CI. Non-interactive runs must state the target.
  const isInteractive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  let target = values.target;
  if (!target) {
    if (!isInteractive) {
      process.stderr.write(
        `Missing --target in a non-interactive run. ` +
          `Pass --target <${TARGET_NAMES.join('|')}>.\n`,
      );
      return 1;
    }
    target = await promptTarget(TARGET_NAMES, DEFAULT_TARGET, {
      input: process.stdin,
      output: process.stderr,
      isInteractive,
    });
  }

  const { projectDir, projectName } = await createProject(dirArg, {
    cwd: process.cwd(),
    target,
    git: values['no-git'] !== true,
  });

  const palette = makePalette(
    Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && values['no-color'] !== true,
  );
  const summary = await collectGovernance(projectDir);
  process.stdout.write('\n' + renderSummary(projectName, target, dirArg, summary, palette));
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof CreateError || error instanceof InitError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      console.error(error); // unexpected: the trace is the diagnostic
    }
    process.exitCode = 1;
  });
