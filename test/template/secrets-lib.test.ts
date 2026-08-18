import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ANTHROPIC_KEY,
  ATLASSIAN_TOKEN,
  CLOUD_ACCESS_KEY,
  CLOUD_ACCESS_KEY_TWIN,
  GITHUB_FINE_GRAINED,
  GITHUB_PAT,
  INLINE_JWT,
  PEM_HEADER,
  assignment,
  pemHeader,
  AWS_SECRET,
  LONG_RUN,
  LONG_WORDS,
  quoted,
} from './secrets-fixtures.js';

// AR-49(b). The half of AR-49 that `.gitignore` could not close.
//
// Half (a) made the router's credential FILENAMES un-committable. It left two
// holes on purpose, both stated in dogfood.test.ts: the `SECURITY_WORDS` arm
// (53 of 55 words still committable as extensions, because taking the arm whole
// would demand ignore rules for `*.cors`, `*.acl` and `*.session`), and the
// SEGMENT arm (`secrets/`, `credentials/` — an ignore rule over a directory
// would hide legitimate source). Both need a decision about which words are
// credentials rather than a derivation, and a guard rather than an ignore rule.
//
// This is that decision, made once. Three call sites will import it — a
// `.husky/pre-commit` check, a `.claude/hooks/` PreToolUse guard, and
// `scripts/validate-no-secrets.mjs` — and `.claude/rules/invariants.md` ("one
// mechanism, one implementation") is why it is a module rather than three
// copies that will disagree, with the one nobody is looking at being wrong.
//
// 🔴 The negative half of this file is the more important half. A guard that
// fires on `auth.ts`, `session.ts` or `.env.example` gets routed around within
// the week, and a routed-around guard is worse than none — everyone believes
// they are covered. So every arm is pinned in BOTH directions.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const modulePath = path.join(scriptsDir, 'lib', 'secrets.mjs');
const routerPath = path.join(scriptsDir, 'decision-router.mjs');

/** One credential this file's scanner found, and deliberately nothing more. */
interface Finding {
  id: string;
  /** 1-based, so it reads the way an editor and a diff both count. */
  line: number;
}

interface SecretsModule {
  CREDENTIAL_WORDS: ReadonlySet<string>;
  CREDENTIAL_BASENAMES: ReadonlySet<string>;
  CREDENTIAL_EXTENSIONS: ReadonlySet<string>;
  CREDENTIAL_SEGMENTS: ReadonlySet<string>;
  isCredentialPath(relativePath: string): boolean;
  SECRET_VALUE_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp }>;
  findSecretValues(text: string, options?: { limit?: number }): Finding[];
}

// The module ships as plain .mjs with no type declarations — same reason
// verdict.test.ts and dogfood.test.ts import their subjects through a file URL.
const load = async (): Promise<SecretsModule> =>
  (await import(pathToFileURL(modulePath).href)) as unknown as SecretsModule;

const isCredentialPath = async (relativePath: string): Promise<boolean> =>
  (await load()).isCredentialPath(relativePath);

const scan = async (text: string, options?: { limit?: number }): Promise<Finding[]> =>
  (await load()).findSecretValues(text, options);

const idsIn = (findings: Finding[]): string[] => findings.map((finding) => finding.id);

/**
 * The router's set literals, parsed out of its source.
 *
 * A deliberate second copy of the parser in dogfood.test.ts: importing a helper
 * out of a *.test.ts file drags that file's whole suite into this one. Both
 * copies are guarded by the same non-vacuity probe below, which is the property
 * that actually matters — a rename that made either return `[]` would turn every
 * subset assertion vacuously green.
 */
const setLiteralOf = (source: string, name: string): string[] => {
  const declaration = source.indexOf(`${name} = new Set([`);
  if (declaration < 0) return [];
  const open = source.indexOf('[', declaration);
  const close = source.indexOf(']', open); // no member contains a bracket
  if (close < 0) return [];
  return [...source.slice(open + 1, close).matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '');
};

const routerSource = await readFile(routerPath, 'utf8');

// The fourteen. An owner RULING, not a derivation: it is a NAMED SUBSET of the
// router's 55-member SECURITY_WORDS, chosen so the guard refuses credentials
// without refusing ordinary source. Written out here rather than derived,
// because a derived list would silently change meaning the day someone adds a
// word to the router — and the subset test below is what keeps the two honest.
const THE_FOURTEEN = [
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
];

// Every one of these is in the router's SECURITY_WORDS and is deliberately NOT
// a credential word. They are ordinary names in ordinary source — `auth.ts`,
// `session.ts`, `crypto.ts`, `permissions.ts` — and a guard that fired on them
// would be uninstalled before it ever caught anything.
const THE_EXCLUDED = [
  'acl',
  'auth',
  'cert',
  'certs',
  'cors',
  'crypto',
  'keys',
  'permission',
  'session',
  'sessions',
];

describe('the credential vocabulary is decided once, in one place', () => {
  it('names exactly the fourteen words this project calls a credential', async () => {
    const { CREDENTIAL_WORDS } = await load();
    expect(CREDENTIAL_WORDS).toBeInstanceOf(Set);
    expect([...CREDENTIAL_WORDS].sort()).toEqual([...THE_FOURTEEN].sort());
  });

  it.each(THE_EXCLUDED)(
    'leaves out %s, which is an ordinary word in ordinary source',
    async (word) => {
      const { CREDENTIAL_WORDS } = await load();
      expect(CREDENTIAL_WORDS.has(word)).toBe(false);
    },
  );

  it('takes every credential word from the router, so the two lists cannot disagree', async () => {
    const { CREDENTIAL_WORDS } = await load();
    const securityWords = setLiteralOf(routerSource, 'SECURITY_WORDS');
    for (const word of CREDENTIAL_WORDS)
      expect(securityWords, `${word} is not in the router's SECURITY_WORDS`).toContain(word);
  });

  it('reads a router vocabulary that is not empty, so the subset check cannot pass on nothing', () => {
    // Without this, a rename of SECURITY_WORDS makes the assertion above
    // vacuously green forever — the failure mode a hand-copied list has.
    const securityWords = setLiteralOf(routerSource, 'SECURITY_WORDS');
    expect(securityWords.length).toBeGreaterThan(THE_FOURTEEN.length);
    expect(securityWords).toContain('secret');
  });

  it('names the credential files that carry no extension to give them away', async () => {
    const { CREDENTIAL_BASENAMES } = await load();
    expect(CREDENTIAL_BASENAMES).toBeInstanceOf(Set);
    expect([...CREDENTIAL_BASENAMES].sort()).toEqual(
      ['.envrc', '.netrc', '.npmrc', '.pgpass', 'id_ed25519', 'id_rsa'].sort(),
    );
  });

  it('names the extensions that mean a key material file', async () => {
    const { CREDENTIAL_EXTENSIONS } = await load();
    expect(CREDENTIAL_EXTENSIONS).toBeInstanceOf(Set);
    expect([...CREDENTIAL_EXTENSIONS].sort()).toEqual(
      ['jks', 'key', 'keystore', 'p12', 'pem', 'pfx'].sort(),
    );
  });

  it('names the two directory names whose contents are credentials whatever they are called', async () => {
    const { CREDENTIAL_SEGMENTS } = await load();
    expect(CREDENTIAL_SEGMENTS).toBeInstanceOf(Set);
    expect([...CREDENTIAL_SEGMENTS].sort()).toEqual(['credentials', 'secrets'].sort());
  });
});

describe('a path alone is enough to know it is a credential', () => {
  it.each([
    '.npmrc',
    '.netrc',
    '.pgpass',
    '.envrc',
    'id_rsa',
    'id_ed25519',
    'infra/keys/id_ed25519',
  ])('calls %s a credential by its name alone', async (file) => {
    await expect(isCredentialPath(file)).resolves.toBe(true);
  });

  it.each(['.env', '.env.local', '.env.production', 'jira.env', 'services/api/.env'])(
    'calls %s a credential, because that is the form this tooling writes',
    async (file) => {
      await expect(isCredentialPath(file)).resolves.toBe(true);
    },
  );

  it.each(['.env.example', '.env.sample', '.env.template', 'apps/web/.env.example'])(
    'leaves %s committable, because it is the documented placeholder form',
    async (file) => {
      await expect(isCredentialPath(file)).resolves.toBe(false);
    },
  );

  it.each(['private.pem', 'a.p12', 'a.jks', 'svc.key', 'store.keystore', 'client.pfx'])(
    'calls %s a credential by its extension',
    async (file) => {
      await expect(isCredentialPath(file)).resolves.toBe(true);
    },
  );

  // The arm half (a) left open: the router calls these credentials, and no
  // ignore rule could, because `*.secrets` and `*.token` files are rare while
  // the words are everywhere.
  it.each([
    'db.secret',
    'api.token',
    'x.jwt',
    'svc.credentials',
    'y.passwd',
    'z.creds',
    'w.bearer',
    'dist/local.secrets',
    'ops/prod.password',
  ])('calls %s a credential, because the extension is one of the fourteen', async (file) => {
    await expect(isCredentialPath(file)).resolves.toBe(true);
  });

  // The other arm half (a) left open, and the reason it is closed by a guard
  // rather than by `.gitignore`: an ignore rule over `secrets/` would hide
  // legitimate source, which is a worse failure than the one it prevents.
  it.each([
    'config/secrets/anything.txt',
    'app/credentials/note.md',
    'a/b/secrets/c/d.txt',
    'infra/credentials/README.md',
  ])('calls %s a credential because of the directory it sits in', async (file) => {
    await expect(isCredentialPath(file)).resolves.toBe(true);
  });

  it.each([
    'notes.md',
    'README.md',
    'tokenizer.ts',
    'auth.ts',
    'session.ts',
    'packages/core/src/authorize.ts',
    'packages/core/src/password-policy.ts',
    'docs/decisions/secrets-and-tokens.md',
  ])('leaves %s alone — the extension is matched, never the stem', async (file) => {
    await expect(isCredentialPath(file)).resolves.toBe(false);
  });

  // This file is its own proof: `secrets` is in the BASENAME, not a directory
  // segment, so the segment arm must not reach it.
  it('does not call this very test file a credential, though its name carries the word', async () => {
    await expect(isCredentialPath('test/template/secrets-lib.test.ts')).resolves.toBe(false);
  });

  it('does not call the module under test a credential either', async () => {
    await expect(
      isCredentialPath('templates/agent-os/universal/.claude/scripts/lib/secrets.mjs'),
    ).resolves.toBe(false);
  });
});

// One line per shape, so a positive test never accidentally proves a different
// pattern than the one it names. Every one of them is ASSEMBLED in
// secrets-fixtures.ts rather than written literally here — see that file for why
// assembly is preferred to exempting this file from its own sweep.

describe('the value patterns name every credential shape the three call sites must refuse', () => {
  it.each([
    'atlassian-token',
    'github-pat',
    'cloud-access-key',
    'anthropic-key',
    'private-key-block',
    'assigned-secret',
  ])('carries a pattern called %s', async (id) => {
    const { SECRET_VALUE_PATTERNS } = await load();
    const entry = SECRET_VALUE_PATTERNS.find((candidate) => candidate.id === id);
    expect(entry, `no pattern is named ${id}`).toBeDefined();
    expect(entry?.pattern).toBeInstanceOf(RegExp);
  });
});

describe('a credential value in a file is found wherever it is written', () => {
  it.each([
    ['atlassian-token', ATLASSIAN_TOKEN],
    ['github-pat', GITHUB_PAT],
    ['github-pat', GITHUB_FINE_GRAINED],
    ['cloud-access-key', CLOUD_ACCESS_KEY],
    ['anthropic-key', ANTHROPIC_KEY],
    ['private-key-block', PEM_HEADER],
  ])('reports %s for a file carrying one', async (id, value) => {
    expect(idsIn(await scan(`some ordinary line\n${value}\nmore ordinary text\n`))).toContain(id);
  });

  it.each([pemHeader(''), pemHeader('EC '), pemHeader('OPENSSH ')])(
    'reports the header %s, whatever kind of private key it opens',
    async (header) => {
      expect(idsIn(await scan(`${header}\nMIIEpAIBAAKCAQEA\n`))).toContain('private-key-block');
    },
  );

  it.each([
    assignment('JIRA_API_TOKEN=', 'zK3mQ7vR1nT9bX5dW2sL8pF4'),
    assignment('token: ', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ012345'),
    assignment('PASSWORD=', 'hunter2hunter2hunter2hunter2'),
    assignment('apikey:', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ012345'),
    assignment('api_key = ', '9fA2dC7bE1gH4jK6mN8pQ0rS'),
  ])('reports the assignment %s, however it is spelled', async (line) => {
    expect(idsIn(await scan(line))).toContain('assigned-secret');
  });

  it('counts the line it found a credential on from one', async () => {
    const text = ['first', 'second', `third ${GITHUB_PAT}`, 'fourth'].join('\n');
    const findings = await scan(text);
    expect(findings.filter((finding) => finding.id === 'github-pat')).toEqual([
      { id: 'github-pat', line: 3 },
    ]);
  });

  it('reports a finding as an id and a line, and nothing else', async () => {
    const findings = await scan(CLOUD_ACCESS_KEY);
    expect(findings).toEqual([{ id: 'cloud-access-key', line: 1 }]);
  });

  // 🔴 The headline of this describe block. A guard that prints what it found
  // has copied the credential into a log, a hook transcript and a CI record —
  // it has leaked the secret in the act of refusing it.
  it('never carries the credential itself into the finding it reports', async () => {
    const text = [
      `ATLASSIAN=${ATLASSIAN_TOKEN}`,
      `GITHUB=${GITHUB_PAT}`,
      `AWS=${CLOUD_ACCESS_KEY}`,
      `ANTHROPIC=${ANTHROPIC_KEY}`,
      PEM_HEADER,
    ].join('\n');

    const serialised = JSON.stringify(await scan(text));

    for (const value of [ATLASSIAN_TOKEN, GITHUB_PAT, CLOUD_ACCESS_KEY, ANTHROPIC_KEY])
      expect(serialised).not.toContain(value);
    // and not a distinctive fragment of one either, so a "truncated for safety"
    // implementation does not pass this by printing the first half
    for (const fragment of ['ATATT3xFfGF0', 'a1B2c3D4e5F6', 'AKIAABCDEFGH', 'Zq9Wx7Lv2Kd4'])
      expect(serialised).not.toContain(fragment);
  });

  it('reports the same pattern on the same line once, however many times it appears', async () => {
    const findings = await scan(`${CLOUD_ACCESS_KEY} and again ${CLOUD_ACCESS_KEY_TWIN}`);
    expect(findings).toEqual([{ id: 'cloud-access-key', line: 1 }]);
  });

  it('still reports the same pattern once per line when it appears on two', async () => {
    const findings = await scan(`${CLOUD_ACCESS_KEY}\n${CLOUD_ACCESS_KEY_TWIN}`);
    expect(findings.map((finding) => finding.line)).toEqual([1, 2]);
  });
});

describe('prose about credentials is not a credential', () => {
  it.each([
    'the token is stored outside the repo',
    'password rotation policy',
    '| password | string | the caller supplies it |',
    'Set JIRA_API_TOKEN in your shell before running the queue adapter.',
    'See docs/decisions/secrets.md for why the credential never enters the repo.',
    'A bearer token authenticates every outbound call.',
  ])('leaves the line %s alone', async (line) => {
    expect(await scan(line)).toEqual([]);
  });

  // The 16-character bound is the whole reason a placeholder file is
  // committable. These pin the boundary from both sides rather than restating
  // the number: `your-token-here` is 15 characters, and it is the literal
  // placeholder `.env.example` files in this repository use.
  it.each(['JIRA_API_TOKEN=your-token-here', 'TOKEN=<redacted>', 'SECRET=xxx', 'password: ***'])(
    'leaves the placeholder %s alone',
    async (line) => {
      expect(await scan(line)).toEqual([]);
    },
  );

  it('does not report an assigned value one character short of the bound', async () => {
    expect(idsIn(await scan(`TOKEN=${'a'.repeat(15)}`))).not.toContain('assigned-secret');
  });

  it('reports an assigned value exactly at the bound', async () => {
    expect(idsIn(await scan(`TOKEN=${'a'.repeat(16)}`))).toContain('assigned-secret');
  });
});

// `.claude/rules/invariants.md`: "A guard that fails open must do provably
// bounded work — and this is the rule that cost the most to learn." Every line
// of work a fail-open guard does is a potential total bypass, so the test is not
// "is it fast enough on realistic input" but "can any input make it do unbounded
// work at all".
describe('the scan is bounded, because a fail-open guard that hangs is a total bypass', () => {
  const fillerLine = 'lorem ipsum dolor sit amet, consectetur adipiscing elit\n';
  const prose = (megabytes: number): string =>
    fillerLine.repeat(Math.ceil((megabytes * 1024 * 1024) / fillerLine.length));

  it('returns from five megabytes of harmless text without throwing', async () => {
    const text = prose(5);
    const started = Date.now();
    const findings = await scan(text);
    const elapsed = Date.now() - started;
    expect(findings).toEqual([]);
    expect(elapsed, `five megabytes took ${elapsed}ms`).toBeLessThan(2_000);
  });

  it('scans nothing past the limit it was given', async () => {
    const text = `${'x'.repeat(200)}\n${CLOUD_ACCESS_KEY}`;
    expect(await scan(text, { limit: 50 })).toEqual([]);
    // and the same text without the cap proves the secret was findable at all,
    // so the assertion above is not passing for the wrong reason
    expect(idsIn(await scan(text))).toContain('cloud-access-key');
  });

  it('has a limit even when the caller names none', async () => {
    const findings = await scan(`${prose(8)}${CLOUD_ACCESS_KEY}\n`);
    expect(idsIn(findings)).not.toContain('cloud-access-key');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AR-49(b), the other half of the decision: what the guard must NOT do.
//
// 🔴 An earlier `assigned-secret` arm read `\S{16,}`, which matches a code
// EXPRESSION as happily as a literal — this line, from the Jira adapter, was
// reported as a credential:
//
//     return { baseUrl, email: env.JIRA_EMAIL, token: env.JIRA_API_TOKEN };
//
// The count that mattered is not restated here, because a number in a comment
// cannot be re-run and goes stale the day the tree grows. The property it stood
// for is asserted instead, over the whole tree and on every run: see
// › "finds no credential value in any file this repository tracks" below, which
// sweeps every tracked file with NO exemption, and › "leaves alone the line this
// repository really contains at queue/jira.mjs:186", which pins the case by name.
//
// That costs more than an ordinary false positive, because this module feeds a
// `.husky/pre-commit` check that BLOCKS A COMMIT. `.claude/rules/invariants.md`
// rules on exactly this case: "Match a rule's precision to the cost of a false
// positive… Where a false block interrupts ordinary work, stay narrow and
// specific." A guard that fires on honest work gets routed around within the
// week, and a routed-around guard is worse than none — everyone believes they
// are covered.

const exec = promisify(execFile);

// The same `withoutGitLocation` idiom dogfood.test.ts spawns git through, and
// for the same defect: a process started under a git hook inherits an absolute
// GIT_DIR/GIT_INDEX_FILE, and the `git ls-files` below would then enumerate
// ANOTHER repository — reporting a clean sweep of a tree it never read.
const { withoutGitLocation } = (await import(
  pathToFileURL(path.join(repoRoot, 'templates/agent-os/universal/.claude/scripts/preflight.mjs'))
    .href
)) as { withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };

const trackedFiles = async (): Promise<string[]> => {
  const { stdout } = await exec('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    env: withoutGitLocation(),
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.split('\0').filter(Boolean);
};

const utf8Decoder = new TextDecoder('utf8', { fatal: true });

/**
 * The file's text, or `null` when it is not valid UTF-8.
 *
 * A binary blob has no lines to name, so scanning one could only produce a
 * finding no human could act on. `fatal: true` is what makes the decode refuse
 * rather than silently substitute U+FFFD — a lossy decode would hand the scanner
 * text that is not what the file contains.
 */
const utf8Of = async (absolutePath: string): Promise<string | null> => {
  try {
    return utf8Decoder.decode(await readFile(absolutePath));
  } catch {
    return null;
  }
};

describe('ordinary source that merely names a credential is not a credential', () => {
  it.each([
    'const apiKey = process.env.ANTHROPIC_API_KEY;',
    'const token = process.env.JIRA_API_TOKEN;',
    '  password: process.env.DB_PASSWORD,',
    'export const SECRET = config.get("some.long.dotted.path");',
    'token: z.string().min(1).describe("the caller token"),',
  ])('leaves the honest line %s alone', async (line) => {
    expect(await scan(line)).toEqual([]);
  });

  // Kept out of the list above and named on its own, because it is not a
  // hypothetical: this is the verbatim text of `.claude/scripts/queue/jira.mjs`
  // line 186 and of its template twin, and those two lines are the ONLY thing
  // the scanner finds anywhere in this repository.
  it('leaves alone the line this repository really contains at queue/jira.mjs:186', async () => {
    expect(
      await scan('return { baseUrl, email: env.JIRA_EMAIL, token: env.JIRA_API_TOKEN };'),
    ).toEqual([]);
  });
});

// 🔴 The tree is the regression test, and the list above is only a sample —
// samples go stale, a repository does not. This reads every tracked file and
// asserts the scanner is silent on all of them, which states two things at once
// and both are load-bearing: no credential value is committed here today, and
// the guard does not fire on the honest source that IS committed here. Every
// false positive anyone adds from now on lands on this test, in the file and
// line where it was written.
describe('the repository itself is the regression test for a guard that fires on honest work', () => {
  it('reads a tracked file list that is not empty, so the sweep cannot pass on nothing', async () => {
    const files = await trackedFiles();
    expect(files.length).toBeGreaterThan(300);
    // and it is THIS repository's list, not whatever repository an inherited
    // GIT_DIR pointed the spawn at
    expect(files).toContain('CLAUDE.md');
    expect(files).toContain('.claude/scripts/queue/jira.mjs');
  });

  it('finds no credential value in any file this repository tracks', async () => {
    const offences: string[] = [];
    for (const relFile of await trackedFiles()) {
      // 🔴 There is NO exemption, and that is the property worth keeping. The
      // suites that carry synthetic credentials assemble them at runtime
      // (secrets-fixtures.ts), so they are clean by the scanner's own
      // definition rather than excused from it. An exemption list is
      // indistinguishable from a real leak somebody silenced; an empty sweep
      // is not. If this loop ever needs a `continue`, that is the finding.
      const text = await utf8Of(path.join(repoRoot, relFile));
      if (text === null) continue;
      // Location only — never the matched value. Printing it would copy the
      // credential into a CI log in the act of reporting it, which is the
      // failure "never carries the credential itself into the finding it
      // reports" pins one layer down.
      for (const finding of await scan(text))
        offences.push(`${relFile}:${finding.line} — ${finding.id}`);
    }

    expect(
      offences,
      'either a credential is committed in this repository, or the guard fires on honest ' +
        'source; the matched value is deliberately not printed',
    ).toEqual([]);
  }, 60_000);
});

// The narrowing has to be paid for from one side only. Both lines below are
// already pinned further up, in the block that proves the pattern finds an
// assignment at all — they are re-stated HERE so the boundary is readable from
// both sides in one place: the assignment that must still fire sits next to the
// expressions that must not.
describe('narrowing the assignment pattern does not cost it a true positive', () => {
  it.each([
    assignment('JIRA_API_TOKEN=', 'zK3mQ7vR1nT9bX5dW2sL8pF4'),
    assignment('PASSWORD=', 'hunter2hunter2hunter2hunter2'),
  ])('still reports the assignment %s, whose value is a literal credential', async (line) => {
    expect(idsIn(await scan(line))).toContain('assigned-secret');
  });
});

// `.claude/rules/invariants.md`: "Every guard has cases it cannot see. Write
// them down in the file, and then test each one." This is the case the narrowing
// CREATES, so it is written down as a price rather than discovered later by
// whoever trusted the guard with it.
//
// Telling a literal from an expression is done by the shape of the value: a
// credential is one run of literal characters, while `process.env.X`,
// `config.get(...)` and `{ token: env.T }` reach a dot, a bracket, a brace or a
// quote within a few characters — `process` is seven.
//
// 🔴 The limit is therefore about the RUN, not about the character. The first
// draft of this block asserted that "a value carrying a dot is invisible" and
// named an inline JWT as the instance. Measured, that was FALSE: a JWT's first
// segment is twenty-odd literal characters, so `assigned-secret` matches it
// before it ever reaches a dot. The claim is corrected here rather than softened,
// and the true positive it turned out to be is pinned below — an unbacked
// sentence about a mechanism is what `.claude/rules/invariants.md` calls a
// prose-reviewer blocker by rule.
describe('what the assignment pattern can and cannot see, stated as a limit rather than found later', () => {
  it('does see an inline JWT, because its first segment is a long literal run', async () => {
    expect(idsIn(await scan(INLINE_JWT))).toContain('assigned-secret');
  });

  // The real price of the narrowing, and the smallest case that shows it: a
  // value that reaches a dot before it has sixteen literal characters is
  // indistinguishable, to this pattern, from `token: env.T`. That similarity is
  // the whole reason the tree sweep above is clean.
  //
  // Asserts only that `assigned-secret` does not claim it — deliberately NOT
  // that something else reports it. A dedicated pattern for short dotted values
  // is a decision nobody has taken, and demanding one here would be asserting
  // behaviour that was never designed.
  it('cannot see a credential whose literal run breaks before sixteen characters', async () => {
    const shortRunBeforeDot = [assignment('token=', 'ab12cd34'), 'ef56gh78ij90klmnop'].join('.');
    expect(idsIn(await scan(shortRunBeforeDot))).not.toContain('assigned-secret');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round-2 gate findings. Three reviewers returned HOLD; these are the cases they
// measured, each pinned from BOTH sides — the shape that must now be found, and
// the honest source that must still be left alone. The second half is the one
// that matters: the narrowing these widen was itself forced by false positives,
// and a widening that brings them back has traded one defect for a worse one.

describe('a credential assigned with a quoted value is still a credential', () => {
  // The dominant shape in a TypeScript, JSON or YAML tree, and every one of
  // these carries an unbroken 32-character run: they were lost to the quote in
  // front of the value, not to anything about the value itself.
  it.each([
    quoted('const token = ', LONG_RUN) + ';',
    '  ' + quoted('"api_key": ', LONG_RUN) + ',',
    quoted('password: ', LONG_WORDS),
    quoted('token: ', LONG_RUN, "'"),
    quoted('PASSWORD = ', LONG_WORDS),
  ])('reports %s, whose value is quoted rather than bare', async (line) => {
    expect(idsIn(await scan(line))).toContain('assigned-secret');
  });

  // 🔴 The other side, in the same block on purpose. Widening for quotes must
  // not re-admit the expressions that forced the narrowing in the first place.
  it.each([
    'const apiKey = process.env.ANTHROPIC_API_KEY;',
    'export const SECRET = config.get("some.long.dotted.path");',
    'token: z.string().min(1).describe("the caller token"),',
    'return { baseUrl, email: env.JIRA_EMAIL, token: env.JIRA_API_TOKEN };',
    'JIRA_API_TOKEN=your-token-here',
    'TOKEN=<redacted>',
  ])('still leaves the honest line %s alone', async (line) => {
    expect(await scan(line)).toEqual([]);
  });
});

describe('the assignment arm reads the same vocabulary as the rest of the module', () => {
  // A hardcoded five-word list sat in the pattern while CREDENTIAL_WORDS held
  // fourteen and the module called itself "one vocabulary, decided once". Two
  // lists answering one question is the exact failure this module exists to
  // prevent — so the agreement is asserted rather than assumed.
  it('accepts every word in the credential vocabulary as an assignment keyword', async () => {
    const { CREDENTIAL_WORDS } = await load();
    // Non-vacuity: a renamed export would otherwise walk an empty set.
    expect(CREDENTIAL_WORDS.size).toBe(14);
    const missed: string[] = [];
    for (const word of CREDENTIAL_WORDS) {
      const findings = await scan(`${word.toUpperCase()}=${LONG_RUN}`);
      if (!findings.some((finding) => finding.id === 'assigned-secret')) missed.push(word);
    }
    expect(
      missed,
      'these words are credentials by CREDENTIAL_WORDS and not by the assignment pattern, ' +
        'which is two vocabularies answering one question',
    ).toEqual([]);
  });

  // The concrete harm the mismatch caused: `cloud-access-key` matches AKIA…,
  // which is the access key IDENTIFIER and not secret material. Missing the
  // secret half while catching the public half reads as coverage.
  it.each([`AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`, `aws_secret_access_key = ${AWS_SECRET}`])(
    'reports %s, where the keyword is not adjacent to the separator',
    async (line) => {
      expect(idsIn(await scan(line))).toContain('assigned-secret');
    },
  );

  // A keyword in prose must not reach a separator further along the line.
  it('does not let a keyword in prose reach a separator further down the line', async () => {
    expect(await scan(`the token here means BASE64 = ${LONG_RUN}`)).toEqual([]);
  });
});

describe('a credential path is the same path however it is spelled', () => {
  it.each([
    '.aws/credentials',
    '.git-credentials',
    'prod.env.local',
    'jira.env.local',
    '.ENV',
    'Id_rsa',
    'config/Secrets/x.txt',
  ])('calls %s a credential', async (file) => {
    await expect(isCredentialPath(file)).resolves.toBe(true);
  });

  // 🔴 And the negative side: case-folding must not start eating source.
  it.each([
    'Auth.ts',
    'Session.ts',
    'Tokenizer.ts',
    'README.md',
    '.env.example',
    '.ENV.EXAMPLE',
    'packages/core/src/credentials.ts',
  ])('still leaves %s alone', async (file) => {
    await expect(isCredentialPath(file)).resolves.toBe(false);
  });
});

describe('a credential quoted in documentation has still been leaked', () => {
  // The queue item names this fixture by hand. The scanner is line-based, so a
  // fence marker is an ordinary line and this passes today; its value is
  // prospective — it is the only thing that would object to a future
  // "do not scan documentation fences" narrowing.
  it('reports a token inside a fenced block in markdown, on the line it sits on', async () => {
    const doc = [
      '# Setting up',
      '',
      'Put your token in the environment:',
      '',
      '```sh',
      `export JIRA_API_TOKEN=${LONG_RUN}`,
      '```',
    ].join('\n');
    expect(await scan(doc)).toEqual([{ id: 'assigned-secret', line: 6 }]);
  });
});
