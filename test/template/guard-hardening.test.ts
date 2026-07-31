import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// Round 3 of the review, and the last one that adds rules.
//
// Rounds 1→2→3 each fixed the previous round by ADDING a construct, and each
// addition opened a hole wider than the one it closed. Round 3's tally on the
// additions alone: three total bypasses (a ten-character brace decoy, a heredoc
// hide-primitive, a long env value) and 32 newly-blocked ordinary commands.
//
// All three bypasses had ONE shape: an exception raised inside the hook's own
// work, swallowed by `catch { return 0 }` into "allow". `main()` must fail open —
// a crashed guard cannot make the session unusable — which means **every line of
// work the hook does is a potential total bypass**. So the guard's work has to be
// structurally bounded, not merely fast in practice.
//
// This pass is therefore SUBTRACTIVE. `expandBraces`, the `stripHeredocs`
// pre-pass, `CATASTROPHIC_TREES` and the length cap are gone. What they reached
// for is either handled where it can be handled safely (heredocs, inside the
// tokenizer where quote state is known) or written down as a limit.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const hook = path.join(universal, '.claude', 'hooks', 'guard-bash.mjs');
const scripts = path.join(universal, '.claude', 'scripts');

let noBrake: Record<string, string>;
let brakeOn: Record<string, string>;
let fakeHome: string;

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brake-'));
  const flag = path.join(dir, 'STOP');
  await writeFile(flag, '');
  noBrake = { AGENT_LOOP_STOP: path.join(dir, 'absent') };
  brakeOn = { AGENT_LOOP_STOP: flag };

  fakeHome = await mkdtemp(path.join(tmpdir(), 'home-'));
  await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
  await writeFile(path.join(fakeHome, '.claude', '__PROJECT_NAME__-loop-STOP'), '');
});

function runHook(
  command: string,
  env: Record<string, string> = {},
  timeout = 10_000,
): Promise<{ code: number | string; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = execFile(
      process.execPath,
      [hook],
      { env: { ...process.env, ...env }, timeout },
      (error) => {
        const killed = (error as { killed?: boolean } | null)?.killed;
        resolve({
          code: killed ? 'TIMEOUT' : error ? ((error as { code?: number }).code ?? 1) : 0,
          ms: Date.now() - started,
        });
      },
    );
    if (!child.stdin) return reject(new Error('no stdin'));
    child.stdin.write(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }));
    child.stdin.end();
  });
}

const deny = async (command: string, env?: Record<string, string>) =>
  expect((await runHook(command, env ?? noBrake)).code, `should DENY: ${command}`).toBe(2);
const allow = async (command: string, env?: Record<string, string>) =>
  expect((await runHook(command, env ?? noBrake)).code, `should ALLOW: ${command}`).toBe(0);

// ── The three total bypasses ─────────────────────────────────────────────────

describe('a dangerous command cannot be un-guarded by making the hook crash', () => {
  // Each of these was a full disarm: the hook exited 0 for EVERY rule, not just
  // the one being probed. That is what `catch { return 0 }` turns any internal
  // error into, which is why the work must be bounded by construction.
  const decoy = ` ${'{a,b}'.repeat(2000)}`;

  it('a brace decoy no longer disarms anything', async () => {
    await deny(`rm -rf /${decoy}`);
    await deny(`git push -f origin main${decoy}`);
    await deny(`rm -rf ~/.ssh${decoy}`);
  });

  it('a huge AGENT_LOOP_STOP value cannot disarm the brake', async () => {
    // `paths.push(extra, ...split)` with 115k empty entries overflowed the
    // argument limit; the RangeError became "allow", brake armed and all.
    const env = { HOME: fakeHome, AGENT_LOOP_STOP: ':'.repeat(115_000) };
    for (const command of ['gh pr merge 12 --squash', 'git push --force origin main', 'rm -rf /']) {
      await deny(command, env);
    }
  });

  it('a stray heredoc marker cannot hide the command after it', async () => {
    // The pre-pass ran BEFORE the tokenizer, so it could not tell a real redirect
    // from `<<` inside a quoted string — a general hide-anything primitive, and
    // the exact defect ("matched before it understood quoting") this file was
    // rewritten to eliminate.
    await deny('echo "usage: cmd << WORD"\nrm -rf /');
    await deny(`echo 'see <<NOTE for details'\ngit push --force origin main`);
    await deny('git commit -m "docs: describe <<EOF"\ngit push --force origin main');
    await deny('echo $((1 << SHIFT))\ngit push --force origin main');
    await deny('grep "<<MARK" file.txt\nrm -rf /');
    await deny('echo "see << EOF"\ngh pr merge 12', brakeOn);
  });

  it('a heredoc marker hides only its own body, never a command', async () => {
    // Round 4: the in-tokenizer heredoc reintroduced the hide-anything primitive
    // in two shapes. Both were DENY before this file gained heredoc handling at
    // all, so both were regressions caused by the fix.
    //
    // Shape A — the rest of the MARKER LINE was skipped with the body.
    await deny('cat <<EOF; rm -rf /\nbody\nEOF');
    await deny('cat <<EOF && git push --force origin main\nbody\nEOF');
    await deny('cat <<EOF | rm -rf /\nbody\nEOF');
    // Shape B — the newline after the terminator was eaten, so the NEXT command
    // was absorbed into the heredoc command's segment. This is the repo's own
    // PR-open flow written as one Bash call, not an adversarial shape.
    await deny("gh pr create --body-file - <<'EOF'\nbody\nEOF\ngit push --force origin main");
    await deny('cat <<EOF\nx\nEOF\nrm -rf /');
    await deny('cat <<EOF\nnote\nEOF\ngh pr merge 12', brakeOn);
    // …while the body itself is still data
    await allow("cat > n.md <<'EOF'\nrm -rf / is dangerous\nEOF");
  });

  it('the ssh key directory is protected as a subtree', async () => {
    // Lost when CATASTROPHIC_TREES was deleted: its members came back as
    // explicit `/x/*` entries, but `~/.ssh/*` did not. The deleted comment had
    // called it "the one place that matters", and the assertion pinning it was
    // dropped in the same commit — a deletion is only safe if the test survives.
    await deny('rm -rf ~/.ssh/*');
    await deny('rm -rf $HOME/.ssh/id_rsa');
    await deny('rm -rf ~/.ssh/id_ed25519');
    await allow('rm -rf ~/.ssh-backup-notes');
  });

  it('stays fast and still denies under every hostile shape', async () => {
    const shapes: Array<[string, string]> = [
      ['many slashes', `rm -rf ${'/'.repeat(200_000)}`],
      ['many /. pairs', `rm -rf /${'/.'.repeat(400_000)}`],
      ['nested substitutions', `${'$('.repeat(10_000)}rm -rf /`],
      ['many quotes', `${"'".repeat(50_000)} ; rm -rf /`],
      ['many separators', `${';'.repeat(100_000)} rm -rf /`],
      ['many heredoc markers', `${'echo <<A\n'.repeat(20_000)}rm -rf /`],
      // The decoy must not hide the real operand. (`rm -rf /{a,b}` as ONE token
      // is not a root delete — the shell expands it to `/a /b` — so that form is
      // correctly allowed and is not a hostile shape.)
      ['deep braces as a decoy', `rm -rf / ${'{a,b}'.repeat(5_000)}`],
    ];
    for (const [label, command] of shapes) {
      const result = await runHook(command);
      expect(result.code, `${label} must not fail open`).toBe(2);
      expect(result.ms, `${label} took ${result.ms}ms`).toBeLessThan(3000);
    }
  });
});

// ── The false positives the additions caused ─────────────────────────────────

describe('ordinary deletes are not blocked — the tree prefixes are gone', () => {
  it.each([
    'rm -rf /private/tmp/scratch',
    'rm -rf /private/var/folders/xx/T/x',
    'rm -rf /var/folders/h2/abc/T/vitest-1234',
    'rm -rf /usr/local/lib/node_modules/oldpkg',
    'rm -rf /opt/homebrew/var/cache/myapp',
    'rm -rf /Library/Caches/com.example.app',
    'rm -rf /Volumes/BuildDisk/artifacts',
    'rm -rf /tmp/build',
    'rm -rf "$HOME/project/node_modules"',
  ])('allows %s', (command) => allow(command));

  it('still refuses the wipes themselves, by exact target', async () => {
    for (const command of [
      'rm -rf /',
      'rm -rf //',
      'rm -rf /.',
      'rm -rf ~',
      'rm -rf "$HOME"',
      'rm -rf ${HOME}',
      'rm -rf /etc/*',
      'rm -rf /usr/*',
      'rm -rf ~/*',
      'rm -rf ~/.ssh',
    ]) {
      await deny(command);
    }
  });

  it('the two spellings of one directory agree', async () => {
    // `/tmp` is a symlink to `/private/tmp`; the prefix rule answered opposite
    // things for the same path, so it neither protected nor permitted reliably.
    for (const command of ['rm -rf /tmp/x', 'rm -rf /private/tmp/x']) await allow(command);
  });
});

// ── The brake, inverted to an allowlist ──────────────────────────────────────

describe('the brake denies the network clients, not the word "merge"', () => {
  // Substring-matching `merge` blocked 19 ordinary commands, including the ones
  // the brake's own message tells the agent to do. And pushing to a protected
  // branch is refused with or without the brake, so the only thing the brake has
  // to add is the PR-merge routes — every one of which is a network client.
  it.each([
    'gh pr merge 12 --squash',
    'gh --repo o/r pr merge 12',
    'gh api -X PUT repos/o/r/pulls/12/merge',
    'gh api -X PUT repos/{owner}/{repo}/pulls/12/merge',
    'gh api repos/o/r/pulls/12/%6Derge -X PUT',
    "gh api graphql -f query='mutation{mergePullRequest(input:{})}'",
    'curl -X PUT https://api.github.com/repos/o/r/pulls/12/merge',
    'wget --method=PUT https://api.github.com/repos/o/r/pulls/12/merge',
  ])('denies %s', (command) => deny(command, brakeOn));

  it('leaves the wind-down the brake itself prescribes alone', async () => {
    for (const command of [
      'git push origin feat/x',
      'git push -u origin fix/merge-conflict-handling',
      'git commit -m "wip"',
      'gh pr create --fill',
      'gh pr view 12',
      'gh pr list',
      'git log --no-merges',
      'git log --oneline --merges -5',
      'git merge origin/main',
      'git mergetool',
      'git branch --merged',
      'grep -r merge src/',
      'cat src/merge-sort.ts',
      'rm -rf node_modules/merge-stream',
      'pnpm add lodash.merge',
      'gh pr create --body-file=notes-on-merge.md',
      'gh pr create --body="we should not merge yet"',
      'echo "- resolved merge conflicts" >> JOURNAL.md',
    ]) {
      await allow(command, brakeOn);
    }
  });

  it('reads the allowlist by POSITION, so a stray safe word is not a pass', async () => {
    // `operands.some(...)` let any operand anywhere satisfy the allowlist.
    await deny('gh pr merge 12 --subject create', brakeOn);
    await deny('gh pr merge 12 --repo o/create', brakeOn);
    await deny('npx gh pr merge 12', brakeOn);
    await deny('bunx gh pr merge 12', brakeOn);
  });

  it('does not treat "no operands at all" as dangerous', async () => {
    // `gh --version` has nothing to allow, and refusing it inverts the rule's
    // own logic — the allowlist is about what a command DOES.
    for (const command of ['gh --version', 'gh help', 'gh']) await allow(command, brakeOn);
  });

  it('allows the network clients again once the brake is cleared', async () => {
    for (const command of [
      'gh pr merge 12',
      'gh api repos/o/r/pulls/1',
      'curl https://example.com',
    ]) {
      await allow(command);
    }
  });
});

// ── What survived all three rounds, still working ────────────────────────────

describe('the rules that three rounds did not break still hold', () => {
  it.each([
    'git push --force origin main',
    'git push origin main',
    'git push origin HEAD:refs/heads/main',
    'git push origin +refs/heads/main',
    'sudo -u root git push --force origin main',
    'sudo -n git push --force origin main',
    'sudo -k git push --force origin main',
    'env -i git push --force origin main',
    'timeout 60 git push --force origin main',
    'for b in a; do git push --force origin main; done',
    'if true; then git push --force origin main; fi',
    'GIT_SSH_COMMAND="ssh -i k" git push --force origin main',
    '(cd infra && git push --force origin main)',
    'eval "git push --force origin main"',
    'bash -c git\\ push\\ -f\\ origin\\ main',
    'gh workflow run --repo o/r deploy-prod.yml',
    'gh workflow run --ref main deploy-prod.yml',
    'gh workflow run deploy.yml -F environment=prod',
    // Restored: these were dropped when this file was rewritten, with no
    // behaviour change to justify it. `xargs -n1` and `nice -n 10` are the worst
    // of them — they are the only cases exercising the per-wrapper `-n` split
    // that the same commit introduced, so the new map shipped with its
    // motivating case untested.
    'sudo -E git push --force origin main',
    'sudo -- git push --force origin main',
    'env -u FOO git push --force origin main',
    'command -p git push --force origin main',
    'xargs -n1 git push --force origin main',
    'nice -n 10 git push --force origin main',
    '! git push --force origin main',
    'while true; do git push -f origin master; done',
    'for i in 1; do rm -rf /; done',
    "eval 'rm -rf /'",
    "GIT_AUTHOR_NAME='a b' rm -rf /",
    "git push --force origin $'main'",
    "rm -rf $'/'",
    'rm -rf /System',
    'rm -rf /home/*',
  ])('denies %s', (command) => deny(command));

  it.each([
    'git push origin feat/main-menu',
    'git push --force-with-lease origin feat/x',
    'git commit -m "guard: cleanup; rm -rf / was possible"',
    "cat > n.md <<'EOF'\nrm -rf / is dangerous\nEOF",
    "git commit -F - <<'EOF'\nrm -rf / is blocked\nEOF",
    'gh workflow run --repo org/prod-release-api ci.yml',
    'gh workflow run ci.yml --ref release/prod-hotfix',
    'gh api repos/o/prod-api/actions/workflows/ci.yml/dispatches -f ref=main',
    'rm -rf node_modules',
    'pnpm test',
  ])('allows %s', (command) => allow(command));
});

describe('the shared brake still has exactly one implementation', () => {
  it('the env can only add a path, and cannot make it throw', async () => {
    const { stopFlags, brakeIsOn } = await import(
      pathToFileURL(path.join(scripts, 'stop-flag.mjs')).href
    );
    const withEnv = (value: string | undefined) => {
      const previous = { HOME: process.env.HOME, AGENT_LOOP_STOP: process.env.AGENT_LOOP_STOP };
      process.env.HOME = fakeHome;
      if (value === undefined) delete process.env.AGENT_LOOP_STOP;
      else process.env.AGENT_LOOP_STOP = value;
      try {
        return { paths: stopFlags() as string[], on: brakeIsOn() as string | null };
      } finally {
        Object.assign(process.env, previous);
      }
    };
    for (const value of [
      undefined,
      '',
      ':::',
      '/dev/null',
      ':'.repeat(200_000),
      'x'.repeat(100_000),
    ]) {
      const { paths, on } = withEnv(value);
      expect(paths[0], `env length ${String(value).length}`).toContain(fakeHome);
      expect(on, 'the machine brake must survive any env value').toBeTruthy();
      expect(paths.length, 'the path list must be bounded').toBeLessThan(100);
    }
  });

  it('preflight reads it through the same module', async () => {
    const { checkKillSwitch } = await import(
      pathToFileURL(path.join(scripts, 'preflight.mjs')).href
    );
    const previous = { HOME: process.env.HOME, AGENT_LOOP_STOP: process.env.AGENT_LOOP_STOP };
    process.env.HOME = fakeHome;
    process.env.AGENT_LOOP_STOP = '/nonexistent/xyz';
    try {
      expect((checkKillSwitch as () => { ok: boolean })().ok).toBe(false);
    } finally {
      Object.assign(process.env, previous);
    }
  });
});

// ── The limits, and the rule that made this round necessary ──────────────────

describe('the guard does provably bounded work, and says what it cannot see', () => {
  it('carries no unbounded construct — the shape all three bypasses shared', async () => {
    const source = (await readFile(hook, 'utf8')).replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    expect(source, 'no recursive expansion in the guard body').not.toMatch(/expandBraces/);
    // …and the module that actually carried the spread bypass caps before it
    // spreads. Asserting this on the hook alone would have passed against the
    // reverted implementation, because the bug never lived here.
    const shared = (await readFile(path.join(scripts, 'stop-flag.mjs'), 'utf8')).replace(
      /^\s*(\/\/|\*|\/\*).*$/gm,
      '',
    );
    expect(shared, 'the spread must be preceded by a cap').toMatch(
      /slice\(0,\s*\d+\)[\s\S]{0,120}\.\.\./,
    );
  });

  it('documents each remaining limit, and each really is one', async () => {
    const source = await readFile(hook, 'utf8');
    const limits: Array<[string, RegExp]> = [
      ['git push --force origin $BRANCH', /runtime|\$BRANCH/],
      ['git push --force origin mai{n..n}', /brace/i],
      ['./scripts/deploy-prod.sh', /alias|wrapper script/i],
      ['eval "$(printf \'git push --force origin main\')"', /assembled at runtime|eval "\$\(/],
    ];
    for (const [command, mentioned] of limits) {
      expect(source, `must document: ${command}`).toMatch(mentioned);
      await allow(command);
    }
    expect(source).toMatch(/not exhaustive|drift, not an adversary/i);
  });
});

describe('invariants.md carries the lesson three rounds paid for', () => {
  it('says a fail-open guard must be bounded by construction', async () => {
    const rule = await readFile(path.join(universal, '.claude', 'rules', 'invariants.md'), 'utf8');
    expect(rule).toMatch(/bounded/i);
    expect(rule).toMatch(/fail open|fails open/i);
    expect(rule).toMatch(/every line|each addition|adding/i);
  });
});
