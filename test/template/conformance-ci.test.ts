import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RP-13, spec point E: CI gains a `memory-conformance` job running the
 * pinned-ref checks. Helpers mirror `test/template/root-ci.test.ts`'s
 * `job`/`runCommands`, kept local so this file stands on its own the way its
 * sibling CI-parsing test files do.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const workflow = (name: string) => readFile(path.join(workflowsDir, name), 'utf8');

const job = (yaml: string, name: string): string => {
  const match = yaml.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, 'm'),
  );
  expect(match, `workflow has no ${name} job`).not.toBeNull();
  return match?.[0] ?? '';
};

const runCommands = (yaml: string): string[] => {
  const lines = yaml.split(/\r?\n/);
  const commands: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = line.match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!match) continue;

    const propertyIndent = match[1]?.length ?? 0;
    const value = match[2]?.trim() ?? '';
    if (!/^\|[-+]?$/.test(value)) {
      if (value) commands.push(value);
      continue;
    }

    const block: string[] = [];
    let blockIndent: number | undefined;
    for (index += 1; index < lines.length; index += 1) {
      const blockLine = lines[index] ?? '';
      const indent = blockLine.match(/^\s*/)?.[0].length ?? 0;
      if (blockLine.trim() && indent <= propertyIndent) {
        index -= 1;
        break;
      }
      if (blockLine.trim() && blockIndent === undefined) blockIndent = indent;
      block.push(blockLine.slice(blockIndent));
    }
    commands.push(block.join('\n').trim());
  }

  return commands;
};

describe('CI runs the pinned-ref Memory conformance checks (RP-13)', () => {
  it('adds a memory-conformance job on ubuntu-latest', async () => {
    const memoryJob = job(await workflow('ci.yml'), 'memory-conformance');
    expect(memoryJob).toMatch(/^ {4}runs-on:\s*ubuntu-latest\s*$/m);
  });

  it('installs, builds and runs the conformance script with --json', async () => {
    const commands = runCommands(job(await workflow('ci.yml'), 'memory-conformance'));
    expect(commands).toContain('pnpm install --frozen-lockfile');
    expect(commands).toContain('pnpm build');
    expect(commands).toContain('node scripts/memory-conformance.mjs --json');
  });

  it('never hides a conformance failure behind continue-on-error', async () => {
    const memoryJob = job(await workflow('ci.yml'), 'memory-conformance');
    expect(memoryJob).not.toMatch(/continue-on-error:\s*true/);
  });
});

describe('the required-check documentation names the memory-conformance job (RP-13)', () => {
  it('README names the CI job that runs the conformance matrix', async () => {
    const readme = await readFile(path.join(repoRoot, 'README.md'), 'utf8');
    expect(readme).toContain('memory-conformance');
  });
});
