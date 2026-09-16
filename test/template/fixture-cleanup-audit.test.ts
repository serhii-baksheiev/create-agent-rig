import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';
import { filesBelow } from '../helpers/scan-exclusions.mjs';

// RP-158: the correspondence audit. Two facts have to stay true together, and
// nothing but a test that reads both sides catches the day one of them moves
// alone (`.claude/rules/invariants.md`, "one mechanism, one implementation"):
//
//   1. every direct recursive test-fixture removal either goes through the
//      shared `removeFixture` helper, or is named — with a reason — in
//      `test/helpers/fixture-cleanup-exceptions.json`;
//   2. every scratch directory a test creates INSIDE this repository (rather
//      than under the OS temp dir) is named — with the prefix it uses and a
//      reason — in `test/helpers/in-repo-fixtures.json`, and that prefix is
//      covered by a `.gitignore` pattern so it cannot leak into `git status`.
//
// Both correspondences are plain text scans: this is a `check-premises`-shaped
// test, not a build step, so the scanning is a pure function over source text,
// tested directly (in-memory, no disk) before it is pointed at the real tree.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const SOURCE_EXTENSIONS = ['.ts', '.mts', '.mjs'];
const HELPER_EXEMPT_FILE = 'test/helpers/remove-fixture.ts';
// This file's own mkdtemp patterns are strings for the scanner, not fixtures.
const AUDIT_FILE = 'test/template/fixture-cleanup-audit.test.ts';

interface CallSite {
  file: string;
  line: number;
  text: string;
}

// ── Pure scanning logic — exercised in-memory below, then pointed at the tree ──

const RM_CALL_LITERALS = ['rm(', 'rmSync(', 'rmP('];

/** Identifiers bound to fs `rm` on an `import { rm as X }` line. */
function aliasNamesFromImportLine(line: string): string[] {
  const names: string[] = [];
  const re = /\brm\s+as\s+(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) {
    const name = match[1];
    if (name) names.push(name);
  }
  return names;
}

/** Every line in `source` that both calls a recursive-removal function and
 * passes `recursive: true` on that same line. */
function findCallSitesInSource(fileRel: string, source: string): CallSite[] {
  const lines = source.split(/\r?\n/);
  const aliases = new Set<string>();
  for (const line of lines) {
    if (/^\s*import\b/.test(line)) {
      for (const name of aliasNamesFromImportLine(line)) aliases.add(name);
    }
  }
  const literals = [...RM_CALL_LITERALS, ...[...aliases].map((name) => `${name}(`)];
  const sites: CallSite[] = [];
  lines.forEach((text, idx) => {
    const hasCall = literals.some((literal) => text.includes(literal));
    if (hasCall && text.includes('recursive: true')) {
      sites.push({ file: fileRel, line: idx + 1, text: text.trim() });
    }
  });
  return sites;
}

interface ExceptionEntry {
  file: string;
  reason: string;
}

/** Sites whose file is not named by any exception entry. */
function missingExceptions(sites: CallSite[], exceptions: ExceptionEntry[]): CallSite[] {
  const named = new Set(exceptions.map((entry) => entry.file));
  return sites.filter((site) => !named.has(site.file));
}

/** Exception entries naming a file that no longer has a matching site. */
function staleExceptions(sites: CallSite[], exceptions: ExceptionEntry[]): ExceptionEntry[] {
  const siteFiles = new Set(sites.map((site) => site.file));
  return exceptions.filter((entry) => !siteFiles.has(entry.file));
}

const REPO_MKDTEMP_PATTERNS = ['mkdtemp(path.join(repoRoot', 'mkdtemp(join(repoRoot'];

interface MkdtempSite {
  file: string;
  line: number;
  text: string;
}

/** Every line in `source` that builds an in-repository mkdtemp() destination. */
function findRepoMkdtempSitesInSource(fileRel: string, source: string): MkdtempSite[] {
  const lines = source.split(/\r?\n/);
  const sites: MkdtempSite[] = [];
  lines.forEach((text, idx) => {
    if (REPO_MKDTEMP_PATTERNS.some((pattern) => text.includes(pattern))) {
      sites.push({ file: fileRel, line: idx + 1, text: text.trim() });
    }
  });
  return sites;
}

interface InRepoFixtureEntry {
  file: string;
  prefix: string;
  reason: string;
}

function missingInRepoFixtureEntries(
  sites: MkdtempSite[],
  entries: InRepoFixtureEntry[],
): MkdtempSite[] {
  const named = new Set(entries.map((entry) => entry.file));
  return sites.filter((site) => !named.has(site.file));
}

/** Whether some line of `.gitignore` covers a directory prefix like `.codex-`. */
function isPrefixIgnored(gitignoreText: string, prefix: string): boolean {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^/?${escaped}\\*/?$`);
  return gitignoreText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => pattern.test(line));
}

// ── The pure logic, pinned in memory before it ever touches the real tree ──

describe('fixture-cleanup-audit: the scanning logic itself', () => {
  it('finds a same-line rm(..., { recursive: true }) call', () => {
    const source = [
      "import { rm } from 'node:fs/promises';",
      'afterEach(async () => {',
      '  await rm(work, { recursive: true, force: true });',
      '});',
    ].join('\n');
    expect(findCallSitesInSource('example.test.ts', source)).toEqual([
      {
        file: 'example.test.ts',
        line: 3,
        text: 'await rm(work, { recursive: true, force: true });',
      },
    ]);
  });

  it('does not mistake a plain mkdir({ recursive: true }) for a removal', () => {
    const source = 'await mkdir(path.dirname(abs), { recursive: true });';
    expect(findCallSitesInSource('example.test.ts', source)).toEqual([]);
  });

  it('follows a destructuring-free `rm as X` import alias', () => {
    const source = [
      "import { rm as wipe } from 'node:fs/promises';",
      'await wipe(dir, { recursive: true, force: true });',
    ].join('\n');
    expect(findCallSitesInSource('example.test.ts', source)).toEqual([
      {
        file: 'example.test.ts',
        line: 2,
        text: 'await wipe(dir, { recursive: true, force: true });',
      },
    ]);
  });

  it('reports a site with no matching exception entry (mutation: extra site)', () => {
    const sites: CallSite[] = [
      { file: 'test/example.test.ts', line: 10, text: 'await rm(dir, { recursive: true });' },
    ];
    expect(missingExceptions(sites, [])).toEqual(sites);
  });

  it('reports an exception naming a file with no site any more (mutation: stale exception)', () => {
    const exceptions: ExceptionEntry[] = [
      { file: 'test/gone.test.ts', reason: 'migrated to removeFixture' },
    ];
    expect(staleExceptions([], exceptions)).toEqual(exceptions);
  });

  it('covers a listed prefix matched by a trailing-slash gitignore pattern', () => {
    expect(isPrefixIgnored('.codex-*/\n', '.codex-')).toBe(true);
  });

  it('does not cover a prefix absent from .gitignore', () => {
    expect(isPrefixIgnored('node_modules/\n', '.codex-')).toBe(false);
  });
});

// ── The real tree, read once and checked against the two manifests ──

/** Every source file below `absDir`, through the one repository walker (RP-155). */
async function collectSourceFiles(absDir: string): Promise<string[]> {
  try {
    const perExtension = await Promise.all(
      SOURCE_EXTENSIONS.map((extension) => filesBelow(repoRoot, absDir, { extension })),
    );
    return perExtension.flat();
  } catch {
    return [];
  }
}

const isSkeletonTestFile = (rel: string): boolean => rel.split('/').includes('test');

async function scanTree(): Promise<{ removalSites: CallSite[]; mkdtempSites: MkdtempSite[] }> {
  const skeleton = path.join(repoRoot, 'templates', 'skeleton');
  const roots = [
    path.join(repoRoot, 'packages', 'cli', 'test'),
    path.join(repoRoot, 'test', 'e2e'),
    path.join(repoRoot, 'test', 'template'),
    path.join(repoRoot, 'test', 'helpers'),
    skeleton,
  ];
  const removalSites: CallSite[] = [];
  const mkdtempSites: MkdtempSite[] = [];
  for (const root of roots) {
    for (const absFile of await collectSourceFiles(root)) {
      const rel = path.relative(repoRoot, absFile).split(path.sep).join('/');
      if (rel === HELPER_EXEMPT_FILE) continue;
      if (
        root === skeleton &&
        !isSkeletonTestFile(path.relative(skeleton, absFile).split(path.sep).join('/'))
      )
        continue;
      const source = await readFile(absFile, 'utf8');
      removalSites.push(...findCallSitesInSource(rel, source));
      if (rel !== AUDIT_FILE) mkdtempSites.push(...findRepoMkdtempSitesInSource(rel, source));
    }
  }
  return { removalSites, mkdtempSites };
}

describe('fixture-cleanup-audit: recursive removal call sites correspond to fixture-cleanup-exceptions.json', () => {
  let removalSites: CallSite[];
  let exceptions: ExceptionEntry[];

  beforeAll(async () => {
    ({ removalSites } = await scanTree());
    const raw = await readFile(
      path.join(repoRoot, 'test', 'helpers', 'fixture-cleanup-exceptions.json'),
      'utf8',
    );
    exceptions = JSON.parse(raw) as ExceptionEntry[];
  });

  it('names every direct recursive removal site, or documents it as an exception', () => {
    const unlisted = missingExceptions(removalSites, exceptions);
    const detail = unlisted.map((site) => `${site.file}:${site.line}`).join('\n');
    expect(unlisted, detail).toEqual([]);
  });

  it('does not carry an exception for a file with no recursive removal site any more', () => {
    const stale = staleExceptions(removalSites, exceptions);
    const detail = stale.map((entry) => entry.file).join('\n');
    expect(stale, detail).toEqual([]);
  });

  it('gives every exception entry a non-empty reason', () => {
    const missingReason = exceptions.filter((entry) => !entry.reason || !entry.reason.trim());
    expect(missingReason).toEqual([]);
  });
});

describe('fixture-cleanup-audit: in-repository mkdtemp() fixtures correspond to in-repo-fixtures.json', () => {
  let mkdtempSites: MkdtempSite[];
  let entries: InRepoFixtureEntry[];
  let gitignoreText: string;

  beforeAll(async () => {
    ({ mkdtempSites } = await scanTree());
    const raw = await readFile(
      path.join(repoRoot, 'test', 'helpers', 'in-repo-fixtures.json'),
      'utf8',
    );
    entries = JSON.parse(raw) as InRepoFixtureEntry[];
    gitignoreText = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');
  });

  it('names every mkdtemp(path.join(repoRoot, …)) site in in-repo-fixtures.json', () => {
    const unlisted = missingInRepoFixtureEntries(mkdtempSites, entries);
    const detail = unlisted.map((site) => `${site.file}:${site.line}`).join('\n');
    expect(unlisted, detail).toEqual([]);
  });

  it('covers every listed prefix with a .gitignore pattern', () => {
    const uncovered = entries.filter((entry) => !isPrefixIgnored(gitignoreText, entry.prefix));
    const detail = uncovered.map((entry) => `${entry.file} (${entry.prefix})`).join('\n');
    expect(uncovered, detail).toEqual([]);
  });
});
