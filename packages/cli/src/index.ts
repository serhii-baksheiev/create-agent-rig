#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { CreateError, createProject } from './commands/create.js';
import { promptTarget } from './lib/prompts.js';
import { DEFAULT_TARGET, TARGET_NAMES } from './lib/targets.js';

const USAGE = `Usage: create-agent-factory <dir> [--target <name>]

Scaffolds a new project into <dir>: agent operating system (.claude/, CLAUDE.md)
plus a runnable code skeleton. Refuses to write into a non-empty directory.

Targets: ${TARGET_NAMES.join(', ')} (default: ${DEFAULT_TARGET};
asked interactively when the flag is absent and stdin is a terminal)`;

async function main(): Promise<number> {
  let positionals: string[];
  let values: { help?: boolean; target?: string };
  try {
    ({ positionals, values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        help: { type: 'boolean', short: 'h' },
        target: { type: 'string' },
      },
      allowPositionals: true,
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 1;
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

  const target =
    values.target ??
    (await promptTarget(TARGET_NAMES, DEFAULT_TARGET, {
      input: process.stdin,
      output: process.stderr,
      isInteractive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    }));

  const { projectDir, projectName } = await createProject(dirArg, {
    cwd: process.cwd(),
    target,
  });
  process.stdout.write(`Created ${projectName} (${target}) in ${projectDir}\n`);
  process.stdout.write(`\nNext steps:\n  cd ${dirArg}\n  pnpm install\n  pnpm test\n`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof CreateError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
