// RP-184 (PR2): docs/command-contract.md was frozen in PR1. This file pins
// named pieces of that frozen text to the code that is supposed to produce
// them, so the contract cannot drift silently once a caller starts relying on
// it. Each `describe` below names one such pair.
//
// Markdown parsing is deliberately re-implemented locally rather than shared:
// `test/template/readme-promises.test.ts`'s own header says only the pointer
// resolver was asked to move into `test/helpers/` for RP-184, and the two
// documents' table shapes differ enough that a shared reader would have to
// carry both anyway.
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
// Named import, not default: ajv's CJS/ESM interop makes the default export's
// construct signature unreliable under this repository's `NodeNext` + strict
// TypeScript settings, but `Ajv2020` is also a real named export of this
// module and constructs cleanly.
import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runIntegrationsCommand } from '../../packages/cli/src/commands/integrations.js';
import { parseDeclaration } from '../../packages/cli/src/integrations/declaration.js';
import { REGISTRY } from '../../packages/cli/src/integrations/registry.js';
import { removeFixture } from '../helpers/remove-fixture.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const contractPath = path.join(repoRoot, 'docs', 'command-contract.md');

async function loadContract(): Promise<string> {
  return readFile(contractPath, 'utf8');
}

/** The text of a Markdown section (its heading through the next same-or-higher heading). */
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

const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

interface PipeTable {
  headers: string[];
  rows: string[][];
}

/** The first pipe table found in a Markdown fragment, or `undefined`. */
function firstPipeTable(markdown: string): PipeTable | undefined {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i]!.startsWith('|') || !/^\|[\s:|-]+\|$/.test(lines[i + 1]!.trim())) continue;
    const headers = splitRow(lines[i]!).map((h) => h.toLowerCase());
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j]!.startsWith('|'); j++) rows.push(splitRow(lines[j]!));
    return { headers, rows };
  }
  return undefined;
}

const stripMd = (cell: string): string => cell.replace(/[`*]/g, '').trim();

/**
 * Every backtick-code span in a Markdown fragment, stripped of the backticks.
 *
 * A fenced block (``` … ```) is stripped first. Without that, its own
 * opening and closing triple-backtick runs pair up with each other as if
 * they were ordinary inline-span delimiters, so the *next* real inline span
 * in the fragment pairs with the wrong backtick and every span after it
 * mis-parses too — pinned in
 * `test/template/contract-correspondence.test.ts` ›
 * "codeSpans keeps inline-span parity across a fenced code block".
 */
function codeSpans(markdown: string): Set<string> {
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, '');
  return new Set([...withoutFences.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
}

/**
 * The `outcome` domain "## setup integrations (RP-22)" documents, read from
 * its own pipe table's leading column — a table, not `codeSpans`, so this
 * reading cannot be affected by the fenced `sh` block earlier in that same
 * section.
 */
function setupOutcomeTableDomain(contract: string): string[] {
  // No trailing `\b` here: the heading ends in `)`, and `\b` cannot match
  // between two non-word characters (`)` and end-of-line) — it would never
  // find the heading at all.
  const setupSection = section(contract, /^##\s+setup integrations \(RP-22\)/);
  const table = firstPipeTable(setupSection);
  expect(table, 'no pipe table found under "## setup integrations (RP-22)"').toBeTruthy();
  return table!.rows.map((row) => stripMd(row[0] ?? ''));
}

/** The `setup add`/`setup apply`/`setup remove` pipe-table rows of "## Public surface at 1.0". */
function publicSurfaceSetupRows(contract: string): string {
  const publicSurface = section(contract, /^##\s+Public surface at 1\.0\b/);
  const rows = publicSurface
    .split('\n')
    .filter((line) => /^\|\s*`setup (add|apply|remove)/.test(line));
  expect(
    rows.length,
    'expected exactly 3 `setup add`/`setup apply`/`setup remove` rows under ' +
      '"## Public surface at 1.0"',
  ).toBe(3);
  return rows.join('\n');
}

/**
 * Backtick spans shaped like an outcome value — one lowercase word — found in
 * a fragment, excluding the `outcome` field name itself (present in these
 * rows as the label, not as a value).
 */
function outcomeLikeSpans(markdown: string): Set<string> {
  return new Set(
    [...codeSpans(markdown)].filter((span) => /^[a-z]+$/.test(span) && span !== 'outcome'),
  );
}

describe('codeSpans', () => {
  it('keeps inline-span parity across a fenced code block', () => {
    const fragment = [
      'A fenced block:',
      '',
      '```sh',
      'create-agent-rig setup add figma-mcp --yes --json',
      '```',
      '',
      'and an inline span after it: `written`.',
    ].join('\n');
    expect(codeSpans(fragment)).toEqual(new Set(['written']));
  });
});

describe('docs/command-contract.md ↔ code correspondence (RP-184 PR2)', () => {
  // --- 1. Ownership verdicts ↔ the UpgradeVerdict union --------------------

  describe('"## Ownership verdicts" names exactly the UpgradeVerdict union in upgrade.ts', () => {
    async function upgradeVerdictMembers(): Promise<string[]> {
      const source = await readFile(
        path.join(repoRoot, 'packages', 'cli', 'src', 'commands', 'upgrade.ts'),
        'utf8',
      );
      const start = source.indexOf('export type UpgradeVerdict =');
      expect(start, 'upgrade.ts no longer declares `export type UpgradeVerdict =`').toBeGreaterThan(
        -1,
      );
      const end = source.indexOf('export interface UpgradeAction', start);
      expect(
        end,
        'upgrade.ts no longer declares `export interface UpgradeAction` after the union',
      ).toBeGreaterThan(start);
      const block = source.slice(start, end);
      return [...block.matchAll(/\|\s*'([a-z]+)'/g)].map((m) => m[1]!);
    }

    it('parses a realistic, non-empty union from upgrade.ts', async () => {
      const members = await upgradeVerdictMembers();
      expect(members.length).toBeGreaterThanOrEqual(5);
    });

    it('matches, in both directions, the leading column of the "## Ownership verdicts" table', async () => {
      const [members, contract] = await Promise.all([upgradeVerdictMembers(), loadContract()]);
      const table = firstPipeTable(section(contract, /^##\s+Ownership verdicts\b/));
      expect(table, 'no pipe table found under "## Ownership verdicts"').toBeTruthy();
      const documented = table!.rows.map((row) => stripMd(row[0] ?? ''));
      const codeSet = new Set(members);
      const docSet = new Set(documented);
      expect(
        members.filter((m) => !docSet.has(m)),
        'in code, not documented',
      ).toEqual([]);
      expect(
        documented.filter((d) => !codeSet.has(d)),
        'documented, not in code',
      ).toEqual([]);
    });
  });

  // --- 2. Doctor check IDs --------------------------------------------------
  //
  // "## Doctor" calls `id` "a stable identifier for the check, safe to match
  // on". Like the `UpgradeVerdict` table above, "## Doctor" now spells out
  // the closed set of values it takes, in a pipe table. This test derives
  // the fixed (non-template) ids `doctor.ts` actually emits from the source,
  // and checks that each one is named literally, in backtick code, somewhere
  // in "## Doctor".

  describe('"## Doctor" names, in backtick code, every fixed check id doctor.ts emits', () => {
    async function fixedDoctorCheckIds(): Promise<string[]> {
      const source = await readFile(
        path.join(repoRoot, 'packages', 'cli', 'src', 'commands', 'doctor.ts'),
        'utf8',
      );
      // Only `id: '<literal>'` — a template-literal id (`` `${entry.id}:...` ``)
      // or a property-shorthand id (`id: entry.id`) is not a fixed, closed value
      // and is intentionally excluded.
      return [...new Set([...source.matchAll(/\bid:\s*'([a-z][a-z-]*)'/g)].map((m) => m[1]!))];
    }

    it('parses a realistic, non-empty set of fixed ids from doctor.ts', async () => {
      const ids = await fixedDoctorCheckIds();
      expect(ids.length).toBeGreaterThanOrEqual(5);
    });

    it('lists every fixed doctor check id in "## Doctor", in backtick code', async () => {
      const [ids, contract] = await Promise.all([fixedDoctorCheckIds(), loadContract()]);
      const doctorSection = section(contract, /^##\s+Doctor\b/);
      const spans = codeSpans(doctorSection);
      const undocumented = ids.filter((id) => !spans.has(id));
      expect(
        undocumented,
        'doctor.ts check ids with no literal backtick mention anywhere in "## Doctor"',
      ).toEqual([]);
    });
  });

  // --- 3. `setup add`/`apply`/`remove` --json `outcome` values --------------
  //
  // Observed empirically (four real `runIntegrationsCommand` calls) rather
  // than regex-scraped from integrations.ts: the real assignment site
  // (`outcome: verb === 'remove' ? 'removed' : 'written'`) also contains the
  // string literal `'remove'` as a comparison operand, not as an outcome
  // value, which a naive text scan over the same line would wrongly collect.
  // Observing what the command actually prints cannot make that mistake and
  // cannot drift out of step with a future rewrite of that line.
  //
  // As with the doctor ids above: "## setup integrations (RP-22)" now spells
  // out `outcome`'s value domain in its own pipe table. That table is the
  // canonical copy and is checked on its own, never unioned with a second
  // source: a union lets either copy alone satisfy the check, so a table
  // that lost every real value could still pass as long as the *other* copy
  // still had them. The "## Public surface at 1.0" rows for
  // `setup add`/`apply`/`remove` are a second, independent copy of the same
  // closed set, and get their own separately-failing assertion that the two
  // agree — the shape `.claude/rules/invariants.md` asks for when a fact has
  // to be spelled out twice.

  describe('the documented setup outcome values match what setup add/apply/remove --json actually prints', () => {
    let repo: string;

    beforeEach(async () => {
      repo = await mkdtemp(path.join(tmpdir(), 'caf-setup-outcome-'));
    });

    afterEach(async () => {
      await removeFixture(repo);
    });

    const setup = (verb: 'add' | 'apply' | 'remove', args: string[]) =>
      runIntegrationsCommand({ verb, args, cwd: repo, isTTY: true });

    async function observedOutcomes(): Promise<string[]> {
      const outcomes = new Set<string>();
      const planned = await setup('add', [
        'figma-mcp',
        '--harness',
        'claude-code',
        '--dry-run',
        '--json',
      ]);
      outcomes.add((JSON.parse(planned.stdout) as { outcome: string }).outcome);

      const written = await setup('add', [
        'figma-mcp',
        '--harness',
        'claude-code',
        '--yes',
        '--json',
      ]);
      outcomes.add((JSON.parse(written.stdout) as { outcome: string }).outcome);

      const removed = await setup('remove', ['figma-mcp', '--yes', '--json']);
      outcomes.add((JSON.parse(removed.stdout) as { outcome: string }).outcome);

      const refused = await setup('add', ['not-a-real-provider', '--yes', '--json']);
      outcomes.add((JSON.parse(refused.stdout) as { outcome: string }).outcome);

      return [...outcomes];
    }

    it('observes the four real outcome values planned/written/removed/refused', async () => {
      const outcomes = await observedOutcomes();
      expect(new Set(outcomes)).toEqual(new Set(['planned', 'written', 'removed', 'refused']));
    });

    it(
      '"## setup integrations (RP-22)" alone names, in its own outcome table, exactly the ' +
        'outcome values setup add/apply/remove --json actually prints',
      async () => {
        const [outcomes, contract] = await Promise.all([observedOutcomes(), loadContract()]);
        const documented = setupOutcomeTableDomain(contract);
        expect(
          outcomes.filter((outcome) => !documented.includes(outcome)),
          'outcome values setup add/apply/remove --json actually prints, missing from the ' +
            '"## setup integrations (RP-22)" outcome table',
        ).toEqual([]);
        expect(
          documented.filter((value) => !outcomes.includes(value)),
          '"## setup integrations (RP-22)" outcome table rows with no matching real outcome value',
        ).toEqual([]);
      },
    );

    it(
      'the `setup add`/`apply`/`remove` rows of "## Public surface at 1.0" agree, in backtick ' +
        'code, with the "## setup integrations (RP-22)" outcome table',
      async () => {
        const contract = await loadContract();
        const documented = new Set(setupOutcomeTableDomain(contract));
        const rowSpans = outcomeLikeSpans(publicSurfaceSetupRows(contract));
        expect(
          [...documented].filter((value) => !rowSpans.has(value)),
          'outcome values the "## setup integrations (RP-22)" table names, missing from the ' +
            '`setup add`/`apply`/`remove` rows of "## Public surface at 1.0"',
        ).toEqual([]);
        expect(
          [...rowSpans].filter((span) => !documented.has(span)),
          'single-word backtick spans in the `setup add`/`apply`/`remove` rows of "## Public ' +
            'surface at 1.0" that are not in the "## setup integrations (RP-22)" outcome table',
        ).toEqual([]);
      },
    );
  });

  // --- 4. The manifest keys a fresh init writes -----------------------------

  describe('a fresh `init` writes exactly the manifest keys "### `.claude/.rig-manifest.json`" documents', () => {
    let repo: string;

    beforeEach(async () => {
      repo = await mkdtemp(path.join(tmpdir(), 'caf-manifest-keys-'));
    });

    afterEach(async () => {
      await removeFixture(repo);
    });

    interface DocumentedManifestKeys {
      topLevel: Set<string>;
      omittableTopLevel: Set<string>;
      nested: Map<string, Set<string>>;
    }

    function documentedManifestKeys(contract: string): DocumentedManifestKeys {
      // No trailing `\b` here either: the heading ends in a backtick, another
      // non-word character.
      const sub = section(contract, /^###\s+`\.claude\/\.rig-manifest\.json`/);
      const table = firstPipeTable(sub);
      expect(table, 'no pipe table found under "### `.claude/.rig-manifest.json`"').toBeTruthy();
      const topLevel = new Set<string>();
      const omittableTopLevel = new Set<string>();
      const nested = new Map<string, Set<string>>();
      for (const row of table!.rows) {
        const keyCell = stripMd(row[0] ?? '');
        const absentCell = (row[2] ?? '').toLowerCase();
        // Drop a trailing parenthetical description FIRST, at the whole-cell
        // level: "layers (`'process'` and/or `'workflow'`, deduplicated)"
        // carries its own "/" inside that description, which would otherwise
        // be split apart alongside the real multi-key "/" separator that
        // "project.name / project.scope / project.region" uses.
        const withoutParen = keyCell.split('(')[0]!.trim();
        for (const rawToken of withoutParen.split('/')) {
          const token = rawToken.trim();
          if (token === '') continue;
          const [top, ...restParts] = token.split('.');
          topLevel.add(top!);
          if (restParts.length > 0) {
            const set = nested.get(top!) ?? new Set<string>();
            set.add(restParts.join('.'));
            nested.set(top!, set);
          }
          if (absentCell.includes('omitted entirely')) omittableTopLevel.add(top!);
        }
      }
      return { topLevel, omittableTopLevel, nested };
    }

    it('parses a realistic, non-empty documented key set', async () => {
      const { topLevel } = documentedManifestKeys(await loadContract());
      expect(topLevel.size).toBeGreaterThanOrEqual(5);
    });

    it(
      'matches, in both directions, the top-level and `project.*` keys of a fresh init manifest ' +
        '(kept absent, as documented, since a fresh install into an empty tree keeps nothing)',
      async () => {
        await writeFile(path.join(repo, 'package.json'), '{"name":"host"}\n');
        const cliBin = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
        await exec(process.execPath, [cliBin, 'init'], { cwd: repo });
        const manifest = JSON.parse(
          await readFile(path.join(repo, '.claude', '.rig-manifest.json'), 'utf8'),
        ) as Record<string, unknown>;

        const { topLevel, omittableTopLevel, nested } = documentedManifestKeys(
          await loadContract(),
        );
        const actualTop = new Set(Object.keys(manifest));

        const missingFromManifest = [...topLevel].filter(
          (key) => !omittableTopLevel.has(key) && !actualTop.has(key),
        );
        const extraInManifest = [...actualTop].filter((key) => !topLevel.has(key));
        expect(
          missingFromManifest,
          'documented, required, but absent from a fresh manifest',
        ).toEqual([]);
        expect(extraInManifest, 'present in a fresh manifest, but not documented').toEqual([]);

        // The one documented omittable key really is omitted on a fresh install.
        expect([...omittableTopLevel].filter((key) => actualTop.has(key))).toEqual([]);

        const documentedProjectKeys = nested.get('project') ?? new Set<string>();
        const actualProjectKeys = new Set(
          Object.keys((manifest as { project?: Record<string, unknown> }).project ?? {}),
        );
        expect([...documentedProjectKeys].filter((k) => !actualProjectKeys.has(k))).toEqual([]);
        expect([...actualProjectKeys].filter((k) => !documentedProjectKeys.has(k))).toEqual([]);
      },
    );
  });

  // --- 5. contracts/integrations/v1/declaration.schema.json ----------------

  describe('contracts/integrations/v1/declaration.schema.json accepts real intent and matches parseDeclaration', () => {
    let repo: string;
    let validate: (data: unknown) => boolean;

    beforeEach(async () => {
      repo = await mkdtemp(path.join(tmpdir(), 'caf-declaration-schema-'));
      const schema = JSON.parse(
        await readFile(
          path.join(repoRoot, 'contracts', 'integrations', 'v1', 'declaration.schema.json'),
          'utf8',
        ),
      );
      const ajv = new Ajv({ strict: true });
      validate = ajv.compile(schema) as unknown as (data: unknown) => boolean;
    });

    afterEach(async () => {
      await removeFixture(repo);
    });

    it('accepts the real .rig/integrations.json a `setup add ... --yes` run writes', async () => {
      const result = await runIntegrationsCommand({
        verb: 'add',
        args: ['figma-mcp', '--harness', 'claude-code', '--yes', '--json'],
        cwd: repo,
        isTTY: true,
      });
      expect(result.exitCode).toBe(0);
      const declaration = JSON.parse(
        await readFile(path.join(repo, '.rig', 'integrations.json'), 'utf8'),
      );
      const ok = validate(declaration);
      expect(ok, JSON.stringify((validate as unknown as { errors?: unknown }).errors)).toBe(true);
    });

    it.each([
      ['an unknown root key', { schemaVersion: 1, integrations: [], bogus: true }],
      ['a schemaVersion other than 1', { schemaVersion: 2, integrations: [] }],
      ['integrations not an array', { schemaVersion: 1, integrations: {} }],
      ['an integration entry with no id', { schemaVersion: 1, integrations: [{ selected: true }] }],
    ])('rejects %s, exactly as parseDeclaration does (status: "invalid")', (_name, data) => {
      expect(parseDeclaration(JSON.stringify(data), REGISTRY).status).toBe('invalid');
      expect(validate(data)).toBe(false);
    });

    // Discovered, not fixed here: the schema's `id` property is an unconstrained
    // string, so it does not encode parseDeclaration's control-character rule.
    // A `.rig/integrations.json` no real Rig command would ever write (control
    // characters cannot reach it through the CLI) would still fail parseDeclaration
    // but pass this schema. Left as a documented, deliberate discrepancy — the
    // schema's own description says it is "the public shape", not every rule
    // parseDeclaration enforces.
    it('accepts a control character in `id` that parseDeclaration refuses (known schema/code gap, not fixed here)', () => {
      const withControlChar = {
        schemaVersion: 1,
        integrations: [{ id: 'figma-mcp\u001b', selected: true }],
      };
      expect(parseDeclaration(JSON.stringify(withControlChar), REGISTRY).status).toBe('invalid');
      expect(validate(withControlChar)).toBe(true);
    });

    // Discovered, not fixed here: the opposite asymmetry. An entry carrying an
    // unknown key is only ever an ENTRY-level rejection to parseDeclaration —
    // the entry is dropped into `rejected[]` and the rest of the document still
    // parses as `status: 'ok'` — but the schema's `additionalProperties: false`
    // on each array item fails the WHOLE document. A real `.rig/integrations.json`
    // never carries such an entry (no Rig command writes one), so this never
    // fires on real intent; it is recorded here so the difference in strictness
    // is not silently relied upon.
    it(
      'fails the whole document over one entry’s unknown key, where parseDeclaration only drops ' +
        'that entry and keeps the document "ok" (known schema/code gap, not fixed here)',
      () => {
        const withUnknownEntryKey = {
          schemaVersion: 1,
          integrations: [{ id: 'figma-mcp', selected: true, command: 'curl' }],
        };
        expect(parseDeclaration(JSON.stringify(withUnknownEntryKey), REGISTRY)).toMatchObject({
          status: 'ok',
          rejected: [{ id: 'figma-mcp' }],
        });
        expect(validate(withUnknownEntryKey)).toBe(false);
      },
    );

    // Discovered, not fixed here: JSON Schema has no built-in way to require
    // uniqueness of one property (`id`) across array items without an extra
    // keyword this schema does not declare (e.g. ajv-keywords'
    // `uniqueItemProperties`), so two entries sharing one `id` pass the schema
    // while parseDeclaration's own duplicate-id guard refuses the document.
    it('accepts two integration entries sharing one id that parseDeclaration refuses (known schema/code gap, not fixed here)', () => {
      const withDuplicateId = {
        schemaVersion: 1,
        integrations: [
          { id: 'figma-mcp', selected: true },
          { id: 'figma-mcp', selected: true },
        ],
      };
      expect(parseDeclaration(JSON.stringify(withDuplicateId), REGISTRY).status).toBe('invalid');
      expect(validate(withDuplicateId)).toBe(true);
    });
  });

  // --- 6. CI Node matrix vs. the engines.node floor -------------------------
  // (the tarball's provider payload is the seventh, and it lives in
  // packages/cli/test/package-contents.test.ts, next to the other pack checks)

  describe('the CI Node matrix includes the package.json engines.node floor', () => {
    it('every workflow node-version value is >= the engines.node floor', async () => {
      const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
        engines?: { node?: string };
      };
      const floorMatch = /^>=(\d+)$/.exec(pkg.engines?.node ?? '');
      expect(
        floorMatch,
        `package.json engines.node is not a plain ">=N" floor: ${pkg.engines?.node}`,
      ).toBeTruthy();
      const floor = Number(floorMatch![1]);

      const workflowDir = path.join(repoRoot, '.github', 'workflows');
      const files = (await readdir(workflowDir)).filter((f) => f.endsWith('.yml'));
      expect(files.length).toBeGreaterThan(0);

      const versions = new Set<number>();
      for (const file of files) {
        const text = await readFile(path.join(workflowDir, file), 'utf8');
        for (const m of text.matchAll(/node-version:\s*['"]?(\d+)(?:\.\d+)*['"]?/g)) {
          versions.add(Number(m[1]));
        }
      }
      expect(versions.size, 'no node-version value found in any workflow').toBeGreaterThan(0);
      const belowFloor = [...versions].filter((v) => v < floor);
      expect(
        belowFloor,
        `workflow node-version values below the engines.node >=${floor} floor`,
      ).toEqual([]);
    });
  });
});
