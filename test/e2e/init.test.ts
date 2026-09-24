import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitEnv } from '../../packages/cli/src/lib/git-env.js';
import { onlyOnWindows, posixShellAvailable, skipUnless } from '../helpers/env.js';
import { removeFixture } from '../helpers/remove-fixture.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliBin = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-init-e2e-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

async function runInit(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cliBin, 'init', ...args], {
      cwd: repo,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

async function hookFiles(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory()
        ? hookFiles(root, full)
        : Promise.resolve([path.relative(root, full).split(path.sep).join('/')]);
    }),
  );
  return files.flat().filter((rel) => rel.endsWith('.mjs'));
}

describe('create-agent-rig init (into an existing repo)', () => {
  it('installs the process layer and leaves architecture rules out', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    const result = await runInit([]);
    expect(result.code).toBe(0);
    expect(await readFile(path.join(repo, '.claude', 'rules', 'workflow.md'), 'utf8')).toContain(
      'TDD',
    );
    await expect(
      readFile(path.join(repo, '.claude', 'rules', 'architecture.md')),
    ).rejects.toThrow();
  });

  it('a dry run writes nothing', async () => {
    const result = await runInit(['--dry-run']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/dry run/i);
    await expect(readFile(path.join(repo, '.claude', 'rules', 'workflow.md'))).rejects.toThrow();
  });

  it('leaves a rig whose hooks are wired and whose scripts parse', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runInit([])).code).toBe(0);

    const settings = JSON.parse(
      await readFile(path.join(repo, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks).length).toBeGreaterThan(0);

    // DERIVED from the manifest, never restated. This assertion was a hand-written
    // list until adding one process hook turned it red — which is the "fourth
    // copy" failure `invariants.md` names: the list and the thing it describes
    // drift, and the copy nobody is looking at is the one that is wrong. Asking
    // layers.json makes the assertion "init installs exactly the hooks the
    // process layer claims", which is the property that actually matters.
    //
    // ⚠ The limit that buys, stated rather than discovered: both sides now trace
    // back to layers.json, so a hook DROPPED from the manifest changes neither
    // and this case stays green. That question belongs to two tests that own it,
    // and both were checked by removing an entry and watching them go red:
    // composition.test.ts › "classifies every universal file exactly once", and
    // guard-secret-file.test.ts › "is classified in layers.json together with
    // the module it imports".
    const manifest = JSON.parse(
      await readFile(
        path.join(repoRoot, 'templates', 'agent-os', 'universal', 'layers.json'),
        'utf8',
      ),
    ) as Record<string, string[]>;
    const expectedHooks = (manifest['process'] ?? [])
      .filter((rel) => rel.startsWith('.claude/hooks/'))
      .map((rel) => rel.slice('.claude/hooks/'.length));
    // Non-vacuity: a renamed key or a changed prefix would otherwise make the
    // comparison below pass on two empty arrays, forever.
    expect(expectedHooks.length, 'no process hooks read from layers.json').toBeGreaterThan(3);
    expect(expectedHooks).toContain('block-no-verify.mjs');

    const hooksRoot = path.join(repo, '.claude', 'hooks');
    const hooks = await hookFiles(hooksRoot);
    expect(hooks.sort()).toEqual(expectedHooks.sort());
    for (const hook of hooks) {
      await exec(process.execPath, ['--check', path.join(hooksRoot, hook)]);
    }

    // the kill switch is a filename: an unsubstituted token means the brake
    // looks for a file the operator will never create
    const stopFlag = await readFile(path.join(repo, '.claude', 'scripts', 'stop-flag.mjs'), 'utf8');
    expect(stopFlag).toContain(`${path.basename(repo).toLowerCase()}-loop-STOP`);
    expect(stopFlag).not.toContain('__PROJECT_NAME__');
  });

  it('tells the operator when it could not wire the hooks itself', async () => {
    await mkdir(path.join(repo, '.claude'), { recursive: true });
    await writeFile(path.join(repo, '.claude', 'settings.json'), '{}');
    const result = await runInit([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/settings\.json/);
    expect(result.stdout).toMatch(/not wired|merge/i);
    expect(await readFile(path.join(repo, '.claude', 'settings.json'), 'utf8')).toBe('{}');
  });

  it('tells the operator when it kept existing Codex hook wiring', async () => {
    await mkdir(path.join(repo, '.codex'), { recursive: true });
    await writeFile(path.join(repo, '.codex', 'hooks.json'), '{}');
    const result = await runInit([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/\.codex[/\\]hooks\.json/);
    expect(result.stdout).toMatch(/not wired|merge/i);
    expect(await readFile(path.join(repo, '.codex', 'hooks.json'), 'utf8')).toBe('{}');
  });

  it('refuses to clobber an existing CLAUDE.md, as a message not a trace', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), '# host rules');
    const result = await runInit([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/CLAUDE\.md/);
    expect(result.stderr).not.toMatch(/at .*init\.js/);
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe('# host rules');
  });
});

// RP-180 round 2: the owner's flag spelling is `--layer <name>`, not
// `--with-workflow`. `process`/Core installs unconditionally and is never a
// name a user passes; `workflow` is the only accepted name today.
describe('create-agent-rig init --layer (RP-180)', () => {
  it('installs the workflow layer when given --layer workflow', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    const result = await runInit(['--layer', 'workflow']);
    expect(result.code, result.stderr).toBe(0);
    await expect(
      readFile(path.join(repo, '.claude', 'skills', 'loop', 'SKILL.md')),
    ).resolves.toBeTruthy();
    const manifest = JSON.parse(
      await readFile(path.join(repo, '.claude', '.rig-manifest.json'), 'utf8'),
    ) as { layers: string[] };
    expect(manifest.layers.sort()).toEqual(['process', 'workflow']);
  });

  it('repeating --layer workflow is harmless', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    const result = await runInit(['--layer', 'workflow', '--layer', 'workflow']);
    expect(result.code, result.stderr).toBe(0);
    await expect(
      readFile(path.join(repo, '.claude', 'skills', 'loop', 'SKILL.md')),
    ).resolves.toBeTruthy();
  });

  it('refuses an unknown --layer name, naming the accepted values, and installs nothing', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    const result = await runInit(['--layer', 'bogus']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/bogus/);
    expect(result.stderr).toMatch(/workflow/);
    await expect(readFile(path.join(repo, '.claude', 'rules', 'workflow.md'))).rejects.toThrow();
  });

  it('refuses a bare --layer with no value', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    const result = await runInit(['--layer']);
    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('never mentions --with-workflow in its own usage text', async () => {
    const result = await runInit(['--help']);
    expect(`${result.stdout}${result.stderr}`).not.toContain('--with-workflow');
  });

  // RP-259: `--force` is refused, not gone — `runInit(['--force'])` above still
  // exits non-zero and still names the flag. "removed in 0.6" is therefore
  // false today, in every release since 0.6, and it goes stale again the
  // moment the next release ships — a reason tied to a past release number is
  // never true for long. The usage text should say what --force does NOW
  // (refused, in favour of upgrade), not cite a release that already passed.
  it('does not claim --force was removed in a past release, while still saying it is refused', async () => {
    const result = await runInit(['--help']);
    const text = `${result.stdout}${result.stderr}`;
    // The `--force` LINE itself says "refused", not merely the help text
    // somewhere else — `/refus/i` alone is already satisfied by an unrelated
    // line ("Refuses to clobber CLAUDE.md") whatever the --force line says.
    expect(text).toMatch(/--force[^\n]*refus/i);
    expect(text).not.toMatch(/removed in 0\.6/i);
  });

  // RP-225 slice 2: `record-dispatch.mjs` sits under `.claude/hooks/` like the
  // process-layer guards, but `layers.json` places it in the WORKFLOW set —
  // its one reader is `lib/gate-coverage.mjs`'s `witness` answer, which only
  // means anything once `pr-ship`/`loop` (and a run directory) exist. A
  // Core-only install must not wire a `SubagentStart`/`SubagentStop` hook it
  // never installed.
  it('a Core-only init installs neither record-dispatch.mjs nor its SubagentStart/SubagentStop wiring', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runInit([])).code).toBe(0);

    await expect(
      readFile(path.join(repo, '.claude', 'hooks', 'record-dispatch.mjs')),
    ).rejects.toThrow();

    const settings = JSON.parse(
      await readFile(path.join(repo, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: Record<string, unknown> };
    expect(settings.hooks['SubagentStart']).toBeUndefined();
    expect(settings.hooks['SubagentStop']).toBeUndefined();
  });

  it('--layer workflow installs record-dispatch.mjs and wires it on SubagentStart/SubagentStop', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    const result = await runInit(['--layer', 'workflow']);
    expect(result.code, result.stderr).toBe(0);

    await expect(
      readFile(path.join(repo, '.claude', 'hooks', 'record-dispatch.mjs'), 'utf8'),
    ).resolves.toContain('record-dispatch');

    const settings = JSON.parse(
      await readFile(path.join(repo, '.claude', 'settings.json'), 'utf8'),
    ) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>>;
    };
    for (const event of ['SubagentStart', 'SubagentStop']) {
      const hooks = (settings.hooks[event] ?? []).flatMap((group) => group.hooks);
      const dispatch = hooks.find((hook) => hook.command.includes('record-dispatch.mjs'));
      expect(dispatch, `${event} has no record-dispatch.mjs entry`).toBeDefined();
      expect(dispatch?.command).toContain('--harness=claude');
      // Claude Code's own `timeout` field is seconds (`gate-stop-dod`'s own
      // entry in this same file is `900`, i.e. 15 minutes) — the design caps
      // this hook at 10s so an observe-only write never stalls a dispatch.
      expect(dispatch?.timeout).toBeDefined();
      expect(dispatch?.timeout).toBeLessThanOrEqual(10);
    }
  });
});

// RP-185: the wired `.codex/hooks.json` SessionStart command is the thing a
// real Codex session actually invokes — not a reimplementation of it. This
// runs the ACTUAL generated command (POSIX form, and its Windows
// `-EncodedCommand` counterpart) against a freshly `init`-ed project, so a
// change to inject-rules.mjs's stdout shape is caught here even if it never
// touches the string built into hooks.json. See
// docs/decisions/session-start-wire-format.md for the envelope both harnesses
// document.
describe('create-agent-rig init (the wired Codex SessionStart hook, end to end)', () => {
  /** Run an arbitrary shell command string with a stdin payload — the same
   *  shape Codex itself invokes a hook with, over the real wired command
   *  rather than a hand-rolled stand-in for it. */
  function runShellCommand(
    command: string,
    cwd: string,
    stdinPayload: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        '/bin/sh',
        ['-c', command],
        { cwd, env: gitEnv() },
        (error, stdout, stderr) => {
          const code = error ? ((error as { code?: number }).code ?? 1) : 0;
          resolve({ code, stdout, stderr });
        },
      );
      if (!child.stdin) return reject(new Error('no stdin'));
      child.stdin.write(stdinPayload);
      child.stdin.end();
    });
  }

  it('the wired .codex/hooks.json SessionStart command emits a JSON envelope on a freshly installed project', async (ctx) => {
    skipUnless(ctx, posixShellAvailable().ok, posixShellAvailable().reason);

    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runInit([])).code).toBe(0);
    // The wired command's first step is `git rev-parse --show-toplevel`, so
    // the installed project has to actually be a git repo for it to resolve.
    await exec('git', ['init', '-q'], { cwd: repo, env: gitEnv() });

    const config = JSON.parse(await readFile(path.join(repo, '.codex', 'hooks.json'), 'utf8')) as {
      hooks: {
        SessionStart: Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>;
      };
    };
    const sessionStartHooks = config.hooks.SessionStart.flatMap((group) => group.hooks);
    expect(sessionStartHooks).toHaveLength(1);
    const command = sessionStartHooks[0]!.command;

    for (const source of ['startup', 'resume', 'compact']) {
      const result = await runShellCommand(
        command,
        repo,
        JSON.stringify({ hook_event_name: 'SessionStart', source }),
      );
      expect(result.code, `${source}: ${result.stderr}`).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        hookSpecificOutput?: { hookEventName?: unknown; additionalContext?: unknown };
      };
      expect(parsed.hookSpecificOutput?.hookEventName, source).toBe('SessionStart');
      expect(parsed.hookSpecificOutput?.additionalContext, source).toContain('Tier 0');
    }
  });

  it('the Windows form of the wired SessionStart command emits the same JSON envelope', async (ctx) => {
    skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);

    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    expect((await runInit([])).code).toBe(0);
    await exec('git', ['init', '-q'], { cwd: repo, env: gitEnv() });

    const config = JSON.parse(await readFile(path.join(repo, '.codex', 'hooks.json'), 'utf8')) as {
      hooks: {
        SessionStart: Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>;
      };
    };
    const sessionStartHooks = config.hooks.SessionStart.flatMap((group) => group.hooks);
    expect(sessionStartHooks).toHaveLength(1);
    const commandWindows = sessionStartHooks[0]!.commandWindows;
    const encoded = commandWindows?.match(
      /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
    )?.[1];
    expect(
      encoded,
      `commandWindows did not match the expected shape: ${commandWindows}`,
    ).toBeDefined();

    for (const source of ['startup', 'resume', 'compact']) {
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded!],
            { cwd: repo, env: gitEnv() },
            (error, stdout, stderr) => {
              const code = error ? ((error as { code?: number }).code ?? 1) : 0;
              resolve({ code, stdout, stderr });
            },
          );
          if (!child.stdin) return reject(new Error('no stdin'));
          child.stdin.write(JSON.stringify({ hook_event_name: 'SessionStart', source }));
          child.stdin.end();
        },
      );
      expect(result.code, `${source}: ${result.stderr}`).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        hookSpecificOutput?: { hookEventName?: unknown; additionalContext?: unknown };
      };
      expect(parsed.hookSpecificOutput?.hookEventName, source).toBe('SessionStart');
      expect(parsed.hookSpecificOutput?.additionalContext, source).toContain('Tier 0');
    }
  });
});

// Running `init` inside a rig `create` produced is legitimate — someone
// refreshing the process layer by hand does exactly that. Since RP-177,
// `create` IS `init` run against a fresh directory, so a rig it produces
// today has `kind: 'init'` from the start and nothing distinguishes it from
// one `init` installed directly. The advisory this block covers is about a
// LEGACY rig — one a pre-0.10 `create` left with `kind: 'create'` in its
// manifest — which still exists in the wild and still deserves the "only
// fills gaps, use `upgrade`" warning `init` gives it.
describe('create-agent-rig init (inside a legacy rig `create` produced pre-0.10)', () => {
  const runCliIn = async (
    cwd: string,
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await exec(process.execPath, [cliBin, ...args], { cwd });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  };

  /** Every output line that carries the advisory — it is meant to be one. */
  const advisoryLines = (stdout: string): string[] =>
    stdout.split('\n').filter((line) => /created by create-agent-rig/i.test(line));

  /**
   * A repo shaped like a pre-0.10 `create` rig: a manifest recording
   * `kind: 'create'` and the stack overlays of that release, but no CLAUDE.md
   * — the way in `init`'s own refusal requires, since `--force` no longer is.
   */
  const plantLegacyCreateRig = async (): Promise<void> => {
    await mkdir(path.join(repo, '.claude'), { recursive: true });
    await writeFile(
      path.join(repo, '.claude', '.rig-manifest.json'),
      JSON.stringify({
        version: '0.9.1',
        kind: 'create',
        project: { name: 'my-app', scope: 'my-app', region: 'eu-central-1' },
        stacks: ['node-ts'],
        files: {},
      }),
    );
  };

  // `--force` used to be the way into a created rig. It is refused now, and
  // this is the only level that can see both halves of that: the message a
  // human reads, and the exit code a script branches on.
  it('refuses `--force` with the command that does refresh a rig, and exits non-zero', async () => {
    const project = path.join(repo, 'my-app');
    const generated = await runCliIn(repo, ['my-app', '--no-git']);
    expect(generated.code, generated.stderr).toBe(0);
    const claudeMd = await readFile(path.join(project, 'CLAUDE.md'), 'utf8');

    const forced = await runCliIn(project, ['init', '--force']);

    expect(forced.code).not.toBe(0);
    expect(`${forced.stdout}${forced.stderr}`).toContain(
      'deprecated — init --force replaced only CLAUDE.md; run create-agent-rig upgrade instead',
    );
    // and it wrote nothing — starting with the one file it used to replace
    expect(await readFile(path.join(project, 'CLAUDE.md'), 'utf8')).toBe(claudeMd);
  });

  it('points the operator at `upgrade` when it re-installs over a legacy create rig', async () => {
    await plantLegacyCreateRig();
    const forced = await runCliIn(repo, ['init']);
    expect(forced.code, forced.stderr).toBe(0);

    // recordInstall preserves `kind` rather than re-describing how the rig
    // was installed — still `create`, even after `init` ran inside it
    const manifest = JSON.parse(
      await readFile(path.join(repo, '.claude', '.rig-manifest.json'), 'utf8'),
    ) as { kind: string };
    expect(manifest.kind).toBe('create');
    expect(forced.stdout).toMatch(/Installed \d+ files/);

    const advisory = advisoryLines(forced.stdout);
    expect(advisory).toHaveLength(1);
    expect(advisory[0]).toMatch(/only fills gaps/i);
    expect(advisory[0]).toMatch(/upgrade/);
  });

  it('says nothing of the sort in a repo that has no rig at all', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    const result = await runCliIn(repo, ['init']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Installed \d+ files/);
    expect(advisoryLines(result.stdout)).toEqual([]);
    expect(result.stdout).not.toMatch(/use `?upgrade`? to refresh/i);
  });

  // The two tests above pin "never" and "over a create rig", which a condition
  // of merely `manifest !== null` also satisfies — and that condition would tell
  // every re-`init`ed rig it came from `create`. This is the case that separates
  // them.
  it('stays quiet when it re-installs over a rig `init` itself put there', async () => {
    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    const first = await runCliIn(repo, ['init']);
    expect(first.code, first.stderr).toBe(0);

    // The re-install needs a way past the CLAUDE.md refusal, and `--force` is no
    // longer one. Deleting it is what the refusal is actually about — the file,
    // not the flag — and it leaves the manifest this test reads untouched.
    await rm(path.join(repo, 'CLAUDE.md'));
    const second = await runCliIn(repo, ['init']);
    expect(second.code, second.stderr).toBe(0);

    // the fixture is what the test claims: a manifest exists, and it says `init`
    const manifest = JSON.parse(
      await readFile(path.join(repo, '.claude', '.rig-manifest.json'), 'utf8'),
    ) as { kind: string };
    expect(manifest.kind).toBe('init');
    expect(advisoryLines(second.stdout)).toEqual([]);
  });
});

// RP-182: a Rig file that already sits in the repo when `init` runs used to
// fall out of the manifest entirely — no `files` entry (init never overwrote
// it, correctly) and no record of any other kind. The manifest now classifies
// it under `kept`; a later `upgrade` still recognises released bytes through
// the hash history.
describe('create-agent-rig init over a pre-existing older Rig file (RP-182)', () => {
  const WORKFLOW_REL = '.claude/rules/workflow.md';
  // A real released copy of the file `init` installs at this path — 0.8.0,
  // token-free (a plain rules document carries no __PROJECT_NAME__ etc.), so
  // planting it verbatim is exactly what a repo pre-dating `init` looks like.
  const RELEASED_SHA = '870f9a3ecae2881908ece8ec3e2ac13f84f505f5';
  const RELEASED_PATH = 'templates/agent-os/universal/.claude/rules/workflow.md';

  const sha256 = (content: string): string =>
    createHash('sha256').update(content, 'utf8').digest('hex');

  const runCliIn = async (
    cwd: string,
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await exec(process.execPath, [cliBin, ...args], { cwd });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  };

  const releasedWorkflowMd = async (): Promise<string> => {
    const { stdout } = await exec('git', ['show', `${RELEASED_SHA}:${RELEASED_PATH}`], {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  };

  it('classifies the kept file in the manifest, and upgrade --dry-run reports it as an update', async () => {
    const older = await releasedWorkflowMd();
    // Premise: token-free, so nothing about substitution can make this
    // fixture wrong by accident.
    expect(older).not.toContain('__PROJECT_NAME__');
    expect(older.length).toBeGreaterThan(0);

    await writeFile(path.join(repo, 'package.json'), '{"name":"host"}');
    await mkdir(path.join(repo, '.claude', 'rules'), { recursive: true });
    await writeFile(path.join(repo, WORKFLOW_REL), older);

    const initResult = await runCliIn(repo, ['init']);
    expect(initResult.code, initResult.stderr).toBe(0);
    // init never overwrites a pre-existing path — still exactly what the
    // fixture planted
    expect(await readFile(path.join(repo, WORKFLOW_REL), 'utf8')).toBe(older);

    const manifest = JSON.parse(
      await readFile(path.join(repo, '.claude', '.rig-manifest.json'), 'utf8'),
    ) as { files: Record<string, string>; kept?: Record<string, string> };
    expect(manifest.kept?.[WORKFLOW_REL], JSON.stringify(manifest)).toBe(sha256(older));
    expect(manifest.files[WORKFLOW_REL]).toBeUndefined();

    const upgradeResult = await runCliIn(repo, ['upgrade', '--dry-run']);
    expect(upgradeResult.code, upgradeResult.stderr).toBe(0);

    // The planted bytes are a released version (their hash is in the shipped
    // hash history), so the report brings the file forward: a `~` line, the
    // update marker, for this path.
    const lines = upgradeResult.stdout.split('\n').map((l) => l.trim());
    expect(
      lines.some((l) => l.startsWith(`~ ${WORKFLOW_REL}`)),
      `no update line for ${WORKFLOW_REL}:\n${upgradeResult.stdout}`,
    ).toBe(true);
    expect(lines.some((l) => l.startsWith(`! ${WORKFLOW_REL}`))).toBe(false);
  });
});
