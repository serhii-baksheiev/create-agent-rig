import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateError, createProject } from '../src/commands/create.js';
import { projectNameFor } from '../src/commands/init.js';
import { planUpgrade } from '../src/commands/upgrade.js';
import { gitEnv } from '../src/lib/git-env.js';
import { readManifest, sha256, writeManifest } from '../src/lib/manifest.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'caf-create-'));
});

afterEach(async () => {
  await removeFixture(work);
});

/**
 * RP-177: `create <dir>` is a thin convenience wrapper — `mkdir` → `git init`
 * → the same install `init` runs into an existing repo → the pristine
 * baseline commit. There is exactly one payload; these tests cover the
 * wrapper's own responsibilities (the directory, the name, git) and lean on
 * `init.test.ts` for the payload itself.
 */
describe('createProject', { timeout: 60_000 }, () => {
  it('makes the directory and installs the one payload into it', async () => {
    const { projectDir } = await createProject('my-app', { cwd: work });
    expect(projectDir).toBe(path.join(work, 'my-app'));
    // RP-186: AGENTS.md is the canonical, substituted rulebook; CLAUDE.md is
    // a short shim with no project-name token of its own to substitute.
    const agentsMd = await readFile(path.join(projectDir, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('my-app');
    expect(agentsMd).not.toContain('__PROJECT_NAME__');
    const claudeMd = await readFile(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).not.toContain('__PROJECT_NAME__');
    // no application scaffolding of any kind
    await expect(readFile(path.join(projectDir, 'package.json'), 'utf8')).rejects.toThrow();
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
    await expect(readFile(path.join(projectDir, 'CLAUDE.md'), 'utf8')).resolves.toBeTruthy();
  });

  it('refuses an invalid project name', async () => {
    await expect(createProject('My App!', { cwd: work })).rejects.toThrow(CreateError);
    await expect(createProject('My App!', { cwd: work })).rejects.toThrow(/name/i);
  });

  it('refuses a name with a trailing "-" or "." — projectNameFor would silently rewrite it', async () => {
    // The historical bug class this pattern exists to prevent: a name
    // `create` accepted and wrote everywhere, but that `init`'s own naming
    // (`projectNameFor`, used whenever no explicit identity is supplied)
    // would have stripped — making a freshly created rig fail to match its
    // own installed files on the very next `upgrade`.
    await expect(createProject('my-app-', { cwd: work })).rejects.toThrow(CreateError);
    await expect(createProject('my-app.', { cwd: work })).rejects.toThrow(CreateError);
  });

  it('writes a manifest of kind "init" — there is only one payload flavour', async () => {
    const { projectDir } = await createProject('my-app', { cwd: work, git: false });
    const manifest = await readManifest(projectDir);
    expect(manifest?.kind).toBe('init');
    expect(manifest?.stacks).toEqual([]);
    expect(manifest?.project).toEqual({ name: 'my-app', scope: 'my-app', region: '' });
  });

  it('carries exact raw-byte ownership from create through upgrade', async () => {
    const { projectDir } = await createProject('my-app', { cwd: work, git: false });
    const rel = '.claude/rules/workflow.md';
    const raw = Buffer.from([0xc3, 0x28, 0x0a]);
    await writeFile(path.join(projectDir, ...rel.split('/')), raw);

    const manifest = await readManifest(projectDir);
    if (manifest === null) throw new Error('fixture: create wrote no manifest');
    manifest.files[rel] = sha256(raw);
    await writeManifest(projectDir, manifest);

    expect(sha256(raw)).not.toBe(sha256(raw.toString('utf8')));
    const plan = await planUpgrade(projectDir);
    expect(plan.actions.find((action) => action.rel === rel)?.verdict).toBe('update');
  });

  it('the validated name reaches the manifest and the files exactly, with no re-derivation', async () => {
    // `projectNameFor` would slug this identically here, so the fixture alone
    // cannot tell "used the validated name" from "re-derived from the
    // directory" — the two happen to agree. What matters is that they need
    // not: the option threading in `initProject` is what's under test.
    const { projectDir, projectName } = await createProject('svc', { cwd: work, git: false });
    expect(projectName).toBe(projectNameFor(projectDir));
    const manifest = await readManifest(projectDir);
    expect(manifest?.project.name).toBe('svc');
  });

  it('overlays the agent operating system — no architecture rules, no stack overlays', async () => {
    const { projectDir } = await createProject('my-app', { cwd: work, git: false });

    const settings = JSON.parse(
      await readFile(path.join(projectDir, '.claude', 'settings.json'), 'utf8'),
    );
    expect(settings.hooks?.PreToolUse?.length).toBeGreaterThan(0);
    const codexHooks = JSON.parse(
      await readFile(path.join(projectDir, '.codex', 'hooks.json'), 'utf8'),
    );
    expect(
      codexHooks.hooks?.PreToolUse?.some((group: { matcher?: string }) =>
        group.matcher?.includes('apply_patch'),
      ),
    ).toBe(true);

    for (const rule of ['workflow.md', 'autonomy.md', 'invariants.md']) {
      await expect(
        readFile(path.join(projectDir, '.claude', 'rules', rule), 'utf8'),
      ).resolves.toBeTruthy();
    }
    // the architecture group is retired outright — never installed by anything
    await expect(
      readFile(path.join(projectDir, '.claude', 'rules', 'architecture.md'), 'utf8'),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(projectDir, '.claude', 'hooks', 'guard-core-purity.mjs'), 'utf8'),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(projectDir, '.claude', 'hooks', 'guard-web-boundary.mjs'), 'utf8'),
    ).rejects.toThrow();
    // no per-stack overlay either
    await expect(
      readFile(path.join(projectDir, '.claude', 'rules', 'node-ts.md'), 'utf8'),
    ).rejects.toThrow();

    for (const agent of [
      'test-writer.md',
      'implementation-agent.md',
      'code-reviewer.md',
      'security-scanner.md',
      'prose-reviewer.md',
      'failure-diagnostician.md',
    ]) {
      const body = await readFile(path.join(projectDir, '.claude', 'agents', agent), 'utf8');
      expect(body).toMatch(/^---\nname: /); // agent frontmatter
    }
    // core skills, installed by default (RP-195 slice 4 adds skill-authoring)
    for (const skill of ['worktree-task', 'check-premises', 'new-invariant', 'skill-authoring']) {
      await expect(
        readFile(path.join(projectDir, '.claude', 'skills', skill, 'SKILL.md'), 'utf8'),
      ).resolves.toBeTruthy();
      await expect(
        readFile(path.join(projectDir, '.agents', 'skills', skill, 'SKILL.md'), 'utf8'),
      ).resolves.toBeTruthy();
    }
    // the opt-in workflow layer (RP-180) is NOT part of the default install —
    // see "the workflow layer is opt-in" below for the dedicated coverage
    for (const skill of ['pr-ship', 'loop']) {
      await expect(
        readFile(path.join(projectDir, '.claude', 'skills', skill, 'SKILL.md')),
      ).rejects.toThrow();
    }
  });

  it('with `withWorkflow: true`, installs the opt-in workflow layer and records it in the manifest', async () => {
    const { projectDir } = await createProject('with-workflow', {
      cwd: work,
      git: false,
      withWorkflow: true,
    });
    await expect(
      readFile(path.join(projectDir, '.claude', 'skills', 'loop', 'SKILL.md'), 'utf8'),
    ).resolves.toBeTruthy();
    await expect(
      readFile(path.join(projectDir, '.claude', 'queue.json'), 'utf8'),
    ).resolves.toContain('adapter');
    const manifest = await readManifest(projectDir);
    expect(manifest?.layers).toEqual(['process', 'workflow']);
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
    expect(status.trim()).toBe(''); // everything generated is in the baseline, including the manifest
    await expect(
      readFile(path.join(projectDir, '.claude', '.rig-manifest.json'), 'utf8'),
    ).resolves.toBeTruthy();
  });

  it('does not stage or commit the parent repo when child git init fails', async () => {
    const outer = path.join(work, 'outer');
    await mkdir(outer, { recursive: true });
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const identity = ['-c', 'user.name=t', '-c', 'user.email=t@localhost'];
    await exec('git', ['init', '--quiet'], { cwd: outer, env: gitEnv() });
    await writeFile(path.join(outer, 'seed.txt'), 'seed\n');
    await exec('git', [...identity, 'add', '-A'], { cwd: outer, env: gitEnv() });
    await exec('git', [...identity, 'commit', '--quiet', '-m', 'outer seed'], {
      cwd: outer,
      env: gitEnv(),
    });
    const { stdout: beforeHead } = await exec('git', ['rev-parse', 'HEAD'], {
      cwd: outer,
      env: gitEnv(),
    });
    const { stdout: beforeIndex } = await exec('git', ['diff', '--cached', '--name-status'], {
      cwd: outer,
      env: gitEnv(),
    });

    // The shim makes only `git init` fail. A later baseline `git add` or
    // `git commit` still reaches real Git, which would discover and mutate
    // `outer` from the child directory unless create stops after init failed.
    const bin = path.join(work, 'bin');
    await mkdir(bin);
    const git = path.join(bin, 'git');
    await writeFile(
      git,
      '#!/bin/sh\nfor arg in "$@"; do [ "$arg" = init ] && exit 1; done\nexec /usr/bin/git "$@"\n',
    );
    await chmod(git, 0o755);

    const previousPath = process.env['PATH'];
    process.env['PATH'] = `${bin}:${previousPath ?? ''}`;
    try {
      await createProject('child', { cwd: outer });
    } finally {
      if (previousPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = previousPath;
    }

    const { stdout: afterHead } = await exec('git', ['rev-parse', 'HEAD'], {
      cwd: outer,
      env: gitEnv(),
    });
    const { stdout: afterIndex } = await exec('git', ['diff', '--cached', '--name-status'], {
      cwd: outer,
      env: gitEnv(),
    });
    expect(afterHead).toBe(beforeHead);
    expect(afterIndex).toBe(beforeIndex);
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
    await expect(readFile(path.join(projectDir, 'CLAUDE.md'), 'utf8')).resolves.toBeTruthy();
  });
});
