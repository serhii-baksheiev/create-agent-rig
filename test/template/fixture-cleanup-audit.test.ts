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
//
// Limits, stated: a removal is recognised only when the call and
// `recursive: true` sit on one line, and exceptions are named per file, so a
// new removal in a listed file is not reported. An in-repository mkdtemp is
// recognised across lines, and each one's prefix is checked against its file's
// entries.

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

// `mkdtemp(path.join(repoRoot, …, '<prefix>'))`, whitespace and line breaks
// allowed anywhere between the tokens; the join's arguments hold no parentheses.
const REPO_MKDTEMP = /mkdtemp\(\s*(?:path\.)?join\(\s*repoRoot\b([^()]*)\)/g;

interface MkdtempSite {
  file: string;
  line: number;
  /** The last string literal in the join: the name prefix mkdtemp extends. */
  prefix: string;
}

/** Every in-repository mkdtemp() destination `source` builds, with its prefix. */
function findRepoMkdtempSitesInSource(fileRel: string, source: string): MkdtempSite[] {
  const sites: MkdtempSite[] = [];
  for (const match of source.matchAll(REPO_MKDTEMP)) {
    const literals = [...(match[1] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '');
    sites.push({
      file: fileRel,
      line: source.slice(0, match.index).split('\n').length,
      prefix: literals.at(-1) ?? '',
    });
  }
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
  return sites.filter(
    (site) =>
      !entries.some((entry) => entry.file === site.file && site.prefix.startsWith(entry.prefix)),
  );
}

/**
 * Whether some line of `.gitignore` covers a directory prefix like `.codex-` at
 * any depth — an unanchored pattern, because in-repository fixtures also sit
 * below the root.
 */
function isPrefixIgnored(gitignoreText: string, prefix: string): boolean {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}\\*/?$`);
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

  it('finds an in-repository mkdtemp written across several lines, with the prefix it uses', () => {
    const source = [
      'const nested = await mkdtemp(',
      '  path.join(',
      '    repoRoot,',
      "    'templates',",
      "    '.codex-gitdir-',",
      '  ),',
      ');',
    ].join('\n');
    expect(findRepoMkdtempSitesInSource('example.test.ts', source)).toEqual([
      { file: 'example.test.ts', line: 1, prefix: '.codex-gitdir-' },
    ]);
  });

  it('reports an in-repository site whose prefix its file does not list (mutation: new prefix)', () => {
    const sites = [{ file: 'test/example.test.ts', line: 3, prefix: '.other-scratch-' }];
    const entries = [{ file: 'test/example.test.ts', prefix: '.codex-', reason: 'r' }];
    expect(missingInRepoFixtureEntries(sites, entries)).toEqual(sites);
  });

  it('does not accept a root-anchored pattern, since in-repository fixtures also sit below the root', () => {
    expect(isPrefixIgnored('/.codex-*/\n', '.codex-')).toBe(false);
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
  const perExtension = await Promise.all(
    SOURCE_EXTENSIONS.map((extension) => filesBelow(repoRoot, absDir, { extension })),
  );
  return perExtension.flat();
}

const isSkeletonTestFile = (rel: string): boolean => rel.split('/').includes('test');

async function scanTree(): Promise<{
  removalSites: CallSite[];
  mkdtempSites: MkdtempSite[];
  scannedFiles: string[];
}> {
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
  const scannedFiles: string[] = [];
  for (const root of roots) {
    for (const absFile of await collectSourceFiles(root)) {
      const rel = path.relative(repoRoot, absFile).split(path.sep).join('/');
      if (rel === HELPER_EXEMPT_FILE) continue;
      if (
        root === skeleton &&
        !isSkeletonTestFile(path.relative(skeleton, absFile).split(path.sep).join('/'))
      )
        continue;
      scannedFiles.push(rel);
      const source = await readFile(absFile, 'utf8');
      removalSites.push(...findCallSitesInSource(rel, source));
      if (rel !== AUDIT_FILE) mkdtempSites.push(...findRepoMkdtempSitesInSource(rel, source));
    }
  }
  return { removalSites, mkdtempSites, scannedFiles };
}

describe('fixture-cleanup-audit: recursive removal call sites correspond to fixture-cleanup-exceptions.json', () => {
  let removalSites: CallSite[];
  let scannedFiles: string[];
  let exceptions: ExceptionEntry[];

  beforeAll(async () => {
    ({ removalSites, scannedFiles } = await scanTree());
    const raw = await readFile(
      path.join(repoRoot, 'test', 'helpers', 'fixture-cleanup-exceptions.json'),
      'utf8',
    );
    exceptions = JSON.parse(raw) as ExceptionEntry[];
  });

  it('reads the trees it claims to scan, so an empty walk cannot pass', () => {
    expect(scannedFiles).toContain('packages/cli/test/create.test.ts');
    expect(scannedFiles).toContain('test/e2e/init.test.ts');
    expect(scannedFiles).toContain('test/template/codex.test.ts');
    expect(scannedFiles).toContain(
      'templates/skeleton/node-service/services/api/test/server.test.ts',
    );
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
