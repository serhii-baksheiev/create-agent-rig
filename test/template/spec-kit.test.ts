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
  await writeFile(statePath, JSON.stringify({ labels: [], issues: [], nextNumber: 1 }));
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
       if (!label || !state.labels.includes(label)) return { exitCode: 1 };
       state.issues.push({ number: state.nextNumber++, labels: [label] });
       save();
       return { stdout: 'https://github.test/owner/repo/issues/' + (state.nextNumber - 1) + '\\n' };
     }
     return { stdout: '' };`,
  );

  try {
    const result = await runQueue(
      path.join(project, '.claude', 'scripts', 'queue', 'index.mjs'),
      ['import', 'spec-kit', '--to', 'github-issues', '--json'],
      project,
    );

    expect(result.code, result.out).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ counts: { create: 1 } });
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { labels: string[] };
    expect([...state.labels].sort()).toEqual([
      'escalated',
      'in-progress',
      'rig-spec-kit',
      'triage',
    ]);
  } finally {
    github.restore();
  }
});
