// RP-315: BMAD TEA (Test Architecture & Evaluator, from
// `bmad-method-test-architecture-enterprise@1.27.2`)'s user-facing
// documentation surface. Loose, substring-level assertions against three
// documents that already exist and already describe a sibling producer the
// same way (Playwright MCP, `playwright-docs.test.ts`) — this pins that BMAD
// TEA gets the same treatment, not an exact wording.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const README_PATH = path.join(repoRoot, 'README.md');
const CONTRACT_PATH = path.join(repoRoot, 'docs', 'command-contract.md');
const ARTIFACT_EVIDENCE_PATH = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'universal',
  'docs',
  'decisions',
  'artifact-evidence.md',
);

describe('README.md integrations table lists BMAD TEA (RP-315)', () => {
  it('names BMAD TEA and its bmad-tea id in the integrations table', async () => {
    const readme = await readFile(README_PATH, 'utf8');
    expect(readme).toMatch(/BMAD TEA/);
    expect(readme).toMatch(/bmad-tea/);
  });
});

describe("docs/command-contract.md's support matrix names BMAD TEA's own install command and pinned version (RP-315)", () => {
  it('names the bmad-method install command, the tea module, and version 1.27.2', async () => {
    const contract = await readFile(CONTRACT_PATH, 'utf8');
    expect(contract).toMatch(/npx bmad-method install --modules tea/);
    expect(contract).toMatch(/1\.27\.2/);
  });

  it('states Rig never installs TEA', async () => {
    const contract = await readFile(CONTRACT_PATH, 'utf8');
    expect(contract).toMatch(
      /BMAD TEA[\s\S]{0,400}never installs|never installs[\s\S]{0,400}BMAD TEA/i,
    );
  });
});

describe("docs/decisions/artifact-evidence.md's Applicability paragraph names BMAD TEA as a second advisory-only producer (RP-315)", () => {
  it('names BMAD TEA and RP-315 in the Applicability paragraph', async () => {
    const content = await readFile(ARTIFACT_EVIDENCE_PATH, 'utf8');
    expect(content).toMatch(/\*\*Applicability\.\*\*[\s\S]{0,600}BMAD TEA/);
    expect(content).toMatch(/RP-315/);
  });

  it('says BMAD TEA is a second producer whose gate words are advisory only', async () => {
    const content = await readFile(ARTIFACT_EVIDENCE_PATH, 'utf8');
    expect(content).toMatch(/\*\*Applicability\.\*\*[\s\S]{0,600}second producer/i);
    expect(content).toMatch(/\*\*Applicability\.\*\*[\s\S]{0,600}advisory/i);
  });
});
