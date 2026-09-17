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

  it('caches pnpm dependencies in the ci job', async () => {
    expect(job(await workflow('ci.yml'), 'ci')).toMatch(
      /uses:\s*actions\/setup-node@v4[\s\S]*?with:\n(?: {10}.+\n)* {10}cache:\s*pnpm\s*$/m,
    );
  });

  it('runs a Windows smoke lane — the unit project only — on the hosted image', async () => {
    // Hosted-first ruling (2026-09-13): the pull-request path checks the
    // product's own unit project on Windows and nothing that depends on a
    // self-hosted machine. The template project — the one that spawns git and
    // the guards, and the one the hosted image times out on — runs in the
    // expensive workflow's Windows job instead.
    const yaml = await workflow('ci.yml');
    const windowsJobs = [
      ...yaml.matchAll(/^ {2}[\w-]+:\n([\s\S]*?)(?=^ {2}[\w-]+:\n|(?![\s\S]))/gm),
    ]
      .map((match) => match[0])
      .filter((candidate) => /^ {4}runs-on:\s*windows-latest\s*$/m.test(candidate));
    expect(windowsJobs, 'workflow has no windows-latest job').toHaveLength(1);
    expect(commandText(windowsJobs[0] ?? '')).toMatch(/\bpnpm test:smoke\b/);
    expect(commandText(windowsJobs[0] ?? '')).not.toMatch(/\bpnpm test:unit\b|\bpnpm test\b(?!:)/);
  });

  it('keeps the pull-request path off self-hosted runners entirely', async () => {
    // The pull-request path is every ci.yml job plus every e2e.yml job that
    // is not gated off pull requests. A job on that path either never names
    // a self-hosted runner, or its runs-on guards the switch behind
    // `github.event_name != 'pull_request'` — so a standing RUNNER_MODE can
    // never route a pull request from anywhere onto a machine of ours.
    expect(await workflow('ci.yml')).not.toMatch(/self-hosted/);
    const e2e = await workflow('e2e.yml');
    const jobs = [...e2e.matchAll(/^ {2}([\w-]+):\n([\s\S]*?)(?=^ {2}[\w-]+:\n|(?![\s\S]))/gm)]
      .map((m) => ({ name: m[1] ?? '', body: m[0] ?? '' }))
      .filter((j) => !/^ {4}if:\s*github\.event_name != 'pull_request'\s*$/m.test(j.body));
    expect(jobs.map((j) => j.name)).toContain('e2e');
    for (const job of jobs) {
      const runsOn = job.body.match(/^ {4}runs-on:\s*(.+)$/m)?.[1] ?? '';
      if (/self-hosted/.test(runsOn))
        expect(runsOn, `${job.name} can reach self-hosted on a pull request`).toMatch(
          /^\$\{\{ github\.event_name != 'pull_request' && /,
        );
    }
  });

  it('excludes no file by name on either Windows lane', async () => {
    // AR-93: the exclusion list is gone. A capability genuinely absent there
    // skips with its reason and is counted in platform-skips.test.ts; a
    // `--exclude` reappearing here would be a red file hidden, not a fix.
    expect(commandText(job(await workflow('ci.yml'), 'windows-smoke'))).not.toMatch(/--exclude/);
    expect(commandText(job(await workflow('e2e.yml'), 'windows-e2e'))).not.toMatch(/--exclude/);
  });
});

describe('the smoke script is the unit project and nothing wider', () => {
  it('declares test:smoke as vitest over the unit project only', async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test:smoke']).toBe('vitest run --project unit');
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

  it('accepts runner_mode hosted|self-hosted by dispatch input and by repository variable, hosted by default', async () => {
    // Owner ruling 2026-09-13 (§3, hosted-first): the release suite runs on
    // GitHub-hosted runners until a confirmed infrastructure condition; the
    // self-hosted fallback stays wired through one switch, never as a second
    // copy of the jobs. The same jobs, the same commands — only runs-on differs.
    const yaml = await expensiveWorkflow();
    const dispatch = yaml.match(
      /^ {2}workflow_dispatch:\n([\s\S]*?)(?=^ {2}[\w-]+:|^permissions:)/m,
    );
    expect(dispatch, 'expensive workflow has no workflow_dispatch block').not.toBeNull();
    const block = dispatch?.[0] ?? '';
    expect(block).toMatch(/^ {6}runner_mode:\n/m);
    expect(block).toMatch(/^ {8}type:\s*choice\s*$/m);
    expect(block).toMatch(/^ {8}default:\s*hosted\s*$/m);
    expect(block).toMatch(/^ {10}- hosted\s*$/m);
    expect(block).toMatch(/^ {10}- self-hosted\s*$/m);

    const runsOn = [...yaml.matchAll(/^ {4}runs-on:\s*(.+)$/gm)].map((m) => m[1] ?? '');
    expect(runsOn.length).toBeGreaterThanOrEqual(2);
    for (const value of runsOn) {
      expect(value, 'a job is not switchable').toMatch(/inputs\.runner_mode/);
      expect(value, 'a job ignores the repository variable').toMatch(/vars\.RUNNER_MODE/);
      expect(value, 'a job has no self-hosted branch').toMatch(/self-hosted/);
      expect(value, 'a job has no hosted default').toMatch(/ubuntu-latest|windows-latest/);
    }
  });

  it('records which runner executed each job, so release evidence can name it', async () => {
    const yaml = await expensiveWorkflow();
    for (const name of ['e2e', 'windows-e2e']) {
      const body = job(yaml, name);
      expect(body, `${name} does not print runner.environment`).toMatch(/runner\.environment/);
      expect(body, `${name} does not print runner.name`).toMatch(/runner\.name/);
      // Through env:, never interpolated into the shell line.
      expect(body).not.toMatch(/^\s*echo .*\$\{\{/m);
    }
  });

  it('keeps the Windows full suite off pull requests — it runs on master, nightly and by dispatch', async () => {
    const windows = job(await expensiveWorkflow(), 'windows-e2e');
    expect(windows).toMatch(/^ {4}if:\s*github\.event_name != 'pull_request'\s*$/m);
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
    // The hosted image is the default branch of the runner_mode switch.
    expect(windows).toMatch(/^ {4}runs-on:.*\|\| 'windows-latest' \}\}\s*$/m);
    expect(windows).toMatch(
      /uses:\s*actions\/checkout@v4[\s\S]*?with:\n(?: {10}.+\n)* {10}fetch-depth:\s*0\b/m,
    );
    expect(windows).toMatch(
      /uses:\s*actions\/setup-node@v4[\s\S]*?with:\n(?: {10}.+\n)* {10}node-version:\s*22\b/m,
    );
    expect(windows).toMatch(/uses:\s*pnpm\/action-setup@v4/);
    expect(runCommands(windows)).toContain('pnpm install --frozen-lockfile');
  });

  it('runs the bounded full root suite after installing root dependencies', async () => {
    const commands = runCommands(await windowsE2e());
    const rootInstall = commands.indexOf('pnpm install --frozen-lockfile');
    const rootTest = commands.findIndex((command) =>
      /^pnpm test\b(?!:).*--maxWorkers(?:=|\s+)\d+\b/.test(command),
    );

    expect(
      rootInstall,
      'the Windows job does not install root dependencies',
    ).toBeGreaterThanOrEqual(0);
    expect(rootTest, 'the Windows job does not run the bounded full root suite').toBeGreaterThan(
      rootInstall,
    );
  });

  it('does not hide a Windows e2e failure', async () => {
    expect(await windowsE2e()).not.toMatch(/continue-on-error:\s*true/);
  });
});
