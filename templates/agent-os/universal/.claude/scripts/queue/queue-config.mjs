// `.claude/queue.json` reading and board resolution — split out of
// `index.mjs` (RP-279) so a module that needs to read the SAME config the
// queue CLI reads (`spec-kit-jira.mjs`, incl. the board selector) can import
// it without statically importing `index.mjs` itself.
//
// That constraint is not stylistic: `index.mjs` is the CLI's own entry point
// and carries a top-level `await` guarded by `invokedDirectly()`. A module
// loaded BY that same running entry process that turns around and statically
// imports `index.mjs` again creates a self-referential import of a module
// still mid-evaluation — Node's loader detects it as an unsettled top-level
// await and the process exits 13 instead of the code this CLI set, which is
// exactly the failure `test/template/spec-kit-import.test.ts` (absent in a generated rig) ›
// "accepts --to jira past the CLI usage gate, refusing only for a missing
// Jira credential" caught. `index.mjs` re-exports every name below so every
// existing import of it is unaffected (`invariants.md`: one mechanism, one
// implementation — this file is that one implementation now).
import { lstatSync, readFileSync } from 'node:fs';

/**
 * A missing config is the normal state of a fresh project. A config that exists
 * and does not parse is NOT — it used to fall back to `plan-md` silently, so a
 * trailing comma in `queue.json` made the loop read a different queue than the one
 * configured, which is the exact failure this file's header refuses for adapters.
 */
export const loadConfig = (configPath, { strictRead = false } = {}) => {
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    if (
      strictRead &&
      (error?.code !== 'ENOENT' || lstatSync(configPath, { throwIfNoEntry: false }) !== undefined)
    ) {
      throw new Error(`${configPath} could not be read (${error?.code ?? 'unknown error'})`, {
        cause: error,
      });
    }
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${configPath} exists but is not valid JSON, so the configured queue cannot be ` +
        'read. Fix the file — ' +
        'silently reading a different queue is worse than refusing to start.',
      { cause: error },
    );
  }
  return resolveBoard(parsed, configPath);
};

/**
 * The selector that travels with a config: `<name>.json` → `<name>.board`.
 *
 * A plain-text file holding one board name. Same class as the state file — a
 * per-checkout runtime value that must never be committed, because the config it
 * sits beside is composed and tracked. Derived from the config path for the same
 * reason `statePathFor` is: a run pointed at a temp config must not switch on
 * this checkout's real selector.
 */
export const boardPathFor = (configPath) => configPath.replace(/(\.json)?$/, '.board');

const isTerminalControl = (char) => {
  const code = char.codePointAt(0);
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
};

// Exported — `index.mjs`'s own `board` command (switching the selector)
// validates a requested name with this same rule, not a second copy of it.
export const assertSafeBoardName = (name, source) => {
  if (typeof name === 'string' && [...name].some(isTerminalControl)) {
    throw new Error(`${source}: board names must not contain terminal control characters.`);
  }
};

// Exported for the same reason: `index.mjs`'s `board` command lists the
// boards a config declares before switching to one of them.
export const boardNamesOf = (boards, configPath) => {
  const names = Object.keys(boards);
  for (const name of names) assertSafeBoardName(name, configPath);
  return names;
};

/**
 * A config may declare several boards and one default:
 *
 *   { "adapter": "jira", "board": "AR",
 *     "boards": { "AR": { "project": "AR", "owner": "x" }, "RP": { … } },
 *     "options": { "maxGateRounds": 3 } }
 *
 * The active board is the selector file if present, else `board`; its entry is
 * laid over `options`, so a key every board shares stays in `options` and only
 * what differs is per board. A config with no `boards` is returned exactly as it
 * was. A name nobody declared — in the selector or as the default — is refused,
 * never read as "no board": the loop would otherwise run on the shared options
 * alone, and for `jira` that is a different (or no) project.
 */
export const resolveBoard = (config, configPath) => {
  if (config?.boards === undefined) return config;
  const boards = config.boards;
  if (boards === null || typeof boards !== 'object' || Array.isArray(boards)) {
    throw new Error(`${configPath}: "boards" must be an object of <name> → options.`);
  }
  const known = boardNamesOf(boards, configPath);
  let selected = null;
  let source = 'the "board" key';
  try {
    selected = readFileSync(boardPathFor(configPath), 'utf8').trim();
    source = boardPathFor(configPath);
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
  }
  // A selector that exists but is empty is refused, not read as "no selector":
  // a truncated write would otherwise switch the run to the default board while
  // the file still looks like a choice somebody made.
  const active = selected === null ? config.board : selected;
  assertSafeBoardName(active, source);
  if (!active || !known.includes(active)) {
    throw new Error(
      `${source} names board ${JSON.stringify(active ?? null)}, which ${configPath} does not ` +
        `declare. Declared boards: ${known.join(', ')}. Refusing rather than running on the ` +
        'shared options alone — that would be a different queue than the one configured.',
    );
  }
  const entry = boards[active];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${configPath}: boards.${active} must be an object of adapter options.`);
  }
  return { ...config, board: active, options: { ...(config.options ?? {}), ...entry } };
};
