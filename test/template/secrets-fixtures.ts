/**
 * Synthetic credentials for the AR-49(b) suites — every one of them ASSEMBLED,
 * never written as a literal.
 *
 * 🔴 This is the whole point of the file, and it is not stylistic. The thing
 * under test scans tracked files for credential shapes. A fixture written
 * literally in its own test file becomes the scanner's first finding the moment
 * the file is committed — and then the `.husky/pre-commit` check refuses the
 * commit that adds the test, and the CI validator reports a leak that is not
 * one. Measured before this file existed: 21 self-matches across the two
 * suites, in four of the six pattern ids.
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
