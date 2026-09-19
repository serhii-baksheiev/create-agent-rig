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
 * RP-179 acceptance #3. The Codex projection's output (`AGENTS.md`,
 * `.codex/agents/*.toml`, `.agents/skills/**`) is not a special case in
 * `planUpgrade` — `layers.json` lists each one as an ordinary template-sourced
 * path (`packages/cli/src/commands/init.ts`, `initManifest`), exactly like
 * `.claude/rules/workflow.md` (see `upgrade.test.ts`), so it goes through the
 * same verdict machinery. This file proves that on the actual generated
 * paths, rather than resting on "the code has no special case for them".
 * Deterministic generation from one source is
 * `test/template/codex.test.ts` › "is in sync with its Claude Code sources"
 * (`node scripts/sync-codex-adapter.mjs --check`, run in CI on every push);
 * this is the upgrade half — unchanged upgrades cleanly, an edit is reported
 * as a conflict rather than silently overwritten (acceptance #2), and a
 * deletion stays deleted.
 *
 * A separate file, not a describe block inside `upgrade.test.ts`: a test file
 * named `upgrade.test.ts` already exists under `test/e2e/`, and
 * `test/template/compatibility-matrix.test.ts` resolves a bare-name evidence
 * pointer to the tracked file with that basename — REFUSING it outright when
 * two files share it, rather than guessing which one was meant. A citation
 * of `upgrade.test.ts` in `docs/compatibility.md` would therefore have to
 * name a path (`test/e2e/upgrade.test.ts` or
 * `packages/cli/test/upgrade.test.ts`) to resolve at all. This file's name
 * is unique in the repository, so it resolves as a bare name with no such
 * ambiguity to disambiguate.
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
  await initProject(repo, {});
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
