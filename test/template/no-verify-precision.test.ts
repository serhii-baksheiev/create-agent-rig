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

  it('allows an ANSI-C quoted heredoc delimiter whose body is literal prose', async () => {
    const result = await inspect("cat <<$'DOC'\ngit commit --no-verify -m prose\nDOC");
    expect(result.code, result.stderr).toBe(0);
  });

  it('continues refusing a bypass after an ANSI-C quoted heredoc terminator', async () => {
    const result = await inspect("cat <<$'DOC'\nprose\nDOC\ngit commit --no-verify -m x");
    expect(result.code, result.stderr).toBe(2);
  });

  it('refuses an ANSI-C delimiter with an escape before a later live bypass', async () => {
    const result = await inspect("cat <<$'DOC\\x41'\nprose\nDOCA\ngit commit --no-verify -m x");
    expect(result.code, result.stderr).toBe(2);
  });

  it('allows an ANSI-C escaped heredoc delimiter whose body is literal prose', async () => {
    const result = await inspect("cat <<$'DOC\\x41'\ngit commit --no-verify -m prose\nDOCA");
    expect(result.code, result.stderr).toBe(0);
  });

  it('proves standalone HUSKY assignments are absent from clean child environments', async () => {
    const printHusky = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      "process.stdout.write(process.env.HUSKY ?? 'absent')",
    )}`;
    for (const command of [
      `HUSKY=0; ${printHusky}`,
      `HUSKY=0 && ${printHusky}`,
      `export HUSKY=0; command env -u HUSKY ${printHusky}`,
    ]) {
      const result = await shell(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
      expect.soft(result.stdout, `${command}: ${result.stderr}`).toBe('absent');
    }
  });

  it('allows standalone unexported HUSKY assignments before later Git commits', async () => {
    for (const command of ['HUSKY=0; git commit -m x', 'HUSKY=0 && git commit -m x']) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
    }
  });

  it('keeps an unexported HUSKY=0 assignment out of child shells and substitutions', async () => {
    for (const command of [
      "HUSKY=0; bash -c 'git commit -m x'",
      `HUSKY=0; printf '%s' "$(git commit -m x)"`,
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
    }
  });

  it('retains an existing HUSKY export through a later standalone zero assignment', async () => {
    for (const command of [
      "export HUSKY=1; HUSKY=0; bash -c 'git commit -m x'",
      `export HUSKY=1; HUSKY=0; printf '%s' "$(git commit -m x)"`,
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(2);
    }
  });

  it('proves the export attribute into a child survives a standalone zero assignment', async () => {
    const printHusky = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      "process.stdout.write(process.env.HUSKY ?? 'absent')",
    )}`;
    const result = await shell(
      `export HUSKY=1; bash -c ${JSON.stringify(`HUSKY=0; ${printHusky}`)}`,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout, result.stderr).toBe('0');
  });

  it('refuses an export attribute into child standalone zero assignments', async () => {
    for (const command of [
      "export HUSKY=1; bash -c 'HUSKY=0; git commit -m x'",
      `export HUSKY=1; printf '%s' "$(HUSKY=0; git commit -m x)"`,
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(2);
    }
  });

  it('clears exported HUSKY through supported multioperand and -v unset forms', async () => {
    for (const command of [
      'export HUSKY=0; unset OTHER HUSKY; git commit -m x',
      'export HUSKY=0; unset -v HUSKY; git commit -m x',
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
    }
  });

  it('proves function-only unset leaves exported HUSKY in a child environment', async () => {
    const printHusky = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      "process.stdout.write(process.env.HUSKY ?? 'absent')",
    )}`;
    const result = await shell(`export HUSKY=0; unset -f HUSKY; ${printHusky}`);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout, result.stderr).toBe('0');
  });

  it('refuses a function-only unset before a Git commit', async () => {
    const result = await inspect('export HUSKY=0; unset -f HUSKY; git commit -m x');
    expect(result.code, result.stderr).toBe(2);
  });

  it('retains exported HUSKY when unset does not name it', async () => {
    const result = await inspect('export HUSKY=0; unset OTHER; git commit -m x');
    expect(result.code, result.stderr).toBe(2);
  });

  it('clears exported HUSKY through a command env -u wrapper', async () => {
    const result = await inspect('export HUSKY=0; command env -u HUSKY git commit -m x');
    expect(result.code, result.stderr).toBe(0);
  });

  it('keeps a command env -u child unexported before its standalone zero assignment', async () => {
    const result = await inspect(
      "export HUSKY=0; command env -u HUSKY bash -c 'HUSKY=0; git commit -m x'",
    );
    expect(result.code, result.stderr).toBe(0);
  });

  it('refuses a command env wrapper that assigns HUSKY=0', async () => {
    const result = await inspect('command env HUSKY=0 git commit -m x');
    expect(result.code, result.stderr).toBe(2);
  });

  it('refuses a command env wrapper that reassigns HUSKY=0 after clearing it', async () => {
    const result = await inspect('command env -u HUSKY HUSKY=0 git commit -m x');
    expect(result.code, result.stderr).toBe(2);
  });

  it('refuses direct, prefix, and exported HUSKY=0 Git bypasses', async () => {
    for (const command of [
      'HUSKY=0 git.exe commit -m x',
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

  it('proves unrelated env unsets preserve ordered child HUSKY values', async () => {
    const printHusky = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      "process.stdout.write(process.env.HUSKY ?? 'absent')",
    )}`;
    for (const [command, expected] of [
      [`env -u HUSKY -u OTHER HUSKY=0 ${printHusky}`, '0'],
      [`command env -u HUSKY -u OTHER HUSKY=0 ${printHusky}`, '0'],
      [`export HUSKY=0; command env -u OTHER -u HUSKY ${printHusky}`, 'absent'],
    ] as const) {
      const result = await shell(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
      expect.soft(result.stdout, `${command}: ${result.stderr}`).toBe(expected);
    }
  });

  it('applies unrelated env unsets before later HUSKY operations', async () => {
    for (const command of [
      'env -u HUSKY -u OTHER HUSKY=0 git commit -m x',
      'command env -u HUSKY -u OTHER HUSKY=0 git commit -m x',
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(2);
    }
    const cleared = await inspect('export HUSKY=0; command env -u OTHER -u HUSKY git commit -m x');
    expect(cleared.code, cleared.stderr).toBe(0);
  });

  it('stops env assignments at the command instead of reading a commit message as one', async () => {
    const message = await inspect('env git commit -m HUSKY=0');
    expect.soft(message.code, message.stderr).toBe(0);
    const prefix = await inspect('env HUSKY=0 git commit -m x');
    expect.soft(prefix.code, prefix.stderr).toBe(2);
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

const inspectWithEnv = (command: string, env: NodeJS.ProcessEnv, cwd?: string) =>
  runNodeTimed(hook, { input: JSON.stringify(bash(command)), cwd, env, timeout: 10_000 });

type CommandResult = { code: number; stdout: string; stderr: string };

const shell = (command: string): Promise<CommandResult> =>
  new Promise((resolve) => {
    const environment = gitEnv();
    delete environment.HUSKY;
    execFile(
      'sh',
      ['-c', command],
      { env: environment, timeout: GIT_FIXTURE_TIMEOUT_MS, maxBuffer: GIT_FIXTURE_MAX_BUFFER },
      (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout,
          stderr,
        });
      },
    );
  });

const git = (args: string[], cwd: string, env = gitEnv()): Promise<CommandResult> =>
  new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'user.name=RP-522 test', '-c', 'user.email=rp522@example.invalid', ...args],
      {
        cwd,
        env,
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

  it('refuses a command-local GIT_CONFIG hooksPath override before git commit', async () => {
    for (const command of [
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x',
      'env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x',
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(2);
    }
    const ordinary = await inspect('git commit -m x');
    expect(ordinary.code, ordinary.stderr).toBe(0);
  });

  it('refuses a local GIT_CONFIG key that completes an inherited hooksPath triad', async () => {
    const fixture = await newGitFixture();
    const inherited = {
      ...gitEnv(),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '/dev/null',
    };
    const effective = { ...inherited, GIT_CONFIG_KEY_0: 'core.hooksPath' };
    const witness = await git(['config', '--get', 'core.hooksPath'], fixture, effective);
    expect(witness.code, witness.stderr).toBe(0);
    expect(witness.stdout).toBe('/dev/null\n');

    const bypass = await inspectWithEnv(
      'GIT_CONFIG_KEY_0=core.hooksPath git commit -m x',
      inherited,
      fixture,
    );
    expect(bypass.code, bypass.stderr).toBe(2);

    const benign = await inspectWithEnv(
      'GIT_CONFIG_KEY_0=safe.directory git commit -m x',
      inherited,
      fixture,
    );
    expect(benign.code, benign.stderr).toBe(0);
    const cleared = await inspectWithEnv('env -i git commit -m x', inherited, fixture);
    expect(cleared.code, cleared.stderr).toBe(0);
    const unset = await inspectWithEnv(
      'env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 git commit -m x',
      inherited,
      fixture,
    );
    expect(unset.code, unset.stderr).toBe(0);
  });

  it('lets command-local environment clearing restore a checked commit while retaining persistent hook overrides', async () => {
    const fixture = await newGitFixture();
    const inherited = {
      ...gitEnv(),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
    };
    const hooks = path.join(fixture, '.git', 'hooks');
    const witness = path.join(fixture, '.git', 'rp522-cleared-config-witness');
    await writeFile(
      path.join(hooks, 'pre-commit'),
      '#!/bin/sh\nprintf witness > .git/rp522-cleared-config-witness\n',
    );
    await chmod(path.join(hooks, 'pre-commit'), 0o755);
    await writeFile(path.join(fixture, 'tracked.txt'), 'cleared configuration\n');
    await gitMustSucceed(['add', 'tracked.txt'], fixture);

    const clearedLookup = await git(['config', '--get', 'core.hooksPath'], fixture, gitEnv());
    expect(clearedLookup.code, clearedLookup.stderr).toBe(1);
    const checkedCommit = await git(['commit', '-m', 'checked after clear'], fixture, gitEnv());
    expect(checkedCommit.code, checkedCommit.stderr).toBe(0);
    await expect(readFile(witness, 'utf8')).resolves.toBe('witness');

    for (const command of [
      'env -i git commit -m x',
      'env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 git commit -m x',
    ]) {
      const result = await inspectWithEnv(command, inherited, fixture);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
    }

    await gitMustSucceed(['config', 'core.hooksPath', '.disabled-hooks'], fixture);
    const persistent = await inspectWithEnv('env -i git commit -m x', inherited, fixture);
    expect(persistent.code, persistent.stderr).toBe(2);
  });

  it('treats env --ignore-environment as clearing an inherited Git configuration triad', async () => {
    const fixture = await newGitFixture();
    const inherited = {
      ...gitEnv(),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
    };
    const cleared = await inspectWithEnv(
      'env --ignore-environment git commit -m x',
      inherited,
      fixture,
    );
    expect(cleared.code, cleared.stderr).toBe(0);

    await gitMustSucceed(['config', 'core.hooksPath', '.disabled-hooks'], fixture);
    const persistent = await inspectWithEnv(
      'env --ignore-environment git commit -m x',
      inherited,
      fixture,
    );
    expect(persistent.code, persistent.stderr).toBe(2);
  });

  it('allows a local Git config key after env clears the inherited configuration triad', async () => {
    const fixture = await newGitFixture();
    const inherited = {
      ...gitEnv(),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '/dev/null',
    };
    const ignored = { ...gitEnv(), GIT_CONFIG_KEY_0: 'core.hooksPath' };
    const ignoredWitness = await git(['config', '--get', 'core.hooksPath'], fixture, ignored);
    expect(ignoredWitness.code, ignoredWitness.stderr).toBe(1);

    const ignoredByHook = await inspectWithEnv(
      'env -i GIT_CONFIG_KEY_0=core.hooksPath git commit -m x',
      inherited,
      fixture,
    );
    expect.soft(ignoredByHook.code, ignoredByHook.stderr).toBe(0);

    const unset: NodeJS.ProcessEnv = { ...inherited, GIT_CONFIG_KEY_0: 'core.hooksPath' };
    delete unset.GIT_CONFIG_COUNT;
    const unsetWitness = await git(['config', '--get', 'core.hooksPath'], fixture, unset);
    expect(unsetWitness.code, unsetWitness.stderr).toBe(1);
    const unsetByHook = await inspectWithEnv(
      'env -u GIT_CONFIG_COUNT GIT_CONFIG_KEY_0=core.hooksPath git commit -m x',
      inherited,
      fixture,
    );
    expect.soft(unsetByHook.code, unsetByHook.stderr).toBe(0);
  });

  it('refuses a literal GIT_CONFIG_PARAMETERS hooksPath override while allowing a benign parameter', async () => {
    const fixture = await newGitFixture();
    const disabledParameters = "'core.hooksPath=/dev/null'";
    const witness = await git(['config', '--get', 'core.hooksPath'], fixture, {
      ...gitEnv(),
      GIT_CONFIG_PARAMETERS: disabledParameters,
    });
    expect(witness.code, witness.stderr).toBe(0);
    expect(witness.stdout).toBe('/dev/null\n');

    const bypass = await inspect(
      'GIT_CONFIG_PARAMETERS="\'core.hooksPath=/dev/null\'" git commit -m x',
      fixture,
    );
    expect(bypass.code, bypass.stderr).toBe(2);
    const benign = await inspect(
      'GIT_CONFIG_PARAMETERS="\'core.editor=cat\'" git commit -m x',
      fixture,
    );
    expect(benign.code, benign.stderr).toBe(0);
  });

  it('refuses separately quoted GIT_CONFIG_PARAMETERS hooksPath overrides while allowing quoted benign parameters', async () => {
    const fixture = await newGitFixture();
    const disabledParameters = "'core.hooksPath'='/dev/null'";
    const witness = await git(['config', '--get', 'core.hooksPath'], fixture, {
      ...gitEnv(),
      GIT_CONFIG_PARAMETERS: disabledParameters,
    });
    expect(witness.code, witness.stderr).toBe(0);
    expect(witness.stdout).toBe('/dev/null\n');

    const bypass = await inspect(
      "GIT_CONFIG_PARAMETERS=\"'core.hooksPath'='/dev/null'\" git commit -m x",
      fixture,
    );
    expect(bypass.code, bypass.stderr).toBe(2);
    const benign = await inspect(
      "GIT_CONFIG_PARAMETERS=\"'core.editor'='cat'\" git commit -m x",
      fixture,
    );
    expect(benign.code, benign.stderr).toBe(0);
  });

  it('carries literal exported Git configuration into later direct, child-shell, and substitution commits', async () => {
    const fixture = await newGitFixture();
    const disabledParameters = "'core.hooksPath'='/dev/null'";
    const disabledTriad = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
    };
    for (const environment of [
      { ...gitEnv(), GIT_CONFIG_PARAMETERS: disabledParameters },
      { ...gitEnv(), ...disabledTriad },
    ]) {
      const witness = await git(['config', '--get', 'core.hooksPath'], fixture, environment);
      expect.soft(witness.code, witness.stderr).toBe(0);
      expect.soft(witness.stdout, witness.stderr).toBe('/dev/null\n');
    }

    for (const command of [
      `export GIT_CONFIG_PARAMETERS="${disabledParameters}"; git commit -m x`,
      'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null; git commit -m x',
      `export GIT_CONFIG_PARAMETERS="${disabledParameters}"; sh -c 'git commit -m x'`,
      `export GIT_CONFIG_PARAMETERS="${disabledParameters}"; printf '%s' "$(git commit -m x)"`,
      `GIT_CONFIG_PARAMETERS="${disabledParameters}"; export GIT_CONFIG_PARAMETERS; git commit -m x`,
      `export GIT_CONFIG_PARAMETERS; GIT_CONFIG_PARAMETERS="${disabledParameters}"; sh -c 'git commit -m x'`,
    ]) {
      const result = await inspect(command, fixture);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(2);
    }

    for (const command of [
      `export GIT_CONFIG_PARAMETERS="'core.editor'='cat'"; git commit -m x`,
      `printf '%s' "$(git commit -m x)"; export GIT_CONFIG_PARAMETERS="${disabledParameters}"`,
    ]) {
      const result = await inspect(command, fixture);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
    }
  });

  it('keeps exported Git configuration scoped and permits literal clearing before a later commit', async () => {
    const fixture = await newGitFixture();
    const disabledParameters = "'core.hooksPath'='/dev/null'";
    for (const command of [
      `( export GIT_CONFIG_PARAMETERS="${disabledParameters}" ); git commit -m x`,
      `export GIT_CONFIG_PARAMETERS="${disabledParameters}"; unset GIT_CONFIG_PARAMETERS; git commit -m x`,
      `export GIT_CONFIG_PARAMETERS="${disabledParameters}"; env -u GIT_CONFIG_PARAMETERS git commit -m x`,
      `export GIT_CONFIG_PARAMETERS="${disabledParameters}"; env -i git commit -m x`,
      'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null; unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0; git commit -m x',
    ]) {
      const result = await inspect(command, fixture);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
    }
  });

  it('removes inherited disabled Git configuration when literal shell state clears it', async () => {
    const fixture = await newGitFixture();
    const parameterInherited = {
      ...gitEnv(),
      GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/dev/null'",
    };
    const triadInherited = {
      ...gitEnv(),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
    };

    for (const [environment, cleared] of [
      [parameterInherited, 'unset GIT_CONFIG_PARAMETERS; git commit -m x'],
      [parameterInherited, 'env -u GIT_CONFIG_PARAMETERS git commit -m x'],
      [parameterInherited, 'env -i git commit -m x'],
      [
        triadInherited,
        'unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0; git commit -m x',
      ],
    ] as const) {
      const bypass = await inspectWithEnv('git commit -m x', environment, fixture);
      expect.soft(bypass.code, bypass.stderr).toBe(2);
      const result = await inspectWithEnv(cleared, environment, fixture);
      expect.soft(result.code, `${cleared}: ${result.stderr}`).toBe(0);
    }
  });

  it('refuses a separately quoted hooksPath override after an unrelated assignment whose value names git', async () => {
    const fixture = await newGitFixture();
    const disabledParameters = "'core.hooksPath'='/dev/null'";
    const witness = await git(['config', '--get', 'core.hooksPath'], fixture, {
      ...gitEnv(),
      GIT_CONFIG_PARAMETERS: disabledParameters,
    });
    expect(witness.code, witness.stderr).toBe(0);
    expect(witness.stdout).toBe('/dev/null\n');

    const bypass = await inspect(
      "TOOL=/usr/bin/git GIT_CONFIG_PARAMETERS=\"'core.hooksPath'='/dev/null'\" /usr/bin/git commit -m x",
      fixture,
    );
    expect(bypass.code, bypass.stderr).toBe(2);
  });

  it.each(['999999999999999999999999999999999999999', '1000000000'])(
    'refuses an excessive command-local Git configuration count of %s without timing out',
    async (count) => {
      const result = await runNodeTimed(hook, {
        input: JSON.stringify(
          bash(
            `GIT_CONFIG_COUNT=${count} GIT_CONFIG_KEY_0=core.editor GIT_CONFIG_VALUE_0=cat git commit -m x`,
          ),
        ),
        env: gitEnv(),
        timeout: 1_500,
      });
      expect(result.code).not.toBe('TIMEOUT');
      expect(result.code, result.stderr).toBe(2);
    },
  );

  it('allows no-verify-looking message-file operands while refusing real bypass flags', async () => {
    for (const command of ['git commit -F --no-verify', 'git commit --file -n']) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
    }
    for (const command of ['git commit -F --no-verify --no-verify', 'git commit --file -n -n']) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(2);
    }
  });

  it('allows attached -F message-file operands while refusing genuine no-verify flags', async () => {
    for (const command of ['git commit -Fn', 'git commit -Fno-verify']) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
    }
    for (const command of ['git commit -n -Fn', 'git commit -Fn -n']) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(2);
    }
  });

  it('allows attached values for Git short options that take a commit, message, or template', async () => {
    for (const command of [
      'git commit -mno-verify',
      'git commit -Cno-verify',
      'git commit -cno-verify',
      'git commit -tno-verify',
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
    }
  });

  it('allows separated commit-option values while refusing a trailing no-verify flag', async () => {
    for (const command of [
      'git commit -C --no-verify',
      'git commit -c --no-verify',
      'git commit -t --no-verify',
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(0);
    }
    for (const command of [
      'git commit -C --no-verify -n',
      'git commit -c --no-verify -n',
      'git commit -t --no-verify -n',
    ]) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(2);
    }
  });

  it('allows an attached optional untracked-files mode while preserving genuine no-verify refusal', async () => {
    const fixture = await newGitFixture();
    const preCommit = path.join(fixture, '.git', 'hooks', 'pre-commit');
    const witness = path.join(fixture, '.git', 'rp522-untracked-files-witness');
    const message = path.join(fixture, 'message.txt');
    await writeFile(preCommit, '#!/bin/sh\nprintf witness > .git/rp522-untracked-files-witness\n');
    await chmod(preCommit, 0o755);
    await writeFile(path.join(fixture, 'tracked.txt'), 'tracked\n');
    await writeFile(message, 'ordinary commit\n');
    await gitMustSucceed(['add', 'tracked.txt'], fixture);
    await gitMustSucceed(['commit', '-uno', '-F', message], fixture);
    await expect(readFile(witness, 'utf8')).resolves.toBe('witness');

    const allowed = await inspect('git commit -uno -m x');
    expect.soft(allowed.code, allowed.stderr).toBe(0);
    for (const command of ['git commit -n -uno -m x', 'git commit -uno -n -m x']) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(2);
    }
  });

  it('allows an attached optional GPG key selector while refusing separate bypass flags', async () => {
    const allowed = await inspect('git commit -Suntracked@example.invalid -m x');
    expect.soft(allowed.code, allowed.stderr).toBe(0);
    for (const command of ['git commit -S -n -m x', 'git commit -S --no-verify -m x']) {
      const result = await inspect(command);
      expect.soft(result.code, `${command}: ${result.stderr}`).toBe(2);
    }
  });

  it('allows documented required long commit-option operands while refusing trailing no-verify flags', async () => {
    const requiredValueOptions = [
      '--author',
      '--date',
      '--reedit-message',
      '--reuse-message',
      '--fixup',
      '--squash',
      '--template',
      '--cleanup',
      '--trailer',
      '--pathspec-from-file',
    ];
    for (const option of requiredValueOptions) {
      const result = await inspect(`git commit ${option} --no-verify`);
      expect.soft(result.code, `${option}: ${result.stderr}`).toBe(0);
    }
    for (const option of requiredValueOptions) {
      const result = await inspect(`git commit ${option} --no-verify -n`);
      expect.soft(result.code, `${option}: ${result.stderr}`).toBe(2);
    }
  });

  it('lets env -i clear inherited HUSKY while refusing an explicit replacement', async () => {
    const cleared = await inspect('HUSKY=0 env -i git commit -m x');
    expect.soft(cleared.code, cleared.stderr).toBe(0);
    const explicit = await inspect('HUSKY=0 env -i HUSKY=0 git commit -m x');
    expect(explicit.code, explicit.stderr).toBe(2);
  });

  it('refuses inherited HUSKY=0 while allowing environment-cleared commits and ordinary prose', async () => {
    const fixture = await newGitFixture();
    const hooks = path.join(fixture, '.git', 'hooks');
    const witness = path.join(fixture, '.git', 'rp522-inherited-husky-witness');
    await writeFile(
      path.join(hooks, 'pre-commit'),
      '#!/bin/sh\nif [ "${HUSKY:-}" = 0 ]; then exit 0; fi\nprintf witness > .git/rp522-inherited-husky-witness\n',
    );
    await chmod(path.join(hooks, 'pre-commit'), 0o755);
    await writeFile(path.join(fixture, 'tracked.txt'), 'husky inheritance\n');
    await gitMustSucceed(['add', 'tracked.txt'], fixture);

    const inherited = { ...gitEnv(), HUSKY: '0' };
    const bypass = await inspectWithEnv('git commit -m x', inherited, fixture);
    expect(bypass.code, bypass.stderr).toBe(2);
    const actualBypass = await git(['commit', '-m', 'husky bypass'], fixture, inherited);
    expect(actualBypass.code, actualBypass.stderr).toBe(0);
    await expect(readFile(witness, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    for (const command of ['env -i git commit -m x', 'env -u HUSKY git commit -m x']) {
      const cleared = await inspectWithEnv(command, inherited, fixture);
      expect.soft(cleared.code, `${command}: ${cleared.stderr}`).toBe(0);
    }
    const prose = await inspectWithEnv('printf %s HUSKY=0', inherited, fixture);
    expect(prose.code, prose.stderr).toBe(0);
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

  it('refuses a bypass evaluated by backticks inside double quotes', async () => {
    const result = await inspect('printf "%s" "`git commit --no-verify -m x`"');
    expect(result.code, result.stderr).toBe(2);
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

  it('refuses a bypass evaluated by backticks in an unquoted heredoc body', async () => {
    const expanded = await inspect('cat <<DOC\n`git commit --no-verify -m x`\nDOC');
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
