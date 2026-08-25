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

const runCommands = (yaml: string): string[] =>
  [...yaml.matchAll(/^\s*- run:\s*(.+)$/gm)].map((match) => match[1]?.trim() ?? '');

const commandText = (yaml: string): string => yaml.replace(/\r?\n\s*/g, ' ');

const WINDOWS_INCOMPATIBLE_TESTS = [
  'packages/cli/test/copy-tree.test.ts',
  'packages/cli/test/create.test.ts',
  'packages/cli/test/init.test.ts',
  'test/template/agents.test.ts',
  'test/template/aws-extras.test.ts',
  'test/template/close-transitioned.test.ts',
  'test/template/codex.test.ts',
  'test/template/decision-router.test.ts',
  'test/template/dogfood.test.ts',
  'test/template/gate-rounds.test.ts',
  'test/template/gate-scripts.test.ts',
  'test/template/git-env.test.ts',
  'test/template/guard-hardening.test.ts',
  'test/template/guard-secret-file.test.ts',
  'test/template/hooks.test.ts',
  'test/template/invariants.test.ts',
  'test/template/packaging.test.ts',
  'test/template/queue-jira.test.ts',
  'test/template/queue-revalidation.test.ts',
  'test/template/queue.test.ts',
  'test/template/revalidate.test.ts',
  'test/template/revalidation-evidence.test.ts',
  'test/template/review-fixes.test.ts',
  'test/template/root-ci.test.ts',
  'test/template/run-journal.test.ts',
  'test/template/secrets-lib.test.ts',
  'test/template/skills.test.ts',
  'test/template/validate-no-secrets.test.ts',
] as const;

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

  it('names every temporary Windows exclusion individually', async () => {
    const windows = job(await workflow('ci.yml'), 'windows-unit');
    const exclusions = [...commandText(windows).matchAll(/--exclude(?:=|\s+)["']?([^\s"']+)/g)]
      .map((match) => match[1] ?? '')
      .sort();
    expect(exclusions).toEqual([...WINDOWS_INCOMPATIBLE_TESTS].sort());
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

  it('runs on pull requests only when CLI or template inputs change', async () => {
    const yaml = await expensiveWorkflow();
    const pullRequest = yaml.match(/^ {2}pull_request:\n([\s\S]*?)(?=^ {2}[\w-]+:|^jobs:)/m);
    expect(pullRequest, 'expensive workflow has no pull_request trigger').not.toBeNull();
    const paths = [...(pullRequest?.[0] ?? '').matchAll(/^ {6}-\s*['"]?(.+?)['"]?\s*$/gm)].map(
      (match) => match[1],
    );
    expect(paths).toEqual(['packages/cli/**', 'templates/**']);
  });
});
