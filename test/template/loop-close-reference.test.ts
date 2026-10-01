import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loopSkill = (root: string) => path.join(root, '.claude', 'skills', 'loop', 'SKILL.md');

/**
 * The issue must remain open until the loop has made its BEFORE_CLOSE decision.
 * Keep this about the documented GitHub-Issues workflow, rather than a particular
 * command spelling, so a later CLI implementation can still satisfy the contract.
 */
const referenceGuidance = (source: string) => {
  const reference = source.indexOf('Refs #<id>');
  expect(
    reference,
    'the GitHub Issues PR-reference guidance must name `Refs #<id>`',
  ).toBeGreaterThan(-1);
  return source.slice(Math.max(0, reference - 700), reference + 700);
};

describe('GitHub Issues close lifecycle guidance', () => {
  it('keeps GitHub issues open through BEFORE_CLOSE by using Refs in the PR body and squash title', async () => {
    const authored = await readFile(
      loopSkill(path.join(repoRoot, 'templates', 'agent-os', 'universal')),
      'utf8',
    );
    const generated = await readFile(loopSkill(repoRoot), 'utf8');

    for (const [name, source] of [
      ['authored template', authored],
      ['generated projection', generated],
    ] as const) {
      const guidance = referenceGuidance(source);
      expect(guidance, name).toMatch(/(?:PR|pull request).{0,90}(?:body|description)/is);
      expect(guidance, name).toMatch(/squash.{0,90}(?:title|commit)/is);
      expect(guidance, name).toMatch(/BEFORE_CLOSE/);
      expect(guidance, name).toMatch(/(?:do not|never|avoid).{0,90}(?:Closes|Fixes)/is);
    }
  });
});
