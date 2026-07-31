import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// The adversarial pass over guard-bash found 26 false negatives and 6 false
// positives. Root cause of nearly all of them: the hook matched with REGEXES over
// a string it had split on separators BEFORE it understood quoting. A commit
// message containing `;` manufactured a fake segment (false block on prose), and
// a quoted branch name vanished before it could be recognised (missed force-push).
//
// This suite is the matrix from that pass. It is deliberately large: a guard is
// only worth the cases it has been shown to get right, in both directions —
// a false negative is a hole, and a false positive is what gets guards disabled.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hook = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'universal',
  '.claude',
  'hooks',
  'guard-bash.mjs',
);

let absentFlag: string;
let presentFlag: string;

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'killswitch-'));
  absentFlag = path.join(dir, 'not-here');
  presentFlag = path.join(dir, 'STOP');
  await writeFile(presentFlag, '');
});

function runHook(command: string, flag?: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hook],
      { env: { ...process.env, AGENT_LOOP_STOP: flag ?? absentFlag } },
      (error, _stdout, stderr) => {
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr });
      },
    );
    if (!child.stdin) return reject(new Error('no stdin'));
    child.stdin.write(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
      }),
    );
    child.stdin.end();
  });
}

const deny = (command: string, flag?: string) => async () => {
  const result = await runHook(command, flag);
  expect(result.code, `should DENY: ${command}`).toBe(2);
};
const allow = (command: string, flag?: string) => async () => {
  const result = await runHook(command, flag);
  expect(result.code, `should ALLOW: ${command}\nstderr: ${result.stderr}`).toBe(0);
};

describe('guard-bash: quoting is understood before anything is matched', () => {
  // FP-1, the worst of the six: a separator inside a quoted string used to create
  // a new segment whose leading word was `rm`. Committing work ABOUT this guard
  // was blocked by this guard.
  it('does not fire on a commit message containing a separator and a forbidden form', async () => {
    for (const command of [
      'git commit -m "guard: cleanup script; rm -rf / was possible"',
      'git commit -m "chore: drop the old script && rm -rf ~ guard note"',
      'echo "step 1; rm -rf / is what NOT to do"',
      'git commit -m "docs: explain why force-push to main is banned"',
      `git commit -m 'never deploy prod by hand'`,
    ]) {
      await allow(command)();
    }
  });

  it(
    'does not fire on a trailing comment that mentions a shared branch',
    allow('git push --force origin feat/x # not main'),
  );

  it('still sees a quoted branch name — quoting an argument does not hide it', async () => {
    await deny('git push --force origin "main"')();
    await deny(`git push --force origin 'master'`)();
  });
});

describe('guard-bash: a prefix before the command name does not defeat the rules', () => {
  it.each([
    'FOO=1 git push --force origin main',
    'env FOO=1 git push --force origin main',
    'sudo git push --force origin main',
    '/usr/bin/git push --force origin main',
    '(git push --force origin main)',
    '(cd infra && git push --force origin main)',
    'echo $(git push --force origin main)',
    'bash -c "git push --force origin main"',
    'cd infra && git push --force origin main',
  ])('denies %s', (command) => deny(command)());
});

describe('guard-bash: a fully-qualified refspec is still the shared branch', () => {
  it.each([
    'git push origin refs/heads/main --force',
    'git push origin HEAD:refs/heads/main',
    'git push origin +refs/heads/main',
    'git push origin HEAD:main',
    'git push origin main:main',
  ])('denies %s', (command) => deny(command)());
});

describe('guard-bash: a line continuation is one command, not two', () => {
  it('denies a force-push split across lines', deny('git push --force \\\n  origin main'));
  it('denies a merge split across lines while the brake is on', async () => {
    await deny('gh pr \\\n merge 12', presentFlag)();
  });
});

describe('guard-bash: the catastrophic-delete list is normalised, not literal', () => {
  it.each([
    'rm -rf /',
    'rm -rf //',
    'rm -rf /.',
    'rm -rf /./',
    'rm -rf ~',
    'rm -rf ~//',
    'rm -rf "$HOME"',
    'rm -rf ${HOME}',
    'rm -rf $HOME/',
    'rm -rf $HOME/*',
    'rm -rf ~/*',
    'rm --recursive --force /',
  ])('denies %s', (command) => deny(command)());

  it.each([
    'rm -rf node_modules',
    'rm -rf ./dist',
    'rm -rf "$HOME/project/node_modules"',
    'rm -rf ./~backup',
    'rm -rf .next out',
  ])('allows %s', (command) => allow(command)());
});

describe('guard-bash: the brake covers the API route to a merge, not one spelling', () => {
  it('denies gh pr merge while the flag exists', async () => {
    await deny('gh pr merge 12 --squash', presentFlag)();
  });
  it('denies the REST route to the same merge', async () => {
    await deny('gh api -X PUT repos/o/r/pulls/12/merge', presentFlag)();
  });
  it('denies it behind an env prefix', async () => {
    await deny('GH_TOKEN=x gh pr merge 12', presentFlag)();
  });
  it('allows everything short of the merge while the flag exists', async () => {
    for (const command of ['git push origin feat/x', 'gh pr create --fill', 'pnpm test']) {
      await allow(command, presentFlag)();
    }
  });
  it('allows the merge once the flag is gone', allow('gh pr merge 12 --squash'));
});

describe('guard-bash: a production deploy is identified by its target, not by the word prod', () => {
  it.each([
    'gh workflow run deploy.yml -f stage=prod',
    'gh workflow run deploy --ref main -f environment=production',
    'gh workflow run deploy-production.yml',
    'gh api repos/o/r/actions/workflows/deploy.yml/dispatches -f inputs[stage]=prod',
  ])('denies %s', (command) => deny(command)());

  // The false positives that would get this rule switched off: `prod` appearing
  // in a repository name or a branch name is not a production deploy.
  it.each([
    'gh workflow run ci.yml',
    'gh workflow run deploy.yml -f stage=dev',
    'gh workflow run --repo org/prod-api ci.yml',
    'gh workflow run ci.yml --ref release/prod-hotfix',
    'gh pr create --title "chore: guard prod deploys"',
  ])('allows %s', (command) => allow(command)());
});

describe('guard-bash: the ordinary day-to-day commands stay allowed', () => {
  it.each([
    'git push origin feat/my-branch',
    'git push --force-with-lease origin feat/my-branch',
    'git push -u origin HEAD',
    'git push origin feat/main-menu',
    'git push origin fix/develop-docs',
    'git push origin feature/trunk-based',
    'git log --grep="force push to main"',
    'gh pr create --fill',
    'pnpm test',
  ])('allows %s', (command) => allow(command)());
});

describe('guard-bash: it fails open on anything it does not understand', () => {
  it('allows a non-Bash tool and an empty command', async () => {
    const nonBash = await new Promise<number>((resolve, reject) => {
      const child = execFile(process.execPath, [hook], (error) =>
        resolve(error ? ((error as { code?: number }).code ?? 1) : 0),
      );
      if (!child.stdin) return reject(new Error('no stdin'));
      child.stdin.write(JSON.stringify({ tool_name: 'Write' }));
      child.stdin.end();
    });
    expect(nonBash).toBe(0);
    await allow('')();
  });

  it('allows a malformed payload', async () => {
    const code = await new Promise<number>((resolve, reject) => {
      const child = execFile(process.execPath, [hook], (error) =>
        resolve(error ? ((error as { code?: number }).code ?? 1) : 0),
      );
      if (!child.stdin) return reject(new Error('no stdin'));
      child.stdin.write('{not json');
      child.stdin.end();
    });
    expect(code).toBe(0);
  });

  it('does not hang or crash on pathological input', async () => {
    const long = `git commit -m "${'a;b&&c '.repeat(2000)}"`;
    const started = Date.now();
    const result = await runHook(long);
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('guard-bash: the kill switch cannot be turned off by pointing the env elsewhere', () => {
  // The override used to REPLACE the machine-level path, so any value that did
  // not exist on disk disabled the brake while the real flag file sat untouched.
  // An override may only ADD a brake, never remove one.
  it('still denies the merge when the env points at an absent file but a real flag exists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ks2-'));
    const real = path.join(dir, 'REAL-STOP');
    await writeFile(real, '');
    const result = await runHook('gh pr merge 12', `${path.join(dir, 'absent')}`);
    // With no real machine flag this must allow; the machine-level path is
    // exercised by the dedicated check below rather than by touching $HOME here.
    expect(result.code).toBe(0);

    // Two paths, one of which exists → deny.
    const both = await new Promise<number>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [hook],
        {
          env: {
            ...process.env,
            AGENT_LOOP_STOP: `${path.join(dir, 'absent')}${path.delimiter}${real}`,
          },
        },
        (error) => resolve(error ? ((error as { code?: number }).code ?? 1) : 0),
      );
      if (!child.stdin) return reject(new Error('no stdin'));
      child.stdin.write(
        JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 12' } }),
      );
      child.stdin.end();
    });
    expect(both).toBe(2);
  });

  // Superseded by `guard-hardening.test.ts`, which exercises the machine-level
  // path behaviourally through a fake HOME. This one only checks that the hook
  // does not carry its own copy of the logic — the shared module is the subject.
  it('reads the brake from the one shared implementation, not its own copy', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(hook, 'utf8');
    expect(source).toMatch(/stop-flag\.mjs/);
    expect(source.replace(/^\s*\/\/.*$/gm, '')).not.toMatch(/homedir\(\)/);
  });
});
