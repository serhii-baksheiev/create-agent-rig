// Codex adapter for the Claude Code-shaped Agent OS templates.
//
// Claude files remain the authoring surface for skills, custom agents and
// hook wiring. This script derives their Codex-native equivalents so both
// harnesses execute the same operating system without two hand-maintained
// copies of each. The rulebook itself is authored directly in AGENTS.md, not
// derived here or anywhere else — see docs/decisions/agents-md-canonical.md
// (RP-186).
//
// Subagent routing is read from the one policy both harnesses share
// (`templates/agent-os/subagent-routing.json`, through `subagent-routing.mjs`):
// the Codex profiles are derived from it, and the Claude agent frontmatter and
// shipped settings are checked against it before anything is projected.
//
//   node scripts/sync-codex-adapter.mjs           # write derived files
//   node scripts/sync-codex-adapter.mjs --check   # report drift only
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROUTING_POLICY_PATH,
  codexProfilesOf,
  validateClaudeAgents,
  validateClaudeSettings,
  validateRoutingPolicy,
} from './subagent-routing.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentOsRoot = path.join(repoRoot, 'templates', 'agent-os');
const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

/**
 * Hooks that act on a Claude Code surface Codex does not have, so they are not
 * projected: `guard-subagent-model` judges the Claude `Agent` tool's call-site
 * `model`, and `warn-subagent-routing` reads Claude Code's own environment.
 * Wiring them into `.codex/hooks.json` would declare enforcement that never runs.
 */
const CLAUDE_ONLY_HOOKS = new Set(['guard-subagent-model.mjs', 'warn-subagent-routing.mjs']);

/**
 * RP-266: these four guards' Windows wrapper had three unbounded waits (`git
 * rev-parse --show-toplevel`, the stdin copy, `$child.WaitForExit()`) and no
 * `timeout` in `.claude/settings.json`, so a host stall on any of them ended
 * only at the harness's own default hook timeout — which resolves to ALLOW
 * (docs/decisions/fail-open-guards.md). Each stage below now carries an
 * explicit millisecond bound and kills the whole process tree on expiry.
 */
const BOUNDED_STAGE_GUARDS = new Set([
  'guard-secret-file.mjs',
  'guard-rulebook.mjs',
  'block-no-verify.mjs',
  'guard-bash.mjs',
]);

// RP-266 follow-up (round 2): git rev-parse is a fast local operation and
// keeps its own tight bound. The stdin copy and the guard's own run share
// ONE deadline instead — headroom for guard latency under load, without a
// separate unmeasured figure for each half — tracked by a stopwatch so the
// guard wait gets whatever the stdin copy did not spend. The projected
// `.codex/hooks.json` timeout (see `codexHooks` below) stays above the sum
// of both, so the outer wiring never kills the wrapper before it can report
// its own stage's timeout.
const GIT_DEFAULT_MS = 5_000;
const GUARD_DEADLINE_MS = 35_000;

/**
 * `.claude/settings.json` carries no `timeout` for these four guards — one
 * there would SHORTEN Claude Code's own 600 s default hook-kill point rather
 * than lengthen it, and a kill is an allow (`docs/decisions/fail-open-guards.md`).
 * The Codex projection has no such default of its own to preserve, so
 * `codexHooks` below adds this explicitly: comfortably above
 * `GIT_DEFAULT_MS + GUARD_DEADLINE_MS` (40 s) plus PowerShell's own startup
 * cost.
 */
const BOUNDED_STAGE_HOOKS_TIMEOUT_SECONDS = 90;

const slash = (value) => value.replaceAll('\\', '/');

// RP-177 retired the `init` override layer and the per-stack overlays — there
// is exactly one payload now, and this is its one source directory.
function layerDirs() {
  return [path.join(agentOsRoot, 'universal')];
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  visit(dir);
  return files;
}

function parseAgent(markdown, source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
  if (!match) throw new Error(`agent has no frontmatter: ${source}`);
  const fields = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator > 0)
      fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const name = fields.get('name');
  const description = fields.get('description');
  if (!name || !description) throw new Error(`agent is missing name or description: ${source}`);
  return {
    name,
    description,
    tools: fields.get('tools') ?? '',
    model: fields.get('model'),
    effort: fields.get('effort'),
    body: match[2].trim(),
  };
}

function validateProfile(profile, label) {
  if (!profile || typeof profile.model !== 'string' || profile.model.trim() === '') {
    throw new Error(`Codex agent profile ${label} is missing model`);
  }
  if (!REASONING_EFFORTS.has(profile.effort)) {
    throw new Error(`Codex agent profile ${label} has unsupported effort: ${profile.effort}`);
  }
}

export function validateAgentProfiles(policy, sourceAgents) {
  validateProfile(policy.default, 'default');
  if (!policy.agents || typeof policy.agents !== 'object' || Array.isArray(policy.agents)) {
    throw new Error('Codex agent profiles are missing the agents map');
  }
  for (const [name, profile] of Object.entries(policy.agents)) validateProfile(profile, name);

  const sourceNames = new Set();
  for (const { name, source } of sourceAgents) {
    if (!policy.agents[name])
      throw new Error(`Codex agent profile is missing for ${name}: ${source}`);
    if (sourceNames.has(name))
      throw new Error(`Codex agent name is duplicated across layers: ${name}`);
    sourceNames.add(name);
  }
  const orphanProfiles = Object.keys(policy.agents).filter((name) => !sourceNames.has(name));
  if (orphanProfiles.length > 0) {
    throw new Error(`Codex agent profiles have no source agent: ${orphanProfiles.join(', ')}`);
  }
  return policy;
}

/** The routing policy, checked against every Claude surface it pins; returns the Codex view. */
function loadAgentProfiles(sourceAgents) {
  const policy = validateRoutingPolicy(JSON.parse(readFileSync(ROUTING_POLICY_PATH, 'utf8')));
  validateClaudeAgents(policy, sourceAgents);
  validateClaudeSettings(
    policy,
    JSON.parse(
      readFileSync(path.join(agentOsRoot, 'universal', '.claude', 'settings.json'), 'utf8'),
    ),
  );
  return validateAgentProfiles(codexProfilesOf(policy), sourceAgents);
}

function codexAgent(markdown, source, profile) {
  const agent = parseAgent(markdown, source);
  const tools = (agent.tools ?? '')
    .split(',')
    .map((tool) => tool.trim())
    .filter(Boolean);
  const sandbox = tools.some((tool) => /^(Write|Edit|NotebookEdit|apply_patch)$/.test(tool))
    ? 'workspace-write'
    : 'read-only';
  return [
    `name = ${JSON.stringify(agent.name)}`,
    `description = ${JSON.stringify(agent.description)}`,
    `model = ${JSON.stringify(profile.model)}`,
    `model_reasoning_effort = ${JSON.stringify(profile.effort)}`,
    `sandbox_mode = ${JSON.stringify(sandbox)}`,
    `developer_instructions = ${JSON.stringify(agent.body)}`,
    '',
  ].join('\n');
}

const hookFileOf = (command) => command.match(/\.claude\/hooks\/([A-Za-z0-9._-]+\.mjs)/)?.[1];

/**
 * Any hook whose Claude command carries the argv flag `--harness=claude` has
 * it rewritten to `--harness=codex` in the projection — Codex is a different
 * harness, so the flag is never carried over verbatim. Detected from the
 * command text itself, not a per-hook name list: RP-225 slice 2 introduced
 * this for `record-dispatch.mjs` alone; RP-415 added `probity-gate.mjs`
 * carrying the same flag, and a name list would need one more entry every
 * time another hook adopts it. A hook that takes no such flag never matches,
 * so `portableHookCommand`/`windowsHookCommand` leave it untouched exactly as
 * before.
 */
const carriesClaudeHarnessFlag = (hook) => hook.includes('--harness=claude');

function portableHookCommand(command) {
  const hook = command.match(/\.claude\/hooks\/[A-Za-z0-9._-]+\.mjs/)?.[0];
  if (!hook) throw new Error(`cannot derive a portable Codex hook command from: ${command}`);
  const base = `repoRoot="$(git rev-parse --show-toplevel)" && CLAUDE_PROJECT_DIR="$repoRoot" node "$repoRoot/${hook}"`;
  return carriesClaudeHarnessFlag(command) ? `${base} --harness=codex` : base;
}

function windowsHookCommand(command) {
  const hook = command.match(/\.claude\/hooks\/[A-Za-z0-9._-]+\.mjs/)?.[0];
  if (!hook) throw new Error(`cannot derive a Windows Codex hook command from: ${command}`);
  const argumentsLine = carriesClaudeHarnessFlag(command)
    ? "$startInfo.Arguments = '\"' + $hookPath + '\" --harness=codex'"
    : "$startInfo.Arguments = '\"' + $hookPath + '\"'";
  const bounded = BOUNDED_STAGE_GUARDS.has(hookFileOf(command));
  // PowerShell owns its stdin, so `& node` receives an empty stream. Copy the
  // original bytes into a child process explicitly; parsing and re-encoding the
  // JSON here would make the wrapper a second implementation of the hook input.
  const script = bounded
    ? [
        "$ErrorActionPreference = 'Stop'",
        // PR #353 round 2: a native command's stderr, redirected under this
        // preference, becomes a terminating NativeCommandError — including
        // PowerShell's own CLIXML progress noise, which SilentlyContinue
        // suppresses at the source instead of relying on every redirect to
        // catch it.
        "$ProgressPreference = 'SilentlyContinue'",
        // `$env:RIG_CODEX_WRAPPER_TIMEOUT_MS` is a test-only knob that can
        // only LOWER a stage's own bound, selected through `[Math]::Min(...)`
        // alone — never a comparison that could raise one. A malformed or
        // absent value must never throw and must never fall through to a
        // production `[int]` cast that could overflow, so it is validated by
        // shape (1-9 digits) before any cast, and `$rigMs` stays at the
        // largest possible value otherwise, so `[Math]::Min` always keeps
        // each stage's own default.
        '$rigRaw = $env:RIG_CODEX_WRAPPER_TIMEOUT_MS',
        '$rigMs = [int]::MaxValue',
        // RP-266 round 3 advisory: .NET's `$` anchor (unlike JS's) also
        // matches just before a single trailing `\n`, so a bare
        // `^[0-9]{1,9}$` would accept "3000`n" as valid. `\z` matches only
        // the true end of the string, with no such exception.
        "if ($rigRaw -match '^[0-9]{1,9}\\z') { $rigMs = [int]$rigRaw }",
        `$gitDefaultMs = ${GIT_DEFAULT_MS}`,
        '$gitBoundMs = [Math]::Min($gitDefaultMs, $rigMs)',
        // PR #353 round 1 resolved git through `cmd.exe /c`, which risks a
        // cwd lookup and the user's own AutoRun; ComSpec with `/d` (skip
        // AutoRun) is the documented safer form of the same idea.
        '$gitInfo = New-Object System.Diagnostics.ProcessStartInfo',
        '$gitInfo.FileName = $env:ComSpec',
        "$gitInfo.Arguments = '/d /c git rev-parse --show-toplevel'",
        '$gitInfo.UseShellExecute = $false',
        '$gitInfo.RedirectStandardOutput = $true',
        // PR #353 round 3 SECURITY blocker (code-reviewer, security-scanner):
        // cmd.exe resolves a bare command name (`git`) in the CURRENT
        // DIRECTORY first, ahead of PATH, unless this is set — so a text
        // `git.cmd` planted at the wrapper's own cwd could replace `git`
        // itself and, through it, `$repoRoot`. This governs the CHILD
        // cmd.exe's own environment, so it is set on ProcessStartInfo,
        // before that child starts.
        "$gitInfo.EnvironmentVariables['NoDefaultCurrentDirectoryInExePath'] = '1'",
        '$gitProc = [System.Diagnostics.Process]::Start($gitInfo)',
        '$gitOk = $gitProc.WaitForExit($gitBoundMs)',
        // PR #353 round 1 blocker (code-reviewer, security-scanner): a kill
        // run bare under `$ErrorActionPreference = 'Stop'` turned an
        // already-exited process's stderr into a terminating error the
        // wrapper never caught, so it exited 1 — which Codex reads as
        // non-blocking. The kill is now the ONLY thing inside the try; the
        // report and `exit 2` run unconditionally once a bound has expired,
        // never inside the catch.
        'if (-not $gitOk) { try { taskkill /PID $gitProc.Id /T /F 2>&1 | Out-Null } catch {}; [Console]::Error.WriteLine("codex wrapper: git rev-parse timed out after $gitBoundMs ms"); exit 2 }',
        '$repoRoot = $gitProc.StandardOutput.ReadToEnd().Trim()',
        'if ($gitProc.ExitCode -ne 0) { exit $gitProc.ExitCode }',
        '$env:CLAUDE_PROJECT_DIR = $repoRoot',
        `$hookPath = Join-Path $repoRoot '${hook}'`,
        '$startInfo = New-Object System.Diagnostics.ProcessStartInfo',
        "$startInfo.FileName = 'node'",
        argumentsLine,
        '$startInfo.UseShellExecute = $false',
        '$startInfo.RedirectStandardInput = $true',
        // `node` is a bare FileName here, resolved by CreateProcess/SearchPath
        // in the WRAPPER's (powershell.exe's) OWN process environment — not
        // the child's, and not $startInfo.EnvironmentVariables, which only
        // governs the started child. A planted `node.exe` in the working
        // directory is the same class of hijack as the git.cmd one above.
        "$env:NoDefaultCurrentDirectoryInExePath = '1'",
        '$child = [System.Diagnostics.Process]::Start($startInfo)',
        // The stdin copy and the guard's own run share ONE deadline: a
        // stopwatch tracks what the copy actually spent, and the guard wait
        // gets whatever is left, rather than each half carrying its own
        // separate, unmeasured figure.
        `$guardDeadlineMs = ${GUARD_DEADLINE_MS}`,
        '$guardBudgetMs = [Math]::Min($guardDeadlineMs, $rigMs)',
        '$guardStopwatch = [System.Diagnostics.Stopwatch]::StartNew()',
        '$copyTask = [Console]::OpenStandardInput().CopyToAsync($child.StandardInput.BaseStream)',
        // PR #353 round 3 advisory: if the guard exits before draining a
        // large stdin write, the pipe closes on the child's end and
        // `$copyTask.Wait` FAULTS — calling `.Wait` on a faulted Task
        // re-throws synchronously, which under `$ErrorActionPreference =
        // 'Stop'` is an unhandled terminating error the wrapper never
        // caught, so it exited 1 instead of the guard's own (already
        // rendered) exit code. The catch falls through to the child's own
        // wait instead — the child has, after all, already exited, which is
        // WHY the copy faulted — never reporting it as a stdin timeout.
        'try { $stdinOk = $copyTask.Wait($guardBudgetMs) } catch { $stdinOk = $true }',
        'if (-not $stdinOk) { try { taskkill /PID $child.Id /T /F 2>&1 | Out-Null } catch {}; [Console]::Error.WriteLine("codex wrapper: stdin timed out after $guardBudgetMs ms"); exit 2 }',
        '$child.StandardInput.Close()',
        '$guardRemainingMs = [Math]::Max(0, $guardBudgetMs - $guardStopwatch.ElapsedMilliseconds)',
        '$guardOk = $child.WaitForExit($guardRemainingMs)',
        // PR #353 round 3 blocker: this message must report the CONFIGURED
        // bound ($guardBudgetMs, the shared deadline lowered by
        // [Math]::Min against any override), not $guardRemainingMs — the
        // time actually left after the stdin copy, which is always a few ms
        // below the configured bound once the copy has spent any time at
        // all.
        'if (-not $guardOk) { try { taskkill /PID $child.Id /T /F 2>&1 | Out-Null } catch {}; [Console]::Error.WriteLine("codex wrapper: guard timed out after $guardBudgetMs ms"); exit 2 }',
        'exit $child.ExitCode',
      ]
    : [
        "$ErrorActionPreference = 'Stop'",
        '$repoRoot = git rev-parse --show-toplevel',
        'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        '$env:CLAUDE_PROJECT_DIR = $repoRoot',
        `$hookPath = Join-Path $repoRoot '${hook}'`,
        '$startInfo = New-Object System.Diagnostics.ProcessStartInfo',
        "$startInfo.FileName = 'node'",
        argumentsLine,
        '$startInfo.UseShellExecute = $false',
        '$startInfo.RedirectStandardInput = $true',
        '$child = [System.Diagnostics.Process]::Start($startInfo)',
        '[Console]::OpenStandardInput().CopyTo($child.StandardInput.BaseStream)',
        '$child.StandardInput.Close()',
        '$child.WaitForExit()',
        'exit $child.ExitCode',
      ];
  const encoded = Buffer.from(script.join('; '), 'utf16le').toString('base64');
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

function codexHooks(settings) {
  // Codex reports shell and unified-exec hook input as `Bash`, preserves
  // lifecycle event names such as Stop and SessionStart, and reports canonical
  // `apply_patch` input even when its Edit/Write matcher aliases select it. Keep
  // the Claude aliases and add the canonical edit spelling so the generated
  // wiring states the input guards receive. See https://learn.chatgpt.com/docs/hooks.
  const source = JSON.parse(settings);
  const hooks = {};
  for (const [event, groups] of Object.entries(source.hooks ?? {})) {
    const projected = groups.flatMap((group) => {
      const kept = group.hooks.filter((hook) => !CLAUDE_ONLY_HOOKS.has(hookFileOf(hook.command)));
      if (kept.length === 0) return [];
      const matcherTools =
        typeof group.matcher === 'string'
          ? group.matcher.split('|').map((tool) => tool.trim())
          : [];
      const matcher =
        matcherTools.some((tool) => tool === 'Write' || tool === 'Edit') &&
        !matcherTools.includes('apply_patch')
          ? `${group.matcher}|apply_patch`
          : group.matcher;
      return [
        {
          ...group,
          ...(typeof matcher === 'string' ? { matcher } : {}),
          hooks: kept.map((hook) => {
            const command = portableHookCommand(hook.command);
            const projected = {
              ...hook,
              command,
              commandWindows: windowsHookCommand(hook.command),
            };
            // Added by the projection itself, never spread from the Claude
            // source — see BOUNDED_STAGE_HOOKS_TIMEOUT_SECONDS above.
            if (BOUNDED_STAGE_GUARDS.has(hookFileOf(hook.command))) {
              projected.timeout = BOUNDED_STAGE_HOOKS_TIMEOUT_SECONDS;
            }
            return projected;
          }),
        },
      ];
    });
    if (projected.length > 0) hooks[event] = projected;
  }
  return `${JSON.stringify(
    { description: 'Codex adapter generated from .claude/settings.json.', hooks },
    null,
    2,
  )}\n`;
}

function expectedFiles() {
  const expected = new Map();
  const sourceAgents = layerDirs().flatMap((layer) => {
    const claudeAgents = path.join(layer, '.claude', 'agents');
    return walk(claudeAgents)
      .filter((source) => path.extname(source) === '.md')
      .map((source) => ({ ...parseAgent(readFileSync(source, 'utf8'), source), source }));
  });
  const policy = loadAgentProfiles(sourceAgents);
  for (const layer of layerDirs()) {
    // RP-186: AGENTS.md is authored source, not a Codex projection of
    // CLAUDE.md — it is the canonical, provider-neutral rulebook, and
    // CLAUDE.md is the shim that imports it. Neither file is generated by
    // this adapter; both are plain tree files under `layer`, so there is no
    // `expected` entry for either here.

    const claudeSkills = path.join(layer, '.claude', 'skills');
    for (const source of walk(claudeSkills)) {
      const rel = path.relative(claudeSkills, source);
      expected.set(path.join(layer, '.agents', 'skills', rel), readFileSync(source, 'utf8'));
    }

    const claudeAgents = path.join(layer, '.claude', 'agents');
    for (const source of walk(claudeAgents)) {
      if (path.extname(source) !== '.md') continue;
      const name = `${path.basename(source, '.md')}.toml`;
      const agent = parseAgent(readFileSync(source, 'utf8'), source);
      const profile = policy.agents[agent.name];
      expected.set(
        path.join(layer, '.codex', 'agents', name),
        codexAgent(readFileSync(source, 'utf8'), source, profile),
      );
    }

    const settings = path.join(layer, '.claude', 'settings.json');
    if (existsSync(settings)) {
      expected.set(
        path.join(layer, '.codex', 'hooks.json'),
        codexHooks(readFileSync(settings, 'utf8')),
      );
    }
  }
  expected.set(
    path.join(agentOsRoot, 'universal', '.codex', 'config.toml'),
    [
      '[agents]',
      `default_subagent_model = ${JSON.stringify(policy.default.model)}`,
      `default_subagent_reasoning_effort = ${JSON.stringify(policy.default.effort)}`,
      '',
    ].join('\n'),
  );
  return expected;
}

function generatedFiles() {
  const files = [];
  for (const layer of layerDirs()) {
    // AGENTS.md is authored source (RP-186) — it is never in this list, and
    // never removed by the cleanup pass below.
    files.push(...walk(path.join(layer, '.agents')));
    files.push(...walk(path.join(layer, '.codex')));
  }
  return files;
}

export function syncCodexAdapters({ check = false } = {}) {
  const expected = expectedFiles();
  const drifted = [];
  const expectedPaths = new Set([...expected.keys()].map((target) => path.resolve(target)));

  for (const [target, content] of expected) {
    if (!existsSync(target) || readFileSync(target, 'utf8') !== content) drifted.push(target);
  }
  for (const target of generatedFiles()) {
    if (!expectedPaths.has(path.resolve(target))) drifted.push(target);
  }

  if (check) {
    if (drifted.length > 0) {
      throw new Error(
        `Codex adapter drift detected in:\n${drifted
          .map((file) => `  - ${slash(path.relative(repoRoot, file))}`)
          .join('\n')}\nRun: node scripts/sync-codex-adapter.mjs`,
      );
    }
    console.log(`Codex adapter is in sync (${expected.size} files checked)`);
    return;
  }

  for (const layer of layerDirs()) {
    rmSync(path.join(layer, '.agents'), { recursive: true, force: true });
    rmSync(path.join(layer, '.codex'), { recursive: true, force: true });
  }
  for (const [target, content] of expected) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    console.log(`synced ${slash(path.relative(repoRoot, target))}`);
  }
}

// Node resolves the main module through symlinks and argv[1] keeps the path
// as typed, so both sides are compared as real paths (RP-24, macOS /var).
if (
  process.argv[1] &&
  realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    syncCodexAdapters({ check: process.argv.includes('--check') });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
