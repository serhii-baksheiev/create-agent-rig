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
 * the shipped wiring does — not the hook file directly (that is covered, file
 * by file, in `hooks.test.ts`, `guard-bash.test.ts`, `guard-rulebook.test.ts`
 * and `guard-secret-file.test.ts`), but the exact command string
 * `templates/agent-os/universal/.claude/settings.json` and
 * `templates/agent-os/universal/.codex/hooks.json` declare for it, run the way
 * each harness runs it: Claude Code substitutes `$CLAUDE_PROJECT_DIR` itself,
 * Codex's POSIX command resolves its own root with `git rev-parse
 * --show-toplevel` before ever naming the hook file.
 *
 * One allowed and one denied fixture per guard per harness, and the denied
 * fixture must exit exactly 2 — the code both harnesses read as "blocked".
 * A guard that exists in the wiring but has no fixture here must be a listed,
 * reasoned exception; the correspondence block at the end of this file derives
 * the wired set from the two wiring files, so a newly wired guard with neither
 * fails it without anyone updating a count.
 *
 * The commands run this repository's dogfooded `.claude/hooks/*` copies, not
 * the template files; the two are held byte-identical by `dogfood.test.ts` ›
 * "CLAUDE.md and .claude/ are in sync with templates/agent-os".
 *
 * ⚠ Executed on POSIX only. On Windows every execution below skips through
 * `posixShellAvailable`, and the Codex cases assert only that a
 * `commandWindows` string is present — which is wiring, not execution.
 * `docs/compatibility.md`, "Platforms", states which Windows commands some
 * other test does execute and marks the rest UNVERIFIED.
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

/** The patch Codex sends for an edit: its editing tool is `apply_patch`, not `Write`. */
const applyPatch = (header: string, addition: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'apply_patch',
  tool_input: {
    command: ['*** Begin Patch', header, '@@', `+${addition}`, '*** End Patch', ''].join('\n'),
  },
});

/** A Claude Code `Agent` dispatch, the payload shape `guard-subagent-model` judges. */
const agent = (toolInput: Record<string, unknown>) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_input: { description: 'fixture dispatch', prompt: 'review the change', ...toolInput },
});

interface Case {
  allowed: object;
  denied: object;
}

interface Fixture {
  hookFile: string;
  /**
   * One allowed and one denied payload per harness whose wiring carries the
   * guard, each in the shape that harness sends. A harness left out must not
   * wire the guard — the first case below asserts that too.
   */
  claude: Case;
  codex?: Case;
  /** What the refusal says, so a deny for the wrong reason is not a pass. */
  reason: RegExp;
}

const FIXTURES: Fixture[] = [
  {
    hookFile: 'guard-secret-file.mjs',
    claude: {
      allowed: write('notes/ideas.md', '# ideas\n\nnothing sensitive here.\n'),
      denied: write('notes/ideas.md', `token = "${GITHUB_PAT}"\n`),
    },
    codex: {
      allowed: applyPatch('*** Add File: notes/ideas.md', '# ideas'),
      denied: applyPatch('*** Add File: notes/ideas.md', `token = "${GITHUB_PAT}"`),
    },
    reason: /credential/i,
  },
  {
    hookFile: 'block-no-verify.mjs',
    claude: {
      allowed: bash('git commit -m "ordinary commit"'),
      denied: bash('git commit --no-verify -m "bypass"'),
    },
    codex: {
      allowed: bash('git commit -m "ordinary commit"'),
      denied: bash('git commit --no-verify -m "bypass"'),
    },
    reason: /pre-commit/i,
  },
  {
    hookFile: 'guard-bash.mjs',
    claude: { allowed: bash('git status'), denied: bash('git push --force origin master') },
    codex: { allowed: bash('git status'), denied: bash('git push --force origin master') },
    reason: /force/i,
  },
  {
    // Claude-only: Codex has no `Agent` tool, and its projection does not wire
    // this guard. The pin it defends is this repository's own
    // `.claude/agents/code-reviewer.md` frontmatter `model:`.
    hookFile: 'guard-subagent-model.mjs',
    claude: {
      allowed: agent({ subagent_type: 'code-reviewer' }),
      denied: agent({ subagent_type: 'code-reviewer', model: 'haiku' }),
    },
    reason: /without .?model/i,
  },
];

describe('every retained PreToolUse guard, run through the shipped wiring of each harness that carries it', () => {
  for (const fixture of FIXTURES) {
    describe(fixture.hookFile, () => {
      it('is wired under PreToolUse exactly on the harnesses that have a fixture', () => {
        expect(() => commandFor(claudeSettings, 'PreToolUse', fixture.hookFile)).not.toThrow();
        if (fixture.codex) {
          expect(() => commandFor(codexHooks, 'PreToolUse', fixture.hookFile)).not.toThrow();
        } else {
          expect(wiredHookFiles(codexHooks, 'PreToolUse').has(fixture.hookFile)).toBe(false);
        }
      });

      it('Claude Code wiring: allows the allowed fixture and blocks the denied one', async (ctx) => {
        const posix = posixShellAvailable();
        skipUnless(ctx, posix.ok, posix.reason);
        const entry = commandFor(claudeSettings, 'PreToolUse', fixture.hookFile);
        const env = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: repoRoot };
        const allow = await runWired(entry.command, fixture.claude.allowed, env, repoRoot);
        expect(allow.code, allow.stderr).toBe(0);
        const deny = await runWired(entry.command, fixture.claude.denied, env, repoRoot);
        expect(deny.code, deny.stderr).toBe(2);
        expect(deny.stderr).toMatch(fixture.reason);
      });

      if (fixture.codex) {
        const codex = fixture.codex;
        it('Codex wiring: allows the allowed fixture and blocks the denied one, and declares a Windows command too', async (ctx) => {
          const entry = commandFor(codexHooks, 'PreToolUse', fixture.hookFile);
          expect(typeof entry.commandWindows, 'a Windows command string').toBe('string');
          expect((entry.commandWindows ?? '').length).toBeGreaterThan(0);

          const posix = posixShellAvailable();
          skipUnless(ctx, posix.ok, posix.reason);
          const env = { ...process.env, HOME: home };
          const allow = await runWired(entry.command, codex.allowed, env, repoRoot);
          expect(allow.code, allow.stderr).toBe(0);
          const deny = await runWired(entry.command, codex.denied, env, repoRoot);
          expect(deny.code, deny.stderr).toBe(2);
          expect(deny.stderr).toMatch(fixture.reason);
        });
      }
    });
  }
});

describe('guard-rulebook.mjs, run through the shipped wiring, on both harnesses', () => {
  // Unlike the fixtures above, this guard's decision depends on a flag file
  // under HOME rather than on the payload alone (`autonomy.md`, "Never" —
  // edit the rulebook from an unattended run outside the item's allow-list).
  // Which path is inside the rulebook is `isRulebookPath`'s answer, asserted
  // below rather than restated here.
  const allowedPath = 'README.md';
  const deniedPath = '.claude/rules/workflow.md';
  const allowed = write(allowedPath, '# create-agent-rig\n');
  const denied = write(deniedPath, '# tampered\n');
  // Codex edits through apply_patch, so its fixtures are patches to the same two paths.
  const codexAllowed = applyPatch(`*** Update File: ${allowedPath}`, '# create-agent-rig');
  const codexDenied = applyPatch(`*** Update File: ${deniedPath}`, '# tampered');
  const reason = /rulebook|unattended/i;

  it('picks one path outside the rulebook and one inside it, by the module that decides', async () => {
    const { isRulebookPath } = (await import(
      pathToFileURL(path.join(repoRoot, '.claude', 'scripts', 'unattended-flag.mjs')).href
    )) as { isRulebookPath: (rel: string) => boolean };
    expect(isRulebookPath(allowedPath)).toBe(false);
    expect(isRulebookPath(deniedPath)).toBe(true);
  });

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
    expect(deny.stderr).toMatch(reason);
  });

  it('Codex wiring: allows README.md and blocks a rule file while unattended, and declares a Windows command too', async (ctx) => {
    const entry = commandFor(codexHooks, 'PreToolUse', 'guard-rulebook.mjs');
    expect((entry.commandWindows ?? '').length).toBeGreaterThan(0);
    const posix = posixShellAvailable();
    skipUnless(ctx, posix.ok, posix.reason);
    await arm(repoRoot);
    const env = { ...process.env, HOME: home };
    const allow = await runWired(entry.command, codexAllowed, env, repoRoot);
    expect(allow.code, allow.stderr).toBe(0);
    const deny = await runWired(entry.command, codexDenied, env, repoRoot);
    expect(deny.code, deny.stderr).toBe(2);
    expect(deny.stderr).toMatch(reason);
  });
});

/**
 * The one place this file's `FIXTURES` (plus the `guard-rulebook` describe
 * block above) are checked against the wiring itself, rather than assumed to
 * track it. Every `PreToolUse` hook wired in EITHER `settings.json` or
 * `hooks.json` must have a fixture here or a reasoned entry below — never
 * neither — every hook wired under any event must have a
 * `docs/compatibility.md` row, and every row must name a hook file that
 * still exists. Both directions are exercised: an
 * `it.each`-style pass over the real snapshot (a wired guard with nothing to
 * cover it fails "has a fixture or a documented exception"), and a pass over
 * what this file and the doc claim (a name that is not actually wired, or
 * not an existing hook file, fails the reverse checks).
 */
// Empty today: every wired PreToolUse guard is executed above. An entry here
// names a guard this file cannot execute through its wiring, and the reason.
const ACCEPTANCE_EXCEPTIONS: Record<string, string> = {};

async function guardSection(): Promise<string> {
  const doc = await readFile(path.join(repoRoot, 'docs', 'compatibility.md'), 'utf8');
  const start = doc.indexOf('## Retained guards and hooks');
  expect(
    start,
    'docs/compatibility.md has no "## Retained guards and hooks" section',
  ).toBeGreaterThan(-1);
  const end = doc.indexOf('\n## ', start + 1);
  return doc.slice(start, end === -1 ? undefined : end);
}

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

  it('docs/compatibility.md carries a row for every hook wired under any event, on either harness', async () => {
    const section = await guardSection();
    const wired = new Set<string>();
    for (const wiring of [claudeSettings, codexHooks]) {
      for (const event of Object.keys(wiring.hooks)) {
        for (const name of wiredHookFiles(wiring, event)) wired.add(name);
      }
    }
    expect(wired.size, 'no hooks found in either wiring file').toBeGreaterThan(0);
    const missing = [...wired]
      .map((name) => name.replace(/\.mjs$/, ''))
      .filter((name) => !section.includes(`| \`${name}\``));
    expect(missing, 'no compatibility.md row for these wired hooks').toEqual([]);
  });

  it('every guard-table row in docs/compatibility.md names a hook file that still exists', async () => {
    const section = await guardSection();
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
