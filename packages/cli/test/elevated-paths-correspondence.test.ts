import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agentOsUniversalDir } from '../src/templates.js';
import { isReadableRulebook, parseElevatedPaths } from '../src/lib/elevated-paths.js';

// Round 5, design ruling: `packages/cli/src/lib/elevated-paths.ts` is a
// SEPARATE implementation of the gate sweep's own `parseElevatedPaths`
// (`templates/agent-os/universal/.claude/scripts/detect-missed-gate.mjs`),
// not a shared import — that `.mjs` is the sweep's own copy, shipped into
// every generated rig, and this one is the generator's, used only to decide
// whether `upgrade` can trust an on-disk AGENTS.md as a rulebook. Two
// implementations of one semantics is exactly the shape
// `.claude/rules/invariants.md` warns drifts silently, so this file is the
// mechanical proof that they still agree — fed the same LITERAL fixtures,
// never fixtures generated from either implementation.
async function loadMjsParser(): Promise<{
  parseElevatedPaths: (markdown: string) => string[] | null;
}> {
  const universal = agentOsUniversalDir();
  return (await import(
    pathToFileURL(path.join(universal, '.claude', 'scripts', 'detect-missed-gate.mjs')).href
  )) as { parseElevatedPaths: (markdown: string) => string[] | null };
}

// Literal fixtures — not derived from either implementation's own logic.
const FIXTURES: Array<{ name: string; markdown: string }> = [
  { name: 'no block at all', markdown: '# AGENTS.md\n\nJust prose, no fence anywhere.\n' },
  {
    name: 'one real path',
    markdown: '# AGENTS.md\n\n```elevated-paths\n.claude/\n```\n',
  },
  {
    name: 'several real paths',
    markdown: '# AGENTS.md\n\n```elevated-paths\n.claude/\nscripts/\npackage.json\n```\n',
  },
  {
    name: 'empty block (hostile emptiness — "Everything is Tier 0")',
    markdown: '# AGENTS.md\n\n```elevated-paths\n# Everything is Tier 0\n```\n',
  },
  {
    name: 'block with only blank lines',
    markdown: '# AGENTS.md\n\n```elevated-paths\n\n\n```\n',
  },
  {
    name: 'a path with an inline comment',
    markdown: '# AGENTS.md\n\n```elevated-paths\n.claude/  # the enforcement layer\n```\n',
  },
  {
    name: 'CRLF line endings inside the block',
    markdown: '# AGENTS.md\r\n\r\n```elevated-paths\r\n.claude/\r\nscripts/\r\n```\r\n',
  },
  {
    name: 'paths needing normalisation (./ prefix, leading /, doubled slash)',
    markdown: '# AGENTS.md\n\n```elevated-paths\n./scripts/\n/docs/decisions/\ninfra//x.ts\n```\n',
  },
  {
    name: 'two separate blocks',
    markdown:
      '# AGENTS.md\n\n```elevated-paths\n.claude/\n```\n\nMore prose.\n\n```elevated-paths\nscripts/\n```\n',
  },
  {
    name: 'a comment line inside the block, alongside a real path',
    markdown: '# AGENTS.md\n\n```elevated-paths\n# a note\n.claude/\n```\n',
  },
  {
    name: 'a fence with the wrong label is not a block at all',
    markdown: '# AGENTS.md\n\n```not-elevated-paths\n.claude/\n```\n',
  },
];

describe("elevated-paths.ts agrees with the gate sweep's own parseElevatedPaths", () => {
  it.each(FIXTURES)('$name', async ({ markdown }) => {
    const { parseElevatedPaths: mjsParse } = await loadMjsParser();
    expect(parseElevatedPaths(markdown)).toEqual(mjsParse(markdown));
  });
});

describe("isReadableRulebook — round 5's content-based hold-back rule", () => {
  it('a real elevated-paths block is a readable rulebook', () => {
    expect(isReadableRulebook('```elevated-paths\n.claude/\n```\n')).toBe(true);
  });

  it('no block at all is not a readable rulebook', () => {
    expect(isReadableRulebook('# nothing here\n')).toBe(false);
  });

  it('an empty block ("Everything is Tier 0") is not a readable rulebook', () => {
    expect(isReadableRulebook('```elevated-paths\n# Everything is Tier 0\n```\n')).toBe(false);
  });

  it('a block with only blank lines is not a readable rulebook', () => {
    expect(isReadableRulebook('```elevated-paths\n\n\n```\n')).toBe(false);
  });
});

describe("the scan cap — this implementation's own stated limit, tested", () => {
  it('a block starting after the cap is invisible — the cap is applied before the regex ever runs', async () => {
    const { ELEVATED_PATHS_SCAN_CAP } = await import('../src/lib/elevated-paths.js');
    const padding = 'x'.repeat(ELEVATED_PATHS_SCAN_CAP + 10);
    const markdown = `${padding}\n\`\`\`elevated-paths\n.claude/\n\`\`\`\n`;
    expect(parseElevatedPaths(markdown)).toBeNull();
  });

  it('a block entirely within the cap is unaffected', async () => {
    const { ELEVATED_PATHS_SCAN_CAP } = await import('../src/lib/elevated-paths.js');
    const padding = '# padding\n'.repeat(1000);
    expect(padding.length).toBeLessThan(ELEVATED_PATHS_SCAN_CAP);
    const markdown = `${padding}\n\`\`\`elevated-paths\n.claude/\n\`\`\`\n`;
    expect(parseElevatedPaths(markdown)).toEqual(['.claude/']);
  });
});
