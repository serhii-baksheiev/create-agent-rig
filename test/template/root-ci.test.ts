import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

const commandText = (yaml: string): string => yaml.replace(/\r?\n\s*/g, ' ');

describe('workflow run-command parsing', () => {
  it('reads inline and named block run steps', () => {
    expect(
      runCommands(`      - run: pnpm test
      - name: Require a cold artifact
        shell: pwsh
        run: |
          if (Test-Path template/dist) {
            throw 'dist exists'
          }`),
    ).toEqual(['pnpm test', "if (Test-Path template/dist) {\n  throw 'dist exists'\n}"]);
  });
});

const expensiveWorkflow = async (): Promise<string> => {
  const names = (await readdir(workflowsDir)).filter((name) => /\.ya?ml$/.test(name));
  const candidates: string[] = [];
  for (const name of names) {
    if (name === 'ci.yml') continue;
    const source = await workflow(name);
    if (runCommands(source).includes('pnpm test')) candidates.push(source);
  }
  expect(
    candidates,
    'exactly one workflow outside ci.yml must own the expensive full test suite',
  ).toHaveLength(1);
  return candidates[0] ?? '';
};

describe('root CI keeps ordinary pull requests fast and least-privileged', () => {
  it('grants the root workflow read-only repository contents', async () => {
    expect(await workflow('ci.yml')).toMatch(/^permissions:\n {2}contents:\s*read\s*$/m);
  });

  it('cancels an older run for the same ref', async () => {
    const yaml = await workflow('ci.yml');
    expect(yaml).toMatch(/^concurrency:\n {2}group:\s*ci-\$\{\{ github\.ref \}\}\s*$/m);
    expect(yaml).toMatch(/^ {2}cancel-in-progress:\s*true\s*$/m);
  });

  it('runs lint, typecheck and unit tests instead of the expensive full suite', async () => {
    const commands = runCommands(job(await workflow('ci.yml'), 'ci'));
    expect(commands).toEqual(expect.arrayContaining(['pnpm lint', 'pnpm typecheck']));
    expect(commands.some((command) => command.startsWith('pnpm test:unit'))).toBe(true);
    expect(commands).not.toContain('pnpm test');
  });

  it('gives unit tests 15 seconds under Linux CI load', async () => {
    expect(commandText(job(await workflow('ci.yml'), 'ci'))).toMatch(
      /pnpm test:unit\b[^\n]*--test-?timeout(?:=|\s+)15000\b/i,
    );
  });

  it.each(['template-aws-serverless', 'template-node-service'])(
    'caches pnpm dependencies in %s',
    async (name) => {
      expect(job(await workflow('ci.yml'), name)).toMatch(
        /uses:\s*actions\/setup-node@v4[\s\S]*?with:\n(?: {10}.+\n)* {10}cache:\s*pnpm\s*$/m,
      );
    },
  );

  it('runs the unit suite on Windows', async () => {
    const yaml = await workflow('ci.yml');
    const windowsJobs = [
      ...yaml.matchAll(/^ {2}[\w-]+:\n([\s\S]*?)(?=^ {2}[\w-]+:\n|(?![\s\S]))/gm),
    ]
      .map((match) => match[0])
      .filter((candidate) => /^ {4}runs-on:\s*windows-latest\s*$/m.test(candidate));
    expect(windowsJobs, 'workflow has no windows-latest job').toHaveLength(1);
    expect(commandText(windowsJobs[0] ?? '')).toMatch(/\bpnpm test:unit\b/);
  });

  it('runs the whole unit suite on Windows, with no file excluded by name', async () => {
    // AR-93: the exclusion list is gone. A capability genuinely absent there
    // skips with its reason and is counted in platform-skips.test.ts; a
    // `--exclude` reappearing here would be a red file hidden, not a fix.
    const windows = job(await workflow('ci.yml'), 'windows-unit');
    expect(commandText(windows)).not.toMatch(/--exclude/);
  });
});

describe('expensive root tests have their own narrowly-triggered workflow', () => {
  it('runs the full suite outside the fast CI workflow with read-only permissions', async () => {
    const yaml = await expensiveWorkflow();
    expect(runCommands(yaml)).toContain('pnpm test');
    expect(yaml).toMatch(/^permissions:\n {2}contents:\s*read\s*$/m);
  });

  it('runs after pushes to master, on a nightly schedule and by manual dispatch', async () => {
    const yaml = await expensiveWorkflow();
    expect(yaml).toMatch(/^ {2}push:\n {4}branches:\s*\[master\]\s*$/m);
    expect(yaml).toMatch(/^ {2}schedule:\n {4}- cron:\s*['"]\d+ \d+ \* \* \*['"]\s*(?:#.*)?$/m);
    expect(yaml).toMatch(/^ {2}workflow_dispatch:\s*$/m);
  });

  it('runs on pull requests when CLI, template, e2e harness or workflow inputs change', async () => {
    const yaml = await expensiveWorkflow();
    const pullRequest = yaml.match(/^ {2}pull_request:\n([\s\S]*?)(?=^ {2}[\w-]+:|^jobs:)/m);
    expect(pullRequest, 'expensive workflow has no pull_request trigger').not.toBeNull();
    const paths = [...(pullRequest?.[0] ?? '').matchAll(/^ {6}-\s*['"]?(.+?)['"]?\s*$/gm)].map(
      (match) => match[1],
    );
    expect(paths).toEqual([
      'packages/cli/**',
      'templates/**',
      '.github/workflows/e2e.yml',
      'test/e2e/**',
    ]);
  });
});

describe('the expensive workflow exercises a cold Windows package-manager path', () => {
  const windowsE2e = async () => job(await workflow('e2e.yml'), 'windows-e2e');

  it('adds a separate full-history Windows job with Node 22 and a frozen root install', async () => {
    const windows = await windowsE2e();
    expect(windows).toMatch(/^ {4}runs-on:\s*windows-latest\s*$/m);
    expect(windows).toMatch(
      /uses:\s*actions\/checkout@v4[\s\S]*?with:\n(?: {10}.+\n)* {10}fetch-depth:\s*0\b/m,
    );
    expect(windows).toMatch(
      /uses:\s*actions\/setup-node@v4[\s\S]*?with:\n(?: {10}.+\n)* {10}node-version:\s*22\b/m,
    );
    expect(windows).toMatch(/uses:\s*pnpm\/action-setup@v4/);
    expect(runCommands(windows)).toContain('pnpm install --frozen-lockfile');
  });

  it('runs the bounded full root suite before the cold node-service test', async () => {
    const commands = runCommands(await windowsE2e());
    const rootInstall = commands.indexOf('pnpm install --frozen-lockfile');
    const rootTest = commands.findIndex((command) =>
      /^pnpm test\b(?!:).*--maxWorkers(?:=|\s+)\d+\b/.test(command),
    );
    const nodeServiceInstall = commands.indexOf(
      'pnpm --dir templates/skeleton/node-service install --frozen-lockfile',
    );
    const noDist = commands.findIndex(
      (command) =>
        /Test-Path\s+templates\/skeleton\/node-service\/dist/i.test(command) &&
        /throw\b/i.test(command),
    );
    const test = commands.indexOf('pnpm --dir templates/skeleton/node-service test');

    expect(
      rootInstall,
      'the Windows job does not install root dependencies',
    ).toBeGreaterThanOrEqual(0);
    expect(rootTest, 'the Windows job does not run the bounded full root suite').toBeGreaterThan(
      rootInstall,
    );
    expect(
      nodeServiceInstall,
      'the Windows job does not install node-service dependencies',
    ).toBeGreaterThan(rootTest);
    expect(
      noDist,
      'the Windows job does not assert that node-service dist is absent',
    ).toBeGreaterThan(nodeServiceInstall);
    expect(test, 'the Windows job does not run the bare node-service test command').toBeGreaterThan(
      noDist,
    );
  });

  it('does not hide a Windows e2e failure', async () => {
    expect(await windowsE2e()).not.toMatch(/continue-on-error:\s*true/);
  });
});
