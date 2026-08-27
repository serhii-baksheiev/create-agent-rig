// Codex adapter for the Claude Code-shaped Agent OS templates.
//
// Claude files remain the authoring surface. This script derives Codex-native
// repository guidance, skills, custom agents and hook wiring so both harnesses
// execute the same operating system without two hand-maintained rulebooks.
//
//   node scripts/sync-codex-adapter.mjs           # write derived files
//   node scripts/sync-codex-adapter.mjs --check   # report drift only
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentOsRoot = path.join(repoRoot, 'templates', 'agent-os');

const slash = (value) => value.replaceAll('\\', '/');

function layerDirs() {
  const dirs = [path.join(agentOsRoot, 'universal'), path.join(agentOsRoot, 'init')];
  const stackRoot = path.join(agentOsRoot, 'stack');
  if (existsSync(stackRoot)) {
    for (const entry of readdirSync(stackRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(stackRoot, entry.name));
    }
  }
  return dirs;
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
  return { name, description, tools: fields.get('tools') ?? '', body: match[2].trim() };
}

function codexAgent(markdown, source) {
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
    `sandbox_mode = ${JSON.stringify(sandbox)}`,
    `developer_instructions = ${JSON.stringify(agent.body)}`,
    '',
  ].join('\n');
}

function portableHookCommand(command) {
  const hook = command.match(/\.claude\/hooks\/[A-Za-z0-9._-]+\.mjs/)?.[0];
  if (!hook) throw new Error(`cannot derive a portable Codex hook command from: ${command}`);
  return `repoRoot="$(git rev-parse --show-toplevel)" && CLAUDE_PROJECT_DIR="$repoRoot" node "$repoRoot/${hook}"`;
}

function windowsHookCommand(command) {
  const hook = command.match(/\.claude\/hooks\/[A-Za-z0-9._-]+\.mjs/)?.[0];
  if (!hook) throw new Error(`cannot derive a Windows Codex hook command from: ${command}`);
  const script = [
    '$repoRoot = git rev-parse --show-toplevel',
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    '$env:CLAUDE_PROJECT_DIR = $repoRoot',
    `$hookPath = Join-Path $repoRoot '${hook}'`,
    '& node $hookPath',
    'exit $LASTEXITCODE',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
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
    hooks[event] = groups.map((group) => {
      const matcherTools =
        typeof group.matcher === 'string'
          ? group.matcher.split('|').map((tool) => tool.trim())
          : [];
      const matcher =
        matcherTools.some((tool) => tool === 'Write' || tool === 'Edit') &&
        !matcherTools.includes('apply_patch')
          ? `${group.matcher}|apply_patch`
          : group.matcher;
      return {
        ...group,
        ...(typeof matcher === 'string' ? { matcher } : {}),
        hooks: group.hooks.map((hook) => {
          const command = portableHookCommand(hook.command);
          return { ...hook, command, commandWindows: windowsHookCommand(hook.command) };
        }),
      };
    });
  }
  return `${JSON.stringify(
    { description: 'Codex adapter generated from .claude/settings.json.', hooks },
    null,
    2,
  )}\n`;
}

function expectedFiles() {
  const expected = new Map();
  for (const layer of layerDirs()) {
    const claudeMd = path.join(layer, 'CLAUDE.md');
    if (existsSync(claudeMd)) {
      expected.set(path.join(layer, 'AGENTS.md'), readFileSync(claudeMd, 'utf8'));
    }

    const claudeSkills = path.join(layer, '.claude', 'skills');
    for (const source of walk(claudeSkills)) {
      const rel = path.relative(claudeSkills, source);
      expected.set(path.join(layer, '.agents', 'skills', rel), readFileSync(source, 'utf8'));
    }

    const claudeAgents = path.join(layer, '.claude', 'agents');
    for (const source of walk(claudeAgents)) {
      if (path.extname(source) !== '.md') continue;
      const name = `${path.basename(source, '.md')}.toml`;
      expected.set(
        path.join(layer, '.codex', 'agents', name),
        codexAgent(readFileSync(source, 'utf8'), source),
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
  return expected;
}

function generatedFiles() {
  const files = [];
  for (const layer of layerDirs()) {
    const agentsMd = path.join(layer, 'AGENTS.md');
    if (existsSync(agentsMd)) files.push(agentsMd);
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
    return;
  }

  for (const layer of layerDirs()) {
    rmSync(path.join(layer, '.agents'), { recursive: true, force: true });
    rmSync(path.join(layer, '.codex'), { recursive: true, force: true });
    rmSync(path.join(layer, 'AGENTS.md'), { force: true });
  }
  for (const [target, content] of expected) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    console.log(`synced ${slash(path.relative(repoRoot, target))}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    syncCodexAdapters({ check: process.argv.includes('--check') });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
