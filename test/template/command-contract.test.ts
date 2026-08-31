import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The filename is the deliverable RP-17 names, so it is resolved by exact path
// rather than discovered by scanning docs/.
const contractPath = path.join(repoRoot, 'docs', 'command-contract.md');
const contractRelative = path.relative(repoRoot, contractPath).split(path.sep).join('/');

type Requirement = readonly [description: string, pattern: RegExp];

/** One credential the shared scanner found — deliberately never its value. */
interface SecretFinding {
  id: string;
  line: number;
}

interface SecretsModule {
  isCredentialPath(relativePath: string): boolean;
  findSecretValues(text: string, options?: { limit?: number }): SecretFinding[];
}

/**
 * The credential vocabulary this repository's own layers refuse by — the module
 * the `## Secrets` section names by path.
 *
 * Imported rather than restated: `.claude/rules/invariants.md` ("one mechanism,
 * one implementation") is why a second spelling of the set is a defect, and the
 * document itself says not to infer the set from a description of it. The
 * module ships as plain `.mjs` with no declarations, so it arrives through a
 * file URL the way `verdict.test.ts` and `secrets-lib.test.ts` take theirs. It
 * runs nothing on import: it is exported constants, two exported functions and
 * one `Map` built from them.
 */
const loadSecretsModule = async (): Promise<SecretsModule> =>
  (await import(
    pathToFileURL(path.join(repoRoot, '.claude', 'scripts', 'lib', 'secrets.mjs')).href
  )) as unknown as SecretsModule;

const expectTerms = (content: string, terms: readonly Requirement[]) => {
  for (const [description, pattern] of terms) expect(content, description).toMatch(pattern);
};

const normalizeProse = (content: string) => content.replace(/\s+/g, ' ').trim();
const expectStatement = (content: string, description: string, statement: string) => {
  expect(normalizeProse(content), description).toContain(statement);
};

const section = (content: string, heading: RegExp): string => {
  const lines = content.split('\n');
  const start = lines.findIndex((line) => heading.test(line));
  expect(start, `missing Markdown section matching ${heading}`).toBeGreaterThan(-1);
  const level = /^(#+)/.exec(lines[start]!)?.[1]?.length ?? 0;
  const end = lines.findIndex((line, index) => {
    const next = /^(#+)\s+/.exec(line)?.[1]?.length;
    return index > start && next !== undefined && next <= level;
  });
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
};

async function loadContract(): Promise<string> {
  try {
    return await readFile(contractPath, 'utf8');
  } catch {
    throw new Error(
      `${contractRelative} does not exist. RP-17's deliverable is that document: ` +
        'a proposed command contract declaring its scope carve-out, the closed exit-code ' +
        'table 0-4, the --json output discipline, the --version handshake, configuration ' +
        'and secret rules, RIG_UNATTENDED, mutations, doctor, the memory surface, a ' +
        '"Conformance today" section and a "what this does not cite" section.',
    );
  }
}

/** Markdown table rows of a section, as their trimmed leading cell. */
const tableRowCells = (sectionText: string): string[] =>
  sectionText
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => line.trim().replace(/^\|/, '').split('|')[0] ?? '')
    .map((cell) => cell.replace(/[`*_]/g, '').trim());

/** The full text of the table row whose leading cell is exactly `code`. */
const tableRow = (sectionText: string, code: string): string =>
  sectionText.split('\n').find((line) => {
    if (!line.trim().startsWith('|')) return false;
    const first = (line.trim().replace(/^\|/, '').split('|')[0] ?? '').replace(/[`*_]/g, '').trim();
    return first === code;
  }) ?? '';

const jsonFixtures = (content: string): string[] => {
  const fences = /```json\r?\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  let match: RegExpExecArray | null = fences.exec(content);
  while (match !== null) {
    blocks.push(match[1] ?? '');
    match = fences.exec(content);
  }
  return blocks;
};

/** Every top-level object of every fixture, in document order. */
const fixtureRoots = (content: string): unknown[] => {
  const roots: unknown[] = [];
  for (const block of jsonFixtures(content)) {
    const parsed: unknown = JSON.parse(block);
    roots.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  return roots;
};

/**
 * "Path-looking": a slash or backslash adjacent to a non-space, a leading `~`,
 * a leading-dot filename (`.gitignore`), one of a few always-a-file names that
 * carry no extension (`Makefile`), or a known source/config/doc extension.
 * Case-insensitive, because `a.JSON` names a file exactly as `a.json` does.
 *
 * `0 ok / 1 fail` is prose and must stay unflagged; `.claude/scripts` is not.
 * The extension list is explicit rather than `\.\w+` for that reason — the
 * fixtures' own `detail` strings ("not on the search path", "not set") and
 * their version strings ("0.6.2", "1.0") have to survive it.
 *
 * Residual limit — what still slips past this constant, stated here because a
 * detector's own claim about its reach is the thing that drifts
 * (`.claude/rules/invariants.md`, "State the limits"):
 *
 *   - an extensionless filename outside the short list below (`LICENSE`,
 *     `pre-commit`), and a bare directory name carrying no separator
 *     (`node_modules`, `secrets`);
 *   - an extension the list does not carry (`.rb`, `.sqlite`, `.pem12`);
 *   - a path split across two fields, or assembled by the consumer from a
 *     directory key plus a name key;
 *   - a path escaped past recognition (URL-encoded, or a Windows path whose
 *     backslashes the JSON author doubled into something else).
 *
 * A path in any of those shapes reaches a payload with this suite green.
 */
const PATH_LIKE =
  /\S[/\\]|[/\\]\S|^~|^\.[A-Za-z0-9]|\b(?:Makefile|Dockerfile|Procfile|Gemfile|Justfile)\b|\.(?:jsonc|json|jsx|tsx|mjs|cjs|mts|cts|yaml|yml|toml|conf|cfg|ini|lock|bash|html|css|xml|txt|mdx|log|pem|crt|env|md|sh|js|ts)(?:\b|$)/i;

const hasKey = (value: unknown, key: string): boolean =>
  typeof value === 'object' && value !== null && key in (value as Record<string, unknown>);

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;

const collectPathLikeStrings = (value: unknown, keyPath: string, out: string[]): void => {
  if (typeof value === 'string') {
    if (PATH_LIKE.test(value)) out.push(`${keyPath} = ${JSON.stringify(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((element, index) => collectPathLikeStrings(element, `${keyPath}[${index}]`, out));
    return;
  }
  if (value !== null && typeof value === 'object') {
    // The document's carve-out is exactly one shape: `fix` is "a doctor-record
    // field", so the exemption needs the RECORD, not merely the key. A `fix`
    // exempted wherever it appeared was measurably wider than the rule it
    // backed: a path in a `fix` inside a `missing[]` entry passed, and the
    // Exit-codes section forbids exactly that. A doctor record is recognised
    // the way a consumer recognises one — it carries `id` and `status` too.
    //
    // Residual, stated rather than left to be found: any object carrying `id`,
    // `status` and a string `fix` earns the exemption, whether or not it sits
    // under `checks`; and a path nested inside an object or an array under a
    // `fix` key is still reported, because only the direct string value is
    // exempt.
    const isDoctorRecord = hasKey(value, 'id') && hasKey(value, 'status');
    for (const [key, child] of Object.entries(value)) {
      const childPath = keyPath === '' ? key : `${keyPath}.${key}`;
      // KEYS are inspected too. A payload can name a path as readily in a key
      // as in a value (`{"packages/core/src/x.ts": true}`), and a walk that
      // only ever looked at values passed that. Keys are never exempt: the
      // carve-out is for a `fix` HINT, which is a value.
      if (PATH_LIKE.test(key)) out.push(`${childPath} (key) = ${JSON.stringify(key)}`);
      if (key === 'fix' && typeof child === 'string' && isDoctorRecord) continue;
      collectPathLikeStrings(child, childPath, out);
    }
  }
};

async function walkSources(dir: string, extension: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walkSources(full, extension)));
    else if (entry.name.endsWith(extension)) found.push(full);
  }
  return found;
}

const asRepoPath = (file: string) => path.relative(repoRoot, file).split(path.sep).join('/');

/**
 * Crude: strips `//` to end of line, so a `//` inside a string literal or a URL
 * takes the rest of that line with it. That is acceptable here — the question is
 * only whether an occurrence of the variable name is a read or a mention.
 */
const stripLineComments = (source: string): string =>
  source
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

/**
 * The spellings of a real read of `RIG_UNATTENDED`, in order: a member access
 * (with or without optional chaining), a computed access by literal key, a
 * destructuring of the environment (with or without a default value), a
 * presence probe passing the environment and the name as two arguments
 * (`Object.hasOwn`, `Reflect.has`), an `in` probe, and `hasOwnProperty`.
 *
 * 🔴 The failure direction here is a false GREEN on a conformance row — a read
 * this pattern cannot see reads as "nothing in this repository reads it" — so
 * the pattern is deliberately wider than a parser would be, and the arms below
 * accept a destructured `env` wherever they accept `process.env`. Four
 * spellings were measured slipping past the previous form: `'RIG_UNATTENDED' in
 * process.env`, `Object.hasOwn(env, 'RIG_UNATTENDED')` against a destructured
 * environment, `process.env.hasOwnProperty('RIG_UNATTENDED')`, and a
 * destructuring whose default value contains braces (`const { RIG_UNATTENDED =
 * {} } = process.env`), which the old brace-balanced arm could not cross. Each
 * of the six is pinned from both sides in
 * "detects every spelling of a RIG_UNATTENDED read, and no bare mention of the
 * name".
 *
 * Limits — the shapes this pattern does not see, so the row it backs is read
 * with them in mind (`.claude/rules/invariants.md`, "State the limits"):
 *
 *   - `stripLineComments` above is crude, so a `//` inside a string swallows
 *     the rest of its line; a read hidden after one on the same line is missed.
 *   - Block comments are not stripped at all, so a mention inside one counts as
 *     a read. That direction is a false RED, which fails safe.
 *   - A computed key held in a variable (`env[name]`), a name built by
 *     concatenation (`'RIG_' + 'UNATTENDED'`), and an alias of the environment
 *     bound to an identifier not ending in `env` (`const e = process.env;
 *     e.RIG_UNATTENDED`) are all invisible.
 *   - A read in a spawned process's environment, or through a `dotenv`-style
 *     loader, is not a textual occurrence at all.
 *   - The destructuring arm is a one-line heuristic: the name, then up to 200
 *     characters carrying no `;` or newline, then `= …env`. A destructuring
 *     broken across lines is missed, and an unrelated mention of the name on a
 *     line that also assigns from the environment is a false RED, which fails
 *     safe.
 */
const READS_RIG_UNATTENDED = new RegExp(
  [
    // `process.env.RIG_UNATTENDED`, `env?.RIG_UNATTENDED`, `env.RIG_UNATTENDED`
    String.raw`(?:process\s*\.\s*)?env\s*(?:\?\.)?\s*\.?\s*RIG_UNATTENDED\b`,
    // `env['RIG_UNATTENDED']`
    String.raw`env\s*(?:\?\.)?\s*\[\s*['"\`]RIG_UNATTENDED['"\`]\s*\]`,
    // `const { RIG_UNATTENDED } = process.env`, and the same with a default
    String.raw`\bRIG_UNATTENDED\b[^;\n]{0,200}=\s*(?:process\s*\.\s*)?env\b`,
    // `Object.hasOwn(process.env, 'RIG_UNATTENDED')`, `Reflect.has(env, …)`
    String.raw`(?:process\s*\.\s*)?env\s*,\s*['"\`]RIG_UNATTENDED['"\`]`,
    // `'RIG_UNATTENDED' in process.env`
    String.raw`['"\`]RIG_UNATTENDED['"\`]\s+in\s+(?:process\s*\.\s*)?env\b`,
    // `process.env.hasOwnProperty('RIG_UNATTENDED')`
    String.raw`env\s*(?:\?\.)?\s*\.\s*hasOwnProperty\s*\(\s*['"\`]RIG_UNATTENDED['"\`]`,
  ].join('|'),
);

describe('the proposed command contract document', () => {
  it('exists, names itself, and declares that it is proposed and awaiting owner acceptance', async () => {
    const content = await loadContract();
    expect(content, 'the document needs a top-level heading naming the command contract').toMatch(
      /^#\s+.*command contract/im,
    );
    expectTerms(content, [
      ['no "Status:" line declares the document proposed', /^Status:.*\bproposed\b/im],
      [
        'the status line does not say owner acceptance is required',
        /^Status:.*\bowner\b[\s\S]{0,200}\b(accept|acceptance|approval)\b/im,
      ],
    ]);
  });

  it('binds the published tool bins and carves the internal script fleet out of scope', async () => {
    const scope = section(await loadContract(), /^#{2,6}\s+.*Scope\b/i);
    expectStatement(
      scope,
      'the Scope section must carry the labelled assumption verbatim',
      "This contract binds the published tool bins — the rig bin and the memory shim — and does not bind this repository's internal .claude/scripts/ fleet.",
    );
    expect(scope, 'Scope must name .claude/scripts/ explicitly as the carve-out').toContain(
      '.claude/scripts/',
    );
  });
});

describe('the exit-code table', () => {
  const exitCodes = async () => section(await loadContract(), /^#{2,6}\s+.*Exit codes\b/i);

  it('defines exactly the codes 0 through 4 and closes the set', async () => {
    const content = await exitCodes();
    expect(content, 'the Exit codes section must contain a Markdown table').toMatch(/^\s*\|/m);
    const declared = tableRowCells(content).filter((cell) => /^\d+$/.test(cell));
    for (const code of ['0', '1', '2', '3', '4']) {
      expect(declared, `the exit-code table defines no row for exit ${code}`).toContain(code);
    }
    expect(
      declared.filter((cell) => !['0', '1', '2', '3', '4'].includes(cell)),
      'the exit-code table defines a code outside the closed set 0-4',
    ).toEqual([]);
  });

  it('makes emptiness a payload field rather than an exit code of its own', async () => {
    expectStatement(
      await exitCodes(),
      'emptiness must be pinned as exit 0 plus a payload field, never its own code',
      'Emptiness is exit 0 plus a field in the JSON payload, never a distinct exit code.',
    );
  });

  it('makes exit 3 list the missing input in the JSON payload', async () => {
    const row = tableRow(await exitCodes(), '3');
    expect(row, 'no table row has 3 as its leading cell').not.toEqual('');
    expect(row, "exit 3's row must say the JSON payload lists what is missing").toMatch(
      /JSON[\s\S]{0,120}\bmissing\b|\bmissing\b[\s\S]{0,120}JSON/i,
    );
  });

  it('gives exit 3 a second occasion where nothing is missing at all', async () => {
    const content = await exitCodes();
    expectStatement(
      content,
      'the Exit codes section must say exit 3 has two occasions and the payload says which',
      'Exit 3 has two occasions, and the payload says which.',
    );
    expectStatement(
      content,
      'the second occasion — a question refused under RIG_UNATTENDED with nothing missing — is not stated',
      'The other is a command that would have to ask a question while `RIG_UNATTENDED` is set, where nothing is missing from the environment at all',
    );
  });

  it('makes a result field the discriminator between the two occasions, not the exit code', async () => {
    expectStatement(
      await exitCodes(),
      'the Exit codes section must name a `result` field as the discriminator rather than the exit code',
      'The discriminator is a `result` field, not the exit code',
    );
  });

  it("closes exit 3's result values at prerequisites-unmet and refused-unattended", async () => {
    const content = await exitCodes();
    // The document's one rule that turns on a field's VALUES rather than its
    // keys, so the stability section does not cover it — left unenumerated, two
    // conforming bins could discriminate the same two occasions with different
    // words. Pinned verbatim: both words, and the claim that they are contract.
    expectStatement(
      content,
      'the Exit codes section must declare the discriminator values contract and enumerate them',
      'and **its values are contract**: on exit 3 the closed set is `prerequisites-unmet` and `refused-unattended`.',
    );
    expectStatement(
      content,
      'the Exit codes section must make a third discriminator value a minor bump rather than silence',
      'Adding a third value is a minor bump, by the additive rule.',
    );
  });

  it('names the environment variable and never the file when a prerequisite is missing', async () => {
    expectStatement(
      await exitCodes(),
      'the Exit codes section must forbid a credential file path in an exit-3 entry',
      'A missing prerequisite names the variable, never the file.',
    );
  });

  it('reserves exit 4 for a contract major mismatch', async () => {
    const row = tableRow(await exitCodes(), '4');
    expect(row, 'no table row has 4 as its leading cell').not.toEqual('');
    expect(row, "exit 4's row must name a contract major mismatch").toMatch(
      /contract[\s\S]{0,80}major|major[\s\S]{0,80}mismatch/i,
    );
  });
});

describe('output discipline', () => {
  const OUTPUT_STATEMENTS = [
    'Under --json, stdout carries exactly one JSON object and nothing else.',
    // "top-level payload", not "object": nested records carry no version of
    // their own, and the earlier wording made a conformance-matrix author guess.
    'Every top-level payload this contract defines carries schemaVersion.',
    'Human-readable rendering goes to stderr.',
  ] as const;

  for (const statement of OUTPUT_STATEMENTS) {
    it(`states verbatim: ${statement}`, async () => {
      const output = section(await loadContract(), /^#{2,6}\s+.*Output\b/i);
      expectStatement(output, `the Output section is missing: ${statement}`, statement);
    });
  }

  it('makes schema evolution additive: unknown keys tolerated, a foreign major rejected', async () => {
    // Verbatim, because the three regexes this replaced were polarity-blind:
    // "unknown keys are NOT tolerated" satisfied the tolerance proximity match
    // exactly as the real rule did, and `\badditive\b` fired on any mention.
    expectStatement(
      section(await loadContract(), /^#{2,6}\s+.*Output\b/i),
      'the Output section must state the additive-evolution rule verbatim, in its own polarity',
      'Schema evolution is **additive**. Unknown keys are tolerated rather than treated as an error, ' +
        'so a bin may add a field in a minor version without breaking a caller written against an earlier one. ' +
        'A foreign major is rejected outright: the consumer refuses to interpret the payload at all — that is what exit 4 is for.',
    );
  });
});

describe('the version handshake', () => {
  it('answers --version --json with name, version and contractVersion', async () => {
    // One verbatim sentence rather than four word-presence regexes: `\bname\b`
    // and `\bversion\b` inside a section titled "The version handshake" are
    // satisfied by the title and by every other paragraph, so neither could
    // have gone red if the answer stopped carrying the field.
    expectStatement(
      section(await loadContract(), /^#{2,6}\s+.*(handshake|--version|version handshake)/i),
      'the handshake section must state the invocation and the three fields of its answer verbatim',
      'Every conforming bin answers `--version --json` with an object carrying at least ' +
        '`name`, `version` and `contractVersion`:',
    );
  });
});

describe('configuration, secrets and unattended operation', () => {
  const configuration = async () => section(await loadContract(), /^#{2,6}\s+.*Configuration\b/i);

  it('orders configuration precedence as flags over environment over file', async () => {
    // Pinned verbatim rather than as a loose regex: the earlier pattern matched
    // the three words in order anywhere in the section, so a document stating
    // the OPPOSITE polarity would have satisfied it.
    expectStatement(
      await configuration(),
      'the Configuration section must state the precedence order verbatim',
      'Precedence runs flags over environment variables over a configuration file.',
    );
  });

  it('lets a flag name a credential file but never carry its contents', async () => {
    expectStatement(
      await configuration(),
      'the Configuration section must carve credentials out of the flag level verbatim',
      'A flag may name the path of a credential file, never its contents.',
    );
  });

  it('reads only documented variables from the RIG_ namespace', async () => {
    const content = await configuration();
    expect(content, 'the RIG_* environment namespace is not declared').toMatch(
      /RIG_\*|`RIG_`|RIG_ namespace/,
    );
    expectStatement(
      content,
      'the Configuration section must state the documented-variables rule verbatim',
      'Only documented variables are read.',
    );
  });

  it('keeps secrets out of argv and ties a secret file to its ignore entry', async () => {
    const secrets = section(await loadContract(), /^#{2,6}\s+.*Secrets?\b/i);
    expectStatement(
      secrets,
      'the Secrets section must state the argv rule verbatim',
      'Secrets never appear in argv.',
    );
    expect(
      normalizeProse(secrets),
      'an installer writing a secret file must write its ignore entry in the same change',
    ).toMatch(/ignore[\s\S]{0,120}same change|same change[\s\S]{0,120}ignore/i);
  });

  it('keeps a credential value out of every payload, rendering and error message', async () => {
    expectStatement(
      section(await loadContract(), /^#{2,6}\s+.*Secrets?\b/i),
      'the Secrets section must state the credential-value rule verbatim',
      'No credential value appears in any JSON payload, in the human rendering, or in an error message.',
    );
  });

  it('states a credential-file name rule the vocabulary actually agrees with', async () => {
    // The document's own instruction is "check the name against that function;
    // do not infer the set from a description of it, this sentence included" —
    // so this probes the real `isCredentialPath` rather than restating it.
    const { isCredentialPath } = await loadSecretsModule();

    // Real callers hand it a repo-relative path (`.claude/hooks/guard-secret-file.mjs`,
    // `scripts/validate-no-secrets.mjs`), and the name arm answers from the
    // basename. Each name is therefore probed twice — bare, and under a
    // directory that decides nothing — and the two must agree. A `secrets/` or
    // `credentials/` prefix would be answered by the SEGMENT arm instead and
    // would say nothing about the name.
    const NAMES: readonly (readonly [name: string, recognised: boolean])[] = [
      ['jira.env', true],
      ['jira.env.qa', false],
      ['jira.env.template', false],
      ['jira.conf', false],
      ['jira.toml', false],
      ['credentials.json', false],
    ];
    for (const [name, recognised] of NAMES) {
      for (const probe of [name, `config/${name}`]) {
        expect(
          isCredentialPath(probe),
          `the Secrets section says ${name} is ${recognised ? '' : 'not '}recognised, ` +
            `but isCredentialPath(${JSON.stringify(probe)}) disagrees`,
        ).toBe(recognised);
      }
    }

    // And the prose names every spelling the probe above measured, so the two
    // cannot drift apart. Backticked, because `jira.env` is a substring of
    // `jira.env.qa` and a bare `toContain` would pass on the wrong one.
    const secrets = normalizeProse(section(await loadContract(), /^#{2,6}\s+.*Secrets?\b/i));
    for (const [name] of NAMES) {
      expect(
        secrets,
        `the Secrets section does not name \`${name}\`, which this test measures`,
      ).toContain(`\`${name}\``);
    }
    expect(
      secrets,
      'the Secrets section must name isCredentialPath and the module it lives in as the authority for the name rule',
    ).toContain(
      'It must be a name `isCredentialPath` returns `true` for (`.claude/scripts/lib/secrets.mjs`).',
    );
    // The document cites this test by name; a rename leaves the pointer dead
    // and nothing else would notice.
    expect(
      secrets,
      'the Secrets section no longer points at this test by name — the pointer is dead',
    ).toContain('"states a credential-file name rule the vocabulary actually agrees with"');
  });

  it('makes RIG_UNATTENDED silence questions and turn missing input into exit 3', async () => {
    const unattended = section(await loadContract(), /^#{2,6}\s+.*RIG_UNATTENDED/);
    expectTerms(unattended, [
      [
        'RIG_UNATTENDED is not stated to suppress every question',
        /\bnever asks?\b|\bno question\b|\bnever prompts?\b/i,
      ],
      [
        'missing input under RIG_UNATTENDED is not exit 3 with the list',
        /exit\s*3[\s\S]{0,160}\blist\b|\blist\b[\s\S]{0,160}exit\s*3/i,
      ],
    ]);
  });

  it('separates RIG_UNATTENDED from the file that arms guard-rulebook', async () => {
    const unattended = section(await loadContract(), /^#{2,6}\s+.*RIG_UNATTENDED/);
    expectStatement(
      unattended,
      'the carve-out against the existing unattended FLAG must be stated verbatim',
      'RIG_UNATTENDED is a command-surface variable and is unrelated to the unattended flag that arms guard-rulebook, which is a file.',
    );
  });
});

describe('mutations and doctor', () => {
  const doctor = async () => section(await loadContract(), /^#{2,6}\s+.*Doctor\b/i);

  it('requires a declared side-effect list, --dry-run and a declared idempotence property', async () => {
    const mutations = section(await loadContract(), /^#{2,6}\s+.*Mutat/i);
    expectTerms(mutations, [
      ['mutating commands do not declare their side effects', /side[- ]effects?\b/i],
      ['mutating commands do not offer --dry-run', /--dry-run/],
      ['mutating commands do not declare an idempotence property', /\bidempoten/i],
    ]);
  });

  it('builds a doctor record from id, status, detail and fix', async () => {
    // The four `\bfield\b` presence regexes this replaced were each satisfied
    // by any other paragraph in the section — `status` alone occurs a dozen
    // times — so none of them could have gone red if a field left the record.
    // The four names themselves are pinned by the presence-rule statement
    // below; what needed a pin of its own is the claim that there are FOUR.
    expectStatement(
      await doctor(),
      'the Doctor section must declare the record shape and its field count verbatim',
      '`doctor --json` answers with a list of check records built from these four fields:',
    );
  });

  it('closes the doctor status set at ok, warn and fail', async () => {
    // Verbatim, because a `\bclosed\b` presence check passed on a section
    // saying "not closed" just as happily as on one saying "is closed".
    expectStatement(
      await doctor(),
      'the Doctor section must state the closed status set verbatim',
      'The status set is closed: ok, warn, fail.',
    );
  });

  it('puts id, status and detail on every record and fix only on warn or fail', async () => {
    expectStatement(
      await doctor(),
      'the Doctor section must state which fields are always present and when `fix` joins them',
      '`id`, `status` and `detail` are present on every record. `fix` is present when `status` is `warn` or `fail`, and omitted otherwise',
    );
  });

  it('exits 0 from a doctor run when no record is fail, and 1 when one is', async () => {
    expectStatement(
      await doctor(),
      'the Doctor section must state the exit rule verbatim',
      'A doctor run exits 0 when no record has status fail, and 1 when one does.',
    );
  });

  it("derives the payload's top-level status from the records rather than beside them", async () => {
    // The suite pinned this of the fixtures before the document said it, which
    // is a rule enforced against nothing. Now it is stated, so the sentence is
    // what the fixture assertion enforces.
    expectStatement(
      await doctor(),
      'the Doctor section must make the top-level status the worst record status, and a convenience only',
      'The payload carries the records under `checks`, and a `status` of its own, which is the worst status any record carries. It is a convenience, not a second source of truth: a consumer that disagrees with it should trust the records.',
    );
  });

  it('keeps detail and fix human-facing while consumers act on status alone', async () => {
    // Verbatim: the proximity match this replaced was polarity-blind — a
    // section telling consumers to match on `detail` puts the same words the
    // same distance apart.
    expectStatement(
      await doctor(),
      'the Doctor section must state the human-facing rule and the consumer restriction verbatim',
      '`detail` and `fix` are human-facing prose. Consumers act on `status` only — matching on the wording of `detail` couples a caller to a sentence nobody promised to keep.',
    );
  });

  it('leaves contract mismatch to the consumer handshake rather than to doctor', async () => {
    // The proximity match this replaced passed on the opposite claim: "doctor
    // reports contract mismatch alongside the handshake" carries both words
    // well inside 120 characters of each other.
    expectStatement(
      await doctor(),
      'the Doctor section must exclude contract mismatch from doctor findings verbatim',
      'Contract mismatch is **not** a doctor finding. A consumer detects it through the version handshake and exit 4, before it interprets any other payload.',
    );
  });
});

describe('the memory command surface', () => {
  const memory = async () => section(await loadContract(), /^#{2,6}\s+.*Memory\b/i);

  it('closes the contract-1.0 foundation verb set at four entries', async () => {
    const content = await memory();
    expectTerms(content, [
      ['the foundation verb set omits --version --json', /--version[\s\S]{0,40}--json/],
      ['the foundation verb set omits doctor --json', /doctor[\s\S]{0,40}--json/],
      ['the foundation verb set omits load --json', /load[\s\S]{0,40}--json/],
      ['the foundation verb set omits --dry-run on mutating commands', /--dry-run/],
    ]);
    // Verbatim: a bare `\bclosed\b` over this whole section was satisfied three
    // separate ways at once, so any one of the three closures could go missing
    // with the assertion still green.
    expectStatement(
      content,
      'the memory section must close the foundation verb set verbatim',
      'The foundation verb set is closed at these four entries:',
    );
  });

  it('closes the lifecycle state vocabulary at candidate, approved, rejected and superseded', async () => {
    expectStatement(
      await memory(),
      'the memory section must close the lifecycle vocabulary verbatim, naming all four states',
      'The lifecycle state vocabulary is closed at these four states: candidate, approved, rejected, superseded.',
    );
  });

  it('gives the storage tree exactly one owner and points consumers at the command surface', async () => {
    const content = await memory();
    expectStatement(
      content,
      'the memory section must state storage-tree ownership verbatim',
      'Only the memory subsystem reads or mutates its storage tree.',
    );
    // Verbatim: the proximity match this replaced was satisfied by any sentence
    // putting "consumers" near "command surface", including one exempting them
    // from it.
    expectStatement(
      content,
      'the memory section must route every other party through the command surface verbatim',
      'Every other party goes through the command surface — consumers use the command surface and never touch the files.',
    );
  });

  it('refuses lifecycle transitions under RIG_UNATTENDED with exit 3', async () => {
    expect(
      normalizeProse(await memory()),
      'lifecycle transition commands must refuse under RIG_UNATTENDED with exit 3',
    ).toMatch(/RIG_UNATTENDED[\s\S]{0,200}exit\s*3|exit\s*3[\s\S]{0,200}RIG_UNATTENDED/);
  });

  it('makes the load selection budget a per-invocation input, never core-global config', async () => {
    expectStatement(
      await memory(),
      'the memory section must state the selection budget rule verbatim',
      'The selection budget is a per-invocation input, and never core-global configuration.',
    );
  });

  it("defers the selection budget's default and bounds instead of claiming to fix them", async () => {
    const content = await loadContract();
    expect(
      normalizeProse(section(content, /^#{2,6}\s+.*Memory\b/i)),
      'the memory section must say this version does not fix the budget default and bounds',
      // The item's amendment (e) asks for contract-defined numbers. Repeating
      // the requirement without supplying one would read as having met it.
    ).toMatch(/default and bounds[\s\S]{0,80}this version does not fix them/i);
    expect(
      normalizeProse(section(content, /^#{2,6}\s+.*(does not cite|not cited)/i)),
      'the absent-referent section carries no entry for the load selection budget',
    ).toMatch(/load selection budget's default and bounds/i);
  });

  it('closes the degradation enum per version and enumerates no member at 1.0', async () => {
    const content = normalizeProse(await memory());
    expect(content, 'degradation[] is not declared a closed enum').toMatch(
      /`degradation\[\]` is a closed enum/,
    );
    expect(
      content,
      'the memory section does not say each version enumerates degradation[]’s members',
      // "closed per version" is the reading of amendment (i) this document
      // takes; without it "closed enum" says nothing about which members exist.
    ).toMatch(/each version of this contract enumerates its members/i);
    expect(content, 'the memory section does not say contract 1.0 enumerates no member').toContain(
      '**Contract 1.0 enumerates none**',
    );
    expect(
      content,
      'the memory section does not say a bin claiming contractVersion 1.0 emits an empty list',
    ).toMatch(/bin claiming `contractVersion` 1\.0 emits an empty list/i);
  });

  it('keeps degradation present on every load payload, empty when there was none', async () => {
    const content = await loadContract();
    expectStatement(
      section(content, /^#{2,6}\s+.*Memory\b/i),
      'the memory section must make `degradation` present whether or not there was any',
      'The key is **present** either way: a `load --json` payload always carries `degradation`, empty when there was none, so a consumer reads one shape rather than two.',
    );
    // And the fixtures obey it: an absent key is the second shape the sentence
    // exists to forbid, so the check is presence, not contents.
    const loads = fixtureRoots(content).filter(
      (root) => hasKey(root, 'counters') && hasKey(root, 'budget'),
    );
    expect(loads.length, 'no fixture illustrates a load payload').toBeGreaterThan(0);
    for (const [index, load] of loads.entries()) {
      expect(
        hasKey(load, 'degradation'),
        `load fixture #${index + 1} omits degradation, which the contract says is present either way`,
      ).toBe(true);
    }
  });
});

describe('stability and versioning', () => {
  const stability = async () =>
    section(await loadContract(), /^#{2,6}\s+.*Stability and versioning\b/i);

  it('covers subcommand names, documented flags, exit codes and JSON keys', async () => {
    expectStatement(
      await stability(),
      'the Stability section must name the covered surface verbatim',
      'What is covered: subcommand names, documented flags, exit codes, and the JSON keys named in this document.',
    );
  });

  it('makes an addition a minor bump', async () => {
    expectStatement(
      await stability(),
      'the Stability section must make an addition a minor bump',
      'Adding a subcommand, a flag, a JSON key or an enum member is a **minor** bump.',
    );
  });

  it('makes a rename or a removal a major bump preceded by a deprecation minor', async () => {
    expectStatement(
      await stability(),
      'the Stability section must require at least one deprecation minor before a major',
      'Renaming or removing any of them is a **major** bump, and must be preceded by at least one minor release in which the old spelling still works and is documented as deprecated.',
    );
  });
});

describe('the questions the document leaves open for acceptance', () => {
  const openQuestions = async () =>
    section(await loadContract(), /^#{2,6}\s+.*Open questions for acceptance\b/i);

  it("names doctor's extra marks, degradation[]'s members, the budget numbers and the fix presence rule", async () => {
    const open = normalizeProse(await openQuestions());
    expectTerms(open, [
      ["the acceptance list omits doctor's two extra marks", /doctor'?s two extra marks/i],
      ["the acceptance list omits degradation[]'s members", /`degradation\[\]`'?s members/i],
      [
        "the acceptance list omits the load selection budget's default and bounds",
        /load selection budget'?s default and bounds/i,
      ],
      [
        "the acceptance list omits the doctor `fix` presence rule, which `## Doctor` marks as this document's reading rather than the item's",
        /the doctor `fix` presence rule/i,
      ],
    ]);
  });

  it('opens exactly as many numbered questions as it says it leaves open', async () => {
    const open = await openQuestions();
    // The count is stated in prose and again as a numbered list; two spellings
    // of one fact drift, and the one nobody is reading is the one that is
    // wrong (`.claude/rules/invariants.md`, "one mechanism, one
    // implementation"). So they are checked against each other.
    expectStatement(
      open,
      'the acceptance section must say how many questions it leaves open',
      'Four things this document deliberately does not settle.',
    );
    const numbered = open.split('\n').filter((line) => /^\d+\.\s/.test(line));
    expect(
      numbered.map((line) => line.slice(0, 60)),
      'the acceptance section says it leaves four questions open but its numbered list has a different length',
    ).toHaveLength(4);
  });
});

describe('the JSON fixtures in the document', () => {
  it('carries at least one fixture and every one parses as JSON', async () => {
    const blocks = jsonFixtures(await loadContract());
    expect(blocks.length, 'the document carries no ```json fixture at all').toBeGreaterThan(0);
    for (const [index, block] of blocks.entries()) {
      expect(() => JSON.parse(block), `fixture #${index + 1} is not valid JSON`).not.toThrow();
    }
  });

  it('carries schemaVersion on every top-level fixture object', async () => {
    const blocks = jsonFixtures(await loadContract());
    expect(blocks.length, 'the document carries no ```json fixture at all').toBeGreaterThan(0);
    blocks.forEach((block, index) => {
      const parsed: unknown = JSON.parse(block);
      const roots = Array.isArray(parsed) ? parsed : [parsed];
      roots.forEach((root, position) => {
        expect(
          hasKey(root, 'schemaVersion'),
          `fixture #${index + 1}${Array.isArray(parsed) ? ` element ${position}` : ''} has no schemaVersion`,
        ).toBe(true);
      });
    });
  });

  it('keeps schemaVersion off every record nested inside a payload', async () => {
    // The document's own words: a nested record "carries no version of its own;
    // the payload's covers them". Asserting the key's PRESENCE on roots does not
    // pin that — this is the direction that matters, and the direction a
    // conformance-matrix author would otherwise have to guess at.
    const offenders: string[] = [];
    const walk = (value: unknown, keyPath: string, depth: number): void => {
      if (Array.isArray(value)) {
        value.forEach((element, index) => walk(element, `${keyPath}[${index}]`, depth));
        return;
      }
      if (value === null || typeof value !== 'object') return;
      if (depth > 0 && hasKey(value, 'schemaVersion')) offenders.push(keyPath);
      for (const [key, child] of Object.entries(value)) {
        walk(child, keyPath === '' ? key : `${keyPath}.${key}`, depth + 1);
      }
    };
    const blocks = jsonFixtures(await loadContract());
    expect(blocks.length, 'the document carries no ```json fixture at all').toBeGreaterThan(0);
    blocks.forEach((block, index) => {
      walk(JSON.parse(block) as unknown, '', 0);
      expect(
        offenders,
        `fixture #${index + 1} versions a nested record (${offenders.join(', ')}) — the document says only the top-level payload carries schemaVersion`,
      ).toEqual([]);
    });
  });

  it('keeps file paths out of every field except a doctor fix hint', async () => {
    const blocks = jsonFixtures(await loadContract());
    expect(blocks.length, 'the document carries no ```json fixture at all').toBeGreaterThan(0);
    blocks.forEach((block, index) => {
      const offenders: string[] = [];
      collectPathLikeStrings(JSON.parse(block) as unknown, '', offenders);
      expect(
        offenders,
        `fixture #${index + 1} names a file path outside a fix field: ${offenders.join(', ')}`,
      ).toEqual([]);
    });
  });

  it('exempts a path only in a doctor record fix, and sees one in a key', () => {
    // The carve-out and the walk are what every path assertion above rests on,
    // so both are measured rather than trusted. Each case here was a measured
    // pass under the previous form: a `fix` was exempt under ANY key at any
    // depth, and keys were never inspected at all.
    const reported = (value: unknown): string[] => {
      const out: string[] = [];
      collectPathLikeStrings(value, '', out);
      return out;
    };
    const HINT = 'copy .claude/skills/new-invariant/guard-invariant.example.test.mjs';
    expect(
      reported({ id: 'hook-test-neighbour', status: 'fail', detail: 'no test', fix: HINT }),
      'a doctor record — id, status and a string fix — must keep its human-facing hint',
    ).toEqual([]);
    expect(
      reported({ kind: 'environment', name: 'RIG_HOME', detail: 'not set', fix: HINT }),
      'a missing[] entry is not a doctor record, so a path in its fix is not exempt',
    ).not.toEqual([]);
    expect(
      reported({ id: 'x', status: 'ok', fix: { path: HINT } }),
      'only the string DIRECTLY under fix is exempt, never a path nested under it',
    ).not.toEqual([]);
    expect(
      reported({ 'packages/core/src/x.ts': true }),
      'a path named by an object KEY is a path in the payload just as a value is',
    ).not.toEqual([]);
    expect(
      reported({ result: 'ok', detail: 'not on the search path', version: '0.6.2' }),
      'ordinary prose and a version string must survive the walk, or every fixture assertion is a false red',
    ).toEqual([]);
  });

  it('discriminates the two exit-3 occasions with result values from the closed set', async () => {
    const carriers = fixtureRoots(await loadContract()).filter((root) => hasKey(root, 'missing'));
    expect(carriers.length, 'no fixture illustrates an exit-3 payload').toBeGreaterThan(0);
    const results = carriers.map((root) => fieldOf(root, 'result'));
    // Equality, not membership: it fails on a fixture inventing a third value
    // AND on the document dropping one of the two occasions it illustrates.
    expect(
      [...new Set(results)].sort(),
      `the exit-3 fixtures discriminate with ${JSON.stringify(results)}, not with the contract's closed set`,
    ).toEqual(['prerequisites-unmet', 'refused-unattended']);
  });

  it('names a variable and never a file in every missing-prerequisite entry', async () => {
    const content = await loadContract();
    const entries = fixtureRoots(content).flatMap((root) => {
      const missing = fieldOf(root, 'missing');
      return Array.isArray(missing) ? missing : [];
    });
    expect(entries.length, 'no fixture carries a non-empty missing[] to check').toBeGreaterThan(0);
    entries.forEach((entry, index) => {
      // `fix` is a DOCTOR-record field. An exit-3 entry that carried one would
      // be the legal-looking place to put a credential file's path, which is
      // the move `## Exit codes` forbids by name.
      expect(
        hasKey(entry, 'fix'),
        `missing[] entry #${index + 1} carries a fix key, but the contract scopes fix to a doctor record`,
      ).toBe(false);
      const offenders: string[] = [];
      collectPathLikeStrings(entry, `missing[${index}]`, offenders);
      expect(
        offenders,
        `missing[] entry #${index + 1} names a file path (${offenders.join(', ')}), and a missing prerequisite names the variable, never the file`,
      ).toEqual([]);
    });
  });

  it('carries no credential value in any fixture', async () => {
    const { findSecretValues } = await loadSecretsModule();
    const blocks = jsonFixtures(await loadContract());
    expect(blocks.length, 'the document carries no ```json fixture at all').toBeGreaterThan(0);

    // Non-vacuity first: an empty finding list means nothing unless the scanner
    // still finds a credential it should. The probe is ASSEMBLED at runtime
    // rather than written out — a credential SHAPE in this file's text would be
    // reported by the project's own sweep as a leak (`.claude/rules/autonomy.md`,
    // "Never").
    const probe = `token = "${'A1'.repeat(12)}"`;
    expect(
      findSecretValues(probe).map((finding) => finding.id),
      'findSecretValues no longer reports an assigned credential — the sweep below would pass vacuously',
    ).toContain('assigned-secret');

    blocks.forEach((block, index) => {
      // The finding is `{ id, line }` and never the value — a report that
      // quoted what it matched would have copied the credential into a CI log
      // in the act of refusing it. So the assertion is on the list, and the
      // message names the shape and the line only.
      const findings = findSecretValues(block);
      expect(
        findings.map((finding) => `${finding.id} at line ${finding.line}`),
        `fixture #${index + 1} carries a credential value, which no payload this contract defines may`,
      ).toEqual([]);
    });
  });

  it('demonstrates the version handshake in a fixture', async () => {
    expect(
      fixtureRoots(await loadContract()).some(
        (value) =>
          hasKey(value, 'name') && hasKey(value, 'version') && hasKey(value, 'contractVersion'),
      ),
      'no fixture object carries name, version and contractVersion together',
    ).toBe(true);
  });

  it('illustrates every payload shape the contract names', async () => {
    const roots = fixtureRoots(await loadContract());
    expect(
      roots.length,
      'the document names six payload shapes and must illustrate each of them',
    ).toBeGreaterThanOrEqual(6);
    const shapes: readonly (readonly [string, (root: unknown) => boolean])[] = [
      [
        'the version handshake (name + version + contractVersion)',
        (root) =>
          hasKey(root, 'name') && hasKey(root, 'version') && hasKey(root, 'contractVersion'),
      ],
      [
        'a successful run with nothing to do (empty === true)',
        (root) => fieldOf(root, 'empty') === true,
      ],
      [
        'environment prerequisites unmet (a non-empty missing[])',
        (root) => {
          const missing = fieldOf(root, 'missing');
          return Array.isArray(missing) && missing.length > 0;
        },
      ],
      [
        'a refusal under RIG_UNATTENDED (refused present, missing empty)',
        (root) => {
          const missing = fieldOf(root, 'missing');
          return hasKey(root, 'refused') && Array.isArray(missing) && missing.length === 0;
        },
      ],
      ['a doctor run (a checks[] array)', (root) => Array.isArray(fieldOf(root, 'checks'))],
      [
        'a memory load (counters and budget)',
        (root) => hasKey(root, 'counters') && hasKey(root, 'budget'),
      ],
    ];
    for (const [description, matches] of shapes) {
      expect(
        roots.some((root) => matches(root)),
        `no fixture illustrates ${description}`,
      ).toBe(true);
    }
  });

  it('obeys its own doctor record rule in the doctor fixture', async () => {
    const roots = fixtureRoots(await loadContract());
    const doctorRuns = roots.filter((root) => Array.isArray(fieldOf(root, 'checks')));
    expect(doctorRuns.length, 'no fixture carries a doctor checks[] array').toBeGreaterThan(0);
    for (const run of doctorRuns) {
      const checks = fieldOf(run, 'checks') as unknown[];
      checks.forEach((record, index) => {
        const status = fieldOf(record, 'status');
        for (const field of ['id', 'status', 'detail'] as const) {
          expect(
            hasKey(record, field),
            `doctor fixture record #${index + 1} has no ${field}, which the contract puts on every record`,
          ).toBe(true);
        }
        expect(
          ['ok', 'warn', 'fail'],
          `doctor fixture record #${index + 1} has status ${JSON.stringify(status)}, outside the closed set`,
        ).toContain(status);
        expect(
          hasKey(record, 'fix'),
          `doctor fixture record #${index + 1} has status ${JSON.stringify(status)}, so fix must be ${status === 'ok' ? 'omitted' : 'present'}`,
        ).toBe(status === 'warn' || status === 'fail');
      });
      const anyFail = checks.some((record) => fieldOf(record, 'status') === 'fail');
      expect(
        fieldOf(run, 'status') === 'fail',
        anyFail
          ? "a doctor fixture has a failing record but its top-level status is not 'fail'"
          : "a doctor fixture has no failing record but its top-level status is 'fail'",
      ).toBe(anyFail);
    }
  });

  it('leaves degradation empty, because contract 1.0 enumerates no member', async () => {
    const roots = fixtureRoots(await loadContract());
    const carriers = roots.filter((root) => hasKey(root, 'degradation'));
    expect(carriers.length, 'no fixture carries a degradation field').toBeGreaterThan(0);
    for (const root of carriers) {
      expect(
        fieldOf(root, 'degradation'),
        'a fixture emits a degradation member, but contract 1.0 enumerates none',
      ).toEqual([]);
    }
  });
});

describe('the conformance section stays true about this repository', () => {
  const conformance = async () => section(await loadContract(), /^#{2,6}\s+.*Conformance today\b/i);

  it('promises that every row names the test that pins it', async () => {
    expectStatement(
      await conformance(),
      'the conformance section must promise that each row is pinned by a named test',
      "Every row below names the test that pins it, and each row's reach is the reach of its test and no wider",
    );
  });

  it('reports that nothing in this repository reads RIG_UNATTENDED', async () => {
    // Per root, not over the union: a union non-empty check leaves the row
    // silently unbacked the day one of the three directories is renamed.
    const roots: readonly (readonly [string, string])[] = [
      [path.join(repoRoot, '.claude', 'scripts'), '.mjs'],
      [path.join(repoRoot, '.claude', 'hooks'), '.mjs'],
      [path.join(repoRoot, 'packages', 'cli', 'src'), '.ts'],
    ];
    const files: string[] = [];
    for (const [dir, extension] of roots) {
      const found = await walkSources(dir, extension);
      expect(
        found.length,
        `${asRepoPath(dir)} holds no ${extension} file — the row's reach has silently shrunk`,
      ).toBeGreaterThan(0);
      files.push(...found);
    }
    const readers: string[] = [];
    for (const file of files) {
      const source = stripLineComments(await readFile(file, 'utf8'));
      if (READS_RIG_UNATTENDED.test(source)) readers.push(asRepoPath(file));
    }
    expect(
      readers,
      `RIG_UNATTENDED now has a reader (${readers.join(', ')}) — the conformance row is stale`,
    ).toEqual([]);
    expect(
      normalizeProse(await conformance()),
      'the conformance section must record that no reader of RIG_UNATTENDED exists',
    ).toMatch(
      /\b(no reader|nothing)\b[\s\S]{0,80}RIG_UNATTENDED|RIG_UNATTENDED[\s\S]{0,160}\b(nothing|no reader|not read|unread)\b/i,
    );
  });

  it('detects every spelling of a RIG_UNATTENDED read, and no bare mention of the name', async () => {
    // The row above fails in the FALSE-GREEN direction: a read the pattern
    // cannot see reads as "nothing in this repository reads it". Four of these
    // six were measured slipping past an earlier form of the pattern, so each
    // is pinned here rather than trusted to the row, which is green either way.
    const READS = [
      'const flag = process.env.RIG_UNATTENDED;',
      'const flag = process.env?.RIG_UNATTENDED;',
      "const flag = env['RIG_UNATTENDED'];",
      'const { RIG_UNATTENDED } = process.env;',
      'const { RIG_UNATTENDED = {} } = process.env;',
      "if (Object.hasOwn(process.env, 'RIG_UNATTENDED')) return true;",
      "if (Object.hasOwn(env, 'RIG_UNATTENDED')) return true;",
      "if ('RIG_UNATTENDED' in process.env) return true;",
      "if (process.env.hasOwnProperty('RIG_UNATTENDED')) return true;",
    ] as const;
    for (const source of READS) {
      expect(
        READS_RIG_UNATTENDED.test(stripLineComments(source)),
        `the detector misses a real read (${source}), so the conformance row would go falsely green`,
      ).toBe(true);
    }
    // The other direction: a mention is not a read, or the row goes red on the
    // documents and comments that discuss the variable without consulting it.
    const MENTIONS = [
      '// RIG_UNATTENDED is a command-surface variable',
      'const message = "set RIG_UNATTENDED before an unattended run";',
      'const other = process.env.RIG_UNATTENDED_HOME;',
    ] as const;
    for (const source of MENTIONS) {
      expect(
        READS_RIG_UNATTENDED.test(stripLineComments(source)),
        `the detector reads a bare mention as a read (${source}), which is a false red on ordinary prose`,
      ).toBe(false);
    }
  });

  it('reports that the rig bin has no --json flag', async () => {
    const cli = await readFile(path.join(repoRoot, 'packages', 'cli', 'src', 'index.ts'), 'utf8');
    // Limit: this reads `index.ts` alone and recognises one spelling — a
    // `parseArgs` option named `json`. A `--json` flag added another way (a
    // hand-rolled argv scan, a string compared against '--json'), or declared
    // in another module under packages/cli/src, is invisible to it.
    expect(
      cli,
      'the rig bin now declares a json parseArgs option — the conformance row is stale',
    ).not.toMatch(/\bjson:\s*\{\s*type:/);
    expect(
      normalizeProse(await conformance()),
      'the conformance section must record that the rig bin has no --json flag',
    ).toMatch(/rig bin[\s\S]{0,200}--json|--json[\s\S]{0,200}rig bin/i);
  });

  it('reports that the rig bin answers --version with no contract handshake', async () => {
    // The row now claims the absence "anywhere under packages/cli/src", so the
    // assertion walks the whole tree rather than reading index.ts alone.
    const sources = await walkSources(path.join(repoRoot, 'packages', 'cli', 'src'), '.ts');
    expect(
      sources.length,
      'found no rig bin sources to search for contractVersion',
    ).toBeGreaterThan(0);
    const namers: string[] = [];
    for (const file of sources) {
      if (/\bcontractVersion\b/.test(await readFile(file, 'utf8'))) namers.push(asRepoPath(file));
    }
    expect(
      namers,
      `the rig bin now names contractVersion (${namers.join(', ')}) — the conformance row is stale`,
    ).toEqual([]);
    expect(
      normalizeProse(await conformance()),
      'the conformance section must record that --version answers with no handshake object',
    ).toMatch(/--version[\s\S]{0,80}\bhandshake\b/i);
  });

  it("reports that the rig bin's only exit codes are 0 and 1", async () => {
    const sources = await walkSources(path.join(repoRoot, 'packages', 'cli', 'src'), '.ts');
    expect(sources.length, 'found no rig bin sources to search for an exit code').toBeGreaterThan(
      0,
    );
    // Every route out of the CLI is a `return <n>` from a command function, a
    // `process.exit(<n>)` or an assignment to `process.exitCode`. A literal
    // outside {0, 1} anywhere in those three spellings makes the row stale.
    //
    // Two known weaknesses, so nobody reads this walk as wider than it is:
    //   - it is not scoped to exit paths, so ANY unrelated `return 2` in the
    //     CLI (an index, a length, a comparator) fires a false red;
    //   - it is blind to a code that is not a literal at the match site — one
    //     thrown inside an error object, or held in a variable or a constant
    //     (`return EXIT_USAGE`).
    const WIDER_EXIT = /(?:return|process\.exit\(|process\.exitCode\s*=)\s*([2-9]\d*)\b/g;
    const wider: string[] = [];
    for (const file of sources) {
      const source = await readFile(file, 'utf8');
      for (const hit of source.matchAll(WIDER_EXIT)) {
        wider.push(`${asRepoPath(file)}: ${hit[0]}`);
      }
    }
    expect(
      wider,
      `the rig bin now has an exit code outside {0, 1} (${wider.join(', ')}) — the conformance row is stale`,
    ).toEqual([]);
    expect(
      normalizeProse(await conformance()),
      'the conformance section must record that the only exit codes are 0 and 1',
    ).toMatch(/exit codes are 0 and 1|exit code outside 0 and 1/i);
  });

  it("reports the doctor marks the contract's status set has no slot for", async () => {
    // Behavioural, not comment-text: `verdictOf` is exported, so the claim that
    // an `unknown` resolves to a caution-level verdict rather than to a pass is
    // pinned by calling it. `doctor.mjs` runs nothing on import — its CLI body
    // sits behind an `invokedDirectly()` guard.
    const doctorModulePath = path.join(repoRoot, '.claude', 'scripts', 'doctor.mjs');
    const { verdictOf } = await import(pathToFileURL(doctorModulePath).href);
    expect(
      typeof verdictOf,
      '.claude/scripts/doctor.mjs no longer exports verdictOf — the conformance row is stale',
    ).toBe('function');
    expect(
      verdictOf(['unknown']),
      'doctor no longer resolves an `unknown` mark to CAUTION — the conformance row is stale',
    ).toBe('CAUTION');
    expect(
      verdictOf(['FAIL']),
      'doctor no longer resolves a FAIL mark to STOP — the conformance row is stale',
    ).toBe('STOP');
    expect(
      verdictOf(['GO']),
      'doctor no longer resolves a clean run to GO — the conformance row is stale',
    ).toBe('GO');

    // `exempt` has no verdict of its own to call, so it stays a source read.
    const doctorScript = await readFile(doctorModulePath, 'utf8');
    expect(
      doctorScript,
      'doctor.mjs no longer carries the `exempt` mark — the conformance row is stale',
    ).toMatch(/\bexempt\b/);

    // The row cites the doctor suite by test name; a rename there leaves a dead
    // pointer that nothing else notices.
    const doctorSuite = await readFile(
      path.join(repoRoot, 'test', 'template', 'doctor.test.ts'),
      'utf8',
    );
    expect(
      doctorSuite,
      'test/template/doctor.test.ts no longer carries the test the conformance row cites — the pointer is dead',
    ).toContain(
      'an unknown-ownership hook without a test is unknown, and the run is CAUTION not GO',
    );

    const text = normalizeProse(await conformance());
    for (const mark of ['unknown', 'exempt'] as const) {
      expect(text, `the conformance section does not name doctor's \`${mark}\` mark`).toMatch(
        new RegExp(`\\b${mark}\\b`),
      );
    }
    expect(
      text,
      "the conformance section must hand doctor's extra marks to the owner's acceptance list",
    ).toMatch(/\bacceptance list\b/i);
  });

  it('reports that exit 2 is already spoken for in the internal script fleet', async () => {
    const queue = await readFile(
      path.join(repoRoot, '.claude', 'scripts', 'queue', 'index.mjs'),
      'utf8',
    );
    const revalidate = await readFile(
      path.join(repoRoot, '.claude', 'scripts', 'revalidate.mjs'),
      'utf8',
    );
    // queue/index.mjs exits 2 literally; revalidate.mjs exits 2 through a
    // conditional (`? 2 : 0`), so both spellings count as a live meaning.
    //
    // Limit: this counts OCCURRENCES, not distinct meanings. Two exits on the
    // same meaning satisfy it exactly as two on different ones, so the "spends
    // it twice over" half of the row rests on the reading of the two call
    // sites, not on this count.
    const EXITS_TWO = /process\.exit\(\s*(?:[^)]*\?\s*)?2\b/g;
    expect(
      [...queue.matchAll(EXITS_TWO)].length,
      'the queue CLI no longer spends exit 2 on two meanings of its own — the conformance row is stale',
    ).toBeGreaterThanOrEqual(2);
    expect(
      revalidate,
      'revalidate.mjs no longer exits 2 — the conformance row about exit 2 is stale',
    ).toMatch(EXITS_TWO);
    expect(
      normalizeProse(await conformance()),
      'the conformance section must say exit 2 already has live meanings in the internal fleet, which is why Scope carves it out',
    ).toMatch(/exit 2[\s\S]{0,240}(already|spoken for|live)/i);
  });

  it('reports the third script that pins the opposite exit convention', async () => {
    // The two comment-fragment matches that used to sit here are gone. They
    // read `verdict.mjs`'s own PROSE about its exit convention, which is a
    // claim rather than the behaviour; the row's real backing is the named
    // behavioural test below, and a comment that drifted while the test still
    // passed would have gone red for nothing.
    //
    // The row cites the behavioural test by name. A rename there is what turns
    // the citation into a dead pointer, and only this assertion sees it.
    const verdictSuite = await readFile(
      path.join(repoRoot, 'test', 'template', 'verdict.test.ts'),
      'utf8',
    );
    expect(
      verdictSuite,
      'test/template/verdict.test.ts no longer carries the test the conformance row cites — the pointer is dead',
    ).toContain('exits 0 on a well-formed HOLD — a refused change is not a broken check');
    expect(
      normalizeProse(await conformance()),
      'the conformance section must name the script that pins the opposite convention',
    ).toMatch(/verdict\.mjs/);
  });
});

describe('what the document does not cite', () => {
  it('names its absent referents instead of citing them', async () => {
    const notCited = section(await loadContract(), /^#{2,6}\s+.*(does not cite|not cited)/i);
    expectTerms(notCited, [
      ['the absent-referent section does not name rp-jira-plan.md', /rp-jira-plan\.md/],
      ['the absent-referent section does not name [A4]', /\[A4\]/],
    ]);
  });
});
