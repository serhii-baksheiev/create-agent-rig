// PreToolUse hook: the part of the "Never" tier of .claude/rules/autonomy.md
// that a text scan can decide, made mechanical. A prompt-level rule is followed most of the time; a hook is
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
// This block is a credibility claim, so the generator's
// `test/template/guard-hardening.test.ts` (absent in a generated rig)
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
//     `main`, and the guard does not expand it;
//   - more than 32 heredocs in one command: past that budget the bodies are read
//     as commands, so a script with 33+ heredocs can be falsely BLOCKED on its
//     own data. The budget exists because each lookahead scans forward, and an
//     unbounded number of them is the quadratic hazard that once killed the hook.
//     Erring toward a false block past the budget is the safe direction — but it
//     is a limit, so it is written here rather than discovered.
//
// That last one is here BY CHOICE, and the choice is the point. Expanding braces
// needs a cross-product, and a bound per group is not a bound on the result: the
// implementation that did it could be made to overflow the stack, which the
// fail-open catch below turned into "allow" for every rule at once. A guard that
// can be disarmed by ten characters is worse than one with a documented gap.
// See .claude/rules/invariants.md, "A guard that fails open must do provably
// bounded work".
//
// And what `cd`/`pushd` TRACKING itself cannot resolve, so it clears rather
// than guesses (RP-309):
//   - `cd -`/`pushd -` return to `$OLDPWD`, a directory this guard cannot
//     know without running a real shell;
//   - `~user` (a tilde naming ANOTHER account's home, not the caller's own)
//     is never resolved — only a bare `~`/`$HOME` is;
//   - `popd` is never tracked at all — only `cd`/`pushd` change it. This
//     guard does not MODEL the real directory stack at all: it tracks a
//     single `{ anchor, parts }` position across the whole command line,
//     never a stack of entries;
//   - a bare `pushd` (no operand), `pushd -n DIR` (pushes DIR WITHOUT cd-ing
//     there) and `pushd +N`/`pushd -N` (rotate the stack to its Nth entry —
//     which FAILS in real bash whenever nothing has been pushed onto the
//     stack yet, the ordinary case here) leave the tracked position
//     UNCHANGED rather than cleared or guessed at (RP-309 gate round 3) — a
//     bare `cd` is unaffected, since it genuinely lands at $HOME;
//   - `pushd`/`popd` never LOWER an already-tracked catastrophic position to
//     an ordinary one either (RP-309 gate round 3, post-cap): a real,
//     POPULATED directory stack can move the shell somewhere this guard
//     cannot see either way, so over-blocking a wildcard delete that follows
//     is the safe direction — but a `pushd` into a directory that is ITSELF
//     catastrophic still replaces whatever was tracked before it, exactly
//     like `cd` does;
//   - a subshell-local `cd`/`pushd` is not told apart from the outer shell's own tracked directory (`( cd ~/.ssh )`) either —
//     tracking still updates when the subshell closes, which over-blocks a
//     wildcard delete written after it. That is the safe direction, so it
//     stays a limit rather than a fix;
//   - `builtin cd` is not recognised as `cd` at all, so it is never tracked.
//
// None of the above is a promise that this tracker is the ONLY thing deciding
// whether a wildcard delete is caught (RP-309 post-cap, controller design
// decision): base's own `cd`-only tracking from 58f9635 — one string, set only
// by `cd`, never cleared or replaced by `pushd`/`popd` at all — runs alongside
// it for every segment, and `checkRm` blocks when EITHER says the cwd is
// catastrophic. So a case this tracker mis-clears (a `pushd`/`popd` it
// resolves differently from `cd`'s own operand grammar, a `pushd -`, the
// shared-array mistake `computeCdTarget`'s own doc comment names) still hits
// the floor base already set — see `legacyCdTarget`'s own doc comment, and
// the generator's test/template/hooks.test.ts (absent in a generated rig) ›
// "never allows a command the base guard blocked (RP-309 post-cap,
// differential)".
//
// And the SCOPE of each rule, because "refuses the Never tier" reads wider than
// what is actually inspected:
//   - deletes: only `rm` is examined. `find -delete`, `dd`, `shred`, `truncate`,
//     `mv`, `rsync --delete` and `chmod -R 000` are not;
//   - production deploys: only a workflow dispatch (`gh workflow run`, `gh api
//     …/dispatches`). A deploy driven straight from an infrastructure CLI, or a
//     registry publish, is not caught — and on a target whose own deploy command
//     IS such a CLI, that is the ordinary spelling, not an exotic one;
//   - direct pushes: only when the command NAMES the branch. Bare `git push` and
//     `git push origin HEAD` depend on the checked-out branch, which this guard
//     cannot know without running git. While the kill switch is on they are
//     refused for that reason; the rest of the time they are not;
//   - branch deletion: `git push --delete` is caught; `git branch -D main`,
//     `git update-ref -d` and `gh api -X DELETE …/refs/heads/main` are not;
//   - a command carried as a flag value (`find … -exec`, `env -S`) is not
//     followed.
//
// The list is **not exhaustive**. The guard targets DRIFT — the ordinary spelling
// written without thinking — not an adversary, and circumventing it is itself a
// Never-tier violation. The layers behind it are review and CI.
//
// ── Which SURFACES it sees, and what that does not promise (RP-65) ───────────
//
// This runs for every tool named in `.claude/scripts/lib/shell-tools.mjs`, not
// for `Bash` alone. It used to be wired under `Bash` only, and the measurement
// that changed it is in that file: the same `--no-verify` command was blocked
// through one tool and ran through the other, in one session.
//
// ⚠ Widening the matcher makes the same RULES run on both surfaces. It does not
// make the PARSING identical: the tokeniser above is POSIX, and PowerShell's
// quoting, escaping and separators are its own, so a command whose danger is
// visible only after PowerShell-specific parsing can read differently here.
//
// ⚠ And the coarse checks are narrower than "coarse" suggests. The rules
// match a command NAME — `git`, `gh`, `rm` — so they refuse the operation
// only when the operation is spelled that way.
// Measured with the brake armed: `gh pr merge …` is refused on both surfaces,
// while `gh.exe pr merge …`, `Start-Process gh -ArgumentList …` and
// `Remove-Item -Recurse -Force C:\` are all allowed. The first of those is
// allowed under `Bash` too, so this is a rule-set bound rather than anything
// the widened matcher introduced — but it is a bound, and an earlier draft of
// this block claimed the opposite. This gap is why the file keeps a name that
// says `bash`: a rename would promise a parity the parser does not have.
//
// Contract (Claude Code): JSON on stdin; exit 0 = allow, exit 2 = block, and
// stderr is shown to the agent as the reason.
//
// Two different things happen to input this guard cannot act on, and collapsing
// them into one sentence is the mistake `.claude/rules/invariants.md`
// ("Refusing to inspect is a third outcome") says costs a credential either way:
//   - NOTHING TO JUDGE -> allow. An unparseable payload, no `tool_input`, no
//     `command`, an empty one, a tool this guard does not answer for, or a crash
//     inside `inspect` — a guard that has nothing to look at, or that broke, must
//     never make the session unusable.
//   - HANDED SOMETHING IT CANNOT READ -> block. A `command` that is present in a
//     shape this guard does not accept is refused, naming the shape expected,
//     because allowing it would report a check that never ran.
// The split is decided in one place for both shell guards, `lib/hook-input.mjs`.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { brakeIsOn } from '../scripts/stop-flag.mjs';
import { SHELL_TOOLS } from '../scripts/lib/shell-tools.mjs';
import { readHookInput, refusalText, shellCommandOf } from './lib/hook-input.mjs';

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
  'npx',
  'bunx',
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
  sudo: new Set([
    '-u', '-g', '-U', '-C', '-r', '-t', '-p', '-D', '-R',
    '--user', '--group', '--other-user', '--close-from', '--role', '--type',
    '--prompt', '--host', '--chdir', '--chroot',
  ]),
  doas: new Set(['-u', '-C']),
  // `-S` deliberately absent: its value is a whole command line, so skipping it
  // would hide the command. Left visible, it becomes an unrecognised command name
  // — a miss, but a miss that inspects rather than one that hides.
  env: new Set(['-u', '-C', '-P', '--unset', '--chdir']),
  xargs: new Set([
    '-n', '-I', '-L', '-P', '-s', '-d', '-a', '-E', '-e',
    '--max-args', '--replace', '--max-lines', '--max-procs', '--max-chars',
    '--delimiter', '--arg-file', '--eof-str',
  ]),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  stdbuf: new Set(['-i', '-o', '-e']),
};
const KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'fi', 'done', 'in', '!', '{', '}']);
/** Shells whose `-c` argument is itself a command line, so it must be parsed too. */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
/** Shell options that consume the following token before the `-c` script. */
const SHELL_VALUE_FLAGS = new Set(['-o', '-O', '+o', '+O', '--init-file', '--rcfile']);
const compactShellValueCount = (value) =>
  /^[+-][^+-]+$/.test(value)
    ? [...value].filter((flag) => flag === 'o' || flag === 'O').length
    : 0;

const shellScript = (args) => {
  let commandFlag = -1;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index].value;
    if (value === '--' || value === '-' || value === '+' || !/^[+-]/.test(value)) break;
    if (value === '-c' || (/^-[^-]+$/.test(value) && value.includes('c'))) {
      commandFlag = index;
      break;
    }
    const valueCount = compactShellValueCount(value);
    if (valueCount > 0 || SHELL_VALUE_FLAGS.has(value)) index += Math.max(1, valueCount);
  }
  if (commandFlag === -1) return '';

  const compactFlag = args[commandFlag].value;
  const compactValues = compactShellValueCount(compactFlag);
  const firstCandidate = commandFlag + 1 + compactValues;
  for (let index = firstCandidate; index < args.length; index += 1) {
    const value = args[index].value;
    if (value === '--') return args[index + 1]?.value ?? '';
    const valueCount = compactShellValueCount(value);
    if (valueCount > 0 || SHELL_VALUE_FLAGS.has(value)) {
      index += Math.max(1, valueCount);
      continue;
    }
    if ((value.startsWith('-') || value.startsWith('+')) && value !== '-' && value !== '+') continue;
    return value;
  }
  return '';
};
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
  '~/.ssh/*',
  '$HOME/.ssh/*',
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
 * The only directories whose CHILDREN are also catastrophic.
 *
 * Deliberately two entries, checked by a prefix test — bounded, no recursion. The
 * general prefix rule that once lived here blocked `/private/tmp`, `$TMPDIR`,
 * Homebrew and `/Volumes` (routine cleanup) and had to go; but `~/.ssh` was the
 * case that motivated it, and nothing in a project routinely deletes a file under
 * there. So it returns scoped to exactly that.
 */
const CATASTROPHIC_SUBTREES = ['~/.ssh', '$HOME/.ssh'];

const isCatastrophic = (target) =>
  CATASTROPHIC.has(target) ||
  CATASTROPHIC_SUBTREES.some((root) => target.startsWith(`${root}/`));

/**
 * The subset of CATASTROPHIC that is credential/key material rather than the
 * filesystem root or the whole home directory. Same targets, same block —
 * only the stated reason differs, because "this deletes the filesystem root
 * or the whole home directory" is simply false for `~/.ssh`: what is actually
 * destroyed is SSH key material, and a reason that misnames the risk is
 * misleading regardless of whether the command is still refused
 * (`.claude/rules/invariants.md`, "the remedy belongs to the refusal").
 *
 * Derived from `CATASTROPHIC_SUBTREES` rather than kept as a second literal
 * list — the two describe the same two directories, and a list that can drift
 * from the one it is a subset of eventually will.
 */
const CREDENTIAL_TARGETS = new Set([
  ...CATASTROPHIC_SUBTREES,
  ...CATASTROPHIC_SUBTREES.map((root) => `${root}/*`),
]);
/**
 * A target with a literal `..` segment does not actually stay inside the
 * credential subtree — `~/.ssh/..` IS `~`, `$HOME/.ssh/../../..` goes above
 * `$HOME` entirely — but the same prefix test that makes `isCatastrophic`
 * treat it as "reaches under `~/.ssh`" would otherwise call that upward
 * escape a credential deletion, which is exactly the misnaming this reason
 * exists to avoid. The reverse mistake is just as real, though (RP-262):
 * `~/.ssh/a/..` and `~/.ssh/a/../id_rsa` NEVER leave `~/.ssh`, yet a bare
 * literal-`..` gate withholds the credential wording from them too. Callers
 * resolve the target with `resolveTarget` (which folds `..` in one bounded
 * pass and reports a genuine escape as `/`) before asking this function —
 * at that point no in-subtree target carries a `..` any more, so the escape
 * still falls through to `isCatastrophic`'s own prefix match (so it stays
 * refused) with only the CREDENTIAL wording withheld, in favour of the
 * root/home one. The `!target.split('/').includes('..')` guard below is now
 * a defensive fallback for a caller that passes a target this way without
 * resolving it first — never the primary mechanism.
 */
const isCredentialTarget = (target) =>
  !target.split('/').includes('..') &&
  (CREDENTIAL_TARGETS.has(target) ||
    CATASTROPHIC_SUBTREES.some((root) => target.startsWith(`${root}/`)));

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
 *
 * ⚠ This is NOT a complete list of ways to reach the API, and cannot be:
 * `python3 -c "urllib…"` and `node -e "fetch(…)"` reach the same endpoint and are
 * the "assembled at runtime" limit stated at the top of this file. The brake
 * covers the clients an agent reaches for by habit, which is the drift it exists
 * to stop — not an adversary who has already decided to route around it.
 */
const NETWORK_CLIENTS = new Set([
  'gh',
  'hub',
  'curl',
  'curlie',
  'wget',
  'xh',
  'http',
  'https',
  'httpie',
]);
/** `gh` subcommands that read, or open a PR — the wind-down the brake asks for. */
const BRAKE_SAFE_GH = new Set(['view', 'list', 'status', 'diff', 'checks', 'create', 'help']);

/**
 * Under the brake a `git push` must name an explicit branch.
 *
 * The brake's premise is that pushing to a protected branch is refused anyway —
 * but that is only true when the command NAMES the branch. Bare `git push`,
 * `git push origin HEAD` and `git push --all` all land on the default branch when
 * you are on it, and the guard cannot know which branch you are on without
 * running git (it is deliberately pure). So while stopped, a push has to say
 * where it is going. `git push origin feat/x` — the wind-down the brake asks for —
 * is unaffected.
 */
const pushWithoutExplicitRef = ({ name, args }) => {
  if (name !== 'git') return false;
  const operands = operandsOf(args);
  if (!operands.some(({ value }) => value === 'push')) return false;
  if (hasFlag(args, '--all', '--mirror')) return true;
  const refs = operands.filter(({ value }) => value !== 'push').slice(1);
  return refs.length === 0 || refs.some(({ value }) => /^HEAD(:|$)/.test(value));
};

const deniedByBrake = (name, args) => {
  if (pushWithoutExplicitRef({ name, args })) return true;
  if (!NETWORK_CLIENTS.has(name)) return false;
  if (name !== 'gh' && name !== 'hub') return true;
  const operands = operandsOf(args, GH_FLAGS).map(({ value }) => value);
  // Nothing to do is not dangerous: `gh --version`, `gh help`.
  if (operands.length === 0) return false;
  // Read by POSITION. `some()` let any operand anywhere satisfy the allowlist,
  // so `gh pr merge 12 --subject create` passed on the word `create`.
  const [group, verb] = operands;
  // `create` is only safe for a PR — `gh release create --target main` is not the
  // wind-down the brake permits.
  if (verb === 'create') return group !== 'pr';
  return !(BRAKE_SAFE_GH.has(verb) || BRAKE_SAFE_GH.has(group));
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
  let pendingHeredoc = null;

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
    if (ch === '<' && raw[i + 1] === '<' && raw[i + 2] === '<') {
      // A here-string, not a heredoc: the word after it is DATA on stdin, and no
      // terminator line follows. Consumed whole — testing `raw[i+2] !== '<'` only
      // skipped the FIRST `<`, so the scanner advanced one and matched `<<WORD`
      // on the second, turning the here-string's word into a terminator and
      // swallowing everything up to the next line equal to it. Three characters
      // disarmed every rule.
      i += 3;
      continue;
    }
    if (ch === '<' && raw[i + 1] === '<' && heredocBudget > 0) {
      // A heredoc body is data, not commands. Recognised HERE, inside the
      // scanner, because only here is it known that the `<<` is unquoted.
      //
      // The marker is only NOTED — the rest of the marker line keeps tokenising,
      // and the body is skipped when its newline arrives. Jumping straight past
      // the terminator swallowed `cat <<EOF; rm -rf /` and merged the command
      // after the terminator into this segment. Both were hide-anything shapes,
      // which is precisely what moving this inside the tokenizer was meant to end.
      // The marker must be CLEANLY delimited. `<<EOF"X"` concatenates to `EOFX`
      // for the shell, and a guard that stops at `EOF` swallows further than the
      // shell does — the hide primitive again. When the models cannot be made to
      // agree, the marker is left inert and the body gets inspected.
      const marker = /^<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2(?=[\s;|&<>()`]|$)/.exec(
        raw.slice(i, i + 64),
      );
      if (marker) {
        // A TOTAL budget, not a per-step one: each lookahead scans forward, so an
        // input full of markers would be quadratic. Past the budget `<<` is two
        // characters again, which keeps the body visible — erring toward
        // inspecting more, never less.
        heredocBudget -= 1;
        // `<<-` strips leading TABS from the terminator line, so the terminator
        // the shell accepts is not the one a plain `\nEOF\n` search finds.
        pendingHeredoc = { word: marker[3], tabs: marker[1] === '-' };
        i += marker[0].length;
        continue;
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
    if (ch === '$' && raw[i + 1] === '(' && raw[i + 2] === '(') {
      // Arithmetic. `$((1<<n))` contains a LEFT SHIFT, not a heredoc — splitting
      // it as a subshell left `1<<n))` to be scanned as ordinary text, where the
      // marker regex matched `<<n` and swallowed the rest of the input.
      const end = raw.indexOf('))', i + 3);
      value += end === -1 ? raw.slice(i) : raw.slice(i, end + 2);
      started = true;
      i = end === -1 ? raw.length : end + 2;
      continue;
    }
    if (ch === '$' && raw[i + 1] === '(') {
      endSegment();
      i += 2;
      continue;
    }
    // `{`/`}` are NOT boundaries: a brace group is handled by the keyword skip in
    // `commandOf`, and braces inside a token belong to the token.
    if ('|;&\n()`'.includes(ch)) {
      endSegment();
      i += 1;
      if (ch === '\n' && pendingHeredoc) {
        // Skip the body and its terminator LINE, leaving the newline that ends
        // that line to act as the next boundary. If the terminator never appears
        // the body is kept and inspected rather than dropped — losing lines is
        // how the pre-pass hid commands.
        const { word, tabs } = pendingHeredoc;
        const terminator = new RegExp(`\n${tabs ? '\t*' : ''}${word}(?=\n|$)`);
        const found = terminator.exec(raw.slice(i - 1));
        if (found) i = i - 1 + found.index + found[0].length;
        pendingHeredoc = null;
      }
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

/**
 * Fold a `..` segment against the one immediately before it, in ONE forward
 * pass over the path with a stack — never recursion, never a rescan of what
 * was already folded, so this stays bounded even when the stack grows to
 * tens of thousands of segments before the `..` run folds it back
 * (`.claude/rules/invariants.md`, "a guard that fails open must do provably
 * bounded work" — pinned with 30,000 segments followed by 30,002 `..`,
 * timed inside the child, in the generator's
 * test/template/hooks.test.ts (absent in a generated rig) › "folds a long
 * run of `..` in bounded time and still blocks the escape").
 *
 * `clampAtRoot: true` is for an absolute path: `/..` IS `/`, there is nowhere
 * higher to go, so a `..` past an empty stack is simply dropped. `clampAtRoot:
 * false` is for a `~`/`$HOME`-anchored path, where popping past an empty
 * stack climbs OUT of the anchor into territory this guard has no name for —
 * reported back as `escaped` rather than guessed at.
 */
function foldDotDot(parts, { clampAtRoot }) {
  const stack = [];
  let escaped = false;
  for (const part of parts) {
    if (part === '..') {
      if (stack.length > 0) stack.pop();
      else if (!clampAtRoot) escaped = true;
    } else {
      stack.push(part);
    }
  }
  return { parts: stack, escaped };
}

/**
 * The fully `..`-resolved form of a target. `normalizeTarget` cleans up `.`,
 * `//` and `${HOME}` but leaves a literal `..` segment untouched — so
 * `~/.ssh/..` (which IS `~`) never matched the exact-match `cd` check, and a
 * target that stays inside `~/.ssh` despite spelling a `..` (`~/.ssh/a/..`)
 * was indistinguishable from one that actually escapes it (RP-262).
 *
 * Only an ANCHORED path is folded — `/…`, `~…`, `$HOME…`. A plain relative
 * target (`src/..`, `../sibling-project`) is returned exactly as
 * `normalizeTarget` already had it: it can never resolve without knowing the
 * working directory, and it can never spell a catastrophic target by
 * accident either — folding it would only change what an ordinary relative
 * `..` prints, never whether anything here blocks it.
 *
 * An anchor-escape (`~/..`, `$HOME/../../..`) has no home-relative name for
 * where it lands, but it lands somewhere between the home directory and the
 * filesystem root — the same non-credential bucket `isCatastrophic`/the
 * upward-escape fallback below already treat root and "above home" as one
 * category, so it resolves to `/`, which both are already exact members of.
 */
function resolveTarget(token) {
  const target = normalizeTarget(token);
  if (target.startsWith('/')) {
    const { parts } = foldDotDot(target.slice(1).split('/').filter(Boolean), {
      clampAtRoot: true,
    });
    return parts.length === 0 ? '/' : `/${parts.join('/')}`;
  }
  const [anchor, ...rest] = target.split('/');
  if (anchor !== '~' && anchor !== '$HOME') return target;
  const { parts, escaped } = foldDotDot(rest, { clampAtRoot: false });
  if (escaped) return '/';
  return parts.length === 0 ? anchor : `${anchor}/${parts.join('/')}`;
}

/**
 * The `cd` OPERAND, read past whatever precedes it (RP-309 gate round 2):
 * `--` ends option parsing without being an operand itself; any OTHER token
 * starting with `-` that is more than one character (`-P`, `-L`, `-e`, `-@`,
 * …) is an option and is skipped rather than read as the target — the
 * previous version read the raw first token unconditionally, so the real
 * path one argument later was never looked at. A LONE `-` before any operand
 * is `$OLDPWD` and is reported as its own kind, because it must resolve
 * differently from a bare `cd` (`$HOME`) — see `advanceCwd`. No token left
 * at all is reported as `bare`. `cd`'s own grammar is otherwise unchanged
 * from before RP-309 gate round 3 — only `pushd` (`pushdOperand` below) got
 * a stricter grammar, because only `pushd` turned out to have one.
 */
function cdOperand(args) {
  let sawDashDash = false;
  for (const { value } of args) {
    if (!sawDashDash) {
      if (value === '--') {
        sawDashDash = true;
        continue;
      }
      if (value === '-') return { kind: 'oldpwd' };
      if (value.length > 1 && value.startsWith('-')) continue; // -P, -L, -e, -@…
    }
    return { kind: 'token', value };
  }
  return { kind: 'bare' };
}

/**
 * `pushd`'s own argument grammar (RP-309 gate round 3, post-cap) — real bash
 * accepts exactly `pushd [-n] [dir]` or `pushd [-n] [+N | -N]`, nothing else:
 *
 *   - `-n` suppresses the directory change entirely (the DIRECTORY argument
 *     that may follow it is pushed onto the stack, never cd-ed to), so it is
 *     reported as `unmoved` the moment it is seen — nothing after it can
 *     change that, unlike an ordinary flag;
 *   - a digits-only `+N`/`-N` rotates the stack to its Nth entry rather than
 *     naming a directory. This guard tracks at most ONE position, i.e. it
 *     always reads the real stack as EMPTY — where it genuinely is empty,
 *     real bash's own rotation FAILS exactly like a bare `pushd` does, and
 *     `unmoved` is simply correct; where a real stack is NOT empty, rotation
 *     actually SUCCEEDS and moves the shell somewhere this guard has no name
 *     for, and `unmoved` there is the same deliberate over-block already
 *     chosen for a populated `pushd DIR`/bare `pushd` (see `advanceCwd`'s own
 *     "never downgrades" doc comment) — never a claim that rotation itself
 *     always fails;
 *   - `--` ends option parsing without being an operand itself;
 *   - exactly ONE bare directory operand is a real `pushd DIR` and is
 *     reported as `token`;
 *   - anything else is a command real bash REJECTS outright (`invalid
 *     number`/`too many arguments`), which leaves the cwd exactly where it
 *     was — so it is `unmoved`, not a skipped flag the way `cd`'s own
 *     `-P`/`-L` are. That covers every OTHER `-`/`+`-prefixed token (`-P`,
 *     `-L`, `-x`, the combined `-nP`, a non-digit `+x`, …) and a SECOND bare
 *     operand (`pushd DIR1 DIR2`) alike — `cd`'s generic flag-skip would
 *     have treated the former as an ordinary option and read the token after
 *     it as the real DIR, and would have silently accepted the latter as if
 *     the second operand were never there.
 *
 * No token left at all is `bare` — a real, populated stack SWAPS the top two
 * entries, which this guard cannot know either; see `advanceCwd`.
 */
function pushdOperand(args) {
  let sawDashDash = false;
  let dir = null;
  for (const { value } of args) {
    if (!sawDashDash) {
      if (value === '--') {
        sawDashDash = true;
        continue;
      }
      if (value === '-') return { kind: 'oldpwd' };
      if (value === '-n') return { kind: 'unmoved' }; // suppresses the cd entirely
      if (/^[+-]\d+$/.test(value)) return { kind: 'unmoved' }; // stack rotation, not a dir
      if (value.startsWith('-') || value.startsWith('+')) return { kind: 'unmoved' }; // bash rejects it
    }
    if (dir !== null) return { kind: 'unmoved' }; // a second operand: "too many arguments"
    dir = value;
  }
  return dir === null ? { kind: 'bare' } : { kind: 'token', value: dir };
}

const cdOperandFor = (name, args) => (name === 'pushd' ? pushdOperand(args) : cdOperand(args));

/**
 * Fold a relative operand's OWN segments onto a tracked `{ anchor, parts }`
 * stack, MUTATING `state.parts` in place — one forward pass over the
 * operand's own length, never a re-split/re-join/spread of the whole tracked
 * stack (RP-309 gate round 2; the previous version rebuilt the entire
 * anchor on every relative `cd`, which made a long chain of them cost
 * anchor-length × chain-length instead of anchor-length + chain-length — see
 * the header's own bounded-work section and test/template/hooks.test.ts
 * (absent in a generated rig) › "resolves a relative cd chain against a long
 * anchored prefix in bounded time, not quadratically (RP-309 gate round 2)"
 * and › "resolves a long, non-popping relative cd chain in bounded time, not
 * quadratically (RP-309 gate round 2)").
 *
 * `.` and an empty segment (so `./`'s trailing slash is inert too) are
 * no-ops — RP-309 gate round 2: the previous version pushed a literal `.`
 * onto the stack as an ordinary segment, so it was never itself catastrophic
 * and a later `..` popped the placeholder instead of the real segment under
 * it. `..` pops one tracked segment; popping past an empty stack escapes the
 * anchor itself, reported by switching `state.anchor` to `/` — the same
 * conservative "nowhere higher to name but the filesystem root" reading
 * `resolveTarget` already uses for an anchor escape (RP-262). Anything else
 * is pushed.
 */
function foldRelativeSegments(state, raw) {
  const normalized = raw.replace(/\$\{HOME\}/g, '$HOME');
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (state.parts.length > 0) {
        state.parts.pop();
      } else if (state.anchor !== '/') {
        state.anchor = '/';
      }
      continue;
    }
    state.parts.push(segment);
  }
}

/**
 * The joined string form of a `{ anchor, parts }` position — `~`, `~/.ssh`,
 * `/etc`, `/`, … Only called where `parts` is already known to be short
 * (bounded by `classifyPosition`'s own `MAX_CATASTROPHIC_DEPTH` check, or by
 * an operand's own length in `resolveRmOperandAgainstCwd`) — never on the
 * tracked cwd's full stack unconditionally, which is exactly what made
 * `checkRm` quadratic in the number of `rm` segments/operands on a command
 * line before RP-309 gate round 3 (it joined the WHOLE tracked stack once
 * per segment, and again once per `..`-bearing operand — see
 * test/template/hooks.test.ts (absent in a generated rig) ›
 * "joins the tracked cwd once per rm segment, not once per segment squared
 * (RP-309 gate round 3)" and › "resolves each `..`-bearing rm operand
 * against the tracked cwd once, not once per operand squared (RP-309 gate
 * round 3)").
 */
function cwdTargetString(cwd) {
  if (!cwd) return null;
  if (cwd.anchor === '/') return cwd.parts.length === 0 ? '/' : `/${cwd.parts.join('/')}`;
  return cwd.parts.length === 0 ? cwd.anchor : `${cwd.anchor}/${cwd.parts.join('/')}`;
}

/**
 * The deepest non-`.ssh` member of `CATASTROPHIC` is 2 segments past its
 * anchor (`/usr/*`, `/System/*`, …); doubled with margin so a future
 * addition to that set does not have to move this bound. Past this depth —
 * and outside the one subtree allowed to be deep, see `classifyPosition` —
 * a position is provably not a member of `CATASTROPHIC` without ever
 * joining `parts` to check.
 */
const MAX_CATASTROPHIC_DEPTH = 8;

/**
 * The longest single `/`-separated segment among every literal entry in
 * `CATASTROPHIC` — `Applications` (12 characters) is the longest today.
 * Derived rather than a second hand-picked number (`.claude/rules/
 * invariants.md`, "one spelling of a fact"): whichever member is longest,
 * this bound moves with it automatically. Used by `classifyPosition` below
 * to answer "not catastrophic" from a single segment's OWN LENGTH, in
 * constant time (`String#length` is O(1) — no join, no scan of the
 * characters) — every real member of `CATASTROPHIC` is a short, literal
 * name, so a `parts` segment longer than this can never equal one, whatever
 * `MAX_CATASTROPHIC_DEPTH` allows through on segment COUNT alone (RP-309
 * gate round 3, post-cap).
 */
const MAX_CATASTROPHIC_PART_LENGTH = Math.max(
  0,
  ...[...CATASTROPHIC].flatMap((entry) => entry.split('/').filter(Boolean).map((part) => part.length)),
);

/**
 * Classify a `{ anchor, parts }` position as catastrophic/credential WITHOUT
 * joining the whole `parts` array when it is long (RP-309 gate round 3) —
 * bounded by LENGTH as well as by COUNT (RP-309 gate round 3, post-cap): a
 * `parts` array within `MAX_CATASTROPHIC_DEPTH` entries can still carry a
 * single, individually enormous segment (a tracked `cd` anchor built from
 * one huge path component), and joining `parts` into a string to compare
 * against `CATASTROPHIC` would pay for that segment's full length on every
 * call — repeated once per `rm` segment/operand on a long command line, that
 * is quadratic in segment length rather than in segment count. So any
 * segment longer than `MAX_CATASTROPHIC_PART_LENGTH` answers "not
 * catastrophic" from its own `.length` alone (O(1) per segment, O(depth)
 * total — `depth` already bounded by `MAX_CATASTROPHIC_DEPTH`), before ever
 * joining anything; the joined prefix this function goes on to build is
 * therefore never more than `MAX_CATASTROPHIC_DEPTH *
 * MAX_CATASTROPHIC_PART_LENGTH` characters.
 *
 * Being (still) inside the `~/.ssh`/`$HOME/.ssh` subtree is decided from
 * `parts[0]` alone, however many segments follow — a tracked position never
 * carries a literal `..` (`foldRelativeSegments`/`resolveTarget` fold it
 * away as they build `parts`, and `resolveRmOperandAgainstCwd` below folds
 * an operand's own `..` before ever reading the tracked stack), so nothing
 * past `.ssh` can walk back out of the subtree — see `isCredentialTarget`'s
 * own doc comment for why a literal `..` would otherwise defeat this exact
 * shortcut. Everything else beyond `MAX_CATASTROPHIC_DEPTH`, or carrying a
 * segment beyond `MAX_CATASTROPHIC_PART_LENGTH`, is answered "not
 * catastrophic" without ever joining; within both bounds, the join is cheap
 * enough to just do and compare against the real sets.
 */
function classifyPosition(anchor, parts) {
  const inSshSubtree = (anchor === '~' || anchor === '$HOME') && parts[0] === '.ssh';
  if (inSshSubtree) return { catastrophic: true, credential: true };
  if (parts.length > MAX_CATASTROPHIC_DEPTH) return { catastrophic: false, credential: false };
  if (parts.some((part) => part.length > MAX_CATASTROPHIC_PART_LENGTH)) {
    return { catastrophic: false, credential: false };
  }
  const target = cwdTargetString({ anchor, parts });
  return { catastrophic: isCatastrophic(target), credential: isCredentialTarget(target) };
}

/**
 * The position a fresh `cd`/`pushd` OPERAND resolves to, given whatever was
 * already tracked (`cwd`, or `null`) — the anchored/relative resolution RP-309
 * (gate round 2) already had, factored out so this function can compare a
 * candidate against the position it would REPLACE before committing to the
 * replacement (RP-309 gate round 3, post-cap: `pushd` never downgrades — see
 * below, decided IN HERE rather than by `advanceCwd` after the fact, RP-309
 * post-cap 3).
 * `null` means "cannot be resolved" (a `~user` operand, or a relative operand
 * with no tracked anchor to fold against). One exception: a `pushd ~user`
 * from a catastrophic tracked position keeps that position instead, since a
 * failed pushd leaves the shell where it was (RP-309 post-cap 4).
 *
 * Never copies the tracked stack (RP-309 post-cap 3). The previous version
 * copied `cwd.parts` (`[...cwd.parts]`) before folding a relative `pushd`, to
 * keep the pre-fold value available for a never-downgrade comparison
 * `advanceCwd` used to make afterward — and that copy made a long
 * relative-`pushd` chain quadratic: pinned in the generator's
 * test/template/hooks.test.ts (absent in a generated rig) ›
 * "resolves a long chain of relative pushds off a very deep cwd in bounded
 * time, not quadratically (RP-309 post-cap 3)". The fix never builds that
 * copy at all — it decides `wasCatastrophic` from the TRACKED position up
 * front (one `classifyPosition` call, already O(1) per call — see its own
 * doc comment for why), then:
 *   - not catastrophic: nothing to preserve, so both a relative `pushd` and a
 *     plain `cd` fold in place — `foldRelativeSegments` mutating `cwd.parts`
 *     directly, one forward pass over the OPERAND's own length (RP-309 gate
 *     round 2's own bound: anchor-length + chain-length, never anchor-length
 *     × chain-length);
 *   - catastrophic, and the operand is anchored: the candidate is built
 *     fresh (it never shares `cwd.parts`), so classifying it and comparing
 *     against `wasCatastrophic` costs nothing extra;
 *   - catastrophic, and the operand is relative: the candidate is classified
 *     WITHOUT ever being built, by `resolveRmOperandAgainstCwd` — the same
 *     bounded reader `checkRm` already uses for a `..`-bearing `rm` operand,
 *     reading at most `MAX_CATASTROPHIC_DEPTH` tracked entries (or answering
 *     from `parts[0]` alone inside the unbounded-depth `~/.ssh` subtree — see
 *     `classifyPosition`'s own doc comment, and
 *     test/template/hooks.test.ts (absent in a generated rig) ›
 *     "keeps deciding a catastrophic ~/.ssh position in bounded time across
 *     many relative pushds, not quadratically (RP-309 post-cap 3)"). Not
 *     catastrophic: `cwd` is returned untouched (never downgrade). Still
 *     catastrophic: nothing downstream needs the PRE-fold value back
 *     anymore, so folding in place is now safe.
 *
 * Before this fix, a relative `pushd`'s own fold handed `foldRelativeSegments`
 * the TRACKED array itself, so the mutation it does in place (`push`/`pop`)
 * silently rewrote `cwd.parts` too, before the never-downgrade check (then
 * living in `advanceCwd`) ever read it — both "was catastrophic" and "is the
 * candidate catastrophic" read the SAME, already-folded position, so a
 * catastrophic `cwd` always looked "still catastrophic" trivially and the
 * check could never fire. `cd ~ && pushd project && rm -rf *` mistracked `~`
 * (catastrophic) as `~/project` (not) and let the wildcard delete through —
 * pinned in the generator's
 * test/template/hooks.test.ts (absent in a generated rig) ›
 * "never lets pushd downgrade an already-tracked catastrophic cwd reached
 * via pushd itself, not only via cd (RP-309 post-cap 3)" — reached through
 * `pushd` alone, so base's own `cd`-only floor (`legacyCdTarget`) cannot
 * rescue a regression here.
 */
function computeCdTarget(cwd, raw, name) {
  const isPushd = name === 'pushd';
  const wasCatastrophic =
    isPushd && cwd ? classifyPosition(cwd.anchor, cwd.parts).catastrophic : false;
  // `~user`: another account's home, never resolved; a pushd never lowers a
  // catastrophic tracking through it (never downgrade).
  if (/^~[^/]/.test(raw)) return wasCatastrophic ? cwd : null;

  if (/^(\/|~|\$HOME)/.test(raw)) {
    const resolved = resolveTarget(raw);
    let candidate;
    if (resolved.startsWith('/')) {
      candidate = { anchor: '/', parts: resolved.slice(1).split('/').filter(Boolean) };
    } else {
      const [anchor, ...parts] = resolved.split('/');
      candidate = { anchor, parts };
    }
    if (wasCatastrophic && !classifyPosition(candidate.anchor, candidate.parts).catastrophic) {
      return cwd; // never downgrade
    }
    return candidate;
  }

  if (!cwd) return null; // no tracked anchor to fold a relative cd against

  if (!isPushd || !wasCatastrophic) {
    foldRelativeSegments(cwd, raw); // nothing to preserve — safe to mutate in place
    return cwd;
  }

  if (!resolveRmOperandAgainstCwd(cwd, normalizeTarget(raw)).catastrophic) {
    return cwd; // never downgrade — leave the tracked stack untouched
  }
  foldRelativeSegments(cwd, raw); // already committed to replacing — safe to fold in place now
  return cwd;
}

/**
 * What a `cd`/`pushd` operand does to the command line's tracked cwd, given
 * whatever a PRIOR `cd`/`pushd` already left (`{ anchor, parts }`, or `null`
 * when nothing is tracked). Tracks the position whether or not it is itself
 * catastrophic — `cd ~/project` is not, but a later `cd ..` off it needs
 * somewhere real to fold against — and lets the caller decide
 * catastrophic-ness at the point a wildcard delete actually asks.
 *
 * `${HOME}` (braced, possibly quoted) is normalised to `$HOME` before the
 * `~user` and anchor checks below (RP-309 gate round 2) — the anchor test
 * used to run on the raw operand, so `${HOME}/.ssh` was never recognised as
 * anchored at all. A fresh anchored operand is resolved with `resolveTarget`
 * against its OWN segments only (RP-262's own bound: linear in the
 * operand's length), never against whatever was tracked before it — a new
 * anchor simply replaces the old one, the same as a real `cd` does.
 *
 * The never-downgrade decision for an ORDINARY `cd`/`pushd` operand lives in
 * `computeCdTarget` now (RP-309 post-cap 3) — this function no longer
 * compares a candidate against the tracked position itself. The `oldpwd`
 * branch just below is the one exception: `pushd -` never goes through
 * `computeCdTarget` at all (there is no operand to resolve), so it keeps its
 * own never-downgrade check inline.
 *
 * See the header's own "The limits, stated exactly" section for the
 * spellings this deliberately still cannot resolve (`cd -`/`pushd -`,
 * `~user`, `popd`, a bare `pushd`, `pushd -n`/`+N`/`-N`, a subshell-local
 * `cd`, `builtin cd`).
 */
function advanceCwd(cwd, name, args) {
  const operand = cdOperandFor(name, args);
  if (operand.kind === 'oldpwd') {
    // `cd -`/`pushd -` return to `$OLDPWD`, which this guard cannot resolve
    // (header's own limits) — but `pushd -`, unlike `cd -`, sits on a REAL
    // directory stack this guard does not model: exactly the reasoning
    // `computeCdTarget`'s own never-downgrade branch applies to an ordinary
    // `pushd DIR`. RP-309 post-cap (differential): clearing tracking to
    // "unknown" here let `pushd -` erase a catastrophic `cd`/`pushd` earlier
    // on the SAME command line (`cd / && pushd - && rm -rf *`) — pinned in the
    // generator's
    // test/template/hooks.test.ts (absent in a generated rig) ›
    // "never lets pushd downgrade an already-tracked catastrophic cwd
    // reached via pushd itself, not only via cd (RP-309 post-cap 3)" (which
    // also covers `pushd / && pushd - && rm -rf *`, reached through `pushd`
    // alone). So an already-tracked CATASTROPHIC position survives a
    // `pushd -` unresolved, over-blocking in the same safe direction as
    // `pushd DIR`/rotation/a bare `pushd` already do. `cd -` keeps clearing
    // to `null`: it fully REPLACES the position the same way an ordinary
    // `cd` does, and the legacy tracker `inspect()` also keeps (see its own
    // doc comment) gives it an independent floor regardless.
    if (name === 'pushd' && cwd && classifyPosition(cwd.anchor, cwd.parts).catastrophic) {
      return cwd;
    }
    return null;
  }
  if (operand.kind === 'unmoved') return cwd; // RP-309 gate round 3: `pushd -n DIR`/`pushd +N`/`pushd -N` never move the cwd
  if (operand.kind === 'bare') {
    // A bare `cd` genuinely lands at $HOME. A bare `pushd` SWAPS the
    // directory stack rather than landing at $HOME — with nothing tracked
    // yet there is nothing to swap to either (tracking stays cleared). This
    // guard never tracks more than ONE entry, so it always reads the real
    // stack as being that shallow — where the real stack genuinely IS that
    // shallow (empty, or the one entry this guard itself tracked), a bare
    // `pushd` FAILS in real bash and leaves the cwd exactly where it was
    // (RP-309 gate round 3). Where a real, POPULATED stack sits underneath
    // (something this guard cannot see either way), a bare `pushd` actually
    // SWAPS and moves the shell somewhere else — "leave cwd exactly as it
    // is" is then the same deliberate over-block already chosen for
    // `pushd DIR`/rotation below, never a claim that the swap itself always
    // fails. Both readings return `cwd` itself unchanged, whether that is
    // `null` or tracked.
    return name === 'pushd' ? cwd : { anchor: '~', parts: [] };
  }
  const raw = operand.value.replace(/\$\{HOME\}/g, '$HOME');
  return computeCdTarget(cwd, raw, name);
}

/**
 * Fold a `..`-bearing `rm` OPERAND's OWN segments in isolation — never
 * reading the tracked cwd at all — into how many segments it pops off
 * whatever precedes it (`popCount`) and what it pushes after those pops
 * (`localSegments`). Bounded to the operand's own length, exactly like
 * `foldRelativeSegments` (RP-309 gate round 2) already is for a `cd` — the
 * input has already been through `normalizeTarget`, so `.`/empty segments
 * and `${HOME}` are already gone; the filter below is a defensive no-op for
 * that, not a second pass over anything.
 */
function foldOperandSegments(normalized) {
  const local = [];
  let popCount = 0;
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (local.length > 0) local.pop();
      else popCount += 1;
      continue;
    }
    local.push(segment);
  }
  return { popCount, localSegments: local };
}

/**
 * A RELATIVE `..`-bearing `rm` operand classified against the tracked cwd —
 * an `rm` never itself changes the working directory, so the tracked stack
 * a later `cd`/`pushd` on the same command line reads must come out exactly
 * as it was (RP-309 gate round 2, "the escape check"); reading only
 * `cwd.parts.length`/`cwd.parts[0]` and, when needed, a bounded PREFIX slice
 * accomplishes that without ever copying the whole tracked stack (RP-309
 * gate round 3: the previous version sliced a COPY of the whole tracked
 * `parts` array for every such operand, which made a single `rm` with many
 * `../x` operands off a long anchored `cd` pay the anchor's full length on
 * each one — operand count × anchor depth, not operand count + anchor
 * depth).
 *
 * `computeCdTarget` reuses this exact function for a relative `pushd` operand
 * too (RP-309 post-cap 3) — an `rm` operand and a `pushd` operand resolve
 * against the tracked cwd identically; only what happens to the RESULT
 * differs (an `rm` never moves the cwd, a still-catastrophic `pushd`
 * replaces it — see that function's own doc comment).
 *
 * The operand's own segments are folded in isolation first
 * (`foldOperandSegments`) into `popCount` and `localSegments`. The
 * surviving depth (`cwd.parts.length - popCount`) then decides how much of
 * the tracked stack actually needs reading:
 *   - negative: popped past the tracked anchor itself — nowhere higher to
 *     name but the filesystem root, the same reading `resolveTarget`/
 *     `foldRelativeSegments` already use for that escape;
 *   - zero: lands exactly at the anchor, plus whatever `localSegments`
 *     pushed after it;
 *   - positive, inside the `~/.ssh`/`$HOME/.ssh` subtree (`cwd.parts[0] ===
 *     '.ssh'`): catastrophic/credential regardless of how deep, decided
 *     without reading anything past that one element;
 *   - positive and shallow enough (`<= MAX_CATASTROPHIC_DEPTH`): the
 *     surviving PREFIX (bounded by that constant, never the whole stack) is
 *     read and joined with `localSegments`;
 *   - positive and deep: provably not catastrophic from the depth alone.
 */
function resolveRmOperandAgainstCwd(cwd, target) {
  const { popCount, localSegments } = foldOperandSegments(target);
  const survivingDepth = cwd.parts.length - popCount;

  if (survivingDepth < 0) return classifyPosition('/', localSegments);
  if (survivingDepth === 0) return classifyPosition(cwd.anchor, localSegments);

  const inSshSubtree =
    (cwd.anchor === '~' || cwd.anchor === '$HOME') && cwd.parts[0] === '.ssh';
  if (inSshSubtree) return { catastrophic: true, credential: true };
  if (survivingDepth > MAX_CATASTROPHIC_DEPTH) return { catastrophic: false, credential: false };

  const survivingPrefix = cwd.parts.slice(0, survivingDepth); // bounded: <= MAX_CATASTROPHIC_DEPTH
  return classifyPosition(cwd.anchor, survivingPrefix.concat(localSegments));
}

/**
 * The literal spellings that mean "everything in the tracked cwd" when that
 * cwd is itself catastrophic — checked against the operand text directly.
 * `normalizeTarget` already reduces `./*` to a bare `*` (already a member
 * below), so a `./*` entry here would never be reached; that dead comparison
 * was removed rather than left to imply a fold `normalizeTarget` does not
 * actually do. A `..`-bearing operand is never compared against this set —
 * it is resolved against the tracked cwd by `resolveRmOperandAgainstCwd`
 * above instead, wherever it actually lands (RP-309 gate round 2).
 */
const WILDCARD_AFTER_CD = new Set(['*', '.', './']);

/**
 * RP-309 post-cap (controller design decision, differential floor): base's
 * OWN `cd` tracking, restored exactly as it read at 58f9635 — one string, set
 * ONLY by `cd` (never by `pushd`, which base never inspected at all), from an
 * EXACT match against `CATASTROPHIC` of `operandsOf(args)[0]`. `operandsOf`
 * treats any `-`-prefixed token as a flag to skip (`-` and `-C` included, and
 * `-C`'s own value with it) — a cruder reading than `cdOperand`'s dedicated
 * grammar below, kept exactly that crude on purpose.
 *
 * `checkRm` asks this AS WELL AS the newer `{ anchor, parts }` tracker and
 * blocks when EITHER says so (see its own call site) — so a case where the
 * newer tracker's own grammar reads a `cd` operand differently from base's
 * `operandsOf` (`cd - /`, `cd -C x /`), or where `pushd`/`popd` land the
 * newer tracker somewhere base was never told to look at all (base simply
 * never clears or replaces what a prior `cd` left), cannot silently become
 * ALLOWED just because the newer tracker's own reading of that one case
 * changed. Pinned in the generator's
 * test/template/hooks.test.ts (absent in a generated rig) › "never allows a
 * command the base guard blocked (RP-309 post-cap, differential)".
 *
 * Bounded exactly as base's own version was: one `resolveTarget` call on the
 * `cd`'s own operand, done once per `cd` segment — never accumulated, never
 * revisited by a `pushd`/`rm` segment that follows.
 */
function legacyCdTarget(args) {
  const target = resolveTarget(operandsOf(args)[0]?.value ?? '');
  return CATASTROPHIC.has(target) ? target : null;
}

function checkRm({ args }, cwd, legacyCwd) {
  // Classified ONCE per `rm` segment, not rebuilt from a join per operand
  // below — see `classifyPosition`'s own bound. `legacyCwd`, whenever it is
  // not `null`, is always one of the short, literal `CATASTROPHIC` members —
  // `legacyCdTarget` only ever sets it from an EXACT match — so testing it is
  // O(1) regardless of how long the command line's other tracked state is.
  const cwdStatus = cwd ? classifyPosition(cwd.anchor, cwd.parts) : null;
  const cwdCatastrophic = Boolean(cwdStatus?.catastrophic) || legacyCwd !== null;
  const cwdCredential =
    Boolean(cwdStatus?.credential) || (legacyCwd !== null && isCredentialTarget(legacyCwd));
  for (const { value } of operandsOf(args)) {
    const normalized = normalizeTarget(value);
    const anchored = /^(\/|~|\$HOME)/.test(normalized);
    const escapesUpward = normalized.split('/').includes('..');

    // RP-309 gate round 2 ("the escape check"): a RELATIVE `..`-bearing
    // operand is resolved against the tracked cwd, so `rm -rf ..`/`rm -rf
    // ../*` are judged by where they actually land — not only recognised
    // when the tracked cwd was already catastrophic. Handled as its own
    // branch (RP-309 gate round 3) because it is classified directly,
    // never via a joined target string — see `resolveRmOperandAgainstCwd`.
    if (cwd && !anchored && escapesUpward) {
      const resolved = resolveRmOperandAgainstCwd(cwd, normalized);
      if (resolved.catastrophic) {
        if (resolved.credential) {
          return (
            'BLOCKED — this deletes SSH credentials/key material under ~/.ssh, ' +
            'which breaks authentication and cannot be recovered from a delete. If a ' +
            'specific key genuinely needs removing, name it precisely and confirm ' +
            'with the human who owns that key first.'
          );
        }
        return (
          'BLOCKED — this deletes the filesystem root or the whole home directory, ' +
          'which no task in this project requires. If a path really needs removing, ' +
          'name it relative to the project.'
        );
      }
      // Not catastrophic where it lands — an operand that resolved through
      // `..` can never itself equal a bare `*`/`.`/`./`, so there is nothing
      // more for the WILDCARD_AFTER_CD check below to add for THIS operand.
      continue;
    }

    const target = normalized;
    // For an ANCHORED operand this stays `resolveTarget(value)` exactly as
    // before — the pre-existing subtree-prefix reasoning above
    // `isCredentialTarget`'s own doc comment is untouched. For anything else
    // (no `cwd`, or no `..`) `resolveTarget` folds nothing further anyway,
    // so it is skipped rather than called for no reason.
    const credentialSource = anchored ? resolveTarget(value) : target;

    if (isCatastrophic(target)) {
      if (isCredentialTarget(credentialSource)) {
        return (
          'BLOCKED — this deletes SSH credentials/key material under ~/.ssh, ' +
          'which breaks authentication and cannot be recovered from a delete. If a ' +
          'specific key genuinely needs removing, name it precisely and confirm ' +
          'with the human who owns that key first.'
        );
      }
      return (
        'BLOCKED — this deletes the filesystem root or the whole home directory, ' +
        'which no task in this project requires. If a path really needs removing, ' +
        'name it relative to the project.'
      );
    }
    // An upward escape from root or home reaches the same place by another name.
    if (anchored && escapesUpward) {
      return (
        'BLOCKED — this path escapes upward out of the home directory or the ' +
        'filesystem root, which reaches the same place as deleting it outright.'
      );
    }
    // `cd / && rm -rf *` is `rm -rf /*` with the target hidden in a prior
    // segment. `catastrophic` (not mere presence of a tracked cwd) is what
    // gates this — `cwdStatus` may equally describe an ordinary,
    // non-catastrophic cwd (`~/project`) tracked only so a later relative
    // `cd` has somewhere to fold against. `cwdCatastrophic` is EITHER
    // tracker's opinion (RP-309 post-cap, differential — see
    // `legacyCdTarget`'s own doc comment), and `cwdCredential` prefers the
    // credential wording the moment either one is a credential target.
    if (cwdCatastrophic && WILDCARD_AFTER_CD.has(target)) {
      if (cwdCredential) {
        return (
          'BLOCKED — an earlier segment changed directory into SSH credentials/key ' +
          'material under ~/.ssh, so this wildcard delete destroys them. If a ' +
          'specific key genuinely needs removing, name it precisely and confirm ' +
          'with the human who owns that key first.'
        );
      }
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
  // Nested `eval`/`bash -c` beyond this is not drift, and following it forever is
  // unbounded work. The depth is a stated limit, not an accident.
  if (depth > 16) return null;
  let cwd = null;
  // RP-309 post-cap (differential floor): base's own `cd`-only tracking,
  // running alongside `cwd` for the whole command line — see
  // `legacyCdTarget`'s own doc comment for why, and `checkRm`'s call site for
  // how the two are combined.
  let legacyCwd = null;

  for (const segment of tokenize(raw)) {
    // The brake, before any per-command rule: while the flag is on, the
    // network clients are refused whatever they are being asked to do.
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
      const script =
        command.name === 'eval'
          ? command.args.map(({ value }) => value).join(' ')
          : shellScript(command.args);
      if (script) {
        const reason = inspect(script, brake, depth + 1);
        if (reason) return reason;
      }
      continue;
    }

    if (command.name === 'cd' || command.name === 'pushd') {
      // RP-262: resolved (`..`-folded), not merely normalised — `~/.ssh/..`
      // is `~`, and an exact-match lookup against the literal string
      // `~/.ssh/..` (which is not itself in CATASTROPHIC) let a wildcard
      // delete right after it through uninspected.
      //
      // RP-309: `pushd` changes the working directory exactly like `cd`
      // does, so it is tracked the same way. And a RELATIVE operand is
      // folded against whatever anchored target a PRIOR `cd`/`pushd` on
      // this same command line already landed on, instead of unconditionally
      // resetting tracking to "unknown".
      //
      // RP-309 gate round 2: the operand itself is read by `cdOperand`, past
      // `--`/a leading multi-character flag (`-P`, `-L`, …) rather than off
      // `args[0]` raw — see `advanceCwd`. The tracked cwd is a stack
      // (`{ anchor, parts }`) mutated in place across the whole command
      // line, never rebuilt per `cd` — see `foldRelativeSegments`.
      cwd = advanceCwd(cwd, command.name, command.args);
      // Base (58f9635) never looked at `pushd` at all — only `cd` moved its
      // one `catastrophicCwdTarget` string, so this legacy tracker is
      // restored to do exactly that and no more (RP-309 post-cap,
      // differential): a `pushd`/`popd` on this command line leaves it
      // untouched, whatever a prior `cd` set it to.
      if (command.name === 'cd') legacyCwd = legacyCdTarget(command.args);
      continue;
    }

    const reason =
      command.name === 'git'
        ? checkGit(command)
        : command.name === 'gh'
          ? checkGh(command, brake)
          : command.name === 'rm'
            ? checkRm(command, cwd, legacyCwd)
            : null;
    if (reason) return reason;
  }
  return null;
};

function main() {
  const input = readHookInput();
  if (input === null) return 0;
  // The ONE list decides which surfaces this guard answers for. Comparing a
  // literal here is what made the widened matcher in `settings.json` cosmetic:
  // the hook was launched for every shell tool and then excused itself from all
  // but one, so the Never tier and the kill switch stayed bypassable on the
  // other. Two spellings of one fact, and the one that ran was the wrong one.
  if (!SHELL_TOOLS.includes(input.tool_name)) return 0;
  // Three outcomes, decided in one shared place (RP-80): absent → allow, a
  // string → inspect, present-in-a-shape-this-cannot-read → REFUSE. The last
  // one used to be an allow, and what that cost is measured rather than
  // asserted: on `master` at `254b25c8`, with the kill switch armed, a
  // `command` spelled as an array of argv words returned 0 here before
  // `brakeIsOn()` was ever consulted. Pinned in hook-command-shape.test.ts
  // (absent in a generated rig) › "refuses an unreadable command through %s
  // while the kill switch is armed". A rule that can be stepped over by
  // restating the same command in another container is not a rule.
  const command = shellCommandOf(input);
  if (command.kind === 'unreadable') {
    process.stderr.write(`${refusalText(command)}\n`);
    return 2;
  }
  // Every member except `string` leaves nothing to inspect. Stated as one
  // POSITIVE test rather than a list of the others, so a member added later
  // cannot fall through to `raw.trim()` — which sits outside the try below,
  // where a throw exits 1 and the harness reads that as allow. That is the
  // fail-open this change removes, re-entering by another door.
  if (command.kind !== 'string') return 0;
  const raw = command.command;
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
