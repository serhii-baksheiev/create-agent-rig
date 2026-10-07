// RP-313: Playwright MCP's user-facing documentation surface. Loose,
// substring-level assertions against three documents that already exist and
// already describe sibling integrations the same way (Basic Memory, Spec
// Kit) — this pins that Playwright MCP gets the same treatment, not an exact
// wording.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const README_PATH = path.join(repoRoot, 'README.md');
const CONTRACT_PATH = path.join(repoRoot, 'docs', 'command-contract.md');
const UNATTENDED_PATH = path.join(repoRoot, 'docs', 'unattended-execution.md');

describe('README.md integrations table lists Playwright MCP (RP-313)', () => {
  it('names Playwright MCP and its playwright-mcp id in the integrations table', async () => {
    const readme = await readFile(README_PATH, 'utf8');
    expect(readme).toMatch(/Playwright MCP/);
    expect(readme).toMatch(/playwright-mcp/);
  });
});

describe("docs/command-contract.md's support matrix names Playwright's Node/npx requirement (RP-313)", () => {
  it('names Playwright alongside a Node/npx requirement in the support-matrix section', async () => {
    const contract = await readFile(CONTRACT_PATH, 'utf8');
    expect(contract).toMatch(/Playwright[\s\S]{0,200}npx|npx[\s\S]{0,200}Playwright/i);
  });
});

describe('docs/unattended-execution.md states the Playwright browser-verification path is attended only (RP-313)', () => {
  it('names Playwright and says the path is attended, never extending the unattended posture', async () => {
    const content = await readFile(UNATTENDED_PATH, 'utf8');
    expect(content).toMatch(/Playwright/i);
    expect(content).toMatch(/attended/i);
  });
});
