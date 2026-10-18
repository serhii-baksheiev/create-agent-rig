// PreToolUse hook: the pre-commit gate may not be bypassed. A red check is a
// signal to fix, never to silence — so `--no-verify` (and `git commit -n`) is
// refused at the tool layer.
//
// Contract (Claude Code): JSON on stdin; exit 0 = allow, exit 2 = block, and
// stderr is shown to the agent as the reason.
//
// It shares the Never-tier tokenizer so quoted heredoc bodies remain prose and
// follows shell `-c` without executing dynamic command text.
// Static scope: literal Git options, shell `-c` payloads and direct `$()` forms.
// Script inspection ends beyond depth 16; the shared tokenizer can inspect
// literal bodies as commands beyond its 32-heredoc budget. Aliases, dynamically
// assembled commands and general shell expansion remain outside this parser.
// Persistent hook configuration is read in this hook's current repository;
// command-local cwd/Git environment changes are not resolved. A usable hook
// path is a preflight, never proof that a later commit executed its checks.
import { execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { commandOf, evaluatedSubstitutions, shellScript, tokenize } from './guard-bash.mjs';
import { readHookInput, refusalText, shellCommandOf } from './lib/hook-input.mjs';
import { withoutGitLocation } from '../scripts/git-env.mjs';
import { SHELL_TOOLS } from '../scripts/lib/shell-tools.mjs';

const refusal =
  'BLOCKED — bypassing pre-commit checks is never allowed. ' +
  'If a check fails, fix the failure (or stop and report why it cannot be fixed); ' +
  'see .claude/rules/workflow.md.';

const operationOf = (args) => {
  const index = args.findIndex(({ value }) => value === 'commit' || value === 'push');
  return index === -1 ? null : { index, value: args[index].value };
};

const bypassesOperation = (args, operation) => {
  for (let index = operation.index + 1; index < args.length; index += 1) {
    const value = args[index].value;
    if (value === '--') return false;
    if (value === '--no-verify') return true;
    if (value === '-m' || value === '--message') {
      index += 1;
      continue;
    }
    if (operation.value !== 'commit' || !/^-[A-Za-z]/.test(value)) continue;
    for (const flag of value.slice(1)) {
      if (flag === 'm') break;
      if (flag === 'n') return true;
    }
  }
  return false;
};

const hasInlineHooksPath = (args, operation) => {
  for (let index = 0; index < operation.index; index += 1) {
    const value = args[index].value;
    if (value === '-c' && args[index + 1]?.value.startsWith('core.hooksPath=')) return true;
    if (value.startsWith('-ccore.hooksPath=')) return true;
  }
  return false;
};

const huskyDisabled = (segment) => {
  const gitIndex = segment.findIndex(({ value }) => value.split('/').pop() === 'git');
  return gitIndex !== -1 && segment.slice(0, gitIndex).some(({ value }) => value === 'HUSKY=0');
};

const configuredHooksAreUsable = () => {
  const gitOptions = {
    env: withoutGitLocation(),
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  let hooksPath;
  try {
    hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], gitOptions).replace(/\r?\n$/, '');
  } catch (error) {
    if (error.status === 1) return null;
    return 'BLOCKED — Git hook configuration could not be read safely.';
  }
  try {
    if (!hooksPath) throw new Error('empty hooks path');
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], gitOptions).replace(/\r?\n$/, '');
    const preCommit = resolve(root, hooksPath, 'pre-commit');
    if (!statSync(preCommit).isFile()) throw new Error('pre-commit is not a file');
    accessSync(preCommit, constants.X_OK);
  } catch {
    return 'BLOCKED — Configured Git hooks do not provide a usable pre-commit hook.';
  }
  return null;
};

const inspect = (raw, depth = 0) => {
  if (depth > 16) return null;
  for (const segment of tokenize(raw)) {
    let command = commandOf(segment);
    if (command.name === 'if') command = commandOf(command.args);
    if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(command.name)) {
      const script = shellScript(command.args);
      if (script) {
        const nested = inspect(script, depth + 1);
        if (nested) return nested;
      }
      continue;
    }
    if (command.name !== 'git' && command.name !== 'git.exe') continue;
    const operation = operationOf(command.args);
    if (!operation) continue;
    if (huskyDisabled(segment) || hasInlineHooksPath(command.args, operation) || bypassesOperation(command.args, operation)) {
      return refusal;
    }
    if (operation.value === 'commit') {
      const configuration = configuredHooksAreUsable();
      if (configuration) return configuration;
    }
  }
  for (const script of evaluatedSubstitutions(raw)) {
    const nested = inspect(script, depth + 1);
    if (nested) return nested;
  }
  return null;
};

function main() {
  const input = readHookInput();
  if (input === null) return 0;
  // One list, not a literal: this hook was launched for every shell surface
  // and then excused itself from all but Bash, so the pre-commit gate stayed
  // bypassable on the other one.
  if (!SHELL_TOOLS.includes(input.tool_name)) return 0;
  // Three outcomes, from the one shared contract (RP-80). `String(argv)` used
  // to stand here, and it did not merely fail to read an array — it produced a
  // plausible-looking string: `["git","commit","--no-verify"]` became
  // `git,commit,--no-verify`, where the tokeniser below never splits on a comma,
  // so the one flag this hook exists to refuse was silently absent. A guard that
  // converts what it cannot read into something it can is worse than one that
  // refuses, because it reports a check it did not perform.
  const parsed = shellCommandOf(input);
  if (parsed.kind === 'unreadable') {
    process.stderr.write(`${refusalText(parsed)}\n`);
    return 2;
  }
  // Positive test, not a list of the others: a member added later must not
  // reach `raw.replace(…)` below with `undefined`, which throws, exits 1, and
  // is read as allow.
  if (parsed.kind !== 'string') return 0;
  const raw = parsed.command;

  const reason = inspect(raw);
  if (reason) {
    process.stderr.write(`${reason}\n`);
    return 2;
  }
  return 0;
}

process.exit(main());
