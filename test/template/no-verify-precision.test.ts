import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { gitEnv } from '../../packages/cli/src/lib/git-env.js';
import { modeBitsExist, skipUnless } from '../helpers/env.js';
import { runNodeTimed } from '../helpers/child-timing.js';
import { removeFixture } from '../helpers/remove-fixture.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hook = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'universal',
  '.claude',
  'hooks',
  'block-no-verify.mjs',
);
const fixtures: string[] = [];
const GIT_FIXTURE_TIMEOUT_MS = 10_000;
const GIT_FIXTURE_MAX_BUFFER = 1024 * 1024;

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => removeFixture(fixture)));
});

const bash = (command: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
});

const inspect = (command: string, cwd?: string) =>
  runNodeTimed(hook, { input: JSON.stringify(bash(command)), cwd, env: gitEnv(), timeout: 10_000 });

type CommandResult = { code: number; stdout: string; stderr: string };

const git = (args: string[], cwd: string): Promise<CommandResult> =>
  new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'user.name=RP-522 test', '-c', 'user.email=rp522@example.invalid', ...args],
      {
        cwd,
        env: gitEnv(),
        timeout: GIT_FIXTURE_TIMEOUT_MS,
        maxBuffer: GIT_FIXTURE_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout,
          stderr,
        });
      },
    );
  });

const gitMustSucceed = async (args: string[], cwd: string): Promise<string> => {
  const result = await git(args, cwd);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr}`);
  }
  return result.stdout.trim();
};

const newGitFixture = async (): Promise<string> => {
  const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'rp522-no-verify-')));
  fixtures.push(fixture);
  await gitMustSucceed(['init', '-q'], fixture);
  return fixture;
};

describe('block-no-verify precise commit bypass detection (RP-522)', () => {
  it('allows -amn because Git consumes n as the attached -m message', async () => {
    const result = await inspect('git commit -amn');
    expect(result.code, result.stderr).toBe(0);
  });

  it('refuses -n before -m when the attached message contains punctuation', async () => {
    const result = await inspect('git commit -nmx-y');
    expect(result.code, result.stderr).toBe(2);
  });

  it('allows -amnx-y because -m consumes nx-y as the attached message', async () => {
    const result = await inspect('git commit -amnx-y');
    expect(result.code, result.stderr).toBe(0);
  });

  it('proves with real Git that -amn runs pre-commit and commits message n', async () => {
    const fixture = await newGitFixture();
    await writeFile(path.join(fixture, 'tracked.txt'), 'before\n');
    await gitMustSucceed(['add', 'tracked.txt'], fixture);
    await gitMustSucceed(['commit', '-qm', 'initial'], fixture);

    const hooks = path.join(fixture, '.git', 'hooks');
    await mkdir(hooks, { recursive: true });
    const witness = path.join(hooks, 'pre-commit');
    await writeFile(witness, '#!/bin/sh\nprintf witness > .git/rp522-pre-commit-witness\n');
    await chmod(witness, 0o755);
    await writeFile(path.join(fixture, 'tracked.txt'), 'after\n');

    await gitMustSucceed(['commit', '-amn'], fixture);
    await expect(
      readFile(path.join(fixture, '.git', 'rp522-pre-commit-witness'), 'utf8'),
    ).resolves.toBe('witness');
    await expect(gitMustSucceed(['log', '-1', '--format=%B'], fixture)).resolves.toBe('n');
  });

  it('allows a heredoc body that documents the forbidden flag', async () => {
    const result = await inspect("cat <<'DOC'\ngit commit --no-verify -m documentation-only\nDOC");
    expect(result.code, result.stderr).toBe(0);
  });

  it('refuses a HUSKY=0 environment bypass before git commit', async () => {
    const result = await inspect('HUSKY=0 git commit -m x');
    expect(result.code, result.stderr).toBe(2);
  });

  it('refuses an inline core.hooksPath override before git commit', async () => {
    const result = await inspect('git -c core.hooksPath=.disabled-hooks commit -m x');
    expect(result.code, result.stderr).toBe(2);
  });

  it('refuses an actual bypass nested in bash -c', async () => {
    const result = await inspect("bash -c 'git commit --no-verify -m x'");
    expect(result.code, result.stderr).toBe(2);
  });

  it('refuses a configured persistent hooksPath override while allowing an ordinary repository', async () => {
    const configured = await newGitFixture();
    await gitMustSucceed(['config', 'core.hooksPath', '.disabled-hooks'], configured);
    const configuredResult = await inspect('git commit -m x', configured);
    expect(configuredResult.code, configuredResult.stderr).toBe(2);

    const ordinary = await newGitFixture();
    const ordinaryResult = await inspect('git commit -m x', ordinary);
    expect(ordinaryResult.code, ordinaryResult.stderr).toBe(0);
  });

  it('refuses an unreadable persistent hooksPath configuration', async () => {
    const fixture = await newGitFixture();
    await writeFile(path.join(fixture, '.git', 'config'), '[core\n\thooksPath = .disabled-hooks\n');

    const lookup = await git(['config', '--get', 'core.hooksPath'], fixture);
    expect(lookup.code, lookup.stderr).toBe(128);

    const result = await inspect('git commit -m x', fixture);
    expect(result.code, result.stderr).toBe(2);
  });

  it('allows an ordinary repository with no persistent hooksPath configuration', async () => {
    const ordinary = await newGitFixture();
    const lookup = await git(['config', '--get', 'core.hooksPath'], ordinary);
    expect(lookup.code, lookup.stderr).toBe(1);

    const ordinaryResult = await inspect('git commit -m x', ordinary);
    expect(ordinaryResult.code, ordinaryResult.stderr).toBe(0);
  });

  it('refuses a configured existing empty hooks directory', async () => {
    const fixture = await newGitFixture();
    await gitMustSucceed(['config', 'core.hooksPath', '.empty-hooks'], fixture);
    await mkdir(path.join(fixture, '.empty-hooks'), { recursive: true });

    const result = await inspect('git commit -m x', fixture);
    expect(result.code, result.stderr).toBe(2);
  });

  it('refuses a configured hooks directory whose pre-commit path is a directory', async () => {
    const fixture = await newGitFixture();
    const hooks = path.join(fixture, '.directory-pre-commit');
    await gitMustSucceed(['config', 'core.hooksPath', '.directory-pre-commit'], fixture);
    await mkdir(path.join(hooks, 'pre-commit'), { recursive: true });

    const result = await inspect('git commit -m x', fixture);
    expect(result.code, result.stderr).toBe(2);
  });

  it('refuses a non-executable regular pre-commit on POSIX permission-capable filesystems', async (ctx) => {
    skipUnless(ctx, modeBitsExist().ok, modeBitsExist().reason);
    const fixture = await newGitFixture();
    const hooks = path.join(fixture, '.non-executable-hooks');
    await gitMustSucceed(['config', 'core.hooksPath', '.non-executable-hooks'], fixture);
    await mkdir(hooks, { recursive: true });
    const witness = path.join(fixture, '.git', 'rp522-non-executable-hooks-witness');
    const preCommit = path.join(hooks, 'pre-commit');
    await writeFile(
      preCommit,
      '#!/bin/sh\nprintf witness > .git/rp522-non-executable-hooks-witness\n',
    );
    await chmod(preCommit, 0o644);
    skipUnless(
      ctx,
      ((await stat(preCommit)).mode & 0o777) === 0o644,
      'the fixture filesystem does not preserve POSIX mode 0644',
    );

    await writeFile(path.join(fixture, 'tracked.txt'), 'non-executable\n');
    await gitMustSucceed(['add', 'tracked.txt'], fixture);
    await gitMustSucceed(['commit', '-qm', 'non-executable pre-commit'], fixture);
    await expect(readFile(witness, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const result = await inspect('git commit -m x', fixture);
    expect(result.code, result.stderr).toBe(2);
  });

  it('allows a custom hooksPath with leading and internal spaces from a repository subdirectory', async () => {
    const fixture = await newGitFixture();
    const hooksPath = ' custom hooks';
    await gitMustSucceed(['config', 'core.hooksPath', hooksPath], fixture);
    const lookup = await git(['config', '--get', 'core.hooksPath'], fixture);
    expect(lookup.code, lookup.stderr).toBe(0);
    expect(lookup.stdout).toBe(`${hooksPath}\n`);

    const hooks = path.join(fixture, hooksPath);
    await mkdir(hooks, { recursive: true });
    const witness = path.join(fixture, '.git', 'rp522-custom-hooks-witness');
    const preCommit = path.join(hooks, 'pre-commit');
    await writeFile(preCommit, '#!/bin/sh\nprintf witness > .git/rp522-custom-hooks-witness\n');
    await chmod(preCommit, 0o755);
    await writeFile(path.join(fixture, 'tracked.txt'), 'custom\n');
    await gitMustSucceed(['add', 'tracked.txt'], fixture);
    const subdirectory = path.join(fixture, 'nested');
    await mkdir(subdirectory, { recursive: true });
    await gitMustSucceed(['commit', '-qm', 'custom hooks'], subdirectory);

    await expect(readFile(witness, 'utf8')).resolves.toBe('witness');
    const result = await inspect('git commit -m custom', subdirectory);
    expect(result.code, result.stderr).toBe(0);
  });

  it('refuses an empty persistent hooksPath that disables the default pre-commit directory', async () => {
    const fixture = await newGitFixture();
    await gitMustSucceed(['config', 'core.hooksPath', ''], fixture);
    const lookup = await git(['config', '--get', 'core.hooksPath'], fixture);
    expect(lookup.code, lookup.stderr).toBe(0);
    expect(lookup.stdout).toBe('\n');

    const defaultWitness = path.join(fixture, '.git', 'rp522-default-hooks-witness');
    const defaultPreCommit = path.join(fixture, '.git', 'hooks', 'pre-commit');
    await writeFile(
      defaultPreCommit,
      '#!/bin/sh\nprintf witness > .git/rp522-default-hooks-witness\n',
    );
    await chmod(defaultPreCommit, 0o755);
    await writeFile(path.join(fixture, 'tracked.txt'), 'empty hooks path\n');
    await gitMustSucceed(['add', 'tracked.txt'], fixture);
    await gitMustSucceed(['commit', '-qm', 'empty hooks path'], fixture);
    await expect(readFile(defaultWitness, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const result = await inspect('git commit -m x', fixture);
    expect(result.code, result.stderr).toBe(2);
  });

  it('allows the repository hooksPath when its pre-commit hook actually runs', async () => {
    const fixture = await newGitFixture();
    await gitMustSucceed(['config', 'core.hooksPath', '.husky'], fixture);
    const husky = path.join(fixture, '.husky');
    await mkdir(husky, { recursive: true });
    const preCommit = path.join(husky, 'pre-commit');
    await writeFile(preCommit, '#!/bin/sh\nprintf witness > .git/rp522-husky-witness\n');
    await chmod(preCommit, 0o755);
    await writeFile(path.join(fixture, 'tracked.txt'), 'ordinary\n');
    await gitMustSucceed(['add', 'tracked.txt'], fixture);
    await gitMustSucceed(['commit', '-qm', 'ordinary'], fixture);

    await expect(readFile(path.join(fixture, '.git', 'rp522-husky-witness'), 'utf8')).resolves.toBe(
      'witness',
    );
    const result = await inspect('git commit -m ordinary', fixture);
    expect(result.code, result.stderr).toBe(0);
  });

  it('continues refusing a bypass evaluated in a command substitution', async () => {
    const result = await inspect('printf %s "$(git commit --no-verify -m x)"');
    expect(result.code, result.stderr).toBe(2);
  });

  it('refuses a substitution after a literal apostrophe inside double quotes', async () => {
    const result = await inspect('printf "%s" "\'$(git commit --no-verify -m x)"');
    expect(result.code, result.stderr).toBe(2);
  });

  it('refuses a substitution after a literal heredoc marker inside double quotes', async () => {
    const result = await inspect('printf "%s" "<<\'DOC\'\n$(git commit --no-verify -m x)\nDOC\n"');
    expect(result.code, result.stderr).toBe(2);
  });

  it('refuses a substitution with a quoted closing parenthesis before the bypass', async () => {
    const result = await inspect('printf "%s" "$(printf \')\'; git commit --no-verify -m x)"');
    expect(result.code, result.stderr).toBe(2);
  });

  it('allows a single-quoted substitution as literal prose', async () => {
    const result = await inspect("printf '%s' '$(git commit --no-verify -m x)'");
    expect(result.code, result.stderr).toBe(0);
  });

  it('allows an escaped dollar substitution as literal prose', async () => {
    const result = await inspect('printf "%s" "\\$(git commit --no-verify -m x)"');
    expect(result.code, result.stderr).toBe(0);
  });

  it('allows single-quoted backticks as literal prose', async () => {
    const result = await inspect("printf '%s' '`git commit --no-verify -m x`'");
    expect(result.code, result.stderr).toBe(0);
  });

  it('continues refusing a bypass evaluated in a condition', async () => {
    const result = await inspect('if git commit -n -m x; then printf committed; fi');
    expect(result.code, result.stderr).toBe(2);
  });

  it('allows quoted prose containing a command separator in a condition', async () => {
    const result = await inspect("if printf '%s' 'ready; git commit --no-verify'; then :; fi");
    expect(result.code, result.stderr).toBe(0);
  });

  it('continues refusing a git.exe bypass spelling', async () => {
    const result = await inspect('git.exe commit --no-verify -m x');
    expect(result.code, result.stderr).toBe(2);
  });

  it('continues refusing a bypass through escaped sh -c', async () => {
    const result = await inspect('sh -c git\\ commit\\ --no-verify\\ -m\\ x');
    expect(result.code, result.stderr).toBe(2);
  });

  it('allows a quoted heredoc body containing a literal bypass example', async () => {
    const literal = await inspect("cat <<'DOC'\n$(git commit --no-verify -m x)\nDOC");
    expect(literal.code, literal.stderr).toBe(0);
  });

  it('refuses a bypass evaluated by an unquoted heredoc body', async () => {
    const expanded = await inspect('cat <<DOC\n$(git commit --no-verify -m x)\nDOC');
    expect(expanded.code, expanded.stderr).toBe(2);
  });
});
