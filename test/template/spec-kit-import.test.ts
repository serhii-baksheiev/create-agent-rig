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
  { failCreate = false }: { failCreate?: boolean } = {},
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
     const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
     fs.appendFileSync(callsPath, JSON.stringify(args) + '\\n');
     fs.appendFileSync(cwdPath, process.cwd() + '\\n');
     const valueAfter = (flag) => { const index = args.indexOf(flag); return index === -1 ? null : args[index + 1]; };
     const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
     if (args[0] === 'label' && args[1] === 'list') return { stdout: JSON.stringify(state.labels.map((name) => ({ name }))) + '\\n' };
     if (args[0] === 'label' && args[1] === 'create') {
       const label = valueAfter('--name') || args[2];
       if (label && !state.labels.includes(label)) state.labels.push(label);
       save();
       return { stdout: '' };
     }
     if (args[0] === 'issue' && args[1] === 'list') return { stdout: JSON.stringify(state.issues) + '\\n' };
     if (args[0] === 'issue' && args[1] === 'create') {
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
