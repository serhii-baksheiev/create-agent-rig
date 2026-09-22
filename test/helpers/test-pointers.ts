/**
 * RP-184: the evidence-pointer resolver `test/template/compatibility-matrix.test.ts`
 * defined for `docs/compatibility.md` — pulled out so `test/template/command-contract.test.ts`
 * and `test/template/readme-promises.test.ts` can resolve the same pointer form
 * against `docs/command-contract.md` without a second copy of the rules below
 * (`.claude/rules/invariants.md`, "One mechanism, one implementation").
 *
 * What counts as a pointer, stated exactly: a backticked `*.test.ts` or
 * `*.test.mjs` name — a bare file name, or a repository-relative path —
 * followed by one or more `› "test name"` segments. A path resolves to that
 * one tracked file; a bare name resolves to the tracked file with that
 * basename, and `candidatesFor` returns more than one entry when two tracked
 * files share it (`upgrade.test.ts` exists twice) — the caller refuses that
 * case rather than picking one silently, because a silent pick is how a
 * citation ends up checking a file nobody meant.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export interface Pointer {
  file: string;
  names: string[];
}

const POINTER = /`([\w./-]+\.test\.(?:ts|mjs))`((?:\s*(?:and\s*)?›\s*"[^"]+")*)/g;

/** Every pointer in one cell/fragment of prose, with its quoted test names. */
export function pointers(cell: string): Pointer[] {
  return [...cell.matchAll(POINTER)].map((m) => ({
    file: m[1]!,
    names: [...m[2]!.matchAll(/"([^"]+)"/g)].map((n) => n[1]!),
  }));
}

const DEFAULT_TEST_DIRS = ['test', 'packages/cli/test'];

/** Every tracked `*.test.ts`/`*.test.mjs` file under the given directories. */
export function trackedTestFiles(
  repoRoot: string,
  dirs: readonly string[] = DEFAULT_TEST_DIRS,
): string[] {
  return execFileSync('git', ['ls-files', ...dirs], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => /\.test\.(ts|mjs)$/.test(f));
}

/**
 * Every tracked path a pointer could mean. A bare basename that two files
 * share resolves to BOTH, and the caller refuses it: picking one silently is
 * how a citation ends up pointing at a file nobody meant. A pointer that
 * carries a path names one file and resolves.
 */
export function candidatesFor(pointerFile: string, files: readonly string[]): string[] {
  if (pointerFile.includes('/')) return files.filter((f) => f === pointerFile);
  return files.filter((f) => path.basename(f) === pointerFile);
}
