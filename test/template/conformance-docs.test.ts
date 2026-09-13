import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RP-13, spec point G: the prose that names where the conformance matrix is
 * rolled out. `docs/command-contract.md`'s own "Conformance matrix" section
 * names `[A4]` as absent and leaves delivery to "whoever supplies the
 * layer" — this pins that once RP-13 supplies it, the section says so by
 * name, following `command-contract.test.ts`'s own `section()` convention.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const contractPath = path.join(repoRoot, 'docs', 'command-contract.md');
const readmePath = path.join(repoRoot, 'README.md');

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

describe('the command contract names the rolled-out conformance matrix (RP-13)', () => {
  it('names .claude/contracts/conformance-v1/ as the layer the matrix rolls out through', async () => {
    const content = await readFile(contractPath, 'utf8');
    const matrix = section(content, /^#{2,6}\s+.*Conformance matrix\b/i);
    expect(matrix).toContain('.claude/contracts/conformance-v1/');
  });

  it("names scripts/memory-conformance.mjs as the matrix's executable form", async () => {
    const content = await readFile(contractPath, 'utf8');
    const matrix = section(content, /^#{2,6}\s+.*Conformance matrix\b/i);
    expect(matrix).toContain('scripts/memory-conformance.mjs');
  });
});

describe('the README documents the conformance layer (RP-13)', () => {
  it('names the payload directory, the pinned-ref manifest and the CI job', async () => {
    const readme = await readFile(readmePath, 'utf8');
    const conformance = section(readme, /^#{1,6}\s+.*Conformance layer\b/i);
    expect(conformance).toContain('.claude/contracts/conformance-v1/');
    expect(conformance).toContain('manifest.json');
    expect(conformance).toContain('memory-conformance');
  });
});
