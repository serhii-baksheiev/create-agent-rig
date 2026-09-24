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

// In package-manager-transport.test.ts RP-212 bounds the CLI-start case's own
// child with `PACKAGE_MANAGER_START_CHILD_TIMEOUT_MS` (the case budget minus a
// margin). It carries the word `timeout:` without being a vitest case/describe
// budget — what the matcher below must tell apart from the one genuine budget
// that file still has, and it must do so by identifier, never by accepting any
// numeric literal, or a stray literal `timeout:` on an unrelated case reads
// as compliant.

// Matches a `const NAME = <expr>;` declaration whose NAME is SCREAMING_CASE
// ending in `_BOUND_MS` or `_CHILD_TIMEOUT_MS`, and whose `<expr>` is either a
// bare numeric literal or `PACKAGE_MANAGER_START_CASE_TIMEOUT_MS - <number>`.
const NAMED_BOUND_DECLARATION =
  /^const ([A-Z][A-Z0-9_]*(?:_BOUND_MS|_CHILD_TIMEOUT_MS)) = (PACKAGE_MANAGER_START_CASE_TIMEOUT_MS\s*-\s*\d[\d_]*|\d[\d_]*);$/gm;

// Resolves every declaration `NAMED_BOUND_DECLARATION` finds to its numeric
// value, substituting `caseValue` for `PACKAGE_MANAGER_START_CASE_TIMEOUT_MS`
// where the declaration is expressed as a margin below it.
function resolveNamedBounds(source: string, caseValue: number): Map<string, number> {
  const bounds = new Map<string, number>();
  for (const match of source.matchAll(NAMED_BOUND_DECLARATION)) {
    const name = match[1] ?? '';
    const expr = match[2] ?? '';
    const asMargin = expr.match(/^PACKAGE_MANAGER_START_CASE_TIMEOUT_MS\s*-\s*(\d[\d_]*)$/);
    const value = asMargin
      ? caseValue - Number((asMargin[1] ?? '').replaceAll('_', ''))
      : Number(expr.replaceAll('_', ''));
    bounds.set(name, value);
  }
  return bounds;
}

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

  it('gives every other timeout: key in that file a named child-process bound below the case budget, never a case budget or a literal', async () => {
    const source = await readPackageManagerTransportTestSource();
    const code = source.replace(/\/\/[^\n]*/g, '');

    const caseBudget = source.match(PACKAGE_MANAGER_START_CASE_BUDGET_DECLARATION);
    expect(caseBudget).not.toBeNull();
    const caseValue = Number((caseBudget?.[1] ?? '').replaceAll('_', ''));

    const namedBounds = resolveNamedBounds(source, caseValue);
    expect(namedBounds.size, 'at least one named child bound is declared').toBeGreaterThan(0);
    for (const [name, value] of namedBounds) {
      expect(value, `${name} must be numerically below the case budget`).toBeLessThan(caseValue);
    }

    // The one genuine vitest per-case budget, and nothing else classified as
    // one — unchanged from the check above, restated here so the exclusion
    // below only ever strips that single, known occurrence.
    const caseOptionMatches = code.match(VITEST_CASE_OPTION_TIMEOUT) ?? [];
    expect(caseOptionMatches, 'the one case-budget usage').toHaveLength(1);

    // Every remaining `timeout:` key — whatever call it sits in, `.each`,
    // `.concurrent`, `.for`, or a plain function call — must resolve to one
    // of the named bounds above. A bare numeric literal or any other
    // identifier fails, which is the point: neither is a declared, bounded
    // constant this test can check against the case budget.
    const withoutCaseBudget = code.replace(VITEST_CASE_OPTION_TIMEOUT, '');
    const remainingTimeoutValues = [
      ...withoutCaseBudget.matchAll(/\btimeout\s*:\s*([^,}\n]+)/g),
    ].map((m) => (m[1] ?? '').trim());

    expect(remainingTimeoutValues.length).toBeGreaterThan(0);
    for (const value of remainingTimeoutValues) {
      expect(
        namedBounds.has(value),
        `unexpected timeout: value "${value}" — neither the case budget nor a named bound declared below it`,
      ).toBe(true);
    }
  });

  it("the CLI-start case's own child call is bound by the named child timeout, never a literal", async () => {
    const source = await readPackageManagerTransportTestSource();
    const code = source.replace(/\/\/[^\n]*/g, '');

    const calls = [
      ...code.matchAll(/runPackageManager\(\s*manager\s*,\s*\[[^\]]*\]\s*,\s*\{([^{}]*)\}\s*\)/g),
    ];
    expect(calls.length, 'runPackageManager is called from the CLI-start case').toBeGreaterThan(0);

    for (const call of calls) {
      const optionsBody = call[1] ?? '';
      expect(optionsBody).toMatch(/\btimeout\s*:\s*PACKAGE_MANAGER_START_CHILD_TIMEOUT_MS\b/);
    }
  });
});

// RP-248. On a hosted windows-e2e stall window, `runSpecKitLifecycle` cases
// (packages/cli/test/spec-kit.test.ts) and `createProject` cases
// (packages/cli/test/create.test.ts) time out at 60 s with no child output
// kept: their own children are bounded at 120 s (production's
// `invoke()`, packages/cli/src/integrations/spec-kit.ts:255) or at
// `runProviderProcess`'s 60 s default when no `timeoutMs` is given at all
// (packages/cli/src/integrations/spawn.ts) — both at or above the vitest CASE
// budget these two files run their cases under, so vitest aborts the case
// before either bound would ever fire, the child is left running with the
// fixture as its cwd, and `afterEach`'s `removeFixture` hits EBUSY instead of
// reporting the child that actually stalled. A case cannot out-wait a child
// whose own bound is not strictly smaller than the case's.
//
// The fix these two checks require of each file: every child process spawn it
// makes carries its OWN named bound — reusing the `_BOUND_MS` /
// `_CHILD_TIMEOUT_MS` convention `resolveNamedBounds` above already reads —
// strictly below that file's case budget, and never forwards a caller-supplied
// or default timeout unexamined.

/**
 * Every call to `calleeName(...)` in `source`, as the raw argument text
 * between its parentheses. Textual, not a parse: a paren inside a string or a
 * `/* *\/`-style comment would mis-balance the scan. Neither check below feeds
 * it a file where one occurs — verified by reading both files once, not
 * enforced here.
 */
function extractCallArgs(source: string, calleeName: string): string[] {
  const callsites: string[] = [];
  const opener = new RegExp(`\\b${calleeName}\\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
      i += 1;
    }
    callsites.push(source.slice(start, i - 1));
  }
  return callsites;
}

const NAMED_BOUND_IDENTIFIER = /^[A-Z][A-Z0-9_]*(?:_BOUND_MS|_CHILD_TIMEOUT_MS)$/;

async function readSpecKitTestSource(): Promise<string> {
  return readFile(path.join(repoRoot, 'packages', 'cli', 'test', 'spec-kit.test.ts'), 'utf8');
}

// The file's one describe block declares its case budget inline, per
// platform, rather than through a named constant — read literally, and
// resolved for whichever platform this very check is running on, which is
// the platform its own `describe(...)` will resolve to as well.
const SPEC_KIT_CASE_BUDGET_DECLARATION =
  /timeout:\s*process\.platform === 'win32' \? (\d[\d_]*) : (\d[\d_]*)/;

function specKitCaseBudget(source: string): number {
  const declared = source.match(SPEC_KIT_CASE_BUDGET_DECLARATION);
  expect(declared, 'spec-kit.test.ts declares its case budget the expected way').not.toBeNull();
  const win32Budget = declared?.[1] ?? '';
  const otherBudget = declared?.[2] ?? '';
  const chosen = process.platform === 'win32' ? win32Budget : otherBudget;
  return Number(chosen.replaceAll('_', ''));
}

describe('the spec-kit lifecycle test children (RP-248)', () => {
  it('gives every runProviderProcess call its own named bound, never a forwarded or default one', async () => {
    const source = await readSpecKitTestSource();
    const code = source.replace(/\/\/[^\n]*/g, '');
    const calls = extractCallArgs(code, 'runProviderProcess');
    expect(calls.length, 'runProviderProcess call sites in the file').toBeGreaterThan(0);

    for (const args of calls) {
      const declaredTimeoutMs = args.match(/timeoutMs\s*:\s*([^,}\n]+)/);
      expect(
        declaredTimeoutMs,
        `runProviderProcess(${args.trim().slice(0, 80)}) must set its own timeoutMs`,
      ).not.toBeNull();
      const value = (declaredTimeoutMs?.[1] ?? '').trim();
      expect(
        value,
        `runProviderProcess's timeoutMs ("${value}") must name one of this file's own declared bounds, not a forwarded caller value or a bare literal`,
      ).toMatch(NAMED_BOUND_IDENTIFIER);
    }
  });

  it('declares at least one named child bound strictly below the case budget', async () => {
    const source = await readSpecKitTestSource();
    const budget = specKitCaseBudget(source);
    const bounds = resolveNamedBounds(source, budget);
    expect(bounds.size, 'named child-process bounds declared in the file').toBeGreaterThan(0);
    for (const [name, value] of bounds) {
      expect(value, `${name} must be numerically below the case budget`).toBeLessThan(budget);
    }
  });
});

async function readCreateTestSource(): Promise<string> {
  return readFile(path.join(repoRoot, 'packages', 'cli', 'test', 'create.test.ts'), 'utf8');
}

const CREATE_CASE_BUDGET_DECLARATION =
  /describe\('createProject',\s*\{\s*timeout:\s*(\d[\d_]*)\s*\}/;

function createCaseBudget(source: string): number {
  const declared = source.match(CREATE_CASE_BUDGET_DECLARATION);
  expect(declared, 'create.test.ts declares its case budget the expected way').not.toBeNull();
  return Number((declared?.[1] ?? '').replaceAll('_', ''));
}

describe("the createProject test's own git children (RP-248)", () => {
  it("gives every git child call its own named bound — none of the file's exec('git', …) calls carry a timeout today", async () => {
    const source = await readCreateTestSource();
    const code = source.replace(/\/\/[^\n]*/g, '');
    const calls = extractCallArgs(code, 'exec').filter((args) => /^\s*'git'/.test(args));
    expect(calls.length, "exec('git', …) call sites in the file").toBeGreaterThan(0);

    for (const args of calls) {
      const declaredTimeout = args.match(/\btimeout\s*:\s*([^,}\n]+)/);
      expect(
        declaredTimeout,
        `exec(${args.trim().slice(0, 60)}) must set its own timeout`,
      ).not.toBeNull();
      const value = (declaredTimeout?.[1] ?? '').trim();
      expect(
        value,
        `exec's timeout ("${value}") must name one of this file's own declared bounds, never a bare literal`,
      ).toMatch(NAMED_BOUND_IDENTIFIER);
    }
  });

  it('declares at least one named child bound strictly below the case budget', async () => {
    const source = await readCreateTestSource();
    const budget = createCaseBudget(source);
    const bounds = resolveNamedBounds(source, budget);
    expect(bounds.size, 'named child-process bounds declared in the file').toBeGreaterThan(0);
    for (const [name, value] of bounds) {
      expect(value, `${name} must be numerically below the case budget`).toBeLessThan(budget);
    }
  });
});
