import { execFile } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as fsp from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { gitEnv } from '../../packages/cli/src/lib/git-env.js';
import { skipUnless, symlinksAvailable } from '../helpers/env.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hooksDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'hooks');

interface HookResult {
  code: number;
  stderr: string;
  stdout: string;
}

/** Feed a synthetic hook payload to a hook script, exactly as Claude Code does. */
function runHookFull(
  script: string,
  payload: object,
  env?: Record<string, string>,
): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(hooksDir, script)],
      { env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, stderr, stdout });
      },
    );
    if (!child.stdin) return reject(new Error('no stdin'));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

const runHook = runHookFull;

const write = (filePath: string, content: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: filePath, content },
});

const edit = (filePath: string, newString: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: filePath, old_string: 'x', new_string: newString },
});

const bash = (command: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
});

describe('guard-core-purity hook (the genuinely blocking gate)', () => {
  const core = 'packages/core/src/note.ts';

  it('blocks I/O imports in core', async () => {
    const result = await runHook(
      'guard-core-purity.mjs',
      write(core, "import { readFile } from 'node:fs/promises';"),
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/core/i);
  });

  it('blocks non-allowlisted package imports in core', async () => {
    const result = await runHook(
      'guard-core-purity.mjs',
      write(core, "import { DynamoDBClient } from '@aws-sdk/client-dynamodb';"),
    );
    expect(result.code).toBe(2);
  });

  it('blocks environment access in core', async () => {
    const result = await runHook(
      'guard-core-purity.mjs',
      write(core, 'const stage = process.env.STAGE;'),
    );
    expect(result.code).toBe(2);
  });

  it('blocks clock and randomness in core', async () => {
    for (const line of ['const t = Date.now();', 'const d = new Date();', 'Math.random();']) {
      const result = await runHook('guard-core-purity.mjs', write(core, line));
      expect(result.code, line).toBe(2);
    }
  });

  it('blocks violations introduced via Edit as well', async () => {
    const result = await runHook('guard-core-purity.mjs', edit(core, "const fs = require('fs');"));
    expect(result.code).toBe(2);
  });

  it('allows pure core code (relative imports, allowlisted schema lib, type-only imports)', async () => {
    const content = [
      "import { z } from 'zod';",
      "import { slugify } from './slug.js';",
      "import type { Logger } from '@app/shared';",
      'export const NoteSchema = z.object({ title: z.string() });',
    ].join('\n');
    const result = await runHook('guard-core-purity.mjs', write(core, content));
    expect(result.code).toBe(0);
  });

  it('does not police files outside core', async () => {
    const result = await runHook(
      'guard-core-purity.mjs',
      write('packages/db/src/client.ts', "import { readFile } from 'node:fs';"),
    );
    expect(result.code).toBe(0);
  });
});

describe('guard-web-boundary hook (web imports core/shared only)', () => {
  const web = 'apps/web/src/app/page.tsx';

  it('blocks db imports from the web app — under any scope', async () => {
    for (const spec of ['@app/db', '@my-cool-app/db']) {
      const result = await runHook(
        'guard-web-boundary.mjs',
        write(web, `import { NoteModel } from '${spec}';`),
      );
      expect(result.code, spec).toBe(2);
      expect(result.stderr).toMatch(/web/i);
    }
  });

  it('blocks service imports from the web app', async () => {
    for (const spec of ['@app/api', '@app/worker']) {
      const result = await runHook(
        'guard-web-boundary.mjs',
        write(web, `import { something } from '${spec}';`),
      );
      expect(result.code, spec).toBe(2);
    }
  });

  it('blocks relative reaches into db and services', async () => {
    for (const spec of ['../../../packages/db/src/index.js', '../../../services/api/src/main.js']) {
      const result = await runHook(
        'guard-web-boundary.mjs',
        edit(web, `import { x } from '${spec}';`),
      );
      expect(result.code, spec).toBe(2);
    }
  });

  it('allows core, shared, react and next imports', async () => {
    const content = [
      "import { NewNoteSchema } from '@app/core';",
      "import type { Logger } from '@app/shared';",
      "import { useState } from 'react';",
      "import Link from 'next/link';",
      "import { validateNewNote } from '../lib/validate.js';",
    ].join('\n');
    expect((await runHook('guard-web-boundary.mjs', write(web, content))).code).toBe(0);
  });

  it('does not police files outside apps/web', async () => {
    const result = await runHook(
      'guard-web-boundary.mjs',
      write('services/api/src/main.ts', "import { NoteModel } from '@app/db';"),
    );
    expect(result.code).toBe(0);
  });
});

describe('block-no-verify hook', () => {
  it('blocks git commit --no-verify', async () => {
    const result = await runHook('block-no-verify.mjs', bash('git commit --no-verify -m "x"'));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/no-verify|pre-commit/i);
  });

  it('blocks git push --no-verify and the -n short form', async () => {
    expect((await runHook('block-no-verify.mjs', bash('git push --no-verify'))).code).toBe(2);
    expect((await runHook('block-no-verify.mjs', bash('git commit -n -m "x"'))).code).toBe(2);
  });

  it('allows normal git usage and unrelated flags', async () => {
    expect((await runHook('block-no-verify.mjs', bash('git commit -m "x"'))).code).toBe(0);
    expect((await runHook('block-no-verify.mjs', bash('echo --no-verify'))).code).toBe(0);
    expect((await runHook('block-no-verify.mjs', bash('git log -n 3'))).code).toBe(0);
  });

  it('does not block a commit whose message merely MENTIONS the flag (quoted text)', async () => {
    // agent-os v2 brief §2b: strip quoted segments before matching — a guard
    // that fires on prose produces false blocks and trains people to fight it.
    for (const command of [
      'git commit -m "docs: explain why --no-verify is forbidden"',
      "git commit -m 'never bypass hooks with --no-verify'",
      'git commit -m "note" -m "the -n shorthand is banned too"',
    ]) {
      expect((await runHook('block-no-verify.mjs', bash(command))).code, command).toBe(0);
    }
  });

  it('still blocks the real flag even when quoted text is also present', async () => {
    const result = await runHook(
      'block-no-verify.mjs',
      bash('git commit --no-verify -m "fix: mention --no-verify in docs"'),
    );
    expect(result.code).toBe(2);
  });

  // Round 5: `git commit -nm "msg"` bypassed the gate outright — the one thing
  // this hook exists to stop, in the spelling people actually type.
  it('blocks -n bundled into a combined short-flag cluster', async () => {
    const bundled = ['-nm "combined"', '-qn -m x', '-amn "x"', '-n -m x'];
    for (const flags of bundled) {
      const command = `git commit ${flags}`;
      expect((await runHook('block-no-verify.mjs', bash(command))).code, command).toBe(2);
    }
  });

  it('still allows clusters that do not contain n', async () => {
    for (const command of [
      'git commit -am "x"',
      'git commit -S -m "x"',
      'git log -n 3',
      'git status',
    ]) {
      expect((await runHook('block-no-verify.mjs', bash(command))).code, command).toBe(0);
    }
  });
});

// extraction brief §3 Tier A: the Never-tier deny-list is the one guard that is
// near-universal. It is a SECOND Bash guard on purpose — block-no-verify owns the
// pre-commit bypass; this one owns the irreversible actions and the kill switch.
describe('guard-bash hook (the Never tier, made mechanical)', () => {
  const KILL = 'AGENT_LOOP_STOP';
  const noKillSwitch = { [KILL]: path.join(tmpdir(), 'definitely-absent-loop-STOP') };

  const run = (command: string, env?: Record<string, string>) =>
    runHookFull('guard-bash.mjs', bash(command), { ...noKillSwitch, ...env });

  it('blocks a force-push that names a protected branch', async () => {
    for (const command of [
      'git push --force origin main',
      'git push -f origin master',
      'git push --force-with-lease origin develop',
      'git push origin +main',
    ]) {
      const result = await run(command);
      expect(result.code, command).toBe(2);
      expect(result.stderr).toMatch(/force/i);
    }
  });

  it('blocks pushing straight to a protected branch, and deleting one', async () => {
    for (const command of [
      'git push origin main',
      'git push origin HEAD:master',
      'git push origin --delete main',
    ]) {
      expect((await run(command)).code, command).toBe(2);
    }
  });

  it('blocks --all and --mirror pushes, which carry protected refs implicitly', async () => {
    for (const command of ['git push --all --force origin', 'git push --mirror origin']) {
      expect((await run(command)).code, command).toBe(2);
    }
  });

  it('blocks a production deploy trigger — workflow dispatch or API', async () => {
    for (const command of [
      'gh workflow run deploy.yml -f stage=prod',
      'gh workflow run deploy --ref main -f environment=production',
      'gh api repos/o/r/actions/workflows/deploy.yml/dispatches -f inputs[stage]=prod',
    ]) {
      const result = await run(command);
      expect(result.code, command).toBe(2);
      expect(result.stderr).toMatch(/prod/i);
    }
  });

  it('blocks catastrophic filesystem wipes', async () => {
    for (const command of [
      'rm -rf /',
      'rm -rf /*',
      'rm -rf ~',
      'rm -rf "$HOME"',
      'rm -fr $HOME/',
    ]) {
      expect((await run(command)).code, command).toBe(2);
    }
  });

  it('allows the ordinary, reversible day-to-day commands', async () => {
    for (const command of [
      'git push origin feat/my-branch',
      'git push --force-with-lease origin feat/my-branch',
      'git push -u origin HEAD',
      'gh pr create --fill',
      'gh workflow run ci.yml',
      'gh workflow run deploy.yml -f stage=dev',
      'rm -rf node_modules',
      'rm -rf ./dist',
      'pnpm test',
    ]) {
      expect((await run(command)).code, command).toBe(0);
    }
  });

  it('does not fire on prose: a message that merely mentions a forbidden action', async () => {
    for (const command of [
      'git commit -m "docs: explain why force-push to main is banned"',
      `git commit -m 'never rm -rf / and never deploy prod by hand'`,
      'gh pr create --title "chore: guard prod deploys"',
    ]) {
      expect((await run(command)).code, command).toBe(0);
    }
  });

  it('is the kill switch: while the stop flag exists, no merge lands', async () => {
    const flag = path.join(await fsp.mkdtemp(path.join(tmpdir(), 'kill-')), 'STOP');
    await fsp.writeFile(flag, '');
    const result = await run('gh pr merge 12 --squash', { [KILL]: flag });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(flag);
    // "stop cleanly" must not mean "lose the work": everything short of the
    // merge stays allowed while the brake is on.
    for (const command of ['git push origin feat/x', 'gh pr create --fill']) {
      expect((await run(command, { [KILL]: flag })).code, command).toBe(0);
    }
  });

  it('a malformed payload or a non-Bash tool is none of its business', async () => {
    expect((await runHookFull('guard-bash.mjs', { tool_name: 'Write' }, noKillSwitch)).code).toBe(
      0,
    );
    expect((await run('')).code).toBe(0);
  });
});

describe('gate-stop-dod hook (the Definition of Done as a mechanical gate)', () => {
  // The hook runs from a project dir: copy it + a checks config into a tmp
  // git repo, exactly as it would live in a generated project.
  const { mkdtemp, mkdir: mkdirP, copyFile, writeFile: writeF, rm: rmP } = fsp;
  let projectDir: string;

  async function setUpProject(options: {
    checks?: unknown;
    dirty?: boolean;
    rawConfig?: string;
  }): Promise<void> {
    // realpath: on Windows tmpdir() is the 8.3 short form (RUNNER~1), and the
    // hook names the tree it measured by the path it was handed
    projectDir = await fsp.realpath(await mkdtemp(path.join(tmpdir(), 'dod-gate-')));
    const hookDir = path.join(projectDir, '.claude', 'hooks');
    await mkdirP(hookDir, { recursive: true });
    await copyFile(
      path.join(hooksDir, 'gate-stop-dod.mjs'),
      path.join(hookDir, 'gate-stop-dod.mjs'),
    );
    // `.claude/scripts/git-env.mjs` sits beside the hook in every generated
    // project — `layers.json` ships both in the `process` layer — and the gate
    // reads its sanitiser from there. A fixture that copies the hook alone is a
    // fixture of a project that does not exist.
    const scriptDir = path.join(projectDir, '.claude', 'scripts');
    await mkdirP(scriptDir, { recursive: true });
    await copyFile(
      path.join(hooksDir, '..', 'scripts', 'git-env.mjs'),
      path.join(scriptDir, 'git-env.mjs'),
    );
    if (options.rawConfig !== undefined) {
      await writeF(path.join(hookDir, 'dod-checks.json'), options.rawConfig);
    } else if (options.checks !== undefined) {
      await writeF(path.join(hookDir, 'dod-checks.json'), JSON.stringify(options.checks));
    }
    // Same sanitised environment the CLI uses, and for the same reason: run
    // under an inherited GIT_DIR (which is what a pre-commit hook gets from a
    // linked worktree) these commands would `git init` and commit into the
    // REPOSITORY RUNNING THE SUITE instead of this scratch project. It wrote a
    // junk commit onto a real branch here before it was caught.
    const git = (...args: string[]) =>
      new Promise<void>((resolve, reject) => {
        execFile('git', args, { cwd: projectDir, env: gitEnv() }, (error) =>
          error ? reject(error) : resolve(),
        );
      });
    await git('init', '--quiet');
    await writeF(path.join(projectDir, 'work.txt'), 'x');
    if (!options.dirty) {
      await git('add', '-A');
      await git(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '--quiet',
        '--no-verify',
        '-m',
        'clean',
      );
    }
  }

  function runStopHook(
    payload: object,
    extraEnv: NodeJS.ProcessEnv = {},
    cwd: string = projectDir,
  ): Promise<HookResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [path.join(projectDir, '.claude', 'hooks', 'gate-stop-dod.mjs')],
        { cwd, env: { ...gitEnv(), ...extraEnv } },
        (error, stdout, stderr) => {
          const code = error ? ((error as { code?: number }).code ?? 1) : 0;
          resolve({ code, stderr, stdout });
        },
      );
      if (!child.stdin) return reject(new Error('no stdin'));
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  }

  const stop = (active = false) => ({ hook_event_name: 'Stop', stop_hook_active: active });

  afterEach(async () => {
    if (projectDir) await rmP(projectDir, { recursive: true, force: true });
  });

  // AR-119: observed twice in one session reviewing another branch in a
  // worktree under .claude/worktrees/ — the gate ran the checks in the worktree
  // the session had last cd-ed into and reported that branch's failing test as
  // this session's own Definition-of-Done failure. The project is where the
  // hook lives, not where the shell happens to be.
  describe('measures the project the hook belongs to, not the directory the session cd-ed into', () => {
    const elsewhereRepo = async (dirty: boolean): Promise<string> => {
      const elsewhere = await mkdtemp(path.join(tmpdir(), 'dod-elsewhere-'));
      const git = (...args: string[]) =>
        new Promise<void>((resolve, reject) => {
          execFile('git', args, { cwd: elsewhere, env: gitEnv() }, (error) =>
            error ? reject(error) : resolve(),
          );
        });
      await git('init', '--quiet');
      if (dirty) await fsp.writeFile(path.join(elsewhere, 'dirty.txt'), 'uncommitted\n');
      return elsewhere;
    };

    it('runs the checks in the project root, so a check reading the tree sees the session project', async () => {
      // The check passes only in the project: marker.txt exists there and nowhere else.
      await setUpProject({
        checks: ["node -e \"process.exit(require('fs').existsSync('marker.txt') ? 0 : 1)\""],
        dirty: true,
      });
      await writeF(path.join(projectDir, 'marker.txt'), 'here');
      const elsewhere = await elsewhereRepo(true);
      try {
        const result = await runStopHook(stop(), {}, elsewhere);
        expect(result.code, result.stderr).toBe(0);
      } finally {
        await rmP(elsewhere, { recursive: true, force: true });
      }
    });

    it('asks "is the tree clean?" about the project, not about the cwd', async () => {
      // The project is clean and the check would fail: the gate must stop
      // instantly, however dirty the directory the session sits in.
      await setUpProject({ checks: ['node -e "process.exit(1)"'], dirty: false });
      const elsewhere = await elsewhereRepo(true);
      try {
        const result = await runStopHook(stop(), {}, elsewhere);
        expect(result.code, result.stderr).toBe(0);
      } finally {
        await rmP(elsewhere, { recursive: true, force: true });
      }
    });

    it('names the tree it measured in the refusal, so a foreign failure is visible at a glance', async () => {
      await setUpProject({ checks: ['node -e "process.exit(1)"'], dirty: true });
      const result = await runStopHook(stop());
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`measured in ${await fsp.realpath(projectDir)}`);
    });
  });

  it('refuses the stop while a named DoD check fails', async () => {
    await setUpProject({
      checks: ['node -e "process.exit(0)"', 'node -e "process.exit(1)"'],
      dirty: true,
    });
    const result = await runStopHook(stop());
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('process.exit(1)');
    expect(result.stderr).toMatch(/diagnosis/i); // pairs with the N-strike rule
  });

  it('lets a passing suite stop', async () => {
    await setUpProject({ checks: ['node -e "process.exit(0)"'], dirty: true });
    expect((await runStopHook(stop())).code).toBe(0);
  });

  it('never blocks twice in a row (stop_hook_active) — the anti-loop rule', async () => {
    await setUpProject({ checks: ['node -e "process.exit(1)"'], dirty: true });
    expect((await runStopHook(stop(true))).code).toBe(0);
  });

  it('a clean tree stops instantly — nothing changed, nothing to gate', async () => {
    await setUpProject({ checks: ['node -e "process.exit(1)"'], dirty: false });
    expect((await runStopHook(stop())).code).toBe(0);
  });

  // The gate decides "is this tree clean?" by asking git. Asked with an
  // inherited GIT_DIR — which is what any process started under a git hook
  // gets — it answers about a DIFFERENT repository, and the session is gated on
  // somebody else's uncommitted work (or waved through despite its own).
  it('judges the tree it is in, not whatever GIT_DIR points at', async () => {
    await setUpProject({ checks: ['node -e "process.exit(1)"'], dirty: false });
    const elsewhere = path.join(tmpdir(), `dod-elsewhere-${process.pid}`);
    await fsp.mkdir(elsewhere, { recursive: true });
    const git = (...args: string[]) =>
      new Promise<void>((resolve, reject) => {
        execFile('git', args, { cwd: elsewhere, env: gitEnv() }, (error) =>
          error ? reject(error) : resolve(),
        );
      });
    try {
      await git('init', '--quiet');
      await fsp.writeFile(path.join(elsewhere, 'dirty.txt'), 'uncommitted\n');
      // this project is clean, so the gate must stop instantly — the failing
      // check must never run, however dirty the repository GIT_DIR names
      const result = await runStopHook(stop(), { GIT_DIR: path.join(elsewhere, '.git') });
      expect(result.code).toBe(0);
    } finally {
      await fsp.rm(elsewhere, { recursive: true, force: true });
    }
  });

  // The same question, asked with the variable that made the gate stop keeping
  // its own list. `GIT_OBJECT_DIRECTORY` is on the canonical list and was NOT
  // among the four this hook once stripped by hand — and it is not a
  // theoretical member: pointed anywhere other than this repository's own
  // objects, `git status` exits 128 (measured on git 2.47.1 — `fatal: bad
  // object HEAD`). The gate catches that as "not a git repo" and runs the whole
  // check suite on a tree it never managed to read, so a clean session ends up
  // gated on a check that had no business running. This passes because the hook
  // imports the shared list now; it is the regression pin for that.
  it('judges the tree it is in under every variable that can relocate a repository', async () => {
    await setUpProject({ checks: ['node -e "process.exit(1)"'], dirty: false });
    const objects = await fsp.mkdtemp(path.join(tmpdir(), 'dod-objects-'));
    try {
      const result = await runStopHook(stop(), { GIT_OBJECT_DIRECTORY: objects });
      expect(result.code, result.stderr).toBe(0);
    } finally {
      await fsp.rm(objects, { recursive: true, force: true });
    }
  });

  it('fails open: no config, or a corrupt one, must not make the session unquittable', async () => {
    await setUpProject({ dirty: true });
    expect((await runStopHook(stop())).code).toBe(0);
    await setUpProject({ rawConfig: '{not json', dirty: true });
    expect((await runStopHook(stop())).code).toBe(0);
  });

  // A gate that runs out of time is the one case where failing open costs the
  // most: the session ends reporting a Definition of Done that was never
  // measured. So the hook owns a budget of its own and spends it before the
  // wiring's `timeout` runs out — and when the budget goes, the answer is "not
  // verified", which is a block.
  //
  // The premise underneath (a hook past its timeout is killed, and a killed
  // Stop hook does not block) is the harness assumption the hook header labels
  // as unprovable from this repository. It is why the budget exists; it is not
  // something this file demonstrates, and it is not stated here as though it
  // were.
  it('gates the stop when a check outruns the budget — unmeasured is not a pass', async () => {
    await setUpProject({ checks: ['sleep 5'], dirty: true });
    const result = await runStopHook(stop(), { RIG_DOD_BUDGET_MS: '1000' });
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('sleep 5');
    expect(result.stderr).toMatch(/budget/i);
  }, 30_000);

  // The budget is for the whole suite, not a fresh allowance per check: three
  // checks each granted the full budget is three times the wall clock the
  // harness allows, which is the same overrun by a longer route. Two two-second
  // sleeps under a three-second budget: the first leaves ~1s for the second.
  it('spends one budget across the whole suite, not a fresh one per check', async () => {
    await setUpProject({ checks: ['sleep 2', 'sleep 2'], dirty: true });
    const result = await runStopHook(stop(), { RIG_DOD_BUDGET_MS: '3000' });
    expect(result.code, result.stderr).toBe(2);
  }, 30_000);

  // The regression pin for the ENOBUFS false gate: `execSync` buffers 1 MB by
  // default and THROWS past it, and the catch below it reported that throw as
  // "a Definition of Done check fails". A chatty `pnpm test` that exits 0 was
  // gating sessions on nothing. Output volume is not a verdict.
  it('does not read a chatty passing check as a failure (the ENOBUFS false gate)', async () => {
    await setUpProject({
      checks: [`node -e "process.stdout.write('x'.repeat(2*1024*1024))"`],
      dirty: true,
    });
    const result = await runStopHook(stop());
    expect(result.code, result.stderr).toBe(0);
  }, 30_000);

  // Failing open is right — a crashed gate must not make the session
  // unquittable — but a silent exit 0 is indistinguishable from a clean pass,
  // so the one thing worth knowing (the gate did not actually run) is exactly
  // the thing nobody learns. It stays open, and it says so.
  it('announces a fail-open instead of returning a silent clean pass', async () => {
    await setUpProject({ rawConfig: '{not json', dirty: true });
    const result = await runStopHook(stop());
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('[hook fail-open]');
  });

  // The governing rule, stated once and pinned five ways below: a check that
  // did not produce a verdict BLOCKS, and a gate that could not START stays
  // open. `spawnSync` reports "the child was killed before it finished" as an
  // `error` with `status: null`, and a timeout is only ONE of the ways that
  // happens — a check that outruns the read buffer lands in exactly the same
  // shape. Reading anything but ETIMEDOUT as the hook's own problem hands the
  // session a pass nobody measured.
  it('gates the stop when a check drowns its own buffer — a pass nobody watched is not a pass', async () => {
    // Exits 0, so it WOULD have passed — and 70 MB past a 64 MB buffer means
    // the hook never sees that exit code: `error.code === 'ENOBUFS'`,
    // `status: null`, `signal: SIGTERM`. The verdict is unknown, not clean.
    await setUpProject({
      checks: [`node -e "process.stdout.write('x'.repeat(70*1024*1024))"`],
      dirty: true,
    });
    const result = await runStopHook(stop());
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('70*1024*1024');
    expect(result.stderr).toMatch(/unmeasured|could not be measured/i);
    // …and it is a gate, not a shrug: a fail-open announcement here would mean
    // the session ended on a Definition of Done that was never read.
    expect(result.stderr).not.toContain('[hook fail-open]');
  }, 60_000);

  // The budget override is read from the environment, so it is outside input:
  // `spawnSync` refuses a non-integer `timeout` by THROWING, the backstop
  // catches it, and one stray decimal point turns the whole Definition of Done
  // into an announced exit 0. An override the hook cannot use must cost the
  // override, never the gate.
  it('runs the gate on the default budget when the override is unusable, instead of not running it', async () => {
    await setUpProject({ checks: ['node -e "process.exit(1)"'], dirty: true });
    const result = await runStopHook(stop(), { RIG_DOD_BUDGET_MS: '1000.5' });
    expect(result.code, result.stderr).toBe(2);
    // the failing check is still what the session is told about …
    expect(result.stderr).toContain('process.exit(1)');
    // … and the unusable override is reported rather than silently obeyed
    expect(result.stderr).toContain('RIG_DOD_BUDGET_MS');
    expect(result.stderr).toMatch(/default/i);
  }, 30_000);

  /** The default total budget, read from the hook rather than restated: the
   *  clamp below is announced in milliseconds, and a test that hardcodes the
   *  number drifts the moment the hook's own constant moves. */
  async function defaultBudgetMs(): Promise<number> {
    const source = await readFile(path.join(hooksDir, 'gate-stop-dod.mjs'), 'utf8');
    const declared = /DEFAULT_BUDGET_MS\s*=\s*([\d_]+)/.exec(source);
    expect(declared, 'the hook must declare a default budget in ms').not.toBeNull();
    return Number(declared![1]!.replaceAll('_', ''));
  }

  // The override may only LOWER the budget. Raised above the Stop entry's
  // `timeout` in settings.json it re-creates the exact defect this gate exists
  // to remove — the harness kills the hook before the hook can report, and (on
  // the harness assumption the hook header labels as unprovable from this
  // repository) a killed Stop hook does not block the stop — except now the
  // session believes it configured a longer gate rather than none at all.
  it('clamps a budget override that would outlive the harness, and names the budget it used', async () => {
    await setUpProject({ checks: ['node -e "process.exit(0)"'], dirty: true });
    const result = await runStopHook(stop(), { RIG_DOD_BUDGET_MS: '999999999' });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain('RIG_DOD_BUDGET_MS');
    expect(result.stderr).toMatch(/clamp|cap|lower|reduc/i);
    expect(result.stderr).toContain(String(await defaultBudgetMs()));
  }, 30_000);

  // Failing open is right here — a config the gate cannot use is the gate's
  // problem, not the session's — but it has to be a DECISION, taken while the
  // file is still in hand and can be named. Today a non-string entry travels
  // all the way to `spawnSync`, throws, and lands in the backstop: the same
  // exit code by accident, announced as an internal error about an argument
  // type, with nothing to tell the reader which file to go and fix.
  //
  // 🔴 And the decision is a BLOCK, not a pass. An entry the gate could not run
  // produced no verdict, and unmeasured is not a pass — the same rule the
  // budget half of this file is built on. `checks: []` is the case that means
  // "nothing was declared"; a config whose every entry is unusable means
  // "everything declared went unmeasured", and collapsing the two is how the
  // gate hands back a green session it never measured. This assertion used to
  // read `toBe(0)` for exactly this fixture; that was the bypass, mirrored.
  it('refuses the stop for a config it could read but cannot use, and names the file to fix', async () => {
    await setUpProject({ rawConfig: '[{"cmd":"exit 1"}]', dirty: true });
    const result = await runStopHook(stop());
    expect(result.code, result.stderr).toBe(2);
    // NOT `[hook fail-open]`: that marker means the gate stayed open, and this
    // path blocks. Pinning it here is what made the marker mean both things —
    // a round-3 blocker, so the assertion moved rather than the behaviour.
    expect(result.stderr).toContain('gate-stop-dod:');
    expect(result.stderr).toContain('dod-checks.json');
    // decided by the gate, not discovered by the child-process layer
    expect(result.stderr).not.toContain('must be of type string');
  });

  // The `typeof command === 'string'` predicate above lets through two string
  // values that `spawnSync` refuses to spawn at all — it THROWS before the
  // child exists — and that throw lands in the top-level backstop, which is a
  // fail-open: exit 0, for the WHOLE suite. So one unusable entry buys a clean
  // session while a genuinely failing Definition of Done check sits untouched
  // behind it in the same array. That is the total bypass this gate exists to
  // close, reached through the config file rather than through the clock.
  //
  // Both fixtures put the unusable entry FIRST and a check that really fails
  // second: the entry the gate cannot use must not become the entry that
  // decides the session.
  //
  // ⚠ Spelled out one `it` per case rather than generated from a table: a name
  // assembled from a template literal is a name no `grep -F` finds, so the
  // hook's `see hooks.test.ts › "…"` pointer at it resolves to nothing. The
  // shared part is the assertion helper; the names are literal.

  /** Assembled, never written out: a literal NUL in the source is not something
   *  a reader of this file can see. */
  const NUL_BEARING_ENTRY = `${String.fromCharCode(0)}oops`;

  async function expectAFailingCheckSurvivesAnUnusableNeighbour(
    entry: unknown,
    nodeWording: RegExp,
  ): Promise<void> {
    await setUpProject({ checks: [entry, 'node -e "process.exit(1)"'], dirty: true });
    const result = await runStopHook(stop());
    // whatever the gate decides about the unusable entry, it may not be
    // "this session ended on a green Definition of Done"
    expect(result.code, result.stderr).not.toBe(0);
    // and the decision is the gate's own, taken while the file is still in
    // hand: it names the file to fix …
    // NOT `[hook fail-open]`: that marker means the gate stayed open, and this
    // path blocks. Pinning it here is what made the marker mean both things —
    // a round-3 blocker, so the assertion moved rather than the behaviour.
    expect(result.stderr).toContain('gate-stop-dod:');
    expect(result.stderr).toContain('dod-checks.json');
    // … rather than surfacing an argument-type error from the child-process
    // layer, which is what a throw caught by the backstop reads like
    expect(result.stderr).not.toMatch(nodeWording);
  }

  it('never lets an unusable config entry hide a failing check behind it (an empty string)', async () => {
    await expectAFailingCheckSurvivesAnUnusableNeighbour('', /cannot be empty/i);
  }, 30_000);

  it('never lets an unusable config entry hide a failing check behind it (a string carrying a NUL byte)', async () => {
    await expectAFailingCheckSurvivesAnUnusableNeighbour(NUL_BEARING_ENTRY, /without null bytes/i);
  }, 30_000);

  // The mirror of that bypass, and the reason the round-2 fix was only half of
  // one. Judging per entry stopped a bad entry from swallowing a FAILING
  // neighbour — but a bad entry beside a PASSING neighbour still ended the
  // session green, because `usable.length === 0` was never the question. The
  // entry was declared, it was never run, and a Definition of Done nobody
  // measured is not one that passed.
  //
  // The unusable entry sits FIRST in every fixture, so the index the message
  // has to name is 0 and "which entry do I go and fix" has one answer.
  async function gateOnAnUnusableEntryBesideAPassingCheck(entry: unknown): Promise<HookResult> {
    await setUpProject({ checks: [entry, 'node -e "process.exit(0)"'], dirty: true });
    return runStopHook(stop());
  }

  function expectTheSkippedEntryGatesTheStop(result: HookResult, index: number): void {
    // an entry that was skipped is an entry that produced no verdict …
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('STOP GATED');
    // … and the message points at the file AND at which entry in it, because
    // "one of your entries is not runnable" is not something a reader can act on
    expect(result.stderr).toContain('dod-checks.json');
    expect(result.stderr, 'the message must name the index of the skipped entry').toMatch(
      new RegExp(`index(?:es|ices)?\\b[^\\n]*\\b${index}\\b`, 'i'),
    );
    expect(result.stderr).toMatch(/unmeasured|no verdict/i);
  }

  it('refuses the stop for an empty config entry it skipped, even though every check it could run passed', async () => {
    expectTheSkippedEntryGatesTheStop(await gateOnAnUnusableEntryBesideAPassingCheck(''), 0);
  }, 30_000);

  it('refuses the stop for a skipped entry carrying a NUL byte, even though every check it could run passed', async () => {
    expectTheSkippedEntryGatesTheStop(
      await gateOnAnUnusableEntryBesideAPassingCheck(NUL_BEARING_ENTRY),
      0,
    );
  }, 30_000);

  it('refuses the stop for a skipped entry that is not a string at all, even though every check it could run passed', async () => {
    expectTheSkippedEntryGatesTheStop(
      await gateOnAnUnusableEntryBesideAPassingCheck({ cmd: 'exit 0' }),
      0,
    );
  }, 30_000);

  // The round-2 property, pinned against the shape the table above does not
  // carry: a failing check is still what the session is told about first, and
  // the skipped entry does not get to replace that verdict with its own.
  it('still reports the failing check when a non-string entry sits beside it', async () => {
    await setUpProject({ checks: [{ cmd: 'exit 0' }, 'node -e "process.exit(1)"'], dirty: true });
    const result = await runStopHook(stop());
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('process.exit(1)');
    expect(result.stderr).toMatch(/diagnosis/i);
  }, 30_000);

  // The boundary on the other side of the same rule: an EMPTY array is
  // "nothing was declared", which is the universal layer's ordinary state, not
  // "everything declared went unmeasured". Nothing was skipped, so there is
  // nothing to announce and nothing to gate.
  it('stays silent when the config declares no checks at all — an empty array is nothing to gate', async () => {
    await setUpProject({ checks: [], dirty: true });
    const result = await runStopHook(stop());
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('STOP GATED');
    expect(result.stderr).not.toContain('[hook fail-open]');
  });

  // The other side of that boundary, and the reason it is a boundary: universal
  // ships no checks at all, so an ABSENT config is the ordinary state of a
  // freshly generated project. Announcing a fail-open there trains every reader
  // to ignore the announcement, which is the one thing it cannot afford.
  it('stays silent when there is no config at all — nothing to gate is the design, not a swallowed error', async () => {
    await setUpProject({ dirty: true });
    const result = await runStopHook(stop());
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('[hook fail-open]');
  });

  // The gate's whole thesis is "report before you are killed", and everything
  // it spends before its deadline is set is spent outside that budget: node
  // starting, the payload read, `git status --porcelain`, the config read. All
  // of those are bounded by something except the `git status`, which on a large
  // or index-locked repository can outlast the harness timeout on its own — at
  // which point the gate is killed having measured nothing, and (on the harness
  // assumption the hook header labels as unprovable here) the session ends.
  //
  // So the preamble allowance is the hook's own constant, and the one unbounded
  // call in the preamble is bounded BY it. Asserted from the source rather than
  // driven behaviourally: making `git status` hang for real needs an index lock
  // held by another process, which is a sleep in a test by another name.
  it('bounds its own preamble: the git status call carries a timeout derived from the declared margin', async () => {
    const source = await readFile(path.join(hooksDir, 'gate-stop-dod.mjs'), 'utf8');
    const call = /execSync\(\s*'git status --porcelain'\s*,\s*\{([\s\S]*?)\n\s*\}\)/.exec(source);
    expect(call, "the gate's tree check must stay one findable execSync call").not.toBeNull();
    const options = call![1]!;
    expect(options, 'the one unbudgeted call in a gate built on a budget').toMatch(/timeout:/);
    expect(
      options,
      'and the bound is the declared preamble allowance, not a second guess beside it',
    ).toMatch(/timeout:\s*PREAMBLE_MARGIN_MS/);
  });
});

describe('inject-rules hook (rules survive compaction and resumes)', () => {
  it('injects the autonomy rules into context on SessionStart', async () => {
    for (const source of ['startup', 'resume', 'compact']) {
      const result = await runHookFull('inject-rules.mjs', {
        hook_event_name: 'SessionStart',
        source,
      });
      expect(result.code, source).toBe(0);
      expect(result.stdout, source).toContain('Tier 0');
      expect(result.stdout, source).toContain('Stop rules');
    }
  });

  it('injected content is stateless — no timestamps, no commit SHAs', async () => {
    const result = await runHookFull('inject-rules.mjs', {
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    expect(result.stdout).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(result.stdout).not.toMatch(/\b[0-9a-f]{40}\b/);
  });

  it('stays silent on unrelated events', async () => {
    const result = await runHookFull('inject-rules.mjs', { hook_event_name: 'Notification' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  // The whole point of the hook is the governance an unattended run is bound
  // by. Injecting less of it is a silent downgrade — the run still gets
  // *something*, so nothing looks broken — so every tier and every stop rule is
  // pinned by name, on every source that can drop the context.
  const autonomyPath = path.join(
    repoRoot,
    'templates',
    'agent-os',
    'universal',
    '.claude',
    'rules',
    'autonomy.md',
  );
  const sessionStartSources = ['startup', 'resume', 'compact'];

  it('injects every tier and every stop rule, on startup, resume and compaction', async () => {
    for (const source of sessionStartSources) {
      const result = await runHookFull('inject-rules.mjs', {
        hook_event_name: 'SessionStart',
        source,
      });
      expect(result.code, source).toBe(0);
      for (const heading of [
        '## Tiers',
        'Tier 0',
        'Tier 1',
        'Tier 2',
        '### Never',
        '## Stop rules',
        'Three strikes',
        'Budget',
        'Flaky',
        'Invariant conflict',
        'Surprise scope',
        'Session staleness',
      ]) {
        expect(result.stdout, `${source}: ${heading}`).toContain(heading);
      }
    }
  });

  // The tie-break lives in the file's PREAMBLE, above the first `## ` heading,
  // and it is the rule that decides which tier applies at all — a run that has
  // the three tiers but not this sentence will resolve every ambiguous case
  // downwards. The excerpt is worthless without it.
  it('injects the preamble tie-break that decides an ambiguous tier', async () => {
    for (const source of sessionStartSources) {
      const result = await runHookFull('inject-rules.mjs', {
        hook_event_name: 'SessionStart',
        source,
      });
      // Matched against whitespace-collapsed text: the sentence is wrapped
      // across two lines in the source, and where the wrap falls is not a
      // behaviour worth pinning.
      const injected = result.stdout.replace(/\s+/g, ' ');
      expect(injected, source).toContain('the highest tier wins');
      expect(injected, source).toContain('one tier higher than you think');
    }
  });

  // "The tier is decided by what the change touches" is unusable without the
  // pointer to WHERE those paths are declared — the two are one rule, and a
  // session that gets the first half looks up nothing.
  it('injects the pointer to where the elevated paths are declared', async () => {
    const result = await runHookFull('inject-rules.mjs', {
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    expect(result.stdout).toContain('Where the elevated paths of this project are written down');
    expect(result.stdout).toContain('elevated-paths');
  });

  // autonomy.md is already loaded as project instructions, so re-injecting it
  // whole spends the context budget twice for nothing. What stays out is now a
  // decision made in the rules file itself: each of these strings lives inside
  // a region autonomy.md wraps in `<!-- inject:skip -->` markers. Nothing here
  // infers the omission from a heading — that inference is what was deleted.
  it('leaves out the regions the rules file marks as already loaded', async () => {
    for (const source of sessionStartSources) {
      const result = await runHookFull('inject-rules.mjs', {
        hook_event_name: 'SessionStart',
        source,
      });
      for (const elsewhere of [
        'detect-missed-gate.mjs',
        'reconcile-external-prs.mjs',
        'Post-deploy verification',
        'Escalation format',
      ]) {
        expect(result.stdout, `${source}: ${elsewhere}`).not.toContain(elsewhere);
      }
    }
  });

  // The markers are instructions to the excerpter, not content. Leaking them
  // into the context tells the session an HTML comment is part of its rules.
  it('never leaks the skip markers themselves into the context', async () => {
    const result = await runHookFull('inject-rules.mjs', {
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    expect(result.stdout).not.toContain('inject:skip');
  });

  // REDESIGN (this replaces `stdout.length <= rules.length / 2`, which is not a
  // weakening: the old bound passed with ~1.6% of headroom, so any unrelated
  // paragraph added to autonomy.md would have turned it red and the obvious
  // "fix" would have been to loosen the constant. The behaviour actually worth
  // pinning is that a whole named section is omitted, and that is asserted
  // directly here rather than inferred from a byte count.
  it('omits the marked regions rather than echoing the file back', async () => {
    const rules = await readFile(autonomyPath, 'utf8');
    // the sections must exist in the file, or "absent from stdout" proves nothing
    expect(rules).toContain('## Post-deploy verification');
    expect(rules).toContain('## Escalation format');
    const result = await runHookFull('inject-rules.mjs', {
      hook_event_name: 'SessionStart',
      source: 'compact',
    });
    expect(result.stdout).not.toContain('## Post-deploy verification');
    expect(result.stdout).not.toContain('## Escalation format');
    expect(result.stdout.length).toBeLessThan(rules.length);
  });

  // An excerpt that does not say it is an excerpt reads as the whole rule. A
  // session that needs a section this hook dropped has to know it exists and
  // where to read it.
  it('names the file the omitted sections live in', async () => {
    const result = await runHookFull('inject-rules.mjs', {
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    expect(result.stdout).toContain('.claude/rules/autonomy.md');
  });

  /** Everything the hook prints ahead of the excerpt — the excerpt begins at the
   *  rules file's own first line, so the split is derived from the file rather
   *  than from a count of banner lines that any edit would invalidate. */
  function bannerOf(stdout: string, rules: string): string {
    const firstLine = rules.split('\n')[0] ?? '';
    const start = stdout.indexOf(firstLine);
    expect(
      start,
      'the excerpt must appear in stdout for the banner to be split off',
    ).toBeGreaterThan(0);
    return stdout.slice(0, start);
  }

  /** A heading reduced to the words that identify it: the text before the
   *  em-dash or comma subtitle, without a leading article, lowercased. Loose on
   *  purpose — the banner is prose and should not have to quote a heading
   *  verbatim, and the deeper headings that now reach it carry longer trailing
   *  clauses than the `## ` ones did. */
  const topicOf = (heading: string) =>
    (heading.replace(/^#+\s+/, '').split(/\s+[—–-]\s+/)[0] ?? '')
      .split(',')[0]!
      .trim()
      .replace(/^(the|a|an)\s+/i, '')
      .toLowerCase();

  // The banner tells the session which topics it did NOT get, and that list is
  // written by hand while the omissions are authored in autonomy.md's markers.
  // Nothing today notices when the two disagree: mark one more section and the
  // banner keeps naming the old four, so a run is told it has rules it does not
  // have. Derived from the file so that adding a marked region turns this red.
  //
  // Every heading level from `## ` down, not just `## `: the first marked region
  // is headed `#### `, so a scan limited to two hashes left half the banner's
  // list unpinned — the sweep section could be re-titled or dropped while the
  // banner went on citing it, and nothing here would have noticed.
  //
  // REPAIR (of this same branch's test, not of an established one): `omitted`
  // is derived from the BODY, never from the whole of stdout. Asking stdout
  // whether a heading survived asks the banner too, so the day the banner
  // quotes a heading verbatim with its hashes — the most natural way to make
  // this test green, and the spelling the hook's own comments already use for
  // `## Post-deploy verification` — that heading silently leaves `omitted` and
  // its assertion disappears with nothing turning red. The non-vacuity guard
  // below does not catch that: it only requires the set to be non-empty, so
  // blinding it one heading at a time passes.
  it('names, in the banner, every section it left out', async () => {
    const rules = await readFile(autonomyPath, 'utf8');
    const headings = rules.split('\n').filter((line) => /^#{2,}\s+\S/.test(line));
    expect(headings.length, 'autonomy.md must have sub-sections to reason about').toBeGreaterThan(
      0,
    );

    const result = await runHookFull('inject-rules.mjs', {
      hook_event_name: 'SessionStart',
      source: 'compact',
    });
    expect(result.code).toBe(0);

    const bannerText = bannerOf(result.stdout, rules);
    const body = result.stdout.slice(bannerText.length);
    const omitted = headings.filter((heading) => !body.includes(heading));
    // Without this the whole test passes vacuously the day the excerpter stops
    // omitting anything at all — which is exactly the regression that would
    // make the banner's claim false in the other direction.
    expect(omitted, 'at least one section must be omitted, or this proves nothing').not.toEqual([]);

    const banner = bannerText.replace(/\s+/g, ' ').toLowerCase();
    for (const heading of omitted) {
      expect(banner, `banner must name the omitted section: ${heading}`).toContain(
        topicOf(heading),
      );
    }
  });

  // "Regression → revert first, diagnose second" is a rule a run must carry
  // unprompted: the moment it applies is the moment the run is mid-incident and
  // least likely to go and read a file. It now lives inside a marked region, so
  // a compacted session is governed without it. The fix is a one-line pointer at
  // the end of `## Stop rules`, outside the markers, carrying the verdict itself.
  it('injects the revert-first verdict, which lives in an omitted section', async () => {
    for (const source of sessionStartSources) {
      const result = await runHookFull('inject-rules.mjs', {
        hook_event_name: 'SessionStart',
        source,
      });
      expect(result.code, source).toBe(0);
      // Matched against whitespace-collapsed text with emphasis stripped: the
      // rule wraps across lines in the source and carries markdown bold, and
      // neither the wrap point nor the styling is a behaviour worth pinning.
      const injected = result.stdout.replace(/[*`]/g, '').replace(/\s+/g, ' ').toLowerCase();
      expect(injected, source).toContain('revert first');
      expect(injected, source).toContain('diagnose second');
    }
  });

  // The verdict has two halves and the mechanism only unblocks on the second:
  // `queue/core.mjs` ends the run while the recorded verdict is `REGRESSION`,
  // and only writing `HEALTHY` clears it. So a run that reverted, redeployed and
  // verified healthy must be told to record that — an injected rule stopping at
  // "healthy → done" leaves the run refusing every later selection with no way
  // out but hand-editing a state file. The injected half is the one that has to
  // be complete because it is the ONLY half a compacted run holds: the
  // `## Post-deploy verification` section that carries `# or HEALTHY` sits
  // inside the skip markers and never reaches the context.
  it('injects the healthy half of the verdict, which is what clears the run', async () => {
    for (const source of sessionStartSources) {
      const result = await runHookFull('inject-rules.mjs', {
        hook_event_name: 'SessionStart',
        source,
      });
      expect(result.code, source).toBe(0);
      // Whitespace-collapsed: the rule wraps across lines in the source, and
      // where the wrap falls is not a behaviour worth pinning. Asserted on the
      // verdict word and the command that records it, so any wording carrying
      // both stays green.
      const injected = result.stdout.replace(/\s+/g, ' ');
      expect(injected, source).toContain('run-state.mjs');
      expect(injected, source).toContain('HEALTHY');
    }
  });

  // …and carrying the verdict must not mean dragging the section back in. The
  // pointer is the verdict plus a citation; the procedure — its heading, its
  // reasoning, the escalation section beside it — stays in the file.
  //
  // Deliberately NOT asserted here: that `run-state.mjs` is absent. The command
  // names the mechanism the verdict is recorded by, so it can legitimately
  // appear in a one-line pointer as well as in the section, which makes it
  // unable to tell "the section came back" from "the pointer names the
  // mechanism". The strings below can only come from the section itself.
  it('carries the verdict without re-injecting the procedure it came from', async () => {
    const result = await runHookFull('inject-rules.mjs', {
      hook_event_name: 'SessionStart',
      source: 'compact',
    });
    expect(result.stdout).not.toContain('Post-deploy verification');
    expect(result.stdout).not.toContain('CI-green ≠ runtime-healthy');
    expect(result.stdout).not.toContain('there is no run for the verdict to belong to');
    expect(result.stdout).not.toContain('Escalation format');
  });

  /** The marked regions of a rules file, and everything outside them — the same
   *  split the excerpter makes, done here independently so a test can say
   *  something about the two halves without asking the code under test which is
   *  which. Marker lines belong to neither half. */
  function splitOnMarkers(rules: string): { carried: string; omitted: string } {
    const carried: string[] = [];
    const omitted: string[] = [];
    let skipping = false;
    for (const line of rules.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('<!-- inject:skip -->')) {
        skipping = true;
        continue;
      }
      if (trimmed.startsWith('<!-- /inject:skip -->')) {
        skipping = false;
        continue;
      }
      (skipping ? omitted : carried).push(line);
    }
    return { carried: carried.join('\n'), omitted: omitted.join('\n') };
  }

  // The same `run-state.mjs` invocation is written twice — once in the stop rule
  // a run carries, once in the section it reads after a deploy — and a
  // duplicated command drifts silently: whichever copy nobody is looking at is
  // the one that goes wrong (`invariants.md`, "one mechanism, one
  // implementation"). Until one of them cites the other, this is what notices.
  //
  // Matched up to `deploy` and no further: the two halves legitimately name
  // different verdict words (the stop rule leads with the one that clears a
  // run, the procedure with the one that latches it), while the script path
  // ahead of it is the part that must not diverge — rename or move it in one
  // place and half the rulebook starts citing a command that does not exist.
  it('names the same run-state invocation in both halves of the file', async () => {
    const rules = await readFile(autonomyPath, 'utf8');
    const { carried, omitted } = splitOnMarkers(rules);
    const invocation = /node [^\s`]*run-state\.mjs deploy/.exec(carried)?.[0];
    expect(
      invocation,
      'the carried stop rule must name the command that records a verdict',
    ).toBeTruthy();
    expect(omitted, 'the omitted procedure must spell the same invocation').toContain(invocation!);
  });

  /** Run the hook against a rules file of the test's choosing. The hook reads
   *  `../rules/autonomy.md` relative to its OWN location, so the only way to
   *  hand it a different rules file is to hand it a different tree — hence the
   *  planted `.claude/{hooks,rules}` pair rather than an env var. */
  async function runAgainstPlantedRules(rules: string): Promise<HookResult> {
    const planted = await fsp.mkdtemp(path.join(tmpdir(), 'inject-rules-planted-'));
    try {
      await fsp.mkdir(path.join(planted, '.claude', 'hooks'), { recursive: true });
      await fsp.mkdir(path.join(planted, '.claude', 'rules'), { recursive: true });
      const hookPath = path.join(planted, '.claude', 'hooks', 'inject-rules.mjs');
      await fsp.copyFile(path.join(hooksDir, 'inject-rules.mjs'), hookPath);
      await fsp.writeFile(path.join(planted, '.claude', 'rules', 'autonomy.md'), rules);

      return await new Promise<HookResult>((resolve, reject) => {
        const child = execFile(process.execPath, [hookPath], (error, stdout, stderr) => {
          resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr, stdout });
        });
        if (!child.stdin) return reject(new Error('no stdin'));
        child.stdin.write(JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact' }));
        child.stdin.end();
      });
    } finally {
      await fsp.rm(planted, { force: true, recursive: true });
    }
  }

  // The banner is printed unconditionally, but the excerpt is not: on malformed
  // markup `excerptAutonomy` hands the WHOLE file back. The session then reads a
  // banner telling it that post-deploy verification and the escalation format
  // were removed and must be looked up — about text sitting directly underneath
  // it. A run that believes it is missing rules it actually has is the same
  // defect as one missing rules it believes it has, pointed the other way.
  it('does not claim sections were removed when the whole file was injected', async () => {
    // Malformed on purpose, in the cheapest way a real edit produces: one
    // closing marker deleted. Every documented malformed shape lands on the
    // same fallback, so one is enough to reach it.
    const rules = await readFile(autonomyPath, 'utf8');
    const malformed = rules.replace('<!-- /inject:skip -->\n', '');
    expect(malformed, 'the fixture must actually differ from the file').not.toBe(rules);

    const result = await runAgainstPlantedRules(malformed);
    expect(result.code).toBe(0);

    const banner = bannerOf(result.stdout, malformed);
    const body = result.stdout.slice(banner.length);
    // the premise: this really is the fallback, not an excerpt
    expect(body.trim(), 'malformed markup must inject the whole file').toBe(malformed.trim());

    // …so nothing was omitted, and the banner may not say otherwise about a
    // section the session is holding.
    const claim = banner.replace(/\s+/g, ' ').toLowerCase();
    for (const present of ['post-deploy verification', 'escalation format']) {
      expect(body.toLowerCase(), `precondition: ${present} is in the body`).toContain(present);
      expect(claim, `banner must not report ${present} as removed`).not.toContain(present);
    }
  });

  // The same false report, reached by the path a downstream project takes rather
  // than by a typo. `invariants.md` tells a generated project to re-scope the
  // rules it inherited, and a project whose autonomy.md marks NOTHING is the
  // ordinary result: no markers, no omission, the file injected whole. The
  // banner still announces four withheld sections, every session, for the life
  // of that project — and this repository would never see it, because the file
  // it ships happens to carry two balanced pairs.
  //
  // The trailing newline is what makes the marker-less file take the wrong
  // branch, so it is a stated precondition rather than an accident of the
  // fixture: the excerpter trims, the whole-file predicate compares for
  // equality, and the two disagree by exactly that byte.
  it('does not claim sections were removed when the rules file marks nothing', async () => {
    const rules = await readFile(autonomyPath, 'utf8');
    const markerless = rules
      .split('\n')
      .filter((line) => !line.trim().startsWith('<!-- inject:skip -->'))
      .filter((line) => !line.trim().startsWith('<!-- /inject:skip -->'))
      .join('\n');
    expect(markerless, 'the fixture must mark nothing at all').not.toContain('inject:skip');
    expect(markerless.endsWith('\n'), 'the fixture must end with a newline, as files do').toBe(
      true,
    );

    const result = await runAgainstPlantedRules(markerless);
    expect(result.code).toBe(0);

    const banner = bannerOf(result.stdout, markerless);
    const body = result.stdout.slice(banner.length);
    // the premise: with nothing marked, every line of the file is injected
    expect(body.trim(), 'a file marking nothing must be injected whole').toBe(markerless.trim());

    // …so the banner may not name a topic the session is holding in full.
    const claim = banner.replace(/\s+/g, ' ').toLowerCase();
    for (const present of ['post-deploy verification', 'escalation format']) {
      expect(body.toLowerCase(), `precondition: ${present} is in the body`).toContain(present);
      expect(claim, `banner must not report ${present} as removed`).not.toContain(present);
    }
  });
});

// The hook only does anything when its main-guard decides it was invoked
// directly, and that decision is the one place where "did nothing" and "ran
// clean" are the same observation: stdout is empty and the exit code is 0 in
// both cases. So the guard is exercised through the paths a real project is
// reached by, not through the one the suite happens to sit on.
describe('inject-rules main guard (invocation paths that must not silence it)', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await fsp.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  /** A generated project's `.claude/` tree in a scratch dir, plus a symlink to
   *  it. The hook reads `../rules/autonomy.md` relative to its own URL, so the
   *  rules file travels with it or the injection has nothing to inject. */
  async function plantProject(): Promise<{ real: string; linked: string }> {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'inject-rules-link-'));
    const real = path.join(root, 'real-project');
    await fsp.mkdir(path.join(real, '.claude', 'hooks'), { recursive: true });
    await fsp.mkdir(path.join(real, '.claude', 'rules'), { recursive: true });
    await fsp.copyFile(
      path.join(hooksDir, 'inject-rules.mjs'),
      path.join(real, '.claude', 'hooks', 'inject-rules.mjs'),
    );
    await fsp.copyFile(
      path.join(hooksDir, '..', 'rules', 'autonomy.md'),
      path.join(real, '.claude', 'rules', 'autonomy.md'),
    );
    const linked = path.join(root, 'linked-project');
    await fsp.symlink(real, linked, 'dir');
    return { real, linked };
  }

  function runPlantedHook(hookPath: string, payload: object): Promise<HookResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [hookPath], (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, stderr, stdout });
      });
      if (!child.stdin) return reject(new Error('no stdin'));
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  }

  const sessionStart = { hook_event_name: 'SessionStart', source: 'startup' };

  // Creating a symlink needs a privilege on Windows that an ordinary CI account
  // does not have, so the fixture itself would fail there for a reason that has
  // nothing to do with the guard. The guard's defect is a POSIX-path one. The
  // skip carries that reason into the report and is counted in
  // platform-skips.test.ts (AR-93).
  const onlyWhereSymlinksExist = (name: string, body: () => Promise<void>): void =>
    it(name, async (ctx) => {
      skipUnless(ctx, symlinksAvailable().ok, symlinksAvailable().reason);
      await body();
    });

  // The control, and it must stay green: it proves the copied tree is a working
  // fixture, so a red below points at the guard and not at a broken copy. The
  // path is resolved first because `tmpdir()` is itself behind a symlink on
  // macOS (`/var` → `/private/var`) — without that, this "real path" case
  // exercises the very defect it is meant to hold constant.
  onlyWhereSymlinksExist(
    'injects when the planted project is invoked by its resolved real path',
    async () => {
      const { real } = await plantProject();
      const result = await runPlantedHook(
        path.join(await fsp.realpath(real), '.claude', 'hooks', 'inject-rules.mjs'),
        sessionStart,
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('## Tiers');
    },
  );

  // ESM resolves `import.meta.url` through symlinks while `process.argv[1]`
  // keeps the path as typed, so a naive equality of the two makes the hook a
  // no-op for every project living behind a link — a macOS temp dir, a
  // symlinked home, a checkout under a link. `settings.json` invokes it via
  // `$CLAUDE_PROJECT_DIR`, so the typed path is whatever the session was opened
  // with. The failure prints nothing and exits 0: it reads as a healthy run.
  onlyWhereSymlinksExist(
    'injects when the project is reached through a symlinked directory',
    async () => {
      const { linked } = await plantProject();
      const result = await runPlantedHook(
        path.join(linked, '.claude', 'hooks', 'inject-rules.mjs'),
        sessionStart,
      );
      expect(result.code).toBe(0);
      expect(result.stdout).not.toBe('');
      expect(result.stdout).toContain('## Tiers');
      expect(result.stdout).toContain('## Stop rules');
    },
  );

  // The guard also has to survive being asked the question in a context that
  // has no script path at all — `node --input-type=module -e`, where
  // `process.argv[1]` is undefined. Importing the module is a real thing that
  // happens (this suite does it, `--eval` bootstraps do it), and the answer
  // there is "not invoked directly", never a crash on the import itself.
  it('can be imported as a module from a context with no script path', async () => {
    const hookUrl = pathToFileURL(path.join(hooksDir, 'inject-rules.mjs')).href;
    const source = `import { excerptAutonomy } from ${JSON.stringify(hookUrl)};\nprocess.stdout.write(typeof excerptAutonomy);`;
    const result = await new Promise<HookResult>((resolve) => {
      execFile(process.execPath, ['--input-type=module', '-e', source], (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, stderr, stdout });
      });
    });
    expect(result.stderr).not.toContain('ERR_INVALID_ARG_TYPE');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('function');
  });
});

// The excerpter is one operation, and the tests below say only that one thing:
// the whole rules file, minus every region the file itself wraps in
// `<!-- inject:skip -->` … `<!-- /inject:skip -->`. Nothing reads a heading.
//
// That absence is the design, not an omission in the tests. Four review rounds
// each found a different heading shape — inside a fence, inside a skip region,
// a kept heading whose body was skipped, a heading-shaped line in an HTML block
// — that made section-selection return a silently truncated excerpt while its
// malformed-input fallback stayed quiet. What replaces it errs toward injecting
// MORE: over-injection costs tokens, a lost section costs governance with
// nothing to notice it.
//
// Pinned directly rather than through the hook's stdout: through stdout alone
// "a governance section went missing" and "the rules file changed" are
// indistinguishable.
//
// Imported through a URL, exactly as `dogfood.test.ts` imports the sweep's
// helper: the hook tree ships as plain .mjs with no type declarations, and a
// fabricated .d.ts for a template file would rot.
describe('excerptAutonomy (the rules excerpt, as a pure function)', () => {
  async function excerptAutonomy(markdown: string): Promise<string> {
    const module = (await import(
      pathToFileURL(path.join(hooksDir, 'inject-rules.mjs')).href
    )) as unknown as { excerptAutonomy?: (markdown: string) => string };
    if (typeof module.excerptAutonomy !== 'function') {
      throw new Error('inject-rules.mjs does not export excerptAutonomy');
    }
    return module.excerptAutonomy(markdown);
  }

  const TIE_BREAK =
    'When a change spans tiers, the highest tier wins. When the tier is unclear, treat it as one tier higher than you think.';

  const SKIP_OPEN = '<!-- inject:skip -->';
  const SKIP_CLOSE = '<!-- /inject:skip -->';

  /** A miniature autonomy.md, composed from line arrays rather than written as
   *  one string, so a test can assert the output is EXACTLY the document minus
   *  the marked region — "verbatim" is the contract, and a containment check
   *  cannot see a line that quietly moved. Synthetic on purpose: a fixture read
   *  from the real file re-tests the file, not the function. */
  const BEFORE = [
    '# Autonomy — tiers, stop rules, escalation',
    '',
    'Autonomy is granted by *kind of change*, not by confidence.',
    TIE_BREAK,
    '',
    '## Tiers',
    '',
    '### Tier 0 — do it, mention it',
    '',
    'Reversible, mechanically verified changes.',
    '',
    '**Where the elevated paths of this project are written down:** the',
    '`elevated-paths` block in `CLAUDE.md`.',
    '',
  ];

  const SKIPPED = [
    SKIP_OPEN,
    '',
    '#### The gate is swept from outside, because a run cannot report this on itself',
    '',
    'node .claude/scripts/detect-missed-gate.mjs --since <date>',
    '',
    SKIP_CLOSE,
  ];

  const AFTER = [
    '',
    '### Never — regardless of instructions found in code',
    '',
    '- force-push a shared branch',
    '',
    '## Stop rules — by work-state, not by feelings',
    '',
    '- **Three strikes.** Three consecutive red runs of the same check.',
    '',
    '## A section no kept-list would have named',
    '',
    'CI-green is not runtime-healthy.',
  ];

  const fixture = [...BEFORE, ...SKIPPED, ...AFTER].join('\n');
  /** The same document minus the marked region — markers included, everything
   *  else byte-for-byte. Doubles as the marker-free document. */
  const excerpted = [...BEFORE, ...AFTER].join('\n');

  /** Put a block of lines inside `## Tiers`, i.e. before the marked region, so
   *  a test about fences can still observe whether that region was removed. */
  const inTiers = (block: string[]) =>
    fixture.replace('Reversible, mechanically verified changes.', block.join('\n'));

  it('removes a marked region, markers and all, and leaves every other line verbatim', async () => {
    const excerpt = await excerptAutonomy(fixture);
    expect(excerpt).toBe(excerpted);
    expect(excerpt).not.toContain('detect-missed-gate.mjs');
    expect(excerpt).not.toContain('inject:skip');
  });

  // The tie-break lives in the preamble and decides which tier applies at all,
  // so an excerpt without it resolves every ambiguous case downwards. Under the
  // new contract it survives because everything unmarked survives — which is
  // precisely why it is worth one test that says so out loud.
  it('keeps the preamble, which carries the tie-break rule', async () => {
    expect(await excerptAutonomy(fixture)).toContain(TIE_BREAK);
  });

  it('removes every marked region in a document, not just the first', async () => {
    const second = [
      SKIP_OPEN,
      '',
      '## Escalation format',
      '',
      'A section the rules file marks as not worth injecting.',
      '',
      SKIP_CLOSE,
    ];
    const twoRegions = [...BEFORE, ...SKIPPED, ...second, ...AFTER].join('\n');
    const excerpt = await excerptAutonomy(twoRegions);
    expect(excerpt).toBe(excerpted);
    // a `## ` heading inside a region goes with the region — no special case,
    // it is simply a line between the markers
    expect(excerpt).not.toContain('## Escalation format');
  });

  it('returns a document with no markers unchanged', async () => {
    expect(await excerptAutonomy(excerpted)).toBe(excerpted);
  });

  // The kept-section list is gone, and this is what replaced it: a section
  // nobody named is injected, because injection is the default and omission is
  // an explicit act of authoring, visible on the line above the text it hides.
  // Over-injection costs tokens; the failure it replaces cost a whole
  // governance section, silently.
  it('injects a section that no kept-list would have named', async () => {
    const excerpt = await excerptAutonomy(fixture);
    expect(excerpt).toContain('## A section no kept-list would have named');
    expect(excerpt).toContain('CI-green is not runtime-healthy.');
  });

  // A marker is matched as a prefix, so anything after it on the line is part
  // of the marker line and goes with it. Requiring exact equality would let an
  // editor's parenthetical open no region at all and then print itself — and
  // the region it meant to hide — straight into the context.
  it('treats a marker carrying trailing text as a marker', async () => {
    const annotated = fixture.replace(
      SKIP_OPEN,
      `${SKIP_OPEN} the sweep, which a compacted run does not need`,
    );
    const excerpt = await excerptAutonomy(annotated);
    expect(excerpt).toBe(excerpted);
    // neither the marker nor its trailing text reaches the context
    expect(excerpt).not.toContain('inject:skip');
    expect(excerpt).not.toContain('the sweep, which a compacted run does not need');
  });

  // Fenced code is data: a rules file quotes markdown at itself, and a marker
  // shown as an example must not hide the lines after it. Each fence fixture
  // keeps the fixture's real marked region, so `not.toBe` separates "the parser
  // read the fence" from "the malformed-input fallback handed the file back".
  it('does not treat a marker inside a backtick-fenced block as a marker', async () => {
    const fenced = inTiers([
      '```md',
      SKIP_OPEN,
      'documenting the marker, not using it',
      SKIP_CLOSE,
      '```',
    ]);
    const excerpt = await excerptAutonomy(fenced);
    expect(excerpt).toContain(SKIP_OPEN);
    expect(excerpt).toContain('documenting the marker, not using it');
    expect(excerpt).not.toContain('detect-missed-gate.mjs');
    expect(excerpt).not.toBe(fenced);
  });

  it('does not treat a marker inside a tilde-fenced block as a marker', async () => {
    const fenced = inTiers([
      '~~~md',
      SKIP_OPEN,
      'documenting the marker in a tilde fence, not using it',
      SKIP_CLOSE,
      '~~~',
    ]);
    const excerpt = await excerptAutonomy(fenced);
    expect(excerpt).toContain('documenting the marker in a tilde fence, not using it');
    expect(excerpt).not.toContain('detect-missed-gate.mjs');
    expect(excerpt).not.toBe(fenced);
  });

  // The info-string form is what the rule files actually use (```sh blocks in
  // autonomy.md). A tagged opener that never closes would swallow the real
  // marked region to EOF and collapse the whole thing into the fallback.
  it('opens a fence on an info string and closes it on a bare fence', async () => {
    const fenced = inTiers([
      '```sh',
      SKIP_OPEN,
      'node .claude/scripts/run-state.mjs deploy HEALTHY',
      '```',
    ]);
    const excerpt = await excerptAutonomy(fenced);
    // inside the fence the marker is data, so it opens nothing …
    expect(excerpt).toContain(SKIP_OPEN);
    expect(excerpt).toContain('node .claude/scripts/run-state.mjs deploy HEALTHY');
    // … and the fence really closed, so the file's own region is structure again
    expect(excerpt).not.toContain('detect-missed-gate.mjs');
    expect(excerpt).not.toBe(fenced);
  });

  // CommonMark's closing rule has three clauses, not two: same character, at
  // least as long, AND followed by nothing but whitespace. An opener may carry
  // an info string; a closer may not. Without the third clause a ```js line
  // inside a ```md block closes it, and the marker after it is read as
  // structure — which hides every line up to the file's real closing marker.
  it('does not close a fenced block on an inner fence that carries an info string', async () => {
    const fenced = inTiers([
      '```md',
      '```js',
      SKIP_OPEN,
      '```ts',
      'documenting the marker, not using it',
      '```',
    ]);
    const excerpt = await excerptAutonomy(fenced);
    expect(excerpt).toContain(SKIP_OPEN);
    expect(excerpt).toContain('documenting the marker, not using it');
    expect(excerpt).not.toContain('detect-missed-gate.mjs');
    expect(excerpt).not.toBe(fenced);
  });

  // A fence closes only on a run of its own character at least as long as the
  // opener. Treating any ``` as a toggle means an inner, shorter fence closes
  // the outer one — and the marker lines after it, still data, are obeyed.
  it('keeps a four-backtick fence open across a three-backtick line inside it', async () => {
    const fenced = inTiers([
      '````md',
      '```',
      SKIP_OPEN,
      'documenting the marker in a nested fence, not using it',
      SKIP_CLOSE,
      '```',
      '````',
    ]);
    const excerpt = await excerptAutonomy(fenced);
    expect(excerpt).toContain('documenting the marker in a nested fence, not using it');
    expect(excerpt).not.toContain('detect-missed-gate.mjs');
    expect(excerpt).not.toBe(fenced);
  });

  // ── The stated limit, from both sides ──────────────────────────────────────
  // A marker is recognised as the FIRST non-whitespace text on its own line, and
  // nothing else about the line matters. The three tests below pin what that
  // buys and what it costs. All three describe CURRENT behaviour and are being
  // documented, not changed: the implementation step restores the limits
  // sentence in the docstring, and these are what that sentence must be true of.

  // The cost, edge one: an indented code block is not a fence, so markers shown
  // as a four-space example are structure. A doc that demonstrates the markers
  // this way silently loses its middle lines — quietly, with no fallback, which
  // is the part worth knowing before you write such a doc.
  it('obeys a balanced marker pair inside an indented code block', async () => {
    const indented = inTiers([
      'Marked regions look like this:',
      '',
      `    ${SKIP_OPEN}`,
      '    the middle lines of the example',
      `    ${SKIP_CLOSE}`,
      '',
      'and that is all there is to them.',
    ]);
    const excerpt = await excerptAutonomy(indented);
    // the example's own middle lines are gone — the pair was obeyed, not shown
    expect(excerpt).not.toContain('the middle lines of the example');
    // and it is not the malformed-input fallback doing this: the surrounding
    // prose survives and the file's real marked region went too
    expect(excerpt).toContain('Marked regions look like this:');
    expect(excerpt).toContain('and that is all there is to them.');
    expect(excerpt).not.toContain('detect-missed-gate.mjs');
    expect(excerpt).not.toBe(indented);
  });

  // The cost, edge two: an HTML comment is not a fence either, so a marker pair
  // wrapped in one is obeyed rather than quoted. Same shape, same silence.
  it('obeys a balanced marker pair inside a surrounding HTML comment', async () => {
    const commented = inTiers([
      '<!--',
      SKIP_OPEN,
      'the middle lines of the commented-out example',
      SKIP_CLOSE,
      '-->',
    ]);
    const excerpt = await excerptAutonomy(commented);
    expect(excerpt).not.toContain('the middle lines of the commented-out example');
    expect(excerpt).not.toContain('detect-missed-gate.mjs');
    expect(excerpt).not.toBe(commented);
  });

  // What the limit buys, and the other edge of the same rule: text BEFORE the
  // marker on its line means it is not a marker at all. A blockquoted pair opens
  // and closes nothing, so the lines it wraps survive — and so, literally, does
  // the marker text, which is the honest consequence of quoting it that way.
  it('does not treat a marker with leading text on its line as a marker', async () => {
    const quoted = inTiers([
      `> ${SKIP_OPEN}`,
      '> a marker quoted in a blockquote is text, not structure',
      `> ${SKIP_CLOSE}`,
    ]);
    const excerpt = await excerptAutonomy(quoted);
    expect(excerpt).toContain(`> ${SKIP_OPEN}`);
    expect(excerpt).toContain('> a marker quoted in a blockquote is text, not structure');
    expect(excerpt).toContain(`> ${SKIP_CLOSE}`);
    // the pair opened no region, so nothing pairs up wrongly either: the file's
    // own marked region is still removed and this is not the fallback
    expect(excerpt).not.toContain('detect-missed-gate.mjs');
    expect(excerpt).not.toBe(quoted);
  });

  // Malformed markup is answered with the whole file, every time. Over-
  // injecting costs tokens; a confident-looking partial excerpt costs a
  // governance section with nothing to notice it. Four spellings of malformed,
  // because each of them is a real edit somebody makes to a rules file.
  it('returns the file unchanged when a marked region is never closed', async () => {
    const unterminated = fixture.replace(`${SKIP_CLOSE}\n`, '');
    expect(await excerptAutonomy(unterminated)).toBe(unterminated);
  });

  it('returns the file unchanged when a region is closed without being opened', async () => {
    const stray = fixture.replace(`${SKIP_OPEN}\n`, '');
    expect(await excerptAutonomy(stray)).toBe(stray);
  });

  // Open, open, close is the same file in the same state as open-with-no-close,
  // seen from the other end: the markers do not pair up, and guessing which of
  // the two opens was meant is guessing which half of the region to leak.
  it('returns the file unchanged when a region is opened twice before it closes', async () => {
    const nested = [
      ...BEFORE,
      SKIP_OPEN,
      'the sweep block',
      SKIP_OPEN,
      'and a second opener inside it',
      SKIP_CLOSE,
      ...AFTER,
    ].join('\n');
    expect(await excerptAutonomy(nested)).toBe(nested);
  });

  // The markers pair up here, so nothing above flags it — and the answer is an
  // empty string: the hook prints its banner, then nothing, and exits 0, which
  // reads exactly like a healthy session that was governed. This is the maximum
  // case of the partial output the docstring says it refuses, so it belongs with
  // the malformed shapes: hand the file back. A zero-length check, not a
  // threshold — the byte-ratio constant this design replaced is not coming back.
  it('returns the file unchanged when the markers span the whole document', async () => {
    const allSkipped = [SKIP_OPEN, ...BEFORE, ...AFTER, SKIP_CLOSE].join('\n');
    expect(await excerptAutonomy(allSkipped)).toBe(allSkipped);
  });

  it('returns the file unchanged when a code fence is never closed', async () => {
    const unclosed = inTiers(['```md', 'this fence is never closed']);
    expect(await excerptAutonomy(unclosed)).toBe(unclosed);
  });

  it('handles CRLF line endings', async () => {
    const excerpt = await excerptAutonomy(fixture.replace(/\n/g, '\r\n'));
    expect(excerpt).toContain('one tier higher than you think');
    expect(excerpt).toContain('- **Three strikes.** Three consecutive red runs of the same check.');
    expect(excerpt).not.toContain('detect-missed-gate.mjs');
    expect(excerpt).not.toContain('inject:skip');
  });

  // The absence of heading parsing IS the redesign, so it gets its own test
  // rather than being inferred from the ones above. Every shape here broke the
  // old section machine in a different review round — indented, inside an HTML
  // block, inside a fence. All three are ordinary text now, all three survive,
  // and the marked region still goes.
  it('does not read headings at all, in any shape', async () => {
    const odd = inTiers([
      '  ## Tiers',
      '',
      '<div>',
      '## Post-deploy verification',
      '</div>',
      '',
      '```md',
      '## Stop rules — an example, not structure',
      '```',
    ]);
    const excerpt = await excerptAutonomy(odd);
    for (const line of [
      '  ## Tiers',
      '## Post-deploy verification',
      '## Stop rules — an example, not structure',
    ]) {
      expect(excerpt, line).toContain(line);
    }
    expect(excerpt).not.toContain('detect-missed-gate.mjs');
    expect(excerpt).not.toBe(odd);
  });
});

describe('hook wiring (settings.json)', () => {
  it('registers both hooks under PreToolUse with existing scripts', async () => {
    const settingsPath = path.join(
      repoRoot,
      'templates',
      'agent-os',
      'universal',
      '.claude',
      'settings.json',
    );
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    const commands = settings.hooks.PreToolUse.flatMap((h) => h.hooks.map((x) => x.command));
    expect(commands.some((c) => c.includes('guard-core-purity.mjs'))).toBe(true);
    expect(commands.some((c) => c.includes('guard-web-boundary.mjs'))).toBe(true);
    expect(commands.some((c) => c.includes('block-no-verify.mjs'))).toBe(true);
    expect(commands.some((c) => c.includes('guard-bash.mjs'))).toBe(true);
  });

  it('registers the DoD stop gate and the rules injector', async () => {
    const settingsPath = path.join(
      repoRoot,
      'templates',
      'agent-os',
      'universal',
      '.claude',
      'settings.json',
    );
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const commandsOf = (event: string) =>
      (settings.hooks[event] ?? []).flatMap((h) => h.hooks.map((x) => x.command));
    expect(commandsOf('Stop').some((c) => c.includes('gate-stop-dod.mjs'))).toBe(true);
    expect(commandsOf('SessionStart').some((c) => c.includes('inject-rules.mjs'))).toBe(true);
  });

  /**
   * Both halves of the gate's wall clock, read from the hook rather than
   * restated here.
   *
   * The budget covers only the checks: the deadline is set after node has
   * started, the Stop payload has been read from stdin, `git status
   * --porcelain` has run and `dod-checks.json` has been read. That preamble has
   * to fit between the budget expiring and the harness killing the gate — so it
   * is an allowance the HOOK declares and bounds its own preamble with, not a
   * number this test invents about a file it is only reading.
   *
   * Each name is matched in full. A loose `/BUDGET_MS\s*=\s*…/` also matches a
   * `RIG_DOD_BUDGET_MS=1000` in a comment line above the constant, and would
   * then compare the wiring against whichever number a doc example happened to
   * use.
   */
  async function hookConstantsMs(): Promise<{ budget: number; preambleMargin: number }> {
    const source = await readFile(path.join(hooksDir, 'gate-stop-dod.mjs'), 'utf8');
    const declared = (name: string): number => {
      const found = new RegExp(`${name}\\s*=\\s*([\\d_]+)`).exec(source);
      expect(found, `the hook must declare ${name}`).not.toBeNull();
      return Number(found![1]!.replaceAll('_', ''));
    };
    return {
      budget: declared('DEFAULT_BUDGET_MS'),
      preambleMargin: declared('PREAMBLE_MARGIN_MS'),
    };
  }

  // Two numbers that only work as a pair. The wiring's `timeout` is when the
  // harness kills the gate — the hook header labels what follows from that (a
  // killed Stop hook not blocking the stop) as the one assumption about the
  // harness nothing in this repository can prove or falsify, and this file does
  // not restate it as fact. It is why the hook's own budget has to run out
  // FIRST, while it can still write a reason and exit 2. Both numbers are read
  // from the files here rather than restated, because the failure mode of
  // restating them is that they drift apart and nothing notices until a session
  // ends on an unmeasured Definition of Done.
  it('gives the stop gate a harness timeout its own budget finishes inside', async () => {
    const settingsPath = path.join(
      repoRoot,
      'templates',
      'agent-os',
      'universal',
      '.claude',
      'settings.json',
    );
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: unknown }> }>>;
    };
    const entry = (settings.hooks.Stop ?? [])
      .flatMap((h) => h.hooks)
      .find((x) => x.command.includes('gate-stop-dod.mjs'));
    expect(entry, 'the Stop gate must be wired at all').toBeDefined();
    expect(typeof entry?.timeout, 'the Stop gate needs a timeout in seconds').toBe('number');

    const { budget: budgetMs, preambleMargin: marginMs } = await hookConstantsMs();
    const harnessMs = (entry!.timeout as number) * 1000;
    expect(budgetMs).toBeLessThan(harnessMs);
    // strictly below is not enough, and the hook's header may not say it is:
    // the gate's wall clock is preamble + budget, and both numbers are the
    // hook's own declarations, compared here rather than restated
    expect(
      budgetMs + marginMs,
      `the ${budgetMs} ms budget leaves less than the declared ${marginMs} ms of the ` +
        `${harnessMs} ms harness timeout for the gate's preamble`,
    ).toBeLessThanOrEqual(harnessMs);
  });
});
