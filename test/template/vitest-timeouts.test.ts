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
