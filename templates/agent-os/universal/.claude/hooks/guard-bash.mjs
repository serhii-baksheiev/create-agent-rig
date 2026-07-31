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
// ── The limits, stated exactly — and TESTED ──────────────────────────────────
//
// This block is a credibility claim, so `test/template/guard-hardening.test.ts`
// asserts each line twice: that the limit is documented here, and that the
// command really does pass. A limits comment nothing checks drifts into fiction,
// which is what happened the first time — an earlier version of this list was
// understated in six ways.
//
// Not caught:
//   - a value that only exists at runtime: `git push --force origin $BRANCH`;
//   - a user-defined alias, or a wrapper script that shells out:
//     `./scripts/deploy-prod.sh`;
//   - a command assembled at runtime: `eval "$(printf ...)"`;
//   - brace expansion: `git push --force origin mai{n..n}` really does push to
//     `main`, and the guard does not expand it.
//
// That last one is here BY CHOICE, and the choice is the point. Expanding braces
// needs a cross-product, and a bound per group is not a bound on the result: the
// implementation that did it could be made to overflow the stack, which the
// fail-open catch below turned into "allow" for every rule at once. A guard that
// can be disarmed by ten characters is worse than one with a documented gap.
// See .claude/rules/invariants.md, "A guard that fails open must do provably
// bounded work".
//
// The list is **not exhaustive**. The guard targets DRIFT — the ordinary spelling
// written without thinking — not an adversary, and circumventing it is itself a
// Never-tier violation. The layers behind it are review and CI.
//
// Contract (Claude Code): JSON on stdin; exit 0 = allow, exit 2 = block, and
// stderr is shown to the agent as the reason. Fails open on anything it cannot
// parse — a crashed guard must never make the session unusable.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { brakeIsOn } from '../scripts/stop-flag.mjs';

/** Branches that are shared by definition. */
const PROTECTED_BRANCH = /^(main|master|develop|development|trunk)$/;
/** Command wrappers that stand between the shell and the real command. */
const WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'nohup',
  'time',
  'timeout',
  'nice',
  'ionice',
  'stdbuf',
  'setsid',
  'xargs',
  'exec',
]);
/**
 * Shell keywords that can begin a segment. Without these the word `do` or `then`
 * becomes the "command name" and the segment is never inspected — so
 * `for b in a; do git push --force origin main; done` was invisible.
 */
/**
 * Wrapper options that consume the next argument — keyed BY WRAPPER, because the
 * same letter differs between them: `-n` takes a value for `xargs` and `nice`,
 * but is `--non-interactive` for `sudo`. One flat set ate the real command after
 * `sudo -n`, so the force-push behind it was never inspected.
 */
const WRAPPER_VALUE_FLAGS = {
  sudo: new Set(['-u', '-g', '-U', '-C', '-r', '-t', '-p', '-h', '-D', '-R']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-S', '--unset', '--chdir']),
  xargs: new Set(['-n', '-I', '-L', '-P', '-s', '-d', '-a', '-E', '-e']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  stdbuf: new Set(['-i', '-o', '-e']),
};
const KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'fi', 'done', 'in', '!', '{', '}']);
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
  '/usr/*',
  '/etc/*',
  '/var/*',
  '/bin/*',
  '/lib/*',
  '/opt/*',
  '/home/*',
  '/Users/*',
  '/System',
  '/Library',
  '/Applications',
  '/private',
  '/Volumes',
  '/System/*',
  '/Library/*',
  '/Applications/*',
]);

/**
 * While the brake is on, the network clients are refused.
 *
 * Pushing to a protected branch is refused with or without the brake, so the only
 * thing the brake has to add is the routes that land a PR — and every one of them
 * goes through a network client (`gh`, `curl`, `wget`). Denying the clients, with
 * a short allowlist of read-only and PR-opening subcommands, covers `gh pr merge`,
 * `gh api …/merge`, the GraphQL mutation and a raw `curl` in one rule, without
 * matching text at all.
 *
 * The previous attempt matched the substring `merge` across every token. It denied
 * 19 ordinary commands — including `git log --no-merges` and pushing a branch named
 * `fix/merge-conflict-handling`, which are literally what the brake's own message
 * tells the agent to do while stopping. A rule that forbids the wind-down it
 * prescribes is not coarse, it is wrong.
 */
const NETWORK_CLIENTS = new Set(['gh', 'curl', 'wget', 'http', 'https', 'httpie', 'hub']);
/** `gh` subcommands that read, or open a PR — the wind-down the brake asks for. */
const BRAKE_SAFE_GH = new Set(['view', 'list', 'status', 'diff', 'checks', 'create']);

const deniedByBrake = (name, args) => {
  if (!NETWORK_CLIENTS.has(name)) return false;
  if (name !== 'gh' && name !== 'hub') return true;
  const operands = operandsOf(args, GH_FLAGS).map(({ value }) => value);
  // `gh pr view`, `gh run list`, `gh pr create` — anything else, including
  // `gh api` by any route, is refused while the brake is on.
  return !operands.some((operand) => BRAKE_SAFE_GH.has(operand));
};

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
  let heredocBudget = 32;

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
    if (ch === '$' && raw[i + 1] === "'") {
      // ANSI-C quoting. `$'main'` is just `main` to the shell; leaving the `$`
      // glued on hid the branch name, and the escaped `'` inside desynchronised
      // the plain single-quote scanner for the rest of the line.
      let j = i + 2;
      while (j < raw.length && raw[j] !== "'") j += raw[j] === '\\' ? 2 : 1;
      value += raw
        .slice(i + 2, Math.min(j, raw.length))
        .replace(/\\(.)/g, '$1');
      started = true;
      i = j < raw.length ? j + 1 : raw.length;
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
    if (ch === '<' && raw[i + 1] === '<' && raw[i + 2] !== '<' && heredocBudget > 0) {
      // A heredoc body is data, not commands. Recognised HERE, inside the
      // scanner, because only here is it known that the `<<` is unquoted — a
      // pre-pass over the raw text could not tell a redirect from `<<` inside a
      // string, which made it a general hide-anything primitive.
      //
      // Bounded by construction: one forward scan, no rescanning, and if the
      // terminator never appears the body is KEPT rather than swallowed. Losing
      // lines is how the pre-pass hid commands.
      const marker = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(raw.slice(i, i + 64));
      if (marker) {
        // A TOTAL budget, not a per-step one. Each lookahead scans forward to the
        // end of the input, so an input full of markers is quadratic — the same
        // shape as the three bypasses this round removed. Past the budget, `<<`
        // is just two characters again, which keeps the body visible: erring
        // toward inspecting more, never toward inspecting less.
        heredocBudget -= 1;
        const bodyStart = raw.indexOf('\n', i + marker[0].length);
        let end = bodyStart === -1 ? -1 : raw.indexOf(`\n${marker[2]}\n`, bodyStart);
        let skip = marker[2].length + 2;
        if (end === -1 && bodyStart !== -1 && raw.endsWith(`\n${marker[2]}`)) {
          end = raw.length - marker[2].length - 1; // the terminator ends the input
          skip = marker[2].length + 1;
        }
        if (end !== -1) {
          endArg();
          i = end + skip; // skip the body and its terminator
          continue;
        }
      }
      i += 2;
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
    // `{`/`}` are NOT boundaries: they are part of a token in brace expansion,
    // and `{ …; }` grouping is handled by the keyword skip in `commandOf`.
    if ('|;&\n()`'.includes(ch)) {
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
  let sawWrapper = false;
  let lastWrapper = null;
  while (i < args.length) {
    const { value } = args[i];
    // An assignment prefix, whether or not it was quoted. Only the UNQUOTED form
    // used to be stepped over, so `GIT_SSH_COMMAND="ssh -i k" git push …` — the
    // ordinary spelling for any value with a space — defeated every rule.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      i += 1;
      continue;
    }
    if (KEYWORDS.has(value)) {
      i += 1;
      continue;
    }
    if (WRAPPERS.has(value.split('/').pop())) {
      lastWrapper = value.split('/').pop();
      i += 1;
      sawWrapper = true;
      continue;
    }
    // A wrapper's own options (`sudo -u root`, `env -i`, `xargs -n1`, and the
    // bare duration in `timeout 60`) — step over them rather than treating `-u`
    // as the command name and giving up.
    if (sawWrapper && value.startsWith('-')) {
      const takesValue = WRAPPER_VALUE_FLAGS[lastWrapper]?.has(value) ?? false;
      i += value !== '--' && takesValue && args[i + 1] ? 2 : 1;
      continue;
    }
    if (sawWrapper && /^\d+(\.\d+)?[smhd]?$/.test(value)) {
      i += 1; // `timeout 60 …`, `nice 10 …`
      continue;
    }
    break;
  }
  const name = (args[i]?.value ?? '').split('/').pop();
  return { name, args: args.slice(i + 1) };
};

/**
 * `gh` flags that take a value. Without these the value stayed in the operand
 * list, which shifted every positional: `gh --repo o/r pr merge` no longer looked
 * like a merge, and `gh workflow run --repo org/prod-release-api ci.yml` looked
 * like a production deploy. One defect, both directions.
 */
const GH_VALUE_FLAGS = new Set([
  '--repo',
  '-R',
  '--ref',
  '--method',
  '-X',
  '-f',
  '-F',
  '--field',
  '--raw-field',
  '--body-file',
  '--label',
  '-l',
  '-H',
  '--jq',
  '-q',
  '--template',
]);

/** Arguments that are neither a flag nor the value of a prose/path/config flag. */
const operandsOf = (args, valueFlags = VALUE_FLAGS) => {
  const operands = [];
  for (let i = 0; i < args.length; i += 1) {
    const { value } = args[i];
    if (valueFlags.has(value)) {
      i += 1; // skip the value: it is a message, a path or a config, never a ref
      continue;
    }
    if (value.startsWith('-')) continue;
    operands.push(args[i]);
  }
  return operands;
};

const GH_FLAGS = new Set([...VALUE_FLAGS, ...GH_VALUE_FLAGS]);

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
    value === '-f' || value === '-F' || value === '--field' || value === '--raw-field'
      ? [args[index + 1]?.value ?? '']
      : value.startsWith('-f=') || value.startsWith('--field=')
        ? [value.split('=').slice(1).join('=')]
        : [],
  );

const PROD_FIELD = /(^|\[)(stage|environment|env|target)\]?=(prod|production)$/i;
const DEPLOY_TARGET = /deploy|release|publish|ship|(^|[^a-z])cd([^a-z]|$)|(^|[^a-z])prod/i;

function checkGh({ args }) {
  const operands = operandsOf(args, GH_FLAGS);
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
    // Only the WORKFLOW segment counts, never the owner or repo name: `prod` in
    // `repos/o/prod-api/…` is a repository, not a production deploy.
    const workflowSegment = /workflows\/([^/\s]+)\/dispatches/.exec(route)?.[1] ?? '';
    const prodish =
      /prod|production/i.test(workflowSegment) || fields.some((f) => PROD_FIELD.test(f));
    if (prodish) {
      return (
        'BLOCKED — dispatching a production workflow through the API is the same ' +
        'hard stop as running it (.claude/rules/autonomy.md, "Never"). Escalate.'
      );
    }
  }

  return null;
}

/**
 * `//`, `/.`, `${HOME}` and a trailing slash all collapse onto the literal list.
 *
 * Single-pass on purpose. The previous version looped a NON-global `replace`, so
 * it copied the whole string once per `/.` — quadratic. At 1.4MB the hook was
 * killed by its own timeout, and a killed hook does not block, so every rule
 * silently switched off for that command. That made the guard, for that input,
 * worse than no guard at all.
 */
export const normalizeTarget = (token) => {
  const path = token.replace(/\$\{HOME\}/g, '$HOME');
  const leading = path.startsWith('/') ? '/' : '';
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  const joined = leading + parts.join('/');
  return joined === '' ? (leading || path) : joined;
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
  if (depth > 8) return null; // a wrapper chain this deep is not a real command
  let atCatastrophicCwd = false;

  for (const segment of tokenize(raw)) {
    // The coarse brake, before any per-command rule and independent of every one
    // of them: while the flag is on, an UNQUOTED mention of a merge is refused
    // whatever command it belongs to.
    const braked = brake && (() => {
      const { name, args } = commandOf(segment);
      return deniedByBrake(name, args);
    })();
    if (braked) {
      return (
        `BLOCKED — the kill switch is set (${brake}), so nothing may land on the ` +
        'default branch. Everything else stays allowed on purpose: finish the ' +
        'current task, push the branch, open the PR, write the journal entry, and ' +
        `stop. "Stop cleanly" never means "lose the work". Clear it with: rm ${brake}`
      );
    }

    const command = commandOf(segment);
    if (!command.name) continue;

    if (SHELLS.has(command.name) || command.name === 'eval') {
      // `bash -c "<command line>"` / `eval "<command line>"` — the payload is a
      // command line of its own. Taken whether or not it is quote-delimited: a
      // backslash-joined payload is still a payload.
      const flagIndex = command.args.findIndex(({ value }) => value === '-c');
      const script =
        flagIndex >= 0
          ? command.args[flagIndex + 1]?.value
          : command.args.map(({ value }) => value).join(' ');
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

/**
 * Only act when invoked as the hook. Importing this module (a test reading
 * `normalizeTarget`, say) must not run the guard and exit the process.
 */
const invokedDirectly = () => {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
};

if (invokedDirectly()) process.exit(main());
