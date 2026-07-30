// PreToolUse hook: the "Never" tier of .claude/rules/autonomy.md, made
// mechanical. A prompt-level rule is followed most of the time; a hook is
// followed every time, and these are the actions where "most of the time" is not
// good enough because they are not reversible.
//
// It is a SECOND Bash guard on purpose. `block-no-verify` owns exactly one
// invariant (the pre-commit gate may not be bypassed) and stays readable because
// of it; this one owns the irreversible actions and the kill switch.
//
// ── Why this parses instead of pattern-matching ──────────────────────────────
//
// The first version ran regexes over the command string after splitting it on
// `|&;`. An adversarial pass found 26 false negatives and 6 false positives, and
// nearly all of them had one cause: **it matched before it understood quoting.**
//   - `git commit -m "cleanup; rm -rf / was possible"` → the `;` inside the
//     message manufactured a segment whose first word was `rm`, and the guard
//     blocked a commit. A guard that fires on prose is a guard people disable.
//   - `git push --force origin "main"` → quoted text was blanked before the
//     branch was read, so the branch vanished and the force-push was allowed.
//
// So it now TOKENISES first: quotes are honoured, separators inside quotes are
// just characters, and every rule reads structured arguments. That single change
// closed both directions at once.
//
// ── The limits, stated exactly ───────────────────────────────────────────────
//
// Still not caught, and deliberately so — each needs a shell, not a parser:
//   - a value that only exists at runtime: `git push --force origin $BRANCH`;
//   - a user-defined alias or a wrapper script that shells out;
//   - `eval "$(printf ...)"` and friends.
// The guard targets DRIFT, not an adversary, and circumventing it is itself a
// Never-tier violation. The layers behind it are review and CI.
//
// Contract (Claude Code): JSON on stdin; exit 0 = allow, exit 2 = block, and
// stderr is shown to the agent as the reason. Fails open on anything it cannot
// parse — a crashed guard must never make the session unusable.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Branches that are shared by definition. */
const PROTECTED_BRANCH = /^(main|master|develop|development|trunk)$/;
/** Command wrappers that stand between the shell and the real command. */
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'nohup', 'time', 'xargs', 'exec']);
/** Shells whose `-c` argument is itself a command line, so it must be parsed too. */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
/**
 * Flags whose VALUE is prose or a path, never a ref. Skipping them is what keeps
 * a commit message from being read as a live argument.
 */
const VALUE_FLAGS = new Set([
  '-m',
  '--message',
  '-F',
  '--file',
  '-C',
  '--grep',
  '--author',
  '--date',
  '--reuse-message',
  '--title',
  '--body',
  '-t',
  '-b',
]);

/**
 * Targets that make a delete unrecoverable wherever you run it. Compared after
 * normalisation, so `//`, `/.`, `${HOME}` and a trailing slash all collapse onto
 * these — the list stays literal and readable while the variants close.
 */
const CATASTROPHIC = new Set([
  '/',
  '/*',
  '~',
  '~/*',
  '$HOME',
  '$HOME/*',
  '/usr',
  '/etc',
  '/var',
  '/bin',
  '/lib',
  '/opt',
  '/home',
  '/Users',
  '~/.ssh',
  '$HOME/.ssh',
]);

/**
 * The kill-switch paths. The machine-level default is ALWAYS checked; the env var
 * only ADDS paths and can never remove the default.
 *
 * This is the fix for a real hole: the override used to *replace* the default, so
 * pointing it at a file that does not exist disabled the brake while the operator's
 * real flag sat untouched in the home directory. An override may add a brake,
 * never take one away.
 */
const stopFlags = () => {
  const paths = [join(homedir(), '.claude', 'create-agent-rig-loop-STOP')];
  const extra = process.env.AGENT_LOOP_STOP;
  if (extra) paths.push(...extra.split(delimiter).filter(Boolean));
  return paths;
};
const brakeIsOn = () => stopFlags().find((path) => existsSync(path)) ?? null;

// ── Tokenising ───────────────────────────────────────────────────────────────

/**
 * Split a command line into segments of arguments, honouring quotes.
 *
 * Each token records whether it was quoted, because the two facts matter
 * separately: a quoted argument is still an argument (so `"main"` is the branch),
 * but a separator inside quotes is text (so a commit message is not a command).
 *
 * A subshell, a pipeline, `&&`, a command substitution and a newline all end the
 * current segment — every one of them introduces a new command whose first word
 * must be examined on its own.
 */
export const tokenize = (raw) => {
  const segments = [];
  let args = [];
  let value = '';
  let quoted = false;
  let started = false;

  const endArg = () => {
    if (started) {
      args.push({ value, quoted });
      value = '';
      quoted = false;
      started = false;
    }
  };
  const endSegment = () => {
    endArg();
    if (args.length > 0) segments.push(args);
    args = [];
  };

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];

    if (ch === '\\' && raw[i + 1] === '\n') {
      i += 2; // a line continuation is whitespace, not a segment boundary
      continue;
    }
    if (ch === '\\' && i + 1 < raw.length) {
      value += raw[i + 1];
      started = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = raw.indexOf("'", i + 1);
      value += end === -1 ? raw.slice(i + 1) : raw.slice(i + 1, end);
      quoted = true;
      started = true;
      i = end === -1 ? raw.length : end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < raw.length && raw[j] !== '"') {
        if (raw[j] === '\\' && j + 1 < raw.length) {
          value += raw[j + 1];
          j += 2;
        } else {
          value += raw[j];
          j += 1;
        }
      }
      quoted = true;
      started = true;
      i = j < raw.length ? j + 1 : raw.length;
      continue;
    }
    if (ch === '#' && !started) {
      const end = raw.indexOf('\n', i);
      i = end === -1 ? raw.length : end; // an unquoted comment is not arguments
      continue;
    }
    if (ch === '$' && raw[i + 1] === '{') {
      // A parameter expansion is part of the token, not a brace group — `${HOME}`
      // must survive tokenising to be normalised into `$HOME` later.
      const end = raw.indexOf('}', i + 2);
      value += end === -1 ? raw.slice(i) : raw.slice(i, end + 1);
      started = true;
      i = end === -1 ? raw.length : end + 1;
      continue;
    }
    if (ch === '$' && raw[i + 1] === '(') {
      endSegment();
      i += 2;
      continue;
    }
    if ('|;&\n()`{}'.includes(ch)) {
      endSegment();
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      endArg();
      i += 1;
      continue;
    }
    value += ch;
    started = true;
    i += 1;
  }
  endSegment();
  return segments;
};

/**
 * The real command in a segment: leading `VAR=value` assignments and wrappers
 * (`sudo`, `env`, …) are stepped over, and a path is reduced to its basename, so
 * `FOO=1 sudo /usr/bin/git push` is recognised as `git push`.
 */
export const commandOf = (args) => {
  let i = 0;
  while (i < args.length) {
    const { value, quoted } = args[i];
    if (!quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      i += 1;
      continue;
    }
    if (WRAPPERS.has(value.split('/').pop())) {
      i += 1;
      continue;
    }
    break;
  }
  const name = (args[i]?.value ?? '').split('/').pop();
  return { name, args: args.slice(i + 1) };
};

/** Arguments that are neither a flag nor the value of a prose/path flag. */
const operandsOf = (args) => {
  const operands = [];
  for (let i = 0; i < args.length; i += 1) {
    const { value } = args[i];
    if (VALUE_FLAGS.has(value)) {
      i += 1; // skip the value: it is a message or a path, never a ref
      continue;
    }
    if (value.startsWith('-')) continue;
    operands.push(args[i]);
  }
  return operands;
};

const hasFlag = (args, ...names) =>
  args.some(({ value }) => names.some((name) => value === name || value.startsWith(`${name}=`)));

// ── Rules ────────────────────────────────────────────────────────────────────

/** Every branch name a refspec token designates (`+`, `src:dst`, `refs/heads/`). */
export const refNames = (token) =>
  token
    .replace(/^\+/, '')
    .split(':')
    .map((part) => part.replace(/^refs\/heads\//, ''));

const namesProtected = (token) => refNames(token).some((name) => PROTECTED_BRANCH.test(name));

function checkGit({ args }) {
  const operands = operandsOf(args);
  if (!operands.some(({ value }) => value === 'push')) return null;

  const forced =
    hasFlag(args, '-f', '--force', '--force-with-lease') ||
    operands.some(({ value }) => value.startsWith('+'));
  const protectedRef = operands.some(({ value }) => value !== 'push' && namesProtected(value));

  if (forced && protectedRef) {
    return (
      'BLOCKED — force-pushing a shared branch is a Never-tier action ' +
      '(.claude/rules/autonomy.md). It rewrites history other people and other ' +
      'sessions have already built on. Push a branch and open a PR instead.'
    );
  }
  if (hasFlag(args, '--mirror') || (forced && hasFlag(args, '--all'))) {
    return (
      'BLOCKED — a --mirror/--all force-push carries every ref, including the ' +
      'shared branches, whether or not you named them (.claude/rules/autonomy.md). ' +
      'Push the one branch you mean, by name.'
    );
  }
  if (protectedRef) {
    return (
      'BLOCKED — the default branch is never written to directly, and never ' +
      'deleted: it stays releasable at all times (.claude/rules/workflow.md, ' +
      '"Branches and commits"). Work reaches it through a PR.'
    );
  }
  return null;
}

/** `-f key=value` / `--field key=value` pairs, which is where a stage actually lives. */
const fieldValues = (args) =>
  args.flatMap(({ value }, index) =>
    value === '-f' || value === '--field' || value === '--raw-field'
      ? [args[index + 1]?.value ?? '']
      : value.startsWith('-f=') || value.startsWith('--field=')
        ? [value.split('=').slice(1).join('=')]
        : [],
  );

const PROD_FIELD = /^(stage|environment|env|target)=(prod|production)$/i;
const DEPLOY_TARGET = /deploy|release|publish/i;

function checkGh({ args }, brake) {
  const operands = operandsOf(args);
  const isWorkflowRun = operands[0]?.value === 'workflow' && operands[1]?.value === 'run';
  const fields = fieldValues(args);

  if (isWorkflowRun) {
    // The workflow being run is the operand after `run` — NOT a repo name and not
    // a --ref value. `prod` in `org/prod-api` or `release/prod-hotfix` is not a
    // production deploy, and blocking those is how the rule gets switched off.
    const workflow = operands[2]?.value ?? '';
    const prodish = /prod/i.test(workflow) || fields.some((field) => PROD_FIELD.test(field));
    if (DEPLOY_TARGET.test(workflow) && prodish) {
      return (
        'BLOCKED — triggering a production deploy from an agent session is a hard ' +
        'stop (.claude/rules/autonomy.md, "Never"). Escalate to the human who owns ' +
        'that release.'
      );
    }
  }

  const route = operands.map(({ value }) => value).join(' ');
  if (/\/dispatches\b/.test(route)) {
    const prodish = /prod|production/i.test(route) || fields.some((f) => /prod|production/i.test(f));
    if (prodish) {
      return (
        'BLOCKED — dispatching a production workflow through the API is the same ' +
        'hard stop as running it (.claude/rules/autonomy.md, "Never"). Escalate.'
      );
    }
  }

  // The brake covers the merge, by whichever route it is reached: `gh pr merge`
  // and the REST endpoint are the same landing on the default branch.
  const isMerge =
    (operands[0]?.value === 'pr' && operands[1]?.value === 'merge') ||
    (operands[0]?.value === 'api' && /pulls\/\d+\/merge/.test(route));
  if (isMerge && brake) {
    return (
      `BLOCKED — the kill switch is set (${brake}), so nothing may land on the ` +
      'default branch. Everything else stays allowed on purpose: finish the ' +
      'current task, push the branch, open the PR, write the journal entry, and ' +
      `stop. "Stop cleanly" never means "lose the work". Clear it with: rm ${brake}`
    );
  }
  return null;
}

/** `//`, `/.`, `${HOME}` and a trailing slash all collapse onto the literal list. */
export const normalizeTarget = (token) => {
  let path = token.replace(/\$\{HOME\}/g, '$HOME');
  path = path.replace(/\/{2,}/g, '/');
  while (/\/\.$|\/\.\//.test(path)) path = path.replace(/\/\.(\/|$)/, '/');
  if (path.length > 1) path = path.replace(/\/$/, '');
  return path;
};

function checkRm({ args }, atCatastrophicCwd) {
  for (const { value } of operandsOf(args)) {
    const target = normalizeTarget(value);
    if (CATASTROPHIC.has(target)) {
      return (
        'BLOCKED — this deletes the filesystem root or the whole home directory, ' +
        'which no task in this project requires. If a path really needs removing, ' +
        'name it relative to the project.'
      );
    }
    // An upward escape from root or home reaches the same place by another name.
    if (/^(\/|~|\$HOME)/.test(target) && target.split('/').includes('..')) {
      return (
        'BLOCKED — this path escapes upward out of the home directory or the ' +
        'filesystem root, which reaches the same place as deleting it outright.'
      );
    }
    // `cd / && rm -rf *` is `rm -rf /*` with the target hidden in a prior segment.
    if (atCatastrophicCwd && (target === '*' || target === '.' || target === './*')) {
      return (
        'BLOCKED — an earlier segment changed directory to the filesystem root or ' +
        'the home directory, so this wildcard delete is a root delete.'
      );
    }
  }
  return null;
}

// ── Entry ────────────────────────────────────────────────────────────────────

/** Walk every segment of a command line, following shells and subshells inward. */
export const inspect = (raw, brake, depth = 0) => {
  if (depth > 3) return null; // a wrapper chain this deep is not a real command
  let atCatastrophicCwd = false;

  for (const segment of tokenize(raw)) {
    const command = commandOf(segment);
    if (!command.name) continue;

    if (SHELLS.has(command.name)) {
      // `bash -c "<command line>"` — the payload is a command line of its own.
      const script = command.args.find(({ quoted }) => quoted)?.value;
      if (script) {
        const reason = inspect(script, brake, depth + 1);
        if (reason) return reason;
      }
      continue;
    }

    if (command.name === 'cd') {
      const target = normalizeTarget(operandsOf(command.args)[0]?.value ?? '');
      atCatastrophicCwd = CATASTROPHIC.has(target);
      continue;
    }

    const reason =
      command.name === 'git'
        ? checkGit(command)
        : command.name === 'gh'
          ? checkGh(command, brake)
          : command.name === 'rm'
            ? checkRm(command, atCatastrophicCwd)
            : null;
    if (reason) return reason;
  }
  return null;
};

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0;
  }
  if (input.tool_name !== 'Bash') return 0;
  const raw = String(input.tool_input?.command ?? '');
  if (!raw.trim()) return 0;

  try {
    const reason = inspect(raw, brakeIsOn());
    if (reason) {
      process.stderr.write(`${reason}\n`);
      return 2;
    }
  } catch {
    return 0; // a guard that crashes must not block the work
  }
  return 0;
}

process.exit(main());
