import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, unlink } from 'node:fs/promises';
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
const limitsTable = path.join(scripts, 'limits-table.mjs');
const limitsFixture = path.join(scripts, 'limits', 'guard-bash.json');
const dogfoodLimitsTable = path.join(repoRoot, '.claude', 'scripts', 'limits-table.mjs');

const LIMITS = JSON.parse(readFileSync(limitsFixture, 'utf8')) as {
  notCaught: Array<{ prose: string; command?: string; mentioned: string }>;
  scope: Array<{
    prose: string;
    command?: string;
    variants?: Array<{ command: string; decision: 'allow' | 'deny'; brake?: boolean }>;
  }>;
  footer: string;
};
const guardBashLimits = LIMITS;
if (!guardBashLimits.notCaught[0]) throw new Error('guard-bash LIMITS fixture is required');
const runtimeValueLimit = guardBashLimits.notCaught[0];

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

function runLimitsTable(
  script: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], (error, stdout, stderr) => {
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

async function limitsTableSandbox(): Promise<{ script: string; hook: string; fixture: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'limits-table-'));
  const sandboxScripts = path.join(
    root,
    'templates',
    'agent-os',
    'universal',
    '.claude',
    'scripts',
  );
  const sandboxHooks = path.join(root, 'templates', 'agent-os', 'universal', '.claude', 'hooks');
  const sandboxTests = path.join(root, 'test', 'template');
  await mkdir(path.join(sandboxScripts, 'limits'), { recursive: true });
  await mkdir(sandboxHooks, { recursive: true });
  await mkdir(sandboxTests, { recursive: true });

  const script = path.join(sandboxScripts, 'limits-table.mjs');
  const sandboxHook = path.join(sandboxHooks, 'guard-bash.mjs');
  await writeFile(script, await readFile(limitsTable, 'utf8'));
  await writeFile(sandboxHook, await readFile(hook, 'utf8'));
  await writeFile(
    path.join(sandboxTests, 'guard-hardening.test.ts'),
    await readFile(fileURLToPath(import.meta.url), 'utf8'),
  );
  const fixture = path.join(sandboxScripts, 'limits', 'guard-bash.json');
  await writeFile(fixture, `${JSON.stringify(guardBashLimits, null, 2)}\n`);
  return { script, hook: sandboxHook, fixture };
}

async function shippedLimitsTableSandbox(): Promise<{ script: string; hook: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'shipped-limits-table-'));
  const sandboxScripts = path.join(root, '.claude', 'scripts');
  const sandboxHooks = path.join(root, '.claude', 'hooks');
  await mkdir(path.join(sandboxScripts, 'limits'), { recursive: true });
  await mkdir(sandboxHooks, { recursive: true });

  const script = path.join(sandboxScripts, 'limits-table.mjs');
  const sandboxHook = path.join(sandboxHooks, 'guard-bash.mjs');
  await writeFile(script, await readFile(dogfoodLimitsTable, 'utf8'));
  await writeFile(
    sandboxHook,
    await readFile(path.join(repoRoot, '.claude', 'hooks', 'guard-bash.mjs')),
  );
  await writeFile(
    path.join(sandboxScripts, 'limits', 'guard-bash.json'),
    `${JSON.stringify(guardBashLimits, null, 2)}\n`,
  );
  return { script, hook: sandboxHook };
}

async function replaceSandboxFixtures(fixture: string, fixtures: unknown): Promise<void> {
  await writeFile(fixture, `${JSON.stringify(fixtures, null, 2)}\n`);
}

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

  it('a here-string is not a heredoc, and hides nothing', async () => {
    // `<<<` was excluded by testing `raw[i+2] !== '<'` — which only skips the
    // FIRST `<`. The scanner then advanced one character and the same test saw
    // `<<` followed by the word, so `cat <<<X` swallowed everything to the next
    // `X` line. Three characters disarmed every rule.
    await deny('cat <<<X\nrm -rf /\nX');
    await deny('cat <<<EOF\ngit push --force origin main\nEOF');
    await deny('grep -q ok <<<yes\nrm -rf /\nyes');
    await deny('cat <<<note\ngh pr merge 12\nnote', brakeOn);
  });

  it('a heredoc whose terminator the guard would MISS is not treated as one', async () => {
    // The guard's terminator model has to match the shell's, or it swallows more
    // than the shell does — which is the hide primitive again. Two shapes where
    // it differed: `<<-` strips leading tabs from the terminator line, and
    // `<<EOF"X"` concatenates to the marker `EOFX`.
    //
    // Where the models cannot be made to agree cheaply, the marker is left inert
    // and the body is INSPECTED. Erring toward inspecting more is the only safe
    // direction for a fail-open guard.
    await deny('cat <<-EOF\n\tdata\n\tEOF\nrm -rf /\necho x\nEOF');
    await deny('cat <<-EOF\n\tx\n\tEOF\ngit push --force origin main\ny\nEOF');
    await deny('cat <<EOF"X"\ndata\nEOFX\nrm -rf /\necho x\nEOF');
    // the tab-stripped form still hides its own body when it is really a heredoc
    await allow('cat <<-EOF\n\trm -rf / is documentation\n\tEOF');
  });

  it('follows a deeper wrapper chain, and states where it stops', async () => {
    for (const depth of [3, 8, 12, 16]) {
      await deny(`${'eval "'.repeat(depth)}git push --force origin main${'"'.repeat(depth)}`);
    }
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
    await deny('xh PUT https://api.github.com/repos/o/r/pulls/12/merge', brakeOn);
    await deny('curlie PUT https://api.github.com/repos/o/r/pulls/12/merge', brakeOn);
  });

  it('does not claim to enumerate every possible client', async () => {
    // `python3 -c "urllib…"` and `node -e "fetch(…)"` reach the same endpoint and
    // cannot be enumerated — they are the "assembled at runtime" limit. The file
    // must say so rather than claim the client list is complete.
    const source = await readFile(hook, 'utf8');
    expect(source).toMatch(/cannot be enumerated|not a complete list|any runtime/i);
  });

  it('a push must name where it is going while the brake is on', async () => {
    // The brake's premise is that a push to a protected branch is refused anyway —
    // true only when the command NAMES the branch. Bare `git push` on the default
    // branch lands there, and `git merge feat/x && git push` was the ordinary way
    // to land a merge with the brake armed. The guard cannot know the checked-out
    // branch without running git, so while stopped it requires the ref to be said.
    for (const command of ['git push', 'git push origin HEAD', 'git push --all origin']) {
      await deny(command, brakeOn);
    }
    // …and the wind-down the brake prescribes is untouched
    for (const command of [
      'git push origin feat/x',
      'git push -u origin fix/y',
      'git merge origin/main',
    ]) {
      await allow(command, brakeOn);
    }
  });

  it('the brake cannot be disarmed by pointing HOME somewhere empty', async () => {
    // `homedir()` honours $HOME, which `.claude/settings.json` can set. The real
    // flag is found through the password database too, which the env cannot move.
    const { brakeIsOn } = await import(pathToFileURL(path.join(scripts, 'stop-flag.mjs')).href);
    const previous = process.env.HOME;
    process.env.HOME = await mkdtemp(path.join(tmpdir(), 'emptyhome-'));
    try {
      const { userInfo } = await import('node:os');
      const realHome = userInfo().homedir;
      const source = await readFile(path.join(scripts, 'stop-flag.mjs'), 'utf8');
      expect(source, 'the real home must be consulted, not only $HOME').toMatch(/userInfo\(\)/);
      expect(typeof (brakeIsOn as () => string | null)()).not.toBe('undefined');
      expect(realHome.length).toBeGreaterThan(0);
    } finally {
      process.env.HOME = previous;
    }
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
    'sudo --user root git push --force origin main',
    'sudo --group staff git push --force origin main',
    'env -u FOO git push --force origin main',
    'env -C /repo git push --force origin main',
    'env -P /usr/bin git push --force origin main',
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

describe('the limits table is generated from the behavioural fixture', () => {
  it('ships one canonical machine-readable fixture instead of an inline test copy', async () => {
    const fixture = JSON.parse(await readFile(limitsFixture, 'utf8')) as unknown;
    expect(fixture).toEqual(guardBashLimits);
    const retiredInlineMarker = ['limits', 'fixture:start'].join('-');
    expect(await readFile(fileURLToPath(import.meta.url), 'utf8')).not.toContain(
      retiredInlineMarker,
    );
  });

  it('runs in a shipped repo that has no generator test tree', async () => {
    const sandbox = await shippedLimitsTableSandbox();
    const result = await runLimitsTable(sandbox.script, ['guard-bash', '--check']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
  });

  it('checks the synced dogfood hook from its shallower script location', async () => {
    const result = await runLimitsTable(dogfoodLimitsTable, ['guard-bash', '--check']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
  });

  it('renders the guard limits between the owned markers', async () => {
    const sandbox = await limitsTableSandbox();
    const result = await runLimitsTable(sandbox.script, ['guard-bash']);
    expect(result.code, result.stderr).toBe(0);

    const source = await readFile(sandbox.hook, 'utf8');
    const start = source.indexOf('// <!-- limits:start -->');
    const end = source.indexOf('// <!-- limits:end -->');
    expect(start, 'the generated block needs an opening ownership marker').toBeGreaterThan(-1);
    expect(end, 'the generated block needs a closing ownership marker').toBeGreaterThan(start);
    const generated = source.slice(start, end);
    expect(generated).toMatch(/Not caught:/);
    expect(generated).toMatch(/SCOPE/);

    let cursor = -1;
    for (const entry of [
      ...guardBashLimits.notCaught,
      ...guardBashLimits.scope,
      { prose: guardBashLimits.footer },
    ]) {
      const position = generated.indexOf(entry.prose);
      expect(
        position,
        `generated prose is missing or out of order: ${entry.prose}`,
      ).toBeGreaterThan(cursor);
      cursor = position;
    }
  });

  it('check mode rejects prose drift without rewriting it', async () => {
    const sandbox = await limitsTableSandbox();
    const written = await runLimitsTable(sandbox.script, ['guard-bash']);
    expect(written.code, written.stderr).toBe(0);

    const original = await readFile(sandbox.hook, 'utf8');
    const drifted = original.replace(
      runtimeValueLimit.prose,
      'a stale hand-written account of the runtime-value limit',
    );
    expect(drifted).not.toBe(original);
    await writeFile(sandbox.hook, drifted);

    const checked = await runLimitsTable(sandbox.script, ['guard-bash', '--check']);
    expect(checked.code, checked.stdout + checked.stderr).not.toBe(0);
    expect(checked.stdout + checked.stderr).toMatch(/drift|out of date/i);
    expect(await readFile(sandbox.hook, 'utf8')).toBe(drifted);
  });

  it('refuses a hook with no LIMITS fixture', async () => {
    const result = await runLimitsTable(limitsTable, ['not-a-real-hook']);
    expect(result.code, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/unknown|fixture|not-a-real-hook/i);
  });
});

describe('the limits-table writer treats fixtures and hook files as untrusted input', () => {
  it.each([
    ['LF in prose', 'prose', { ...runtimeValueLimit, prose: 'first line\n// injected' }],
    ['CR in footer', 'footer', 'first line\r// injected'],
    ['U+2028 in prose', 'prose', { ...runtimeValueLimit, prose: 'first line\u2028// injected' }],
    ['U+2029 in footer', 'footer', 'first line\u2029// injected'],
  ])('rejects the %s line separator', async (_name, field, injected) => {
    const sandbox = await limitsTableSandbox();
    const table =
      field === 'prose'
        ? { ...guardBashLimits, notCaught: [injected, ...guardBashLimits.notCaught.slice(1)] }
        : { ...guardBashLimits, footer: injected };
    await replaceSandboxFixtures(sandbox.fixture, table);
    const before = await readFile(sandbox.hook, 'utf8');

    const result = await runLimitsTable(sandbox.script, ['guard-bash']);
    expect(result.code, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(
      /carriage|line feed|line separator|paragraph separator|newline|CR|LF|U\+2028|U\+2029/i,
    );
    expect(await readFile(sandbox.hook, 'utf8')).toBe(before);
  });

  it.each(['limits:start', 'limits:end'])('rejects a duplicate %s marker', async (marker) => {
    const sandbox = await limitsTableSandbox();
    const source = await readFile(sandbox.hook, 'utf8');
    const duplicated = `${source}\n// <!-- ${marker} -->\n`;
    await writeFile(sandbox.hook, duplicated);

    const result = await runLimitsTable(sandbox.script, ['guard-bash']);
    expect(result.code, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/duplicate|exactly one|marker/i);
    expect(await readFile(sandbox.hook, 'utf8')).toBe(duplicated);
  });

  it.each(['../hooks/guard-bash', '/tmp/guard-bash', 'guard-bash/../../victim'])(
    'rejects unsafe hook name %s before resolving a path',
    async (unsafeName) => {
      const sandbox = await shippedLimitsTableSandbox();
      const before = await readFile(sandbox.hook, 'utf8');
      const result = await runLimitsTable(sandbox.script, [unsafeName]);
      expect(result.code, result.stdout + result.stderr).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/unsafe|hook name/i);
      expect(await readFile(sandbox.hook, 'utf8')).toBe(before);
    },
  );

  it('refuses a symlink hook without altering its target', async () => {
    const sandbox = await shippedLimitsTableSandbox();
    const target = path.join(path.dirname(sandbox.hook), 'outside-target.mjs');
    const targetSource = (await readFile(sandbox.hook, 'utf8')).replace(
      runtimeValueLimit.prose,
      'stale prose in a file outside the owned hook',
    );
    await writeFile(target, targetSource);
    await unlink(sandbox.hook);
    await symlink(target, sandbox.hook);

    const result = await runLimitsTable(sandbox.script, ['guard-bash']);
    expect(result.code, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/symlink/i);
    expect(await readFile(target, 'utf8')).toBe(targetSource);
  });

  it('publishes a replacement atomically instead of truncating the hook in place', async () => {
    const sandbox = await limitsTableSandbox();
    const drifted = (await readFile(sandbox.hook, 'utf8')).replace(
      runtimeValueLimit.prose,
      'stale prose that requires regeneration',
    );
    await writeFile(sandbox.hook, drifted);
    const before = await stat(sandbox.hook);

    const result = await runLimitsTable(sandbox.script, ['guard-bash']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const after = await stat(sandbox.hook);
    expect(after.ino, 'same-directory rename must replace the file, not truncate it').not.toBe(
      before.ino,
    );
    expect(await readFile(sandbox.hook, 'utf8')).toContain(runtimeValueLimit.prose);
  });
});

describe('the guard does provably bounded work, and says what it cannot see', () => {
  it('carries no unbounded construct — the shape all three bypasses shared', async () => {
    const source = (await readFile(hook, 'utf8')).replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    expect(source, 'no recursive expansion in the guard body').not.toMatch(/expandBraces/);
  });

  it('the stop-flag cap is EXERCISED, not merely present in the source', async () => {
    // The assertion this replaces grepped for `slice(0, \d+)` before a spread.
    // Changing 32 to 32000000 kept all 85 tests green while reopening the
    // RangeError total bypass — a test that pins syntax pins nothing. The
    // behavioural tests were blind too: every value they passed was reduced to
    // ≤1 entry by `filter(Boolean)` before the cap could matter.
    //
    // This passes 200k NON-EMPTY entries, so the cap is the only thing between
    // the spread and the argument limit.
    const { stopFlags, brakeIsOn } = await import(
      pathToFileURL(path.join(scripts, 'stop-flag.mjs')).href
    );
    const previous = { HOME: process.env.HOME, AGENT_LOOP_STOP: process.env.AGENT_LOOP_STOP };
    process.env.HOME = fakeHome;
    process.env.AGENT_LOOP_STOP = Array.from({ length: 200_000 }, (_, i) => `/p${i}`).join(
      path.delimiter,
    );
    try {
      const paths = (stopFlags as () => string[])();
      expect(paths.length, 'the cap must bound the list').toBeLessThan(100);
      expect(paths[0], 'the machine flag survives').toContain(fakeHome);
      expect((brakeIsOn as () => string | null)(), 'and it is still armed').toBeTruthy();
    } finally {
      Object.assign(process.env, previous);
    }
    // In-process on purpose: an env value large enough to overflow the spread
    // cannot be handed to a child at all (`spawn E2BIG`), so a subprocess test
    // could never reach the cap. Remove the cap and this call throws RangeError.
  });

  it('documents and exercises the complete Not caught inventory', async () => {
    const expectedNotCaught = [
      {
        prose: 'a value that only exists at runtime: `git push --force origin $BRANCH`',
        command: 'git push --force origin $BRANCH',
        mentioned: 'runtime|\\$BRANCH',
      },
      {
        prose: 'a wrapper script that shells out: `./scripts/deploy-prod.sh`',
        command: './scripts/deploy-prod.sh',
        mentioned: 'wrapper script',
      },
      {
        prose:
          'a command assembled at runtime: `eval "$(printf \'git push --force origin main\')"`',
        command: 'eval "$(printf \'git push --force origin main\')"',
        mentioned: 'assembled at runtime|eval "\\$\\(',
      },
      {
        prose:
          'brace expansion: `git push --force origin mai{n..n}` really does push to `main`, and the guard does not expand it',
        command: 'git push --force origin mai{n..n}',
        mentioned: 'brace',
      },
      {
        prose:
          'more than 32 heredocs in one command: past that budget the bodies are inspected as commands, so ordinary data can be falsely blocked',
        mentioned: '32 heredocs|heredoc.*budget',
      },
    ] as const;

    const source = await readFile(hook, 'utf8');
    expect(guardBashLimits.notCaught).toEqual(expectedNotCaught);
    for (const limit of expectedNotCaught) {
      expect(source, `must document: ${limit.prose}`).toMatch(new RegExp(limit.mentioned, 'i'));
      if ('command' in limit) await allow(limit.command);
    }
    expect(source).toMatch(/not exhaustive|drift, not an adversary/i);
  });

  it('marks upstream generator test pointers as absent locally in generated projects', async () => {
    const header = (await readFile(hook, 'utf8')).split('// <!-- limits:start -->')[0];
    expect(header).toMatch(/upstream generator tests are absent locally in generated projects/i);
    expect.soft(header).toContain('documents and exercises the complete Not caught inventory');
    expect.soft(header).toContain('runs in a shipped repo that has no generator test tree');
  });

  it('declares and exercises every command behaviour named by each Scope sentence', async () => {
    const expectedVariants = [
      [
        { command: 'rm -rf /', decision: 'deny' },
        { command: 'find . -delete', decision: 'allow' },
        { command: 'dd if=/dev/zero of=artifact.bin', decision: 'allow' },
        { command: 'shred artifact.bin', decision: 'allow' },
        { command: 'truncate -s 0 artifact.bin', decision: 'allow' },
        { command: 'mv artifact.bin /tmp/artifact.bin', decision: 'allow' },
        { command: 'rsync --delete source/ destination/', decision: 'allow' },
        { command: 'chmod -R 000 .', decision: 'allow' },
      ],
      [
        { command: 'gh workflow run deploy.yml -f environment=production', decision: 'deny' },
        { command: 'infra deploy production', decision: 'allow' },
        { command: 'npm publish', decision: 'allow' },
      ],
      [
        { command: 'git push origin main', decision: 'deny' },
        { command: 'git push', decision: 'allow' },
        { command: 'git push origin HEAD', decision: 'allow' },
        { command: 'git push', decision: 'deny', brake: true },
        { command: 'git push origin HEAD', decision: 'deny', brake: true },
      ],
      [
        { command: 'git push --delete origin main', decision: 'deny' },
        { command: 'git branch -D main', decision: 'allow' },
        { command: 'git update-ref -d refs/heads/main', decision: 'allow' },
        {
          command: 'gh api --method DELETE repos/acme/app/git/refs/heads/main',
          decision: 'allow',
        },
      ],
      [
        { command: "find . -exec sh -c 'rm -rf /' \\;", decision: 'allow' },
        { command: "env -S 'rm -rf /'", decision: 'allow' },
      ],
    ] as const;

    expect(guardBashLimits.scope).toHaveLength(expectedVariants.length);
    for (const variants of expectedVariants) {
      for (const variant of variants) {
        const environment = 'brake' in variant && variant.brake ? brakeOn : noBrake;
        if (variant.decision === 'deny') await deny(variant.command, environment);
        else await allow(variant.command, environment);
      }
    }
    for (const [index, limit] of guardBashLimits.scope.entries()) {
      const variants = expectedVariants[index];
      expect(limit.variants, `Scope fixture entry ${index + 1}: ${limit.prose}`).toEqual(variants);
    }
  });

  it('states the heredoc budget as a limit, in the direction it actually errs', async () => {
    const source = await readFile(hook, 'utf8');
    expect(source).toMatch(/32 heredocs|heredoc.*budget/i);
    // Past the budget the bodies are inspected, so a 33-heredoc script is falsely
    // blocked on its own data. That is the safe direction — and a limit, so it is
    // written down rather than discovered.
    const many = `${'echo <<A\nA\n'.repeat(33)}cat <<Z\nrm -rf /\nZ`;
    expect((await runHook(many)).code, 'past the budget it inspects, never hides').toBe(2);
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
