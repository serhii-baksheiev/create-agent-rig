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
 * rulebook document, a dependency manifest, a file under a declared elevated
 * path, and an absent file list all resolve to the **expensive** answer. The
 * cheap lanes are narrow on purpose and are meant to stay that way.
 *
 * ⚠ Read "under a declared elevated path" exactly, because it has one carve-out
 * and the carve-out is inherited rather than chosen here: `elevatedPathsIn`
 * treats **`.md`/`.mdx` files and test paths** that provision nothing as inert,
 * so `infra/README.md` does not escalate while `infra/stack.ts` does. 🔴 Both
 * halves are the SWEEP's definitions and neither matches this file's: its inert
 * test paths are `test|tests|__tests__` directories and `.test.`/`.spec.`
 * JS-flavoured names, while `isTestPath` here is wider; and its inert
 * extensions are `.md`/`.mdx` while `PROSE_EXTENSIONS` here is `.md`/`.txt` —
 * **neither set contains the other**, and the difference on `.mdx` is
 * deliberate (MDX executes, see `PROSE_EXTENSIONS`). Aligning either way would
 * do harm: widening the sweep stops `requirements.txt` in an elevated directory
 * from escalating, and copying the sweep's `.mdx` back into this file's prose
 * set reinstates a defect a 🔴 below spends a paragraph closing. They stay
 * apart on purpose, and the difference is written here rather than discovered.
 * A rulebook file
 * is not inert wherever it sits. That is the sweep's definition and this file
 * delegates to it on purpose — two answers to "is this path elevated" would
 * disagree. **Neither cheap lane relies on that carve-out for a derived file:**
 * both test the declared prefixes raw, so an inert-looking derived file under
 * one cannot compose its way in. (Round four scoped this sentence to the
 * no-reviewer lane; the mechanism gated both from the start, and the narrower
 * claim understated the guard.)
 *
 * 🔴 **The lane is a value on stdout; the exit code says only that the router
 * ran.** `0` never means "cheap" and non-zero never means "expensive" — a caller
 * that chains this on `&&` reads *escalate to the model* as *go ahead*, which is
 * the one misreading that turns a gate into a rubber stamp. Read the JSON.
 *
 * **What it deliberately does not do:** decide whether a review PASSED (that is
 * the gate's job), run any reviewer, or write anything except journal records.
 *
 * ⚠ **The limits, stated rather than implied — all six of them.**
 *
 * 1. **It sees paths, never content.** A diff that guts a function inside
 *    `docs/` is invisible to it, and so is a secret pasted into a `.md`. It
 *    classifies by name because that is what a dispatcher can do in
 *    milliseconds before any expensive work starts; the layers behind it (the
 *    suite, the reviewers, CI) are what read content. A project whose risky code
 *    does not announce itself in its paths should widen `elevated-paths` rather
 *    than expect this file to guess.
 * 2. **`derived` is a naming convention, not a proof.** A hand-authored
 *    `src/x.generated.ts` satisfies it. So **both cheap lanes** require a status
 *    saying the file was drift — `modified` or `removed`; everything else,
 *    including an entry with **no status at all** (the `--files` string form),
 *    is refused them — as is a derived file **under a declared elevated path**,
 *    whatever its status. A `modified` derived file elsewhere is still taken on
 *    trust, and that trust rests on the project having a check that regenerates
 *    it.
 * 3. **The journal is written only when `RIG_RUN_DIR` is declared**, and only
 *    from the CLI — `route()` used as a library writes nothing. So an absent
 *    `decisions.jsonl` is the ordinary state of an undeclared run, and a reader
 *    auditing one must check the run declared a directory before reading
 *    absence as a gate that stopped firing.
 * 4. **Exit 1 is not a lane, and STDOUT is the thing to read.** Exit 1 means
 *    nothing was routed — an unreadable diff, an absent file list, a project
 *    declaring no elevated path, an unrecognised flag, a `--base`/`--head` that
 *    is not a revision, or a run directory that is not there. The caller treats
 *    it as `model`; it is never a reason to skip the gate.
 *
 *    ⚠ **Do not key on the `run journal:` prefix**, because both journal
 *    failures wear it and they end differently: a trace that can no longer
 *    accept records ends the TRACE, not the routing — the lane still prints and
 *    the exit stays 0 — while a run directory that was never there exits 1 with
 *    nothing on stdout. One rule covers both and every other case: **if a lane
 *    printed, read it; if stdout is empty, treat the change as `model`.**
 *    ⚠ And the diff it reads is the **committed** one, `<base>...<head>`: an
 *    uncommitted edit is not routed, so commit before routing.
 * 5. **Case folding is deliberately asymmetric, and the residual is the FLAG,
 *    not the lane.** A rulebook file is recognised whatever the case of its
 *    name, and this file's own cheap-lane tests fold too — both directions that
 *    can only ESCALATE. The gate sweep's `elevatedPathsIn` does not fold, on
 *    purpose (`normalizePath` explains why). So against a declared `scripts/`,
 *    a file under `Scripts/` **routes to the same lane** as the correctly-cased
 *    path — `caseOnlyElevated` in `route` sees to that, and it inherits the
 *    sweep's inertness so `Scripts/README.md` stays as cheap as
 *    `scripts/README.md` — but `risks` comes back empty, so the trace does not
 *    say *why* it was expensive.
 *
 *    🔴 This limit has now been wrong in **both** directions, which is why it
 *    is spelled out rather than summarised. It first claimed the residual was a
 *    stray `.txt` while a *derived* file under the mismatched directory reached
 *    the lane with no reviewer at all; the fix for that then claimed the lane
 *    was safe while a `.txt` still lost `code-reviewer`. Both are closed now,
 *    in code rather than in prose.
 *
 *    ⚠ One genuine false negative survives, and ASCII is not where it lives:
 *    Unicode lowercasing is not prefix-preserving at a Greek final sigma, so a
 *    declared prefix ending mid-segment on `Σ` can fail to fold-match. It needs
 *    a declaration without a trailing slash, a path inert to the sweep, a
 *    derived-looking name and a trusted status all at once.
 * 6. **`reviewers` is a floor, not a ceiling** — and this was measured on the
 *    router's own first run, not predicted. It returned `code-reviewer` and
 *    `prose-reviewer` for a diff that parses untrusted argv and git output,
 *    which `pr-ship`'s own trigger list calls a `security-scanner` case. Paths
 *    cannot see what code does. The gate's triggers apply on every lane and may
 *    only add.
 *
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  elevatedPathsIn,
  isDecisionRecord,
  normalizePath,
  readDeclaredPaths,
} from './detect-missed-gate.mjs';
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

/**
 * The documents that instruct agents — where the prose IS the implementation.
 *
 * 🔴 Matched case-INSENSITIVELY, and the reason is a two-commit attack that was
 * reproduced end to end: on a case-insensitive checkout (macOS default)
 * `git mv CLAUDE.md claude.md` is accepted and recorded. The rename itself is
 * caught, because a rename keeps its source path — but from the next commit on,
 * the rulebook is in the prose lane forever. `readDeclaredPaths` still read that
 * same file for its `elevated-paths` block, so the router was parsing it as the
 * rulebook and refusing to classify it as one.
 *
 * ⚠ Case folding in this file is a whitelist, not a single site: this check,
 * `isTestPath`'s directory scan, and `route`'s own prefix tests all fold —
 * every one of them a direction that can only ESCALATE. What must NOT fold is
 * `normalizePath`, and therefore `elevatedPathsIn`: that one decides the gate
 * sweep's escalation, where folding creates false positives.
 * `detect-missed-gate.mjs` states why.
 */
const RULEBOOK_BASENAMES = new Set([
  'claude.md',
  'agents.md',
  'gemini.md',
  'conventions.md',
  'copilot-instructions.md',
]);

const isRulebookPath = (path) => {
  const segments = segmentsOf(path);
  if (segments.length === 0) return false;
  if (RULEBOOK_BASENAMES.has(segments[segments.length - 1].toLowerCase())) return true;
  for (const segment of segments) if (segment.toLowerCase() === '.claude') return true;
  // A decision record carries rulebook rationale, so it is code here for the
  // same reason a rule file is: the prose IS the implementation. Shared with
  // the gate sweep rather than re-spelled — see `isDecisionRecord`.
  return isDecisionRecord(path);
};

// 🔴 Deliberately EMPTY, and it held `.rig-manifest.json` for one review round.
// Nothing in a generated project regenerates or verifies that file — it is
// written once at scaffold time and read by `upgrade` to decide which files are
// locally modified. So the premise the cheap lane rests on ("a check already
// catches its drift") is false for it, on the one file that governs what
// `upgrade` may overwrite. A project that really does generate a fixed-name
// artifact adds it here, next to the check that regenerates it.
const DERIVED_BASENAMES = new Set();
// 🔴 `.mdx` is NOT here, and it was for four review rounds. MDX compiles to an
// ES module: it supports `import`/`export` and evaluates every `{…}`
// expression, so `app/page.mdx` is a route that executes. A single-file diff
// adding `import { execSync } …` to one routed to `fast-path`, and the router
// printed "the change carries no code" over it. This is not limit 1 — the path
// itself declares an executable format, and the router was reading it wrong.
// `DOC_EXTENSIONS` still sends it to `prose-reviewer` on top of the code review.
const PROSE_EXTENSIONS = new Set(['md', 'txt']);
const DOC_EXTENSIONS = new Set(['md', 'mdx', 'txt']);

/**
 * Does this path LOOK derived — and it is only ever a look.
 *
 * ⚠ Nothing here verifies that the file is actually generator output; the
 * classification is a naming convention, and a hand-authored file can satisfy
 * it. That matters more than usual because `deterministic` is the lane that runs
 * **no reviewer at all**, so the check on it is `route`'s status guard rather
 * than this predicate: a derived-looking file that was ADDED cannot be drift
 * against a generator, because there is no prior output for it to have drifted
 * from.
 */
const looksDerived = (segments, basename) => {
  if (DERIVED_BASENAMES.has(basename)) return true;
  for (const segment of segments) if (segment === 'dist') return true;
  // 🔴 A test SNAPSHOT is deliberately not here, and it was, for one review
  // round. A snapshot is not output whose drift a generator check catches — it
  // IS the behaviour claim, rewritten by the test run that then passes by
  // construction. Routing one to the lane that launches no reviewer is
  // "weaken a test to get to green" with a dispatcher doing the weakening.
  return /\.generated\.[^.]+$/.test(basename);
};

/**
 * The statuses under which a derived file may reach the **no-reviewer** lane.
 *
 * Deliberately narrow, and the narrowness is the whole guard. `deterministic`
 * rests on one claim — this file is generator output, so a check already catches
 * its drift — and that claim needs a prior output to have drifted from. An
 * `added` or `copied` file has none. A `renamed` one is new content at that
 * path. And a status-less entry (the `--files` string form) has not been
 * measured at all, which is not the same as measuring `modified`.
 */
const DERIVED_TRUSTED_STATUSES = new Set(['modified', 'removed']);

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

  // 🔴 A test path is code too, and this line closes a claim the header used to
  // make and the mechanism did not honour: "every test file classifies as
  // `code`, so a change containing one cannot reach a cheap lane on
  // classification alone". It did not hold for a fixture — `test/golden/
  // expected.txt` and `test/fixtures/golden.md` classified as PROSE, so a
  // deleted golden file reached `fast-path` with `prose-reviewer` as the whole
  // gate. It also has to come before the derived look, or
  // `packages/db/src/test/schema.generated.ts` composes two carve-outs into the
  // lane that launches nobody.
  if (isTestPath(path)) return CODE;

  if (looksDerived(segments, basename)) return DERIVED;

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
  // `.txt` is otherwise prose, so these two are actively DOWNGRADED rather than
  // merely missed — and this layer is what `init` installs into a repo whose
  // shape nobody here knows.
  'requirements.txt',
  'constraints.txt',
  // 🔴 A `.txt` that is a BUILD SCRIPT, not prose. `CMakeLists.txt` runs
  // `execute_process` and `FetchContent_Declare` at configure time — a new
  // dependency, a new outbound destination and arbitrary shell, three of the
  // gate's own `security-scanner` triggers — and it took the prose lane.
  // `conanfile.txt` is C/C++'s `requirements.txt`. The same reasoning that
  // pulled Python's manifests out of prose applies here and was simply not
  // carried across.
  'cmakelists.txt',
  'conanfile.txt',
  // Other ecosystems. These classify as `code` and so reach `model` anyway —
  // what they buy is the `security-scanner` member of the reviewer floor, which
  // a supply-chain edit is exactly the case for.
  'pipfile',
  'pipfile.lock',
  'poetry.lock',
  'pyproject.toml',
  'gemfile',
  'gemfile.lock',
  'cargo.toml',
  'cargo.lock',
  'go.mod',
  'go.sum',
  'composer.json',
  'composer.lock',
]);

/**
 * The same manifests, in the forms a name-exact set cannot hold.
 *
 * `requirements-dev.txt`, `dev-requirements.txt` and `requirements/base.txt` are
 * the shapes that actually appear, and each of them is `.txt` — the one prose
 * extension a dependency manifest uses, so missing them does not merely fail to
 * escalate, it actively downgrades a supply-chain edit to the prose lane.
 */
const isDependencyPath = (segments, basename) => {
  const lower = basename.toLowerCase();
  if (DEPENDENCY_FILES.has(lower)) return true;
  if (!lower.endsWith('.txt')) return false;
  // Matched on the STEM's words rather than on a shape. The shape form spelled
  // `^(dev-)?requirements(-[a-z0-9.]+)?$` and missed `requirements_dev.txt`,
  // `requirements-DEV.txt`, `requirements-dev-extra.txt` and
  // `test-requirements.txt` — each of which then reached the PROSE lane, because
  // `.txt` is the one prose extension a manifest uses.
  // 🔴 The stem keeps its ORIGINAL CASE here. Pre-lowercasing destroyed the
  // camel boundary `wordsOf` exists for — `requirementsDev` collapsed to one
  // word and reached the prose lane — and buys nothing, since `wordsOf`
  // lowercases every word it emits. Prefix-matched so a digit or a singular
  // (`requirements2`, `requirement-dev`) cannot slip past either.
  for (const word of wordsOf(basename.slice(0, -4))) {
    if (word.startsWith('requirement') || word.startsWith('constraint')) return true;
  }
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i].toLowerCase();
    if (segment === 'requirements') return true;
    // Go's vendor manifest is `vendor/modules.txt` and names neither word.
    if (segment === 'vendor' && lower === 'modules.txt') return true;
  }
  return false;
};

/**
 * Files that ARE credentials, rather than files whose name mentions one.
 *
 * These reach `model` on classification anyway; what they buy is the
 * `security-scanner` member of the reviewer floor, which the flag's own `why`
 * already claims to cover.
 */
const SECRET_EXTENSIONS = new Set(['pem', 'key', 'p12', 'pfx', 'keystore', 'jks']);
const SECRET_BASENAMES = new Set(['.npmrc', '.netrc', '.pgpass', 'id_rsa', 'id_ed25519']);

const isSecretFile = (segments, basename) => {
  if (SECRET_BASENAMES.has(basename)) return true;
  if (basename === '.env' || basename.startsWith('.env.')) return true;
  for (const segment of segments) if (segment === 'secrets' || segment === 'credentials') return true;
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) return false;
  const extension = basename.slice(dot + 1).toLowerCase();
  // The extension is tested against the security words as well, because both
  // sides stripped it before matching: `dist/local.env`, `dist/db.secret` and
  // `dist/api.token` reached the lane that launches no reviewer, while
  // `dist/svc.key` was caught — only because `key` happened to be an extension
  // in the list. That inconsistency was the finding.
  return SECRET_EXTENSIONS.has(extension) || SECURITY_WORDS.has(extension);
};

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
  'authenticate',
  'authentication',
  'authorization',
  'authorize',
  'oauth',
  'oauth2',
  'login',
  'signin',
  'signup',
  'sso',
  'saml',
  'secret',
  'secrets',
  'credential',
  'credentials',
  'password',
  'passwords',
  'key',
  'keys',
  'apikey',
  'apikeys',
  'jwt',
  'crypto',
  'env',
  'passwd',
  'creds',
  'cookie',
  'csrf',
  'cors',
  'rbac',
  'acl',
  'iam',
  'hmac',
  'nonce',
  'cert',
  'certs',
  'tls',
  'mfa',
  'totp',
  'otp',
  'bearer',
  'oidc',
  'ldap',
  'authorise',
  'authorised',
  'authorisation',
  'token',
  'tokens',
  'session',
  'sessions',
  'permission',
  'permissions',
]);

/**
 * Split one path segment's stem into the words a name is made of.
 *
 * 🔴 **One forward pass, written by hand because the regex form was quadratic.**
 * The obvious spelling — `replace(/([A-Z]+)([A-Z][a-z])/g, …)` to break an
 * acronym off the word after it — backtracks the whole remaining run of capitals
 * at every start position. Measured on a stem of N capitals reaching `route()`:
 * 8k → 93 ms, 32k → 1.5 s, 100k → 14 s. And a 40 000-character path component
 * needs no checkout to construct: `git mktree` puts it in a tree and
 * `git diff --name-status` hands it straight back.
 *
 * This is a stall rather than a bypass — the router does not fail open, and a
 * timeout exits 1, which the caller reads as `model`. It is fixed anyway,
 * because `invariants.md` names this exact shape as the lesson that cost the
 * most, and because the comment that used to sit here claimed "no backtracking
 * regex" while pointing at one.
 *
 * A word boundary is a separator (`-`, `_`, `.`, space) or a camel hump: an
 * uppercase char that either follows a non-uppercase one (`authService`) or is
 * the last of a run before a lowercase one (`JWTVerify` → `jwt`, `verify`).
 */
const wordsOf = (stem) => {
  const words = [];
  const isUpper = (c) => c !== undefined && c >= 'A' && c <= 'Z';
  const isLower = (c) => c !== undefined && c >= 'a' && c <= 'z';
  const isDigit = (c) => c !== undefined && c >= '0' && c <= '9';
  let start = 0;
  const cut = (end) => {
    if (end > start) words.push(stem.slice(start, end).toLowerCase());
    start = end;
  };
  for (let i = 0; i < stem.length; i += 1) {
    const ch = stem[i];
    if (ch === '-' || ch === '_' || ch === '.' || ch === ' ') {
      cut(i);
      start = i + 1;
      continue;
    }
    if (i > start && isUpper(ch) && (!isUpper(stem[i - 1]) || isLower(stem[i + 1]))) cut(i);
    // A digit after a letter is a boundary too: `auth2`, `oauth2` and
    // `requirements2` each hid a whole word behind one character.
    else if (i > start && isDigit(ch) && !isDigit(stem[i - 1])) cut(i);
    // …and the mirror, which was missing: `v2auth`, `s3credentials` and
    // `api2key` hid a whole word behind one leading character exactly the way
    // `auth2` hid one behind a trailing character. Verified against every
    // documented negative — `utf8parser`, `sha256hash`, `base64`, `http2server`
    // all stay clean.
    else if (i > start && !isDigit(ch) && isDigit(stem[i - 1])) cut(i);
  }
  cut(stem.length);
  return words;
};

const isSecuritySurface = (path) => {
  const segments = segmentsOf(path);
  if (segments.length === 0) return false;
  const basename = segments[segments.length - 1];
  if (isDependencyPath(segments, basename)) return true;
  if (isSecretFile(segments, basename)) return true;

  for (const segment of segments) {
    // One forward pass per segment: strip the extension, then split the stem on
    // the separators a filename actually uses — including a camelCase boundary,
    // because `authService.ts` is the same file as `auth-service.ts` and only
    // one of them was being seen. No rescanning, no backtracking regex — the
    // input is a path from a diff and its length is not ours.
    const dot = segment.lastIndexOf('.');
    const stem = dot > 0 ? segment.slice(0, dot) : segment;
    for (const word of wordsOf(stem)) {
      if (SECURITY_WORDS.has(word)) return true;
    }
  }
  return false;
};

const TEST_DIRECTORIES = new Set([
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'e2e',
  'cypress',
]);

/**
 * Directory names that are a test root in one ecosystem and a documentation
 * directory in another — resolved by the EXTENSION rather than by picking a
 * side, because picking a side oscillates.
 *
 * 🔴 Both choices were made in this branch and both were wrong. Treating them
 * as test roots made `docs/features/login.md` code, narrowing the very lane
 * this module exists to open. Removing them put `integration/fixtures/
 * expected.txt` (deleted) back on the prose lane and
 * `integration/schema.generated.ts` into the lane that launches nobody — giving
 * back, for two directory names, exactly the coverage the fixture fix had won.
 *
 * A `.md`/`.mdx` file under one of these is treated as documentation BY THIS
 * PREDICATE; anything else is a test artifact. ⚠ That is not the same as
 * reaching the prose lane — `.mdx` is code to the ladder (see
 * `PROSE_EXTENSIONS`), so `integration/x.mdx` still routes `model`. Those two extensions and no more, deliberately: `.txt` under
 * `integration/` is a golden file far more often than it is prose, and it was
 * the `.txt` fixture that broke. The pair matches the gate sweep's own inert
 * extensions, which is the one other place this distinction is drawn.
 */
const AMBIGUOUS_TEST_DIRECTORIES = new Set(['integration', 'features']);
const DOC_ONLY_EXTENSIONS = new Set(['md', 'mdx']);

const isTestPath = (path) => {
  const segments = segmentsOf(path);
  if (segments.length === 0) return false;
  const basename = segments[segments.length - 1];
  if (/\.(test|spec)\.[^.]+$/.test(basename)) return true;
  // The JS-flavoured `.test.`/`.spec.` form was the only one recognised, so a
  // deleted `critical_spec.generated.rb` reached the lane that launches no
  // reviewer. `test_x.py`, `x_test.go` and `x_spec.rb` are tests too.
  const dot = basename.lastIndexOf('.');
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  const extension = dot > 0 ? basename.slice(dot + 1).toLowerCase() : '';
  const words = wordsOf(stem);
  // Any word, not just the first or last: `critical_spec.generated.rb` puts it
  // in the middle, and that exact name reached the no-reviewer lane when the
  // check looked only at the ends. `words.length > 1` keeps a file simply named
  // `spec.ts` out of it; over-escalating a `spec-loader.ts` that was DELETED is
  // the safe direction and costs one reviewer.
  if (words.length > 1) {
    for (const word of words) {
      if (word === 'test' || word === 'tests' || word === 'spec' || word === 'specs') return true;
    }
  }
  for (let i = 0; i < segments.length - 1; i += 1) {
    // Folded, for the same reason `isRulebookPath` folds: `Tests/`, `Test/` and
    // `Spec/` are the ordinary conventions in .NET, Java and Swift, and on a
    // case-insensitive checkout `git mv test Test` also survives — unlike the
    // rulebook rename, silently, because test runners glob.
    const segment = segments[i].toLowerCase();
    if (TEST_DIRECTORIES.has(segment)) return true;
    if (AMBIGUOUS_TEST_DIRECTORIES.has(segment) && !DOC_ONLY_EXTENSIONS.has(extension)) return true;
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
      why:
        'a test file left its path — deleted outright, or renamed away, which the diff \nreports the same way. Deleting a test to reach green is on the Never tier',
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
export const route = ({ files, elevatedPaths } = {}) => {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(
      'the decision router needs the changed file list of the change being routed ' +
        '(`git diff --name-status <base>...<head>`). An empty or missing list is an ' +
        'absence, not a cheap change, and routing on it would send an unmeasured diff ' +
        'down the lane that reviews least.',
    );
  }

  // 🔴 The same refusal the CLI makes, made here so a library caller cannot
  // reach the permissive answer the CLI is careful to avoid. With no
  // declaration the `elevated-path` flag is not evaluated at all, and the gate
  // line would then read `risk-flags clear — no risk flag fired`: an
  // unevaluated check presenting as a pass, in the file whose whole argument is
  // that those two must never look alike.
  if (!Array.isArray(elevatedPaths) || elevatedPaths.length === 0) {
    throw new Error(
      'the decision router needs the project\'s declared elevated paths, and refuses ' +
        'rather than routing without them: the `elevated-path` risk flag cannot be ' +
        'evaluated against an empty declaration, and reporting that as "no risk flag ' +
        'fired" would be an absence dressed as a pass. Read them with ' +
        '`readDeclaredPaths(projectRoot)`.',
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

  // Three counts, because `derived` splits. It is a naming convention a
  // hand-authored file can satisfy, so a derived file only counts as cheap when
  // git says it was drift (`DERIVED_TRUSTED_STATUSES`); anything else is
  // `derivedUntrusted`.
  //
  // 🔴 **Both cheap lanes consult it, and for one review round only one did.**
  // The reasoning that dropped it from `fast-path` — "that lane still has a
  // cold reader" — was wrong about which reader: `prose-reviewer` is scoped to
  // documents that instruct agents, not to a new `.ts` file. Measured
  // consequence: a diff adding `src/x.generated.ts` alongside one `.md` edit
  // routed to `fast-path` and no reviewer read the code. Adding a derived-
  // looking filename was a one-line way to drop `code-reviewer`.
  // The raw prefix test, deliberately NOT the inert-aware one. `elevatedPathsIn`
  // drops prose and test paths as inert, which is right for the gate sweep and
  // wrong for the lane that launches nobody: composing that carve-out with the
  // derived one put `packages/db/src/test/x.generated.ts` — a declared elevated
  // path — into `deterministic` with zero reviewers. Each half is documented;
  // the composition was not, and it contradicted this file's own headline.
  //
  // 🔴 Folded to lower case. `normalizePath` preserves case on purpose —
  // folding THERE would create false positives in the gate sweep's escalation
  // decision. These tests are the opposite direction: they can only move a file
  // OUT of a cheap lane, so folding costs a few extra reviews and closes a real
  // hole. Measured: with a declared `scripts/`, a case-mismatched
  // `Scripts/y.generated.ts` reported `M` reached `deterministic` with ZERO
  // reviewers — and no rename is needed, a repo that simply spells the
  // directory differently from its declaration has it from day one.
  const declared = elevatedPaths.map(normalizePath);
  const folded = declared.map((prefix) => prefix.toLowerCase());
  const underDeclaredPath = (path) => {
    const normalized = normalizePath(path).toLowerCase();
    return folded.some((prefix) => normalized.startsWith(prefix));
  };

  /**
   * A file the sweep WOULD have called elevated if the case had matched.
   *
   * 🔴 This closes the residual rather than documenting it, and the shape
   * matters: it asks `elevatedPathsIn` the same question twice, once folded and
   * once not, so it inherits the sweep's inertness in BOTH answers. That is
   * what keeps it consistent instead of merely stricter — `Scripts/notes.txt`
   * now routes exactly where `scripts/notes.txt` routes (`model`, because
   * `.txt` is not inert), and `Scripts/README.md` routes exactly where
   * `scripts/README.md` routes (`fast-path`, because `.md` is).
   *
   * The measured hole: with a declared `scripts/`, `Scripts/notes.txt` reached
   * `fast-path` with `prose-reviewer` as the whole gate while the same file
   * spelled `scripts/` reached `model`. No rename is needed — a repo that
   * spells the directory differently from its declaration has it from day one.
   *
   * What remains after this is the **flag**, not the lane: the change routes
   * expensively, and `risks` stays empty because `elevatedPathsIn` is the
   * sweep's answer and the sweep does not fold. That is limit 5, and it is now
   * the whole of it.
   */
  const caseOnlyElevated = (path) =>
    elevatedPathsIn([path.toLowerCase()], folded).length > 0 &&
    elevatedPathsIn([path], declared).length === 0;

  let prose = 0;
  let derivedUntrusted = 0;
  let derivedUnderDeclaredPath = 0;
  let other = 0;
  for (const file of files) {
    const path = pathOf(file);
    const kind = classifyFile(path);
    // Ahead of the classification, because it disqualifies every kind: a file
    // whose only escape from the declaration is how its directory is spelled
    // must not reach a cheap lane on being prose either.
    if (caseOnlyElevated(path)) other += 1;
    else if (kind === PROSE) prose += 1;
    else if (kind !== DERIVED) other += 1; // code and unknown alike: the expensive answer
    else if (underDeclaredPath(path)) {
      // Counted apart from the status case so the gate line can name WHICH of
      // the two refused the lane. One reason string covering both said "no
      // status saying it was drift" about a file git reported as `M`, and that
      // string is what lands in `decisions.jsonl`.
      derivedUnderDeclaredPath += 1;
      derivedUntrusted += 1;
    } else if (!DERIVED_TRUSTED_STATUSES.has(statusOf(file))) derivedUntrusted += 1;
  }

  const clear = line('risk-flags', 'clear', 'no risk flag fired on the changed paths');

  const everyFileDerived = other === 0 && prose === 0;

  if (everyFileDerived && derivedUntrusted === 0) {
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

  // 🔴 The reason has to name which of the two disqualified the lane. A verdict
  // saying "not every changed file is a derived artifact" about a change where
  // every file IS one is a false line in `decisions.jsonl` — and that line is
  // the only record of why the cheap gate refused.
  const declinedDeterministic = line(
    'deterministic',
    'decline',
    !everyFileDerived
      ? 'not every changed file is a derived artifact'
      : derivedUnderDeclaredPath > 0
        ? 'every changed file is derived, but at least one sits under a path this project declares elevated'
        : 'every changed file is derived, but at least one carries no status saying it was drift — an addition, a copy, a rename, a type change, or a list with no statuses at all',
  );

  if (other === 0 && derivedUntrusted === 0 && prose > 0) {
    return {
      lane: 'fast-path',
      reviewers: ['prose-reviewer'],
      risks,
      why: 'the change is documentation outside the rulebook, with any derived file travelling with it reported as drift',
      gates: [
        clear,
        declinedDeterministic,
        line(
          'fast-path',
          'route',
          'nothing in the change classifies as code or as a rulebook document — `code-reviewer` has nothing to read',
        ),
        line('model', 'skipped', 'not evaluated — a cheaper gate claimed the change'),
      ],
    };
  }

  // Same rule one lane down: say which count sent it here. There are two
  // reasons and they are not the same finding.
  const reasons = [];
  if (other > 0) reasons.push('code, a rulebook document, or a path the router could not classify');
  if (derivedUnderDeclaredPath > 0) {
    reasons.push('a derived artifact under a path this project declares elevated');
  }
  // Strictly greater, so a single file tripping BOTH is reported once by its
  // sharper reason rather than twice. A diff carrying one of each names both.
  if (derivedUntrusted > derivedUnderDeclaredPath) {
    reasons.push('a derived artifact with no status saying it was drift');
  }

  return {
    lane: 'model',
    reviewers: reviewersFor(files, risks),
    risks,
    why: `the change carries ${reasons.join(', and ')}`,
    gates: [
      clear,
      declinedDeterministic,
      line(
        'fast-path',
        'decline',
        prose === 0
          ? 'nothing in the change classifies as documentation, which is what this lane admits'
          : 'the change is not documentation-only',
      ),
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
    // `DOC_EXTENSIONS` rather than the PROSE classification: `.mdx` is code to
    // the lane logic and a document to a reader, and both are true.
    const segments = segmentsOf(path);
    const basename = segments[segments.length - 1] ?? '';
    const dot = basename.lastIndexOf('.');
    const extension = dot > 0 ? basename.slice(dot + 1).toLowerCase() : '';
    if (DOC_EXTENSIONS.has(extension) || isRulebookPath(path)) {
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
  // 🔴 NOT `modified`. A type change swaps a file for a symlink (or back), which
  // is not "the generator ran again" — so it must not buy the trusted status
  // that unlocks the lane with no reviewer.
  T: 'type-changed',
});

// 🔴 The DEFAULT, and it is the point: round four fixed `T` by adding a table
// entry, which left the class open. Every letter not in the table — `U`
// unmerged, `X` unknown, `B` broken pairing, and whatever git adds next —
// resolved to `modified`, the one status that unlocks the lane with no
// reviewer. An unclassifiable input resolves to the expensive answer here like
// everywhere else in this file.
const UNKNOWN_STATUS = 'unknown';

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
    const status = STATUS_LETTERS[letter] ?? UNKNOWN_STATUS;
    if (letter === 'R' || letter === 'C') {
      const from = fields[i + 1];
      const to = fields[i + 2];
      // 🔴 A rename DELETES its source, and the source path is the only place
      // that deletion appears in the diff. Keeping just the destination let a
      // rename carry a test out of the suite and a hook out of `.claude/` with
      // nothing left for any flag to see — measured, not predicted: a diff
      // renaming `test/foo.test.ts` and `.claude/hooks/guard-bash.mjs` into
      // `docs/` routed to `fast-path` with `prose-reviewer` as the whole gate.
      // A COPY leaves its source in place, so only a rename records one.
      if (from && letter === 'R') files.push({ path: from, status: 'removed' });
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

/**
 * A revision this file is willing to hand to git.
 *
 * `${base}...${head}` is one argv element with no `--` separator ahead of it, so
 * a value starting with `-` is read by git as an OPTION rather than a revision —
 * `--base '--output=/tmp/x'` really does make git write a file. There is no
 * shell here and the caller already owns the process, so this is hardening
 * rather than a hole; it is refused because the module treats its argv as
 * untrusted everywhere else and a half-guarded input is the one people rely on.
 */
const revisionOrNull = (value) =>
  typeof value === 'string' && value !== '' && !value.startsWith('-') ? value : null;

const parseArgs = (argv) => {
  const args = { base: 'origin/HEAD', head: 'HEAD', files: null, json: false, bad: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--base' || arg === '--head') {
      const key = arg.slice(2);
      const value = revisionOrNull(argv[++i]);
      if (value === null) args.bad = arg;
      else args[key] = value;
    } else if (arg === '--files') args.files = argv[++i] ?? '';
    // An unrecognised flag was silently ignored, so `--file README.md` routed
    // the whole branch diff at exit 0 — a different change than the caller
    // asked about, reported as if it were theirs. That is the one input this
    // module was not treating as untrusted.
    //
    // The FIRST offender is kept, not the last: `--file README.md` leaves two
    // unrecognised tokens behind, and naming the second one points the reader
    // at the argument rather than at the typo that stranded it.
    else if (args.bad === null) args.bad = arg;
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
    // git's own stderr is captured rather than inherited, so it does not
    // interleave with this file's output mid-run.
    //
    // ⚠ Stated exactly, because the first version of this comment claimed a
    // sanitisation that does not happen: `execFileSync` folds the captured
    // stderr into `error.message`, and the handler below prints that verbatim.
    // So git's `fatal:` text and any repository-supplied name in it still reach
    // the terminal — just at the end rather than streamed. Capturing buys
    // ordering, not filtering.
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseNameStatus(raw);
};

/**
 * Was this file invoked directly?
 *
 * Compared by REALPATH on both sides, the same way every sibling CLI in this
 * directory does it. ESM resolves `import.meta.url` through symlinks while
 * `process.argv[1]` keeps the path as typed, so a checkout behind a link — a
 * macOS temp dir, a symlinked home — fails a naive equality check and the script
 * exits 0 having printed nothing. For this file that is the worst shape
 * available: the gate reads the lane off stdout, and empty stdout with exit 0 is
 * indistinguishable from a router that ran.
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

if (invokedDirectly()) {
  const args = parseArgs(process.argv.slice(2));
  if (args.bad !== null) {
    process.stderr.write(
      `decision-router: ${args.bad === '' ? '""' : args.bad} is not a flag this router ` +
        'understands, or was given a value starting with "-" that git would read as an ' +
        'option rather than a revision. Nothing was routed — treat this as the expensive ' +
        'lane.\n',
    );
    process.exit(1);
  }
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

  // 🔴 A project that declares no elevated path cannot have the `elevated-path`
  // flag EVALUATED — and degrading that to an empty declaration made the trace
  // say `risk-flags clear — no risk flag fired`, which is an unevaluated check
  // reading as a pass. That is the one thing a gate's own journal must never
  // produce, so this refuses instead, exactly as `recordCompletedTier` does.
  const declared = readDeclaredPaths(projectRoot);
  if (!declared || declared.length === 0) {
    process.stderr.write(
      'decision-router: nothing in this project declares an elevated path, so the ' +
        '`elevated-path` risk flag cannot be evaluated and no lane can be trusted. Add an ' +
        '`elevated-paths` block to CLAUDE.md or a rule file. Nothing was routed — treat ' +
        'this as the expensive lane, never as a cheap one.\n',
    );
    process.exit(1);
  }

  let result;
  try {
    result = route({ files, elevatedPaths: declared });
  } catch (error) {
    // The refusal, as a diagnosis rather than a stack dump: a caller reading a
    // node trace on stderr learns nothing about why its change was not routed.
    process.stderr.write(`decision-router: ${error?.message ?? error}\n`);
    process.exit(1);
  }

  // 🔴 A router with no journal line is a decision nobody can retrace. One
  // record per gate — including the skipped ones, because within a run that
  // declared a directory, "no line" is exactly how a gate that silently stopped
  // matching looks.
  //
  // ⚠ Read that condition exactly, because the two absences are different
  // facts: this writes ONLY when the run declared `RIG_RUN_DIR`, so an empty
  // `decisions.jsonl` across an undeclared run is the ordinary state and says
  // nothing about the gates. Inventing a directory here would make this CLI a
  // second owner of the `.claude/runs/<run-id>/` convention.
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
