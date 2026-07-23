import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InitError, initProject, planInit } from '../src/commands/init.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-init-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('planInit — the dry-run plan (never writes)', () => {
  it('lists only the PROCESS layer, never architecture rules', async () => {
    const plan = await planInit(repo);
    const files = plan.files.map((f) => f.path);
    expect(files).toContain('.claude/rules/workflow.md');
    expect(files).toContain('.claude/rules/autonomy.md');
    // architecture assumes packages/core etc. — must NOT be installed into an
    // arbitrary existing repo
    expect(files).not.toContain('.claude/rules/architecture.md');
    expect(files.some((f) => f.includes('guard-core-purity'))).toBe(false);
    expect(files.some((f) => f.includes('guard-web-boundary'))).toBe(false);
    // process hooks travel fine
    expect(files.some((f) => f.includes('gate-stop-dod'))).toBe(true);
  });

  it('writes nothing', async () => {
    await planInit(repo);
    await expect(readFile(path.join(repo, '.claude', 'rules', 'workflow.md'))).rejects.toThrow();
  });

  it('flags an existing CLAUDE.md as a conflict, not a silent overwrite', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), '# my rules');
    const plan = await planInit(repo);
    expect(plan.conflicts).toContain('CLAUDE.md');
  });
});

describe('initProject — the install', () => {
  it('installs the process layer into an existing repo', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"existing"}');
    const result = await initProject(repo, {});
    expect(result.written.length).toBeGreaterThan(0);
    expect(await readFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'utf8')).toContain(
      'TDD',
    );
    // it never brought architecture rules
    await expect(
      readFile(path.join(repo, '.claude', 'rules', 'architecture.md')),
    ).rejects.toThrow();
  });

  it('refuses to clobber an existing CLAUDE.md unless forced', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), '# mine');
    await expect(initProject(repo, {})).rejects.toThrow(InitError);
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe('# mine');
  });

  it('never overwrites a pre-existing process file it did not write', async () => {
    await mkdir(path.join(repo, '.claude', 'rules'), { recursive: true });
    await writeFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'CUSTOM');
    const result = await initProject(repo, {});
    expect(await readFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'utf8')).toBe(
      'CUSTOM',
    );
    expect(result.skipped).toContain('.claude/rules/workflow.md');
  });

  it('a dry run writes nothing but reports the plan', async () => {
    const result = await initProject(repo, { dryRun: true });
    expect(result.written).toEqual([]);
    await expect(readFile(path.join(repo, '.claude', 'rules', 'workflow.md'))).rejects.toThrow();
    expect(result.plannedCount).toBeGreaterThan(0);
  });
});
