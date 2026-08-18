// The credential vocabulary, decided once, so that everything which refuses a
// credential refuses the same set.
//
// Every layer that refuses one reads THIS module — which layers exist is a
// question about the project, not about this file. A freshly generated rig has
// the `guard-secret-file` PreToolUse hook and nothing else; the generator this
// came from adds a commit-time check and a CI sweep over the same vocabulary
// (`scripts/validate-no-secrets.mjs`, wired in `.husky/pre-commit` and the CI
// workflow). Read `.husky/` and the CI config to know which of those you have.
//
// `.claude/rules/invariants.md` ("one mechanism, one implementation") is why the
// vocabulary is a module and not a list per consumer: two copies of an invariant
// disagree, and the one nobody is looking at is the one that is wrong. That is
// worth keeping even at one consumer, because the ignore rules are the second
// reader of this set whether or not they import it.
//
// ⚠ The `see <file> › "<test>"` pointers below name suites that live in the
// GENERATOR this rig came from, not in this repository — the same arrangement
// `.claude/rules/invariants.md` describes for the hooks themselves under "About
// the hooks you were given". They are where a claim is proven, not cover you
// have here. The moment you edit this module, its tests are yours.
//
// It answers two different questions, and keeping them apart matters:
//
//   isCredentialPath(path)  — is this file a credential BY ITS NAME?
//   findSecretValues(text)  — does this TEXT contain a credential value?
//
// The first is what `.gitignore` can express; the second is what nothing in this
// repository expressed before, which is the gap AR-49(b) was filed for.
//
// 🔴 WHAT THIS DELIBERATELY DOES NOT DO, because a guard's own claim about its
// reach is the first thing to go stale:
//
//   - It never returns the matched value. A guard that prints what it found has
//     copied the credential into a hook transcript, a CI log and a terminal
//     scrollback — it has leaked the secret in the act of refusing it. The
//     finding is `{ id, line }` and the tests assert the serialised finding
//     carries neither the value nor a fragment of it: see secrets-lib.test.ts ›
//     "never carries the credential itself into the finding it reports".
//   - The assignment arm judges at most 32 candidates on one line and gives up.
//     Past that a real credential is missed — it needs 32+ keyword-plus-identifier
//     candidates ahead of the real value on ONE line, so a minified bundle or a
//     single-line config rather than ordinary source. Pinned from both sides, the
//     way the scan cap is: see secrets-lib.test.ts › "finds a credential behind
//     thirty-one innocent candidates" and › "misses a credential behind more
//     candidates than the cap allows".
//   - It is a TEXT scan, not an entropy analyser. A credential that matches none
//     of the shapes below passes, and a base64 blob that happens to look like
//     one does not. It targets drift, not an adversary. Named rather than left
//     to be discovered, because the list of prefixes below invites the opposite
//     assumption: a password inside a `postgres://user:pass@host` or a
//     basic-auth URL, a bare unassigned JWT, a storage connection string of
//     the `AccountKey=…` form and a PuTTY key header are all still invisible
//     to it. Nor are these siblings of the prefixes it does know: the `xapp-`
//     and `xoxe-` chat-app forms, a test-mode payment key, and the classic
//     un-prefixed model-provider key.
//   - `assigned-secret` reads a keyword next to a long value. It cannot tell a
//     real token from a long placeholder, which is why the length bound exists
//     and why the placeholder forms this repository actually writes are pinned
//     by test rather than by hope: see secrets-lib.test.ts › "leaves the
//     placeholder %s alone".
//
// 🔴 AND IT IS BOUNDED, which is the rule `invariants.md` says cost the most to
// learn. Its PreToolUse consumer fails OPEN — a hook that throws allows the edit
// — so every line of work here is a potential total bypass, for all the rules at
// once rather than for the one that broke. (The validator fails closed: it exits
// 1 on a finding. The asymmetry is deliberate and belongs to those files.)
//
// Hence, and every one of these is a bound rather than a hope: the input is
// capped BEFORE it is split; every quantifier is bounded or over a class
// disjoint from what follows it; the one pattern that judges its value walks a
// line's candidates under an explicit cap rather than to exhaustion. The last
// two were paid for — an unbounded run between keyword and separator made this
// quadratic, 36 s on 256 KB of one line, in a guard that fails open. The cap is
// asserted by test from both
// sides — that a secret past it is missed, and that the same secret is found
// without the cap, so the miss is not passing for the wrong reason: see
// secrets-lib.test.ts › "scans nothing past the limit it was given".

/**
 * The words this project calls a credential — a NAMED SUBSET of the router's
 * 55-member `SECURITY_WORDS`, not a derivation from it.
 *
 * The distinction is the whole decision. `SECURITY_WORDS` answers "is this path
 * a security surface worth a careful reviewer", and `auth`, `session`, `cors`
 * and `acl` belong in that answer. This set answers "is this file a credential",
 * where those same words are ordinary names in ordinary source — `auth.ts`,
 * `session.ts`, `permissions.ts` — and a guard that refused them would be routed
 * around within the week. A routed-around guard is worse than no guard, because
 * everyone believes they are covered.
 *
 * A test asserts every word here is still in the router's set, so the two cannot
 * drift into disagreeing about what a credential is.
 */
export const CREDENTIAL_WORDS = new Set([
  'apikey',
  'apikeys',
  'bearer',
  'creds',
  'credential',
  'credentials',
  'jwt',
  'passwd',
  'password',
  'passwords',
  'secret',
  'secrets',
  'token',
  'tokens',
]);

/**
 * Credential files whose name carries no extension to give them away.
 *
 * `.envrc` is here and is deliberately WIDER than the router: `isSecretFile`
 * misses it, because its only dot is at index 0 so the extension arm returns
 * early. direnv writes `export JIRA_API_TOKEN=…` into it verbatim, which makes
 * the miss expensive. Widening the router itself changes routing behaviour in a
 * file under a declared elevated path — a different change at a different tier.
 */
export const CREDENTIAL_BASENAMES = new Set([
  '.envrc',
  '.netrc',
  '.npmrc',
  '.pgpass',
  'id_ed25519',
  'id_rsa',
]);

/** Extensions that mean key material, whatever the file is called. */
export const CREDENTIAL_EXTENSIONS = new Set(['jks', 'key', 'keystore', 'p12', 'pem', 'pfx']);

/**
 * Directory names whose contents are credentials whatever they are called.
 *
 * This is the arm AR-49(a) left open, and the reason it is closed HERE rather
 * than in `.gitignore`: an ignore rule over `secrets/` hides legitimate source
 * and a gitignore has no include directive to claw it back. Refusing a commit
 * is the right instrument; hiding a directory is not.
 */
export const CREDENTIAL_SEGMENTS = new Set(['credentials', 'secrets']);

/**
 * Suffixes that mark the documented placeholder form of an env file.
 *
 * `.env.example` is committed on purpose — it is how a project states which
 * variables it needs. The exemption is scoped to the env arm alone: a file under
 * `secrets/` stays a credential however it is suffixed.
 */
const PLACEHOLDER_SUFFIXES = ['.example', '.sample', '.template'];

/** The last dot-separated part, or `''` for a name whose only dot leads it. */
const extensionOf = (basename) => {
  const dot = basename.lastIndexOf('.');
  return dot <= 0 ? '' : basename.slice(dot + 1).toLowerCase();
};

/**
 * The suffixes that make `<stem>.env.<suffix>` an env FILE rather than a source
 * file about the environment.
 *
 * 🔴 Named rather than open-ended, and that is the whole point. A bare
 * `basename.includes('.env.')` reaches `prod.env.local` — and also
 * `packages/shared/src/config.env.ts`, `src/app.env.ts` and `docs/setup.env.md`,
 * which are ordinary source. `CLAUDE.md` puts env loading in `packages/shared`,
 * so that false positive lands on the file most likely to need writing. See
 * secrets-lib.test.ts › "leaves %s writable — it is source, not a credential".
 *
 * ⚠ The price, named rather than left to be found: an environment this list does
 * not know — `app.env.qa`, `svc.env.ci` — is invisible to the path arm. A file
 * called `.env.qa` is unaffected; only the `<stem>.env.<suffix>` form needs the
 * suffix to be recognised.
 */
const ENV_SUFFIXES = new Set([
  'local',
  'development',
  'dev',
  'production',
  'prod',
  'staging',
  'stage',
  'test',
]);

// `.env` at either end, or in the middle followed by a named environment.
const isEnvFile = (basename) => {
  if (basename === '.env' || basename.startsWith('.env.') || basename.endsWith('.env')) return true;
  const middle = basename.indexOf('.env.');
  if (middle < 0) return false;
  return ENV_SUFFIXES.has(basename.slice(middle + '.env.'.length));
};

/**
 * Whether a path names a credential file, from the path text alone.
 *
 * Deliberately answers from the NAME: it is the question a pre-commit hook and a
 * PreToolUse hook can both ask before any content exists to read.
 */
export const isCredentialPath = (relativePath) => {
  const normalised = String(relativePath ?? '').replaceAll('\\', '/');
  // 🔴 Lowercased once, and every arm below reads the lowered form. macOS and
  // Windows are case-insensitive filesystems, so `.ENV` and `.env` are the SAME
  // FILE — a case-sensitive check refuses one spelling and waves the other
  // through, while git records whichever one was typed.
  const segments = normalised
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => segment.toLowerCase());
  if (segments.length === 0) return false;

  const basename = segments[segments.length - 1];

  // Directories only — the basename is not a segment. A file merely NAMED for
  // the subject (`secrets-lib.test.ts`, a `secrets-and-tokens.md` note) is
  // source, not a credential.
  for (let i = 0; i < segments.length - 1; i += 1)
    if (CREDENTIAL_SEGMENTS.has(segments[i])) return true;

  if (CREDENTIAL_BASENAMES.has(basename)) return true;

  // The two most famous credential filenames there are, and both were missed:
  // a cloud CLI's `credentials` file and `.git-credentials` carry the word as
  // the BASENAME,
  // which the segment loop above deliberately skips. Matched exactly, or behind
  // a `-`, so `credentials.ts` and `secrets-lib.test.ts` stay source.
  if (CREDENTIAL_SEGMENTS.has(basename)) return true;
  // 🔴 DOTFILES only. `.git-credentials` is a credential store; `scripts/rotate-secrets`
  // and `ops/sync-credentials` are ordinary extensionless scripts, and refusing
  // to write them is the false positive that gets a guard uninstalled. See
  // secrets-lib.test.ts › "leaves %s writable — it is source, not a credential".
  if (basename.startsWith('.') && (basename.endsWith('-credentials') || basename.endsWith('-secrets')))
    return true;

  if (isEnvFile(basename))
    return !PLACEHOLDER_SUFFIXES.some((suffix) => basename.endsWith(suffix));

  const extension = extensionOf(basename);
  if (extension === '') return false;
  return CREDENTIAL_EXTENSIONS.has(extension) || CREDENTIAL_WORDS.has(extension);
};

/**
 * The `assigned-secret` pattern, built from `CREDENTIAL_WORDS`.
 *
 * 🔴 THE RUN BETWEEN KEYWORD AND SEPARATOR IS BOUNDED, and that bound is the
 * whole difference between linear and quadratic. Unbounded, the engine restarts
 * at every offset and walks `[A-Za-z0-9_-]*` to end-of-line at each keyword hit.
 * In a guard that FAILS OPEN and shares its matcher with two others, that is not
 * slowness, it is a bypass of all three. `.claude/rules/invariants.md` states the
 * bar exactly: not "is it fast enough on realistic input" but "can any input make
 * it do unbounded work at all". Pinned by secrets-lib.test.ts › "grows linearly
 * with input size rather than quadratically".
 *
 * Forty characters is chosen to clear the longest real prefix this has to
 * cross — `_ACCESS_KEY` after `secret` — with room, and nothing longer is an
 * assignment anyone writes.
 *
 * ⚠ NOT anchored with `\b`, deliberately. It would read as the obvious fix for
 * the same measurements, and it breaks the case this arm exists for:
 * a name like `<VENDOR>_SECRET_ACCESS_KEY` is one word, so there is no word
 * boundary before `SECRET` and the keyword would never be found.
 * What separates a credential from an identifier here is the VALUE, not the
 * keyword — see `IDENTIFIER_VALUE` below.
 */
const assignmentPattern = () => {
  // Ordered longest-first so `credentials` is tried before `credential`. This is
  // presentation, not correctness: the bounded run absorbs either tail.
  const words = [...CREDENTIAL_WORDS].sort((a, b) => b.length - a.length);
  // `api_key` and `api-key` are the same keyword spelled three ways; the
  // vocabulary holds only the closed form, so the separators are added here.
  const alternation = [...words, 'api[_-]?keys?'].join('|');
  return new RegExp(
    `(?:${alternation})[A-Za-z0-9_-]{0,40}["']?\\s*[=:]\\s*["']?([A-Za-z0-9_\\-+/=]{16,})`,
    'i',
  );
};

/**
 * A value that is a bare identifier, which is what SOURCE is made of.
 *
 * 🔴 This is the rule that separates an assigned random string from
 * `readonly credentials: RequestCredentials`. (Deliberately described rather
 * than shown: a literal example here is a finding in this file, which is the
 * same reason the suites assemble their fixtures.)
 *
 * Without it the arm reported ordinary source — `const trailingToken =
 * getTrailingToken(…)`, `exports.isTokenOnSameLine = …`, `credentials:
 * CredentialsContainer`. Those are the shapes a TypeScript service tree is MADE
 * of, and this module ships into one. What keeps that true is not this comment:
 * see secrets-lib.test.ts › "leaves %s alone" in the block about ordinary
 * TypeScript, and › "finds no credential value in any file this repository
 * tracks", which sweeps the whole tree with no exemption.
 *
 * A guard that fires on honest work is routed around within the week, and a
 * routed-around guard is worse than none because everyone believes they are
 * covered. See secrets-lib.test.ts › "leaves %s alone" in the block about
 * ordinary TypeScript.
 *
 * ⚠ The price is real and is pinned too: an all-letters secret is invisible to
 * this arm — see › "cannot see an assigned value that is all letters, which is
 * the price of the rule above". Shapes with a recognisable prefix are caught by
 * the patterns above regardless of what they are assigned to.
 */
const IDENTIFIER_VALUE = /^[A-Za-z]+$/;

/**
 * The credential shapes a refusal names — each id chosen so a block can say WHICH
 * shape it matched without quoting what it matched.
 *
 * How many things read this list is a question about the project, answered at the
 * top of this file; it is not a property of the list.
 *
 * Every pattern is deliberately flat: no quantifier nests inside another.
 *
 * 🔴 THAT IS NOT SUFFICIENT ON ITS OWN, and reading it as sufficient is how the
 * quadratic in `assignedPattern` got written. Disjoint consecutive classes bound
 * each backtrack STEP; they say nothing about the engine RESTARTING at every
 * offset. An unanchored alternation followed by an unbounded run is linear per
 * attempt and quadratic over the line. The rule for a thirteenth pattern is
 * therefore: a literal prefix and ONE bounded class, or a bound on every
 * quantifier that can follow a match that fails.
 */
export const SECRET_VALUE_PATTERNS = [
  { id: 'atlassian-token', pattern: /ATATT3x[A-Za-z0-9_\-=]{16,}/ },
  // `gh[pousr]_` rather than `ghp_` alone: the other four are live credentials
  // of the same shape, and an id called `github-pat` reads as though they were
  // already covered.
  { id: 'github-pat', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  // The negative lookahead is the issuer's own PUBLISHED example key. It appears
  // in documentation, and this generator ships a target whose README quotes such
  // docs — refusing it at commit time, with --no-verify hook-blocked, leaves an
  // author nothing but to route around the guard. A fixed-length literal, so it
  // adds no backtracking surface. See secrets-lib.test.ts › "leaves the published
  // example access key alone".
  { id: 'cloud-access-key', pattern: /\bAKIA(?!IOSFODNN7EXAMPLE\b)[A-Z0-9]{16}\b/ },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9\-_]{16,}/ },
  { id: 'private-key-block', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  // Six more with a recognisable prefix. Each is a literal followed by ONE
  // bounded class — the cheapest shape there is, and the one that cannot
  // backtrack. They are here because a tool that names four issuers by prefix
  // invites the reader to assume it knows the rest; the ones it still does not
  // know are named in the limits block above rather than left to be discovered.
  { id: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{16,}/ },
  // Exactly 35, not 16-or-more: the open bound matched ordinary identifiers
  // that merely begin with those four letters (`AIzaSyntaxHighlighter`).
  { id: 'google-api-key', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/ },
  { id: 'stripe-live-key', pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}/ },
  { id: 'openai-project-key', pattern: /\bsk-proj-[A-Za-z0-9_-]{16,}/ },
  { id: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{30,}/ },
  { id: 'gitlab-pat', pattern: /\bglpat-[A-Za-z0-9_-]{16,}/ },
  // A keyword next to a long LITERAL value — the only pattern here that is
  // built rather than written, because it is the only one whose vocabulary this
  // project decides.
  //
  // THREE bounds, and every one of them was paid for by a defect:
  //
  // 1. Sixteen characters. This is what keeps `.env.example` committable —
  //    `your-token-here` is fifteen. See secrets-lib.test.ts › "leaves the
  //    placeholder %s alone".
  //
  // 2. A LITERAL value class — no dot, no bracket. An earlier form read
  //    `\S{16,}` and matched a code expression as happily as a literal, which
  //    against this repository's own tree produced false positives and nothing
  //    else, feeding a hook that blocks a commit. `.claude/rules/invariants.md`:
  //    "Where a false block interrupts ordinary work, stay narrow and specific."
  //    What keeps it narrow is not this comment but two live tests — see
  //    secrets-lib.test.ts › "leaves the honest line %s alone" and › "finds no
  //    credential value in any file this repository tracks".
  //
  // 3. An OPTIONAL leading quote, and the keyword need not touch the separator.
  //    Without those two the pattern missed `const token = "…"`, `"api_key":
  //    "…"` and `SECRET_ACCESS_KEY=…` — every quoted assignment, which is the
  //    dominant shape in a TypeScript, JSON or YAML tree. The second of those is
  //    the sharp one: `cloud-access-key` matches the key IDENTIFIER, which is
  //    public, so without this the scanner caught the public half of a key pair
  //    and missed the private half. That is worse than catching neither, because
  //    it reads as coverage. See secrets-lib.test.ts › "reports %s, whose value
  //    is quoted rather than bare" and › "reports %s, where the keyword is not
  //    adjacent to the separator".
  //
  // 🔴 THE KEYWORDS ARE DERIVED FROM `CREDENTIAL_WORDS`, not restated. A
  // hardcoded five-word list sat here while the file called itself "one
  // vocabulary, decided once" and the vocabulary had fourteen — two lists
  // answering one question, which is the exact thing this module exists to
  // prevent. A test walks every word: see secrets-lib.test.ts › "accepts every
  // word in the credential vocabulary as an assignment keyword".
  //
  // What is still lost, stated as measured: a value whose literal run breaks
  // before sixteen characters — see › "cannot see a credential whose literal run
  // breaks before sixteen characters". An inline JWT is NOT lost; its first
  // segment is twenty-odd literal characters.
  {
    id: 'assigned-secret',
    pattern: assignmentPattern(),
    // The value is captured so it can be judged, not merely matched.
    valueGroup: 1,
    reject: IDENTIFIER_VALUE,
  },
];

/**
 * How much text a scan reads before it stops.
 *
 * A cap rather than a timeout, because a cap is decidable before the work
 * starts. Two megabytes covers every source file this rulebook expects and stops
 * a generated blob from turning a fail-open guard into a bypass.
 */
export const DEFAULT_SCAN_LIMIT = 2 * 1024 * 1024;

/**
 * A global twin per rejecting pattern, built once.
 *
 * Only patterns that JUDGE their value need to walk a line: the rest answer with
 * one `test`. Built at module load rather than per line, because a fail-open
 * guard should not allocate per unit of input.
 */
const GLOBAL_TWIN = new Map(
  SECRET_VALUE_PATTERNS.filter((entry) => entry.reject).map((entry) => [
    entry.id,
    new RegExp(entry.pattern.source, `${entry.pattern.flags}g`),
  ]),
);

/** How many candidates on one line are judged before the line is given up on. */
const MAX_CANDIDATES_PER_LINE = 32;

/**
 * Whether one pattern claims this line.
 *
 * A rejecting pattern walks the line's candidates rather than judging only the
 * first: `credentials: RequestCredentials, token: <a real one>` has an innocent
 * match before a guilty one, and stopping at the first would miss it. Bounded by
 * `MAX_CANDIDATES_PER_LINE`, so the walk cannot become the unbounded work this
 * module exists to avoid.
 */
const matches = (entry, line) => {
  if (!entry.reject) return entry.pattern.test(line);
  const global = GLOBAL_TWIN.get(entry.id);
  if (!global) return entry.pattern.test(line);
  global.lastIndex = 0;
  for (let seen = 0; seen < MAX_CANDIDATES_PER_LINE; seen += 1) {
    const match = global.exec(line);
    if (match === null) return false;
    if (!entry.reject.test(match[entry.valueGroup] ?? '')) return true;
    // 🔴 RESUME ONE CHARACTER PAST THE START, never past the whole match. A
    // rejected match ends after its all-letters value, and a credential keyword
    // INSIDE that value is then consumed with it: `AtlassianApiToken` ends in
    // `Token`, so `const secret: AtlassianApiToken = "<a real one>"` was reported
    // clean by all three layers. The property was inverted — more credential
    // vocabulary on the line meant less detection. See secrets-lib.test.ts ›
    // "reports %s, whose real value sits behind a rejected one".
    //
    // This is also what makes the cap above load-bearing rather than decorative:
    // the walk now revisits offsets, so it is the cap that bounds it.
    global.lastIndex = match.index + 1;
  }
  return false;
};

/**
 * Every credential shape found in `text`, as `{ id, line }` and nothing else.
 *
 * One forward pass over at most `limit` characters. A pattern is reported once
 * per line however many times it occurs there: the finding locates the problem,
 * it does not count it.
 */
export const findSecretValues = (text, options = {}) => {
  const source = typeof text === 'string' ? text : '';
  const limit = Number.isFinite(options.limit) ? Math.max(0, options.limit) : DEFAULT_SCAN_LIMIT;
  // Capped BEFORE the split, so the array below is bounded by `limit` and not by
  // the caller's input — `invariants.md`: cap first, then spread.
  const scanned = source.length > limit ? source.slice(0, limit) : source;

  const findings = [];
  const lines = scanned.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const entry of SECRET_VALUE_PATTERNS) {
      if (matches(entry, line)) findings.push({ id: entry.id, line: index + 1 });
    }
  }
  return findings;
};
