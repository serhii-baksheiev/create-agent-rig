import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gitEnv as withoutGitLocation } from '../../packages/cli/src/lib/git-env.js';
import { describe, expect, it } from 'vitest';
import {
  fifosAvailable,
  needsGitRoot,
  onlyOnWindows,
  posixShellAvailable,
  skipUnless,
} from '../helpers/env.js';
import { removeFixture } from '../helpers/remove-fixture.js';
import { CLOUD_ACCESS_KEY } from './secrets-fixtures.js';

// 🔴 A `git` spawned from a test inherits the same GIT_DIR a hook exports, so
// `git init` under pre-commit re-initialises THIS repository rather than the
// scratch directory — measured: it flipped the checkout to `core.bare=true`,
// silently, while the suite stayed green. `git-env.mjs` is the one
// implementation and its own header says a new git spawn belongs on the sweep's
// list the day it is written; both are on it, and the `env` is spelled out at
// each call rather than hidden behind a named object, because the sweep reads
// the call's own option window.
const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const agentOs = path.join(repoRoot, 'templates', 'agent-os');
const universal = path.join(agentOs, 'universal');
const hooksDir = path.join(universal, '.claude', 'hooks');

const text = (...parts: string[]) => readFile(path.join(...parts), 'utf8');

// RP-162: the one case below that starts Windows PowerShell carries its own
// budget. Measured on the hosted windows-unit runner, same code, four runs:
// 817 / 3 747 / 6 794 ms and a timeout at the template project's 15 000 ms.
// Per step, on one Windows host, the generated wrapper's round trip
// (powershell.exe → git rev-parse → node guard) took 1.7–4.7 s idle and
// 7–15 s under load, completing with the right verdict every time. Its
// irreducible content is that one powershell.exe start — everything else the
// case does is about 5 % of its wall time — so the figure moves for this case
// and not for the file. The siblings do not share the exposure: the POSIX twin
// drives /bin/sh, which starts in milliseconds, and is skipped on Windows; the
// sync check and the 57 apply_patch cases spawn node directly and ran at
// 60–140 ms in the same red run. Pinned in vitest-timeouts.test.ts › "carries its own
// budget, declared once by name and passed as that case's options", › "is
// bounded above so a genuine hang still fails within a minute, and sits above
// the lane budget it replaces" and › "is the only case in that file with a
// budget of its own — the figure moves for one case, not for the file".
const WINDOWS_POWERSHELL_CASE_TIMEOUT_MS = 60_000;

// RP-266: the Windows wrapper for these four guards HAD three unbounded
// waits (`git rev-parse --show-toplevel`, the stdin copy, `$child.WaitForExit()`)
// and no `timeout` anywhere, so a host stall on any of them ended only at the
// harness's own default hook timeout — which
// `docs/decisions/fail-open-guards.md:27` records resolves to ALLOW, not a
// block. Round 1 (PR #353) bounded each stage, but code-reviewer and
// security-scanner both found it still fails open: every `taskkill … | Out-Null`
// runs under `$ErrorActionPreference = 'Stop'`, and PS 5.1 turns any stderr
// line from an already-exited process into a terminating error the wrapper
// never catches, so a guard that exits moments AFTER its bound gets exit 1
// (non-blocking) instead of the wrapper's own exit 2. This round (round 2 of
// PR #353) hardens that kill, tightens the override the earlier round left
// "shaped for a regex" (duplicated per-stage if/else branches), and moves the
// hooks.json `timeout` here — never into `.claude/settings.json`, which would
// shorten Claude Code's own 600 s default kill point instead.
const BOUNDED_STAGE_GUARDS = [
  'guard-secret-file.mjs',
  'guard-rulebook.mjs',
  'block-no-verify.mjs',
  'guard-bash.mjs',
];

describe('Codex adapter is generated from the Claude Code Agent OS', () => {
  it('is in sync with its Claude Code sources', async () => {
    await expect(
      exec(process.execPath, [path.join(repoRoot, 'scripts', 'sync-codex-adapter.mjs'), '--check']),
    ).resolves.toBeTruthy();
  });

  // RP-24: on macOS the checkout sat behind a symlink (/var → /private/var),
  // Node resolved the main module through it, argv[1] did not, and the check
  // exited 0 having run nothing. A silent pass is indistinguishable from that,
  // so the check says what it verified and is started here through a link.
  it('runs its check when started through a symlinked checkout, and says so', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'rig-codex-link-'));
    const linked = path.join(outside, 'checkout');
    try {
      await symlink(repoRoot, linked, process.platform === 'win32' ? 'junction' : 'dir');
      const { stdout } = await exec(process.execPath, [
        path.join(linked, 'scripts', 'sync-codex-adapter.mjs'),
        '--check',
      ]);
      expect(stdout).toMatch(/Codex adapter is in sync/);
    } finally {
      // The link alone, never recursively: a recursive removal through it
      // would reach the checkout it points at.
      await rm(linked, { force: true });
      await removeFixture(outside);
    }
  });

  // RP-186: AGENTS.md is the canonical, provider-neutral rulebook and
  // CLAUDE.md is a short compatibility shim that imports it — they are no
  // longer byte-identical, and this replaces the identity check that used to
  // stand here.
  it.each(['universal'])(
    '%s: AGENTS.md is canonical, CLAUDE.md is its import shim',
    async (layer) => {
      const dir = path.join(agentOs, layer);
      const agentsMd = await text(dir, 'AGENTS.md');
      const claudeMd = await text(dir, 'CLAUDE.md');
      expect(agentsMd).toMatch(/Claude Code and Codex/);
      expect(agentsMd).toContain('## One operating system, two harnesses');
      expect(agentsMd).toContain('```elevated-paths');

      // PR #241 round 2 advisory: the shim's own FIRST LINE must be exactly
      // `@AGENTS.md` — `startsWith` alone would also pass a line like
      // `@AGENTS.md-ish` or one with trailing text on the same line, neither
      // of which is Claude Code's import syntax.
      expect(claudeMd.split(/\r?\n/, 1)[0]).toBe('@AGENTS.md');

      // A literal list of AGENTS.md's own section headings, not derived from
      // AGENTS.md's content — the shim must contain NONE of them, so a
      // regression that copies even one section back in is caught, not just
      // the one heading a single `.not.toContain` would have watched.
      const CANONICAL_SECTION_HEADINGS = [
        '## One operating system, two harnesses',
        '## What was installed here, and what was not',
        '## If you read only three sections, read these',
        '## How work happens here',
        '## The opt-in workflow layer (experimental)',
        '## Four things this install left for you to finish',
        '## The elevated paths of this project',
        '## Foot-guns',
      ];
      for (const heading of CANONICAL_SECTION_HEADINGS) {
        expect(claudeMd, `shim must not restate "${heading}"`).not.toContain(heading);
      }
      expect(claudeMd).not.toContain('```elevated-paths');
      expect(claudeMd.length).toBeLessThan(2000);
    },
  );

  it('publishes every shared skill through the Codex repository skill location', async () => {
    const claudeSkills = await readdir(path.join(universal, '.claude', 'skills'));
    const codexSkills = await readdir(path.join(universal, '.agents', 'skills'));
    expect(codexSkills.sort()).toEqual(claudeSkills.sort());

    for (const skill of claudeSkills) {
      await expect(text(universal, '.agents', 'skills', skill, 'SKILL.md')).resolves.toBe(
        await text(universal, '.claude', 'skills', skill, 'SKILL.md'),
      );
    }
  });

  it('publishes every Claude agent as a project-scoped Codex custom agent', async () => {
    const claudeAgents = (await readdir(path.join(universal, '.claude', 'agents'))).map((name) =>
      name.replace(/\.md$/, ''),
    );
    const codexAgents = (await readdir(path.join(universal, '.codex', 'agents'))).map((name) =>
      name.replace(/\.toml$/, ''),
    );
    expect(codexAgents.sort()).toEqual(claudeAgents.sort());

    for (const agent of codexAgents) {
      const profile = await text(universal, '.codex', 'agents', `${agent}.toml`);
      expect(profile).toContain(`name = "${agent}"`);
      expect(profile).toMatch(/^description = ".+"$/m);
      expect(profile).toMatch(/^developer_instructions = /m);
      if (agent !== 'test-writer' && agent !== 'implementation-agent')
        expect(profile).toContain('sandbox_mode = "read-only"');
    }
  });

  it('routes every named Codex agent to its role-specific model and reasoning effort', async () => {
    const expected = new Map([
      ['universal/test-writer', ['gpt-5.6-terra', 'high']],
      ['universal/implementation-agent', ['gpt-5.6-terra', 'high']],
      ['universal/prose-reviewer', ['gpt-5.6-terra', 'high']],
      ['universal/code-reviewer', ['gpt-6-sol', 'high']],
      ['universal/security-scanner', ['gpt-6-sol', 'high']],
      ['universal/failure-diagnostician', ['gpt-6-sol', 'high']],
    ]);

    for (const [profile, [model, effort]] of expected) {
      const [layer, ...parts] = profile.split('/');
      const name = parts.pop()!;
      const dir = path.join(agentOs, layer!);
      const source = await text(dir, '.codex', 'agents', `${name}.toml`);
      expect(source).toContain(`model = "${model}"`);
      expect(source).toContain(`model_reasoning_effort = "${effort}"`);
    }
  });

  it('gives unnamed Codex subagents balanced repository defaults without pinning capacity', async () => {
    const config = await text(universal, '.codex', 'config.toml');
    expect(config).toContain('[agents]');
    expect(config).toContain('default_subagent_model = "gpt-5.6-terra"');
    expect(config).toContain('default_subagent_reasoning_effort = "medium"');
    expect(config).not.toMatch(/max_concurrent|thread/i);
  });

  it.each([
    [
      'a missing named profile',
      { default: { model: 'm', effort: 'medium' }, agents: {} },
      [{ name: 'reviewer', source: 'reviewer.md' }],
      /missing for reviewer/,
    ],
    [
      'an orphan named profile',
      {
        default: { model: 'm', effort: 'medium' },
        agents: { orphan: { model: 'm', effort: 'high' } },
      },
      [],
      /no source agent: orphan/,
    ],
    [
      'a duplicate source-agent name',
      {
        default: { model: 'm', effort: 'medium' },
        agents: { reviewer: { model: 'm', effort: 'high' } },
      },
      [
        { name: 'reviewer', source: 'a.md' },
        { name: 'reviewer', source: 'b.md' },
      ],
      /duplicated across layers: reviewer/,
    ],
    [
      'an invalid reasoning effort',
      { default: { model: 'm', effort: 'turbo' }, agents: {} },
      [],
      /unsupported effort: turbo/,
    ],
  ])('refuses %s in the closed Codex agent policy', async (_case, policy, agents, message) => {
    const { validateAgentProfiles } = (await import(
      pathToFileURL(path.join(repoRoot, 'scripts', 'sync-codex-adapter.mjs')).href
    )) as {
      validateAgentProfiles: (
        policy: unknown,
        sourceAgents: Array<{ name: string; source: string }>,
      ) => unknown;
    };

    expect(() => validateAgentProfiles(policy, agents)).toThrow(message);
  });

  it('wires native Codex hooks with portable commands and apply_patch coverage', async () => {
    const config = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
      hooks: Record<
        string,
        Array<{
          matcher?: string;
          hooks: Array<{ command: string; commandWindows?: string }>;
        }>
      >;
    };
    const editGroup = config.hooks.PreToolUse?.find((group) =>
      group.matcher?.includes('apply_patch'),
    );
    // RP-65: the shell guards cover an enumerated SET of shell tools now
    // (.claude/scripts/lib/shell-tools.mjs), so this asserts that Bash is among
    // them rather than that it is the only one.
    expect(
      config.hooks.PreToolUse?.some((group) => (group.matcher ?? '').split('|').includes('Bash')),
    ).toBe(true);
    expect(config.hooks.Stop).toHaveLength(1);
    expect(config.hooks.SessionStart).toHaveLength(1);
    expect(editGroup).toBeDefined();
    expect(editGroup?.hooks.some((hook) => hook.command.includes('guard-secret-file.mjs'))).toBe(
      true,
    );
    for (const groups of Object.values(config.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          expect(hook.command).toContain('git rev-parse --show-toplevel');
          expect(hook.commandWindows).not.toBe(hook.command);
          const windowsCommand = hook.commandWindows?.match(
            /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
          );
          expect(windowsCommand).toBeDefined();
          const windowsScript = Buffer.from(windowsCommand?.[1] ?? '', 'base64').toString(
            'utf16le',
          );
          expect(windowsScript).toContain('git rev-parse --show-toplevel');
          expect(windowsScript).toMatch(
            /Join-Path \$repoRoot '\.claude\/hooks\/[A-Za-z0-9._-]+\.mjs'/,
          );
          expect(hook.command).toContain('CLAUDE_PROJECT_DIR');
          expect(windowsScript).toContain('$env:CLAUDE_PROJECT_DIR = $repoRoot');
          expect(windowsScript).toContain('$startInfo.RedirectStandardInput = $true');
          // RP-266: the four bounded guards (BOUNDED_STAGE_GUARDS) copy stdin
          // through a bounded `CopyToAsync(...).Wait(...)` instead — pinned by
          // the RP-266 cases below, not here.
          const hookFile = hook.command.match(/\.claude\/hooks\/([A-Za-z0-9._-]+\.mjs)/)?.[1];
          if (!BOUNDED_STAGE_GUARDS.includes(hookFile ?? '')) {
            expect(windowsScript).toContain(
              '[Console]::OpenStandardInput().CopyTo($child.StandardInput.BaseStream)',
            );
          }
          expect(windowsScript).toContain('exit $child.ExitCode');
          // `command` is what Codex executes on macOS and Linux. Keep it valid
          // for the platform-provided POSIX shell and independent of GNU tools.
          expect(hook.command).toMatch(/node [^\n]*\.claude\/hooks\/[A-Za-z0-9._-]+\.mjs/);
          expect(hook.command).not.toMatch(/powershell|cmd\.exe|%CD%|\\/i);
        }
      }
    }
  });

  it.each(BOUNDED_STAGE_GUARDS)(
    'bounds every Windows wrapper stage for %s, kills the process tree on expiry, and names the timed-out stage (RP-266)',
    async (guardFile) => {
      const config = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
        hooks: Record<
          string,
          Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>
        >;
      };
      const entry = Object.values(config.hooks)
        .flatMap((groups) => groups.flatMap((group) => group.hooks))
        .find((hook) => hook.command.includes(guardFile));
      expect(entry, `${guardFile} has no projected Codex hook entry`).toBeDefined();

      const encoded = entry?.commandWindows?.match(
        /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
      )?.[1];
      expect(encoded, `${guardFile}'s commandWindows is not an EncodedCommand`).toBeDefined();
      const windowsScript = Buffer.from(encoded ?? '', 'base64').toString('utf16le');

      // Both the `git rev-parse --show-toplevel` stage and the child's own
      // run must carry a bound — `WaitForExit()` with no argument (today's
      // shape) waits forever.
      const boundedWaits = windowsScript.match(/WaitForExit\(\s*[^)\s][^)]*\)/g) ?? [];
      expect(
        boundedWaits.length,
        `expected a bounded WaitForExit(<ms>) for both the git stage and the child stage in:\n${windowsScript}`,
      ).toBeGreaterThanOrEqual(2);

      expect(
        windowsScript,
        'the stdin copy must be bounded (CopyToAsync(...).Wait(T)), not a bare synchronous CopyTo',
      ).toMatch(/CopyToAsync\([^)]*\)[\s\S]{0,80}\.Wait\(/);

      // invariants.md: a crossed bound blocks and names the limit — here that
      // means killing the whole tree, not just the immediate process.
      expect(windowsScript, 'a crossed bound must kill the whole process tree').toContain(
        'taskkill',
      );
      expect(windowsScript).toMatch(/\/T\b/);
      expect(windowsScript).toMatch(/\/F\b/);

      expect(
        windowsScript,
        'a crossed bound must write the stage and its budget to stderr and exit 2',
      ).toMatch(/codex wrapper: [^"'\n]*timed out after [^"'\n]*/i);
      expect(windowsScript).toMatch(/exit\s+2\b/);
    },
  );

  // PR #353 round 1 blocker (code-reviewer, security-scanner): every kill
  // ran `taskkill … 2>$null | Out-Null` directly under
  // `$ErrorActionPreference = 'Stop'`. In PS 5.1 any stderr line from
  // taskkill — the process already exited, or a tree member vanished, both
  // ordinary once the timeout has genuinely fired — is a terminating
  // NativeCommandError the wrapper never caught, so it exited 1. Codex
  // treats exit 1 as non-blocking: fail open. Reproduced 5/6 and 6/8 with a
  // guard that exits ~0.1–0.6 s after the bound (behavioural repro in
  // test/template/codex-wrapper-bounds.test.ts).
  it.each(BOUNDED_STAGE_GUARDS)(
    "wraps every kill in %s's wrapper so it cannot throw, and reports the timeout unconditionally once a bound expired (RP-266 follow-up)",
    async (guardFile) => {
      const config = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
        hooks: Record<
          string,
          Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>
        >;
      };
      const entry = Object.values(config.hooks)
        .flatMap((groups) => groups.flatMap((group) => group.hooks))
        .find((hook) => hook.command.includes(guardFile));
      expect(entry, `${guardFile} has no projected Codex hook entry`).toBeDefined();

      const encoded = entry?.commandWindows?.match(
        /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
      )?.[1];
      const windowsScript = Buffer.from(encoded ?? '', 'base64').toString('utf16le');

      const taskkillCount = (windowsScript.match(/taskkill/g) ?? []).length;
      expect(taskkillCount, `${guardFile}: expected at least one taskkill site`).toBeGreaterThan(0);

      const guardedKills =
        windowsScript.match(/try\s*\{[^{}]*taskkill[^{}]*\}\s*catch\s*\{[^{}]*\}/g) ?? [];
      expect(
        guardedKills.length,
        `${guardFile}: every taskkill site must sit inside its own try/catch so a ` +
          'PS 5.1 NativeCommandError from an already-exited process cannot escape and skip ' +
          `the wrapper's own exit 2. Found ${taskkillCount} taskkill site(s), ${guardedKills.length} guarded:\n${windowsScript}`,
      ).toBe(taskkillCount);

      // The catch must swallow ONLY the kill — never the timeout report that
      // has to run unconditionally once a bound has genuinely expired.
      for (const block of guardedKills) {
        expect(
          block,
          `${guardFile}: a try/catch around a kill must not also swallow the timeout report: ${block}`,
        ).not.toMatch(/timed out after|exit 2/);
      }

      const unconditionalReports =
        windowsScript.match(
          /\[Console\]::Error\.WriteLine\("codex wrapper: [^"]*timed out after[^"]*"\)\s*;?\s*exit 2/g,
        ) ?? [];
      expect(
        unconditionalReports.length,
        `${guardFile}: expected the stderr message and exit 2 to run unconditionally for every stage`,
      ).toBeGreaterThanOrEqual(2);
    },
  );

  // Hygiene, from reviewer advisories accepted alongside the blocker above:
  // CLIXML progress noise from a native command can land IN the block
  // reason, and `cmd.exe` alone risks a cwd lookup / the user's AutoRun.
  it.each(BOUNDED_STAGE_GUARDS)(
    "keeps CLIXML progress noise out of %s's block reason and resolves git through ComSpec with AutoRun disabled (RP-266 follow-up)",
    async (guardFile) => {
      const config = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
        hooks: Record<
          string,
          Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>
        >;
      };
      const entry = Object.values(config.hooks)
        .flatMap((groups) => groups.flatMap((group) => group.hooks))
        .find((hook) => hook.command.includes(guardFile));
      const encoded = entry?.commandWindows?.match(
        /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
      )?.[1];
      const windowsScript = Buffer.from(encoded ?? '', 'base64').toString('utf16le');

      expect(
        windowsScript,
        `${guardFile}: expected $ProgressPreference = 'SilentlyContinue' so CLIXML progress ` +
          'noise from a native command cannot land in the block reason',
      ).toMatch(/\$ProgressPreference\s*=\s*'SilentlyContinue'/);

      expect(
        windowsScript,
        `${guardFile}: expected git resolved through $env:ComSpec (not a bare 'cmd.exe', which ` +
          'risks a cwd lookup) with /d (skips the user AutoRun) before /c',
      ).toMatch(/\$env:ComSpec/);
      expect(windowsScript).toMatch(/\/d\b/);
      expect(windowsScript).toContain('git rev-parse --show-toplevel');
    },
  );

  // Per the official docs (https://code.claude.com/docs/en/hooks.md), Claude
  // Code's own default command-hook timeout is 600 s. Putting a `timeout`
  // into `.claude/settings.json` for these four SHORTENS Claude's kill point
  // instead of lengthening it — and a kill is an allow
  // (docs/decisions/fail-open-guards.md:27). The bound belongs only on the
  // Codex projection, which has no 600 s default of its own to preserve.
  it.each(BOUNDED_STAGE_GUARDS)(
    "never shortens Claude Code's own 600 s default hook timeout for %s in .claude/settings.json (RP-266 follow-up)",
    async (guardFile) => {
      const settings = JSON.parse(await text(universal, '.claude', 'settings.json')) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>>;
      };
      const entry = Object.values(settings.hooks)
        .flatMap((groups) => groups.flatMap((group) => group.hooks))
        .find((hook) => hook.command.includes(guardFile));
      expect(entry, `${guardFile} has no .claude/settings.json entry`).toBeDefined();

      expect(
        entry?.timeout,
        `${guardFile}'s .claude/settings.json entry must carry no timeout at all — one here ` +
          "would SHORTEN Claude Code's own 600 s default kill point to a lower figure, and a " +
          'kill is an allow (docs/decisions/fail-open-guards.md:27)',
      ).toBeUndefined();
    },
  );

  it.each(BOUNDED_STAGE_GUARDS)(
    "declares .codex/hooks.json's %s timeout as exactly 90 s, added by the projection itself, above the wrapper's own worst-case stage sum (RP-266 follow-up)",
    async (guardFile) => {
      const config = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
        hooks: Record<
          string,
          Array<{
            hooks: Array<{ command: string; commandWindows?: string; timeout?: number }>;
          }>
        >;
      };
      const entry = Object.values(config.hooks)
        .flatMap((groups) => groups.flatMap((group) => group.hooks))
        .find((hook) => hook.command.includes(guardFile));
      expect(entry, `${guardFile} has no projected Codex hook entry`).toBeDefined();

      // Only the Codex projection carries this — `.claude/settings.json` has
      // none for these four (pinned above), so `codexHooks()` must be adding
      // this explicitly rather than merely spreading the Claude source.
      expect(
        entry?.timeout,
        `${guardFile}'s projected Codex hook entry must carry a timeout of exactly 90 — 90 must exceed git ` +
          "5 s + the shared stdin/guard deadline 35 s + PowerShell's own startup cost " +
          '(measured 3–8 s, up to 15 s on hosted runners)',
      ).toBe(90);

      const encoded = entry?.commandWindows?.match(
        /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
      )?.[1];
      const windowsScript = Buffer.from(encoded ?? '', 'base64').toString('utf16le');

      // RP-266 follow-up: a reviewer called the earlier per-stage `if
      // ($xOverridden) { … } else { … }` branches "shaped for a regex" — the
      // fix is named literal DEFAULT assignments read once, not a duplicated
      // conditional per stage. git keeps its own bound; the stdin copy and
      // the guard wait now share ONE deadline (the stdin bound used to count
      // node startup and block large legitimate writes).
      const gitDefault = windowsScript.match(/\$gitDefaultMs\s*=\s*(\d+)\b/)?.[1];
      const guardDeadline = windowsScript.match(/\$guardDeadlineMs\s*=\s*(\d+)\b/)?.[1];
      expect(
        gitDefault,
        `${guardFile}: expected a named literal $gitDefaultMs = <ms> default assignment`,
      ).toBeDefined();
      expect(
        guardDeadline,
        `${guardFile}: expected a named literal $guardDeadlineMs = <ms> default assignment, ` +
          'shared by the stdin copy and the guard wait',
      ).toBeDefined();

      const sumOfStageDefaultsMs = Number(gitDefault) + Number(guardDeadline);
      const declaredTimeoutMs = (entry?.timeout ?? 0) * 1000;
      expect(
        declaredTimeoutMs,
        `${guardFile}'s hooks.json timeout (${entry?.timeout}s = ${declaredTimeoutMs} ms) must ` +
          `exceed the wrapper's own worst-case SUM of stage defaults ($gitDefaultMs + ` +
          `$guardDeadlineMs = ${sumOfStageDefaultsMs} ms), or the outer wiring kills the ` +
          "wrapper before it can report its own stage's timeout",
      ).toBeGreaterThan(sumOfStageDefaultsMs);
    },
  );

  it.each(BOUNDED_STAGE_GUARDS)(
    "lets a test-only RIG_CODEX_WRAPPER_TIMEOUT_MS override lower %s's per-stage bounds through Math.Min alone, and never raise them (RP-266 follow-up)",
    async (guardFile) => {
      const config = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
        hooks: Record<
          string,
          Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>
        >;
      };
      const entry = Object.values(config.hooks)
        .flatMap((groups) => groups.flatMap((group) => group.hooks))
        .find((hook) => hook.command.includes(guardFile));
      expect(entry, `${guardFile} has no projected Codex hook entry`).toBeDefined();

      const encoded = entry?.commandWindows?.match(
        /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
      )?.[1];
      const windowsScript = Buffer.from(encoded ?? '', 'base64').toString('utf16le');

      expect(
        windowsScript,
        `${guardFile}'s Windows wrapper must read a test-only ` +
          '$env:RIG_CODEX_WRAPPER_TIMEOUT_MS override for its stage bounds — hosted-Windows ' +
          'guard latency needs realistic (multi-second) production defaults, and a behavioural ' +
          'test cannot wait out a 35 s default on every run',
      ).toMatch(/\$env:RIG_CODEX_WRAPPER_TIMEOUT_MS/);

      // Accepted advisory: the override is a positive integer of at most 9
      // digits — 99999999999 (11 digits) or 2147483648 (10 digits, past
      // Int32.MaxValue) must never throw and must never fall through to a
      // production `[int]` cast that could overflow.
      const validityPattern = windowsScript.match(/-match\s+'(\^\[0-9\]\{1,9\}(?:\\z|\$))'/)?.[1];
      expect(
        validityPattern,
        `${guardFile}: expected the override validated by a ^[0-9]{1,9} shape`,
      ).toBeDefined();
      // RP-266 round 3 advisory: .NET's `$` (unlike JS's) matches not only the
      // true end of the string but also just before a single trailing `\n` —
      // so a bare `^[0-9]{1,9}$` accepts "3000\n" in PowerShell's own -match,
      // even though the same literal text tested through JS's regex engine
      // below would (misleadingly) look safe. `\z` is the anchor with no such
      // exception, so the SHAPE of the anchor is what has to be pinned here,
      // not a re-test in an engine that does not share the bug.
      expect(
        validityPattern,
        `${guardFile}: the override validity regex must end with \\z (the exact end of the ` +
          "string), not a bare $ — .NET's $ matches before a trailing newline too, so a value " +
          'like "3000\\n" would still pass the validity check with a bare $',
      ).toMatch(/\\z$/);
      // Re-test the digit shape in JS: .NET's \z has no JS counterpart (JS reads it as a
      // literal 'z'), and JS's own $ without the m flag already means the true end of the
      // string, so translate the one anchor before building the RegExp.
      const validity = new RegExp((validityPattern ?? '(?!)').replace(/\\z$/, () => '$'));
      expect(
        '99999999999',
        'an 11-digit override must fail the shape and keep the defaults',
      ).not.toMatch(validity);
      expect(
        '2147483648',
        'a 10-digit override past Int32.MaxValue must fail the shape too',
      ).not.toMatch(validity);
      expect('2000', 'a normal override must still validate').toMatch(validity);

      // "Only ever lowers a bound, and never through a duplicated per-stage
      // if/else": PR #353 round 1's `if ($gitOverridden) { … } else { … }`
      // shape (once per stage) is exactly what a reviewer called "shaped for
      // a regex" — the fix is a single `[Math]::Min(...)` selection against
      // each named default, with no conditional tied to the override at all.
      expect(
        windowsScript,
        `${guardFile}'s wrapper must never compare RIG_CODEX_WRAPPER_TIMEOUT_MS with -gt/-ge — ` +
          'that would let the override RAISE a stage bound instead of only lowering it',
      ).not.toMatch(/RIG_CODEX_WRAPPER_TIMEOUT_MS[^\n;]{0,200}-(?:gt|ge)\b/);
      expect(
        windowsScript,
        `${guardFile}'s wrapper must select the override only through [Math]::Min(...) against ` +
          "each stage's own named default",
      ).toMatch(/\[Math\]::Min\(/);
      expect(
        windowsScript,
        `${guardFile}'s wrapper must not carry a duplicated per-stage "if ($xOverridden) { … } ` +
          'else { … }" branch — a reviewer called that shape "shaped for a regex"; a single ' +
          '[Math]::Min(...) selection replaces it',
      ).not.toMatch(/if\s*\(\s*\$\w*[Oo]verrid(?:den|e)\w*\s*\)/);
    },
  );

  // PR #353 round 3 SECURITY BLOCKER (code-reviewer, security-scanner):
  // cmd.exe (and Windows' own CreateProcess, for a bare executable name like
  // 'node') looks in the CURRENT DIRECTORY first when resolving a command,
  // ahead of PATH — unless NoDefaultCurrentDirectoryInExePath is set. A text
  // `git.cmd` planted at the repository root, echoing an attacker-chosen
  // directory, replaces `$repoRoot` — and with it `$hookPath`, and with it
  // the guard script node actually runs. Measured: exit 0 on
  // `git push --force origin master` through the generated guard-bash
  // wrapper (an unhijacked run exits 2). The behavioural repro is
  // codex-wrapper-bounds.test.ts's hijack case.
  it.each(BOUNDED_STAGE_GUARDS)(
    "sets NoDefaultCurrentDirectoryInExePath=1 before starting git and before starting node in %s's wrapper, so a planted git.cmd/node.exe in the working directory cannot hijack the lookup (RP-266 round 3)",
    async (guardFile) => {
      const config = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
        hooks: Record<
          string,
          Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>
        >;
      };
      const entry = Object.values(config.hooks)
        .flatMap((groups) => groups.flatMap((group) => group.hooks))
        .find((hook) => hook.command.includes(guardFile));
      const encoded = entry?.commandWindows?.match(
        /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
      )?.[1];
      const windowsScript = Buffer.from(encoded ?? '', 'base64').toString('utf16le');

      // The git CHILD's own resolution (cmd.exe, via $env:ComSpec) is
      // governed by ITS OWN process environment, set on ProcessStartInfo's
      // EnvironmentVariables dictionary — not the wrapper's own $env:, which
      // a child process does not inherit changes to made after it started
      // (and $gitInfo is built before $env:ComSpec is even read).
      const gitEnvIdx = windowsScript.search(
        /\$gitInfo\.EnvironmentVariables\[['"]NoDefaultCurrentDirectoryInExePath['"]\]\s*=\s*['"]1['"]/,
      );
      expect(
        gitEnvIdx,
        `${guardFile}: expected $gitInfo.EnvironmentVariables['NoDefaultCurrentDirectoryInExePath'] = '1'`,
      ).toBeGreaterThanOrEqual(0);
      const gitStartIdx = windowsScript.indexOf('[System.Diagnostics.Process]::Start($gitInfo)');
      expect(gitStartIdx).toBeGreaterThan(-1);
      expect(
        gitStartIdx,
        `${guardFile}: the git child's NoDefaultCurrentDirectoryInExePath must be set before it starts`,
      ).toBeGreaterThan(gitEnvIdx);

      // node's own start uses a bare 'node' FileName, resolved by
      // CreateProcess/SearchPath in the WRAPPER's (powershell.exe's) own
      // process environment — set through $env:, not through $startInfo's
      // EnvironmentVariables (which governs the CHILD node process's
      // environment, not the search that locates node.exe itself).
      const wrapperEnvIdx = windowsScript.search(
        /\$env:NoDefaultCurrentDirectoryInExePath\s*=\s*['"]1['"]/,
      );
      expect(
        wrapperEnvIdx,
        `${guardFile}: expected $env:NoDefaultCurrentDirectoryInExePath = '1' before node starts`,
      ).toBeGreaterThanOrEqual(0);
      const nodeStartIdx = windowsScript.indexOf('[System.Diagnostics.Process]::Start($startInfo)');
      expect(nodeStartIdx).toBeGreaterThan(-1);
      expect(
        wrapperEnvIdx,
        `${guardFile}: the wrapper's own NoDefaultCurrentDirectoryInExePath must be set before node starts`,
      ).toBeLessThan(nodeStartIdx);
    },
  );

  // PR #353 round 3 CODE BLOCKER: the guard stage's timeout message reported
  // whatever was LEFT of the shared deadline after the stdin copy had
  // already spent part of it (e.g. 966 ms of a 1000 ms bound) rather than
  // the bound that was actually configured (the shared deadline, or the
  // lowered override). Decision: report the configured bound.
  it.each(BOUNDED_STAGE_GUARDS)(
    "reports the guard stage's configured bound, not the stdin copy's leftover, in %s's timeout message (RP-266 round 3)",
    async (guardFile) => {
      const config = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
        hooks: Record<
          string,
          Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>
        >;
      };
      const entry = Object.values(config.hooks)
        .flatMap((groups) => groups.flatMap((group) => group.hooks))
        .find((hook) => hook.command.includes(guardFile));
      const encoded = entry?.commandWindows?.match(
        /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
      )?.[1];
      const windowsScript = Buffer.from(encoded ?? '', 'base64').toString('utf16le');

      expect(
        windowsScript,
        `${guardFile}: the guard-stage timeout message must interpolate the configured deadline ` +
          '(e.g. $guardBudgetMs, the shared deadline lowered by [Math]::Min against any override), ' +
          'not the leftover time WaitForExit was actually given after the stdin copy',
      ).toMatch(/guard timed out after \$guard(?:BudgetMs|DeadlineMs) ms/);
      expect(
        windowsScript,
        `${guardFile}: the guard-stage message must not report $guardRemainingMs — that is a few ` +
          'ms below the configured bound once the stdin copy has spent any time at all, so a ' +
          '1000 ms bound would be reported as e.g. "966 ms"',
      ).not.toMatch(/guard timed out after \$guardRemainingMs ms/);
    },
  );

  // Accepted advisory, fail-open: if the guard exits before draining a large
  // stdin write, the pipe closes on the child's end and $copyTask.Wait
  // FAULTS — calling .Wait on a faulted Task re-throws synchronously, and
  // under $ErrorActionPreference = 'Stop' that is an unhandled terminating
  // error, so the wrapper exits 1 instead of the guard's own (already
  // rendered) exit code. The fix lets a faulted copy fall through to the
  // child wait rather than crash the script.
  it.each(BOUNDED_STAGE_GUARDS)(
    "falls through to the child wait instead of throwing when the stdin copy faults, in %s's wrapper (RP-266 round 3)",
    async (guardFile) => {
      const config = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
        hooks: Record<
          string,
          Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>
        >;
      };
      const entry = Object.values(config.hooks)
        .flatMap((groups) => groups.flatMap((group) => group.hooks))
        .find((hook) => hook.command.includes(guardFile));
      const encoded = entry?.commandWindows?.match(
        /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
      )?.[1];
      const windowsScript = Buffer.from(encoded ?? '', 'base64').toString('utf16le');

      const guardedCopyWait = windowsScript.match(
        /try\s*\{\s*\$stdinOk\s*=\s*\$copyTask\.Wait\([^)]*\)\s*\}\s*catch\s*\{[^{}]*\}/,
      );
      expect(
        guardedCopyWait,
        `${guardFile}: expected $stdinOk = $copyTask.Wait(...) wrapped in its own try/catch, so a ` +
          'faulted copy (the guard exited before draining a large write) cannot throw uncaught ' +
          `under $ErrorActionPreference = 'Stop':\n${windowsScript}`,
      ).not.toBeNull();

      // The catch must let the wrapper fall through to the child's own wait
      // (the child has, after all, already exited — that is WHY the copy
      // faulted) rather than reporting it as a stdin timeout.
      expect(
        guardedCopyWait?.[0],
        `${guardFile}: a faulted copy must fall through to the child wait, not be reported as a ` +
          'stdin timeout — the catch must not itself write the timeout message or exit 2',
      ).not.toMatch(/timed out after|exit 2/);
      expect(
        guardedCopyWait?.[0],
        `${guardFile}: the catch must set $stdinOk to a truthy value so the wrapper proceeds past ` +
          "the stdin-timeout check to the child's own wait, instead of leaving it false",
      ).toMatch(/catch\s*\{\s*\$stdinOk\s*=\s*\$true\s*\}/);
    },
  );

  // RP-225 slice 2: `record-dispatch.mjs` is wired on Claude's SubagentStart
  // and SubagentStop with `--harness=claude` in the Claude source
  // (`.claude/settings.json`) — a call-site argv flag, never guessed from the
  // hook payload. The Codex projection must carry the SAME hook with its
  // harness argument rewritten to `--harness=codex`, so the one deterministic
  // difference between the two projected commands is that one flag.
  it('projects record-dispatch onto Codex SubagentStart/SubagentStop with --harness=codex', async () => {
    const config = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>>;
    };
    for (const event of ['SubagentStart', 'SubagentStop']) {
      const hooks = (config.hooks[event] ?? []).flatMap((group) => group.hooks);
      const dispatch = hooks.find((hook) => hook.command.includes('record-dispatch.mjs'));
      expect(dispatch, `${event} has no record-dispatch.mjs entry`).toBeDefined();
      expect(dispatch?.command).toContain('--harness=codex');
      expect(dispatch?.command).not.toContain('--harness=claude');
      // commandWindows is a base64 -EncodedCommand (see the test above); the
      // flag lives inside the decoded PowerShell script, not the raw string.
      const encoded = dispatch?.commandWindows?.match(
        /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
      )?.[1];
      expect(encoded, ` commandWindows is not an EncodedCommand`).toBeDefined();
      const windowsScript = Buffer.from(encoded ?? '', 'base64').toString('utf16le');
      expect(windowsScript).toContain('--harness=codex');
      expect(windowsScript).not.toContain('--harness=claude');
    }
  });

  it('anchors a nested-cwd Codex rulebook edit to the canonical repository root', async (ctx) => {
    // Windows wiring is decoded and asserted above; this drives the POSIX
    // command through the shell it targets instead of pretending to execute
    // PowerShell on another platform.
    skipUnless(ctx, posixShellAvailable().ok, posixShellAvailable().reason);

    const scratch = await mkdtemp(path.join(tmpdir(), 'codex-hook-root-'));
    const home = await mkdtemp(path.join(tmpdir(), 'codex-hook-home-'));
    const nested = path.join(scratch, 'packages', 'core', 'src');
    try {
      await exec('git', ['init', '-q', scratch], { env: withoutGitLocation() });
      await cp(path.join(universal, '.claude'), path.join(scratch, '.claude'), {
        recursive: true,
      });
      await mkdir(nested, { recursive: true });

      const scopedEnv = { HOME: home, CLAUDE_PROJECT_DIR: scratch };
      const { unattendedFlags } = (await import(
        pathToFileURL(path.join(scratch, '.claude', 'scripts', 'unattended-flag.mjs')).href
      )) as { unattendedFlags: (env: Record<string, string>) => string[] };
      const flag = unattendedFlags(scopedEnv).find((candidate) => candidate.startsWith(home));
      expect(flag).toBeDefined();
      await mkdir(path.dirname(flag!), { recursive: true });
      await writeFile(flag!, JSON.stringify({ item: 'RP-54', runDir: '/runs/rp-54', allow: [] }));

      const config = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
        hooks: {
          PreToolUse: Array<{
            hooks: Array<{ command: string }>;
          }>;
        };
      };
      const command = config.hooks.PreToolUse.flatMap((group) => group.hooks).find((hook) =>
        hook.command.includes('guard-rulebook.mjs'),
      )?.command;
      expect(command).toBeDefined();

      const result = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
        const child = execFile(
          '/bin/sh',
          ['-c', command!],
          {
            cwd: nested,
            env: {
              ...withoutGitLocation(process.env),
              HOME: home,
              CLAUDE_PROJECT_DIR: '',
            },
          },
          (error, _stdout, stderr) =>
            resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr }),
        );
        if (!child.stdin) return reject(new Error('no stdin'));
        child.stdin.end(
          JSON.stringify({
            hook_event_name: 'PreToolUse',
            tool_name: 'Write',
            tool_input: { file_path: path.join(scratch, '.claude', 'rules', 'autonomy.md') },
            cwd: nested,
          }),
        );
      });

      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toMatch(/rulebook|unattended/i);
    } finally {
      await removeFixture(scratch);
      await removeFixture(home);
    }
  });

  it(
    'anchors a nested-cwd Windows Codex rulebook edit to the canonical repository root',
    { timeout: WINDOWS_POWERSHELL_CASE_TIMEOUT_MS },
    async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);

      const scratch = await mkdtemp(path.join(tmpdir(), 'codex-hook-windows-root-'));
      const home = await mkdtemp(path.join(tmpdir(), 'codex-hook-windows-home-'));
      const nested = path.join(scratch, 'packages', 'core', 'src');
      try {
        await exec('git', ['init', '-q', scratch], { env: withoutGitLocation() });
        await cp(path.join(universal, '.claude'), path.join(scratch, '.claude'), {
          recursive: true,
        });
        await mkdir(nested, { recursive: true });

        const scopedEnv = { HOME: home, CLAUDE_PROJECT_DIR: scratch };
        const { unattendedFlags } = (await import(
          pathToFileURL(path.join(scratch, '.claude', 'scripts', 'unattended-flag.mjs')).href
        )) as { unattendedFlags: (env: Record<string, string>) => string[] };
        const flag = unattendedFlags(scopedEnv).find((candidate) =>
          path.resolve(candidate).toLowerCase().startsWith(path.resolve(home).toLowerCase()),
        );
        expect(flag).toBeDefined();
        await mkdir(path.dirname(flag!), { recursive: true });
        await writeFile(flag!, JSON.stringify({ item: 'RP-54', runDir: '/runs/rp-54', allow: [] }));

        const config = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
          hooks: {
            PreToolUse: Array<{
              hooks: Array<{ command: string; commandWindows?: string }>;
            }>;
          };
        };
        const commandWindows = config.hooks.PreToolUse.flatMap((group) => group.hooks).find(
          (hook) => hook.command.includes('guard-rulebook.mjs'),
        )?.commandWindows;
        const encoded = commandWindows?.match(
          /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
        )?.[1];
        expect(encoded).toBeDefined();

        const payloadText = JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          tool_input: { file_path: path.join(scratch, '.claude', 'rules', 'autonomy.md') },
          cwd: nested,
        });

        const result = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
          const child = execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded!],
            {
              cwd: nested,
              env: {
                ...withoutGitLocation(process.env),
                HOME: home,
                CLAUDE_PROJECT_DIR: '',
              },
            },
            (error, _stdout, stderr) =>
              resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr }),
          );
          if (!child.stdin) return reject(new Error('no stdin'));
          child.stdin.end(payloadText);
        });

        // A bare "expected 0 to be 2" says nothing about WHY the guard allowed
        // the edit, and the only stderr PowerShell returns on the allow path is
        // its own CLIXML progress noise — so this failure has to carry the inputs
        // the guard compared. The spellings are the whole question: the hook
        // derives its root from `git rev-parse --show-toplevel` while the payload
        // path comes from `os.tmpdir()`, and the flag is named by a hash of that root.
        const toplevel = (
          await exec('git', ['rev-parse', '--show-toplevel'], {
            cwd: nested,
            env: withoutGitLocation(),
          })
        ).stdout.trim();
        // Only when the guard already allowed the edit: re-run the SAME unmodified
        // wrapper against a probe standing in for the guard, so the failure says
        // whether the payload reached the child at all. It separates a wrapper
        // that loses stdin from a guard that reads it and decides "allow" — and
        // the exit code says whether the wrapper propagates a child's code.
        const probe =
          result.code === 2
            ? '(not probed: the guard blocked)'
            : await (async () => {
                await writeFile(
                  path.join(scratch, '.claude', 'hooks', 'guard-rulebook.mjs'),
                  [
                    "import { readFileSync } from 'node:fs';",
                    "let n = -1, err = '';",
                    'try { n = readFileSync(0).length; } catch (e) { err = String((e && e.code) || e); }',
                    'process.stderr.write(`PROBE bytes=${n} err=${err}\\n`);',
                    'process.exit(3);',
                  ].join('\n'),
                );
                return new Promise<string>((resolve, reject) => {
                  const child = execFile(
                    'powershell.exe',
                    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded!],
                    {
                      cwd: nested,
                      env: {
                        ...withoutGitLocation(process.env),
                        HOME: home,
                        CLAUDE_PROJECT_DIR: '',
                      },
                    },
                    (error, _stdout, stderr) => {
                      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
                      resolve(`exit=${code} ${stderr.replace(/\s+/g, ' ').trim()}`);
                    },
                  );
                  if (!child.stdin) return reject(new Error('no stdin'));
                  child.stdin.end(payloadText);
                });
              })();

        const seen = [
          `tmpdir            ${tmpdir()}`,
          `scratch           ${scratch}`,
          `scratch (native)  ${realpathSync.native(scratch)}`,
          `git toplevel      ${toplevel}`,
          `payload file_path ${path.join(scratch, '.claude', 'rules', 'autonomy.md')}`,
          `payload bytes     ${Buffer.byteLength(payloadText)}`,
          `home              ${home}`,
          `flag              ${flag}`,
          `flag exists       ${existsSync(flag!)}`,
          `transport probe   ${probe}`,
          `stderr            ${result.stderr}`,
        ].join('\n');

        expect(result.code, seen).toBe(2);
        expect(result.stderr, seen).toMatch(/rulebook|unattended/i);
      } finally {
        await removeFixture(scratch);
        await removeFixture(home);
      }
    },
  );

  it('emits each tool at most once in generated Codex hook matchers', async () => {
    const config = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
      hooks: Record<string, Array<{ matcher?: string }>>;
    };

    for (const groups of Object.values(config.hooks)) {
      for (const group of groups) {
        if (!group.matcher) continue;
        const tools = group.matcher.split('|').map((tool) => tool.trim());
        expect(tools, group.matcher).toHaveLength(new Set(tools).size);
      }
    }
  });

  it('refuses to expose a Claude edit guard to apply_patch without the shared normalizer', async () => {
    const config = JSON.parse(await text(universal, '.codex', 'hooks.json')) as {
      hooks: {
        PreToolUse: Array<{
          matcher?: string;
          hooks: Array<{ command: string }>;
        }>;
      };
    };

    // RP-415: a relay hands the payload bytes to another program and never
    // interprets the edit, so it has no edit to normalise. It is held to the
    // stricter property instead: its source never touches tool_input at all.
    const RELAY_HOOKS = new Set(['.claude/hooks/probity-gate.mjs']);
    for (const group of config.hooks.PreToolUse) {
      if (!group.matcher?.includes('apply_patch')) continue;
      for (const hook of group.hooks) {
        const relativeHook = hook.command.match(/\.claude\/hooks\/[A-Za-z0-9._-]+\.mjs/)?.[0];
        expect(relativeHook, `cannot locate the hook in: ${hook.command}`).toBeDefined();
        const source = await text(universal, ...(relativeHook?.split('/') ?? []));
        if (relativeHook && RELAY_HOOKS.has(relativeHook)) {
          expect(source, `${relativeHook} is a relay but reads tool_input`).not.toMatch(
            /tool_input/,
          );
          continue;
        }
        expect(source, `${relativeHook} bypasses the shared edit normalizer`).toMatch(
          /from ['"]\.\/lib\/edit-input\.mjs['"]/,
        );
      }
    }
  });

  // RP-186: the elevated-paths block lives in AGENTS.md now (the canonical
  // rulebook); CLAUDE.md is a shim and declares no block of its own.
  it('declares generated Codex hook wiring as an elevated path', async () => {
    const map = await text(universal, 'AGENTS.md');
    const elevated = /```elevated-paths\n([\s\S]*?)```/.exec(map)?.[1] ?? '';
    expect(elevated.split(/\r?\n/)).toContain('.codex/');
  });

  it('grounds the string command payload contract in the official Codex hooks documentation', async () => {
    const decision = await text(universal, 'docs', 'decisions', 'codex-adapter.md');

    expect(decision).toContain('https://learn.chatgpt.com/docs/hooks');
    expect(decision).toMatch(/tool_input\.command[^.]{0,120}string/i);
  });

  it('documents how the aggregate path-component budget limits files per patch', async () => {
    const decision = await text(universal, 'docs', 'decisions', 'codex-adapter.md');
    const contract = decision
      .split(/\n\s*\n/)
      .find((paragraph) => paragraph.includes('MAX_PATCH_PATH_COMPONENTS'));

    expect(contract, 'the authored decision must name MAX_PATCH_PATH_COMPONENTS').toBeDefined();
    expect(contract).toMatch(
      /(?:aggregate|cumulative|total|patch-wide)[^.]{0,160}(?:per[- ]patch|whole patch|entire patch|across (?:a|the) patch)|(?:per[- ]patch|whole patch|entire patch|across (?:a|the) patch)[^.]{0,160}(?:aggregate|cumulative|total|patch-wide)/i,
    );
    expect(contract).toMatch(
      /(?:file capacity|number of files|how many files|file count)[^.]{0,160}(?:path depth|path components?)|(?:path depth|path components?)[^.]{0,160}(?:file capacity|number of files|how many files|file count)/i,
    );
    expect(contract).toMatch(/split(?:ting)?[^.]{0,100}(?:smaller|multiple)[^.]{0,40}patch/i);
  });

  it('names all seven per-patch inspection budgets in the normalizer header', async () => {
    const source = await text(hooksDir, 'lib', 'edit-input.mjs');
    const header = /^\/\*\*[\s\S]*?\*\//.exec(source)?.[0] ?? '';
    const budgets: Array<[string, RegExp]> = [
      ['sources', /\bsources?\b/i],
      ['hunks', /\bhunks?\b/i],
      ['output', /\boutput\b/i],
      ['splices', /\bsplices?\b/i],
      ['comparisons', /\bcomparisons?\b/i],
      ['sections', /\bsections?\b/i],
      ['path components', /\bpath[- ]components?\b/i],
    ];
    const missing = budgets.filter(([, pattern]) => !pattern.test(header)).map(([name]) => name);

    expect(header).toMatch(/bounded globally per patch/i);
    expect(missing, 'the header must enumerate every global inspection budget').toEqual([]);
  });

  it('grounds hook trust and re-review guidance in the official Codex hooks documentation', async () => {
    const readme = await text(repoRoot, 'README.md');
    const trustGuidance = readme.match(/After generation or upgrade,[\s\S]*?(?=\n## )/)?.[0] ?? '';

    expect(trustGuidance).toContain('https://learn.chatgpt.com/docs/hooks');
    expect(trustGuidance).toMatch(/changed[^.]*hook[^.]*review again/i);
  });
});

// RP-266 follow-up: the win32 behavioural cases that drive the real
// generated wrapper (busy-wait taskkill-race repro, override passthrough,
// invalid-override fallback) moved to test/template/codex-wrapper-bounds.test.ts
// — every one of them starts a real powershell.exe, the same load-sensitive
// cost RP-162's comment above already measured, so they get their own file
// and their own per-case budget instead of the wall-clock-sensitive shape
// this file used to carry for two of them.

function runGuard(script: string, command: string): Promise<{ code: number; stderr: string }> {
  return runGuardInput(script, {
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: { command },
    cwd: repoRoot,
  });
}

function runGuardInput(
  script: string,
  input: {
    hook_event_name: string;
    tool_name: string;
    tool_input: { command: unknown };
    cwd: string;
  },
  timeout?: number,
  /** Extra environment for the child — used to simulate a git hook's inherited GIT_DIR. */
  env?: Record<string, string>,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(hooksDir, script)],
      { timeout, env: env ? { ...process.env, ...env } : process.env },
      (error, _stdout, stderr) =>
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr }),
    );
    if (!child.stdin) return reject(new Error('no stdin'));
    child.stdin.end(JSON.stringify(input));
  });
}

describe('Codex apply_patch shape validation keeps its refusal remedy', () => {
  // The remaining write guard owns this refusal. A shape refusal must not send
  // the agent to split the patch, while a size refusal must.
  const GUARDS = ['guard-secret-file.mjs'];

  it.each(GUARDS)('%s tells an unreadable shape to resend, not to split', async (guard) => {
    const result = await runGuardInput(guard, {
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command: { patch: '*** Begin Patch\n*** End Patch' } },
      cwd: repoRoot,
    });

    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/patch string, or a list of strings/i);
    expect(result.stderr).not.toMatch(/smaller patch/i);
  });

  it.each(GUARDS)('%s still tells an oversized patch to split', async (guard) => {
    const oversized = [
      '*** Begin Patch',
      '*** Add File: a.md',
      `+${'x'.repeat(1024 * 1024 + 10)}`,
      '*** End Patch',
    ].join('\n');
    const result = await runGuardInput(guard, {
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command: oversized },
      cwd: repoRoot,
    });

    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/smaller patch/i);
    expect(result.stderr).not.toMatch(/patch string, or a list of strings/i);
  });

  // 🔴 A `tool_input` that is not an object threw on `'command' in toolInput`, and
  // two of the three guards have no catch — they exited 1 with a stack trace,
  // which neither harness treats as blocking. A crash was an ALLOW, on the path
  // this whole item exists for.
  it.each(GUARDS)('%s refuses a tool_input that is not an object', async (guard) => {
    const result = await runGuardInput(guard, {
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: 'oops' as unknown as { command: unknown },
      cwd: repoRoot,
    });

    expect(result.code, result.stderr).toBe(2);
  });

  // The other side of the same seam, and it had no test at all: an ABSENT
  // command is a payload the hook does not understand, which the rules say must
  // allow — the same answer the Write/Edit arm gives a missing file_path.
  it.each(GUARDS)('%s allows a payload carrying no command at all', async (guard) => {
    const result = await runGuardInput(guard, {
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: {} as unknown as { command: unknown },
      cwd: repoRoot,
    });

    expect(result.code, result.stderr).toBe(0);
  });

  it.each([
    ['a number', 42],
    ['a mixed array', ['*** Begin Patch', 42, '*** End Patch']],
    ['an object', { patch: '*** Begin Patch\n*** End Patch' }],
  ])(
    'refuses, rather than failing open, when apply_patch command is supplied as %s',
    async (_label, command) => {
      const result = await runGuardInput('guard-secret-file.mjs', {
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: { command },
        cwd: repoRoot,
      });

      // 🔴 This assertion was `toBe(0)` and is deliberately reversed, which is
      // the one thing a test edit may not do quietly. The old contract let a
      // credential land: `guard-secret-file` allowed a patch whose container the
      // normalizer could not read, while stderr announced that nothing had been
      // inspected. Measured before the change — string 2, all-string array 2,
      // array with one non-string 0, object 0.
      //
      // The rule cited for failing open (`invariants.md`) covers a guard that
      // THROWS or is handed something it cannot parse at all. This shape is one
      // the normalizer detects and names, and the branch ten lines below it in
      // `edit-input.mjs` already refuses the same class. Two opposite answers to
      // one question was the defect; this is the side that does not lose a
      // credential.
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/shape|form/i);
    },
  );

  // The unit-level half of the case above: that one drives the whole guard, this
  // one pins the fragment `editFragments` hands its consumers. Both say refuse —
  // the shape is a condition the normalizer detects and reports, not an error it
  // threw, which is the line `invariants.md` draws around failing open.
  it.each([
    ['a number', 42],
    ['a mixed array', ['*** Begin Patch', 42, '*** End Patch']],
    ['an object', { patch: '*** Begin Patch\n*** End Patch' }],
  ])(
    'returns an inspection refusal that applies to the whole patch when command is %s',
    async (_label, command) => {
      const editInput = (await import(
        pathToFileURL(path.join(hooksDir, 'lib', 'edit-input.mjs')).href
      )) as {
        editFragments(input: unknown): Array<{
          filePath: string;
          fragment: string;
          inspectionRefusal?: string;
          appliesToAll?: boolean;
        }>;
      };

      const fragments = editInput.editFragments({
        tool_name: 'apply_patch',
        cwd: repoRoot,
        tool_input: { command },
      });

      expect(fragments).toHaveLength(1);
      expect(fragments[0]).toMatchObject({ appliesToAll: true });
      expect(fragments[0]?.inspectionRefusal).toMatch(/shape|form/i);
      expect(fragments[0]?.inspectionRefusal).not.toMatch(/limit|size/i);
    },
  );

  it('blocks a credential added through an Update section', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    const result = await runGuard(
      'guard-secret-file.mjs',
      [
        '*** Begin Patch',
        '*** Update File: notes.md',
        '@@',
        `+AWS_KEY=${CLOUD_ACCESS_KEY}`,
        '*** End Patch',
      ].join('\n'),
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/credential/i);
  });

  it.each([
    {
      guard: 'guard-secret-file.mjs',
      destination: 'packages/core/./src/note.ts',
      addition: `+AWS_KEY=${CLOUD_ACCESS_KEY}`,
    },
    {
      guard: 'guard-secret-file.mjs',
      destination: 'apps/./web/src/notes.md',
      addition: `+AWS_KEY=${CLOUD_ACCESS_KEY}`,
    },
  ])('canonicalizes and protects the dotted destination $destination', async (example) => {
    const result = await runGuard(
      example.guard,
      [
        '*** Begin Patch',
        `*** Update File: ${example.destination}`,
        '@@',
        example.addition,
        '*** End Patch',
      ].join('\n'),
    );

    expect(result.code).toBe(2);
  });

  it('protects an Add destination hidden behind an in-repository parent symlink', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-symlink-add-destination-'));
    const alias = path.join(scratch, 'alias');
    // Any real, existing in-repository directory — what matters is that the
    // guard resolves the ADD destination through the symlink and still scans
    // what lands there, not what the target directory happens to be.
    const target = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'rules');

    try {
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await runGuard(
        'guard-secret-file.mjs',
        [
          '*** Begin Patch',
          `*** Add File: ${path.relative(repoRoot, path.join(alias, 'notes.md'))}`,
          `+AWS_KEY=${CLOUD_ACCESS_KEY}`,
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/credential/i);
    } finally {
      await removeFixture(scratch);
    }
  });

  it('protects a Move destination hidden behind an in-repository parent symlink', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-symlink-move-destination-'));
    const source = path.join(scratch, 'impure.ts');
    const alias = path.join(scratch, 'alias');
    // Any real, existing in-repository directory — see the Add-destination
    // test above for why the target's identity does not matter here.
    const target = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'rules');
    await writeFile(source, `AWS_KEY=${CLOUD_ACCESS_KEY}\n`);

    try {
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await runGuard(
        'guard-secret-file.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          `*** Move to: ${path.relative(repoRoot, path.join(alias, 'notes.md'))}`,
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/credential/i);
    } finally {
      await removeFixture(scratch);
    }
  });

  it('refuses a destination symlink outside the repository without leaking its target or moved content', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'codex-private-destination-target-'));
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-outside-destination-link-'));
    const source = path.join(scratch, 'source.ts');
    const alias = path.join(scratch, 'alias');
    const contentMarker = 'unique-destination-content-marker';
    await writeFile(source, `export const value = '${contentMarker}';\n`);

    try {
      await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await runGuard(
        'guard-secret-file.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          `*** Move to: ${path.relative(repoRoot, path.join(alias, 'moved.ts'))}`,
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/destination.*(?:outside|unsafe)|unsafe.*destination/i);
      expect(result.stderr).not.toContain(contentMarker);
      expect(result.stderr).not.toContain(outside);
    } finally {
      await removeFixture(scratch);
      await removeFixture(outside);
    }
  });

  it('refuses an Add destination that is a dangling symlink to a missing outside path without leaking the target', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'codex-missing-add-target-'));
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-dangling-add-link-'));
    const missingTarget = path.join(outside, 'missing-private-target.ts');
    const destination = path.join(scratch, 'destination.ts');

    try {
      await symlink(missingTarget, destination, 'file');
      const result = await runGuard(
        'guard-secret-file.mjs',
        [
          '*** Begin Patch',
          `*** Add File: ${path.relative(repoRoot, destination)}`,
          '+export const safe = true;',
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/destination.*(?:outside|unsafe)|unsafe.*destination/i);
      expect(result.stderr).not.toContain(outside);
    } finally {
      await removeFixture(scratch);
      await removeFixture(outside);
    }
  });

  it('refuses a Move destination below a dangling parent symlink without leaking its missing outside target', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'codex-missing-move-target-'));
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-dangling-move-link-'));
    const missingTarget = path.join(outside, 'missing-private-directory');
    const source = path.join(scratch, 'source.ts');
    const alias = path.join(scratch, 'alias');
    await writeFile(source, 'export const safe = true;\n');

    try {
      await symlink(missingTarget, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await runGuard(
        'guard-secret-file.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          `*** Move to: ${path.relative(repoRoot, path.join(alias, 'moved.ts'))}`,
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/destination.*(?:outside|unsafe)|unsafe.*destination/i);
      expect(result.stderr).not.toContain(outside);
    } finally {
      await removeFixture(scratch);
      await removeFixture(outside);
    }
  });

  it('refuses absolute and traversal move destinations outside the repository', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-outside-destination-'));
    const source = path.join(scratch, 'source.ts');
    await writeFile(source, 'export const safe = true;\n');

    try {
      for (const destination of [
        path.join(tmpdir(), 'outside.ts'),
        '../outside.ts',
        '..\\outside.ts',
        'C:outside.ts',
        '\\\\server\\share\\outside.ts',
      ]) {
        const result = await runGuard(
          'guard-secret-file.mjs',
          [
            '*** Begin Patch',
            `*** Update File: ${path.relative(repoRoot, source)}`,
            `*** Move to: ${destination}`,
            '*** End Patch',
          ].join('\n'),
        );

        expect(result.code, destination).toBe(2);
        expect(result.stderr, destination).toMatch(/destination.*outside|unsafe.*destination/i);
      }
    } finally {
      await removeFixture(scratch);
    }
  });

  it('does not inspect removed patch lines as newly introduced code', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    const result = await runGuard(
      'guard-secret-file.mjs',
      [
        '*** Begin Patch',
        '*** Update File: packages/core/src/note.ts',
        '@@',
        "-import { readFile } from 'node:fs/promises';",
        '+export const pure = true;',
        '*** End Patch',
      ].join('\n'),
    );
    expect(result.code).toBe(0);
  });

  it.each(['absolute', 'traversal'])(
    'refuses to inspect a move source outside the repository via %s',
    async (pathKind) => {
      const scratch = await mkdtemp(path.join(tmpdir(), 'codex-outside-'));
      const source = path.join(scratch, 'safe.ts');
      await writeFile(source, 'export const safe = true;\n');
      const sourcePath = pathKind === 'absolute' ? source : path.relative(repoRoot, source);

      try {
        const result = await runGuard(
          'guard-secret-file.mjs',
          [
            '*** Begin Patch',
            `*** Update File: ${sourcePath}`,
            '*** Move to: packages/core/src/safe.ts',
            '*** End Patch',
          ].join('\n'),
        );
        expect(result.code).toBe(2);
        expect(result.stderr).toMatch(/outside|repository|repo root|refus|inspect/i);
      } finally {
        await removeFixture(scratch);
      }
    },
  );

  it('does not echo content read from an outside-repository move source', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'codex-outside-content-'));
    const source = path.join(scratch, 'private.ts');
    await writeFile(source, "import '@app/db/unique-private-marker';\n");

    try {
      const result = await runGuard(
        'guard-secret-file.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${source}`,
          '*** Move to: apps/web/src/private.ts',
          '*** End Patch',
        ].join('\n'),
      );
      expect(result.code).toBe(2);
      expect(result.stderr).not.toContain('unique-private-marker');
    } finally {
      await removeFixture(scratch);
    }
  });

  it('rejects an in-repository symlink that resolves outside without echoing its content', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'codex-symlink-target-'));
    const inside = await mkdtemp(path.join(repoRoot, '.codex-symlink-source-'));
    const link = path.join(inside, 'outside');
    await writeFile(path.join(outside, 'private.ts'), "import '@app/db/unique-symlink-marker';\n");

    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await runGuard(
        'guard-secret-file.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, path.join(link, 'private.ts'))}`,
          '*** Move to: apps/web/src/private.ts',
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/resolves outside|outside.*repository/i);
      expect(result.stderr).not.toContain('unique-symlink-marker');
    } finally {
      await removeFixture(inside);
      await removeFixture(outside);
    }
  });

  it('treats a final-component symlink as a recognized unsafe-source refusal', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    const outside = await mkdtemp(path.join(tmpdir(), 'codex-final-symlink-target-'));
    const inside = await mkdtemp(path.join(repoRoot, '.codex-final-symlink-'));
    const target = path.join(outside, 'private.ts');
    const link = path.join(inside, 'private.ts');
    await writeFile(target, "import '@app/db/unique-final-symlink-marker';\n");

    try {
      await symlink(target, link, 'file');
      const result = await runGuard(
        'guard-secret-file.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, link)}`,
          '*** Move to: apps/web/src/private.ts',
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/resolves outside|unsafe.*source/i);
      expect(result.stderr).not.toContain('unique-final-symlink-marker');
    } finally {
      await removeFixture(inside);
      await removeFixture(outside);
    }
  });

  it('diagnoses a missing move source but leaves the guard fail-open', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    const result = await runGuard(
      'guard-secret-file.mjs',
      [
        '*** Begin Patch',
        '*** Update File: definitely-missing/move-source.ts',
        '*** Move to: packages/core/src/missing.ts',
        '*** End Patch',
      ].join('\n'),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/could not inspect moved file/i);
    expect(result.stderr).not.toMatch(/BLOCKED/i);
  });

  it('blocks a move-only patch that carries an existing credential into a tracked path', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-secret-move-'));
    const source = path.join(scratch, 'secret.txt');
    await writeFile(source, `AWS_KEY=${CLOUD_ACCESS_KEY}\n`);

    try {
      const result = await runGuard(
        'guard-secret-file.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          '*** Move to: notes.md',
          '*** End Patch',
        ].join('\n'),
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/credential/i);
    } finally {
      await removeFixture(scratch);
    }
  });

  // 🔴 Found by this repository's own pre-commit hook, which is the only place the
  // suite runs with a git hook's environment inherited. Every other git call site
  // in the rig strips the variables that locate a repository (`git-env.mjs`,
  // `withoutGitLocation`) — gate-stop-dod, preflight, decision-router,
  // queue/checkout — and this one did not, so `git rev-parse --show-toplevel`
  // answered about the HOOK's repository and the guard fell open. Same lesson the
  // baseline-commit incident already paid for.
  it('resolves the repository root even when a git hook has exported GIT_DIR', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    // A REAL repository, not an empty directory: with an invalid GIT_DIR the git
    // call merely fails and the fallback saves the guard, which is the wrong
    // reason to pass. A git hook exports a VALID one — that is the case that
    // resolves the wrong root successfully.
    const foreign = await mkdtemp(path.join(tmpdir(), 'foreign-repo-'));
    await exec('git', ['init', '-q', foreign], { env: withoutGitLocation() });
    const nested = await mkdtemp(path.join(repoRoot, '.codex-gitdir-'));
    await writeFile(path.join(nested, 'secret.txt'), `AWS_KEY=${CLOUD_ACCESS_KEY}\n`);

    try {
      const result = await runGuardInput(
        'guard-secret-file.mjs',
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'apply_patch',
          tool_input: {
            command: [
              '*** Begin Patch',
              '*** Update File: secret.txt',
              '*** Move to: moved.txt',
              '*** End Patch',
            ].join('\n'),
          },
          cwd: nested,
        },
        undefined,
        { GIT_DIR: path.join(foreign, '.git'), GIT_WORK_TREE: foreign },
      );

      // 🔴 The REASON, not just the code. Without the fix this still exits 2 —
      // the root resolves to `foreign`, the destination lands outside it, and the
      // guard refuses for that instead. Measured: deleting `withoutGitLocation()`
      // from both copies left all 61 tests in this file green. Asserting the
      // credential message is what makes the test fail for the defect it names.
      expect(result.stderr).toMatch(/credential/i);
      expect(result.code).toBe(2);
    } finally {
      await removeFixture(nested);
      await removeFixture(foreign);
    }
  });

  it('resolves a relative move source from the hook payload cwd', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    const nested = await mkdtemp(path.join(repoRoot, '.codex-nested-cwd-'));
    await writeFile(path.join(nested, 'secret.txt'), `AWS_KEY=${CLOUD_ACCESS_KEY}\n`);

    try {
      const result = await runGuardInput('guard-secret-file.mjs', {
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: {
          command: [
            '*** Begin Patch',
            '*** Update File: secret.txt',
            '*** Move to: moved.txt',
            '*** End Patch',
          ].join('\n'),
        },
        cwd: nested,
      });

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/credential/i);
    } finally {
      await removeFixture(nested);
    }
  });

  it('refuses to inspect a non-regular move source', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-non-regular-'));
    const source = path.join(scratch, 'directory');
    await mkdir(source);

    try {
      const result = await runGuard(
        'guard-secret-file.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          '*** Move to: packages/core/src/directory.ts',
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/not a regular file|cannot safely inspect/i);
    } finally {
      await removeFixture(scratch);
    }
  });

  it('quickly refuses a FIFO move source instead of blocking on it', async (ctx) => {
    skipUnless(ctx, fifosAvailable().ok, fifosAvailable().reason);

    const scratch = await mkdtemp(path.join(tmpdir(), 'codex-fifo-move-'));
    const core = path.join(scratch, 'packages', 'core', 'src');
    const source = path.join(core, 'source.ts');

    try {
      await mkdir(core, { recursive: true });
      await exec('git', ['init', '--quiet'], { cwd: scratch, env: withoutGitLocation() });
      try {
        await exec('mkfifo', [source]);
      } catch (error) {
        const stderr = (error as { stderr?: string }).stderr ?? '';
        if (/operation not supported/i.test(stderr)) return;
        throw error;
      }
      const result = await runGuardInput(
        'guard-secret-file.mjs',
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'apply_patch',
          tool_input: {
            command: [
              '*** Begin Patch',
              '*** Update File: packages/core/src/source.ts',
              '*** Move to: packages/core/src/moved.ts',
              '*** End Patch',
            ].join('\n'),
          },
          cwd: scratch,
        },
        1_000,
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/not a regular file|cannot safely inspect/i);
    } finally {
      await removeFixture(scratch);
    }
  });

  it('fails closed on a final-component symlink even when its target is in the repository', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-inside-symlink-'));
    const target = path.join(scratch, 'target.ts');
    const source = path.join(scratch, 'source.ts');
    await writeFile(target, 'export const safe = true;\n');

    try {
      await symlink(target, source, 'file');
      const result = await runGuard(
        'guard-secret-file.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          '*** Move to: packages/core/src/source.ts',
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/cannot safely inspect|unsafe.*source/i);
    } finally {
      await removeFixture(scratch);
    }
  });

  it('reads only a bounded prefix and blocks an oversized move source', async () => {
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-large-move-'));
    const source = path.join(scratch, 'large.ts');
    await writeFile(source, 'x'.repeat(1024 * 1024 + 1));

    try {
      const result = await runGuard(
        'guard-secret-file.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          '*** Move to: packages/core/src/large.ts',
          '*** End Patch',
        ].join('\n'),
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/large|size|limit|inspect/i);
    } finally {
      await removeFixture(scratch);
    }
  });

  it('refuses an oversized apply_patch command before parsing its contents', async () => {
    const result = await runGuard(
      'guard-secret-file.mjs',
      [
        '*** Begin Patch',
        '*** Update File: packages/core/src/large-patch.ts',
        '@@',
        `+${'x'.repeat(1024 * 1024 + 1)}`,
        '*** End Patch',
      ].join('\n'),
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/patch.*(?:size|limit|large)|(?:size|limit|large).*patch/i);
  });

  it('refuses the whole patch and stops processing after the global section budget is exhausted', async () => {
    const source = await text(hooksDir, 'lib', 'edit-input.mjs');
    const declaration = /const MAX_PATCH_SECTIONS = ([\d_]+);/.exec(source);
    expect(
      declaration,
      'MAX_PATCH_SECTIONS must bound filesystem work independently of patch character size',
    ).not.toBeNull();

    const sectionLimit = Number(declaration?.[1]?.replaceAll('_', ''));
    expect(sectionLimit).toBeGreaterThan(0);
    expect(sectionLimit).toBeLessThanOrEqual(4_096);
    expect([...source.matchAll(/\bMAX_PATCH_SECTIONS\b/g)].length).toBeGreaterThan(1);

    const editInput = (await import(
      pathToFileURL(path.join(hooksDir, 'lib', 'edit-input.mjs')).href
    )) as {
      editFragments(input: unknown): Array<{
        filePath: string;
        fragment: string;
        inspectionRefusal?: string;
        appliesToAll?: boolean;
      }>;
    };
    const sections = Array.from({ length: sectionLimit + 1 }, (_, index) => [
      `*** Add File: packages/core/src/section-${index}.ts`,
      '+export {};',
    ]).flat();
    const fragments = editInput.editFragments({
      tool_name: 'apply_patch',
      cwd: repoRoot,
      tool_input: {
        command: [
          '*** Begin Patch',
          ...sections,
          // If processing continues after exhaustion this path produces a
          // different repository-path refusal and masks the budget failure.
          '*** Add File: ../../must-not-resolve.ts',
          '+export {};',
          '*** End Patch',
        ].join('\n'),
      },
    });
    const refusals = fragments.filter(({ inspectionRefusal }) => inspectionRefusal);

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ appliesToAll: true });
    expect(refusals[0]?.inspectionRefusal).toMatch(
      /section.*(?:budget|limit)|(?:budget|limit).*section/i,
    );
    expect(refusals[0]?.inspectionRefusal).not.toMatch(/destination|repository|path/i);
  });

  it('refuses the whole patch before later sections after the global path-component budget is exhausted', async () => {
    const source = await text(hooksDir, 'lib', 'edit-input.mjs');
    const declaration = /const MAX_PATCH_PATH_COMPONENTS = ([\d_]+);/.exec(source);
    expect(
      declaration,
      'MAX_PATCH_PATH_COMPONENTS must bound destination traversal independently of section count',
    ).not.toBeNull();

    const componentLimit = Number(declaration?.[1]?.replaceAll('_', ''));
    expect(componentLimit).toBeGreaterThan(0);
    expect(componentLimit).toBeLessThanOrEqual(4_096);
    expect([...source.matchAll(/\bMAX_PATCH_PATH_COMPONENTS\b/g)].length).toBeGreaterThan(1);

    const editInput = (await import(
      pathToFileURL(path.join(hooksDir, 'lib', 'edit-input.mjs')).href
    )) as {
      editFragments(input: unknown): Array<{
        filePath: string;
        fragment: string;
        inspectionRefusal?: string;
        appliesToAll?: boolean;
      }>;
    };
    const componentsPerSection = Math.min(32, componentLimit);
    const sectionCount = Math.floor(componentLimit / componentsPerSection) + 1;
    const sections = Array.from({ length: sectionCount }, (_, section) => {
      const components = Array.from(
        { length: componentsPerSection },
        (_unused, component) => `s${section}-${component}`,
      );
      components[components.length - 1] += '.ts';
      return [`*** Add File: ${components.join('/')}`, '+export {};'];
    }).flat();
    const fragments = editInput.editFragments({
      tool_name: 'apply_patch',
      cwd: repoRoot,
      tool_input: {
        command: [
          '*** Begin Patch',
          ...sections,
          '*** Add File: ../../must-not-resolve-after-component-budget.ts',
          '+export {};',
          '*** End Patch',
        ].join('\n'),
      },
    });
    const refusals = fragments.filter(({ inspectionRefusal }) => inspectionRefusal);

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ appliesToAll: true });
    expect(refusals[0]?.inspectionRefusal).toMatch(
      /(?:path|destination).*component.*(?:budget|limit)|(?:budget|limit).*component/i,
    );
    expect(refusals[0]?.inspectionRefusal).not.toMatch(/outside|cannot be resolved safely/i);
  });

  it('caps aggregate source inspection across many move sections', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-many-moves-'));
    const sections: string[] = [];

    try {
      for (let index = 0; index < 17; index += 1) {
        const source = path.join(scratch, `${index}.ts`);
        await writeFile(source, 'x'.repeat(64 * 1024));
        sections.push(
          `*** Update File: ${path.relative(repoRoot, source)}`,
          `*** Move to: packages/core/src/moved-${index}.ts`,
        );
      }
      const result = await runGuard(
        'guard-secret-file.mjs',
        ['*** Begin Patch', ...sections, '*** End Patch'].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/aggregate|total.*(?:move|inspection)|move.*budget/i);
    } finally {
      await removeFixture(scratch);
    }
  });

  it('does not inspect later move sources after refusing the aggregate moved-byte budget', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-move-budget-stop-'));
    const fullBudget = path.join(scratch, 'full-budget.ts');
    const overBudget = path.join(scratch, 'over-budget.ts');
    const laterDirectory = path.join(scratch, 'must-not-open');
    await writeFile(fullBudget, 'x'.repeat(1024 * 1024));
    await writeFile(overBudget, 'x');
    await mkdir(laterDirectory);

    try {
      const result = await runGuard(
        'guard-secret-file.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, fullBudget)}`,
          '*** Move to: packages/core/src/full-budget.ts',
          `*** Update File: ${path.relative(repoRoot, overBudget)}`,
          '*** Move to: packages/core/src/over-budget.ts',
          `*** Update File: ${path.relative(repoRoot, laterDirectory)}`,
          '*** Move to: packages/core/src/must-not-open.ts',
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/aggregate.*move|move.*aggregate/i);
      expect(result.stderr).not.toMatch(/not a regular file|cannot safely inspect moved file/i);
    } finally {
      await removeFixture(scratch);
    }
  });

  it('blocks a move whose patch context does not match its source', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-context-mismatch-'));
    const source = path.join(scratch, 'actual.ts');
    await writeFile(source, 'export const actual = true;\n');

    try {
      const result = await runGuard(
        'guard-secret-file.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          '*** Move to: packages/core/src/actual.ts',
          '@@',
          ' export const expected = true;',
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/context does not match/i);
    } finally {
      await removeFixture(scratch);
    }
  });

  it('blocks a move hunk that exceeds the hunk-line ceiling', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-hunk-lines-'));
    const source = path.join(scratch, 'small.ts');
    await writeFile(source, 'same\n');

    try {
      const result = await runGuard(
        'guard-secret-file.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          '*** Move to: packages/core/src/small.ts',
          '@@',
          ...Array.from({ length: 10_001 }, () => ' same'),
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/hunk.*(?:ceiling|limit)|(?:ceiling|limit).*hunk/i);
    } finally {
      await removeFixture(scratch);
    }
  });

  it('caps total hunk lines across one move', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-total-hunks-'));
    const source = path.join(scratch, 'small.ts');
    await writeFile(source, 'export {};\n');

    try {
      const additions = Array.from({ length: 6_000 }, () => '+const safe = true;');
      const result = await runGuard(
        'guard-secret-file.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          '*** Move to: packages/core/src/many-hunks.ts',
          '@@',
          ...additions,
          '@@',
          ...additions,
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/total.*hunk|hunk.*(?:total|budget)/i);
    } finally {
      await removeFixture(scratch);
    }
  });

  it('caps the total output lines produced by move inspection', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-output-lines-'));
    const source = path.join(scratch, 'many-lines.ts');
    await writeFile(source, `${Array.from({ length: 20_001 }, () => 'safe').join('\n')}\n`);

    try {
      const result = await runGuard(
        'guard-secret-file.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          '*** Move to: packages/core/src/many-lines.ts',
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/output.*(?:budget|limit)|(?:budget|limit).*output/i);
    } finally {
      await removeFixture(scratch);
    }
  });

  it('caps aggregate output lines across multiple move sections', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-aggregate-output-lines-'));
    const sections: string[] = [];

    try {
      for (let index = 0; index < 2; index += 1) {
        const source = path.join(scratch, `${index}.ts`);
        await writeFile(source, `${Array.from({ length: 10_001 }, () => 'safe').join('\n')}\n`);
        sections.push(
          `*** Update File: ${path.relative(repoRoot, source)}`,
          `*** Move to: packages/core/src/output-${index}.ts`,
        );
      }
      const result = await runGuard(
        'guard-secret-file.mjs',
        ['*** Begin Patch', ...sections, '*** End Patch'].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/aggregate.*output|output.*aggregate/i);
    } finally {
      await removeFixture(scratch);
    }
  });

  it('does not inspect later move sources after refusing the aggregate output-line budget', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-output-budget-stop-'));
    const first = path.join(scratch, 'first.ts');
    const overBudget = path.join(scratch, 'over-budget.ts');
    const laterDirectory = path.join(scratch, 'must-not-open');
    await writeFile(first, Array.from({ length: 10_000 }, () => 'safe').join('\n'));
    await writeFile(overBudget, Array.from({ length: 10_001 }, () => 'safe').join('\n'));
    await mkdir(laterDirectory);

    try {
      const result = await runGuard(
        'guard-secret-file.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, first)}`,
          '*** Move to: packages/core/src/output-first.ts',
          `*** Update File: ${path.relative(repoRoot, overBudget)}`,
          '*** Move to: packages/core/src/output-over-budget.ts',
          `*** Update File: ${path.relative(repoRoot, laterDirectory)}`,
          '*** Move to: packages/core/src/output-must-not-open.ts',
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/aggregate.*output|output.*aggregate/i);
      expect(result.stderr).not.toMatch(/not a regular file|cannot safely inspect moved file/i);
    } finally {
      await removeFixture(scratch);
    }
  });

  it('caps the number of splice operations across one move', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-splice-budget-'));
    const source = path.join(scratch, 'small.ts');
    await writeFile(source, 'export {};\n');

    try {
      const hunks = Array.from({ length: 1_001 }, () => ['@@', '+const safe = true;']).flat();
      const result = await runGuard(
        'guard-secret-file.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          '*** Move to: packages/core/src/many-splices.ts',
          ...hunks,
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/splice.*(?:budget|limit)|(?:budget|limit).*splice/i);
    } finally {
      await removeFixture(scratch);
    }
  });

  it('blocks a move when the context-comparison budget is exhausted', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-comparison-budget-'));
    const source = path.join(scratch, 'repetitive.ts');
    const content = `${Array.from({ length: 12_000 }, () => 'same').join('\n')}\n`;
    expect(Buffer.byteLength(content)).toBeLessThan(1024 * 1024);
    await writeFile(source, content);

    try {
      const result = await runGuard(
        'guard-secret-file.mjs',
        [
          '*** Begin Patch',
          `*** Update File: ${path.relative(repoRoot, source)}`,
          '*** Move to: packages/core/src/repetitive.ts',
          '@@',
          ...Array.from({ length: 4_999 }, () => ' same'),
          ' needle',
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/comparison.*(?:budget|limit)|(?:budget|limit).*comparison/i);
    } finally {
      await removeFixture(scratch);
    }
  });

  it('keeps move-inspection contracts mechanically self-contained in shipped code', async () => {
    const source = await text(hooksDir, 'lib', 'edit-input.mjs');
    expect(source).not.toMatch(/codex\.test\.ts|test[\\/]template/);

    for (const [name, value] of [
      ['MAX_PATCH_CHARACTERS', '1024 * 1024'],
      ['MAX_MOVED_FILE_BYTES', '1024 * 1024'],
      ['MAX_HUNK_LINES', '10_000'],
      ['MAX_CONTEXT_COMPARISONS', '2_000_000'],
    ]) {
      expect(source, `${name} must be declared in the shipped normalizer`).toContain(
        `const ${name} = ${value};`,
      );
      expect(
        [...source.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length,
        `${name} must be consumed by inspection behavior`,
      ).toBeGreaterThan(1);
    }

    const guards = await Promise.all(
      ['guard-secret-file.mjs', 'guard-secret-file.mjs'].map((guard) => text(hooksDir, guard)),
    );
    expect(source).toMatch(/inspectionRefusal:\s*reason/);
    for (const guard of guards) expect(guard).toMatch(/inspectionRefusal/);
  });

  it('removes the occurrence selected by the complete hunk, not the first matching line', async (ctx) => {
    skipUnless(ctx, needsGitRoot(repoRoot).ok, needsGitRoot(repoRoot).reason);
    const scratch = await mkdtemp(path.join(repoRoot, '.codex-exact-move-'));
    const source = path.join(scratch, 'duplicate.ts');
    await writeFile(
      source,
      [
        'const duplicate = true;',
        'const anchor = true;',
        'const duplicate = true;',
        'export {};',
        '',
      ].join('\n'),
    );

    try {
      const editInput = (await import(
        pathToFileURL(path.join(hooksDir, 'lib', 'edit-input.mjs')).href
      )) as {
        editFragments(input: unknown): Array<{ filePath: string; fragment: string }>;
      };
      const [move] = editInput.editFragments({
        tool_name: 'apply_patch',
        cwd: repoRoot,
        tool_input: {
          command: [
            '*** Begin Patch',
            `*** Update File: ${path.relative(repoRoot, source)}`,
            '*** Move to: packages/core/src/duplicate.ts',
            '@@',
            ' const anchor = true;',
            '-const duplicate = true;',
            ' export {};',
            '*** End Patch',
          ].join('\n'),
        },
      });

      expect(move?.fragment).toBe(
        ['const duplicate = true;', 'const anchor = true;', 'export {};', ''].join('\n'),
      );
    } finally {
      await removeFixture(scratch);
    }
  });
});

describe('Codex oversized apply_patch inspection refusals', () => {
  it.each([
    {
      guard: 'guard-secret-file.mjs',
      falseDiagnosis:
        /credential file|credential value|writes a credential|repository never carries one/i,
    },
  ])(
    '$guard blocks with a neutral, actionable size-limit refusal',
    async ({ guard, falseDiagnosis }) => {
      const result = await runGuard(
        guard,
        [
          '*** Begin Patch',
          '*** Add File: docs/big.md',
          `+${'x'.repeat(1024 * 1024 + 1)}`,
          '*** End Patch',
        ].join('\n'),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/BLOCKED — cannot safely inspect/i);
      expect(result.stderr).toMatch(/1048576-character inspection limit/i);
      expect(result.stderr).toMatch(/split|smaller patch/i);
      expect(result.stderr).not.toMatch(falseDiagnosis);
    },
  );
});
