// RP-314: `docs/decisions/composition-presets.md` is a root, NOT-synced
// decision record — like `docs/decisions/memory-rig-boundary.md` and
// `docs/decisions/cost-ceiling-over-growth-ratio.md` beside it, it is
// authored here and stays here (it rules on what a preset is allowed to be
// in THIS product, not on template payload `scripts/sync-agent-os.mjs`
// copies into every generated project), so it carries the same "not synced"
// banner rather than living under `templates/agent-os/universal/docs/
// decisions/`, which `test/template/decision-records.test.ts` already
// covers. There is no precedent test for an individual not-synced root
// record's own content, so this one is new rather than mirrored — the shape
// (loose, case-insensitive, one assertion per bullet) follows this file's own
// siblings rather than a prior test.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const recordPath = path.join(repoRoot, 'docs', 'decisions', 'composition-presets.md');
const contractPath = path.join(repoRoot, 'docs', 'command-contract.md');

async function loadRecord(): Promise<string> {
  return readFile(recordPath, 'utf8');
}

describe('docs/decisions/composition-presets.md — the preset decision record (RP-314)', () => {
  it('exists and opens with a level-1 heading that names it', async () => {
    const content = await loadRecord();
    const first = content.split('\n').find((line) => line.trim() !== '') ?? '';
    expect(first).toMatch(/^#\s+\S/);
    expect(content.toLowerCase()).toContain('preset');
  });

  it('carries the "not synced" banner, like memory-rig-boundary.md beside it', async () => {
    const content = await loadRecord();
    expect(content).toMatch(/this record is not synced/i);
  });

  it('states presets are configuration sugar over existing layers/integration intents, not a runtime or profile abstraction', async () => {
    const content = await loadRecord();
    expect(content).toMatch(/sugar/i);
    expect(content).toMatch(/not a runtime/i);
  });

  it('states the preset name is recorded for diagnostics only and never becomes execution state', async () => {
    const content = await loadRecord();
    expect(content).toMatch(/diagnostics only/i);
    expect(content).toMatch(/never becomes execution state/i);
  });

  it('states presets own none of provider lifecycle, scheduling, claims, the task graph, or merge decisions', async () => {
    const content = await loadRecord();
    for (const phrase of [
      'provider lifecycle',
      'scheduling',
      'claims',
      'task graph',
      'merge decisions',
    ]) {
      expect(content.toLowerCase(), `missing "${phrase}"`).toContain(phrase);
    }
  });

  it('states degradation for a missing optional integration', async () => {
    const content = await loadRecord();
    expect(content).toMatch(/degrad/i);
    expect(content.toLowerCase()).toContain('optional integration');
  });

  it('states compatibility — a repository with no preset metadata keeps its existing behaviour', async () => {
    const content = await loadRecord();
    expect(content).toMatch(/compatib/i);
    expect(content.toLowerCase()).toContain('preset metadata');
  });

  it('states a future preset composes existing primitives or justifies a new one separately', async () => {
    const content = await loadRecord();
    expect(content).toMatch(/composes existing primitives/i);
    expect(content).toMatch(/justif(y|ies) a new one/i);
  });

  it('is cited by docs/command-contract.md', async () => {
    const contract = await readFile(contractPath, 'utf8');
    expect(contract).toContain('docs/decisions/composition-presets.md');
  });
});
