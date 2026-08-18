// The CI half of AR-49(b): nothing tracked in this repository carries a
// credential, and nothing about to be committed does either.
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
 * A git command in the current working directory, with an explicit environment.
 *
 * An inherited `GIT_DIR`/`GIT_INDEX_FILE` aims this at another repository, which
 * would have it report another tree's cleanliness as this one's.
 */
const git = (args, { encoding = 'utf8' } = {}) => {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'])
    delete env[key];
  return execFileSync('git', args, { encoding, env, maxBuffer: 256 * 1024 * 1024 });
};

const zeroSeparated = (output) =>
  String(output)
    .split('\0')
    .filter((entry) => entry !== '');

const trackedFiles = () => zeroSeparated(git(['ls-files', '-z']));
const stagedFiles = () => zeroSeparated(git(['diff', '--cached', '--name-only', '-z']));

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
const indexText = (relativePath) => textOf(() => git(['show', `:${relativePath}`]));

/** Every finding in one file, path arm first. */
const findingsIn = (relativePath, text) => {
  const findings = [];
  if (isCredentialPath(relativePath)) findings.push({ id: CREDENTIAL_PATH_ID, line: null });
  if (text !== null) for (const finding of findSecretValues(text)) findings.push(finding);
  return findings;
};

const formatFinding = (relativePath, finding) =>
  finding.line === null
    ? `${relativePath} — ${finding.id}`
    : `${relativePath}:${finding.line} — ${finding.id}`;

/** The sweep, shared by both file-reading modes. */
function sweep(files, readText, label) {
  const lines = [];
  const offending = [];
  for (const relativePath of files) {
    const findings = findingsIn(relativePath, readText(relativePath));
    if (findings.length === 0) continue;
    offending.push(relativePath);
    for (const finding of findings) lines.push(formatFinding(relativePath, finding));
  }

  const listProblems = exemptionProblems({ exemptions: EXEMPTIONS, tracked: files, offending });
  for (const problem of listProblems)
    lines.push(`${problem.path} — ${problem.kind} (in this script's EXEMPTIONS list)`);

  const excused = new Set(listProblems.length === 0 ? EXEMPTIONS.map((entry) => entry.path) : []);
  const reported = lines.filter((line) => !excused.has(line.split(' — ')[0].split(':')[0]));

  if (reported.length === 0) {
    // 🔴 The clean line states the SIZE of the set it read. "Clean" and "I found
    // nothing to look at" print identically otherwise — a wrong cwd, a wrong
    // repository or a flag that stopped being supported all read as a pass.
    process.stdout.write(`clean — ${files.length} ${label} scanned, no credential found\n`);
    return 0;
  }
  process.stdout.write(
    `${reported.length} finding(s) — a credential must never be committed:\n` +
      `${reported.map((line) => `${line}\n`).join('')}` +
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
  if (argv.includes('--staged')) return sweep(stagedFiles(), indexText, 'staged file(s)');
  return sweep(trackedFiles(), worktreeText, 'tracked file(s)');
}

// Importable without side effects: the exemption tests import this module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
