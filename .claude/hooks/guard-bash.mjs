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
// Not caught, because each needs a shell rather than a parser:
//   - a value that only exists at runtime: `git push --force origin $BRANCH`;
//   - a user-defined alias, or a wrapper script that shells out:
//     `./scripts/deploy-prod.sh`;
//   - a command assembled at runtime: `eval "$(printf ...)"`.
//
// The list is **not exhaustive**. The guard targets DRIFT — the ordinary spelling
// written without thinking — not an adversary, and circumventing it is itself a
// Never-tier violation. The layers behind it are review and CI.
//
// One rule is deliberately coarse rather than precise: while the kill switch is
// on, ANY unquoted mention of a merge is refused, whatever command it belongs to.
// A false block costs nothing there, because the session is already stopped —
// precision should follow the cost of being wrong.
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
/** Wrapper options that consume the next argument, so it is not the command. */
const WRAPPER_VALUE_FLAGS = new Set([
  '-u', '-g', '-U', '-C', '-r', '-t', '-k', '-n', '-I', '-L', '-P', '-s', '-d', '-a',
]);
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
  '/home/*',
  '/Users/*',
  '/System',
  '/Library',
  '/Applications',
  '/private',
  '/Volumes',
]);

/**
 * While the brake is on, anything that looks like a merge is refused.
 *
 * Deliberately COARSE, and that is the design rule worth stating: **match a
 * rule's precision to the cost of a false positive.** A false block here costs
 * nothing — the session is already stopped — so the brake does not need to
 * out-parse a shell, and it must not depend on doing so. Trying to enumerate the
 * routes (`gh pr merge`, `gh api …/merge`, `curl`, `graphql`) is how three of
 * them were missed.
 *
 * Quoted text is exempt, so a commit message or a journal entry that merely
 * mentions merging is untouched.
 */
const MERGE_WORD = /merge/i;
/** Flags whose value is prose a human wrote, where a mention of merging is not an act. */
const PROSE_FLAGS = new Set(['-m', '--message', '--body', '--title', '--body-file', '-F', '--file']);
const mentionsMerge = (segment) =>
  segment.some((token, index) => {
    const previous = segment[index - 1]?.value;
    if (token.quoted && PROSE_FLAGS.has(previous)) return false;
    return MERGE_WORD.test(token.value);
  });

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
/**
 * Remove heredoc BODIES before tokenising.
 *
 * A heredoc body is data, not commands — but every newline was a segment
 * boundary, so `git commit -F - <<'EOF' … rm -rf / … EOF` read as an `rm`
 * command and was blocked. The rewrite fixed prose for `-m "…"` and left it open
 * for multi-line bodies, which is exactly how PR descriptions and journal entries
 * are written. Same failure the file's own header calls fatal for a guard.
 */
export const stripHeredocs = (raw) => {
  const lines = raw.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    out.push(lines[i]);
    const marker = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(lines[i]);
    if (!marker) continue;
    const terminator = marker[2];
    i += 1;
    while (i < lines.length && lines[i].trim() !== terminator) i += 1;
  }
  return out.join('\n');
};

/**
 * Expand the brace forms a shell would: `mai{n..n}` really is `main`, and the
 * guard has to see the branch the command actually pushes to. Bounded and
 * literal — anything larger or stranger is left alone rather than guessed at.
 */
export const expandBraces = (token) => {
  const match = /\{([^{}]*)\}/.exec(token);
  if (!match) return [token];
  const body = match[1];
  let options = null;
  if (body.includes(',')) options = body.split(',');
  else {
    const range = /^([A-Za-z0-9]+)\.\.([A-Za-z0-9]+)$/.exec(body);
    if (range && range[1] === range[2]) options = [range[1]];
  }
  if (!options || options.length > 16) return [token];
  return options.flatMap((option) =>
    expandBraces(token.slice(0, match.index) + option + token.slice(match.index + match[0].length)),
  );
};

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
      i += 1;
      sawWrapper = true;
      continue;
    }
    // A wrapper's own options (`sudo -u root`, `env -i`, `xargs -n1`, and the
    // bare duration in `timeout 60`) — step over them rather than treating `-u`
    // as the command name and giving up.
    if (sawWrapper && value.startsWith('-')) {
      i += value !== '--' && WRAPPER_VALUE_FLAGS.has(value) && args[i + 1] ? 2 : 1;
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
  // Brace forms expand first: `mai{n..n}` is the branch `main` to the shell, so
  // the guard has to see the ref the push actually targets.
  const operands = operandsOf(args).flatMap(({ value, quoted }) =>
    expandBraces(value).map((expanded) => ({ value: expanded, quoted })),
  );
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
  if (token.length > 4096) return token; // no real path is this long
  const path = token.replace(/\$\{HOME\}/g, '$HOME');
  const leading = path.startsWith('/') ? '/' : '';
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  const joined = leading + parts.join('/');
  return joined === '' ? (leading || path) : joined;
};

/**
 * Roots whose CHILDREN are also catastrophic. `/etc` was listed and `/etc/*` was
 * not — the same deletion by another spelling.
 *
 * Home is deliberately absent: `$HOME/project/node_modules` and
 * `/Users/me/app/dist` are the most ordinary deletions there are, and blocking
 * them is how a guard gets switched off. Home is protected as a whole (`~`,
 * `~/*`) and in the one place that matters (`~/.ssh`), not by prefix.
 */
const CATASTROPHIC_TREES = [
  '/usr',
  '/etc',
  '/var',
  '/bin',
  '/lib',
  '/opt',
  '/System',
  '/Library',
  '/Applications',
  '/private',
  '/Volumes',
  '~/.ssh',
  '$HOME/.ssh',
];

const isCatastrophic = (target) =>
  CATASTROPHIC.has(target) || CATASTROPHIC_TREES.some((root) => target.startsWith(`${root}/`));

function checkRm({ args }, atCatastrophicCwd) {
  for (const { value } of operandsOf(args).flatMap(({ value: v }) => expandBraces(v).map((x) => ({ value: x })))) {
    const target = normalizeTarget(value);
    if (isCatastrophic(target)) {
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

  for (const segment of tokenize(stripHeredocs(raw))) {
    // The coarse brake, before any per-command rule and independent of every one
    // of them: while the flag is on, an UNQUOTED mention of a merge is refused
    // whatever command it belongs to.
    if (brake && mentionsMerge(segment)) {
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
