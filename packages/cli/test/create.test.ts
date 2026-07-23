import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateError, createProject } from '../src/commands/create.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'caf-create-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('createProject', () => {
  it('generates the default target into the given directory', async () => {
    const { projectDir } = await createProject('my-app', { cwd: work });
    expect(projectDir).toBe(path.join(work, 'my-app'));
    const pkg = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));
    expect(pkg.name).toContain('my-app');
    expect(pkg.name).not.toContain('@app/');
    const readme = await readFile(path.join(projectDir, 'README.md'), 'utf8');
    expect(readme).toContain('my-app');
    expect(readme).not.toContain('__PROJECT_NAME__');
  });

  it('accepts a nested path and uses its basename as the project name', async () => {
    const { projectDir, projectName } = await createProject(path.join('nested', 'my-app'), {
      cwd: work,
    });
    expect(projectName).toBe('my-app');
    expect(projectDir).toBe(path.join(work, 'nested', 'my-app'));
  });

  it('refuses when the target directory exists and is non-empty', async () => {
    await mkdir(path.join(work, 'busy'));
    await writeFile(path.join(work, 'busy', 'keep.txt'), 'x');
    await expect(createProject('busy', { cwd: work })).rejects.toThrow(CreateError);
    await expect(createProject('busy', { cwd: work })).rejects.toThrow(/not empty/i);
    // and the pre-existing file was not touched
    expect(await readFile(path.join(work, 'busy', 'keep.txt'), 'utf8')).toBe('x');
  });

  it('allows an existing but empty target directory', async () => {
    await mkdir(path.join(work, 'empty-dir'));
    const { projectDir } = await createProject('empty-dir', { cwd: work });
    await expect(readFile(path.join(projectDir, 'package.json'), 'utf8')).resolves.toBeTruthy();
  });

  it('refuses an invalid project name', async () => {
    await expect(createProject('My App!', { cwd: work })).rejects.toThrow(CreateError);
    await expect(createProject('My App!', { cwd: work })).rejects.toThrow(/name/i);
  });
});
