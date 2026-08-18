// The credential vocabulary, decided once and imported by every layer that
// refuses one.
//
// Every layer that refuses a credential imports it: the `guard-secret-file`
// PreToolUse hook, and `scripts/validate-no-secrets.mjs` — which CI runs over
// the tracked tree and `.husky/pre-commit` runs over the staged set.
// `.claude/rules/invariants.md` ("one mechanism, one implementation") is why it
// is a module rather than a list per layer: two copies of an invariant disagree,
// and the one nobody is looking at is the one that is wrong.
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
//   - It is a TEXT scan, not an entropy analyser. A credential that matches none
//     of the shapes below passes, and a base64 blob that happens to look like
//     one does not. It targets drift, not an adversary.
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
// 1 on a finding. The asymmetry is deliberate and belongs to those files.) Hence: the input is capped
// BEFORE it is split, one forward pass, no rescanning, and no pattern that can
// backtrack (every quantifier below is anchored by a literal or a character
// class, never a nested repetition). The cap is asserted by test from both
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

// `.env` anywhere in the name, not only at either end: `prod.env.local` and
// `jira.env.local` are the forms a multi-environment project writes, and they
// match neither `*.env` nor `.env.*`.
const isEnvFile = (basename) =>
  basename === '.env' ||
  basename.startsWith('.env.') ||
  basename.endsWith('.env') ||
  basename.includes('.env.');

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
  if (basename.endsWith('-credentials') || basename.endsWith('-secrets')) return true;

  if (isEnvFile(basename))
    return !PLACEHOLDER_SUFFIXES.some((suffix) => basename.endsWith(suffix));

  const extension = extensionOf(basename);
  if (extension === '') return false;
  return CREDENTIAL_EXTENSIONS.has(extension) || CREDENTIAL_WORDS.has(extension);
};

/**
 * The `assigned-secret` pattern, built from `CREDENTIAL_WORDS`.
 *
 * Longest word first, so `credentials` is tried before `credential` — the
 * alternation is ordered, and a shorter prefix winning would leave the rest of
 * the word to the run below rather than to the separator.
 *
 * `[A-Za-z0-9_-]*` between the keyword and the separator is what reaches
 * `SECRET_ACCESS_KEY=` and every plural. It cannot cross whitespace, so a
 * keyword in prose never reaches a separator further down the line: `the token
 * here = x` does not match, because `here` is not adjacent to `token`.
 *
 * Bounded by construction: that class, `\s*` and `[=:]` are mutually disjoint,
 * so no input gives the engine a choice to backtrack over.
 */
const assignmentPattern = () => {
  const words = [...CREDENTIAL_WORDS].sort((a, b) => b.length - a.length);
  // `api_key` and `api-key` are the same keyword spelled three ways; the
  // vocabulary holds only the closed form, so the separator is added here.
  const alternation = [...words, 'api[_-]?keys?', 'secret[_-]?access[_-]?key'].join('|');
  return new RegExp(
    `(?:${alternation})[A-Za-z0-9_-]*["']?\\s*[=:]\\s*["']?[A-Za-z0-9_\\-+/=]{16,}`,
    'i',
  );
};

/**
 * The credential shapes the three call sites refuse, each named so a refusal can
 * say WHICH shape it matched without quoting what it matched.
 *
 * Every pattern is deliberately flat: no quantifier nests inside another, and
 * where two run in sequence their character classes are DISJOINT, so the engine
 * never has a choice to backtrack over. That is the property that matters — a
 * guard that fails open cannot afford to hang, and ambiguity is what makes a
 * regex hang.
 */
export const SECRET_VALUE_PATTERNS = [
  { id: 'atlassian-token', pattern: /ATATT3x[A-Za-z0-9_\-=]{16,}/ },
  { id: 'github-pat', pattern: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { id: 'cloud-access-key', pattern: /\bAKIA[A-Z0-9]{16}\b/ },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9\-_]{16,}/ },
  { id: 'private-key-block', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
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
    for (const { id, pattern } of SECRET_VALUE_PATTERNS) {
      if (pattern.test(line)) findings.push({ id, line: index + 1 });
    }
  }
  return findings;
};
