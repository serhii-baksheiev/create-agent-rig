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

  it('ships a .gitignore in every target (npm publish strips dotfile originals)', async () => {
    for (const target of ['aws-serverless', 'node-service']) {
      const { projectDir } = await createProject(`gi-${target}`, { cwd: work, target });
      const gitignore = await readFile(path.join(projectDir, '.gitignore'), 'utf8');
      expect(gitignore).toContain('node_modules');
      // the un-dotted source name must not leak into the generated project
      await expect(readFile(path.join(projectDir, 'gitignore'), 'utf8')).rejects.toThrow();
      // npm packaging metadata must not leak either
      await expect(readFile(path.join(projectDir, '.npmignore'), 'utf8')).rejects.toThrow();
    }
  });

  it('refuses an invalid project name', async () => {
    await expect(createProject('My App!', { cwd: work })).rejects.toThrow(CreateError);
    await expect(createProject('My App!', { cwd: work })).rejects.toThrow(/name/i);
  });

  it('generates the node-service target when asked', async () => {
    const { projectDir } = await createProject('svc', { cwd: work, target: 'node-service' });
    const pkg = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@svc/root');
    // same layers, no cloud:
    for (const p of ['packages/core/src', 'packages/db/src', 'services/worker/src']) {
      await expect(
        readFile(path.join(projectDir, p, 'index.ts'), 'utf8').catch(() => 'dir'),
      ).resolves.toBeTruthy();
    }
    await expect(readFile(path.join(projectDir, 'infra', 'cdk.json'), 'utf8')).rejects.toThrow();
    // agent-os composition: universal + node-ts, and NOT aws-cdk
    await expect(
      readFile(path.join(projectDir, '.claude', 'rules', 'node-ts.md'), 'utf8'),
    ).resolves.toBeTruthy();
    await expect(
      readFile(path.join(projectDir, '.claude', 'rules', 'aws-cdk.md'), 'utf8'),
    ).rejects.toThrow();
    // skills follow the same seam: pr-ship is universal, post-deploy-verify is
    // aws-cdk only — node-service has no deploy step, so it must not get it
    await expect(
      readFile(path.join(projectDir, '.claude', 'skills', 'pr-ship', 'SKILL.md'), 'utf8'),
    ).resolves.toBeTruthy();
    await expect(
      readFile(
        path.join(projectDir, '.claude', 'skills', 'post-deploy-verify', 'SKILL.md'),
        'utf8',
      ),
    ).rejects.toThrow();
  });

  it('refuses an unknown target, naming the known ones', async () => {
    await expect(createProject('x', { cwd: work, target: 'heroku' })).rejects.toThrow(CreateError);
    await expect(createProject('x', { cwd: work, target: 'heroku' })).rejects.toThrow(
      /aws-serverless.*node-service|node-service.*aws-serverless/s,
    );
  });

  it('overlays the agent operating system onto the generated project', async () => {
    const { projectDir } = await createProject('my-app', { cwd: work });

    const claudeMd = await readFile(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('my-app');
    expect(claudeMd).not.toContain('__PROJECT_NAME__');

    const settings = JSON.parse(
      await readFile(path.join(projectDir, '.claude', 'settings.json'), 'utf8'),
    );
    expect(settings.hooks?.PreToolUse?.length).toBeGreaterThan(0);

    // Composition: universal rules + the target's stack rules (PLAN.md phase 4).
    for (const rule of [
      'architecture.md',
      'workflow.md',
      'autonomy.md',
      'node-ts.md',
      'aws-cdk.md',
    ]) {
      await expect(
        readFile(path.join(projectDir, '.claude', 'rules', rule), 'utf8'),
      ).resolves.toBeTruthy();
    }
    for (const agent of ['test-writer.md', 'code-reviewer.md', 'security-scanner.md']) {
      const body = await readFile(path.join(projectDir, '.claude', 'agents', agent), 'utf8');
      expect(body).toMatch(/^---\nname: /); // agent frontmatter
    }
    await expect(
      readFile(path.join(projectDir, '.claude', 'hooks', 'guard-core-purity.mjs'), 'utf8'),
    ).resolves.toBeTruthy();
    // the default (aws-serverless) composition gets both skills
    for (const skill of ['pr-ship', 'post-deploy-verify']) {
      await expect(
        readFile(path.join(projectDir, '.claude', 'skills', skill, 'SKILL.md'), 'utf8'),
      ).resolves.toBeTruthy();
    }
  });
});
