import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Same reason as in queue.test.ts: the TWO `check-ignore` spawns below take an
// explicit environment from the ONE shipped list. `check-ignore` consults the
// index, so an inherited GIT_INDEX_FILE aims it at another repository — the
// variable that already killed the ignore tests in that file once.
//
// 🔴 Scoped to those two on purpose, and the limit is stated rather than
// implied: the `git ls-files` spawn further down this file inherits its
// environment, and this file is NOT on the sweep list in git-env.test.ts.
// Both facts predate this block. They are the open item AR-2 (`two git spawns
// outside the env sweep`), whose premises were checked and hold — fixing them
// here would be taking a queue item that was never handed out. A comment
// claiming this file is GIT_DIR-safe throughout would be the overstatement
// invariants.md warns about, in the file that carries that scar.
const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(repoRoot, 'templates/agent-os/universal/.claude/scripts/preflight.mjs'))
    .href
)) as { withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };

// AR-49(a). The router's credential vocabulary, read from the router.
//
// `SECRET_EXTENSIONS`, `SECRET_BASENAMES` and `SECURITY_WORDS` are module-private
// consts in decision-router.mjs — not exported, and exporting them is a change to
// an elevated file that this test has no business forcing. So they are parsed out
// of the source instead. The parse is asserted non-empty by a test of its own
// below: a rename that made this return `[]` would otherwise turn every
// derived-candidate assertion vacuously green, which is the exact failure mode a
// hand-copied list has.
const setLiteralOf = (source: string, name: string): string[] => {
  const declaration = source.indexOf(`${name} = new Set([`);
  if (declaration < 0) return [];
  const open = source.indexOf('[', declaration);
  const close = source.indexOf(']', open); // no member contains a bracket
  if (close < 0) return [];
  return [...source.slice(open + 1, close).matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '');
};

/**
 * One filename per way this repository answers "this file IS a credential".
 *
 * Derived, never restated — a restated list is the fourth copy the comment below
 * complains about. Three sources feed it:
 *
 *   - `SECRET_BASENAMES` and `SECRET_EXTENSIONS`, parsed out of the router;
 *   - `env` out of the router's `SECURITY_WORDS`, because `service.env` and
 *     `jira.env` are the form this repository's own tooling writes;
 *   - `CREDENTIAL_WORDS`, imported from `.claude/scripts/lib/secrets.mjs` — the
 *     14-word NAMED SUBSET the AR-49(b) ruling settled. That import is what ties
 *     the three ignore blocks to the one module the guards also read, so the
 *     ignore rule and the refusal cannot come to disagree about what a
 *     credential is.
 *
 * 🔴 **What is still committable, stated as a rule so it cannot go stale.**
 * `SECURITY_WORDS` has 55 members; 16 of them are ignored — the fourteen above
 * plus `env` and `key` — so **39 stay committable**. That is deliberate, not a
 * gap: the remainder is `auth`, `session`, `cors`, `acl`, `cert`, `keys`,
 * `crypto` and their kin, which are ordinary names in ordinary source. An ignore
 * rule over `*.session` would hide legitimate files, and a guard that fired on
 * them would be routed around within the week.
 *
 * The `39 = 55 − 16` form is deliberate. A hand-listed set is that fourth copy,
 * and the first attempt at one here was wrong on day one.
 *
 * The segment arm (`secrets/`, `credentials/`) is a directory, not a filename,
 * and a gitignore that swallowed either would hide legitimate source. It is
 * closed by `guard-secret-file` and the CI validator instead, which refuse a
 * commit rather than hiding a tree.
 */
const credentialFileNames = (
  source: string,
  credentialWords: ReadonlySet<string> = new Set(),
): string[] => {
  const names = [...setLiteralOf(source, 'SECRET_BASENAMES')];
  for (const extension of setLiteralOf(source, 'SECRET_EXTENSIONS'))
    names.push(`private.${extension}`);
  if (setLiteralOf(source, 'SECURITY_WORDS').includes('env')) names.push('jira.env');
  for (const word of credentialWords) names.push(`prod.${word}`);
  return names;
};

// The ruling AR-49(b) settled, read from the module the guards read. Imported
// rather than restated so the ignore blocks and the refusal share one list.
const { CREDENTIAL_WORDS } = (await import(
  pathToFileURL(path.join(repoRoot, 'templates/agent-os/universal/.claude/scripts/lib/secrets.mjs'))
    .href
)) as { CREDENTIAL_WORDS: ReadonlySet<string> };

const routerSource = await readFile(
  path.join(repoRoot, 'templates/agent-os/universal/.claude/scripts/decision-router.mjs'),
  'utf8',
);

// The elevated-path declaration this repo publishes, read the way the sweep
// reads it. Imported through a URL for the same reason as below: the script
// ships as plain .mjs with no type declarations.
type Detector = {
  parseElevatedPaths: (md: string) => string[] | null;
  elevatedPathsIn: (files: string[], elevatedPaths: string[]) => string[];
};

const loadDetector = async (): Promise<Detector> =>
  (await import(
    pathToFileURL(
      path.join(repoRoot, 'templates/agent-os/universal/.claude/scripts/detect-missed-gate.mjs'),
    ).href
  )) as Detector;

const loadDeclaredPaths = async (): Promise<string[]> => {
  const detector = await loadDetector();
  const claudeMd = await readFile(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
  const declared = detector.parseElevatedPaths(claudeMd);
  expect(declared).not.toBeNull();
  return declared!;
};

// PLAN.md phase 5: this repo runs under its own agent-os. CLAUDE.md and
// .claude/ are composed from templates/agent-os (universal + node-ts) by
// scripts/sync-agent-os.mjs; any drift between the templates and the checked-in
// copies fails here.
describe('dogfooding: the tool repo runs its own agent-os', () => {
  it('CLAUDE.md and .claude/ are in sync with templates/agent-os', async () => {
    await expect(
      exec(process.execPath, [path.join(repoRoot, 'scripts', 'sync-agent-os.mjs'), '--check']),
    ).resolves.toBeTruthy();
  });

  it('the composed CLAUDE.md names this repo and keeps the repo addendum', async () => {
    const claudeMd = await readFile(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('create-agent-rig');
    expect(claudeMd).toContain('generator repo addendum');
    // The universal-derived part is fully substituted. (The addendum below the
    // marker legitimately *documents* the token names, so it is exempt.)
    const [universalPart] = claudeMd.split('generator repo addendum');
    expect(universalPart).not.toContain('__PROJECT_NAME__');
  });

  // The seeded elevated paths belong to the generated skeleton
  // (packages/db/src/), which does not exist here. Left as-is it would declare a
  // gate over nothing — dogfooding that describes another repo is worse than no
  // dogfooding, because the sweep would report "clean" while looking nowhere.
  it('declares elevated paths that actually exist in THIS repo', async () => {
    // Imported through a URL: the hook/script tree ships as plain .mjs with no
    // declarations, and a fabricated .d.ts for a template file would rot.
    const detector = (await import(
      pathToFileURL(
        path.join(repoRoot, 'templates/agent-os/universal/.claude/scripts/detect-missed-gate.mjs'),
      ).href
    )) as { parseElevatedPaths: (md: string) => string[] | null };
    const claudeMd = await readFile(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
    const declared = detector.parseElevatedPaths(claudeMd);
    expect(declared).not.toBeNull();
    expect(declared!.length).toBeGreaterThan(0);

    const { access } = await import('node:fs/promises');
    for (const declaredPath of declared!) {
      await expect(
        access(path.join(repoRoot, declaredPath)),
        `declared elevated path does not exist: ${declaredPath}`,
      ).resolves.toBeUndefined();
    }
    // and the enforcement layer itself is elevated here: weakening a hook is
    // precisely the change that must never slip through unreviewed
    expect(declared).toContain('templates/agent-os/universal/.claude/hooks/');
  });

  // AR-12. A file that carries its own ```elevated-paths``` block is a
  // declaration source: the sweep unions every such block into the list it
  // gates on. So a merge that DELETES such a block silently un-declares
  // whatever it declared, and the sweep afterwards reports "clean" while
  // looking nowhere. The only thing that makes that merge visible is the
  // declaring file itself sitting under a declared elevated path.
  //
  // The sharp case is templates/agent-os/stack/aws-cdk/.claude/rules/aws-cdk.md:
  // its block declares `infra/` for every generated AWS project.
  it('declares both stack rulebooks, one of which declares elevated paths itself', async () => {
    const declared = await loadDeclaredPaths();

    expect(declared).toContain('templates/agent-os/stack/aws-cdk/.claude/rules/');
    expect(declared).toContain('templates/agent-os/stack/node-ts/.claude/rules/');
  });

  it('declares every file that declares elevated paths of its own', async () => {
    const declared = await loadDeclaredPaths();
    const detector = await loadDetector();

    // One pass over the tracked markdown files: `git ls-files` never descends
    // into node_modules or .git, so the work is bounded by what is committed.
    // Only .md is scanned, because only a .md can be a declaration SOURCE the
    // sweep reads: `readDeclaredPaths` parses CLAUDE.md and .claude/rules/*.md
    // and nothing else. The one .mjs that matters is scripts/sync-agent-os.mjs,
    // whose ELEVATED_PATHS is this repo's authoritative list — it is not scanned
    // here and does not need to be, because `scripts/` is itself declared. Move
    // that list elsewhere and this reasoning has to move with it.
    const { stdout } = await exec('git', ['ls-files', '*.md'], { cwd: repoRoot });
    const markdownFiles = stdout.split('\n').filter(Boolean);

    const declaringFiles: string[] = [];
    for (const relFile of markdownFiles) {
      // The root CLAUDE.md is skipped, and NOT because the assertion would be
      // circular — it would simply fail: no declared path covers it. It is
      // exempt because three other mechanisms already cover it, and adding it to
      // the list would be a fourth. It is GENERATED by sync-agent-os.mjs, so a
      // hand-edit fails the drift check in CI; a legitimate edit goes through
      // `scripts/`, which IS declared; and deleting its block entirely makes the
      // sweep emit `no-elevated-paths-declared` rather than fall silent.
      if (relFile === 'CLAUDE.md') continue;
      const content = await readFile(path.join(repoRoot, relFile), 'utf8');
      if (content.includes('```elevated-paths')) declaringFiles.push(relFile);
    }
    expect(declaringFiles.length).toBeGreaterThan(0);

    // Coverage is asked of the sweep itself rather than re-implemented here.
    // A hand-rolled prefix match would drift from `elevatedPathsIn` — and it
    // would miss the half that matters: a path can be declared and still be
    // dropped as inert, which is exactly how `.md` rulebooks were once
    // invisible to this gate.
    for (const relFile of declaringFiles) {
      expect(
        detector.elevatedPathsIn([relFile], declared).length > 0,
        `file declares elevated paths but is not itself under a declared elevated path — ` +
          `deleting its block would un-declare them and the sweep would report clean: ${relFile}`,
      ).toBe(true);
    }
  });

  // AR-51. The rulebook the synced `.claude/` tree carries is what
  // `guard-rulebook` protects from an unattended run — and the sweep can only
  // see a merge that touched it if the composed CLAUDE.md declares it. The
  // template-side directories are declared; the synced copy at the root was not.
  it('declares the synced .claude/ tree itself as an elevated path', async () => {
    const sync = await readFile(path.join(repoRoot, 'scripts', 'sync-agent-os.mjs'), 'utf8');
    const block = /const ELEVATED_PATHS = \[([\s\S]*?)\n\];/.exec(sync);
    expect(block, 'ELEVATED_PATHS array not found in sync-agent-os.mjs').not.toBeNull();
    const entries = [...block![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(entries).toContain('.claude/');
  });

  it('the blocking hooks are active in this repo', async () => {
    const settings = JSON.parse(
      await readFile(path.join(repoRoot, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    const commands = settings.hooks.PreToolUse.flatMap((h) => h.hooks.map((x) => x.command));
    expect(commands.some((c) => c.includes('block-no-verify.mjs'))).toBe(true);
  });
});

// The same dogfooding gap, one file over: the skeletons have shipped a secrets
// block since they existed, and this repository — which runs the loop against a
// tracker adapter that reads an API token from the environment — did not have
// one. "Never put secrets in code, config, logs or fixtures" (`autonomy.md`,
// Never tier) is a rule; an ignore rule is the mechanical half of it, and by
// `invariants.md` a check with no test is a guess.
//
// 🔴 Assert it BEHAVIOURALLY and in BOTH directions. A one-sided ignore test is
// vacuous: the interesting failure is not "`.env` stopped being ignored", it is
// "`.env.example` started being ignored" — or, worse, the reverse, where a tidy
// that widens `.env`/`.env.*` into `.env*` with a matching `!.env*` un-ignores
// every secret while every ignore assertion here stays green. So each verdict is
// pinned together with the RULE that produced it: not-ignored has to be the work
// of `!.env.example`, not of the whole block having been deleted.
describe('the secrets block the skeletons ship is live in this repository too', () => {
  /**
   * The real ignore verdict. `-q` alone: 0 = ignored, 1 = not.
   *
   * `-c core.excludesFile=/dev/null` for the same reason the skeleton spawn
   * further down passes it: `*.pem`, `*.key` and `.env` are common enough in a
   * developer's global excludesfile that this whole block could be missing and
   * every assertion here still pass on one machine while failing in CI.
   */
  const ignored = (file: string): Promise<boolean> =>
    new Promise((resolve) => {
      execFile(
        'git',
        ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '-q', '--', file],
        { cwd: repoRoot, env: withoutGitLocation() },
        (error) => resolve(!error),
      );
    });

  /**
   * The rule that decided the verdict, as `<source>:<pattern>`, or `null` when
   * no pattern matched at all.
   *
   * Deliberately NOT used for the verdict: under `-v` git exits 0 for a NEGATED
   * match too (`.env.example` matches `!.env.example` and is not ignored), so
   * reading ignore-ness off that exit code inverts this file's headline case.
   * The source is asserted so an ignore cannot be credited to a developer's
   * global excludesfile — belt and braces with the `core.excludesFile` override
   * above, because this one also pins WHICH rule decided.
   */
  const matchedRule = (file: string): Promise<string | null> =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '-v', '--non-matching', '--', file],
        { cwd: repoRoot, env: withoutGitLocation() },
        (error, stdout) => {
          const code = error ? ((error as { code?: number }).code ?? 1) : 0;
          if (code > 1) return reject(error as Error);
          // `<source>:<line>:<pattern>\t<pathname>`, or `::\t<pathname>`
          const match = /^(.*):(\d+):(.*)$/.exec(stdout.split('\t')[0] ?? '');
          resolve(match ? `${match[1]}:${match[3]}` : null);
        },
      );
    });

  it.each([
    // the pattern is not root-anchored — a nested one is the same secret
    ['.env', '.env'],
    ['packages/core/.env', '.env'],
    ['.env.local', '.env.*'],
    ['.env.production', '.env.*'],
    ['id.pem', '*.pem'],
    ['server.key', '*.key'],
  ])('never lets %s be committed', async (file, pattern) => {
    await expect(ignored(file)).resolves.toBe(true);
    await expect(matchedRule(file)).resolves.toBe(`.gitignore:${pattern}`);
  });

  // The fragile line. The negation is only correct BECAUSE it sits after
  // `.env.*`; git takes the last matching pattern, so a reorder silently commits
  // every `.env.*` file. And the sample file has to survive nested too, or a
  // service's own `.env.example` stops being shippable.
  it.each(['.env.example', 'packages/core/.env.example'])(
    'still tracks %s, and by the negation rather than by an absent block',
    async (file) => {
      await expect(ignored(file)).resolves.toBe(false);
      await expect(matchedRule(file)).resolves.toBe('.gitignore:!.env.example');
    },
  );

  // A neighbour that predates the block: adding patterns must not change what
  // the existing entries mean.
  it('leaves the pre-existing next-env.d.ts entry doing its job', async () => {
    await expect(ignored('next-env.d.ts')).resolves.toBe(true);
    await expect(matchedRule('next-env.d.ts')).resolves.toBe('.gitignore:next-env.d.ts');
  });

  // `invariants.md`: "One mechanism, one implementation. If two files enforce
  // the same invariant, they will disagree — and the one nobody is looking at is
  // the one that is wrong." A gitignore has no include directive, so the three
  // copies are forced; this test is the only thing tying them together. Extract
  // the patterns, never restate them — a restated list is a fourth copy.
  const secretsPatterns = async (...parts: string[]): Promise<string[]> => {
    const lines = (await readFile(path.join(repoRoot, ...parts), 'utf8')).split('\n');
    const header = lines.findIndex((line) => /^#.*\bsecrets\b/i.test(line));
    expect(header, `no secrets block in ${path.join(...parts)}`).toBeGreaterThanOrEqual(0);
    const patterns: string[] = [];
    for (const line of lines.slice(header + 1)) {
      if (line.trim() === '') break; // the block ends at the first blank line
      if (line.startsWith('#')) continue; // its prose is per-file, its patterns are not
      patterns.push(line);
    }
    return patterns;
  };

  // `cdk deploy --outputs-file cdk-outputs.json` writes it on every deploy, and
  // an artifact that is untracked-but-committable is one `git add -A` away from
  // being in the history — this one names buckets, distributions and endpoints.
  // The workflow runs the deploy from `infra/`, so the pattern has to reach a
  // nested path, not just the root.
  it.each(['cdk-outputs.json', 'infra/cdk-outputs.json'])(
    'the aws-serverless skeleton never lets %s be committed',
    async (file) => {
      const skeleton = path.join(repoRoot, 'templates', 'skeleton', 'aws-serverless');
      const dir = await mkdtemp(path.join(tmpdir(), 'rig-skeleton-ignore-'));
      const env = withoutGitLocation();
      await exec('git', ['init', '-q', dir], { env });
      await copyFile(path.join(skeleton, 'gitignore'), path.join(dir, '.gitignore'));

      const { stdout } = await exec(
        'git',
        // an empty global excludesfile: the skeleton's own ignore has to be the
        // one doing the work, not whatever this machine happens to exclude
        ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '-v', '--', file],
        { cwd: dir, env },
      ).catch(() => ({ stdout: '' }));

      await rm(dir, { recursive: true, force: true });
      expect(stdout.split('\t')[0], `${file} is not ignored by the skeleton`).toMatch(
        /^\.gitignore:\d+:/,
      );
    },
  );

  it('states the same secrets patterns in the root ignore and in both skeletons', async () => {
    const root = await secretsPatterns('.gitignore');
    // non-vacuity: three empty lists are also "identical"
    expect(root.length, 'the root block must carry patterns, not just its comment').toBeGreaterThan(
      0,
    );
    for (const target of ['node-service', 'aws-serverless']) {
      await expect(
        secretsPatterns('templates', 'skeleton', target, 'gitignore'),
        `${target} has drifted from the root .gitignore`,
      ).resolves.toEqual(root);
    }
  });

  // AR-49(a). The same invariant one layer up, and the one the three-way test
  // above cannot reach: the three ignore blocks agree with EACH OTHER, and all
  // three disagree with `decision-router.mjs`. The router's `isSecretFile`
  // (`:408`) is this repository's written-down answer to "which files ARE
  // credentials"; the ignore block is the mechanism that keeps such a file out
  // of the history. Two statements of one definition, and — `invariants.md`,
  // "One mechanism, one implementation" — the one nobody is looking at is the
  // one that is wrong. Measured at the time of writing: `.npmrc`, `.netrc`,
  // `.pgpass`, `id_rsa`, `id_ed25519`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`
  // and `*.env` are all committable in this repo while the router calls each of
  // them a credential file.
  //
  // 🔴 The candidate list is DERIVED from the router's own sets, never restated.
  // A restated list is the fourth copy this comment is complaining about, and it
  // would go stale in the direction that reads as green.
  it.each([
    ['SECRET_EXTENSIONS', 'p12'],
    ['SECRET_BASENAMES', '.pgpass'],
    ['SECURITY_WORDS', 'env'],
  ])('reads the router set %s, and finds %s in it rather than an empty set', (name, member) => {
    const members = setLiteralOf(routerSource, name);
    expect(members.length, `${name} was not readable from decision-router.mjs`).toBeGreaterThan(0);
    expect(members).toContain(member);
  });

  it.each(credentialFileNames(routerSource, CREDENTIAL_WORDS))(
    'never lets %s be committed — the router calls it a credential file',
    async (file) => {
      await expect(ignored(file)).resolves.toBe(true);
      await expect(matchedRule(file)).resolves.toMatch(/^\.gitignore:/);
    },
  );

  // The derivation is the whole test, so it gets its own pin: run it over a
  // fabricated source and a name that exists nowhere in this repository. This is
  // the "drift the other way" half — a name added to the two DERIVED arms
  // (`SECRET_BASENAMES`, `SECRET_EXTENSIONS`) produces a new required ignore,
  // instead of the parser silently returning what it returned yesterday.
  //
  // 🔴 It does not reach the `SECURITY_WORDS` arm: that one contributes `env`
  // only, so adding a word to the ROUTER produces nothing here. The credential
  // words come from `secrets.mjs` instead and are passed in separately — which
  // is why this case passes no set, and why the `prod.*` names are absent below.
  it('turns a name newly added to the router sets into a newly required ignore', () => {
    const fabricated = [
      "const SECRET_EXTENSIONS = new Set(['ar49ext']);",
      "const SECRET_BASENAMES = new Set(['.ar49rc']);",
      "const SECURITY_WORDS = new Set(['env']);",
    ].join('\n');

    const derived = credentialFileNames(fabricated);
    expect(derived).toContain('.ar49rc');
    expect(derived.some((file) => file.endsWith('.ar49ext'))).toBe(true);
    // and the fabricated source's names are the ONLY ones — nothing is smuggled
    // in from a hardcoded default that would keep passing after a rename
    expect(derived.some((file) => file.includes('pgpass') || file.includes('p12'))).toBe(false);
  });

  // NOT derived, and the reason is worth writing down rather than hiding in the
  // list above: `isSecretFile` does **not** classify `.envrc`. Its `.env` arm
  // tests `basename === '.env' || basename.startsWith('.env.')` — with a
  // trailing dot — and the extension arm returns early on `lastIndexOf('.') <= 0`,
  // which for `.envrc` is 0. So direnv's file is a credential store that this
  // repository's own classifier misses and its ignore block misses too; the
  // second gap is the one this test closes. The first is the router's, and
  // widening a risk classifier is not this change.
  it('never lets .envrc be committed, though isSecretFile does not classify it', async () => {
    await expect(ignored('.envrc')).resolves.toBe(true);
    await expect(matchedRule('.envrc')).resolves.toMatch(/^\.gitignore:/);
  });
});
