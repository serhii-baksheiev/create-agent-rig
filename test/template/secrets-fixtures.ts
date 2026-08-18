/**
 * Synthetic credentials for the AR-49(b) suites — every one of them ASSEMBLED,
 * never written as a literal.
 *
 * 🔴 This is the whole point of the file, and it is not stylistic. The thing
 * under test scans tracked files for credential shapes. A fixture written
 * literally in its own test file becomes the scanner's first finding the moment
 * the file is committed — and then the `.husky/pre-commit` check refuses the
 * commit that adds the test, and the CI validator reports a leak that is not
 * one. That the suites are clean by the scanner's own definition is asserted,
 * not asserted-in-prose: see secrets-lib.test.ts › "finds no credential value in
 * any file this repository tracks", which sweeps them with no exemption.
 *
 * The alternative was an exemption list naming the test files. That is worse in
 * a specific way: an exemption is indistinguishable from a real leak that
 * someone silenced, it needs a reason nobody can verify later, and it grows by
 * one entry every time a suite gains a fixture. Assembly needs no list, no
 * reason and no maintenance — the sweep stays honestly empty, which is the only
 * state in which "nothing is committed here" means anything.
 *
 * None of these are real credentials. They are the SHAPES the patterns match,
 * chosen so each one proves the pattern it names and no other.
 *
 * A second copy of this file is not needed anywhere: it is a plain module rather
 * than a `*.test.ts`, so importing it does not drag a suite along —
 * `verdict-spec.ts` in this directory is the same shape for the same reason.
 */

/** Joins the parts so no matchable run ever appears contiguously in source. */
const assemble = (...parts: string[]): string => parts.join('');

export const ATLASSIAN_TOKEN = assemble('ATATT', '3xFfGF0T4Ph9Kx2Qm7Zb3Rv8Nc1Ld5Gj6Ws0Ey4Ui');
export const GITHUB_PAT = assemble('ghp', '_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
export const GITHUB_FINE_GRAINED = assemble(
  'github',
  '_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789ABCDEF',
);
export const CLOUD_ACCESS_KEY = assemble('AKIA', 'ABCDEFGHIJKLMNOP');
/** A second key of the same shape, for the "reported once per line" case. */
export const CLOUD_ACCESS_KEY_TWIN = assemble('AKIA', 'QRSTUVWXYZABCDEF');
export const ANTHROPIC_KEY = assemble('sk-ant', '-api03-Zq9Wx7Lv2Kd4Nb8Mc1Pf6Rt3Hy5Ug0Jn');

/** The opening line of a private key block, for any kind of key. */
export const pemHeader = (kind = 'RSA '): string =>
  assemble('-----BEGIN ', kind, 'PRIVATE', ' KEY-----');

export const PEM_HEADER = pemHeader();

/**
 * A `KEYWORD=value` line, assembled so the assignment never reads as one in
 * source. `keyword` carries its own separator (`=`, `:`, ` = `), because which
 * separator is used is part of what the assignment cases are pinning.
 */
export const assignment = (keyword: string, value: string): string => assemble(keyword, value);

/** A JWT: three base64url segments. Its first segment is a long literal run. */
export const INLINE_JWT = [
  assignment('token=', 'eyJhbGciOiJIUzI1NiJ9'),
  'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV',
].join('.');

/**
 * A 32-character literal run, long enough to clear the sixteen-character bound
 * with room to spare — so a case that fails does so for the reason it names and
 * not for length.
 */
export const LONG_RUN = assemble('aBcDeFgHiJkLmNoPqRsTuVwXyZ', '012345');
export const LONG_WORDS = assemble('hunter2hunter2', 'hunter2hunter2');

/** The AWS secret access key, whose canonical spellings both put text between
 * the credential word and the separator. */
export const AWS_SECRET = assemble('wJalrXUtnFEMI', 'K7MDENGbPxRfiCYEXAMPLEKEY');

/** A quoted assignment, assembled so the quote never sits next to the run. */
export const quoted = (prefix: string, value: string, quote = '"'): string =>
  assemble(prefix, quote, value, quote);

/** Six more shapes with a recognisable prefix, all assembled, none real. */
export const SLACK_BOT_TOKEN = assemble('xoxb', '-2417923850-4192837465-aBcDeFgHiJkLmNoPqRsTuVwX');
export const GOOGLE_API_KEY = assemble('AIza', 'SyD-9fA2dC7bE1gH4jK6mN8pQ0rS3tU5vW7');
export const STRIPE_LIVE_KEY = assemble('sk_live', '_51HkQ2aBcDeFgHiJkLmNoPqRsTuVwXyZ0123');
export const OPENAI_PROJECT_KEY = assemble('sk-proj', '-Zq9Wx7Lv2Kd4Nb8Mc1Pf6Rt3Hy5Ug0Jn2Bs4Dt');
export const NPM_TOKEN = assemble('npm', '_aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX');
export const GITLAB_PAT = assemble('glpat', '-aB1cD2eF3gH4iJ5kL6');
