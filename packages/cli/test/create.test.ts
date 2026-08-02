import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateError, createProject } from '../src/commands/create.js';
import { gitEnv } from '../src/lib/git-env.js';

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
    // …and so do agents: no CDK, no cdk-diff-reviewer
    await expect(
      readFile(path.join(projectDir, '.claude', 'agents', 'cdk-diff-reviewer.md'), 'utf8'),
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
    for (const agent of [
      'test-writer.md',
      'code-reviewer.md',
      'security-scanner.md',
      'prose-reviewer.md',
    ]) {
      const body = await readFile(path.join(projectDir, '.claude', 'agents', agent), 'utf8');
      expect(body).toMatch(/^---\nname: /); // agent frontmatter
    }
    await expect(
      readFile(path.join(projectDir, '.claude', 'hooks', 'guard-core-purity.mjs'), 'utf8'),
    ).resolves.toBeTruthy();
    // the default (aws-serverless) composition gets both skills…
    for (const skill of ['pr-ship', 'post-deploy-verify']) {
      await expect(
        readFile(path.join(projectDir, '.claude', 'skills', skill, 'SKILL.md'), 'utf8'),
      ).resolves.toBeTruthy();
    }
    // …and the stack-layer CDK diff gate
    await expect(
      readFile(path.join(projectDir, '.claude', 'agents', 'cdk-diff-reviewer.md'), 'utf8'),
    ).resolves.toBeTruthy();
  });

  it('ships the work-queue convention (PLAN.md with both queues)', async () => {
    const { projectDir } = await createProject('queued', { cwd: work, git: false });
    const plan = await readFile(path.join(projectDir, 'PLAN.md'), 'utf8');
    expect(plan).toContain('## Agent queue');
    expect(plan).toContain('## Operator queue');
    expect(plan).toContain('queued');
    expect(plan).not.toContain('__PROJECT_NAME__');
  });

  it('initialises git with a pristine-template baseline commit', async () => {
    const { projectDir } = await createProject('gitted', { cwd: work });
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    // sanitised like every git call in this file — under an inherited GIT_DIR
    // these would report on the repository running the suite, not on the
    // project just generated, and the assertion below would be meaningless
    const { stdout: log } = await exec('git', ['log', '--oneline'], {
      cwd: projectDir,
      env: gitEnv(),
    });
    expect(log.trim().split('\n')).toHaveLength(1);
    const { stdout: status } = await exec('git', ['status', '--porcelain'], {
      cwd: projectDir,
      env: gitEnv(),
    });
    expect(status.trim()).toBe(''); // everything generated is in the baseline
  });

  // Observed, twice, on this repo's own branches: git hands its hooks an
  // absolute GIT_DIR when the commit comes from a linked worktree, the
  // pre-commit suite inherits it, and the baseline commit of every generated
  // project in that run lands in the OUTER repository — on the branch being
  // committed. The generated project ends up with no .git at all.
  it('ignores an inherited git environment — the baseline is the new repo, never the caller’s', async () => {
    const outer = path.join(work, 'outer');
    await mkdir(outer, { recursive: true });
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const identity = ['-c', 'user.name=t', '-c', 'user.email=t@localhost'];
    // 🔴 This test's OWN git calls are sanitised, every one of them. It runs
    // under whatever environment the suite inherited — and when the suite is a
    // pre-commit hook in a linked worktree, that includes an absolute GIT_DIR.
    // Unsanitised, the setup below does not build a fixture: `git init` marks
    // the repository running the suite **bare** and the seed commit lands on
    // its checked-out branch. Both happened here, in the commit that added
    // this test.
    await exec('git', ['init', '--quiet'], { cwd: outer, env: gitEnv() });
    await writeFile(path.join(outer, 'seed.txt'), 'seed\n');
    await exec('git', [...identity, 'add', '-A'], { cwd: outer, env: gitEnv() });
    await exec('git', [...identity, 'commit', '--quiet', '-m', 'outer seed'], {
      cwd: outer,
      env: gitEnv(),
    });

    // The GIT_DIR under test is a LINKED WORKTREE's gitdir, not `outer/.git`,
    // because that is the shape the failure actually had — and only that shape
    // makes a redirected `git init` flip the parent repository to bare. Pointed
    // at a plain `.git`, the bare assertion below would pass either way and
    // pin nothing.
    const linked = path.join(work, 'linked');
    await exec('git', ['worktree', 'add', '--quiet', '--detach', linked], {
      cwd: outer,
      env: gitEnv(),
    });
    const worktreeGitDir = path.join(outer, '.git', 'worktrees', 'linked');

    // The inheritance under test, scoped to the one call that must survive it:
    // createProject reads process.env internally, so simulating it means
    // setting it — and setting it for no longer than that.
    const had = Object.prototype.hasOwnProperty.call(process.env, 'GIT_DIR');
    const previous = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = worktreeGitDir;
    let projectDir: string;
    try {
      ({ projectDir } = await createProject('gitted-under-git-dir', { cwd: work }));
    } finally {
      if (had) process.env['GIT_DIR'] = previous;
      else delete process.env['GIT_DIR'];
    }

    // the generated project got its own repository...
    await expect(stat(path.join(projectDir, '.git'))).resolves.toBeDefined();
    const { stdout: log } = await exec('git', ['log', '--oneline'], {
      cwd: projectDir,
      env: gitEnv(),
    });
    expect(log.trim().split('\n')).toHaveLength(1);
    // ...and the caller's repository was left exactly as it was
    const { stdout: outerLog } = await exec('git', ['log', '--oneline'], {
      cwd: outer,
      env: gitEnv(),
    });
    expect(outerLog.trim().split('\n')).toHaveLength(1);
    expect(outerLog).toContain('outer seed');
    const { stdout: bare } = await exec('git', ['config', '--get', 'core.bare'], {
      cwd: outer,
      env: gitEnv(),
    });
    expect(bare.trim()).toBe('false'); // a redirected `git init` flips this
  });

  it('skips git when asked, and generation still succeeds', async () => {
    const { projectDir } = await createProject('ungitted', { cwd: work, git: false });
    await expect(readFile(path.join(projectDir, '.git', 'HEAD'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(projectDir, 'package.json'), 'utf8')).resolves.toBeTruthy();
  });

  it('the scope substitution reaches the frontend (web brief §5)', async () => {
    for (const target of ['aws-serverless', 'node-service']) {
      const { projectDir } = await createProject(`web-${target}`, { cwd: work, target });
      const webPkg = JSON.parse(
        await readFile(path.join(projectDir, 'apps', 'web', 'package.json'), 'utf8'),
      );
      expect(webPkg.name, target).toBe(`@web-${target}/web`);
      expect(webPkg.dependencies[`@web-${target}/core`], target).toBe('workspace:*');
      const nextConfig = await readFile(
        path.join(projectDir, 'apps', 'web', 'next.config.mjs'),
        'utf8',
      );
      expect(nextConfig, target).toContain(`@web-${target}/core`);
      expect(nextConfig, target).not.toContain('@app/');
      // in-place web build artifacts never reach the generated project
      await expect(
        readFile(path.join(projectDir, 'apps', 'web', 'next-env.d.ts'), 'utf8'),
      ).rejects.toThrow();
    }
  });
});
