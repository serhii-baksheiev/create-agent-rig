#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { CreateError, createProject } from './commands/create.js';

const USAGE = `Usage: create-agent-factory <dir>

Scaffolds a new project into <dir>: agent operating system (.claude/, CLAUDE.md)
plus a runnable code skeleton. Refuses to write into a non-empty directory.`;

async function main(): Promise<number> {
  let positionals: string[];
  try {
    ({ positionals } = parseArgs({
      args: process.argv.slice(2),
      options: { help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 1;
  }

  if (process.argv.slice(2).includes('--help') || process.argv.slice(2).includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const dirArg = positionals[0];
  if (!dirArg || positionals.length > 1) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  const { projectDir, projectName } = await createProject(dirArg, { cwd: process.cwd() });
  process.stdout.write(`Created ${projectName} in ${projectDir}\n`);
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
