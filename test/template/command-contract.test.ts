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

  it('enumerates the covered surface once, and says where', async () => {
    // Measured: deleting this paragraph left the suite green. It replaced a
    // second spelling of the covered surface that had already drifted from the
    // first, so the paragraph IS the fix for that drift — unpinned, the drift
    // simply comes back.
    expectStatement(
      section(await loadContract(), /^#{2,6}\s+.*Scope\b/i),
      'Scope must point at the single enumeration of the covered surface rather than restating it',
      'What the contract covers, once accepted, is enumerated once — in `## Stability and versioning`, which is also where the bump rules for changing it live.',
    );
  });

  it('records the scope as an owner ruling rather than as an open assumption', async () => {
    const scope = section(await loadContract(), /^#{2,6}\s+.*Scope\b/i);
    // The sentence above was carried as a *labelled assumption* while the
    // question was open. It was settled on the item on 2026-08-31, so what the
    // section must now say is who decided it and when — an assumption and a
    // ruling are read differently by everyone downstream.
    expectStatement(
      scope,
      'Scope must attribute the boundary to the owner ruling that settled it',
      'That sentence is an **owner ruling**, recorded on RP-17 on 2026-08-31',
    );
    expect(
      normalizeProse(scope),
      'Scope still calls the boundary a labelled assumption, which the owner ruling replaced',
    ).not.toMatch(/labelled assumption/i);
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
    // Pinned verbatim: both words, and the claim that they are contract.
    //
    // This paragraph used to add that it was "the one rule in this document
    // that turns on a field's values rather than its keys, and the stability
    // section covers keys". That was false in both halves — the doctor status
    // set, the lifecycle vocabulary and degradation[]'s members all turn on
    // values, and the stability section names enum members — and the suite was
    // pinning the false sentence verbatim. So the claim is gone and the
    // paragraph points at the value-domain rule instead.
    expectStatement(
      content,
      'the Exit codes section must declare the discriminator values contract and enumerate them',
      'and **its values are contract**: on exit 3 the closed set is `prerequisites-unmet` and `refused-unattended`.',
    );
    expect(
      normalizeProse(content),
      'the Exit codes section still claims to be the only rule that turns on a value rather than a key',
    ).not.toMatch(/the one rule in this document that turns on a field's _?values_?/i);
    expectStatement(
      content,
      'the Exit codes section must make a third discriminator value a minor bump rather than silence',
      // Both directions now, and both derived from the value-domain rule rather
      // than asserted here: a set that can only ever grow says nothing about
      // the change a caller is actually broken by.
      'adding a third value is a minor bump and removing one is a major.',
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
    // The three word-presence regexes this replaced were polarity-blind: a
    // section saying "a mutating command need not offer --dry-run" carries
    // `--dry-run` exactly as happily as one that requires it, and the suite
    // stayed green through that inversion when it was measured. These three
    // back item bullets, so each is pinned to the sentence that states it.
    const mutations = section(await loadContract(), /^#{2,6}\s+.*Mutat/i);
    expectStatement(
      mutations,
      'the Mutations section must say how many obligations a mutating command carries',
      'is a **mutating command**, and it carries three obligations:',
    );
    for (const [description, statement] of [
      [
        'the Mutations section must oblige a declared side-effect list, and say what an undeclared one is',
        'The documentation names what it writes, creates, deletes or sends. A side effect the documentation does not name is a defect, not a feature.',
      ],
      [
        'the Mutations section must oblige --dry-run and require the same payload shape as the real run',
        'The command performs none of its declared side effects and reports what it would have done, in the same payload shape the real run emits.',
      ],
      [
        'the Mutations section must oblige a stated idempotence property and refuse to leave it unsaid',
        "Both answers are acceptable; leaving it unsaid is not, because the caller's retry policy depends on it.",
      ],
    ] as const) {
      expectStatement(mutations, description, statement);
    }
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

  it('puts all four record fields on every record, with fix empty when there is nothing to do', async () => {
    // The rule this replaced — `fix` omitted on a passing record — was the
    // document's own reading rather than the item's, and it was on the
    // acceptance list for exactly that reason. The item names a FOUR-field
    // record; amendment (f) restricts consumers to `status`, so a consumer
    // never reads `fix` and an empty one costs it nothing. The document's own
    // one-shape principle for `degradation` decides the rest.
    expectStatement(
      await doctor(),
      'the Doctor section must put all four fields on every record and make `fix` empty rather than absent',
      'All four fields are present on every record. `fix` is an empty string when the check has nothing for a human to do',
    );
  });

  it('says what ok means, so a check that could not run is never reported as one', async () => {
    // The status set is closed at three words, and the project's own doctor
    // answers two more. Ruling 1 of 2026-08-31 puts that doctor outside this
    // contract, so its marks are not a conformance target — but a conforming
    // doctor still needs to know what to answer for a check it could not run,
    // and that follows from what `ok` means rather than from a fourth mark.
    expectStatement(
      await doctor(),
      'the Doctor section must define ok as "the check ran and passed" and exclude an unrunnable check from it',
      '`ok` means the check ran and passed. A check that could not run is therefore never `ok`',
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
    // The four proximity arms this replaced searched the WHOLE memory section,
    // where `load --json` also appears in the degradation paragraph — so the
    // `load --json` verb could be deleted from the set while the arm stayed
    // green and the verbatim sentence below still said four. Measured. The set
    // is a list, so the assertion reads the list: its bullets, in the
    // subsection that declares it, and nothing else in the section counts.
    const verbSet = section(content, /^#{2,6}\s+.*foundation verb set\b/i);
    const bullets = verbSet
      .split('\n')
      .filter((line) => /^-\s/.test(line))
      .map((line) => line.replace(/^-\s*/, ''));
    expect(
      bullets.length,
      `the foundation verb set is declared closed at four entries but lists ${bullets.length}`,
    ).toBe(4);
    for (const [description, verb] of [
      ['the foundation verb set omits --version --json', '`--version --json`'],
      ['the foundation verb set omits doctor --json', '`doctor --json`'],
      ['the foundation verb set omits load --json', '`load --json`'],
      ['the foundation verb set omits --dry-run on mutating commands', '`--dry-run`'],
    ] as const) {
      expect(
        bullets.some((bullet) => bullet.startsWith(verb)),
        description,
      ).toBe(true);
    }
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
    // The proximity match this replaced was polarity-blind over the whole
    // memory section: "Lifecycle transition commands do not refuse under
    // RIG_UNATTENDED and never exit 3" carries both tokens the same distance
    // apart, and the suite stayed green through exactly that inversion when it
    // was measured. Amendment (d) is a normative rule, so it gets its sentence.
    expectStatement(
      await memory(),
      'the memory section must state amendment (d) verbatim',
      'Lifecycle transition commands refuse under RIG_UNATTENDED and exit 3.',
    );
  });

  it('makes the load selection budget a per-invocation input, never core-global config', async () => {
    expectStatement(
      await memory(),
      'the memory section must state the selection budget rule verbatim',
      'The selection budget is a per-invocation input, and never core-global configuration.',
    );
  });

  it('fixes the budget default at the value both shipped backends measurably carry', async () => {
    const memorySection = await memory();
    // Amendment (e) calls the default contract-defined, and the owner ruling of
    // 2026-08-31 refuses to let it stay deferred. The number is not chosen: it
    // is the constant both Memory MVP backends hold, so the document has to
    // carry the number AND where it was read, or a later reader cannot tell a
    // measurement from a preference.
    expectStatement(
      memorySection,
      'the memory section must state the budget default as a number',
      'The default is **8192 bytes**.',
    );
    expectTerms(normalizeProse(memorySection), [
      [
        'the budget default names neither backend constant it was read from',
        /INJECTION_BUDGET_BYTES/,
      ],
      ['the budget default cites no source file for the POSIX backend', /load\.sh:14/],
      ['the budget default cites no source file for the PowerShell backend', /load\.ps1:5/],
      [
        "the budget default does not record the owner's 2026-08-23 decision not to raise it",
        /2026-08-23/,
      ],
    ]);
  });

  it('states the budget unit and the behaviour at the limit, not the number alone', async () => {
    // A byte count with no unit is three different budgets: whole file, body,
    // or characters. The two backends agree on one of them, and they agree on
    // what happens to a record that does not fit — it is skipped, never cut.
    expectStatement(
      await memory(),
      'the memory section must define the unit the budget counts and what happens at the limit',
      'A record whose body does not fit the remainder is skipped and counted, never truncated',
    );
    expect(
      normalizeProse(await memory()),
      'the memory section does not say the budget counts UTF-8 bytes of a record body',
    ).toMatch(/UTF-8 bytes of a record's body/i);
  });

  it('fixes the allowed range at 0 to 8192 inclusive, the ceiling being the default', async () => {
    // The owner ruling of 2026-08-31 closed amendment (e). The ceiling reuses
    // the measured default deliberately: a per-invocation input may lower the
    // cap and may not raise it, so nothing here can enlarge what a session
    // reads beyond what the backends already permit.
    expectStatement(
      await memory(),
      'the memory section must state the allowed range and that the input is an integer',
      '**The allowed range is 0 to 8192 inclusive**, and the input is an integer count',
    );
    expectStatement(
      await memory(),
      'the memory section must say the per-invocation input may lower the cap and never raise it',
      'a per-invocation input may **lower** the cap and may not raise it',
    );
  });

  it('pins the two clauses of the ruling a proximity match would have let drift', async () => {
    // Both were measured green under inversion at the last gate round: the
    // per-invocation reset and the omitted-means-default rule. They are clauses
    // of an owner ruling, so each gets the sentence that states it.
    const memorySection = await memory();
    expectStatement(
      memorySection,
      'the memory section must say the budget resets to zero on every invocation',
      'the count starts at zero on every invocation',
    );
    expectStatement(
      memorySection,
      'the memory section must say what an omitted budget means',
      'Omitted, the budget is the default: 8192.',
    );
  });

  it('makes an out-of-range budget an invocation error rather than a silent clamp', async () => {
    // The failure mode a clamp creates: the caller asked for one run and got a
    // different one that looks like the one it asked for. The exit-code table
    // already has a word for an invocation a bin will not accept.
    const memorySection = normalizeProse(await memory());
    expectStatement(
      await memory(),
      'the memory section must refuse a negative, non-integer or oversized budget with exit 2',
      'A value that is negative, not an integer, or above 8192 is an **invocation error**: exit 2',
    );
    expect(
      memorySection,
      'the memory section does not forbid clamping an out-of-range budget',
    ).toMatch(/never silently clamped/i);
    expect(
      memorySection,
      'the memory section does not say 0 is a valid budget, nor what it means',
    ).toMatch(/`0` is valid[\s\S]{0,120}no record bodies/i);
  });

  it('says the ceiling is a ruling, and rests that on cited lines rather than on a probe', async () => {
    // This used to cite a one-off sandbox probe — figures with no test, no
    // command and no revision behind them, in a document whose own rule says a
    // claim about a mechanism is a pointer or it is deleted. The figures are
    // gone; the conclusion survives because it follows from lines the section
    // already cites, where each backend assigns its budget from the constant
    // and validates nothing.
    const memorySection = await memory();
    expectStatement(
      memorySection,
      'the memory section must say the ceiling is a decision rather than something a backend enforces',
      '⚠ **The ceiling is a decision, not a reading.**',
    );
    expectTerms(normalizeProse(memorySection), [
      [
        'the no-bound claim cites no line in the POSIX backend where the budget is assigned unvalidated',
        /load\.sh:14-15/,
      ],
      [
        'the no-bound claim cites no line in the PowerShell backend where the budget is assigned unvalidated',
        /load\.ps1:5-6/,
      ],
      [
        'the memory section no longer says why a reader must not read the ceiling as enforced',
        /reader who assumed the backends already refuse a larger value would be wrong/i,
      ],
    ]);
  });

  it('says the per-invocation input is implemented nowhere, and discloses its cross-repo evidence', async () => {
    const memorySection = await memory();
    expectStatement(
      memorySection,
      'the memory section must say nothing implements the input yet and that RP-17 does not ask it to',
      '**Nothing implements this input today, and RP-17 does not ask anything to.**',
    );
    // The default's citations point into another repository, which this suite
    // cannot reach. An undisclosed unbackable claim is the exact shape
    // `.claude/rules/invariants.md` calls UNMEASURED, so the document discloses
    // it rather than letting a reader infer a pin that does not exist.
    expect(
      normalizeProse(memorySection),
      'the memory section does not disclose that its budget evidence is cross-repository and unpinnable by this suite',
    ).toMatch(/cross-repository[\s\S]{0,400}cannot pin any of it/i);
  });

  it('stops deferring the budget, now that both halves of amendment (e) are fixed', async () => {
    const notCited = normalizeProse(
      section(await loadContract(), /^#{2,6}\s+.*(does not cite|not cited)/i),
    );
    for (const [description, pattern] of [
      [
        'the absent-referent section still defers the budget bounds, which the ruling fixed',
        /load selection budget'?s allowed bounds/i,
      ],
      [
        'the absent-referent section still defers the budget default, which this version fixes',
        /load selection budget'?s default and bounds/i,
      ],
    ] as const) {
      expect(notCited, description).not.toMatch(pattern);
    }
  });

  it('closes the degradation enum per version and enumerates its 1.0 members', async () => {
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
    // An empty enum satisfied (i) in form and made the field unusable, which is
    // what the owner ruling of 2026-08-31 calls a silent deferral. The two
    // members below are not words picked here: they are the two degradations
    // both shipped backends already count, in the backends' own spelling.
    expect(
      content,
      'the memory section does not say how many members contract 1.0 enumerates',
    ).toContain('**Contract 1.0 enumerates two**');
    expectTerms(content, [
      ['the degradation enum does not name its budget member', /`budget-skipped`/],
      ['the degradation enum does not name its validation member', /`invalid`/],
    ]);
  });

  it('pins the cross-repository evidence by its polarity, not only by its presence', async () => {
    // Measured: inverting the counter-line clause to "which print neither
    // `budget-skipped=` nor `invalid=` among five counters" left the suite
    // green. The citation was pinned; what it asserts was not. The document
    // discloses that this suite cannot reach the backend — that is a reason to
    // pin the SENTENCE tightly, not a licence to leave it loose.
    expectStatement(
      await memory(),
      'the degradation enum must state what the cited counter line prints, not merely that it exists',
      "in those backends' own spelling from the counter line they write to stderr (`shared-memory/load.sh:56-57` and `load.ps1:53` in `claude-config@b1bfb6e`, which print `budget-skipped=` and `invalid=` among five counters)",
    );
  });

  it('rests the no-bound claim on the cited assignment, in the direction it claims', async () => {
    // Measured: "validates nothing" -> "validates the range" left the suite
    // green, which would have turned the load-bearing sentence into its own
    // negation while the ceiling still called itself a decision.
    expectStatement(
      await memory(),
      'the memory section must say each backend assigns its budget from the constant and validates nothing',
      'No implementation enforces any bound at all, and that is visible in the lines already cited rather than in a probe: each backend assigns its working budget straight from the constant and validates nothing — `load.sh:14-15` and `load.ps1:5-6`, same revision — so there is no code path anywhere today that refuses a value for being out of range.',
    );
  });

  it('cites the decision behind the default, and the two documents that record it', async () => {
    // Measured: deleting the `PLAN.md:264` citation, and stripping the line
    // number from the README citation, both left the suite green — the exact
    // shape prose-reviewer blocked at round 2, reintroduced by the remedy.
    const memorySection = await memory();
    expectStatement(
      memorySection,
      'the memory section must cite where the 2026-08-23 do-not-raise decision is recorded',
      'It is also a number the owner has decided about once already: `PLAN.md:264` records the decision of **2026-08-23**, taken against measurements over four real memory trees, _not_ to raise it',
    );
    expectStatement(
      memorySection,
      'the memory section must cite the two supporting documents by file and line',
      "that repository's `README.md:124` states it to a reader as the 8 KB cap a session's injected event bodies are held to, and its `docs/decisions/mvp-completion.md:90-93` records the same figure beside a dated measurement of a real tree.",
    );
  });

  it('keeps the cross-repository disclosure covering claims, not only citations', async () => {
    // Measured: narrowing it back to "Every `claude-config` citation" left the
    // suite green. That scope is precisely what prose-reviewer's round-2
    // blockers turned on — a disclosure that covers sourced claims and leaves
    // unsourced ones uncovered moves the boundary instead of closing it.
    expectStatement(
      await memory(),
      'the disclosure must cover every claim in the section, not only the ones carrying a citation',
      "Every claim and every `claude-config` citation in this section — the budget constant above, and the counter line and dedup ordering behind `degradation[]` below — was read in that repository at revision `b1bfb6e`, and **this repository's suite cannot pin any of it**.",
    );
  });

  it('excludes the one measured degradation no backend can observe', async () => {
    // A dedup drop is real and is counted by nothing — `load.sh` skips a seen
    // `sourceKey` before the eligible count. Naming it in the enum would put a
    // member in the contract that no conforming bin could ever emit.
    expect(
      normalizeProse(await memory()),
      'the memory section does not say why the dedup drop is left out of the enum',
    ).toMatch(/`sourceKey` was already seen[\s\S]{0,200}counters/i);
  });

  it('cites the backend evidence behind the degradation enum, and discloses it too', async () => {
    // The prose-reviewer blocker. The enum rests on two claims about another
    // repository's running code — the spelling of the counter line, and the
    // dedup skip landing before the eligible count — and they decide which
    // members RP-18 must emit. The budget subsection fifteen lines earlier
    // meets the `.claude/rules/invariants.md` standard for exactly this class
    // of claim; this one carried neither citation nor disclosure.
    const text = normalizeProse(await memory());
    expectTerms(text, [
      ['the degradation enum does not cite the POSIX counter line', /load\.sh:56/],
      ['the degradation enum does not cite the PowerShell counter line', /load\.ps1:53/],
      [
        'the degradation enum does not cite the dedup skip against the eligible count',
        /load\.sh:37/,
      ],
      [
        'the degradation evidence names no revision, so its line numbers cannot be reproduced',
        /b1bfb6e/,
      ],
    ]);
    // And the disclosure has to reach this evidence, not only the budget's.
    // Scoped to one subsection it left the neighbouring claims uncovered.
    expect(
      text,
      'the cross-repository disclosure is still scoped to the budget subsection alone',
    ).not.toMatch(/The budget evidence in this section is\s+\*\*cross-repository\*\*/i);
    expect(text, 'no cross-repository disclosure covers the whole memory section').toMatch(
      /every `claude-config` citation in this section[\s\S]{0,200}cannot pin/i,
    );
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

  it('covers subcommand names, documented flags, exit codes, JSON keys and value domains', async () => {
    // The surface used to stop at keys, which made the budget's own
    // "raising the maximum later is a minor bump" underivable — the residual
    // rule classified it as a PATCH — and left the breaking direction with no
    // answer at all. Every closed value set in this document is code a caller
    // writes against, so the surface has to name them.
    expectStatement(
      await stability(),
      'the Stability section must name the covered surface verbatim, value domains included',
      'What is covered: subcommand names, documented flags, exit codes, the JSON keys named in this document, and the **value domains** this document closes',
    );
    expectTerms(normalizeProse(await stability()), [
      ['the covered surface omits the exit-3 result set', /exit-3 `result` set/i],
      ['the covered surface omits the doctor status set', /doctor `status` set/i],
      ['the covered surface omits the lifecycle states', /lifecycle states/i],
      ["the covered surface omits degradation[]'s members", /`degradation\[\]`'?s members/i],
      ["the covered surface omits the load budget's allowed range", /budget'?s allowed range/i],
    ]);
  });

  it('answers both directions for a closed value domain, not just the widening one', async () => {
    // One answer per direction. Widening is the case the owner's budget ruling
    // anticipated; narrowing is the one a caller can actually be broken by, and
    // it had no answer here at all.
    const text = await stability();
    expectStatement(
      text,
      'the Stability section must make widening a closed value domain a minor bump',
      'Widening a closed value domain is a minor bump too',
    );
    expectStatement(
      text,
      'the Stability section must make narrowing a closed value domain a major bump',
      'Narrowing a closed value domain is a major bump',
    );
    expect(
      normalizeProse(text),
      'the Stability section does not name a raised budget maximum as the widening case, nor a lowered one as the narrowing case',
    ).toMatch(/raised budget maximum[\s\S]{0,600}lowered budget maximum/i);
  });

  it('makes the budget ceiling rule derivable from the stability rule it cites', async () => {
    // Twice now the remedy for "a proximity match that survives its own
    // inversion" has been another proximity match. The one this replaces —
    // /Raising the maximum[\s\S]{0,200}Stability and versioning/ — stayed green
    // when the sentence was rewritten to call a RAISE a narrowing and a MAJOR
    // bump, which contradicts both the stability section and the owner ruling.
    // A sentence that assigns a direction to a bump is pinned verbatim, or it
    // is not pinned.
    expectStatement(
      section(await loadContract(), /^#{2,6}\s+.*Memory\b/i),
      'the budget section must name the bump for each direction, and cite the rule that carries it',
      'Raising the maximum later is a widening of a closed value domain, which `## Stability and versioning` makes a **minor** bump — and lowering it, or lowering the default, is a narrowing, which that same rule makes a **major** one.',
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

describe('what acceptance settled, and that nothing is left open', () => {
  const settled = async () =>
    section(await loadContract(), /^#{2,6}\s+.*What acceptance settled\b/i);

  it('leaves no question open, and says so as a count it can be checked against', async () => {
    // The count used to be stated in prose and again as a numbered list, and
    // the two could drift. They still can, so they are still checked against
    // each other — the count is now zero, and a numbered entry appearing here
    // is exactly the drift that check exists for.
    expectStatement(
      await settled(),
      'the section must state that acceptance left nothing open',
      'Nothing in this document is left for acceptance to settle.',
    );
    const numbered = (await settled()).split('\n').filter((line) => /^\d+\.\s/.test(line));
    expect(
      numbered.map((line) => line.slice(0, 60)),
      'the section says nothing is open but carries a numbered open question',
    ).toHaveLength(0);
  });

  it('counts the entries it settled, and the count matches the list', async () => {
    // The section said "four" over five bullets, and the status line repeated
    // the four. The fifth is the scope assumption, which the list's own first
    // bullet calls a question the document carried — so five is the number, and
    // it is derived from the bullets rather than asserted beside them.
    const text = await settled();
    const bullets = text.split('\n').filter((line) => /^-\s/.test(line));
    const claimed = /carried (one|two|three|four|five|six|seven) entries\b/i.exec(
      normalizeProse(text),
    );
    expect(claimed, 'the settled section states no count of the entries it carried').not.toBe(null);
    const WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'] as const;
    expect(
      WORDS.indexOf(claimed![1]!.toLowerCase() as (typeof WORDS)[number]) + 1,
      `the settled section claims a different number of entries than the ${bullets.length} it lists`,
    ).toBe(bullets.length);
    // And the status line names the same number, or the two drift again.
    expect(
      normalizeProse(await loadContract()),
      'the status line does not carry the same entry count, in the same noun, as the settled section',
    ).toMatch(new RegExp(`Status:[^]{0,320}${claimed![1]!} entries`, 'i'));
  });

  it('records every question it once carried, and the ruling that closed each', async () => {
    const text = normalizeProse(await settled());
    expectTerms(text, [
      ['the settled list omits the scope question', /which tools the contract binds/i],
      ["the settled list omits doctor's two extra marks", /doctor'?s two extra marks/i],
      ['the settled list omits the degradation members question', /`degradation\[\]`'?s members/i],
      ['the settled list omits the doctor fix presence rule', /`fix` presence rule/i],
      ['the settled list omits the budget default and bounds', /budget'?s default and bounds/i],
      ['the settled list dates none of the rulings that closed the questions', /2026-08-31/],
    ]);
  });

  it('leaves no dangling pointer to the section acceptance used to be asked in', async () => {
    // The status line and the memory section both pointed at "## Open questions
    // for acceptance". Renaming a heading without its referrers is how a
    // document acquires a pointer to a section that is not there.
    const content = await loadContract();
    expect(
      content,
      'the document still points at a "## Open questions for acceptance" section it no longer has',
    ).not.toMatch(/Open questions for acceptance/);
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
        for (const field of ['id', 'status', 'detail', 'fix'] as const) {
          expect(
            hasKey(record, field),
            `doctor fixture record #${index + 1} has no ${field}, which the contract puts on every record`,
          ).toBe(true);
        }
        expect(
          ['ok', 'warn', 'fail'],
          `doctor fixture record #${index + 1} has status ${JSON.stringify(status)}, outside the closed set`,
        ).toContain(status);
        // The presence rule is now "always present, empty when there is
        // nothing to do", so what varies with status is the CONTENT. A
        // non-empty fix on a passing record would say a passed check needs
        // remedying; an empty one on a failure would leave a human nowhere.
        expect(
          fieldOf(record, 'fix') === '',
          `doctor fixture record #${index + 1} has status ${JSON.stringify(status)}, so fix must be ${status === 'ok' ? 'empty' : 'non-empty'}`,
        ).toBe(status === 'ok');
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

  it('emits no degradation member outside the two contract 1.0 enumerates', async () => {
    const roots = fixtureRoots(await loadContract());
    const carriers = roots.filter((root) => hasKey(root, 'degradation'));
    expect(carriers.length, 'no fixture carries a degradation field').toBeGreaterThan(0);
    // The enum is closed per version, so a fixture is the first place a member
    // outside it would appear — and a fixture is what an implementer copies.
    const MEMBERS = ['budget-skipped', 'invalid'] as const;
    for (const root of carriers) {
      const members = fieldOf(root, 'degradation');
      expect(Array.isArray(members), 'a fixture carries a degradation that is not a list').toBe(
        true,
      );
      for (const member of members as unknown[]) {
        expect(
          MEMBERS,
          `a fixture emits the degradation member ${JSON.stringify(member)}, which contract 1.0 does not enumerate`,
        ).toContain(member);
      }
    }
  });

  it('keeps the load fixture a measurement rather than a plausible-looking payload', async () => {
    const roots = fixtureRoots(await loadContract());
    const loads = roots.filter((root) => hasKey(root, 'counters') && hasKey(root, 'budget'));
    expect(loads.length, 'no fixture illustrates a load payload').toBeGreaterThan(0);
    for (const load of loads) {
      // The limit a fixture shows is the number an implementer will copy. It
      // was 65536 here — a value no backend has ever carried — while the
      // document was about to fix the default at 8192.
      expect(
        fieldOf(fieldOf(load, 'budget'), 'limitBytes'),
        'a load fixture shows a budget limit that is not the contract default',
      ).toBe(8192);
      const counters = fieldOf(load, 'counters') as Record<string, unknown>;
      const usedBytes = fieldOf(fieldOf(load, 'budget'), 'usedBytes') as number;
      expect(
        usedBytes <= 8192,
        `a load fixture spends ${usedBytes} bytes of an 8192-byte budget`,
      ).toBe(true);
      // A payload reporting budget-skipped records with an empty degradation
      // list, or the reverse, teaches an implementer the wrong relation.
      const skipped = counters.budgetSkipped as number;
      const degraded = (fieldOf(load, 'degradation') as unknown[]).includes('budget-skipped');
      expect(
        degraded,
        `a load fixture counts budgetSkipped=${skipped} but ${degraded ? 'does' : 'does not'} report the degradation`,
      ).toBe(skipped > 0);
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

  it('counts the rows that state a reach, and the count matches the rows', async () => {
    // Two spellings of one fact drift, and the number was the one that was
    // wrong: the preamble said three where four rows carry a reach statement.
    // This is the same defect as the round-3 blocker that claimed one exception
    // where three existed — in the section whose whole purpose is that no
    // sentence claims more than its backing. So the number is derived from the
    // rows rather than asserted beside them.
    const text = await conformance();
    // Every reach statement carries the same `Reach:` label, so counting them
    // is mechanical rather than a judgement about what reads as one.
    const stated = (normalizeProse(text).match(/\bReach:/g) ?? []).length;
    const claimed = /and (one|two|three|four|five|six|seven) of them do\b/i.exec(
      normalizeProse(text),
    );
    expect(
      claimed,
      'the conformance preamble states no count of the rows that state a reach',
    ).not.toBe(null);
    const WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'] as const;
    expect(
      WORDS.indexOf(claimed![1]!.toLowerCase() as (typeof WORDS)[number]) + 1,
      `the preamble claims a different number of reach-stating rows than the ${stated} rows labelled Reach:`,
    ).toBe(stated);
  });

  it('states each reach as the sentence it is, not as a label a negation can wear', async () => {
    // The count above is of `Reach:` labels, and a label says nothing about
    // what follows it: three of the four reach clauses were measured green
    // after being inverted into overclaims — "the template copies ARE scanned
    // too", "the test does NOT read index.ts alone", "`exempt` HAS a verdict of
    // its own". Each is a statement about how far a test reaches, in a section
    // whose whole promise is that no sentence claims more than its backing, so
    // each is pinned verbatim and the label check keeps the count honest.
    const text = await conformance();
    for (const [description, statement] of [
      [
        'the --json row must state that its test reads index.ts alone and knows one spelling',
        'Reach: the test reads `index.ts` alone and recognises one spelling — a `parseArgs` option named `json`; a flag added by a hand-rolled argv scan, or declared in another module under `packages/cli/src`, is invisible to it.',
      ],
      [
        'the RIG_UNATTENDED row must state that its reach is those three trees and no others',
        'Reach: those three trees and no others — the template copies under `templates/agent-os/` are not scanned, and neither is any extension but `.mjs` and `.ts`.',
      ],
      [
        'the exit-2 row must state that its test counts occurrences rather than meanings',
        'Reach: the test counts occurrences of an exit-2 call, not distinct meanings, so the "twice over" clause rests on reading those two call sites and not on the count.',
      ],
      [
        'the doctor row must state that the exempt half is a source read with no verdict behind it',
        'Reach: `exempt` has no verdict of its own to call — `verdictOf` branches on `FAIL` and `unknown` only — so that half of the row is a source read, and would stay green if the mark were removed from `auditHooks` while its name survived in a comment.',
      ],
    ] as const) {
      expectStatement(text, description, statement);
    }
  });

  it('states the reach on every row whose test is narrower than the row sounds', async () => {
    // The round-3 blocker: the preamble named `exempt` as the ONE clause weaker
    // than its test's reach, while rows 1 and 5 stated no reach at all and
    // their tests' own comments recorded one. The rows were true; the promise
    // of pinning was not. So the preamble must stop claiming a single
    // exception, and the two rows must carry their limits where they are read.
    const section_ = normalizeProse(await conformance());
    expect(
      section_,
      'the conformance preamble still claims a single clause is weaker than its test',
    ).not.toMatch(/which is the case for `exempt` in the last one/i);
    expectTerms(section_, [
      [
        'the --json row does not state that its test reads index.ts alone',
        /`index\.ts` alone[\s\S]{0,200}`parseArgs`/i,
      ],
      [
        'the exit-2 row does not state that its test counts occurrences rather than meanings',
        /counts occurrences[\s\S]{0,160}not distinct meanings/i,
      ],
    ]);
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
    // The row used to hand this to the acceptance list. Ruling 1 of 2026-08-31
    // settled it instead: `.claude/scripts/doctor.mjs` is not bound by this
    // contract, so its two extra marks are a measured difference of a tool the
    // contract does not reach — not an open question, and not a violation.
    expect(
      text,
      "the doctor-marks row must say the measured tool is outside this contract's scope",
    ).toMatch(/outside this contract's scope|this contract does not bind/i);
    // A negative regex on the old wording would be dodged by a reword, so the
    // pin is positive: the row has to say the question is settled and by what.
    expectStatement(
      await conformance(),
      'the doctor-marks row must record that the acceptance question it used to carry is settled',
      'until the owner ruling of 2026-08-31 settled it',
    );
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
