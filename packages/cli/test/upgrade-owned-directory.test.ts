// RP-189 — an owned path can be replaced by a non-empty directory.  Upgrade
// must classify that user-owned filesystem shape without following, deleting,
// or trying to overwrite it.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject } from '../src/commands/init.js';
import { applyUpgrade, planUpgrade } from '../src/commands/upgrade.js';
import type { UpgradePlan } from '../src/commands/upgrade.js';
import type { HashHistory } from '../src/lib/history.js';
import { MANIFEST_REL } from '../src/lib/manifest.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

type Fixture = {
  name: string;
  rel: string;
  withWorkflow: boolean;
};

const FIXTURES: readonly Fixture[] = [
  { name: 'a managed Core file', rel: '.claude/rules/workflow.md', withWorkflow: false },
  { name: 'a managed workflow-layer file', rel: '.claude/queue.json', withWorkflow: true },
];

const MANIFEST_VARIANTS = [
  { name: 'the manifest is intact', deleteManifest: false },
  { name: 'the manifest was deleted', deleteManifest: true },
] as const;

const emptyHistory: HashHistory = { versions: [], files: {} };

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-upgrade-owned-directory-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

const abs = (rel: string): string => path.join(repo, ...rel.split('/'));

const verdictFor = (plan: UpgradePlan, rel: string) =>
  plan.actions.find((action) => action.rel === rel)?.verdict;

async function replaceOwnedFileWithDirectory(
  rel: string,
): Promise<{ sentinel: string; contents: string }> {
  const target = abs(rel);
  const contents = 'user directory sentinel — must survive upgrade\n';
  await rm(target);
  await mkdir(target);
  const sentinel = path.join(target, 'sentinel.txt');
  await writeFile(sentinel, contents);
  return { sentinel, contents };
}

describe('upgrade — manifest-owned file replaced with a directory (RP-189)', () => {
  for (const fixture of FIXTURES) {
    for (const variant of MANIFEST_VARIANTS) {
      it(`${fixture.name}, ${variant.name}, is a conflict and leaves its directory sentinel intact`, async () => {
        await initProject(repo, { withWorkflow: fixture.withWorkflow });
        if (variant.deleteManifest) await rm(abs(MANIFEST_REL));
        const { sentinel, contents } = await replaceOwnedFileWithDirectory(fixture.rel);

        const plan = await planUpgrade(repo, { history: emptyHistory });

        expect(verdictFor(plan, fixture.rel)).toBe('conflict');
        const result = await applyUpgrade(repo, plan);
        expect(result.written).not.toContain(fixture.rel);
        expect(await readFile(sentinel, 'utf8')).toBe(contents);
      });
    }
  }
});
