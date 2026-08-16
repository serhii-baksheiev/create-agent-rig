/**
 * The decision router — which gate does this change deserve, and what does that
 * cost.
 *
 * `pr-ship` is the merge-time gate and it always runs the expensive path: the
 * full suite, then `code-reviewer` on every diff. That is right for a change
 * that contains code and wrong for one that does not, and today there is no
 * cheaper lane at all — a one-line typo fix in a README buys the same fan-out as
 * a rewrite of the storage layer. This module is the dispatcher that decides
 * *whether the expensive path is warranted*; it does not replace the gate and it
 * never runs a reviewer itself.
 *
 * The ladder is `LANES`, in ascending order of cost, and `RISK_FLAGS` are
 * evaluated **ahead of all three** — a flag escalates straight to `model`, so no
 * cheap gate ever gets the chance to claim a change that carries one.
 *
 * 🔴 **The two directions of error are not symmetric, and every decision below
 * is made in the safe one.** Routing an expensive change into a cheap lane loses
 * the review — silently, and exactly on the diff that needed it. Routing a cheap
 * change into the expensive lane costs tokens. So: an unclassifiable path, a
 * rulebook document, a dependency manifest, anything under a declared elevated
 * path, and an absent file list all resolve to the **expensive** answer. The
 * cheap lanes are narrow on purpose and are meant to stay that way.
 *
 * 🔴 **The lane is a value on stdout; the exit code says only that the router
 * ran.** `0` never means "cheap" and non-zero never means "expensive" — a caller
 * that chains this on `&&` reads *escalate to the model* as *go ahead*, which is
 * the one misreading that turns a gate into a rubber stamp. Read the JSON.
 *
 * **What it deliberately does not do:** decide whether a review PASSED (that is
 * the gate's job), run any reviewer, or write anything except journal records.
 *
 * ⚠ **The limits, stated rather than implied.** The router sees *paths*, never
 * content: a diff that guts a function inside `docs/` is invisible to it, and so
 * is a secret pasted into a `.md`. It classifies by name because that is what a
 * dispatcher can do in milliseconds before any expensive work starts — the
 * layers behind it (the suite, the reviewers, CI) are what read content. A
 * project whose risky code does not announce itself in its paths should widen
 * `elevated-paths` rather than expect this file to guess.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { elevatedPathsIn, normalizePath, readDeclaredPaths } from './detect-missed-gate.mjs';
import { withoutGitLocation } from './git-env.mjs';

/** The three lanes, cheapest first. The order is the dispatch order. */
export const LANES = Object.freeze(['deterministic', 'fast-path', 'model']);

/**
 * Every gate that produces a verdict, in evaluation order.
 *
 * 🔴 `risk-flags` is first and that placement is the contract. Evaluated after
 * the cheap lanes it could escalate nothing — the change would already be
 * routed, and the flag would be a comment rather than a control.
 */
export const GATES = Object.freeze(['risk-flags', 'deterministic', 'fast-path', 'model']);

/**
 * The closed vocabulary a gate line may carry.
 *
 * `decline` and `skipped` are different facts and collapsing them is how a trace
 * starts lying: a gate that was *evaluated and said no* tells you the router
 * considered the cheap answer, and a gate that was *never reached* tells you an
 * escalation happened above it. A reader who cannot tell those apart cannot tell
 * a working router from one whose cheap lanes silently stopped matching.
 */
export const VERDICTS = Object.freeze(['clear', 'escalate', 'route', 'decline', 'skipped']);

/** What escalates a change ahead of the ladder. */
export const RISK_FLAGS = Object.freeze(['elevated-path', 'security-surface', 'test-removed']);

const DERIVED = 'derived';
const PROSE = 'prose';
const CODE = 'code';
const UNKNOWN = 'unknown';

/**
 * Coerce a file entry to its path, accepting both shapes the callers have.
 *
 * `--files` yields plain strings; `git diff --name-status` yields a status too,
 * and `test-removed` cannot be decided without it. Rather than force every
 * caller into the richer shape, both travel in one list.
 */
const pathOf = (file) => {
  if (typeof file === 'string') return file;
  const path = file?.path;
  return typeof path === 'string' ? path : '';
};

const statusOf = (file) => {
  const status = file?.status;
  return typeof status === 'string' ? status : null;
};

const segmentsOf = (path) => normalizePath(path).split('/').filter(Boolean);

const isRulebookPath = (path) => {
  const segments = segmentsOf(path);
  if (segments.length === 0) return false;
  if (segments[segments.length - 1] === 'CLAUDE.md') return true;
  for (const segment of segments) if (segment === '.claude') return true;
  return false;
};

const DERIVED_BASENAMES = new Set(['.rig-manifest.json']);
const PROSE_EXTENSIONS = new Set(['md', 'mdx', 'txt']);

/**
 * What kind of file this is — the only judgement the cheap lanes are allowed to
 * rest on.
 *
 * 🔴 A rulebook document classifies as `code`, and that is the single most
 * expensive misroute this file exists to prevent: a change rewriting the
 * autonomy tiers is a `.md`, and a router that read extensions would hand the
 * Never list to the prose lane. In this layer the prose *is* the implementation.
 */
export const classifyFile = (file) => {
  const raw = typeof file === 'string' ? file : '';
  if (raw.trim() === '') return UNKNOWN;

  const path = normalizePath(raw);
  const segments = segmentsOf(path);
  if (segments.length === 0) return UNKNOWN;
  const basename = segments[segments.length - 1];

  // Fail expensive first: a rulebook file is never derived and never prose,
  // whatever it is called or where it sits.
  if (isRulebookPath(path)) return CODE;

  if (DERIVED_BASENAMES.has(basename)) return DERIVED;
  for (const segment of segments) if (segment === 'dist') return DERIVED;
  if (basename.endsWith('.snap')) return DERIVED;
  if (/\.generated\.[^.]+$/.test(basename)) return DERIVED;

  const dot = basename.lastIndexOf('.');
  const extension = dot > 0 ? basename.slice(dot + 1).toLowerCase() : '';
  if (PROSE_EXTENSIONS.has(extension)) return PROSE;

  return CODE;
};

/** Dependency manifests and lockfiles: a change here is the supply chain. */
const DEPENDENCY_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'npm-shrinkwrap.json',
]);

/**
 * The words that make a path a security surface, matched as whole name-parts.
 *
 * Substring matching was the obvious form and it is wrong in the expensive
 * direction *for the router*: `tokenizer.ts` and `authoring-guide.txt` are
 * ordinary files this repository contains, and a router that escalates
 * everything routes nothing — the cheap lanes stop being reachable and the whole
 * mechanism becomes a slower way to do what `pr-ship` already did.
 */
const SECURITY_WORDS = new Set([
  'auth',
  'authn',
  'authz',
  'secret',
  'secrets',
  'credential',
  'credentials',
  'token',
  'tokens',
  'session',
  'sessions',
  'permission',
  'permissions',
]);

const isSecuritySurface = (path) => {
  const segments = segmentsOf(path);
  if (segments.length === 0) return false;
  if (DEPENDENCY_FILES.has(segments[segments.length - 1])) return true;

  for (const segment of segments) {
    // One forward pass per segment: strip the extension, then split the stem on
    // the separators a filename actually uses. No rescanning, no backtracking
    // regex — the input is a path from a diff and its length is not ours.
    const dot = segment.lastIndexOf('.');
    const stem = dot > 0 ? segment.slice(0, dot) : segment;
    for (const word of stem.toLowerCase().split(/[-_.]/)) {
      if (SECURITY_WORDS.has(word)) return true;
    }
  }
  return false;
};

const isTestPath = (path) => {
  const segments = segmentsOf(path);
  if (segments.length === 0) return false;
  const basename = segments[segments.length - 1];
  if (/\.(test|spec)\.[^.]+$/.test(basename)) return true;
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (segments[i] === 'test' || segments[i] === 'tests' || segments[i] === '__tests__') {
      return true;
    }
  }
  return false;
};

/**
 * The risk flags this change carries — at most one entry per flag, each naming
 * the files that earned it.
 *
 * `elevated-path` is delegated to `elevatedPathsIn` rather than re-derived here.
 * **One mechanism, one implementation** (`invariants.md`): two files deciding
 * "is this path elevated" disagree the first time either changes, and the one
 * nobody is looking at is the wrong one. It also inherits, for free, the two
 * subtleties that copy would have lost — inert prose inside an elevated
 * directory does not count, and a rulebook file counts wherever it sits.
 *
 * ⚠ **`test-removed` needs a status, and without one it is not evaluated.** A
 * plain string list cannot say whether a file was deleted, so this flag stays
 * silent there rather than guessing either way. That is safe and not a hole:
 * every test file classifies as `code`, so a change containing one cannot reach
 * a cheap lane on classification alone. The flag buys the *reason* being visible
 * in the trace, not the escalation itself.
 */
export const riskFlagsIn = (files, { elevatedPaths = [] } = {}) => {
  const list = Array.isArray(files) ? files : [];

  const paths = [];
  for (const file of list) paths.push(pathOf(file));

  const elevated = elevatedPathsIn(paths, elevatedPaths);

  const security = [];
  const removedTests = [];
  for (const file of list) {
    const path = pathOf(file);
    if (path === '') continue;
    if (isSecuritySurface(path)) security.push(path);
    if (statusOf(file) === 'removed' && isTestPath(path)) removedTests.push(path);
  }

  const flags = [];
  if (elevated.length > 0) {
    flags.push({
      flag: 'elevated-path',
      files: elevated,
      why: 'a changed file sits under a path this project declares elevated, so the change is Tier 2 by what it touches',
    });
  }
  if (security.length > 0) {
    flags.push({
      flag: 'security-surface',
      files: security,
      why: 'a changed file is a dependency manifest or names auth, secrets, tokens, sessions or permissions',
    });
  }
  if (removedTests.length > 0) {
    flags.push({
      flag: 'test-removed',
      files: removedTests,
      why: 'a test file was deleted, and deleting a test to reach green is on the Never tier',
    });
  }
  return flags;
};

const line = (gate, verdict, why) => ({ gate, verdict, why });

/**
 * Route one change.
 *
 * Returns `{ lane, reviewers, gates, risks, why }`. `gates` carries **one entry
 * per member of `GATES`, always, in `GATES` order** — including the ones that
 * were never reached, which say `skipped` and name the escalation. An absent
 * line is indistinguishable from a declined one and from a gate that crashed,
 * and a trace that cannot tell those apart is the shape a silently disabled gate
 * hides in.
 *
 * 🔴 It **refuses** an absent or non-array file list rather than routing it. A
 * zero and an unknown look identical in a count and mean opposite things: the
 * permissive reading here is "nothing changed, take the cheapest lane", which is
 * precisely the wrong answer written confidently.
 */
export const route = ({ files, elevatedPaths = [] } = {}) => {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(
      'the decision router needs the changed file list of the change being routed ' +
        '(`git diff --name-status <base>...<head>`). An empty or missing list is an ' +
        'absence, not a cheap change, and routing on it would send an unmeasured diff ' +
        'down the lane that reviews least.',
    );
  }

  const risks = riskFlagsIn(files, { elevatedPaths });

  if (risks.length > 0) {
    const named = risks.map((risk) => risk.flag).join(', ');
    const why = `risk flags escalated ahead of the ladder: ${named}`;
    return {
      lane: 'model',
      reviewers: reviewersFor(files, risks),
      risks,
      why,
      gates: [
        line('risk-flags', 'escalate', why),
        line('deterministic', 'skipped', 'not evaluated — risk flags escalated ahead of it'),
        line('fast-path', 'skipped', 'not evaluated — risk flags escalated ahead of it'),
        line('model', 'route', 'the expensive path is warranted: a risk flag fired'),
      ],
    };
  }

  // Only the two counts that can disqualify a cheap lane are kept; `derived` is
  // the remainder, and the list is non-empty by the refusal above — so
  // `other === 0 && prose === 0` is exactly "every file is derived".
  let prose = 0;
  let other = 0;
  for (const file of files) {
    const kind = classifyFile(pathOf(file));
    if (kind === PROSE) prose += 1;
    else if (kind !== DERIVED) other += 1; // code and unknown alike: the expensive answer
  }

  const clear = line('risk-flags', 'clear', 'no risk flag fired on the changed paths');

  if (other === 0 && prose === 0) {
    return {
      lane: 'deterministic',
      reviewers: [],
      risks,
      why: 'every changed file is a derived artifact whose drift a mechanical check already catches',
      gates: [
        clear,
        line(
          'deterministic',
          'route',
          'every changed file is derived — the checks are the review, and a model would re-read the generator',
        ),
        line('fast-path', 'skipped', 'not evaluated — a cheaper gate claimed the change'),
        line('model', 'skipped', 'not evaluated — a cheaper gate claimed the change'),
      ],
    };
  }

  const declinedDeterministic = line(
    'deterministic',
    'decline',
    'not every changed file is a derived artifact',
  );

  if (other === 0) {
    return {
      lane: 'fast-path',
      reviewers: ['prose-reviewer'],
      risks,
      why: 'the change is documentation outside the rulebook, so the reviewer that reads prose is the whole gate',
      gates: [
        clear,
        declinedDeterministic,
        line(
          'fast-path',
          'route',
          'the change carries no code and no rulebook document — `code-reviewer` would have nothing to read',
        ),
        line('model', 'skipped', 'not evaluated — a cheaper gate claimed the change'),
      ],
    };
  }

  return {
    lane: 'model',
    reviewers: reviewersFor(files, risks),
    risks,
    why: 'the change carries code, a rulebook document, or a path the router could not classify',
    gates: [
      clear,
      declinedDeterministic,
      line('fast-path', 'decline', 'the change is not documentation-only'),
      line('model', 'route', 'the expensive path is warranted'),
    ],
  };
};

/**
 * Who the expensive lane fans out to — `code-reviewer` first, always, and the
 * conditional gates `pr-ship` already names, decided from the same paths.
 */
const reviewersFor = (files, risks) => {
  const reviewers = ['code-reviewer'];

  let wantsProse = false;
  for (const file of files) {
    const path = pathOf(file);
    if (path === '') continue;
    if (classifyFile(path) === PROSE || isRulebookPath(path)) {
      wantsProse = true;
      break;
    }
  }
  if (wantsProse) reviewers.push('prose-reviewer');

  for (const risk of risks) {
    if (risk.flag === 'security-surface') {
      reviewers.push('security-scanner');
      break;
    }
  }
  return reviewers;
};

/** The verdict a human reads, as opposed to the JSON a caller parses. */
export const render = (result) => {
  const rows = result.gates.map(
    (gate) => `  ${gate.gate.padEnd(14)} ${gate.verdict.padEnd(9)} ${gate.why}`,
  );
  const reviewers = result.reviewers.length > 0 ? result.reviewers.join(', ') : '(none)';
  return (
    `decision-router: lane ${result.lane.toUpperCase()} — ${result.why}\n\n` +
    `${rows.join('\n')}\n\n` +
    `reviewers: ${reviewers}\n\n` +
    '🔴 the lane is the value on stdout, never the exit code: 0 means the router ran.\n' +
    '   Do not chain this on `&&`.\n'
  );
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const STATUS_LETTERS = Object.freeze({
  A: 'added',
  C: 'copied',
  D: 'removed',
  M: 'modified',
  R: 'renamed',
  T: 'modified',
});

/**
 * `git diff --name-status -z` into `{ path, status }` records.
 *
 * `-z` and a NUL split rather than lines: with `core.quotePath` on (the default)
 * a non-ASCII path arrives quoted and octal-escaped, matching no declared
 * prefix, and a filename containing a newline splits into two junk paths. Both
 * failures point the same way — an elevated file that stops looking elevated.
 *
 * A rename arrives as three fields (`R100`, old, new); everything else as two.
 */
export const parseNameStatus = (raw) => {
  const fields = String(raw ?? '').split('\0');
  const files = [];
  let i = 0;
  while (i < fields.length) {
    const code = fields[i];
    if (!code) {
      i += 1;
      continue;
    }
    const letter = code[0];
    const status = STATUS_LETTERS[letter] ?? 'modified';
    if (letter === 'R' || letter === 'C') {
      const to = fields[i + 2];
      if (to) files.push({ path: to, status });
      i += 3;
    } else {
      const path = fields[i + 1];
      if (path) files.push({ path, status });
      i += 2;
    }
  }
  return files;
};

const parseArgs = (argv) => {
  const args = { base: 'origin/HEAD', head: 'HEAD', files: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--base') args.base = argv[++i] ?? args.base;
    else if (arg === '--head') args.head = argv[++i] ?? args.head;
    else if (arg === '--files') args.files = argv[++i] ?? '';
  }
  return args;
};

/**
 * The changed files of the branch under review.
 *
 * `<base>...<head>` — three dots — is right *here* and wrong after a merge: it
 * is `merge-base..head`, which is exactly "what this branch added" while the
 * branch is still open. (The post-merge close step needs `<merge>^1 <merge>`
 * instead, and mixing the two up returns an empty list.)
 */
const gitFiles = (base, head) => {
  const raw = execFileSync('git', ['diff', '--name-status', '-z', `${base}...${head}`], {
    encoding: 'utf8',
    // A process started under a git hook inherits an absolute GIT_DIR, and a
    // child that keeps it reports the file list of ANOTHER repository — silently,
    // because the list comes back non-empty.
    env: withoutGitLocation(),
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseNameStatus(raw);
};

const invokedDirectly = () =>
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly()) {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  let files;
  try {
    files =
      args.files === null
        ? gitFiles(args.base, args.head)
        : args.files
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);
  } catch (error) {
    process.stderr.write(
      `decision-router: could not read the changed file list from git ` +
        `(${error?.message ?? error}). Nothing was routed — an unreadable diff is an ` +
        'absence, not a cheap change.\n',
    );
    process.exit(1);
  }

  let result;
  try {
    // A project that declares no elevated path at all cannot have the
    // `elevated-path` flag evaluated. That is reported by `detect-missed-gate`
    // as its own finding; here it degrades to an empty declaration, and the
    // other two flags plus the classification still decide the lane.
    result = route({ files, elevatedPaths: readDeclaredPaths(projectRoot) ?? [] });
  } catch (error) {
    // The refusal, as a diagnosis rather than a stack dump: a caller reading a
    // node trace on stderr learns nothing about why its change was not routed.
    process.stderr.write(`decision-router: ${error?.message ?? error}\n`);
    process.exit(1);
  }

  // 🔴 A router with no journal line is a decision nobody can retrace. One
  // record per gate — including the skipped ones, because "no line" is exactly
  // how a gate that silently stopped matching looks.
  const runDir = process.env.RIG_RUN_DIR;
  if (runDir) {
    let journal = null;
    try {
      journal = await import('./run-journal.mjs');
      for (const gate of result.gates) {
        journal.recordDecision({
          runDir,
          gate: `review-routing:${gate.gate}`,
          verdict: gate.verdict,
          why: gate.why,
          now: new Date().toISOString(),
        });
      }
    } catch (error) {
      // Same split the queue CLI makes, and for the same reason: a trace that
      // cannot accept another record is over, and the routing is not. Asking the
      // module which failure this is — never matching on the message text, which
      // would put the decision in two files and let them drift.
      const classify = journal?.isTraceExhausted;
      if (typeof classify === 'function' && classify(error)) {
        process.stderr.write(
          `run journal: ${error.message}\n` +
            `  the route below was NOT recorded in ${runDir}. This run's trace ends here; ` +
            'the routing is fine, and a new run needs a new run directory.\n',
        );
      } else {
        process.stderr.write(`run journal: ${error?.message ?? error}\n`);
        process.exit(1);
      }
    }
  }

  process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : render(result));
}
