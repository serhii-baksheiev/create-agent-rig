// PreToolUse hook: the pre-commit gate may not be bypassed. A red check is a
// signal to fix, never to silence — so `--no-verify` (and `git commit -n`) is
// refused at the tool layer.
//
// Contract (Claude Code): JSON on stdin; exit 0 = allow, exit 2 = block, and
// stderr is shown to the agent as the reason.
//
// See test/template/no-verify-precision.test.ts (absent in a generated rig) ›
// "documents and retains the depth-16 literal shell inspection limit";
// "documents and retains the static-scope limits for aliases and runtime-assembled commands";
// "documents and retains the shared 32-heredoc tokenizer budget".
// Aliases, dynamically assembled commands, and general shell expansion remain
// outside this parser; the shared tokenizer has a 32-heredoc budget.
// Literal Git `-C`, `--git-dir`, and `--work-tree` values reach the bounded configuration preflight: see › "reads persistent hooksPath from literal -C targets, including a repeated relative target".
// A usable hook path is only a preflight: see › "uses a usable hooksPath only as a preflight and does not execute the proposed commit".
// Literal shell-state bounds are covered by › "keeps HUSKY state isolated between sibling and nested subshells";
// "carries an existing HUSKY value when export names it among literal operands";
// "carries exported HUSKY into substitutions at their lexical execution point"; and
// "keeps env-local HUSKY changes and literal prose out of the parent shell state".
// The same state reaches evaluated substitutions: see ›
// "carries bare and multioperand exported HUSKY=0 into evaluated substitutions";
// "uses restored or unset HUSKY state at the later substitution";
// "keeps single-quoted export prose out of later substitution state";
// "does not apply a post-header export before an unquoted heredoc body expands".
// Ordered env operations: see › "applies env unsets and assignments to Git in their literal order".
// Prefix boundary: see › "stops env assignments at the command instead of reading a commit message as one".
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

const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--config-env', '--git-dir', '--namespace', '--work-tree']);
const isGitConfigEnvironmentKey = (key) => /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key);

const cloneGitConfig = (configuration) =>
  Object.fromEntries(Object.entries(configuration).map(([key, value]) => [key, { ...value }]));

const inheritedGitConfig = () =>
  Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => isGitConfigEnvironmentKey(key))
      .map(([key, value]) => [key, { exported: true, value }]),
  );

const exportedGitConfig = (configuration) =>
  Object.fromEntries(
    Object.entries(configuration)
      .filter(([, { exported, value }]) => exported && value !== undefined)
      .map(([key, { value }]) => [key, value]),
  );

const childGitConfig = (configuration) =>
  Object.fromEntries(
    Object.entries(configuration)
      .filter(([, { exported }]) => exported)
      .map(([key, value]) => [key, { ...value }]),
  );

const environmentWithoutGitConfig = (environment) => {
  const withoutConfiguration = { ...environment };
  for (const key of Object.keys(withoutConfiguration)) {
    if (isGitConfigEnvironmentKey(key)) delete withoutConfiguration[key];
  }
  return withoutConfiguration;
};

const assignmentEntries = (segment) =>
  segment
    .map(({ value }) => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(value))
    .filter(Boolean)
    .map(([, key, value]) => [key, value]);

const operationOf = (args) => {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index].value;
    if (value === '--') return null;
    if (GIT_GLOBAL_VALUE_FLAGS.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith('-C') || value.startsWith('--git-dir=')) continue;
    if (value.startsWith('-')) continue;
    return value === 'commit' || value === 'push' ? { index, value } : null;
  }
  return null;
};

const contextOptions = (args, operation) => {
  const context = [];
  for (let index = 0; index < operation.index; index += 1) {
    const value = args[index].value;
    if (value === '-C' && args[index + 1]) {
      context.push('-C', args[index + 1].value);
      index += 1;
    } else if (value.startsWith('-C') && value.length > 2) {
      context.push('-C', value.slice(2));
    } else if ((value === '--git-dir' || value === '--work-tree') && args[index + 1]) {
      context.push(value, args[index + 1].value);
      index += 1;
    } else if (value.startsWith('--git-dir=') || value.startsWith('--work-tree=')) {
      context.push(value);
    }
  }
  return context;
};

const bypassesOperation = (args, operation) => {
  const shortValueFlags = new Set(['m', 'F', 'C', 'c', 't']);
  const requiredValueOptions = new Set([
    '--message',
    '--file',
    '--author',
    '--date',
    '--reedit-message',
    '--reuse-message',
    '--template',
    '--cleanup',
    '--trailer',
    '--fixup',
    '--squash',
    '--pathspec-from-file',
  ]);
  const attachedOnlyValueFlags = new Set(['u', 'S']);
  for (let index = operation.index + 1; index < args.length; index += 1) {
    const value = args[index].value;
    if (value === '--') return false;
    if (value === '--no-verify') return true;
    if (
      requiredValueOptions.has(value) ||
      value === '-m' ||
      value === '-F' ||
      value === '-C' ||
      value === '-c' ||
      value === '-t'
    ) {
      index += 1;
      continue;
    }
    if (operation.value !== 'commit' || !/^-[A-Za-z]/.test(value)) continue;
    for (let flagIndex = 0; flagIndex < value.length - 1; flagIndex += 1) {
      const flag = value[flagIndex + 1];
      if (shortValueFlags.has(flag)) break;
      if (attachedOnlyValueFlags.has(flag) && flagIndex + 2 < value.length) break;
      if (flag === 'n') return true;
    }
  }
  return false;
};

const commandEnvironmentOf = (segment, command, inheritedConfiguration) => {
  // `commandOf` preserves the original token objects in `args`, so the token
  // immediately before its first argument is the executable it actually chose.
  // Matching a basename in the whole segment mistakes `TOOL=/usr/bin/git` for
  // that executable and drops later assignments from the child environment.
  const commandIndex = segment.indexOf(command.args[0]) - 1;
  if (commandIndex === -1) return null;
  const effectiveEnv = {
    ...environmentWithoutGitConfig(process.env),
    ...exportedGitConfig(inheritedConfiguration),
  };
  const baselineEnv = { ...effectiveEnv };
  const configuration = childGitConfig(inheritedConfiguration);
  const context = [];
  let hasLocalGitConfiguration = false;
  let envCommand = false;
  for (let index = 0; index < commandIndex; index += 1) {
    const value = segment[index].value;
    if (value.split('/').pop() === 'env') {
      envCommand = true;
      continue;
    }
    if (envCommand && (value === '-i' || value === '--ignore-environment')) {
      for (const key of Object.keys(effectiveEnv)) delete effectiveEnv[key];
      for (const key of Object.keys(baselineEnv)) delete baselineEnv[key];
      for (const key of Object.keys(configuration)) delete configuration[key];
      continue;
    }
    if (envCommand && value === '-u' && segment[index + 1]) {
      const key = segment[index + 1].value;
      delete effectiveEnv[key];
      delete baselineEnv[key];
      if (isGitConfigEnvironmentKey(key)) delete configuration[key];
      index += 1;
      continue;
    }
    if (envCommand && value.startsWith('-u') && value.length > 2) {
      const key = value.slice(2);
      delete effectiveEnv[key];
      delete baselineEnv[key];
      if (isGitConfigEnvironmentKey(key)) delete configuration[key];
      continue;
    }
    if (envCommand && value === '-C' && segment[index + 1]) {
      context.push('-C', segment[index + 1].value);
      index += 1;
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(value);
    if (match) {
      effectiveEnv[match[1]] = match[2];
      if (isGitConfigEnvironmentKey(match[1])) {
        hasLocalGitConfiguration = true;
        configuration[match[1]] = { exported: true, value: match[2] };
      } else {
        baselineEnv[match[1]] = match[2];
      }
    }
  }
  return { effectiveEnv, baselineEnv, hasLocalGitConfiguration, configuration, context };
};

const hasInlineHooksPath = (args, operation) => {
  const isHooksPath = (value) => value.split('=', 1)[0].toLowerCase() === 'core.hookspath';
  for (let index = 0; index < operation.index; index += 1) {
    const value = args[index].value;
    if (value === '-c' && args[index + 1] && isHooksPath(args[index + 1].value)) return true;
    if (value.startsWith('-c') && isHooksPath(value.slice(2))) return true;
    if (value === '--config-env' && args[index + 1] && isHooksPath(args[index + 1].value)) return true;
    if (value.startsWith('--config-env=') && isHooksPath(value.slice('--config-env='.length))) return true;
  }
  return false;
};

const huskyAssignment = (segment, command) => {
  const commandIndex = command.name
    ? segment.findIndex(({ value }) => value.split('/').pop() === command.name)
    : segment.length;
  const match = segment
    .slice(0, commandIndex)
    .filter(({ value }) => /^HUSKY=([01])$/.test(value))
    .at(-1)?.value.match(/^HUSKY=([01])$/);
  return match ? match[1] === '0' : null;
};

const envHusky = (segment) => {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[index]?.value ?? '')) index += 1;
  while (segment[index]?.value === 'command') index += 1;
  if (segment[index]?.value.split('/').pop() !== 'env') return null;
  index += 1;
  let state = null;
  for (; index < segment.length; index += 1) {
    if (segment[index].value === '-i' || segment[index].value === '--ignore-environment') {
      state = { exported: false, value: false };
      continue;
    }
    if (segment[index].value === '-u' && segment[index + 1]) {
      if (segment[index + 1].value === 'HUSKY') state = { exported: false, value: false };
      index += 1;
    } else if (segment[index].value === '-uHUSKY') {
      state = { exported: false, value: false };
    } else if (/^HUSKY=([01])$/.test(segment[index].value)) {
      state = { exported: true, value: segment[index].value === 'HUSKY=0' };
    } else if (!segment[index].value.startsWith('-')) {
      break;
    }
  }
  return state;
};

const envSplitScript = (segment) =>
  segment[0]?.value.split('/').pop() === 'env' && segment[1]?.value === '-S'
    ? segment[2]?.value ?? null
    : null;

const unsetNames = (args) => {
  let index = 0;
  let functionOnly = false;
  while (args[index]?.value.startsWith('-')) {
    const option = args[index].value;
    if (option === '-v') {
      index += 1;
      continue;
    }
    if (option === '-f') {
      functionOnly = true;
      index += 1;
      continue;
    }
    return [];
  }
  return functionOnly ? [] : args.slice(index).map(({ value }) => value);
};

const hooksPathOf = (context, env) => {
  const gitOptions = {
    env: withoutGitLocation(env),
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  try {
    return {
      kind: 'value',
      value: execFileSync('git', [...context, 'config', '--get', 'core.hooksPath'], gitOptions).replace(/\r?\n$/, ''),
    };
  } catch (error) {
    if (error.status === 1) return { kind: 'missing' };
    return { kind: 'unreadable' };
  }
};

const configuredHooksAreUsable = (context, { effectiveEnv, baselineEnv, hasLocalGitConfiguration }) => {
  const effective = hooksPathOf(context, effectiveEnv);
  if (effective.kind === 'unreadable') return 'BLOCKED — Git hook configuration could not be read safely.';
  if (hasLocalGitConfiguration) {
    const baseline = hooksPathOf(context, baselineEnv);
    if (baseline.kind === 'unreadable') return 'BLOCKED — Git hook configuration could not be read safely.';
    if (effective.kind !== baseline.kind || effective.value !== baseline.value) return refusal;
  }
  if (effective.kind === 'missing') return null;
  const gitOptions = {
    env: withoutGitLocation(effectiveEnv),
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  try {
    const hooksPath = effective.value;
    if (!hooksPath) throw new Error('empty hooks path');
    const root = execFileSync('git', [...context, 'rev-parse', '--show-toplevel'], gitOptions).replace(/\r?\n$/, '');
    const preCommit = resolve(root, hooksPath, 'pre-commit');
    if (!statSync(preCommit).isFile()) throw new Error('pre-commit is not a file');
    accessSync(preCommit, constants.X_OK);
  } catch {
    return 'BLOCKED — Configured Git hooks do not provide a usable pre-commit hook.';
  }
  return null;
};

const inspect = (
  raw,
  depth = 0,
  inheritedState = {
    husky: { exported: Object.hasOwn(process.env, 'HUSKY'), value: process.env.HUSKY === '0' },
    configuration: inheritedGitConfig(),
  },
) => {
  if (depth > 16) return null;
  const substitutions = evaluatedSubstitutions(raw, false, true);
  const substitutionRanges = substitutions
    .filter(({ index }) => raw[index] === '$' || raw[index] === '`')
    .map(({ index, script }) => [index, index + script.length + (raw[index] === '$' ? 3 : 2)]);
  const states = new Map([
    [0, { husky: { ...inheritedState.husky }, configuration: cloneGitConfig(inheritedState.configuration) }],
  ]);
  const snapshots = [];
  for (const segment of tokenize(raw, { literalHeredocs: true, scopes: true })) {
    if (substitutionRanges.some(([start, end]) => segment.start >= start && segment.start < end)) continue;
    const scope = segment.subshellScope;
    if (!states.has(scope)) {
      const parent = states.get(segment.subshellParent) ?? states.get(0);
      states.set(scope, { husky: { ...parent.husky }, configuration: cloneGitConfig(parent.configuration) });
    }
    const state = states.get(scope);
    // Expansions see the owning command's state before that command changes it.
    snapshots.push({
      start: segment.start,
      husky: { ...state.husky },
      configuration: cloneGitConfig(state.configuration),
    });
    let command = commandOf(segment);
    if (command.name === 'if') command = commandOf(command.args);
    const split = envSplitScript(segment);
    if (split) {
      const nested = inspect(split, depth + 1, {
        husky: state.husky.exported ? { ...state.husky } : { exported: false, value: false },
        configuration: childGitConfig(state.configuration),
      });
      if (nested) return nested;
      continue;
    }
    const environmentHusky = envHusky(segment);
    const assignmentHusky = huskyAssignment(segment, command);
    if (command.name === 'export') {
      for (const { value } of command.args) {
        if (/^HUSKY=([01])$/.test(value)) state.husky.value = value === 'HUSKY=0';
        if (value === 'HUSKY' || /^HUSKY=/.test(value)) state.husky.exported = true;
        const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(value);
        if (assignment && isGitConfigEnvironmentKey(assignment[1])) {
          state.configuration[assignment[1]] = { exported: true, value: assignment[2] };
        } else if (isGitConfigEnvironmentKey(value)) {
          state.configuration[value] = { ...state.configuration[value], exported: true };
        }
      }
      continue;
    }
    if (command.name === 'unset') {
      const names = unsetNames(command.args);
      if (names.includes('HUSKY')) {
        state.husky.value = false;
        state.husky.exported = false;
      }
      for (const key of names.filter(isGitConfigEnvironmentKey)) delete state.configuration[key];
      continue;
    }
    if (!command.name && assignmentHusky !== null && segment[0]?.value !== 'env') {
      state.husky.value = assignmentHusky;
    }
    if (!command.name) {
      for (const [key, value] of assignmentEntries(segment)) {
        if (!isGitConfigEnvironmentKey(key)) continue;
        state.configuration[key] = { exported: state.configuration[key]?.exported ?? false, value };
      }
      continue;
    }
    const environment = commandEnvironmentOf(segment, command, state.configuration);
    if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(command.name)) {
      const script = shellScript(command.args);
      if (script) {
        const nested = inspect(
          script,
          depth + 1,
          {
            husky:
              environmentHusky ??
              (assignmentHusky === null
                ? (state.husky.exported ? { ...state.husky } : { exported: false, value: false })
                : { exported: true, value: assignmentHusky }),
            configuration: environment.configuration,
          },
        );
        if (nested) return nested;
      }
      continue;
    }
    if (command.name !== 'git' && command.name !== 'git.exe') continue;
    const operation = operationOf(command.args);
    if (!operation) continue;
    if (
      (environmentHusky?.value ?? assignmentHusky ?? (state.husky.exported && state.husky.value)) ||
      hasInlineHooksPath(command.args, operation) ||
      bypassesOperation(command.args, operation)
    ) {
      return refusal;
    }
    if (operation.value === 'commit') {
      const configuration = configuredHooksAreUsable(
        [...environment.context, ...contextOptions(command.args, operation)],
        environment,
      );
      if (configuration) return configuration;
    }
  }
  for (const { index, script } of substitutions) {
    let low = 0;
    let high = snapshots.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (snapshots[middle].start <= index) low = middle + 1;
      else high = middle;
    }
    const substitution = snapshots[low - 1] ?? inheritedState;
    const nested = inspect(script, depth + 1, substitution);
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
