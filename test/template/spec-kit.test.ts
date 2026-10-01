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

it('fresh Spec Kit import prepares GitHub queue lifecycle labels', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'spec-kit-lifecycle-labels-'));
  temporaryPaths.add(project);
  await cp(path.join(universal, '.claude', 'scripts'), path.join(project, '.claude', 'scripts'), {
    recursive: true,
  });
  await mkdir(path.join(project, 'specs', '001-queue'), { recursive: true });
  await writeFile(
    path.join(project, 'specs', '001-queue', 'tasks.md'),
    ['# Tasks: Queue', '', '- [ ] T001 Make the queue claimable', ''].join('\n'),
  );

  const bin = await mkdtemp(path.join(tmpdir(), 'stub-gh-spec-kit-lifecycle-labels-'));
  temporaryPaths.add(bin);
  const statePath = path.join(bin, 'state.json');
  await writeFile(
    statePath,
    JSON.stringify({
      labels: Array.from(
        { length: 996 },
        (_, index) => `existing-${String(index).padStart(4, '0')}`,
      ),
      issues: [],
      nextNumber: 1,
    }),
  );
  const github: StubHandle = await stubCommand(
    'gh',
    `const fs = require('node:fs');
     const statePath = ${JSON.stringify(statePath)};
     const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
     const valueAfter = (flag) => { const index = args.indexOf(flag); return index === -1 ? null : args[index + 1]; };
     const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
     if (args[0] === 'label' && args[1] === 'list') return { stdout: JSON.stringify(state.labels.map((name) => ({ name }))) + '\\n' };
     if (args[0] === 'label' && args[1] === 'create') {
       const label = valueAfter('--name') || args[2];
       if (!label || state.labels.includes(label)) return { exitCode: 1 };
       state.labels.push(label);
       save();
       return { stdout: '' };
     }
     if (args[0] === 'issue' && args[1] === 'list') return { stdout: JSON.stringify(state.issues) + '\\n' };
     if (args[0] === 'issue' && args[1] === 'create') {
       const label = valueAfter('--label');
       const title = valueAfter('--title');
       const body = valueAfter('--body');
       if (!label || !title || !body || !state.labels.includes(label)) return { exitCode: 1 };
       state.issues.push({ number: state.nextNumber++, title, body, labels: [label] });
       save();
       return { stdout: 'https://github.test/owner/repo/issues/' + (state.nextNumber - 1) + '\\n' };
     }
     return { stdout: '' };`,
  );

  try {
    const script = path.join(project, '.claude', 'scripts', 'queue', 'index.mjs');
    const first = await runQueue(
      script,
      ['import', 'spec-kit', '--to', 'github-issues', '--json'],
      project,
    );

    expect(first.code, first.out).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ counts: { create: 1 } });
    const afterFirst = JSON.parse(await readFile(statePath, 'utf8')) as { labels: string[] };
    expect(afterFirst.labels).toHaveLength(1000);
    expect(afterFirst.labels.filter((label) => !label.startsWith('existing-')).sort()).toEqual([
      'escalated',
      'in-progress',
      'rig-spec-kit',
      'triage',
    ]);

    const second = await runQueue(
      script,
      ['import', 'spec-kit', '--to', 'github-issues', '--json'],
      project,
    );

    expect(second.code, second.out).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ counts: { unchanged: 1 } });
    const afterSecond = JSON.parse(await readFile(statePath, 'utf8')) as {
      labels: string[];
      issues: unknown[];
    };
    expect(afterSecond.labels).toHaveLength(1000);
    expect(afterSecond.issues).toHaveLength(1);

    await writeFile(
      statePath,
      JSON.stringify({
        labels: Array.from(
          { length: 997 },
          (_, index) => `existing-${String(index).padStart(4, '0')}`,
        ),
        issues: [],
        nextNumber: 1,
      }),
    );
    const overflow = await runQueue(
      script,
      ['import', 'spec-kit', '--to', 'github-issues', '--json'],
      project,
    );

    expect(overflow.code, overflow.out).not.toBe(0);
    const afterOverflow = JSON.parse(await readFile(statePath, 'utf8')) as {
      labels: string[];
      issues: unknown[];
    };
    expect(afterOverflow.labels).toHaveLength(997);
    expect(afterOverflow.issues).toHaveLength(0);
  } finally {
    github.restore();
  }
});
