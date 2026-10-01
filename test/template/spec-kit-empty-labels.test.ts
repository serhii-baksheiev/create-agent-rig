import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
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
): Promise<{ code: number; stdout: string; out: string }> =>
  new Promise((resolve) => {
    execFile(process.execPath, [scriptPath, ...args], { cwd }, (error, stdout, stderr) => {
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        stdout,
        out: stdout + stderr,
      });
    });
  });

it('imports into a repository whose GitHub label list is empty', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spec-kit-empty-labels-'));
  temporaryPaths.add(dir);
  await cp(path.join(universal, '.claude', 'scripts'), path.join(dir, '.claude', 'scripts'), {
    recursive: true,
  });
  await mkdir(path.join(dir, 'specs', '001-empty-labels'), { recursive: true });
  await writeFile(
    path.join(dir, 'specs', '001-empty-labels', 'tasks.md'),
    [
      '# Tasks: Empty labels',
      '',
      '- [ ] T001 Create the base',
      '- [ ] T002 Add the first dependency (depends on T001)',
      '- [ ] T003 Add the second dependency (depends on T001)',
      '- [ ] T004 Join the dependencies (depends on T002, T003)',
      '- [ ] T005 Finish the projection (depends on T004)',
      '',
    ].join('\n'),
  );

  const bin = await mkdtemp(path.join(tmpdir(), 'stub-gh-empty-labels-'));
  temporaryPaths.add(bin);
  const statePath = path.join(bin, 'state.json');
  await writeFile(statePath, JSON.stringify({ nextNumber: 41, labels: [], issues: [] }));
  const github: StubHandle = await stubCommand(
    'gh',
    `const fs = require('node:fs');
     const statePath = ${JSON.stringify(statePath)};
     const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
     const valueAfter = (flag) => { const index = args.indexOf(flag); return index === -1 ? null : args[index + 1]; };
     const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
     if (args[0] === 'label' && args[1] === 'list') {
       return { stdout: state.labels.length === 0 ? '' : JSON.stringify(state.labels.map((name) => ({ name }))) + '\\n' };
     }
     if (args[0] === 'label' && args[1] === 'create') {
       state.labels.push(args[2]);
       save();
       return { stdout: '' };
     }
     if (args[0] === 'issue' && args[1] === 'list') return { stdout: JSON.stringify(state.issues) + '\\n' };
     if (args[0] === 'issue' && args[1] === 'create') {
       const issue = {
         number: state.nextNumber++,
         title: valueAfter('--title'),
         body: valueAfter('--body'),
         labels: [valueAfter('--label')],
         state: 'OPEN',
       };
       state.issues.push(issue);
       save();
       return { stdout: 'https://github.test/owner/repo/issues/' + issue.number + '\\n' };
     }
     return { stdout: '' };`,
  );

  try {
    const scriptPath = path.join(dir, '.claude', 'scripts', 'queue', 'index.mjs');
    const first = await runQueue(
      scriptPath,
      ['import', 'spec-kit', '--to', 'github-issues', '--json'],
      dir,
    );

    expect(first.code, first.out).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      taskCount: 5,
      dependencyCount: 5,
      counts: { create: 5, update: 0, unchanged: 0 },
    });
    const afterFirst = JSON.parse(await readFile(statePath, 'utf8')) as {
      labels: string[];
      issues: Array<{ number: number; body: string; labels: string[] }>;
    };
    expect(afterFirst.labels).toEqual(['rig-spec-kit']);
    expect(afterFirst.issues).toHaveLength(5);
    expect(afterFirst.issues.map((issue) => issue.labels)).toEqual([
      ['rig-spec-kit'],
      ['rig-spec-kit'],
      ['rig-spec-kit'],
      ['rig-spec-kit'],
      ['rig-spec-kit'],
    ]);
    expect(afterFirst.issues[1]?.body).toContain('Blocked by #41');
    expect(afterFirst.issues[2]?.body).toContain('Blocked by #41');
    expect(afterFirst.issues[3]?.body).toContain('Blocked by #42');
    expect(afterFirst.issues[3]?.body).toContain('Blocked by #43');
    expect(afterFirst.issues[4]?.body).toContain('Blocked by #44');

    const dryRun = await runQueue(
      scriptPath,
      ['import', 'spec-kit', '--to', 'github-issues', '--dry-run', '--json'],
      dir,
    );
    expect(dryRun.code, dryRun.out).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({
      counts: { create: 0, update: 0, unchanged: 5 },
    });

    const second = await runQueue(
      scriptPath,
      ['import', 'spec-kit', '--to', 'github-issues', '--json'],
      dir,
    );
    expect(second.code, second.out).toBe(0);
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual(afterFirst);
  } finally {
    github.restore();
  }
});
