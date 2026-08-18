// The CI half of AR-49(b): the sweep that looks for a credential in everything
// this repository tracks, and in everything about to be committed.
//
// Deliberately phrased as what it LOOKS AT rather than as what it guarantees.
// The limits block below says what it cannot see, and a guarantee written above
// it would be read instead of it.
//
// Three modes, one vocabulary:
//
//   node scripts/validate-no-secrets.mjs             every TRACKED file (CI)
//   node scripts/validate-no-secrets.mjs --staged    only what is STAGED (pre-commit)
//   node scripts/validate-no-secrets.mjs --self-test the scanner still detects
//
// The vocabulary is `.claude/scripts/lib/secrets.mjs` — the same module
// `guard-secret-file` reads and the same one `dogfood.test.ts` derives the
// ignore blocks from. `.claude/rules/invariants.md`: one mechanism, one
// implementation. Three lists would disagree, and the copy nobody runs is the
// one that is wrong.
//
// 🔴 IT NEVER PRINTS WHAT IT FOUND. A validator that quotes the credential has
// copied it into a CI log, a PR check annotation and a terminal scrollback — it
// has leaked the secret in the act of reporting it. Every line below is
// `path:line — pattern-id`.
//
// 🔴 AND IT NEVER WRITES ITS OWN FIXTURES OUT. `--self-test` assembles every
// shape at run time, for the same reason `test/template/secrets-fixtures.ts`
// does: a credential-shaped literal in this file makes the default sweep report
// its own scanner, on the day this file is tracked. That this file is clean by
// its own definition is asserted rather than asserted-in-prose: see
// validate-no-secrets.test.ts › "carries no literal credential in its own
// source".
//
// 🔴 LIMITS — what this sweep cannot see. `.claude/rules/invariants.md` asks for
// these in the file, next to the guarantee, because the `clean` line is where a
// reader forms their belief. Each is pinned by a test:
//
//   - A BINARY file is not scanned at all. Any file containing a NUL byte is
//     skipped, and the summary counts it separately rather than reporting it as
//     scanned — see validate-no-secrets.test.ts › "reports the files it could
//     not read, instead of counting them as scanned". A credential inside a
//     binary blob is invisible here.
//   - An UNREADABLE file is the same case and is counted the same way.
//   - It reads the TRACKED set (or the STAGED set). A credential in a file git
//     does not track is out of scope on purpose — a local `.env` is the point of
//     `.gitignore` — see › "leaves an untracked file alone, however loudly it
//     carries a credential".
//   - It is a text scan over known shapes, not an entropy analyser. What the
//     shapes do and do not match is `secrets.mjs`'s own limits block.
//
// The 2 MB bound `findSecretValues` applies by default is deliberately NOT one
// of them: that cap exists so a FAIL-OPEN hook cannot be made to hang, and this
// sweep fails closed. It reads whole files — see › "finds a credential past the
// two-megabyte mark the hook stops at".
//
// 🔴 WHY `--self-test` EXISTS AT ALL. A scanner that has silently stopped
// matching reports a clean tree forever, and a clean tree is exactly what
// everyone expects to see — the failure is invisible by construction. So the
// mode asserts each pattern still fires on a shape built for it, and names every
// id the vocabulary defines, so a pattern added without a fixture fails rather
// than riding along uncovered.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { findSecretValues, isCredentialPath, SECRET_VALUE_PATTERNS } = await import(
  pathToFileURL(path.join(here, '..', '.claude', 'scripts', 'lib', 'secrets.mjs')).href
);

/** The id a finding carries when the PATH is the problem, not the content. */
const CREDENTIAL_PATH_ID = 'credential-path';

/**
 * Files excused from the sweep, each with the reason it is excused.
 *
 * 🔴 It ships EMPTY, and that is a property worth defending rather than a
 * placeholder. The suites that need synthetic credentials assemble them at run
 * time, so nothing here needs excusing. An empty list is a state a reader can
 * verify at a glance; a populated one asks them to trust a reason they cannot
 * check, and is indistinguishable from a real leak somebody silenced.
 *
 * Before adding one, try assembly — it needs no entry, no reason and no upkeep.
 */
export const EXEMPTIONS = [];

/**
 * What is wrong with the exemption list itself, as findings about the list.
 *
 * A stale exemption is the failure this guards: an entry outlives the file it
 * excused, and then stands as permanent cover for whatever lands on that path
 * next. So the list is checked against reality every run — three ways.
 */
export function exemptionProblems({ exemptions = [], tracked = [], offending = [] } = {}) {
  const trackedSet = new Set(tracked);
  const offendingSet = new Set(offending);
  const problems = [];
  for (const entry of exemptions) {
    const entryPath = String(entry?.path ?? '');
    if (String(entry?.reason ?? '').trim() === '')
      problems.push({ kind: 'exemption-without-reason', path: entryPath });
    if (!trackedSet.has(entryPath))
      problems.push({ kind: 'exemption-not-tracked', path: entryPath });
    else if (!offendingSet.has(entryPath))
      problems.push({ kind: 'exemption-no-longer-needed', path: entryPath });
  }
  return problems;
}

/**
 * A git command in the current working directory.
 *
 * 🔴 THE ENVIRONMENT DEPENDS ON WHO IS ASKING, and getting this wrong was a
 * total bypass of the pre-commit layer.
 *
 * A standalone run (CI) must not inherit `GIT_DIR`/`GIT_INDEX_FILE` from
 * whatever spawned it: those aim git at another repository, and the sweep would
 * report that tree's cleanliness as this one's.
 *
 * A `--staged` run is the opposite case. It is git's own child — the `pre-commit`
 * hook — and during `git commit -a` git builds a TEMPORARY index holding exactly
 * the changes being committed and points `GIT_INDEX_FILE` at it. Stripping that
 * makes `git diff --cached` read `.git/index`, which has none of them: the sweep
 * then reports `0 staged file(s)` and the commit sails through. Measured, with a
 * real commit carrying a real key shape. So in that mode git's own environment
 * is authoritative and is left alone — see validate-no-secrets.test.ts ›
 * "refuses a credential committed with `git commit -am`, not only one that was
 * `git add`ed".
 */
const git = (args, { inheritLocation = false, encoding = 'utf8' } = {}) => {
  const env = { ...process.env };
  if (!inheritLocation)
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'])
      delete env[key];
  return execFileSync('git', args, {
    encoding,
    env,
    maxBuffer: 256 * 1024 * 1024,
    // git's own diagnostics are not this tool's report; a raw `fatal:` line in
    // pre-commit output reads as a crash in the guard.
    stdio: ['ignore', 'pipe', 'ignore'],
  });
};

const zeroSeparated = (output) =>
  String(output)
    .split('\0')
    .filter((entry) => entry !== '');

const trackedFiles = () => zeroSeparated(git(['ls-files', '-z']));

// `--diff-filter=d` drops DELETIONS. Without it the path arm fires on the very
// commit that removes a credential file — the guard refusing the remediation its
// own message prescribes, with `--no-verify` hook-blocked, leaving the author
// nothing but to route around the guard. See validate-no-secrets.test.ts › "lets
// the commit that REMOVES a credential file through".
const stagedFiles = () =>
  zeroSeparated(
    git(['diff', '--cached', '--name-only', '--diff-filter=d', '-z'], { inheritLocation: true }),
  );

/** Text of a file, or `null` when it is binary or unreadable — never a throw. */
const textOf = (read) => {
  try {
    const text = read();
    // A NUL byte means binary; scanning it finds nothing and costs the read.
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
};

const worktreeText = (relativePath) =>
  textOf(() => readFileSync(path.join(process.cwd(), relativePath), 'utf8'));

// 🔴 From the INDEX, not the worktree. `--staged` answers "what would this
// commit contain", and a file edited after `git add` differs from what is
// staged — reading the worktree would refuse a commit over text nobody is
// committing, or wave through text nobody has on disk.
const indexText = (relativePath) =>
  textOf(() => git(['show', `:${relativePath}`], { inheritLocation: true }));

/**
 * The whole file, not the first two megabytes.
 *
 * `findSecretValues` defaults to a 2 MB cap so a FAIL-OPEN hook cannot be made
 * to hang by a crafted payload. This sweep fails closed and runs in CI, where a
 * truncated read is a blind spot reported as `clean`. So the cap is lifted here,
 * deliberately and in one place.
 */
const NO_SCAN_LIMIT = Number.MAX_SAFE_INTEGER;

/** Every finding in one file, path arm first, as data rather than as text. */
const findingsIn = (relativePath, text) => {
  const findings = [];
  if (isCredentialPath(relativePath))
    findings.push({ path: relativePath, id: CREDENTIAL_PATH_ID, line: null });
  if (text !== null)
    for (const finding of findSecretValues(text, { limit: NO_SCAN_LIMIT }))
      findings.push({ path: relativePath, id: finding.id, line: finding.line });
  return findings;
};

const formatFinding = (finding) =>
  finding.line === null
    ? `${finding.path} — ${finding.id}`
    : `${finding.path}:${finding.line} — ${finding.id}`;

/**
 * The sweep, shared by both file-reading modes.
 *
 * 🔴 Findings stay STRUCTURED until the last moment. An earlier version excused
 * a file by re-parsing its own formatted line back into a path, which truncated
 * any path containing `:` — under-excusing the intended file and over-excusing
 * its siblings at once. A value that has been rendered for a human is not a
 * value to compute with.
 */
export function sweep(files, readText, label, { tracked = files, exemptions = EXEMPTIONS } = {}) {
  const findings = [];
  let unread = 0;
  for (const relativePath of files) {
    const text = readText(relativePath);
    if (text === null) unread += 1;
    findings.push(...findingsIn(relativePath, text));
  }

  const offending = [...new Set(findings.map((finding) => finding.path))];
  // 🔴 Checked against the TRACKED set, never against the set just scanned. In
  // `--staged` mode those differ, and feeding the staged set here made a valid
  // exemption for any file not in this commit report `exemption-not-tracked` —
  // so the first exemption anyone added bricked every subsequent commit.
  const listProblems = exemptionProblems({ exemptions, tracked, offending });

  // 🔴 All-or-nothing, and deliberately so: one unusable entry suspends EVERY
  // excusal rather than honouring the rest. The direction is fail-closed — a
  // list that cannot be trusted excuses nothing — and it is surprising enough
  // that it is pinned by test rather than left to be rediscovered: see
  // validate-no-secrets.test.ts › "suspends every excusal while one entry is
  // unusable, rather than honouring the rest".
  const excused = new Set(listProblems.length === 0 ? exemptions.map((entry) => entry.path) : []);
  const lines = [
    ...findings.filter((finding) => !excused.has(finding.path)).map(formatFinding),
    ...listProblems.map(
      (problem) => `${problem.path} — ${problem.kind} (in this script's EXEMPTIONS list)`,
    ),
  ];

  const counted = `${files.length} ${label} scanned${unread > 0 ? `, ${unread} unread` : ''}`;
  if (lines.length === 0) {
    // 🔴 The clean line states the SIZE of the set it read, and how much of it
    // it could not open. "Clean", "I found nothing to look at" and "I counted
    // files I never opened" print identically otherwise — and a wrong cwd, a
    // wrong repository or a tree of binaries all land in one of the last two.
    process.stdout.write(`clean — ${counted}, no credential found\n`);
    return 0;
  }
  process.stdout.write(
    `${lines.length} finding(s) — a credential must never be committed (${counted}):\n` +
      `${lines.map((line) => `${line}\n`).join('')}` +
      'The matched values are deliberately not printed. Open the lines above.\n',
  );
  return 1;
}

/**
 * Proof that each pattern still fires, on a shape assembled here rather than
 * written out. Assembly is the whole technique: a literal below would be found
 * by the default sweep the moment this file is tracked.
 */
function selfTest() {
  const join = (...parts) => parts.join('');
  const fixtures = {
    'atlassian-token': join('ATATT', '3xFfGF0T4Ph9Kx2Qm7Zb3Rv8Nc1Ld5Gj6Ws0Ey4Ui'),
    'github-pat': join('ghp', '_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'),
    'cloud-access-key': join('AKIA', 'ABCDEFGHIJKLMNOP'),
    'anthropic-key': join('sk-ant', '-api03-Zq9Wx7Lv2Kd4Nb8Mc1Pf6Rt3Hy5Ug0Jn'),
    'private-key-block': join('-----BEGIN ', 'RSA ', 'PRIVATE', ' KEY-----'),
    'assigned-secret': join('JIRA_API_TOKEN=', 'zK3mQ7vR1nT9bX5dW2sL8pF4'),
  };

  const missing = [];
  for (const { id } of SECRET_VALUE_PATTERNS) {
    const fixture = fixtures[id];
    // A pattern with no fixture is not "probably fine" — it is a shape nothing
    // proves still matches, which is the state this mode exists to refuse.
    if (fixture === undefined) {
      missing.push(`${id} — no fixture covers this pattern`);
      continue;
    }
    const found = findSecretValues(fixture).some((finding) => finding.id === id);
    if (!found) missing.push(`${id} — stopped matching its own fixture`);
  }

  const covered = SECRET_VALUE_PATTERNS.map(({ id }) => id);
  if (missing.length === 0) {
    process.stdout.write(`self-test passed — every shape still detected: ${covered.join(', ')}\n`);
    return 0;
  }
  process.stdout.write(
    `self-test FAILED — the scanner is not detecting what it claims:\n` +
      `${missing.map((line) => `  - ${line}\n`).join('')}` +
      `covered ids: ${covered.join(', ')}\n`,
  );
  return 1;
}

export function main(argv = []) {
  if (argv.includes('--self-test')) return selfTest();
  if (argv.includes('--staged'))
    return sweep(stagedFiles(), indexText, 'staged file(s)', { tracked: trackedFiles() });
  return sweep(trackedFiles(), worktreeText, 'tracked file(s)');
}

// Importable without side effects: the exemption tests import this module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
