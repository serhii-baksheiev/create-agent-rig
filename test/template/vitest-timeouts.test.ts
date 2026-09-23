import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Under a full parallel `pnpm test` the template tests that spawn a stub `gh`
// have hit vitest's 5 s default while passing alone (AR-143). CI already runs
// the unit lane with --testTimeout=15000; the template project declares the
// same figure so the local and e2e.yml runs get it too.
const projects = (config as { test?: { projects?: unknown[] } }).test?.projects ?? [];
const templateProject = projects.find(
  (p): p is { test: { name: string; testTimeout?: number } } =>
    typeof p === 'object' &&
    p !== null &&
    (p as { test?: { name?: string } }).test?.name === 'template',
);

describe('vitest template project timeout', () => {
  it('gives the template project the timeout CI already runs with, so a load-sensitive spawn is not read as a failure', () => {
    expect(templateProject).toBeDefined();
    expect(templateProject?.test.testTimeout).toBe(15_000);
  });

  it('keeps that figure equal to the --testTimeout ci.yml passes, so the two cannot drift', async () => {
    const ci = await readFile(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    const figures = [...ci.matchAll(/--testTimeout=(\d+)/g)].map((m) => Number(m[1]));
    expect(figures.length).toBeGreaterThan(0);
    for (const figure of figures) {
      expect(templateProject?.test.testTimeout).toBe(figure);
    }
  });
});

// RP-191. ci.yml hands the unit lane 15 s on the command line, but e2e.yml's
// windows-e2e runs the whole suite (`pnpm test --maxWorkers=2`) and cannot pass
// --testTimeout without overriding the e2e project's own figure. So under the
// full suite the unit project alone ran on vitest's 5 s default, and two of its
// cases that install a rig timed out on the hosted Windows runner (run
// 35528246325) — hidden on master behind the RP-190 failure. The unit project
// declares the figure itself, the way the template project does.
const unitProject = projects.find(
  (p): p is { test: { name: string; testTimeout?: number } } =>
    typeof p === 'object' &&
    p !== null &&
    (p as { test?: { name?: string } }).test?.name === 'unit',
);

describe('vitest unit project timeout', () => {
  it('gives the unit project under the full suite the timeout ci.yml already runs it with', async () => {
    expect(unitProject).toBeDefined();
    expect(unitProject?.test.testTimeout).toBe(15_000);

    const ci = await readFile(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    const unitLane = ci.match(/pnpm test:unit --testTimeout=(\d+)/);
    expect(unitLane).not.toBeNull();
    expect(unitProject?.test.testTimeout).toBe(Number(unitLane?.[1]));
  });
});

// RP-162. test/template/codex.test.ts has exactly one case that starts
// powershell.exe. Measured on the hosted windows-unit runner, same code, four
// runs: 817 ms, 3747 ms, 6794 ms and >15000 ms (timed out at the template
// project's budget). The work cannot shrink: one powershell.exe start is the
// case. So that one `it(...)` carries its own vitest per-case timeout, and
// the file-wide figure above stays where it is.
const WINDOWS_POWERSHELL_CASE_NAME =
  'anchors a nested-cwd Windows Codex rulebook edit to the canonical repository root';
const CASE_BUDGET_DECLARATION = /^const WINDOWS_POWERSHELL_CASE_TIMEOUT_MS = (\d[\d_]*);/m;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readCodexTestSource(): Promise<string> {
  return readFile(path.join(repoRoot, 'test', 'template', 'codex.test.ts'), 'utf8');
}

describe('the one case that starts Windows PowerShell', () => {
  it("carries its own budget, declared once by name and passed as that case's options", async () => {
    const source = await readCodexTestSource();

    expect(source).toMatch(CASE_BUDGET_DECLARATION);

    const caseWithOptions = new RegExp(
      `it\\(\\s*'${escapeRegExp(WINDOWS_POWERSHELL_CASE_NAME)}'\\s*,\\s*\\{ timeout: WINDOWS_POWERSHELL_CASE_TIMEOUT_MS \\}`,
    );
    expect(source).toMatch(caseWithOptions);
  });

  it('is bounded above so a genuine hang still fails within a minute, and sits above the lane budget it replaces', async () => {
    const source = await readCodexTestSource();
    const declared = source.match(CASE_BUDGET_DECLARATION);
    expect(declared).not.toBeNull();

    const budget = Number((declared?.[1] ?? '').replaceAll('_', ''));
    expect(Number.isInteger(budget)).toBe(true);
    expect(templateProject?.test.testTimeout).toBeDefined();
    expect(budget).toBeGreaterThan(templateProject?.test.testTimeout ?? Number.POSITIVE_INFINITY);
    expect(budget).toBeLessThanOrEqual(60_000);
  });

  it('is the only case in that file with a budget of its own — the figure moves for one case, not for the file', async () => {
    // Both spellings vitest accepts, read outside comments: a `timeout:` key in
    // an options object however it is spaced or combined, and the numeric
    // trailing argument `}, 20_000)` that queue.test.ts uses.
    const code = (await readCodexTestSource()).replace(/\/\/[^\n]*/g, '');
    const optionKeys = code.match(/\btimeout\s*:/g) ?? [];
    const trailingFigures = code.match(/\}\s*,\s*\d[\d_]*\s*\);/g) ?? [];
    expect(optionKeys, 'timeout keys in options objects').toHaveLength(1);
    expect(trailingFigures, 'numeric trailing-argument budgets').toHaveLength(0);
  });
});

// RP-158. test/template/package-manager-transport.test.ts has one
// `it.each(['npm', 'pnpm', 'npx'] as const)` case that starts a real
// package-manager CLI child process ('runs the installed %s CLI directly and
// returns its version'). Measured on the hosted windows-e2e runner, same
// code, across separate runs: 4670 ms (run 35200784928), 7023 ms (run
// 35193542091), and in run 35202028836 "Error: Test timed out in 15000ms." at
// 16525 ms, followed by "EBUSY: resource busy or locked, rmdir
// '...\\caf-package-manager-...'" from afterEach because the still-running
// pnpm child held its cwd. The npm and npx siblings of the same it.each took
// 123 ms / 152 ms — the case cannot shrink: one package-manager CLI start is
// the whole of it. So that one parametrised case carries its own vitest
// per-case timeout, and the file-wide figure above stays where it is.
const PACKAGE_MANAGER_START_CASE_NAME =
  'runs the installed %s CLI directly and returns its version';
const PACKAGE_MANAGER_START_CASE_BUDGET_DECLARATION =
  /^const PACKAGE_MANAGER_START_CASE_TIMEOUT_MS = (\d[\d_]*);/m;

// RP-212 bounds the *child process* the CLI-start case spawns —
// `PACKAGE_MANAGER_START_CHILD_TIMEOUT_MS`, declared as the case budget minus
// a margin — and exercises that bound with a literal `execFile` timeout in a
// second case. Both carry the word `timeout:` without being a vitest
// case/describe budget, which is exactly what the matcher below must tell
// apart from the one genuine budget it still expects.
const PACKAGE_MANAGER_START_CHILD_BOUND_DECLARATION =
  /^const PACKAGE_MANAGER_START_CHILD_TIMEOUT_MS = PACKAGE_MANAGER_START_CASE_TIMEOUT_MS - (\d[\d_]*);/m;

// Matches `timeout` set as a direct option of an it/test/describe call —
// including through one `.each(...)`, `.skipIf(...)` or `.runIf(...)` link —
// never a plain object literal handed to an ordinary function call such as
// `runPackageManager(...)` or `run(...)`. Limits: follows at most one such
// chained modifier, and assumes the options object itself carries no nested
// `{}` — true of every case in this file today.
const VITEST_CASE_OPTION_TIMEOUT =
  /\b(?:it|test|describe)(?:\.(?:each\([^()]*\)|skipIf\([^()]*\)|runIf\([^()]*\)))?\(\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*,\s*\{[^{}]*\btimeout\s*:[^{}]*\}/g;

async function readPackageManagerTransportTestSource(): Promise<string> {
  return readFile(
    path.join(repoRoot, 'test', 'template', 'package-manager-transport.test.ts'),
    'utf8',
  );
}

describe('the package-manager CLI start cases', () => {
  it("carries its own budget, declared once by name and passed as that parametrised case's options", async () => {
    const source = await readPackageManagerTransportTestSource();

    expect(source).toMatch(PACKAGE_MANAGER_START_CASE_BUDGET_DECLARATION);

    const caseWithOptions = new RegExp(
      `it\\.each\\([^)]*\\)\\(\\s*'${escapeRegExp(PACKAGE_MANAGER_START_CASE_NAME)}'\\s*,\\s*\\{ timeout: PACKAGE_MANAGER_START_CASE_TIMEOUT_MS \\}`,
    );
    expect(source).toMatch(caseWithOptions);
  });

  it('is bounded above so a genuine hang still fails within a minute, and sits above the lane budget it replaces', async () => {
    const source = await readPackageManagerTransportTestSource();
    const declared = source.match(PACKAGE_MANAGER_START_CASE_BUDGET_DECLARATION);
    expect(declared).not.toBeNull();

    const budget = Number((declared?.[1] ?? '').replaceAll('_', ''));
    expect(Number.isInteger(budget)).toBe(true);
    expect(templateProject?.test.testTimeout).toBeDefined();
    expect(budget).toBeGreaterThan(templateProject?.test.testTimeout ?? Number.POSITIVE_INFINITY);
    expect(budget).toBeLessThanOrEqual(60_000);
  });

  it('is the only vitest budget of its own in that file — the figure moves for the CLI-start case, not for the file', async () => {
    const code = (await readPackageManagerTransportTestSource()).replace(/\/\/[^\n]*/g, '');

    const caseOptionMatches = code.match(VITEST_CASE_OPTION_TIMEOUT) ?? [];
    // Both spellings vitest accepts for a bare per-case override: the numeric
    // trailing argument `}, 20_000)` that queue.test.ts uses. Limit: a plain
    // textual scan for that closing shape, not a parse — sound only because
    // nothing else in this file closes a block with `, <number>);`.
    const trailingFigures = code.match(/\}\s*,\s*\d[\d_]*\s*\);/g) ?? [];

    expect(
      caseOptionMatches.length + trailingFigures.length,
      'vitest per-case/describe budgets in the whole file',
    ).toBe(1);
    expect(caseOptionMatches, "the one budget is the CLI-start case's options object").toHaveLength(
      1,
    );
    expect(trailingFigures, 'no case carries a bare trailing-argument budget instead').toHaveLength(
      0,
    );
  });

  it('gives every other timeout: key in that file a child-process bound, never a case budget', async () => {
    const source = await readPackageManagerTransportTestSource();
    const code = source.replace(/\/\/[^\n]*/g, '');

    const withoutCaseBudgets = code.replace(VITEST_CASE_OPTION_TIMEOUT, '');
    const childTimeoutValues = [...withoutCaseBudgets.matchAll(/\btimeout\s*:\s*([^,}\n]+)/g)].map(
      (m) => (m[1] ?? '').trim(),
    );

    expect(childTimeoutValues.length).toBeGreaterThan(0);
    for (const value of childTimeoutValues) {
      expect(
        value === 'PACKAGE_MANAGER_START_CHILD_TIMEOUT_MS' || /^\d[\d_]*$/.test(value),
        `unexpected timeout: value "${value}" — neither the named child bound nor a numeric literal`,
      ).toBe(true);
    }

    const caseBudget = source.match(PACKAGE_MANAGER_START_CASE_BUDGET_DECLARATION);
    expect(caseBudget).not.toBeNull();
    const caseValue = Number((caseBudget?.[1] ?? '').replaceAll('_', ''));

    const childBound = source.match(PACKAGE_MANAGER_START_CHILD_BOUND_DECLARATION);
    expect(
      childBound,
      'the named child bound is declared as the case budget minus a positive margin',
    ).not.toBeNull();
    const margin = Number((childBound?.[1] ?? '').replaceAll('_', ''));
    expect(margin).toBeGreaterThan(0);

    const childValue = caseValue - margin;
    expect(childValue).toBeLessThan(caseValue);
  });
});
