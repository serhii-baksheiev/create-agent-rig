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

describe('block-no-verify R1 literal prose and Git option boundaries (RP-522)', () => {
  it('allows an escaped heredoc delimiter whose body is literal prose', async () => {
    const result = await inspect('cat <<\\DOC\ngit commit --no-verify -m prose\nDOC');
    expect(result.code, result.stderr).toBe(0);
  });

  it('allows a heredoc delimiter assembled from an unquoted and quoted fragment', async () => {
    const result = await inspect("cat <<D'OC'\ngit commit --no-verify -m prose\nDOC");
    expect(result.code, result.stderr).toBe(0);
  });

  it('allows an unquoted punctuation-bearing heredoc delimiter whose body is literal prose', async () => {
    const result = await inspect('cat <<DOC-1\ngit commit --no-verify -m prose\nDOC-1');
    expect(result.code, result.stderr).toBe(0);
  });

  it('allows a quoted punctuation-bearing heredoc delimiter whose body is literal prose', async () => {
    const result = await inspect("cat <<'DOC-1'\ngit commit --no-verify -m prose\nDOC-1");
    expect(result.code, result.stderr).toBe(0);
  });

  it('allows a tab-stripped literal heredoc body', async () => {
    const result = await inspect('cat <<-DOC\n\tgit commit --no-verify -m prose\n\tDOC');
    expect(result.code, result.stderr).toBe(0);
  });

  it('allows a concatenated heredoc delimiter whose body is literal prose', async () => {
    const result = await inspect('cat <<EOF"X"\ngit commit --no-verify -m prose\nEOFX');
    expect(result.code, result.stderr).toBe(0);
  });

  it('continues refusing a bypass after a real literal heredoc terminator', async () => {
    const result = await inspect("cat <<'DOC'\nprose\nDOC\ngit commit --no-verify -m x");
    expect(result.code, result.stderr).toBe(2);
  });

  it('treats word-start hashes as comments while retaining an attached hash as evaluated text', async () => {
    for (const command of [
      'printf done # $(git commit --no-verify -m x)',
      'printf done; # $(git commit --no-verify -m x)',
      '# $(git commit --no-verify -m x)',
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
    }
    const attached = await inspect('printf %s x#$(git commit --no-verify -m x)');
    expect(attached.code, attached.stderr).toBe(2);
  });

  it('skips literal global-option values before identifying the Git operation', async () => {
    for (const command of [
      'git -C push commit -n -m x',
      'git -Cpush commit -n -m x',
      'git --git-dir push commit -n -m x',
      'git --git-dir=push commit -n -m x',
      'git --work-tree push commit -n -m x',
      'git --namespace push commit -n -m x',
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(2);
    }
    for (const command of [
      'git -C commit push -n',
      'git -Ccommit push -n',
      'git --git-dir commit push -n',
      'git --git-dir=commit push -n',
      'git --work-tree commit push -n',
      'git --namespace commit push -n',
      'git log --grep commit -n1',
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
    }
  });

  it('refuses mixed-case hooksPath overrides in all supported Git global-option spellings', async () => {
    for (const command of [
      'git -c CoRe.HoOkSpAtH=.disabled-hooks commit -m x',
      'git -cCoRe.HoOkSpAtH=.disabled-hooks commit -m x',
      'git --config-env=CoRe.HoOkSpAtH=DISABLED commit -m x',
      'git --config-env CoRe.HoOkSpAtH=DISABLED commit -m x',
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(2);
    }
    const unrelated = await inspect('git -c core.editor=cat commit -m x');
    expect.soft(unrelated.code, unrelated.stderr).toBe(0);
  });

  it('reads persistent hooksPath from literal -C targets, including a repeated relative target', async () => {
    const disabled = await newGitFixture();
    await gitMustSucceed(['config', 'core.hooksPath', '.disabled-hooks'], disabled);
    const disabledResult = await inspect(`git -C ${JSON.stringify(disabled)} commit -m x`);
    expect.soft(disabledResult.code, disabledResult.stderr).toBe(2);
    const disabledGitDir = path.join(disabled, '.git');
    const disabledLookup = await git(
      ['--git-dir', disabledGitDir, 'config', '--get', 'core.hooksPath'],
      disabled,
    );
    expect.soft(disabledLookup.code, disabledLookup.stderr).toBe(0);
    expect.soft(disabledLookup.stdout).toBe('.disabled-hooks\n');
    const disabledGitDirResult = await inspect(
      `git --git-dir ${JSON.stringify(disabledGitDir)} commit -m x`,
    );
    expect.soft(disabledGitDirResult.code, disabledGitDirResult.stderr).toBe(2);
    const disabledGitDirEqualsResult = await inspect(
      `git --git-dir=${JSON.stringify(disabledGitDir)} commit -m x`,
    );
    expect.soft(disabledGitDirEqualsResult.code, disabledGitDirEqualsResult.stderr).toBe(2);

    const usable = await newGitFixture();
    await gitMustSucceed(['config', 'core.hooksPath', '.custom-hooks'], usable);
    const hooks = path.join(usable, '.custom-hooks');
    await mkdir(hooks, { recursive: true });
    const preCommit = path.join(hooks, 'pre-commit');
    await writeFile(preCommit, '#!/bin/sh\nexit 0\n');
    await chmod(preCommit, 0o755);
    const usableResult = await inspect(`git -C ${JSON.stringify(usable)} commit -m x`);
    expect.soft(usableResult.code, usableResult.stderr).toBe(0);
    const usableGitDirResult = await inspect(
      `git --git-dir ${JSON.stringify(path.join(usable, '.git'))} --work-tree ${JSON.stringify(usable)} commit -m x`,
    );
    expect.soft(usableGitDirResult.code, usableGitDirResult.stderr).toBe(0);
    const usableWorkTreeEqualsResult = await inspect(
      `git --git-dir ${JSON.stringify(path.join(usable, '.git'))} --work-tree=${JSON.stringify(usable)} commit -m x`,
    );
    expect.soft(usableWorkTreeEqualsResult.code, usableWorkTreeEqualsResult.stderr).toBe(0);

    const outer = await newGitFixture();
    const nested = path.join(outer, 'nested');
    await mkdir(nested);
    await gitMustSucceed(['init', '-q'], nested);
    await gitMustSucceed(['config', 'core.hooksPath', '.disabled-hooks'], nested);
    const repeated = await inspect(`git -C ${JSON.stringify(outer)} -C nested commit -m x`);
    expect.soft(repeated.code, repeated.stderr).toBe(2);
  });

  it('uses a usable hooksPath only as a preflight and does not execute the proposed commit', async () => {
    const fixture = await newGitFixture();
    await gitMustSucceed(['config', 'core.hooksPath', '.custom-hooks'], fixture);
    const hooks = path.join(fixture, '.custom-hooks');
    await mkdir(hooks, { recursive: true });
    const witness = path.join(fixture, '.git', 'rp522-preflight-only-witness');
    const preCommit = path.join(hooks, 'pre-commit');
    await writeFile(preCommit, '#!/bin/sh\nprintf witness > .git/rp522-preflight-only-witness\n');
    await chmod(preCommit, 0o755);
    await writeFile(path.join(fixture, 'tracked.txt'), 'staged but uncommitted\n');
    await gitMustSucceed(['add', 'tracked.txt'], fixture);
    const before = await gitMustSucceed(['status', '--short'], fixture);

    const result = await inspect('git commit -m x', fixture);
    expect(result.code, result.stderr).toBe(0);
    await expect(readFile(witness, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(gitMustSucceed(['status', '--short'], fixture)).resolves.toBe(before);
  });

  it('preserves a backslash before an ordinary quoted-delimiter character', async () => {
    const literal = await inspect('cat <<"D\\OC"\n$(git commit -n -m x)\nD\\OC');
    expect.soft(literal.code, literal.stderr).toBe(0);
    const afterTerminator = await inspect('cat <<"D\\OC"\nprose\nD\\OC\ngit commit -n -m x\nDOC');
    expect.soft(afterTerminator.code, afterTerminator.stderr).toBe(2);
  });

  it('allows a quoted empty heredoc delimiter whose body is literal prose', async () => {
    const result = await inspect("cat <<''\ngit commit -n -m prose\n\n");
    expect(result.code, result.stderr).toBe(0);
  });

  it('tracks exported HUSKY=0 through Git spellings and literal shell process scopes', async () => {
    for (const command of [
      'HUSKY=0 git.exe commit -m x',
      'HUSKY=0; git commit -m x',
      'HUSKY=0 && git commit -m x',
      'HUSKY="0" git commit -m x',
      "env HUSKY='0' git commit -m x",
      'export HUSKY=0; git commit -m x',
      "HUSKY=0 bash -c 'git commit -m x'",
      "env HUSKY=0 bash -c 'git commit -m x'",
      "export HUSKY=0; sh -c 'git commit -m x'",
      "export HUSKY=0; HUSKY=0; sh -c 'git commit -m x'",
      "export HUSKY=1; HUSKY=0; sh -c 'git commit -m x'",
      '( export HUSKY=0; git commit -m x )',
      'OTHER=1 HUSKY=0 git commit -m x',
      '/usr/bin/env HUSKY=0 git commit -m x',
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(2);
    }
    for (const command of [
      'HUSKY=0; HUSKY=1; git commit -m x',
      'HUSKY=0; unset HUSKY; git commit -m x',
      "HUSKY=0; sh -c 'git commit -m x'",
      '( export HUSKY=0 ); git commit -m x',
      '( export HUSKY=0; HUSKY=1; git commit -m x )',
      "export HUSKY=0; HUSKY=1; sh -c 'git commit -m x'",
      "export HUSKY=0; unset HUSKY; sh -c 'git commit -m x'",
      'HUSKY=0 printf ready; git commit -m x',
      '( HUSKY=0 ); git commit -m x',
      "printf '%s' 'HUSKY=0; git commit -m x'",
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
    }
  });

  it('treats a hash inside double quotes as text whose substitution still evaluates', async () => {
    const evaluated = await inspect('printf " # $(git commit --no-verify -m x)"');
    expect.soft(evaluated.code, evaluated.stderr).toBe(2);
    for (const command of [
      "printf '%s' ' # $(git commit --no-verify -m x)'",
      'printf done # $(git commit --no-verify -m x)',
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
    }
  });

  it('keeps HUSKY state isolated between sibling and nested subshells', async () => {
    for (const command of [
      'export HUSKY=0; ( HUSKY=1 ); ( git commit -m x )',
      'export HUSKY=0; ( ( HUSKY=1 ) ); ( git commit -m x )',
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(2);
    }
    for (const command of [
      '( HUSKY=0 ); ( git commit -m x )',
      'export HUSKY=0; ( HUSKY=1 ); HUSKY=1; ( git commit -m x )',
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
    }
  });

  it('carries an existing HUSKY value when export names it among literal operands', async () => {
    for (const command of [
      "HUSKY=0; export HUSKY; sh -c 'git commit -m x'",
      "export HUSKY; HUSKY=0; sh -c 'git commit -m x'",
      'export OTHER=1 HUSKY=0; git commit -m x',
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(2);
    }
    for (const command of [
      "HUSKY=1; export HUSKY; sh -c 'git commit -m x'",
      'export OTHER=1 HUSKY=1; git commit -m x',
      'export OTHER=1; git commit -m x',
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
    }
  });

  it('carries exported HUSKY into substitutions at their lexical execution point', async () => {
    for (const command of [
      `export HUSKY=0; printf '%s' "$(git commit -m x)"`,
      `export HUSKY=0; printf '%s' "$(git commit -m x)"; HUSKY=1`,
      'export HUSKY=0; cat <<DOC\n$(git commit -m x)\nDOC',
      'export HUSKY=0; cat <<DOC; HUSKY=1\n$(git commit -m x)\nDOC',
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(2);
    }
    for (const command of [
      `printf '%s' "$(git commit -m x)"; export HUSKY=0`,
      "export HUSKY=0; cat <<'DOC'\n$(git commit -m x)\nDOC",
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
    }
  });

  it('keeps env-local HUSKY changes and literal prose out of the parent shell state', async () => {
    for (const command of [
      'env HUSKY=0; git commit -m x',
      'export HUSKY=0; env -u HUSKY git commit -m x',
      "printf '%s' 'export HUSKY=0; git commit -m x'",
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
    }
  });

  it('carries bare and multioperand exported HUSKY=0 into evaluated substitutions', async () => {
    const prefixes = ['HUSKY=0; export HUSKY', 'export HUSKY; HUSKY=0', 'export OTHER=1 HUSKY=0'];
    for (const prefix of prefixes) {
      for (const command of [
        `${prefix}; printf '%s' "$(git commit -m x)"`,
        `${prefix}; cat <<DOC\n$(git commit -m x)\nDOC`,
      ]) {
        const result = await inspect(command);
        expect.soft(result.code, `${command}: ${result.stderr}`).toBe(2);
      }
    }
  });

  it('uses restored or unset HUSKY state at the later substitution', async () => {
    for (const prefix of ['export HUSKY=0; HUSKY=1', 'export HUSKY=0; unset HUSKY']) {
      for (const command of [
        `${prefix}; printf '%s' "$(git commit -m x)"`,
        `${prefix}; cat <<DOC\n$(git commit -m x)\nDOC`,
      ]) {
        const result = await inspect(command);
        expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
      }
    }
  });

  it('keeps single-quoted export prose out of later substitution state', async () => {
    const result = await inspect(
      `printf '%s' 'x; export HUSKY=0;'; printf '%s' "$(git commit -m x)"`,
    );
    expect.soft(result.code, result.stderr).toBe(0);
  });

  it('does not apply a post-header export before an unquoted heredoc body expands', async () => {
    const result = await inspect('cat <<DOC; export HUSKY=0\n$(git commit -m x)\nDOC');
    expect.soft(result.code, result.stderr).toBe(0);
  });

  it('applies env unsets and assignments to Git in their literal order', async () => {
    const disabled = await inspect('env -u HUSKY HUSKY=0 git commit -m x');
    expect.soft(disabled.code, disabled.stderr).toBe(2);
    const cleared = await inspect('env -u HUSKY git commit -m x');
    expect.soft(cleared.code, cleared.stderr).toBe(0);
  });

  it('documents and retains the depth-16 literal shell inspection limit', async () => {
    const source = await readFile(hook, 'utf8');
    expect(source).toMatch(/depth 16|depth > 16/i);
    let command = 'git commit -n -m x';
    for (let depth = 0; depth < 17; depth += 1) command = `sh -c ${JSON.stringify(command)}`;
    const result = await inspect(command);
    expect(result.code, result.stderr).toBe(0);
  });

  it('documents and retains the static-scope limits for aliases and runtime-assembled commands', async () => {
    const source = await readFile(hook, 'utf8');
    expect(source).toMatch(/aliases.*dynamically.*assembled.*general shell expansion/is);
    for (const command of [
      "alias ci='git commit -n -m x'; ci",
      'operation=commit; eval "git $operation -n -m x"',
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
    }
  });

  it('distinguishes literal delimiter composition from evaluated heredoc bodies and header suffixes', async () => {
    for (const command of [
      'cat <<\\DOC\n$(git commit -n -m x)\nDOC',
      "cat <<D'OC'\n$(git commit -n -m x)\nDOC",
      'cat <<EOF"X"\n$(git commit -n -m x)\nEOFX',
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
    }
    for (const command of [
      'cat <<DOC-1\n$(git commit -n -m x)\nDOC-1',
      'cat <<D\'OC\'; printf %s "$(git commit -n -m x)"\nprose\nDOC',
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(2);
    }
  });

  it('documents and retains the shared 32-heredoc tokenizer budget', async () => {
    const source = await readFile(hook, 'utf8');
    expect(source).toMatch(/32-heredoc budget|32 heredoc budget/i);
    const command = Array.from(
      { length: 33 },
      (_, index) => `cat <<'DOC${index}'\ngit commit --no-verify -m prose\nDOC${index}`,
    ).join('\n');
    const result = await inspect(command);
    expect(result.code, result.stderr).toBe(2);
  });
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

  it('refuses a bypass inside single quotes in an unquoted heredoc body', async () => {
    const expanded = await inspect("cat <<DOC\n'$(git commit --no-verify -m x)'\nDOC");
    expect(expanded.code, expanded.stderr).toBe(2);
  });

  it('refuses a header-suffix substitution after a quoted heredoc body', async () => {
    const suffix = await inspect(
      'cat <<\'DOC\'; printf "%s" "$(git commit --no-verify -m x)"\ntext\nDOC',
    );
    expect(suffix.code, suffix.stderr).toBe(2);
  });

  it('refuses an expanded first body when a later heredoc body is quoted', async () => {
    const multiple = await inspect(
      "cat <<FIRST <<'SECOND'\n$(git commit --no-verify -m x)\nFIRST\nliteral\nSECOND",
    );
    expect(multiple.code, multiple.stderr).toBe(2);
  });

  it('refuses a bypass after a large unquoted heredoc substitution prefix', async () => {
    const body = '$() '.repeat(150_000) + '$(git commit --no-verify -m x)';
    const result = await inspect(`cat <<DOC\n${body}\nDOC`);
    expect(result.code, result.stderr).toBe(2);
  });
});
