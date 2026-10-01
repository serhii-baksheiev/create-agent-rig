import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { removeFixture } from '../helpers/remove-fixture.js';
import { stubCommand } from '../helpers/stub-command.js';

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

const scratchProject = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spec-kit-claim-'));
  temporaryPaths.add(dir);
  await cp(path.join(universal, '.claude', 'scripts'), path.join(dir, '.claude', 'scripts'), {
    recursive: true,
  });
  await mkdir(path.join(dir, 'specs', '001-queue'), { recursive: true });
  await writeFile(
    path.join(dir, 'specs', '001-queue', 'tasks.md'),
    ['# Tasks: Queue', '', '- [ ] T001 Make the queue claimable', ''].join('\n'),
  );
  return dir;
};

type GhState = {
  labels: string[];
  issues: Array<{
    number: number;
    title: string;
    body: string;
    state: 'OPEN';
    labels: string[];
    updatedAt: string;
    assignees: [];
  }>;
  events: Array<{
    event: 'labeled';
    label: { name: string };
    actor: { login: string };
    created_at: string;
  }>;
  nextNumber: number;
};

const installGithub = async ({ failLabel }: { failLabel?: string } = {}) => {
  const bin = await mkdtemp(path.join(tmpdir(), 'stub-gh-spec-kit-claim-'));
  temporaryPaths.add(bin);
  const statePath = path.join(bin, 'state.json');
  const callsPath = path.join(bin, 'calls.log');
  await writeFile(
    statePath,
    JSON.stringify({ labels: [], issues: [], events: [], nextNumber: 1 } satisfies GhState),
  );
  await writeFile(callsPath, '');
  const stub = await stubCommand(
    'gh',
    `const fs = require('node:fs');
     const statePath = ${JSON.stringify(statePath)};
     const callsPath = ${JSON.stringify(callsPath)};
     const failLabel = ${JSON.stringify(failLabel ?? null)};
     const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
     const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
     const valueAfter = (flag) => { const index = args.indexOf(flag); return index === -1 ? null : args[index + 1]; };
     fs.appendFileSync(callsPath, JSON.stringify(args) + '\\n');
     if (args[0] === 'label' && args[1] === 'list') return { stdout: JSON.stringify(state.labels.map((name) => ({ name }))) + '\\n' };
     if (args[0] === 'label' && args[1] === 'create') {
       const label = valueAfter('--name') || args[2];
       if (!label || label === failLabel || state.labels.includes(label)) return { exitCode: 1 };
       state.labels.push(label); save(); return { stdout: '' };
     }
     if (args[0] === 'issue' && args[1] === 'list') return { stdout: JSON.stringify(state.issues) + '\\n' };
     if (args[0] === 'issue' && args[1] === 'create') {
       const label = valueAfter('--label');
       if (!label || !state.labels.includes(label)) return { exitCode: 1 };
       const number = state.nextNumber++;
       state.issues.push({ number, title: valueAfter('--title') || '', body: valueAfter('--body') || '', state: 'OPEN', labels: [label], updatedAt: '2026-10-01T00:00:00.000Z', assignees: [] });
       save(); return { stdout: 'https://github.test/owner/repo/issues/' + number + '\\n' };
     }
     if (args[0] === 'issue' && args[1] === 'view') {
       const issue = state.issues.find((candidate) => candidate.number === Number(args[2]));
       if (!issue) return { exitCode: 1 };
       const fields = String(valueAfter('--json') || '').split(',');
       const output = {};
       for (const field of fields) {
         if (field === 'state') output.state = issue.state;
         if (field === 'labels') output.labels = issue.labels.map((name) => ({ name }));
         if (field === 'updatedAt') output.updatedAt = issue.updatedAt;
         if (field === 'assignees') output.assignees = issue.assignees;
       }
       return { stdout: JSON.stringify(output) + '\\n' };
     }
     if (args[0] === 'issue' && args[1] === 'edit') {
       const issue = state.issues.find((candidate) => candidate.number === Number(args[2]));
       const label = valueAfter('--add-label');
       if (!issue || label !== 'in-progress' || issue.labels.includes(label)) return { exitCode: 1 };
       issue.labels.push(label);
       state.events.push({ event: 'labeled', label: { name: label }, actor: { login: 'rig-controller' }, created_at: '2026-10-01T00:00:01.000Z' });
       save(); return { stdout: '' };
     }
     if (args[0] === 'api' && args[1] === 'user') return { stdout: 'rig-controller\\n' };
     if (args[0] === 'api' && String(args[1] || '').startsWith('repos/')) return { stdout: JSON.stringify(state.events) + '\\n' };
     return { exitCode: 64 };`,
  );
  return {
    stub,
    state: async () => JSON.parse(await readFile(statePath, 'utf8')) as GhState,
    calls: async () =>
      (await readFile(callsPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
  };
};

describe('Spec Kit imports queue-claimable GitHub issues (RP-329)', () => {
  it('provisions lifecycle labels before importing and lets the imported issue pass the normal verified claim', async () => {
    const project = await scratchProject();
    const github = await installGithub();
    try {
      const queuePath = path.join(project, '.claude', 'scripts', 'queue', 'index.mjs');
      const imported = await runQueue(
        queuePath,
        ['import', 'spec-kit', '--to', 'github-issues', '--json'],
        project,
      );
      expect(imported.code, imported.out).toBe(0);

      const beforeClaim = await github.state();
      expect(beforeClaim.labels).toEqual(
        expect.arrayContaining(['in-progress', 'escalated', 'triage', 'rig-spec-kit']),
      );
      const importedIssue = beforeClaim.issues[0];
      if (!importedIssue) throw new Error('test setup: Spec Kit import did not create its issue.');

      const { claim } = await import(
        `${pathToFileURL(path.join(project, '.claude', 'scripts', 'queue', 'github-issues.mjs')).href}?${Date.now()}`
      );
      const result = claim(
        {
          id: '1',
          updatedAt: importedIssue.updatedAt,
          labels: importedIssue.labels,
        },
        { projectRoot: project },
      );

      expect(result).toMatchObject({ ok: true, claimed: true });
      const claimedIssue = (await github.state()).issues[0];
      if (!claimedIssue)
        throw new Error('test setup: imported issue disappeared before claim readback.');
      expect(claimedIssue.labels).toContain('in-progress');
    } finally {
      github.stub.restore();
    }
  });

  it('refuses the import before issue creation when a required lifecycle label cannot be created', async () => {
    const project = await scratchProject();
    const github = await installGithub({ failLabel: 'triage' });
    try {
      const result = await runQueue(
        path.join(project, '.claude', 'scripts', 'queue', 'index.mjs'),
        ['import', 'spec-kit', '--to', 'github-issues', '--json'],
        project,
      );

      expect(result.code, result.out).toBe(1);
      expect(result.out).toMatch(/GitHub label create failed/i);
      expect((await github.state()).issues).toEqual([]);
      expect(
        (await github.calls()).some((call) => call[0] === 'issue' && call[1] === 'create'),
      ).toBe(false);
    } finally {
      github.stub.restore();
    }
  });
});
