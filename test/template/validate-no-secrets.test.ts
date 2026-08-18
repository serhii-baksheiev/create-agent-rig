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
  /** The ONE finding id this entry excuses — never the whole path. */
  id: string;
  reason: string;
}

/** A complaint the validator makes about its OWN list, rather than about a file. */
interface ExemptionProblem {
  kind: string;
  path: string;
}

interface ValidatorModule {
  EXEMPTIONS: ReadonlyArray<Exemption>;
  sweep(
    files: readonly string[],
    readText: (relativePath: string) => string | null,
    label: string,
    options?: {
      tracked?: readonly string[];
      exemptions?: ReadonlyArray<Partial<Exemption>>;
      /** Off in `--staged`: a commit cannot see the tree the list is about. */
      auditList?: boolean;
    },
  ): number;
  exemptionProblems(input: {
    exemptions: ReadonlyArray<Partial<Exemption>>;
    tracked: readonly string[];
    /** Findings, always `{ path, id }` — the key an exemption is matched on. */
    offending: ReadonlyArray<{ path: string; id: string }>;
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
      exemptions: [{ path: 'fixtures/sample.env', id: 'credential-path' }],
      tracked: ['fixtures/sample.env'],
      offending: [{ path: 'fixtures/sample.env', id: 'credential-path' }],
    });
    // An unexplained exemption is indistinguishable from a real leak someone
    // silenced. Honouring it silently is the failure; naming it is the fix.
    expect(problems.map((problem) => problem.kind)).toContain('exemption-without-reason');
    expect(problems.map((problem) => problem.path)).toContain('fixtures/sample.env');
  });

  it('refuses an entry that names no finding id, complaining about its own list', async () => {
    const { exemptionProblems } = await loadValidator();
    const problems = exemptionProblems({
      exemptions: [{ path: 'fixtures/sample.env', reason: 'a documented placeholder' }],
      tracked: ['fixtures/sample.env'],
      offending: [{ path: 'fixtures/sample.env', id: 'credential-path' }],
    });
    // An entry with no id cannot say WHAT it excuses, so honouring it would be
    // the blanket-per-path licence the {path, id} key exists to remove.
    expect(problems.map((problem) => problem.kind)).toContain('exemption-without-id');
  });

  it('reports an exemption naming a path that is not tracked', async () => {
    const { exemptionProblems } = await loadValidator();
    const problems = exemptionProblems({
      exemptions: [
        {
          path: 'fixtures/deleted.env',
          id: 'credential-path',
          reason: 'a fixture that used to exist',
        },
      ],
      tracked: ['src/index.ts'],
      offending: [],
    });
    expect(problems.map((problem) => problem.kind)).toContain('exemption-not-tracked');
  });

  it('reports an exemption whose path no longer produces any finding', async () => {
    const { exemptionProblems } = await loadValidator();
    const problems = exemptionProblems({
      exemptions: [
        { path: 'fixtures/sample.env', id: 'credential-path', reason: 'a documented placeholder' },
      ],
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
      exemptions: [
        { path: 'fixtures/sample.env', id: 'credential-path', reason: 'a documented placeholder' },
      ],
      tracked: ['fixtures/sample.env'],
      offending: [{ path: 'fixtures/sample.env', id: 'credential-path' }],
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

// ─────────────────────────────────────────────────────────────────────────────
// Round-2 gate findings.
//
// 🔴 The first block below exists because every `--staged` case above runs the
// validator STANDALONE, after an explicit `git add`. That is not the situation
// the layer is for. `security-scanner` drove a real `git commit` through a real
// hook and found the guard absent from the most ordinary idiom there is, and no
// test here could have noticed. So these drive `git`, not the script.

/** A real `pre-commit` hook in a throwaway repo, running the real validator. */
const installPreCommitHook = async (dir: string): Promise<void> => {
  const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
  await mkdir(path.dirname(hook), { recursive: true });
  await writeFile(hook, `#!/bin/sh\nexec "${process.execPath}" "${validator}" --staged\n`, {
    mode: 0o755,
  });
};

/** A commit attempt that reports whether it landed, rather than throwing. */
const tryCommit = async (dir: string, args: string[]): Promise<{ ok: boolean; out: string }> => {
  const before = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
  let out;
  try {
    const result = await git(dir, [
      '-c',
      'user.email=nobody@example.invalid',
      '-c',
      'user.name=nobody',
      '-c',
      'commit.gpgsign=false',
      'commit',
      ...args,
    ]);
    out = result.stdout + result.stderr;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    out = (failure.stdout ?? '') + (failure.stderr ?? '');
  }
  const after = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
  return { ok: before !== after, out };
};

describe('validate-no-secrets --staged — driven by git, the way a commit actually runs it', () => {
  const seeded = async (): Promise<string> => {
    const dir = await temporaryRepo();
    await put(dir, 'src/config.ts', 'export const port = 8080;\n');
    await git(dir, ['add', '--', 'src/config.ts']);
    await commitAll(dir);
    await installPreCommitHook(dir);
    return dir;
  };

  // 🔴 THE ONE THAT MATTERED. During `git commit -a`, git builds a TEMPORARY
  // index holding exactly the changes being committed and points
  // GIT_INDEX_FILE at it before running this hook. A sweep that strips that
  // variable reads `.git/index` instead — which has none of them — and reports
  // `0 staged file(s) scanned` on its way to letting the commit through.
  it('refuses a credential committed with `git commit -am`, not only one that was `git add`ed', async () => {
    const dir = await seeded();
    await put(dir, 'src/config.ts', `export const key = "${CLOUD_ACCESS_KEY}";\n`);

    const { ok, out } = await tryCommit(dir, ['-a', '-m', 'sneak']);
    expect(ok, `the commit landed and should not have\n${out}`).toBe(false);
  }, 30_000);

  it('still refuses the same credential when it was staged with `git add` first', async () => {
    const dir = await seeded();
    await put(dir, 'src/config.ts', `export const key = "${CLOUD_ACCESS_KEY}";\n`);
    await git(dir, ['add', '--', 'src/config.ts']);

    const { ok, out } = await tryCommit(dir, ['-m', 'sneak']);
    expect(ok, `the commit landed and should not have\n${out}`).toBe(false);
  }, 30_000);

  // The direction that decides whether anyone keeps the hook installed.
  it('lets an honest `git commit -am` through', async () => {
    const dir = await seeded();
    await put(dir, 'src/config.ts', 'export const port = 9090;\n');

    const { ok, out } = await tryCommit(dir, ['-a', '-m', 'honest']);
    expect(ok, `an honest commit was refused\n${out}`).toBe(true);
  }, 30_000);

  // A guard whose refusal says "this repository never carries one" must not
  // then block the only clean way to act on it. `git diff --cached` lists
  // deletions; running the path arm over them refuses the remediation.
  it('lets the commit that REMOVES a credential file through', async () => {
    const dir = await temporaryRepo();
    await put(dir, 'jira.env', 'TOKEN=placeholder\n');
    await put(dir, 'README.md', '# repo\n');
    await git(dir, ['add', '-f', '--', 'jira.env', 'README.md']);
    await commitAll(dir);
    await git(dir, ['rm', '-q', '--', 'jira.env']);

    const result = await run(dir, ['--staged']);
    expect(result.code, result.out).toBe(0);
    expect(result.out).not.toMatch(/credential-path/);
    // and no raw git plumbing error reaches the author either
    expect(result.out).not.toMatch(/fatal:/);
  }, 30_000);
});

describe('validate-no-secrets — what the sweep cannot see, stated and tested', () => {
  // The hook is fail-open and owes bounded work; the CI sweep is fail-closed and
  // owes none. Inheriting the hook's 2 MB cap made a large tracked file a blind
  // spot while the summary still said "clean".
  it('finds a credential past the two-megabyte mark the hook stops at', async () => {
    const dir = await temporaryRepo();
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit\n'.repeat(60_000);
    expect(filler.length).toBeGreaterThan(3_000_000);
    await put(dir, 'data/blob.txt', `${filler}${CLOUD_ACCESS_KEY}\n`);
    await git(dir, ['add', '--', 'data/blob.txt']);

    const result = await run(dir);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toMatch(/^data\/blob\.txt:\d+ — cloud-access-key$/m);
  }, 60_000);

  // "clean" and "N scanned" were built to separate a clean tree from an empty
  // read. They did not separate either from "N counted, some never opened".
  it('reports the files it could not read, instead of counting them as scanned', async () => {
    const dir = await temporaryRepo();
    await put(dir, 'ok.txt', 'ordinary text\n');
    await put(dir, 'image.bin', 'PNG\0\0binary\0payload\n');
    await git(dir, ['add', '--', 'ok.txt', 'image.bin']);

    const result = await run(dir);
    expect(result.code, result.out).toBe(0);
    expect(result.out, 'the summary hides that a file was never opened').toMatch(
      /1 unread|1 skipped/i,
    );
  }, 20_000);

  it('states its limits in its own source, where a reader of the clean line would look', async () => {
    const source = await readFile(validator, 'utf8');
    expect(source).toMatch(/LIMITS/);
    expect(source).toMatch(/binary/i);
  });
});

// The excusal path was the part of this script nothing exercised: every
// exemption case called `exemptionProblems` directly, so the code that DECIDES
// from its answer — which findings are suppressed, and what happens when the
// list itself is unusable — ran only in production. The list ships empty, so
// these inject one rather than editing the script to make it testable.
describe('validate-no-secrets — the excusal path, with a list that is not empty', () => {
  const text = (byPath: Record<string, string>) => (relativePath: string) =>
    byPath[relativePath] ?? null;

  it('suppresses a finding on an exempt path, and only on that path', async () => {
    const { sweep } = await loadValidator();
    const files = ['fixtures/sample.txt', 'src/other.txt'];
    const code = sweep(
      files,
      text({
        'fixtures/sample.txt': `key=${CLOUD_ACCESS_KEY}`,
        'src/other.txt': 'ordinary\n',
      }),
      'file(s)',
      {
        tracked: files,
        exemptions: [
          { path: 'fixtures/sample.txt', id: 'cloud-access-key', reason: 'a documented sample' },
        ],
      },
    );
    expect(code, 'the exempt finding was not suppressed').toBe(0);
  });

  it('still reports a finding on a path the list does not name', async () => {
    const { sweep } = await loadValidator();
    const files = ['fixtures/sample.txt', 'src/other.txt'];
    const code = sweep(
      files,
      text({
        'fixtures/sample.txt': 'ordinary\n',
        'src/other.txt': `key=${CLOUD_ACCESS_KEY}`,
      }),
      'file(s)',
      {
        tracked: files,
        exemptions: [
          { path: 'fixtures/sample.txt', id: 'cloud-access-key', reason: 'a documented sample' },
        ],
      },
    );
    expect(code, 'an unexempt finding was suppressed').toBe(1);
  });

  it('suspends every excusal while one entry is unusable, rather than honouring the rest', async () => {
    const { sweep } = await loadValidator();
    const files = ['fixtures/sample.txt'];
    const code = sweep(
      files,
      text({ 'fixtures/sample.txt': `key=${CLOUD_ACCESS_KEY}` }),
      'file(s)',
      {
        tracked: files,
        exemptions: [
          { path: 'fixtures/sample.txt', id: 'cloud-access-key', reason: 'a documented sample' },
          {
            path: 'fixtures/gone.txt',
            id: 'cloud-access-key',
            reason: 'names a path nobody tracks',
          },
        ],
      },
    );
    // Fail-closed: a list carrying a stale entry cannot be trusted to excuse
    // anything, so the good entry stops applying too.
    expect(code).toBe(1);
  });

  // 🔴 The reason findings stay structured. An earlier version rebuilt a path by
  // splitting its own formatted output, which truncates at the first colon.
  it('excuses a path containing a colon, which its own formatted output would have truncated', async () => {
    const { sweep } = await loadValidator();
    const files = ['odd:name.txt'];
    const code = sweep(files, text({ 'odd:name.txt': `key=${CLOUD_ACCESS_KEY}` }), 'file(s)', {
      tracked: files,
      exemptions: [
        { path: 'odd:name.txt', id: 'cloud-access-key', reason: 'a path with a colon in it' },
      ],
    });
    expect(code, 'the path was re-parsed out of formatted text and lost its tail').toBe(0);
  });
});

describe('validate-no-secrets — an exemption excuses one finding, not a file', () => {
  const text = (byPath: Record<string, string>) => (relativePath: string) =>
    byPath[relativePath] ?? null;

  // 🔴 The failure this closes, demonstrated end to end by the round-2 scan: an
  // exemption taken out for a `credential-path` false positive on
  // `docs/secrets/threat-model.md` went on to report a REAL token in that same
  // file as clean, exit 0, with no staleness finding to say so. A blanket
  // per-path excusal is a standing licence for whatever lands on that path next.
  it('excuses the id it names', async () => {
    const { sweep } = await loadValidator();
    const files = ['docs/secrets/note.md'];
    const code = sweep(files, text({ 'docs/secrets/note.md': 'ordinary prose\n' }), 'file(s)', {
      tracked: files,
      exemptions: [
        {
          path: 'docs/secrets/note.md',
          id: 'credential-path',
          reason: 'a documentation directory',
        },
      ],
    });
    expect(code, 'the named finding was not excused').toBe(0);
  });

  it('does NOT excuse a different id on the same path', async () => {
    const { sweep } = await loadValidator();
    const files = ['docs/secrets/note.md'];
    const code = sweep(
      files,
      text({ 'docs/secrets/note.md': `token=${'a1'.repeat(12)}\n` }),
      'file(s)',
      {
        tracked: files,
        exemptions: [
          {
            path: 'docs/secrets/note.md',
            id: 'credential-path',
            reason: 'a documentation directory',
          },
        ],
      },
    );
    expect(code, 'a real credential was suppressed by a path-arm exemption').toBe(1);
  });

  it('reports an entry whose named id has stopped appearing on that path', async () => {
    const { exemptionProblems } = await loadValidator();
    const problems = exemptionProblems({
      exemptions: [{ path: 'a.txt', id: 'assigned-secret', reason: 'was needed once' }],
      tracked: ['a.txt'],
      offending: [{ path: 'a.txt', id: 'credential-path' }],
    });
    expect(problems.map((problem) => problem.kind)).toContain('exemption-no-longer-needed');
  });

  it('leaves an entry alone while the id it names is still appearing', async () => {
    const { exemptionProblems } = await loadValidator();
    const problems = exemptionProblems({
      exemptions: [{ path: 'a.txt', id: 'credential-path', reason: 'a documentation directory' }],
      tracked: ['a.txt'],
      offending: [{ path: 'a.txt', id: 'credential-path' }],
    });
    expect(problems).toEqual([]);
  });

  // 🔴 The mutation that survived round 1 with a green suite, and why. The
  // all-or-nothing rule was asserted only through the exit code — and the stale
  // entry emits a line of its own, so the code is 1 whether the rule is there or
  // not. Deleting the rule left 31/31 passing while the credential finding
  // silently vanished from the output. So this reads the OUTPUT: the suppressed
  // finding has to come back, by name.
  it('stops excusing anything while one entry is unusable, and says which finding came back', async () => {
    const { sweep } = await loadValidator();
    const files = ['a.txt'];
    const printed: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (chunk: unknown): boolean => {
      printed.push(String(chunk));
      return true;
    };
    let code: number;
    try {
      code = sweep(files, text({ 'a.txt': `key=${CLOUD_ACCESS_KEY}` }), 'file(s)', {
        tracked: files,
        exemptions: [
          { path: 'a.txt', id: 'cloud-access-key', reason: 'excused' },
          { path: 'gone.txt', id: 'cloud-access-key', reason: 'names a path nobody tracks' },
        ],
      });
    } finally {
      process.stdout.write = write;
    }
    const out = printed.join('');
    expect(code).toBe(1);
    expect(out, 'the excused finding did not come back when the list became untrustworthy').toMatch(
      /^a\.txt:\d+ — cloud-access-key$/m,
    );
    expect(out).toMatch(/gone\.txt — exemption-not-tracked/);
  });
});

describe('validate-no-secrets --staged — the list is audited where the whole tree is visible', () => {
  const text = (byPath: Record<string, string>) => (relativePath: string) =>
    byPath[relativePath] ?? null;

  // 🔴 Round 1 fixed half of this: `exemption-not-tracked` stopped reading the
  // staged set, and `exemption-no-longer-needed` kept reading it. So one valid
  // exemption still failed every commit that did not touch its path — under the
  // headline "a credential must never be committed", which is not what happened.
  // A commit sees one slice of the tree; auditing the list against a slice is
  // the category error. The audit belongs to the sweep that sees everything.
  // 🔴 The case above drives `sweep` directly, so it cannot see whether `main()`
  // actually asks for the audit to be off. Round 1 shipped a pass-through whose
  // deletion left the suite green for exactly that reason. Reading the wiring is
  // the weakest kind of test and it is the one this suite already uses for
  // `.husky/pre-commit` and `ci.yml` — it catches the mutation, which the
  // behavioural case above does not.
  it('wires the staged mode to skip the audit, and not only supports skipping it', async () => {
    const source = await readFile(validator, 'utf8');
    const staged = source.slice(source.indexOf("argv.includes('--staged')"));
    expect(staged.slice(0, 900)).toMatch(/auditList:\s*false/);
  });

  it('does not report a stale exemption from a commit that cannot see the whole tree', async () => {
    const { sweep } = await loadValidator();
    const staged = ['unrelated.ts'];
    const code = sweep(
      staged,
      text({ 'unrelated.ts': 'export const x = 1;\n' }),
      'staged file(s)',
      {
        tracked: ['unrelated.ts', 'fixtures/sample.env'],
        exemptions: [{ path: 'fixtures/sample.env', id: 'credential-path', reason: 'a sample' }],
        auditList: false,
      },
    );
    expect(code, 'a commit was refused over the exemption list, not over a credential').toBe(0);
  });
});

describe('validate-no-secrets --self-test — a pattern added without a fixture fails', () => {
  // 🔴 The header claims a shape cannot ride along uncovered. That claim was
  // backed only by a hardcoded id list, so a thirteenth pattern would have got
  // the free pass the header says is impossible. This derives the expectation
  // from the vocabulary instead.
  it('names every id the vocabulary defines, derived rather than listed', async () => {
    const { SECRET_VALUE_PATTERNS } = await loadSecretsLib();
    expect(SECRET_VALUE_PATTERNS.length, 'the vocabulary must have patterns').toBeGreaterThan(6);
    const dir = await temporaryRepo();
    const result = await run(dir, ['--self-test']);
    expect(result.code, result.out).toBe(0);
    for (const { id } of SECRET_VALUE_PATTERNS) expect(result.out).toContain(id);
  }, 20_000);
});
