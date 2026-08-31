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
    for (const [key, child] of Object.entries(value)) {
      const childPath = keyPath === '' ? key : `${keyPath}.${key}`;
      // The document's carve-out is exactly one shape: "a doctor `fix` hint,
      // which is an instruction to a human". So the exemption is the STRING
      // VALUE DIRECTLY UNDER a `fix` key and nothing else — not a path nested
      // inside an object or an array under `fix`, and not a `fix` key that
      // turns up inside a `missing[]` entry carrying a path of its own. An
      // exemption that travelled down the tree with the nearest ancestor key
      // let both of those through.
      if (key === 'fix' && typeof child === 'string') continue;
      collectPathLikeStrings(child, childPath, out);
    }
  }
};

const hasKey = (value: unknown, key: string): boolean =>
  typeof value === 'object' && value !== null && key in (value as Record<string, unknown>);

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;

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
 * (with or without optional chaining), a computed access by literal key,
 * a destructuring of `process.env`, and a presence probe that passes
 * `process.env` and the name as two arguments (`Object.hasOwn`, `Reflect.has`).
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
 */
const READS_RIG_UNATTENDED =
  /(?:process\s*\.\s*)?env\s*(?:\?\.)?\s*\.?\s*RIG_UNATTENDED\b|env\s*(?:\?\.)?\s*\[\s*['"`]RIG_UNATTENDED['"`]\s*\]|\{[^{}]*\bRIG_UNATTENDED\b[^{}]*\}\s*=\s*(?:process\s*\.\s*)?env\b|process\s*\.\s*env\s*,\s*['"`]RIG_UNATTENDED['"`]/;

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
      'The discriminator is a `result` field, not the exit code.',
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
    const output = section(await loadContract(), /^#{2,6}\s+.*Output\b/i);
    expectTerms(output, [
      ['the Output section does not call evolution additive', /\badditive\b/i],
      [
        'the Output section does not say unknown keys are tolerated',
        /unknown\s+(?:keys|fields)[\s\S]{0,120}\b(tolerat|ignor|accept)/i,
      ],
      [
        'the Output section does not say a foreign major is rejected',
        /\bmajor\b[\s\S]{0,120}\b(reject|refus)/i,
      ],
    ]);
  });
});

describe('the version handshake', () => {
  it('answers --version --json with name, version and contractVersion', async () => {
    const handshake = section(
      await loadContract(),
      /^#{2,6}\s+.*(handshake|--version|version handshake)/i,
    );
    expectTerms(handshake, [
      [
        'the handshake section does not name the --version --json invocation',
        /--version[\s\S]{0,40}--json/,
      ],
      ['the handshake answer omits name', /\bname\b/],
      ['the handshake answer omits version', /\bversion\b/],
      ['the handshake answer omits contractVersion', /\bcontractVersion\b/],
    ]);
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
    expectTerms(
      await doctor(),
      (['id', 'status', 'detail', 'fix'] as const).map(
        (field) =>
          [`the doctor record shape omits ${field}`, new RegExp(`\\b${field}\\b`)] as const,
      ),
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

  it('keeps detail and fix human-facing while consumers act on status alone', async () => {
    expectTerms(await doctor(), [
      [
        'detail and fix are not marked human-facing',
        /\b(detail|fix)\b[\s\S]{0,160}\bhuman[- ](facing|readable)\b/i,
      ],
      [
        'consumers are not restricted to acting on status only',
        /consumers?[\s\S]{0,160}\bstatus\b[\s\S]{0,60}\bonly\b|\bstatus\b[\s\S]{0,60}\bonly\b[\s\S]{0,160}consumers?/i,
      ],
    ]);
  });

  it('leaves contract mismatch to the consumer handshake rather than to doctor', async () => {
    expect(
      normalizeProse(await doctor()),
      'doctor must not report contract mismatch; the consumer detects it through the handshake',
    ).toMatch(/contract[\s\S]{0,120}handshake|handshake[\s\S]{0,120}contract/i);
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
    expect(content, 'consumers are not routed through the command surface').toMatch(
      /consumers?[\s\S]{0,160}command surface/i,
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
  it("names doctor's extra marks, degradation[]'s members and the budget numbers", async () => {
    const open = normalizeProse(
      section(await loadContract(), /^#{2,6}\s+.*Open questions for acceptance\b/i),
    );
    expectTerms(open, [
      ["the acceptance list omits doctor's two extra marks", /doctor'?s two extra marks/i],
      ["the acceptance list omits degradation[]'s members", /`degradation\[\]`'?s members/i],
      [
        "the acceptance list omits the load selection budget's default and bounds",
        /load selection budget'?s default and bounds/i,
      ],
    ]);
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
      'Every row below names the test that pins it, and goes red when its claim stops being true.',
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
    const verdict = await readFile(
      path.join(repoRoot, '.claude', 'scripts', 'verdict.mjs'),
      'utf8',
    );
    // The claim wraps across two comment lines, so it is pinned as the two
    // fragments that each sit on one line rather than as one sentence.
    for (const fragment of [/whether the REPORT was usable/, /never what the verdict/]) {
      expect(
        verdict,
        `verdict.mjs no longer states that its exit code says whether the report was usable (${fragment}) — the conformance row is stale`,
      ).toMatch(fragment);
    }
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
