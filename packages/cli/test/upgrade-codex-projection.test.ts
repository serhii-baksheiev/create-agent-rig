import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject } from '../src/commands/init.js';
import { applyUpgrade, planUpgrade } from '../src/commands/upgrade.js';
import type { UpgradePlan, UpgradeVerdict } from '../src/commands/upgrade.js';
import type { HashHistory } from '../src/lib/history.js';
import { readManifest, sha256 } from '../src/lib/manifest.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

/**
 * RP-179 acceptance #3. The Codex projection's output (`.codex/agents/*.toml`,
 * `.agents/skills/**`) is not a special case in `planUpgrade` — `layers.json`
 * lists each one as an ordinary template-sourced path
 * (`packages/cli/src/commands/init.ts`, `initManifest`), exactly like
 * `.claude/rules/workflow.md` (see `upgrade.test.ts`), so it goes through the
 * same verdict machinery. `AGENTS.md` stays on this list for the same generic
 * reason even though it is no longer a Codex *projection* of `CLAUDE.md`: since
 * RP-186 it is the canonical, authored rulebook and `CLAUDE.md` is the
 * derived-in-spirit shim, but `layers.json`/`initManifest` still track it as
 * one ordinary path, so the machinery this file is about is unchanged. This
 * file proves that on the actual generated paths, rather than resting on "the
 * code has no special case for them".
 * Deterministic generation from one source is
 * `test/template/codex.test.ts` › "is in sync with its Claude Code sources"
 * (`node scripts/sync-codex-adapter.mjs --check`, run in CI on every push);
 * this is the upgrade half — unchanged upgrades cleanly, an edit is reported
 * as a conflict rather than silently overwritten (acceptance #2), and a
 * deletion stays deleted.
 *
 * A separate file, not a describe block inside `upgrade.test.ts`: a test file
 * named `upgrade.test.ts` already exists under `test/e2e/`, and
 * `docs/compatibility.md`'s evidence pointers resolve a citation by basename
 * (`test/template/compatibility-matrix.test.ts`). An ambiguous basename is
 * refused rather than silently resolved — `candidatesFor` returns every match
 * and the caller reports "… is ambiguous (…) — cite the path", pinned by
 * `compatibility-matrix.test.ts` › "refuses a basename two tracked files
 * share, and resolves the same pointer given as a path" — but a refusal is
 * still worse than not hitting it, so this file's name stays unique in the
 * repository.
 */

let repo: string;

const abs = (rel: string): string => path.join(repo, ...rel.split('/'));
const read = (rel: string): Promise<string> => readFile(abs(rel), 'utf8');
const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(path.dirname(abs(rel)), { recursive: true });
  await writeFile(abs(rel), content);
};

const verdictFor = (plan: UpgradePlan, rel: string): UpgradeVerdict | undefined =>
  plan.actions.find((a) => a.rel === rel)?.verdict;

async function installRig(): Promise<void> {
  // `.agents/skills/loop/SKILL.md` is a workflow-layer path (RP-180) and is
  // not part of the default Lean Core install — request it explicitly so
  // this file keeps covering the Codex projection for all three paths.
  await initProject(repo, { withWorkflow: true });
}

const emptyHistory: HashHistory = { versions: [], files: {} };

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-upgrade-codex-projection-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

describe('planUpgrade — the Codex projection files use the general verdict machinery (RP-179)', () => {
  const CODEX_PROJECTION_PATHS = [
    'AGENTS.md',
    '.codex/agents/test-writer.toml',
    '.agents/skills/loop/SKILL.md',
  ];

  it.each(CODEX_PROJECTION_PATHS)('%s: unchanged upgrades cleanly', async (rel) => {
    await installRig();
    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(verdictFor(plan, rel)).toBe('unchanged');

    const before = await read(rel);
    await applyUpgrade(repo, plan);
    expect(await read(rel)).toBe(before);
    expect((await readManifest(repo))?.files[rel]).toBe(sha256(before));
  });

  it.each(CODEX_PROJECTION_PATHS)(
    '%s: an edit is reported as a conflict, never silently overwritten',
    async (rel) => {
      await installRig();
      const edited = `${await read(rel)} `;
      await write(rel, edited);

      const plan = await planUpgrade(repo, { history: emptyHistory });
      const action = plan.actions.find((a) => a.rel === rel);
      expect(action?.verdict).toBe('conflict');
      expect(action?.reason).toBeTruthy();

      await applyUpgrade(repo, plan);
      expect(await read(rel)).toBe(edited);
      expect((await readManifest(repo))?.files[rel]).toBeUndefined();
    },
  );

  it.each(CODEX_PROJECTION_PATHS)('%s: a deletion stays deleted', async (rel) => {
    await installRig();
    await rm(abs(rel));

    const plan = await planUpgrade(repo, { history: emptyHistory });
    expect(verdictFor(plan, rel)).toBe('deleted');

    await applyUpgrade(repo, plan);
    await expect(read(rel)).rejects.toThrow();
  });
});
