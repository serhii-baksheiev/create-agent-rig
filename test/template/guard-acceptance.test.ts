import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GITHUB_PAT } from './secrets-fixtures.js';
import { posixShellAvailable, skipUnless } from '../helpers/env.js';
import { removeFixture } from '../helpers/remove-fixture.js';

/**
 * RP-178. The compatibility matrix (`docs/compatibility.md`) claims each
 * retained guard is `SUPPORTED` on Claude Code and on Codex. A claim like
 * that is worth nothing unless something actually invokes the guard the way
 * the shipped wiring does — not the hook file directly (that is already
 * covered, file by file, in `hooks.test.ts`, `guard-bash.test.ts` and
 * `guard-rulebook.test.ts`), but the exact command string
 * `templates/agent-os/universal/.claude/settings.json` and
 * `templates/agent-os/universal/.codex/hooks.json` declare for it, run the way
 * each harness runs it: Claude Code substitutes `$CLAUDE_PROJECT_DIR` itself,
 * Codex's POSIX command resolves its own root with `git rev-parse
 * --show-toplevel` before ever naming the hook file.
 *
 * One allowed and one denied fixture per guard per harness — six guards,
 * twenty-four executions. `guard-subagent-model` and `gate-stop-dod` are
 * covered by their own dedicated suites (`subagent-routing.test.ts`,
 * `hooks.test.ts` › "gate-stop-dod hook") and are not duplicated here; the
 * first is wired for Claude Code only (`docs/compatibility.md` has that row),
 * and the second's fixture (a real `git status` plus `dod-checks.json`) does
 * not gain anything from being re-invoked through the wiring string.
 *
 * ⚠ Executed on POSIX only. Codex's `commandWindows` (base64 PowerShell) is
 * asserted present and non-empty here, not executed — this suite runs under
 * WSL/Linux, and the Windows-hosted lane in `e2e.yml` already exercises the
 * same underlying `.mjs` file on real Windows. That is a stated limit of this
 * file, not of the guard: the guard logic is one shared module either way.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');

interface HookEntry {
  command: string;
  commandWindows?: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
interface HookWiring {
  hooks: Record<string, HookGroup[]>;
}

async function loadWiring(file: string): Promise<HookWiring> {
  return JSON.parse(await readFile(file, 'utf8')) as HookWiring;
}

/** The one command string a harness's wiring declares for `hookFile` under `event`. */
function commandFor(wiring: HookWiring, event: string, hookFile: string): HookEntry {
  for (const group of wiring.hooks[event] ?? []) {
    const found = group.hooks.find((h) => h.command.includes(hookFile));
    if (found) return found;
  }
  throw new Error(`no ${event} hook wires ${hookFile}`);
}

interface Exit {
  code: number;
  stderr: string;
}

/** Run a wiring's exact POSIX command string as the harness runs it: through a shell, stdin JSON. */
function runWired(
  command: string,
  payload: object,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = execFile('/bin/sh', ['-c', command], { env, cwd }, (error, _stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr });
    });
    if (!child.stdin) return reject(new Error('no stdin'));
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

const write = (filePath: string, content: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: filePath, content },
});

const bash = (command: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
});

let home: string;
let claudeSettings: HookWiring;
let codexHooks: HookWiring;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'guard-acceptance-home-'));
  claudeSettings = await loadWiring(path.join(universal, '.claude', 'settings.json'));
  codexHooks = await loadWiring(path.join(universal, '.codex', 'hooks.json'));
});
afterEach(async () => {
  await removeFixture(home);
});

interface Fixture {
  hookFile: string;
  event: 'PreToolUse';
  allowed: object;
  denied: object;
  /** Extra env beyond HOME (and, for Claude, CLAUDE_PROJECT_DIR). */
  env?: Record<string, string>;
}

const CORE_FILE = 'packages/core/src/note.ts';
const WEB_FILE = 'apps/web/src/app/page.tsx';

const FIXTURES: Fixture[] = [
  {
    hookFile: 'guard-core-purity.mjs',
    event: 'PreToolUse',
    allowed: write(CORE_FILE, "import { z } from 'zod';\nexport const x = z.string();\n"),
    denied: write(CORE_FILE, "import { readFile } from 'node:fs/promises';\n"),
  },
  {
    hookFile: 'guard-web-boundary.mjs',
    event: 'PreToolUse',
    allowed: write(WEB_FILE, "import { NewNoteSchema } from '@app/core';\n"),
    denied: write(WEB_FILE, "import { NoteModel } from '@app/db';\n"),
  },
  {
    hookFile: 'guard-secret-file.mjs',
    event: 'PreToolUse',
    allowed: write('notes/ideas.md', '# ideas\n\nnothing sensitive here.\n'),
    denied: write('notes/ideas.md', `token = "${GITHUB_PAT}"\n`),
  },
  {
    hookFile: 'block-no-verify.mjs',
    event: 'PreToolUse',
    allowed: bash('git commit -m "ordinary commit"'),
    denied: bash('git commit --no-verify -m "bypass"'),
  },
  {
    hookFile: 'guard-bash.mjs',
    event: 'PreToolUse',
    allowed: bash('git status'),
    denied: bash('git push --force origin master'),
  },
];

describe('every retained PreToolUse guard, run through the shipped wiring, on both harnesses', () => {
  for (const fixture of FIXTURES) {
    describe(fixture.hookFile, () => {
      it('is wired under PreToolUse in both settings.json and hooks.json', () => {
        expect(() => commandFor(claudeSettings, 'PreToolUse', fixture.hookFile)).not.toThrow();
        expect(() => commandFor(codexHooks, 'PreToolUse', fixture.hookFile)).not.toThrow();
      });

      it('Claude Code wiring: allows the allowed fixture and blocks the denied one', async (ctx) => {
        const posix = posixShellAvailable();
        skipUnless(ctx, posix.ok, posix.reason);
        const entry = commandFor(claudeSettings, 'PreToolUse', fixture.hookFile);
        const env = {
          ...process.env,
          ...fixture.env,
          HOME: home,
          CLAUDE_PROJECT_DIR: repoRoot,
        };
        const allow = await runWired(entry.command, fixture.allowed, env, repoRoot);
        expect(allow.code, allow.stderr).toBe(0);
        const deny = await runWired(entry.command, fixture.denied, env, repoRoot);
        expect(deny.code, deny.stderr).not.toBe(0);
      });

      it('Codex wiring: allows the allowed fixture and blocks the denied one, and declares a Windows command too', async (ctx) => {
        const entry = commandFor(codexHooks, 'PreToolUse', fixture.hookFile);
        expect(typeof entry.commandWindows, 'a Windows command string').toBe('string');
        expect((entry.commandWindows ?? '').length).toBeGreaterThan(0);

        const posix = posixShellAvailable();
        skipUnless(ctx, posix.ok, posix.reason);
        const env = { ...process.env, ...fixture.env, HOME: home };
        const allow = await runWired(entry.command, fixture.allowed, env, repoRoot);
        expect(allow.code, allow.stderr).toBe(0);
        const deny = await runWired(entry.command, fixture.denied, env, repoRoot);
        expect(deny.code, deny.stderr).not.toBe(0);
      });
    });
  }
});

describe('guard-rulebook.mjs, run through the shipped wiring, on both harnesses', () => {
  // Unlike the fixtures above, this guard's decision depends on a flag file
  // under HOME rather than on the payload alone (`autonomy.md`, "Never" —
  // edit the rulebook from an unattended run outside the item's allow-list).
  // README.md is not part of the rulebook (`autonomy.md` names it exactly:
  // hooks, settings, rules, skills, agents, the queue adapter, `.codex/`, the
  // integrity manifest, `.claude/doctor-exemptions.json`, `AGENTS.md` and
  // `CLAUDE.md`), so it is the allowed fixture even while unattended; a rule
  // file is the denied one.
  const allowed = write('README.md', '# create-agent-rig\n');
  const denied = write('.claude/rules/architecture.md', '# tampered\n');

  async function arm(root: string): Promise<void> {
    // The wired commands below run THIS repository's own installed
    // `.claude/hooks/guard-rulebook.mjs` (dogfooded from `universal`, with
    // `__PROJECT_NAME__` substituted to `create-agent-rig`) — not the
    // template source. The flag path must be computed the same way the
    // running hook computes it, so this loads the installed copy of
    // `unattended-flag.mjs` too, rather than the unsubstituted template one.
    const { unattendedFlags } = (await import(
      pathToFileURL(path.join(repoRoot, '.claude', 'scripts', 'unattended-flag.mjs')).href
    )) as { unattendedFlags: (env: NodeJS.ProcessEnv) => string[] };
    const flag = unattendedFlags({ HOME: home, CLAUDE_PROJECT_DIR: root })[0]!;
    await mkdir(path.dirname(flag), { recursive: true });
    await writeFile(
      flag,
      JSON.stringify({
        item: 'guard-acceptance',
        runDir: path.join(home, '.rig-run'),
        allow: [],
      }),
    );
  }

  it('Claude Code wiring: allows README.md and blocks a rule file while unattended', async (ctx) => {
    const posix = posixShellAvailable();
    skipUnless(ctx, posix.ok, posix.reason);
    await arm(repoRoot);
    const entry = commandFor(claudeSettings, 'PreToolUse', 'guard-rulebook.mjs');
    const env = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: repoRoot };
    const allow = await runWired(entry.command, allowed, env, repoRoot);
    expect(allow.code, allow.stderr).toBe(0);
    const deny = await runWired(entry.command, denied, env, repoRoot);
    expect(deny.code, deny.stderr).not.toBe(0);
  });

  it('Codex wiring: allows README.md and blocks a rule file while unattended, and declares a Windows command too', async (ctx) => {
    const entry = commandFor(codexHooks, 'PreToolUse', 'guard-rulebook.mjs');
    expect((entry.commandWindows ?? '').length).toBeGreaterThan(0);
    const posix = posixShellAvailable();
    skipUnless(ctx, posix.ok, posix.reason);
    await arm(repoRoot);
    const env = { ...process.env, HOME: home };
    const allow = await runWired(entry.command, allowed, env, repoRoot);
    expect(allow.code, allow.stderr).toBe(0);
    const deny = await runWired(entry.command, denied, env, repoRoot);
    expect(deny.code, deny.stderr).not.toBe(0);
  });
});
