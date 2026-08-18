import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { ATLASSIAN_TOKEN, CLOUD_ACCESS_KEY } from './secrets-fixtures.js';

// AR-49(b), layer 2: the CI half of the "both layers, one shared module" ruling.
//
// Layer 1 shipped the vocabulary (`.claude/scripts/lib/secrets.mjs`) and the
// PreToolUse guard that reads it. A PreToolUse hook only ever sees what an AGENT
// writes through a tool — it is blind to a human's editor, to a `git apply`, to
// anything already sitting in the tree before the hook existed. This is the
// sweep that answers for the tree as a whole: every tracked file, on every CI
// run, plus the staged set on every commit by any author.
//
// 🔴 Every credential-shaped string in this file is ASSEMBLED, never literal —
// `./secrets-fixtures.js`. The subject of these tests scans every tracked file
// of the repository it runs in, and this file is one of them: a literal fixture
// here would make the validator's first finding be its own test suite, and the
// pre-commit half would then refuse the commit that adds it. That is the
// measured lesson `secrets-fixtures.ts` carries in its header, and it is the
// reason this file imports rather than types.

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const validator = path.join(repoRoot, 'scripts', 'validate-no-secrets.mjs');

/**
 * The vocabulary module, read from the SYNCED copy under `.claude/`.
 *
 * Deliberately not the `templates/agent-os/…` original that `secrets-lib.test.ts`
 * loads: `scripts/validate-no-secrets.mjs` lives in this repository's own root
 * and imports the synced copy, so the source of truth for "what would the
 * validator see" is the file the validator itself resolves. The drift test in
 * dogfood.test.ts is what keeps the two identical; nothing here re-tests that.
 */
const secretsLib = path.join(repoRoot, '.claude', 'scripts', 'lib', 'secrets.mjs');

interface Finding {
  id: string;
  line: number;
}

interface SecretsModule {
  SECRET_VALUE_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp }>;
  findSecretValues(text: string, options?: { limit?: number }): Finding[];
}

const loadSecretsLib = async (): Promise<SecretsModule> =>
  (await import(pathToFileURL(secretsLib).href)) as unknown as SecretsModule;

/** One entry of the validator's own exemption list. */
interface Exemption {
  path: string;
  reason: string;
}

/** A complaint the validator makes about its OWN list, rather than about a file. */
interface ExemptionProblem {
  kind: string;
  path: string;
}

interface ValidatorModule {
  EXEMPTIONS: ReadonlyArray<Exemption>;
  exemptionProblems(input: {
    exemptions: ReadonlyArray<Partial<Exemption>>;
    tracked: readonly string[];
    offending: readonly string[];
  }): ExemptionProblem[];
}

// The validator ships as plain .mjs with no declarations — the same reason
// dogfood.test.ts and gate-scripts.test.ts import their subjects by file URL.
// Imported lazily inside each case so a missing module fails the case that
// needed it, with the module path in the message, rather than the whole file.
const loadValidator = async (): Promise<ValidatorModule> =>
  (await import(pathToFileURL(validator).href)) as unknown as ValidatorModule;

/**
 * Every git spawn below takes an explicit environment.
 *
 * Not defensiveness: an inherited `GIT_DIR`/`GIT_INDEX_FILE` aims `git init`,
 * `git add` and `git commit` at ANOTHER repository, which in this repo has
 * already produced junk commits on two branches and one repository flipped to
 * bare (git-env.test.ts). A suite that builds a throwaway repo per case is the
 * exact shape that defect likes.
 */
const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(repoRoot, 'templates/agent-os/universal/.claude/scripts/preflight.mjs'))
    .href
)) as { withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };

const temporaryDirs: string[] = [];

afterAll(async () => {
  for (const dir of temporaryDirs) await rm(dir, { recursive: true, force: true });
});

/**
 * `-c core.excludesFile=/dev/null`: a developer's global excludesfile commonly
 * carries `*.env` and `*.pem`, and `git add` REFUSES an ignored path. Without
 * this the `jira.env` case would fail on one machine and pass in CI, blaming the
 * validator for a machine's ignore rules.
 */
const git = (dir: string, args: string[]) =>
  exec('git', ['-c', 'core.excludesFile=/dev/null', ...args], {
    cwd: dir,
    env: withoutGitLocation(),
  });

/** A throwaway repository the assertions are about — never this one. */
async function temporaryRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'validate-no-secrets-'));
  temporaryDirs.push(dir);
  await git(dir, ['init', '-q']);
  return dir;
}

const put = async (dir: string, relative: string, content: string): Promise<void> => {
  const file = path.join(dir, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

/** An initial commit, so `git diff --cached` has a HEAD to compare against. */
const commitAll = (dir: string) =>
  git(dir, [
    '-c',
    'user.email=nobody@example.invalid',
    '-c',
    'user.name=nobody',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'seed',
  ]);

interface Run {
  code: number;
  out: string;
}

const run = (dir: string, args: string[] = []): Promise<Run> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [validator, ...args],
      // The validator spawns git itself; it is the subject's job to sanitise
      // that, but a test that handed it a poisoned environment could not tell
      // a real failure from its own.
      { cwd: dir, env: withoutGitLocation(), maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          out: stdout + stderr,
        });
      },
    );
  });

describe('validate-no-secrets — the default sweep over the tracked set', () => {
  it('exits 0 and says it looked, on a repository with nothing to find', async () => {
    const dir = await temporaryRepo();
    await put(dir, 'src/index.ts', 'export const greet = () => "hello";\n');
    await put(dir, 'README.md', '# a project\n');
    await git(dir, ['add', '--', 'src/index.ts', 'README.md']);

    const result = await run(dir);
    expect(result.code, result.out).toBe(0);
    // "clean" has to be distinguishable from "found nothing to look at": a sweep
    // whose `git ls-files` returned nothing — wrong cwd, wrong repository, a
    // flag that stopped being supported — prints exactly what a clean tree
    // prints. So the clean line states the size of the set it read.
    expect(result.out).toMatch(/\b2 tracked\b/i);
  }, 20_000);

  it('refuses a tracked file carrying a credential value, naming path, line and pattern', async () => {
    const dir = await temporaryRepo();
    await put(
      dir,
      'src/config.ts',
      [
        '// configuration',
        '',
        `const key = "${CLOUD_ACCESS_KEY}";`,
        'export default key;',
        '',
      ].join('\n'),
    );
    await git(dir, ['add', '--', 'src/config.ts']);

    const result = await run(dir);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/^src\/config\.ts:3 — cloud-access-key$/m);
  }, 20_000);

  it('never prints the credential it found, nor a fragment of it', async () => {
    const dir = await temporaryRepo();
    await put(dir, 'notes.md', `deploy key: ${CLOUD_ACCESS_KEY}\n`);
    await git(dir, ['add', '--', 'notes.md']);

    const result = await run(dir);
    // 🔴 The finding is asserted FIRST, and it is not decoration. A `not.toContain`
    // pair passes against any output at all — including a crash, an empty stdout,
    // or a validator that scanned nothing. Measured while writing this file: with
    // the script absent, the two absence assertions alone went green. So the
    // refusal has to be pinned before the silence is.
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/^notes\.md:1 — cloud-access-key$/m);
    // A validator that echoes what it matched has copied the credential into a
    // CI log, a terminal scrollback and an artifact — it has leaked the secret
    // in the act of refusing it. The prefix check is the half that matters: a
    // "helpful" truncated preview is the form this regression actually takes.
    expect(result.out).not.toContain(CLOUD_ACCESS_KEY);
    expect(result.out).not.toContain(CLOUD_ACCESS_KEY.slice(0, 12));
  }, 20_000);

  it('leaves an untracked file alone, however loudly it carries a credential', async () => {
    const dir = await temporaryRepo();
    await put(dir, 'src/index.ts', 'export const greet = () => "hello";\n');
    await git(dir, ['add', '--', 'src/index.ts']);
    // never `git add`ed: it is not in the history and cannot leak through it,
    // and a sweep that read the whole working tree would fire on every local
    // scratch file and get routed around within the week.
    await put(dir, 'scratch.txt', `${CLOUD_ACCESS_KEY}\n`);

    const result = await run(dir);
    expect(result.code, result.out).toBe(0);
    expect(result.out).not.toContain('scratch.txt');
  }, 20_000);

  // `invariants.md`: the test is not "is it fast enough on realistic input" but
  // "can any input make it do unbounded work at all". A CI validator that hangs
  // is a CI validator someone removes from the pipeline.
  it('finishes on a five-megabyte tracked file instead of hanging on it', async () => {
    const dir = await temporaryRepo();
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit\n'.repeat(100_000);
    expect(filler.length).toBeGreaterThan(5_000_000);
    await put(dir, 'data/blob.txt', filler);
    await git(dir, ['add', '--', 'data/blob.txt']);

    const started = Date.now();
    const result = await run(dir);
    const elapsed = Date.now() - started;

    expect(result.code, result.out).toBe(0);
    expect(elapsed, `took ${elapsed}ms on 5 MB of harmless text`).toBeLessThan(20_000);
  }, 60_000);
});

describe('validate-no-secrets --staged — the half a pre-commit hook runs', () => {
  it('refuses a staged credential value', async () => {
    const dir = await temporaryRepo();
    await put(dir, 'seed.txt', 'seed\n');
    await git(dir, ['add', '--', 'seed.txt']);
    await commitAll(dir);

    await put(dir, 'deploy/notes.md', `token: ${ATLASSIAN_TOKEN}\n`);
    await git(dir, ['add', '--', 'deploy/notes.md']);

    const result = await run(dir, ['--staged']);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/^deploy\/notes\.md:1 — atlassian-token$/m);
    expect(result.out).not.toContain(ATLASSIAN_TOKEN);
  }, 20_000);

  it('refuses a staged credential FILENAME even when its content is innocuous', async () => {
    const dir = await temporaryRepo();
    await put(dir, 'seed.txt', 'seed\n');
    await git(dir, ['add', '--', 'seed.txt']);
    await commitAll(dir);

    // Nothing in this file matches a value pattern — the refusal has to come
    // from `isCredentialPath`. This is the arm `.gitignore` deliberately cannot
    // close (AR-49 a): an ignore rule over `secrets/` hides legitimate source,
    // so the commit is refused instead of the tree being hidden.
    await put(dir, 'jira.env', 'nothing interesting here\n');
    await git(dir, ['add', '--', 'jira.env']);

    const result = await run(dir, ['--staged']);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/^jira\.env(?::\d+)? — credential-path$/m);
  }, 20_000);

  it('reads the staged content from the index, not from the working tree', async () => {
    const dir = await temporaryRepo();
    await put(dir, 'seed.txt', 'seed\n');
    await git(dir, ['add', '--', 'seed.txt']);
    await commitAll(dir);

    await put(dir, 'notes.md', 'nothing here yet\n');
    await git(dir, ['add', '--', 'notes.md']);
    // The path IS in the staged set, so this case is not vacuous: the file gets
    // read either way, and only the SOURCE of the bytes decides the verdict.
    // A commit is not the moment to refuse work a developer has not offered.
    await put(dir, 'notes.md', `nothing here yet\n${CLOUD_ACCESS_KEY}\n`);

    const result = await run(dir, ['--staged']);
    expect(result.code, result.out).toBe(0);
  }, 20_000);
});

describe('validate-no-secrets --self-test — proving the scanner still detects', () => {
  it('exits 0 when every built-in shape is still detected', async () => {
    const dir = await temporaryRepo();
    const result = await run(dir, ['--self-test']);
    expect(result.code, result.out).toBe(0);
  }, 20_000);

  it('names every pattern the vocabulary defines, so a new shape gets no free pass', async () => {
    const dir = await temporaryRepo();
    const { SECRET_VALUE_PATTERNS } = await loadSecretsLib();
    expect(
      SECRET_VALUE_PATTERNS.length,
      'the vocabulary must have patterns to cover',
    ).toBeGreaterThan(0);

    const result = await run(dir, ['--self-test']);
    expect(
      result.code,
      `the self-test must have RUN before its report is read\n${result.out}`,
    ).toBe(0);
    // A self-test that covers four of six shapes reports "the scanner works"
    // while two patterns have quietly stopped matching — which is the exact
    // failure mode this mode exists to make impossible.
    for (const { id } of SECRET_VALUE_PATTERNS) expect(result.out).toContain(id);
  }, 20_000);
});

describe('validate-no-secrets — the validator is not its own first finding', () => {
  it('carries no literal credential in its own source', async () => {
    const { findSecretValues } = await loadSecretsLib();
    const source = await readFile(validator, 'utf8');
    // The `--self-test` fixtures live in this file and must be assembled at run
    // time for the same reason `secrets-fixtures.ts` assembles its own: a
    // literal shape here makes the default sweep report its own scanner.
    expect(findSecretValues(source)).toEqual([]);
  });
});

describe('validate-no-secrets — the exemption list answers for itself', () => {
  it('ships empty', async () => {
    const { EXEMPTIONS } = await loadValidator();
    // Empty is a state a reader can verify at a glance; a populated list is a
    // set of claims nobody re-checks. Nothing needs excusing today because the
    // suites that carry synthetic credentials ASSEMBLE them — see
    // secrets-fixtures.ts — so the honest state of this list is zero entries.
    expect(EXEMPTIONS).toEqual([]);
  });

  it('gives every entry a reason', async () => {
    const { EXEMPTIONS } = await loadValidator();
    // Written over the list rather than as a second `toEqual([])`: it is
    // vacuous today on purpose, and it becomes the real assertion the day
    // somebody adds an entry.
    const unexplained = EXEMPTIONS.filter(
      (entry) => typeof entry.reason !== 'string' || entry.reason.trim() === '',
    ).map((entry) => entry.path);
    expect(unexplained).toEqual([]);
  });

  it('refuses an entry that carries no reason, complaining about its own list', async () => {
    const { exemptionProblems } = await loadValidator();
    const problems = exemptionProblems({
      exemptions: [{ path: 'fixtures/sample.env' }],
      tracked: ['fixtures/sample.env'],
      offending: ['fixtures/sample.env'],
    });
    // An unexplained exemption is indistinguishable from a real leak someone
    // silenced. Honouring it silently is the failure; naming it is the fix.
    expect(problems.map((problem) => problem.kind)).toContain('exemption-without-reason');
    expect(problems.map((problem) => problem.path)).toContain('fixtures/sample.env');
  });

  it('reports an exemption naming a path that is not tracked', async () => {
    const { exemptionProblems } = await loadValidator();
    const problems = exemptionProblems({
      exemptions: [{ path: 'fixtures/deleted.env', reason: 'a fixture that used to exist' }],
      tracked: ['src/index.ts'],
      offending: [],
    });
    expect(problems.map((problem) => problem.kind)).toContain('exemption-not-tracked');
  });

  it('reports an exemption whose path no longer produces any finding', async () => {
    const { exemptionProblems } = await loadValidator();
    const problems = exemptionProblems({
      exemptions: [{ path: 'fixtures/sample.env', reason: 'a documented placeholder' }],
      tracked: ['fixtures/sample.env'],
      offending: [],
    });
    // A permanent exemption that stopped being needed is how a list decays into
    // standing cover for the next real leak that lands on that path.
    expect(problems.map((problem) => problem.kind)).toContain('exemption-no-longer-needed');
  });

  it('leaves an exemption that is tracked, explained and still needed alone', async () => {
    const { exemptionProblems } = await loadValidator();
    const problems = exemptionProblems({
      exemptions: [{ path: 'fixtures/sample.env', reason: 'a documented placeholder' }],
      tracked: ['fixtures/sample.env'],
      offending: ['fixtures/sample.env'],
    });
    // The negative half: a rule that also fires on the compliant form is a rule
    // that gets routed around.
    expect(problems).toEqual([]);
  });
});

// A check nothing calls is a wish. These three pin the call sites — the commit
// path, the CI path, and the declaration that makes an edit to the commit path
// visible to the gate sweep.
describe('validate-no-secrets is wired into the paths that run it', () => {
  it('runs on every commit, through .husky/pre-commit', async () => {
    const hook = await readFile(path.join(repoRoot, '.husky', 'pre-commit'), 'utf8');
    // The one gate a PreToolUse hook cannot cover: a human editing a file in an
    // editor never reaches one.
    expect(hook).toMatch(/node scripts\/validate-no-secrets\.mjs --staged/);
  });

  it('runs on every CI run, as a step of the main job', async () => {
    const workflow = await readFile(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    const lines = workflow.split('\n');
    const start = lines.findIndex((line) => line === '  ci:');
    expect(start, 'no `ci` job in the workflow — the block below would be vacuous').toBeGreaterThan(
      -1,
    );
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^ {2}\S/.test(line));
    const job = (end === -1 ? rest : rest.slice(0, end)).join('\n');
    expect(job).toMatch(/node scripts\/validate-no-secrets\.mjs/);
  });

  // The gate sweep reads the declared block and nothing else, so a merge that
  // emptied `.husky/pre-commit` would be invisible to it while the directory
  // went undeclared. Parsed the way the sweep parses it — a regex of this
  // file's own would drift from the thing that actually decides.
  it('declares .husky/ as an elevated path, so an edit to the hook is gated', async () => {
    const { parseElevatedPaths } = (await import(
      pathToFileURL(
        path.join(repoRoot, 'templates/agent-os/universal/.claude/scripts/detect-missed-gate.mjs'),
      ).href
    )) as { parseElevatedPaths: (md: string) => string[] | null };
    const claudeMd = await readFile(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
    const declared = parseElevatedPaths(claudeMd);
    expect(declared).not.toBeNull();
    expect(declared).toContain('.husky/');
  });
});
