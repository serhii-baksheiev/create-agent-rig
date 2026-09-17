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
 * One allowed and one denied fixture per guard per harness — six of the seven
 * `PreToolUse`-wired guards, twenty-four executions. `guard-subagent-model`
 * (wired `PreToolUse` too, matcher `Agent`, Claude Code only) has its own
 * fixtures in `subagent-routing-hooks.test.ts` instead — the same
 * "own dedicated suite" pattern this file already uses for `guard-bash` and
 * `guard-rulebook`'s richer behaviour, not a gap. `gate-stop-dod` (`Stop`) and
 * `warn-subagent-routing` (`SessionStart`) are not `PreToolUse` at all and are
 * out of this file's scope entirely.
 *
 * The correspondence describe block at the end of this file is what keeps
 * that exception list from becoming a place to hide a real gap: it enumerates
 * every `PreToolUse` hook actually wired in `settings.json`/`hooks.json` and
 * requires each one to have either a fixture here or a listed, reasoned
 * exception, in both directions — a newly wired guard with neither, and a
 * fixture or exception naming something that turns out not to be wired, both
 * fail it. It also requires a `docs/compatibility.md` row for each.
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

const HOOK_FILE = /([\w-]+\.mjs)/;

/** Every distinct `<name>.mjs` a wiring declares under `event`, across every matcher group. */
function wiredHookFiles(wiring: HookWiring, event: string): Set<string> {
  const names = new Set<string>();
  for (const group of wiring.hooks[event] ?? []) {
    for (const hook of group.hooks) {
      const match = HOOK_FILE.exec(hook.command);
      if (match) names.add(match[1]!);
    }
  }
  return names;
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
        expect(deny.code, deny.stderr).toBe(2);
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
        expect(deny.code, deny.stderr).toBe(2);
      });
    });
  }
});

describe('guard-rulebook.mjs, run through the shipped wiring, on both harnesses', () => {
  // Unlike the fixtures above, this guard's decision depends on a flag file
  // under HOME rather than on the payload alone (`autonomy.md`, "Never" —
  // edit the rulebook from an unattended run outside the item's allow-list).
  // README.md is not one of `RULEBOOK_PREFIXES`
  // (`.claude/scripts/unattended-flag.mjs` — the one spelling of that list;
  // `autonomy.md` deliberately does not restate it, so this comment does not
  // either), so it is the allowed fixture even while unattended; a path under
  // `.claude/rules/` is one of those prefixes and is the denied fixture.
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
    expect(deny.code, deny.stderr).toBe(2);
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
    expect(deny.code, deny.stderr).toBe(2);
  });
});

/**
 * The one place this file's `FIXTURES` (plus the `guard-rulebook` describe
 * block above) are checked against the wiring itself, rather than assumed to
 * track it. Every `PreToolUse` hook wired in EITHER `settings.json` or
 * `hooks.json` must have a fixture here or a reasoned entry below — never
 * neither — and every `docs/compatibility.md` guard-table row must name a
 * hook file that still exists. Both directions are exercised: an
 * `it.each`-style pass over the real snapshot (a wired guard with nothing to
 * cover it fails "has a fixture or a documented exception"), and a pass over
 * what this file and the doc claim (a name that is not actually wired, or
 * not an existing hook file, fails the reverse checks).
 */
const ACCEPTANCE_EXCEPTIONS: Record<string, string> = {
  'guard-subagent-model.mjs':
    'Claude-only (matcher Agent; Codex has no Agent tool). Its allow/deny fixtures are in ' +
    'subagent-routing-hooks.test.ts, invoked against the hook file directly — the pattern this ' +
    "file already uses for guard-bash/guard-rulebook's richer behaviour, not a gap.",
};

describe("the PreToolUse wiring, this file's fixtures, and docs/compatibility.md name the same guards", () => {
  const fixturedHooks = new Set([...FIXTURES.map((f) => f.hookFile), 'guard-rulebook.mjs']);

  it('every PreToolUse hook wired in settings.json has a fixture here or a documented exception', () => {
    const wired = wiredHookFiles(claudeSettings, 'PreToolUse');
    const uncovered = [...wired].filter(
      (name) => !fixturedHooks.has(name) && !(name in ACCEPTANCE_EXCEPTIONS),
    );
    expect(uncovered, 'wired but neither fixtured nor excepted').toEqual([]);
  });

  it('every PreToolUse hook wired in hooks.json has a fixture here or a documented exception', () => {
    const wired = wiredHookFiles(codexHooks, 'PreToolUse');
    const uncovered = [...wired].filter(
      (name) => !fixturedHooks.has(name) && !(name in ACCEPTANCE_EXCEPTIONS),
    );
    expect(uncovered, 'wired but neither fixtured nor excepted').toEqual([]);
  });

  it('no fixture or exception names a guard that is not actually wired PreToolUse, on either harness', () => {
    const wired = new Set([
      ...wiredHookFiles(claudeSettings, 'PreToolUse'),
      ...wiredHookFiles(codexHooks, 'PreToolUse'),
    ]);
    const stale = [...fixturedHooks, ...Object.keys(ACCEPTANCE_EXCEPTIONS)].filter(
      (name) => !wired.has(name),
    );
    expect(stale, 'fixtured or excepted but not wired PreToolUse anywhere').toEqual([]);
  });

  it('docs/compatibility.md carries a guard-table row for every fixtured or excepted hook', async () => {
    const doc = await readFile(path.join(repoRoot, 'docs', 'compatibility.md'), 'utf8');
    const start = doc.indexOf('## Retained security guards');
    const end = doc.indexOf('\n## ', start + 1);
    expect(
      start,
      'docs/compatibility.md has no "## Retained security guards" section',
    ).toBeGreaterThanOrEqual(0);
    const section = doc.slice(start, end === -1 ? undefined : end);
    const missing = [...fixturedHooks, ...Object.keys(ACCEPTANCE_EXCEPTIONS)]
      .map((name) => name.replace(/\.mjs$/, ''))
      .filter((name) => !section.includes(`\`${name}\``));
    expect(missing, 'no compatibility.md row for these guards').toEqual([]);
  });

  it('every guard-table row in docs/compatibility.md names a hook file that still exists', async () => {
    const doc = await readFile(path.join(repoRoot, 'docs', 'compatibility.md'), 'utf8');
    const start = doc.indexOf('## Retained security guards');
    const end = doc.indexOf('\n## ', start + 1);
    const section = doc.slice(start, end === -1 ? undefined : end);
    const rowNames = [...section.matchAll(/^\| `([a-z-]+)`/gm)].map((m) => m[1]!);
    expect(rowNames.length, 'no guard rows found in the table').toBeGreaterThan(0);
    const hooksDir = path.join(universal, '.claude', 'hooks');
    const missingFiles: string[] = [];
    for (const name of rowNames) {
      try {
        await readFile(path.join(hooksDir, `${name}.mjs`));
      } catch {
        missingFiles.push(name);
      }
    }
    expect(missingFiles, 'compatibility.md names a guard with no hook file on disk').toEqual([]);
  });
});
