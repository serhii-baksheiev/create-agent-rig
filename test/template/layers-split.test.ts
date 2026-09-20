// RP-180: `templates/agent-os/universal/layers.json` splits the single
// install array into `process` (Lean Core, always installed) and `workflow`
// (the experimental, opt-in autonomous multi-session layer — `init
// --layer workflow`). Two things can drift silently once a split like this
// exists, and this file is the mechanical check for both, per
// `invariants.md`'s "one mechanism, one implementation":
//
//  1. the WORKFLOW set itself — an entry could be added or removed from
//     `layers.json` without anyone deciding whether it belongs there;
//  2. a CORE `.mjs` file could come to `import` a WORKFLOW file — which
//     would break every core-only install the moment that import runs,
//     exactly the failure `docs/decisions/workflow-layer-split.md` explains
//     `verdict.mjs`/`lib/gate-coverage.mjs`/`run-journal.mjs` had to be
//     pulled out of the workflow set to avoid.
//
// Limit, stated because it is the same one `queue.test.ts`'s import sweep
// states for the same reason: only `from '…'` and `import('…')` naming a
// relative `.mjs` path are read. A dynamically assembled specifier is
// invisible to it, and always has been to every sibling check of this shape.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');

async function layers(): Promise<Record<string, string[]>> {
  return JSON.parse(await readFile(path.join(universalDir, 'layers.json'), 'utf8')) as Record<
    string,
    string[]
  >;
}

// The named set RP-180 decided on — pinned so an entry cannot join or leave
// `workflow` without this test being updated on purpose. Grouped exactly as
// `docs/decisions/workflow-layer-split.md` explains them.
const EXPECTED_WORKFLOW = new Set([
  // the loop and pr-ship skills, and their Codex mirror
  '.claude/skills/pr-ship/SKILL.md',
  '.claude/skills/loop/SKILL.md',
  '.agents/skills/pr-ship/SKILL.md',
  '.agents/skills/loop/SKILL.md',
  // PR-lifecycle helpers (verdict.mjs/lib/gate-coverage.mjs/run-journal.mjs
  // are the one exception — they stay core; see the decision record)
  '.claude/scripts/detect-missed-gate.mjs',
  '.claude/scripts/decision-router.mjs',
  '.claude/scripts/reconcile-external-prs.mjs',
  // the unattended run's own preflight, and the deploy verdict it reads
  '.claude/scripts/preflight.mjs',
  '.claude/scripts/run-state.mjs',
  // revalidation and claim-records (RP-53/RP-26 freeze: relocated, not changed)
  '.claude/scripts/revalidate.mjs',
  '.claude/scripts/revalidation-report.mjs',
  '.claude/scripts/lib/claim-records.mjs',
  '.claude/scripts/lib/revalidation-evidence.mjs',
  '.claude/scripts/lib/revalidation-points.mjs',
  '.rig/revalidation.json',
  // the queue seam
  '.claude/scripts/queue/core.mjs',
  '.claude/scripts/queue/plan-md.mjs',
  '.claude/scripts/queue/github-issues.mjs',
  '.claude/scripts/queue/jira.mjs',
  '.claude/scripts/queue/index.mjs',
  '.claude/scripts/queue/as-of.mjs',
  '.claude/scripts/queue/checkout.mjs',
  '.claude/scripts/queue/state.mjs',
  '.claude/scripts/queue/gate-rounds.mjs',
  '.claude/queue.json',
  // journal and the decision records that document workflow-only mechanisms
  'journal/README.md',
  'docs/decisions/gate-coverage.md',
  'docs/decisions/closing-a-task.md',
  'docs/decisions/content-blind-revalidation.md',
  'docs/decisions/run-directory.md',
  'docs/decisions/spacing-rations-mechanisms.md',
  'docs/decisions/stop-conditions-in-a-file.md',
  'docs/decisions/two-empty-endings.md',
]);

describe('layers.json — the core/workflow split (RP-180)', () => {
  it('has exactly `process` and `workflow` as its top-level keys', async () => {
    expect(Object.keys(await layers()).sort()).toEqual(['process', 'workflow']);
  });

  it('partitions every entry exactly once — no overlap, and nothing outside the two arrays', async () => {
    const manifest = await layers();
    const process_ = manifest.process ?? [];
    const workflow = manifest.workflow ?? [];
    const overlap = process_.filter((rel) => workflow.includes(rel));
    expect(overlap, 'listed in both layers').toEqual([]);
    expect(new Set(process_).size).toBe(process_.length);
    expect(new Set(workflow).size).toBe(workflow.length);
  });

  // Fact 1: the workflow set is exactly the one this ticket decided on — an
  // addition or removal here is a classification call, not a drive-by edit.
  it('the workflow layer is exactly the named set RP-180 decided on', async () => {
    const manifest = await layers();
    expect(new Set(manifest.workflow ?? [])).toEqual(EXPECTED_WORKFLOW);
  });

  // Fact 2: no core `.mjs` file imports a workflow file — a core-only install
  // (the default) must never ship a script whose module graph reaches for a
  // file that install never wrote.
  it('no core .mjs file imports a workflow-layer file', async () => {
    const manifest = await layers();
    const workflow = new Set(manifest.workflow ?? []);
    const coreScripts = (manifest.process ?? []).filter((rel) => rel.endsWith('.mjs'));

    const IMPORT = /(?:from|import)\s*\(?\s*['"](\.{1,2}\/[A-Za-z0-9._\-/]+\.mjs)['"]/g;
    const offenders: string[] = [];
    for (const rel of coreScripts) {
      const abs = path.join(universalDir, ...rel.split('/'));
      const dir = path.posix.dirname(rel.replaceAll('\\', '/'));
      const content = await readFile(abs, 'utf8');
      for (const match of content.matchAll(IMPORT)) {
        const target = path.posix
          .normalize(path.posix.join(dir, match[1] ?? ''))
          .replaceAll('\\', '/');
        if (workflow.has(target)) offenders.push(`${rel} -> ${target}`);
      }
    }
    expect(offenders, 'a core script importing a workflow-layer file').toEqual([]);
  });
});
