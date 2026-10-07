import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';
import { stubCommand, type StubHandle } from '../helpers/stub-command.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const temporaryPaths = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryPaths].map((temporaryPath) => removeFixture(temporaryPath)));
  temporaryPaths.clear();
});

const runQueue = (
  scriptPath: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string; out: string }> =>
  new Promise((resolve) => {
    execFile(process.execPath, [scriptPath, ...args], { cwd }, (error, stdout, stderr) => {
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        stdout,
        stderr,
        out: stdout + stderr,
      });
    });
  });

const TASKS = [
  '# Tasks: Export',
  '',
  '## Phase 1: Setup',
  '',
  '- [ ] T001 Create the export configuration',
  '- [ ] T002 Generate exports (depends on T001)',
  '- [ ] T003 Document why T002 exists',
  '',
].join('\n');

const scratchProject = async (
  tasks = TASKS,
): Promise<{ dir: string; scriptPath: string; tasksPath: string }> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spec-kit-import-'));
  temporaryPaths.add(dir);
  await cp(path.join(universal, '.claude', 'scripts'), path.join(dir, '.claude', 'scripts'), {
    recursive: true,
  });
  const tasksPath = path.join(dir, 'specs', '001-export', 'tasks.md');
  await mkdir(path.dirname(tasksPath), { recursive: true });
  await writeFile(tasksPath, tasks);
  return { dir, scriptPath: path.join(dir, '.claude', 'scripts', 'queue', 'index.mjs'), tasksPath };
};

const everyGitHubCommandRunsFromProject = (cwdCalls: string[], projectCwd: string): boolean => {
  const canonicalProjectCwd = realpathSync.native(projectCwd);
  return cwdCalls.every((cwd) => realpathSync.native(cwd) === canonicalProjectCwd);
};

type FakeIssue = { number: number; title: string; body: string; labels?: string[]; state?: string };

/** A tiny persistent `gh` repository: enough to observe import effects across two runs. */
const installGh = async (
  issues: FakeIssue[] = [],
  {
    failCreate = false,
    // RP-441 — lets a test make `issue create` fail for a reason OTHER than
    // the title bound below, with GitHub's own stderr shape, so the importer
    // can be pinned on surfacing that reason rather than only "failed (exit 1)".
    createErrorStderr = null,
  }: { failCreate?: boolean; createErrorStderr?: string | null } = {},
): Promise<{
  stub: StubHandle;
  state: () => Promise<{ issues: FakeIssue[] }>;
  calls: () => Promise<string[][]>;
  cwdCalls: () => Promise<string[]>;
}> => {
  const bin = await mkdtemp(path.join(tmpdir(), 'stub-gh-spec-kit-import-'));
  temporaryPaths.add(bin);
  const statePath = path.join(bin, 'state.json');
  const callsPath = path.join(bin, 'calls.log');
  const cwdPath = path.join(bin, 'cwd.log');
  await writeFile(statePath, JSON.stringify({ nextNumber: 41, issues, labels: [] }));
  const stub = await stubCommand(
    'gh',
    `const fs = require('node:fs');
     const statePath = ${JSON.stringify(statePath)};
     const callsPath = ${JSON.stringify(callsPath)};
     const cwdPath = ${JSON.stringify(cwdPath)};
     const failCreate = ${JSON.stringify(failCreate)};
     const createErrorStderr = ${JSON.stringify(createErrorStderr)};
     const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
     fs.appendFileSync(callsPath, JSON.stringify(args) + '\\n');
     fs.appendFileSync(cwdPath, process.cwd() + '\\n');
     const valueAfter = (flag) => { const index = args.indexOf(flag); return index === -1 ? null : args[index + 1]; };
     const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
     // RP-441 — the independent oracle this suite checks the importer's title
     // bound against: GitHub's OWN limit, reproduced here straight from the
     // live defect report's stderr ("GraphQL: Title is too long (maximum is
     // 256 characters) (createIssue)"), never imported from the production
     // bound this file exists to pin. Counted by '.length' (UTF-16 code
     // units) — GitHub enforces the 256-character limit on characters, and a
     // lone surrogate half still counts as one toward that total, the same as
     // any other UTF-16 code unit.
     if (args[0] === 'issue' && (args[1] === 'create' || args[1] === 'edit')) {
       const titleArgument = valueAfter('--title');
       if (titleArgument !== null && titleArgument.length > 256) {
         const operation = args[1] === 'create' ? 'createIssue' : 'updateIssue';
         process.stderr.write('GraphQL: Title is too long (maximum is 256 characters) (' + operation + ')\\n');
         return { exitCode: 1 };
       }
     }
     if (args[0] === 'label' && args[1] === 'list') return { stdout: JSON.stringify(state.labels.map((name) => ({ name }))) + '\\n' };
     if (args[0] === 'label' && args[1] === 'create') {
       const label = valueAfter('--name') || args[2];
       if (label && !state.labels.includes(label)) state.labels.push(label);
       save();
       return { stdout: '' };
     }
     if (args[0] === 'issue' && args[1] === 'list') return { stdout: JSON.stringify(state.issues) + '\\n' };
     if (args[0] === 'issue' && args[1] === 'create') {
       if (createErrorStderr) {
         process.stderr.write(createErrorStderr + '\\n');
         return { stdout: '', exitCode: 1 };
       }
       if (failCreate) return { stdout: '', exitCode: 1 };
       const issue = {
         number: state.nextNumber++,
         title: valueAfter('--title') || '',
         body: valueAfter('--body') || '',
         labels: valueAfter('--label') ? [valueAfter('--label')] : [],
         state: 'OPEN',
       };
       state.issues.push(issue);
       save();
       return { stdout: 'https://github.test/owner/repo/issues/' + issue.number + '\\n' };
     }
     if (args[0] === 'issue' && args[1] === 'view') {
       const id = Number(String(args[2] || '').split('/').pop());
       const issue = state.issues.find((candidate) => candidate.number === id);
       return { stdout: JSON.stringify(issue || {}) + '\\n' };
     }
     if (args[0] === 'issue' && args[1] === 'edit') {
       const issue = state.issues.find((candidate) => candidate.number === Number(args[2]));
       if (issue) {
         const body = valueAfter('--body');
         const title = valueAfter('--title');
         if (body !== null) issue.body = body;
         if (title !== null) issue.title = title;
         save();
       }
       return { stdout: '' };
     }
     return { stdout: '' };`,
  );
  return {
    stub,
    state: async () => JSON.parse(await readFile(statePath, 'utf8')) as { issues: FakeIssue[] },
    calls: async () => {
      try {
        return (await readFile(callsPath, 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    cwdCalls: async () => {
      try {
        return (await readFile(cwdPath, 'utf8')).split('\n').filter(Boolean);
      } catch {
        return [];
      }
    },
  };
};

describe('queue import spec-kit --to github-issues (RP-275)', () => {
  it('dry-runs deterministic task identities and only projects explicit task dependencies', async () => {
    const { dir, scriptPath } = await scratchProject();
    const github = await installGh();
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--dry-run', '--json'],
        dir,
      );

      expect(result.code, result.out).toBe(0);
      const report = JSON.parse(result.stdout) as {
        dryRun: boolean;
        source: string;
        target: string;
        taskCount: number;
        dependencyCount: number;
        counts: { create: number; update: number; unchanged: number };
        changes: Array<{ identity: string; action: string; dependencies: string[] }>;
      };
      expect(report).toMatchObject({
        dryRun: true,
        source: 'spec-kit',
        target: 'github-issues',
        taskCount: 3,
        dependencyCount: 1,
        counts: { create: 3, update: 0, unchanged: 0 },
        changes: [
          { identity: '001-export:T001', action: 'create', dependencies: [] },
          {
            identity: '001-export:T002',
            action: 'create',
            dependencies: ['001-export:T001'],
          },
          { identity: '001-export:T003', action: 'create', dependencies: [] },
        ],
      });
      expect(await github.calls()).toEqual([expect.arrayContaining(['issue', 'list'])]);
    } finally {
      github.stub.restore();
    }
  });

  it('creates blockers only after GitHub numbers exist, then leaves an identical reimport unchanged', async () => {
    const { dir, scriptPath } = await scratchProject();
    const github = await installGh();
    try {
      const first = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--json'],
        dir,
      );
      expect(first.code, first.out).toBe(0);

      const afterFirst = await github.state();
      expect(afterFirst.issues).toHaveLength(3);
      const firstTask = afterFirst.issues.find((issue) => issue.body.includes('001-export:T001'));
      const secondTask = afterFirst.issues.find((issue) => issue.body.includes('001-export:T002'));
      expect(firstTask).toBeTruthy();
      expect(secondTask?.body).toContain(`Blocked by #${firstTask?.number}`);
      expect(afterFirst.issues.every((issue) => issue.labels?.includes('rig-spec-kit'))).toBe(true);
      const firstImportCalls = await github.calls();
      const dependentCreate = firstImportCalls.find(
        (call) => call[0] === 'issue' && call[1] === 'create' && call.includes('Generate exports'),
      );
      expect(
        dependentCreate?.some((argument) => argument.includes(`Blocked by #${firstTask?.number}`)),
      ).toBe(true);
      expect(firstImportCalls.filter((call) => call[0] === 'issue' && call[1] === 'edit')).toEqual(
        [],
      );

      const second = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--json'],
        dir,
      );
      expect(second.code, second.out).toBe(0);
      expect(JSON.parse(second.stdout)).toMatchObject({
        counts: { create: 0, update: 0, unchanged: 3 },
      });
      expect((await github.state()).issues).toEqual(afterFirst.issues);
    } finally {
      github.stub.restore();
    }
  });

  it('updates only the existing task whose source text changed on reimport', async () => {
    const { dir, scriptPath, tasksPath } = await scratchProject();
    const github = await installGh();
    try {
      expect(
        (await runQueue(scriptPath, ['import', 'spec-kit', '--to', 'github-issues', '--json'], dir))
          .code,
      ).toBe(0);
      await writeFile(tasksPath, TASKS.replace('Generate exports', 'Generate audited exports'));

      const reimport = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--json'],
        dir,
      );

      expect(reimport.code, reimport.out).toBe(0);
      expect(JSON.parse(reimport.stdout)).toMatchObject({
        counts: { create: 0, update: 1, unchanged: 2 },
        changes: [expect.objectContaining({ identity: '001-export:T002', action: 'update' })],
      });
      const issues = (await github.state()).issues;
      expect(issues.find((issue) => issue.body.includes('001-export:T002'))?.body).toContain(
        'Generate audited exports',
      );
    } finally {
      github.stub.restore();
    }
  });

  it('refuses duplicate or malformed task identifiers before contacting GitHub', async () => {
    for (const tasks of [
      TASKS.replace('T002 Generate exports', 'T001 Generate exports'),
      TASKS.replace('T002 Generate exports', 'T02 Generate exports'),
    ]) {
      const { dir, scriptPath } = await scratchProject(tasks);
      const github = await installGh();
      try {
        const result = await runQueue(
          scriptPath,
          ['import', 'spec-kit', '--to', 'github-issues', '--dry-run', '--json'],
          dir,
        );
        expect(result.code, result.out).toBe(1);
        expect(result.out).toMatch(/duplicate|malformed|task id/i);
        expect(await github.calls()).toEqual([]);
      } finally {
        github.stub.restore();
      }
    }
  });

  it('refuses an ambiguous existing projected identity before it writes GitHub', async () => {
    const { dir, scriptPath } = await scratchProject();
    const github = await installGh([
      {
        number: 7,
        title: 'Export configuration',
        body: '<!-- rig-spec-kit-task:001-export:T001 -->',
        labels: ['rig-spec-kit'],
      },
      {
        number: 8,
        title: 'Second export configuration',
        body: '<!-- rig-spec-kit-task:001-export:T001 -->',
        labels: ['rig-spec-kit'],
      },
    ]);
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--json'],
        dir,
      );

      expect(result.code, result.out).toBe(1);
      expect(result.out).toMatch(/ambiguous.*001-export:T001|001-export:T001.*ambiguous/i);
      expect(
        (await github.calls()).filter(
          (call) => call[0] === 'issue' && (call[1] === 'create' || call[1] === 'edit'),
        ),
      ).toEqual([]);
    } finally {
      github.stub.restore();
    }
  });

  it('refuses a megabytes-sized tasks.md before it contacts GitHub', async () => {
    const oversizedTasks = [
      '# Tasks: Oversized',
      '',
      `- [ ] T001 ${'x'.repeat(2 * 1024 * 1024)}`,
      '',
    ].join('\n');
    const { dir, scriptPath } = await scratchProject(oversizedTasks);
    const github = await installGh();
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--dry-run', '--json'],
        dir,
      );

      expect(result.code, result.out).toBe(1);
      expect(result.out).toMatch(/size|byte|limit|bounded/i);
      expect(await github.calls()).toEqual([]);
    } finally {
      github.stub.restore();
    }
  });

  it('dry-runs an existing trusted projection as updates and unchanged items without writes', async () => {
    const tasks = [
      '# Tasks: Export',
      '',
      '- [ ] T001 Create the export configuration',
      '- [ ] T002 Generate exports',
      '',
    ].join('\n');
    const { dir, scriptPath } = await scratchProject(tasks);
    const github = await installGh([
      {
        number: 41,
        title: 'Create the export configuration',
        body: '<!-- rig-spec-kit-task:001-export:T001 -->\n\nCreate the export configuration',
        labels: ['rig-spec-kit'],
      },
      {
        number: 42,
        title: 'Old export generation',
        body: '<!-- rig-spec-kit-task:001-export:T002 -->\n\nOld export generation',
        labels: ['rig-spec-kit'],
      },
    ]);
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--dry-run', '--json'],
        dir,
      );

      expect(result.code, result.out).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        counts: { create: 0, update: 1, unchanged: 1 },
        changes: [expect.objectContaining({ identity: '001-export:T002', action: 'update' })],
      });
      expect(
        (await github.calls()).filter(
          (call) => call[0] === 'issue' && (call[1] === 'create' || call[1] === 'edit'),
        ),
      ).toEqual([]);
    } finally {
      github.stub.restore();
    }
  });

  it('plans an existing task update that depends on a new task without requiring the new issue number', async () => {
    const tasks = [
      '# Tasks: Export',
      '',
      '- [ ] T002 Generate exports (depends on T004)',
      '- [ ] T004 Generate the new prerequisite',
      '',
    ].join('\n');
    const { dir, scriptPath } = await scratchProject(tasks);
    const github = await installGh([
      {
        number: 42,
        title: 'Generate exports',
        body: '<!-- rig-spec-kit-task:001-export:T002 -->\n\nGenerate exports',
        labels: ['rig-spec-kit'],
      },
    ]);
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--dry-run', '--json'],
        dir,
      );

      expect(result.code, result.out).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        counts: { create: 1, update: 1, unchanged: 0 },
        changes: [
          expect.objectContaining({ identity: '001-export:T002', action: 'update' }),
          expect.objectContaining({ identity: '001-export:T004', action: 'create' }),
        ],
      });
      expect(
        (await github.calls()).filter(
          (call) => call[0] === 'issue' && (call[1] === 'create' || call[1] === 'edit'),
        ),
      ).toEqual([]);
    } finally {
      github.stub.restore();
    }
  });

  it('refuses an explicit dependency whose task identifier is not T### before contacting GitHub', async () => {
    const { dir, scriptPath } = await scratchProject(
      TASKS.replace('depends on T001', 'depends on T01'),
    );
    const github = await installGh();
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--dry-run', '--json'],
        dir,
      );

      expect(result.code, result.out).toBe(1);
      expect(result.out).toMatch(/depend|malformed|T###/i);
      expect(await github.calls()).toEqual([]);
    } finally {
      github.stub.restore();
    }
  });

  it('refuses an unclosed explicit dependency suffix before contacting GitHub', async () => {
    const { dir, scriptPath } = await scratchProject(
      TASKS.replace('(depends on T001)', '(depends on T001'),
    );
    const github = await installGh();
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--dry-run', '--json'],
        dir,
      );

      expect(result.code, result.out).toBe(1);
      expect(result.out).toMatch(/depend|malformed|unclosed/i);
      expect(await github.calls()).toEqual([]);
    } finally {
      github.stub.restore();
    }
  });

  it('refuses an unknown import flag before it can turn a dry-run typo into GitHub writes', async () => {
    const { dir, scriptPath } = await scratchProject();
    const github = await installGh();
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--dryrun', '--json'],
        dir,
      );

      expect(result.code, result.out).toBe(1);
      expect(result.out).toMatch(/unknown|flag|usage|dryrun/i);
      expect(await github.calls()).toEqual([]);
    } finally {
      github.stub.restore();
    }
  });

  it('refuses extra positional and unsupported import options before contacting GitHub', async () => {
    const cases: Array<[string, string[]]> = [
      ['an extra positional argument', ['dry-run']],
      ['a queue configuration option', ['--config', 'queue.json']],
      ['a branch option', ['--branch', 'main']],
    ];
    for (const [, extra] of cases) {
      const { dir, scriptPath } = await scratchProject();
      const github = await installGh();
      try {
        const result = await runQueue(
          scriptPath,
          ['import', 'spec-kit', '--to', 'github-issues', ...extra, '--json'],
          dir,
        );

        expect(result.code, result.out).toBe(1);
        expect(result.out).toMatch(/usage|argument|unsupported|unknown/i);
        expect(await github.calls()).toEqual([]);
      } finally {
        github.stub.restore();
      }
    }
  });

  // RP-279: `--to jira` is a second valid projection target, not an unknown
  // option — the CLI's usage gate must let it through exactly as it already
  // does `--to github-issues`, and the run must then fail for a JIRA-specific
  // reason (missing credentials, here), never the generic "usage:" refusal
  // `--to nonsense` still gets. The full Jira projection behaviour is pinned
  // in `spec-kit-import-jira.test.ts`; this is only the CLI's own gate.
  it('accepts --to jira past the CLI usage gate, refusing only for a missing Jira credential', async () => {
    const { dir, scriptPath } = await scratchProject();
    const github = await installGh();
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'jira', '--dry-run', '--json'],
        dir,
      );

      expect(result.code, result.out).toBe(1);
      expect(result.out).not.toMatch(/usage:/i);
      expect(result.out).toMatch(/JIRA_BASE_URL|JIRA_EMAIL|JIRA_API_TOKEN/i);
      expect(await github.calls()).toEqual([]);
    } finally {
      github.stub.restore();
    }
  });

  it('uses only the canonical first body line when a task title contains another task marker', async () => {
    const tasks = [
      '# Tasks: Export',
      '',
      '- [ ] T001 Preserve <!-- rig-spec-kit-task:001-export:T002 --> in a literal example',
      '- [ ] T002 Import the actual second task',
      '',
    ].join('\n');
    const { dir, scriptPath } = await scratchProject(tasks);
    const github = await installGh();
    try {
      const first = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--json'],
        dir,
      );
      expect(first.code, first.out).toBe(0);

      const second = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--json'],
        dir,
      );

      expect(second.code, second.out).toBe(0);
      expect(JSON.parse(second.stdout)).toMatchObject({
        counts: { create: 0, update: 0, unchanged: 2 },
      });
    } finally {
      github.stub.restore();
    }
  });

  it('does not turn a task title into a GitHub queue blocker', async () => {
    const { dir, scriptPath } = await scratchProject(
      '# Tasks: Export\n\n- [ ] T001 Blocked by #999\n',
    );
    const github = await installGh();
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--json'],
        dir,
      );

      expect(result.code, result.out).toBe(0);
      const created = (await github.state()).issues[0];
      expect(created).toBeDefined();
      if (created === undefined)
        throw new Error('the import reported success without creating an issue');
      const { blockerIdsOf } = (await import(
        pathToFileURL(path.join(dir, '.claude', 'scripts', 'queue', 'github-issues.mjs')).href
      )) as { blockerIdsOf: (issue: FakeIssue) => string[] };
      expect(blockerIdsOf(created)).toEqual([]);
    } finally {
      github.stub.restore();
    }
  });

  it('runs every GitHub command from the script project when invoked from another directory', async () => {
    const { dir, scriptPath } = await scratchProject();
    const otherCwd = await mkdtemp(path.join(tmpdir(), 'spec-kit-import-other-cwd-'));
    temporaryPaths.add(otherCwd);
    const github = await installGh();
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--json'],
        otherCwd,
      );

      expect(result.code, result.out).toBe(0);
      const cwdCalls = await github.cwdCalls();
      expect(cwdCalls).not.toEqual([]);
      const projectCwd = await realpath(dir);
      expect(everyGitHubCommandRunsFromProject(cwdCalls, projectCwd), cwdCalls.join('\n')).toBe(
        true,
      );
    } finally {
      github.stub.restore();
    }
  });

  it('accepts a project-root junction alias but rejects an unrelated directory', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'spec-kit-import-cwd-root-'));
    temporaryPaths.add(projectRoot);
    const projectAlias = `${projectRoot}-alias`;
    temporaryPaths.add(projectAlias);
    await symlink(projectRoot, projectAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const unrelatedRoot = await mkdtemp(path.join(tmpdir(), 'spec-kit-import-cwd-unrelated-'));
    temporaryPaths.add(unrelatedRoot);
    const canonicalProjectRoot = await realpath(projectRoot);

    expect(everyGitHubCommandRunsFromProject([projectAlias], canonicalProjectRoot)).toBe(true);
    expect(everyGitHubCommandRunsFromProject([unrelatedRoot], canonicalProjectRoot)).toBe(false);
  });

  it('refuses a specs feature symlink that points outside the project before contacting GitHub', async () => {
    const { dir, scriptPath } = await scratchProject();
    const outside = await mkdtemp(path.join(tmpdir(), 'spec-kit-import-outside-'));
    temporaryPaths.add(outside);
    await writeFile(path.join(outside, 'tasks.md'), TASKS);
    await removeFixture(path.join(dir, 'specs', '001-export'));
    await symlink(
      outside,
      path.join(dir, 'specs', '001-export'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const github = await installGh();
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--dry-run', '--json'],
        dir,
      );

      expect(result.code, result.out).toBe(1);
      expect(result.out).toMatch(/specs|symlink|tasks\.md/i);
      expect(await github.calls()).toEqual([]);
    } finally {
      github.stub.restore();
    }
  });

  it('refuses a specs root symlink that points outside the project before contacting GitHub', async () => {
    const { dir, scriptPath } = await scratchProject();
    const outsideSpecs = await mkdtemp(path.join(tmpdir(), 'spec-kit-import-outside-specs-'));
    temporaryPaths.add(outsideSpecs);
    const outsideTasks = path.join(outsideSpecs, '001-export', 'tasks.md');
    await mkdir(path.dirname(outsideTasks), { recursive: true });
    await writeFile(outsideTasks, TASKS);
    await removeFixture(path.join(dir, 'specs'));
    await symlink(
      outsideSpecs,
      path.join(dir, 'specs'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const github = await installGh();
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--dry-run', '--json'],
        dir,
      );

      expect(result.code, result.out).toBe(1);
      expect(result.out).toMatch(/specs|symlink|outside/i);
      expect(await github.calls()).toEqual([]);
    } finally {
      github.stub.restore();
    }
  });

  it('does not trust or edit a marker copied onto an unrelated GitHub issue', async () => {
    const { dir, scriptPath } = await scratchProject(
      '# Tasks: Export\n\n- [ ] T001 Create the export configuration\n',
    );
    const spoofed: FakeIssue = {
      number: 7,
      title: 'User-owned issue',
      body: '<!-- rig-spec-kit-task:001-export:T001 -->\n\nKeep this user issue intact',
      labels: [],
    };
    const github = await installGh([spoofed]);
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--json'],
        dir,
      );

      expect(result.code, result.out).toBe(0);
      const issues = (await github.state()).issues;
      expect(issues).toHaveLength(2);
      expect(issues.find((issue) => issue.number === spoofed.number)).toMatchObject(spoofed);
      expect(issues.find((issue) => issue.number !== spoofed.number)?.labels).toContain(
        'rig-spec-kit',
      );
      expect(
        (await github.calls()).filter(
          (call) => call[0] === 'issue' && call[1] === 'edit' && call[2] === '7',
        ),
      ).toEqual([]);
    } finally {
      github.stub.restore();
    }
  });

  it('accepts the upstream T1000 task identity in a dry-run projection', async () => {
    const { dir, scriptPath } = await scratchProject(
      '# Tasks: Export\n\n- [ ] T1000 Import a four-digit task\n',
    );
    const github = await installGh();
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--dry-run', '--json'],
        dir,
      );

      expect(result.code, result.out).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        taskCount: 1,
        dependencyCount: 0,
        counts: { create: 1, update: 0, unchanged: 0 },
        changes: [expect.objectContaining({ identity: '001-export:T1000', action: 'create' })],
      });
    } finally {
      github.stub.restore();
    }
  });

  it('imports an explicitly selected tasks.md when several feature directories exist', async () => {
    const { dir, scriptPath } = await scratchProject();
    const selectedTasks = path.join(dir, 'specs', '002-selected', 'tasks.md');
    await mkdir(path.dirname(selectedTasks), { recursive: true });
    await writeFile(selectedTasks, '# Tasks: Selected\n\n- [ ] T001 Import only this feature\n');
    const github = await installGh();
    try {
      const result = await runQueue(
        scriptPath,
        [
          'import',
          'spec-kit',
          '--to',
          'github-issues',
          '--tasks',
          'specs/002-selected/tasks.md',
          '--dry-run',
          '--json',
        ],
        dir,
      );

      expect(result.code, result.out).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        taskCount: 1,
        changes: [expect.objectContaining({ identity: '002-selected:T001', action: 'create' })],
      });
    } finally {
      github.stub.restore();
    }
  });

  it('refuses missing or project-escaping explicit tasks paths before contacting GitHub', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'spec-kit-import-explicit-outside-'));
    temporaryPaths.add(outside);
    await writeFile(
      path.join(outside, 'tasks.md'),
      '# Tasks: Outside\n\n- [ ] T001 Never import this\n',
    );
    for (const tasksPath of [
      'specs/missing/tasks.md',
      path.join('..', path.basename(outside), 'tasks.md'),
    ]) {
      const { dir, scriptPath } = await scratchProject();
      const github = await installGh();
      try {
        const result = await runQueue(
          scriptPath,
          [
            'import',
            'spec-kit',
            '--to',
            'github-issues',
            '--tasks',
            tasksPath,
            '--dry-run',
            '--json',
          ],
          dir,
        );

        expect(result.code, result.out).toBe(1);
        expect(result.out).toMatch(/tasks|path|project|refus/i);
        expect(await github.calls()).toEqual([]);
      } finally {
        github.stub.restore();
      }
    }
  });

  it('does not echo a task body when GitHub rejects its create request', async () => {
    const taskText = 'SENSITIVE_TASK_BODY_MUST_NOT_REACH_OUTPUT';
    const { dir, scriptPath } = await scratchProject(`# Tasks: Export\n\n- [ ] T001 ${taskText}\n`);
    const github = await installGh([], { failCreate: true });
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--json'],
        dir,
      );

      expect(result.code, result.out).toBe(1);
      expect(result.out).not.toContain(taskText);
    } finally {
      github.stub.restore();
    }
  });

  it('refuses task titles carrying standalone carriage-return or escape controls before contacting GitHub', async () => {
    for (const title of ['contains a carriage\rreturn', 'contains an escape\u001b[31msequence']) {
      const { dir, scriptPath } = await scratchProject(`# Tasks: Export\n\n- [ ] T001 ${title}\n`);
      const github = await installGh();
      try {
        const result = await runQueue(
          scriptPath,
          ['import', 'spec-kit', '--to', 'github-issues', '--dry-run', '--json'],
          dir,
        );

        expect(result.code, result.out).toBe(1);
        expect(await github.calls()).toEqual([]);
      } finally {
        github.stub.restore();
      }
    }
  });

  it('refuses an overlong single task description before contacting GitHub', async () => {
    const description = 'x'.repeat(128 * 1024);
    const { dir, scriptPath } = await scratchProject(
      `# Tasks: Export\n\n- [ ] T001 ${description}\n`,
    );
    const github = await installGh();
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--dry-run', '--json'],
        dir,
      );

      expect(result.code, result.out).toBe(1);
      expect(result.out).toMatch(/line|description|length|limit|bounded/i);
      expect(await github.calls()).toEqual([]);
    } finally {
      github.stub.restore();
    }
  });
});

// RP-441 — live defect from the RP-317 pilot: Spec Kit 1.0.8 writes task
// lines of thousands of characters (the pilot's T001 is 2423 characters),
// and the importer passes the whole line straight to `gh issue create
// --title`. GitHub refuses a title over 256 characters
// (`GraphQL: Title is too long (maximum is 256 characters) (createIssue)`,
// exit 1), and the importer today reports only
// "spec-kit import: GitHub issue create failed (exit 1)." — the title bound
// `jira.mjs`'s `boundedSummary` already applies to the Jira target
// (`.claude/scripts/queue/jira.mjs`, 255, never splitting a surrogate pair)
// has no GitHub-target counterpart.
//
// The oracle for "is this title too long" lives in the stub's own title
// check above (`installGh`), reproduced from GitHub's live stderr — these
// tests never call the production bound to compute their own expectation,
// per `invariants.md`'s independent-oracle rule.
describe('queue import spec-kit --to github-issues — GitHub title bound (RP-441)', () => {
  // A string long enough to straddle the 256-character cut while still
  // reading as one Spec Kit task description. 2400+ characters mirrors the
  // pilot's own 2423-character T001.
  const LONG_TASK_TEXT = 'Generate exports '.repeat(142).trim();

  it('imports a 2400+ character task line, bounding the issue title while keeping the full text in the body', async () => {
    expect(LONG_TASK_TEXT.length).toBeGreaterThanOrEqual(2400);
    const { dir, scriptPath } = await scratchProject(
      `# Tasks: Export\n\n- [ ] T001 ${LONG_TASK_TEXT}\n`,
    );
    const github = await installGh();
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--json'],
        dir,
      );

      expect(result.code, result.out).toBe(0);
      const issues = (await github.state()).issues;
      expect(issues).toHaveLength(1);
      const created = issues[0];
      expect(created).toBeDefined();
      if (!created) throw new Error('the import reported success without creating an issue');
      expect(created.title.length).toBeLessThanOrEqual(256);
      expect(LONG_TASK_TEXT.startsWith(created.title)).toBe(true);
      expect(created.body).toContain(LONG_TASK_TEXT);
    } finally {
      github.stub.restore();
    }
  });

  it('bounds a title whose 256-character cut would split a surrogate pair, leaving no lone high surrogate', async () => {
    // index 0..254 are 'x' (255 code units), index 255 is the emoji's high
    // surrogate — so a naive `slice(0, 256)` ends exactly on the low half's
    // position, keeping only the high surrogate and splitting the pair.
    const straddling = `${'x'.repeat(255)}\u{1F600}${'y'.repeat(2200)}`;
    const { dir, scriptPath } = await scratchProject(
      `# Tasks: Export\n\n- [ ] T001 ${straddling}\n`,
    );
    const github = await installGh();
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--json'],
        dir,
      );

      expect(result.code, result.out).toBe(0);
      const created = (await github.state()).issues[0];
      expect(created).toBeDefined();
      if (!created) throw new Error('the import reported success without creating an issue');
      expect(created.title.length).toBeLessThanOrEqual(256);
      // Independent check: no cut may leave a lone high surrogate dangling at
      // the end — that is not valid UTF-16 text, and GitHub would refuse it
      // as malformed JSON content the same way a raw cut would.
      expect(/[\uD800-\uDBFF]$/.test(created.title)).toBe(false);
    } finally {
      github.stub.restore();
    }
  });

  it('reports a reimported long-title task unchanged, not a perpetual update', async () => {
    const { dir, scriptPath } = await scratchProject(
      `# Tasks: Export\n\n- [ ] T001 ${LONG_TASK_TEXT}\n`,
    );
    const github = await installGh();
    try {
      const first = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--json'],
        dir,
      );
      expect(first.code, first.out).toBe(0);

      const second = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--json'],
        dir,
      );

      expect(second.code, second.out).toBe(0);
      expect(JSON.parse(second.stdout)).toMatchObject({
        counts: { create: 0, update: 0, unchanged: 1 },
      });
      expect(
        (await github.calls()).filter((call) => call[0] === 'issue' && call[1] === 'edit'),
      ).toEqual([]);
    } finally {
      github.stub.restore();
    }
  });

  // Pins existing behavior: no test elsewhere in this file asserts the
  // issue TITLE for an ordinary short task — only that something was
  // created. A title bound fix must not shorten or otherwise alter a title
  // that was never too long to begin with.
  it('still projects a short task description as the issue title verbatim', async () => {
    const { dir, scriptPath } = await scratchProject();
    const github = await installGh();
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--json'],
        dir,
      );

      expect(result.code, result.out).toBe(0);
      const issues = (await github.state()).issues;
      expect(issues.map((issue) => issue.title).sort()).toEqual(
        ['Create the export configuration', 'Generate exports', 'Document why T002 exists'].sort(),
      );
    } finally {
      github.stub.restore();
    }
  });

  it('names the GitHub-reported reason when issue create fails for something other than the title bound', async () => {
    const taskText = 'Create the export configuration';
    const { dir, scriptPath } = await scratchProject(`# Tasks: Export\n\n- [ ] T001 ${taskText}\n`);
    // RP-441 — the fix is expected to surface this through the same
    // `error.stderr` `execFileSync` already captures (`github-issues.mjs`'s
    // own `ghText` catches and rethrows on a `gh` failure, carrying it on
    // the thrown Error); `spec-kit-import.mjs`'s own `gh()` wrapper
    // currently discards `error.stderr` entirely and reports only
    // "failed (exit 1)". No existing helper bounds/redacts an arbitrary `gh`
    // stderr string in this tree — `jira.mjs`'s `boundedSummary` bounds a
    // TITLE, not a free-text error reason — so surfacing this is new
    // surface, not a reuse of one.
    const github = await installGh([], {
      createErrorStderr: "GraphQL: Could not resolve to a Repository with the name 'owner/repo'.",
    });
    try {
      const result = await runQueue(
        scriptPath,
        ['import', 'spec-kit', '--to', 'github-issues', '--json'],
        dir,
      );

      expect(result.code, result.out).toBe(1);
      expect(result.out).toContain('Could not resolve to a Repository');
      expect(result.out).not.toMatch(
        /^spec-kit import: GitHub issue create failed \(exit 1\)\.\s*$/m,
      );
    } finally {
      github.stub.restore();
    }
  });
});
