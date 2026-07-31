import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// Second review pass over the guard. Three reviewers returned HOLD; this suite
// pins what was actually fixed and — just as importantly — what is now HONESTLY
// declared as out of scope.
//
// The governing idea: **match each rule's precision to the cost of a false
// positive.** While the brake is on, a false block costs nothing (the session is
// stopped anyway), so that rule is deliberately coarse. Everyday rules stay narrow,
// because a guard that fires on ordinary work gets disabled.

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

  // A home directory carrying the machine-level flag, so the DEFAULT path is
  // exercised rather than only the env override.
  fakeHome = await mkdtemp(path.join(tmpdir(), 'home-'));
  await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
  await writeFile(path.join(fakeHome, '.claude', '__PROJECT_NAME__-loop-STOP'), '');
});

function runHook(
  command: string,
  env: Record<string, string> = {},
  timeout = 15_000,
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

// ── D. the only place the hook was worse than no hook ────────────────────────

describe('D. a long path cannot stall the hook into failing open', () => {
  // The collapse loop was quadratic: one full string copy per `/.`. At 1.4MB the
  // hook was KILLED by its timeout — and a killed hook does not block, so every
  // rule silently switched off for that command.
  it('stays fast on a pathological path, and still blocks the real action', async () => {
    const command = `cd /tmp${'/.'.repeat(300_000)} && git push --force origin main`;
    const result = await runHook(command, noBrake);
    expect(result.code, 'must still deny, not time out').toBe(2);
    expect(result.ms).toBeLessThan(3000);
  });

  it('normalizeTarget is linear', async () => {
    const { normalizeTarget } = await import(pathToFileURL(hook).href);
    const time = (n: number) => {
      const started = Date.now();
      (normalizeTarget as (s: string) => string)(`/tmp${'/.'.repeat(n)}`);
      return Date.now() - started;
    };
    time(50_000); // warm
    expect(time(400_000)).toBeLessThan(500);
  });
});

// ── B. one implementation of the brake, used by everything ───────────────────

describe('B. the stop flag has one implementation, shared', () => {
  it('both the hook and preflight import it rather than re-deriving it', async () => {
    const shared = await readFile(path.join(scripts, 'stop-flag.mjs'), 'utf8');
    expect(shared).toMatch(/homedir\(\)/);
    for (const file of [hook, path.join(scripts, 'preflight.mjs')]) {
      const source = await readFile(file, 'utf8');
      expect(source, file).toMatch(/stop-flag\.mjs/);
      // Neither may derive the path itself — one implementation means exactly one
      // place computes it, so there is only one place to get it wrong.
      expect(source.replace(/^\s*\/\/.*$/gm, ''), file).not.toMatch(/homedir\(\)/);
    }
  });

  it('the env variable can only ADD a brake, never remove the machine-level one', async () => {
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
    for (const value of [undefined, '', '/nonexistent/xyz', ':::', '/dev/null']) {
      const { paths, on } = withEnv(value);
      expect(paths[0], String(value)).toContain(fakeHome);
      expect(on, `env=${String(value)} must not disable the machine brake`).toBeTruthy();
    }
  });

  it('preflight reports the brake through the same path — the sibling hole is closed', async () => {
    const { checkKillSwitch } = await import(
      pathToFileURL(path.join(scripts, 'preflight.mjs')).href
    );
    const previous = { HOME: process.env.HOME, AGENT_LOOP_STOP: process.env.AGENT_LOOP_STOP };
    process.env.HOME = fakeHome;
    process.env.AGENT_LOOP_STOP = '/nonexistent/xyz';
    try {
      // Before the fix this reported ok:true ("absent") while the operator's real
      // flag sat untouched — and preflight is the ONLY scripted brake check.
      expect((checkKillSwitch as () => { ok: boolean })().ok).toBe(false);
    } finally {
      Object.assign(process.env, previous);
    }
  });

  it('the hook honours the machine-level flag with the env pointing elsewhere', async () => {
    await deny('gh pr merge 12', { HOME: fakeHome, AGENT_LOOP_STOP: '/nonexistent/xyz' });
  });
});

// ── A. the brake is coarse on purpose ────────────────────────────────────────

describe('A. while the brake is on, nothing that looks like a merge gets through', () => {
  it.each([
    'gh pr merge 12 --squash',
    'gh --repo o/r pr merge 12',
    'gh -R o/r pr merge 12',
    'gh api -X PUT repos/o/r/pulls/12/merge',
    'gh api -X PUT repos/{owner}/{repo}/pulls/12/merge',
    'curl -X PUT https://api.github.com/repos/o/r/pulls/12/merge',
    "gh api graphql -f query='mutation{mergePullRequest(input:{})}'",
    'git merge --ff-only origin/main',
  ])('denies %s', async (command) => deny(command, brakeOn));

  it('leaves every other step of finishing the task alone', async () => {
    // "Stop cleanly" must never mean "lose the work".
    for (const command of [
      'git push origin feat/x',
      'git commit -m "wip"',
      'gh pr create --fill',
      'pnpm test',
      'git status',
    ]) {
      await allow(command, brakeOn);
    }
  });

  it('does not fire on the word inside quoted prose, even while braked', async () => {
    // Coarse is fine; firing on a journal entry is not.
    for (const command of [
      'git commit -m "merge the two helper functions"',
      `gh pr create --body 'explains why we do not merge yet'`,
    ]) {
      await allow(command, brakeOn);
    }
  });

  it('allows the merge again once the brake is cleared', async () => allow('gh pr merge 12'));
});

// ── C. the drift-shaped misses ───────────────────────────────────────────────

describe('C. ordinary spellings an agent actually writes are covered', () => {
  it.each([
    'sudo -u root git push --force origin main',
    'sudo -E git push --force origin main',
    'sudo -- git push --force origin main',
    'env -i git push --force origin main',
    'env -u FOO git push --force origin main',
    'command -p git push --force origin main',
    'xargs -n1 git push --force origin main',
    'timeout 60 git push --force origin main',
    'nice -n 10 git push --force origin main',
  ])('sees through the wrapper: %s', (command) => deny(command));

  it.each([
    'if true; then git push --force origin main; fi',
    'for b in a; do git push --force origin main; done',
    'while true; do git push -f origin master; done',
    'for i in 1; do rm -rf /; done',
    '! git push --force origin main',
  ])('sees past the shell keyword: %s', (command) => deny(command));

  it.each([
    'GIT_SSH_COMMAND="ssh -i k" git push --force origin main',
    "GIT_AUTHOR_NAME='a b' rm -rf /",
  ])('sees past a QUOTED assignment prefix: %s', (command) => deny(command));

  it.each([
    'git push --force origin mai{n..n}',
    'git push --force origin "mas"{ter..ter}',
    "git push --force origin $'main'",
    "rm -rf $'/'",
    'rm -rf /{usr,etc}',
  ])('resolves the shell forms that hide a literal: %s', (command) => deny(command));

  it.each([
    'eval "git push --force origin main"',
    "eval 'rm -rf /'",
    'bash -c git\\ push\\ -f\\ origin\\ main',
  ])('follows a statically visible payload: %s', (command) => deny(command));

  it.each([
    'rm -rf /etc/*',
    'rm -rf /usr/*',
    'rm -rf /home/*',
    'rm -rf ~/.ssh/*',
    'rm -rf /System',
  ])('treats the children of a catastrophic directory as catastrophic: %s', (command) =>
    deny(command),
  );

  it.each([
    'gh workflow run --repo o/r deploy-prod.yml',
    'gh workflow run --ref main deploy-prod.yml',
    'gh workflow run deploy.yml -F environment=prod',
  ])('reads gh flags in any order: %s', (command) => deny(command));

  it.each([
    'gh workflow run --repo org/prod-release-api ci.yml',
    'gh workflow run --ref release/prod-hotfix ci.yml',
    'gh api repos/o/prod-api/actions/workflows/ci.yml/dispatches -f ref=main',
  ])('and still does not fire on prod in a repo or ref name: %s', (command) => allow(command));

  it('does not read a heredoc body as commands', async () => {
    // The rewrite fixed prose for `-m "…"` and left it open for multi-line
    // bodies, which is how PR descriptions and journal entries are written.
    for (const command of [
      "cat > notes.md <<'EOF'\nrm -rf / is dangerous\nEOF",
      "git commit -F - <<'EOF'\nrm -rf / is now blocked\nEOF",
      "gh pr create --body-file - <<'EOF'\ngit push --force origin main is refused\nEOF",
    ]) {
      await allow(command);
    }
  });
});

// ── E/F. the limits comment is a claim, so it is tested ──────────────────────

describe('E. every limit the file claims is really a limit', () => {
  it('the stated-limits block names each of these, and each genuinely passes', async () => {
    const source = await readFile(hook, 'utf8');
    // Only what is GENUINELY still a limit. Brace expansion, ANSI-C quoting and a
    // literal `eval` payload were on this list and are now handled — a limits
    // block that keeps stale entries understates the guard as surely as an
    // overstated one misleads about it.
    const limits: Array<[string, RegExp]> = [
      ['git push --force origin $BRANCH', /runtime|\$BRANCH/i],
      ['./scripts/deploy-prod.sh', /alias|script|wrapper/i],
      ['eval "$(printf \'git push --force origin main\')"', /eval "\$\(|assembled at runtime/i],
    ];
    for (const [command, mentioned] of limits) {
      // it is documented …
      expect(source, `limits block must mention: ${command}`).toMatch(mentioned);
      // … and it really is not caught, so the documentation is not overstating
      await allow(command);
    }
  });

  it('does not claim to be exhaustive', async () => {
    const source = await readFile(hook, 'utf8');
    expect(source).toMatch(/not exhaustive|incomplete|drift, not an adversary/i);
  });
});

describe('F. invariants.md requires a guard to test its own stated limits', () => {
  it('says so, because a limits comment is a credibility claim', async () => {
    const rule = await readFile(path.join(universal, '.claude', 'rules', 'invariants.md'), 'utf8');
    expect(rule).toMatch(/limit/i);
    expect(rule).toMatch(/test/i);
  });
});
