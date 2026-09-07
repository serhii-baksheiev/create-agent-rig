import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SCAN_IGNORE_GLOBS,
  SKIPPED_DIRECTORY_NAMES,
  SKIPPED_REPOSITORY_PATHS,
  filesBelow,
  skipsScan,
} from '../helpers/scan-exclusions.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const templateTests = path.dirname(fileURLToPath(import.meta.url));

// RP-155. The `worktree-task` skill puts a session's checkout under
// `.claude/worktrees/<name>/`, and the repository scans in test/template walked
// into it: consistency.test.ts rooted a markdown walk at `.claude/` with only
// `node_modules` excluded, so a sibling checkout's
// `.claude/worktrees/<name>/journal/2026-08.md:311` was reported as THIS repo's
// chain drift — one offence per worktree present. PR #197 carried the lint half
// as a literal `'.claude/worktrees/**'` in eslint.config.mjs, stated there as a
// second copy; test/helpers/scan-exclusions.mjs is the one spelling that
// literal and every walker now take from.

describe('one exclusion list for every repository scan', () => {
  it('names node_modules and .git as skipped wherever they sit, and .claude/worktrees as a skipped subtree', () => {
    expect(SKIPPED_DIRECTORY_NAMES).toEqual(['node_modules', '.git']);
    expect(SKIPPED_REPOSITORY_PATHS).toEqual(['.claude/worktrees']);
    expect(SCAN_IGNORE_GLOBS).toEqual(['**/node_modules/**', '**/.git/**', '.claude/worktrees/**']);
  });

  it('skipsScan refuses a worktree path, a nested node_modules, and nothing else', () => {
    // path.join, not string concatenation: on win32 the segments are joined with
    // backslashes, which is exactly the shape the helper has to read.
    const root = path.join(os.tmpdir(), 'rp155-root');

    expect(skipsScan(root, path.join(root, '.claude', 'worktrees', 'x', 'journal', 'a.md'))).toBe(
      true,
    );
    expect(skipsScan(root, path.join(root, '.claude', 'worktrees'))).toBe(true);
    expect(
      skipsScan(root, path.join(root, 'packages', 'cli', 'node_modules', 'y', 'index.js')),
    ).toBe(true);

    expect(skipsScan(root, path.join(root, '.claude', 'scripts', 'queue', 'index.mjs'))).toBe(
      false,
    );
    expect(skipsScan(root, path.join(root, 'journal', '2026-09.md'))).toBe(false);
    expect(
      skipsScan(
        root,
        path.join(root, 'templates', 'agent-os', 'universal', '.claude', 'rules', 'autonomy.md'),
      ),
    ).toBe(false);
  });

  it('filesBelow does not report a file inside a nested checkout under .claude/worktrees/, and still reports its siblings', async () => {
    // Acceptance 1 of the item, on disk: a scratch root OUTSIDE the repository
    // carrying the shape that produced the measured offence.
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'rp155-scan-'));
    try {
      const rules = path.join(scratch, '.claude', 'rules');
      const probe = path.join(scratch, '.claude', 'worktrees', 'probe');
      await mkdir(rules, { recursive: true });
      await mkdir(path.join(probe, 'journal'), { recursive: true });
      await writeFile(path.join(rules, 'keep.md'), '# keep\n');
      // The drifted chain the consistency scan flags — it must not be seen here.
      await writeFile(
        path.join(probe, 'journal', '2026-08.md'),
        'a run once wrote payload → handler → model here\n',
      );
      await writeFile(path.join(probe, 'eslint.config.mjs'), 'export default [];\n');

      const found = await filesBelow(scratch, path.join(scratch, '.claude'), { extension: '.md' });
      const relative = found.map((file: string) =>
        path.relative(scratch, file).split(path.sep).join('/'),
      );

      expect(relative).toContain('.claude/rules/keep.md');
      expect(relative.filter((p: string) => p.startsWith('.claude/worktrees'))).toEqual([]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('the ESLint ignore globs are the same facts, not a third spelling', () => {
    const derived = [
      ...SKIPPED_DIRECTORY_NAMES.map((name: string) => `**/${name}/**`),
      ...SKIPPED_REPOSITORY_PATHS.map((repoPath: string) => `${repoPath}/**`),
    ];
    expect([...SCAN_IGNORE_GLOBS].sort()).toEqual([...derived].sort());
  });
});

describe('the scanners that can reach .claude/ use the shared list, and the rest are recorded', () => {
  it('consistency.test.ts imports filesBelow from the helper and carries no walker of its own', async () => {
    const source = await readFile(path.join(templateTests, 'consistency.test.ts'), 'utf8');
    expect(source).toMatch(/from '\.\.\/helpers\/scan-exclusions\.mjs'/);
    expect(source).not.toMatch(/withFileTypes/);
  });

  it('command-contract.test.ts, which roots under .claude/scripts and .claude/hooks, walks through the helper too', async () => {
    const source = await readFile(path.join(templateTests, 'command-contract.test.ts'), 'utf8');
    expect(source).toMatch(/from '\.\.\/helpers\/scan-exclusions\.mjs'/);
    expect(source).not.toMatch(/withFileTypes/);
  });

  it('eslint.config.mjs takes its ignores from the helper, not from literals', async () => {
    const source = await readFile(path.join(repoRoot, 'eslint.config.mjs'), 'utf8');
    expect(source).toMatch(/scan-exclusions\.mjs/);
    expect(source).not.toContain("'.claude/worktrees/**'");
  });

  // The record below is measured, not remembered. The item's premise — that only
  // consistency.test.ts walked a tree — was false: fifteen files here still call
  // readdir with `withFileTypes: true` or `recursive: true` themselves (the regex
  // tolerates one level of parentheses in the first argument, so a call whose
  // directory is itself a path.join(...) expression counts). Every one of
  // them roots inside templates/, packages/, test/, contracts/, journal/ or a
  // scratch fixture, where a sibling checkout cannot sit, so they are recorded
  // here rather than rewritten; the two that root under THIS repository's
  // `.claude/` — consistency.test.ts at `.claude` itself, command-contract.test.ts
  // at `.claude/scripts` and `.claude/hooks` — walk through the helper and so are
  // absent from the record. The last assertion reads every `path.join(repoRoot,
  // '.claude' …)` root in the directory: only consistency.test.ts may root at
  // `.claude` exactly, and nothing may root at `.claude/worktrees`. A new walker
  // added later must either join the recorded list with such a root, or import
  // the helper.
  it('every other recursive walker in test/template roots outside .claude/, and the list is the record', async () => {
    const RECURSIVE_READDIR =
      /readdir(Sync)?\((?:[^()]|\([^()]*\))*(withFileTypes|recursive): true/;
    const DOT_CLAUDE_ROOT = /path\.join\(repoRoot,\s*'\.claude'(?:,\s*'([^']+)')?\)/g;

    const names = (await readdir(templateTests)).filter((name) => name.endsWith('.test.ts'));
    const walkers: string[] = [];
    const rootedAtDotClaude: string[] = [];
    const rootedUnderDotClaude: Record<string, string[]> = {};
    for (const name of names) {
      const source = await readFile(path.join(templateTests, name), 'utf8');
      if (RECURSIVE_READDIR.test(source)) walkers.push(name);
      for (const match of source.matchAll(DOT_CLAUDE_ROOT)) {
        if (match[1] === undefined) rootedAtDotClaude.push(name);
        else (rootedUnderDotClaude[name] ??= []).push(match[1]);
      }
    }

    expect(walkers.sort()).toEqual([
      'composition.test.ts',
      'correspondence.test.ts',
      'decision-records.test.ts',
      'decision-router.test.ts',
      'e2e-install-network.test.ts',
      'e2e-pack.test.ts',
      'generator-neutrality.test.ts',
      'git-env.test.ts',
      'hash-history.test.ts',
      'invariants.test.ts',
      'journal.test.ts',
      'platform-skips.test.ts',
      'policy-declaration.test.ts',
      'run-journal.test.ts',
      'session-messaging-schema.test.ts',
    ]);
    expect([...new Set(rootedAtDotClaude)]).toEqual(['consistency.test.ts']);
    for (const [name, segments] of Object.entries(rootedUnderDotClaude)) {
      expect(
        segments,
        `${name} roots a path at .claude/${segments.join(', .claude/')}`,
      ).not.toContain('worktrees');
    }
  });
});
