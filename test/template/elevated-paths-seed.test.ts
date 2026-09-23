// RP-217: RP-61 added `.rig/revalidation.json` to `RULEBOOK_PREFIXES`
// (`unattended-flag.mjs`) and `layers.json` installs it with the workflow
// layer — but until RP-217 the PAYLOAD's own `elevated-paths` seed block, in
// `templates/agent-os/universal/AGENTS.md`, had no matching entry. That
// block is what `detect-missed-gate.mjs` and `decision-router.mjs` read
// inside a GENERATED workflow rig (this repo's own `AGENTS.md` is a separate,
// composed copy with its own list — `dogfood.test.ts` covers that one), so a
// generated rig's sweep could not see a merge that rewrote the detection
// contract, even though the same rig's `guard-rulebook` already refused an
// unattended edit to it.
//
// These tests read the payload's declaration and the payload's sweep the same
// way a generated project's own scripts would — never the root, composed
// AGENTS.md this repository runs under.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');

type Detector = {
  parseElevatedPaths: (md: string) => string[] | null;
  elevatedPathsIn: (files: string[], elevatedPaths: string[]) => string[];
};

const loadDetector = async (): Promise<Detector> =>
  (await import(
    pathToFileURL(path.join(universalDir, '.claude', 'scripts', 'detect-missed-gate.mjs')).href
  )) as Detector;

/** The SEED block a generated project's copy of AGENTS.md ships with. */
const loadSeedDeclaredPaths = async (): Promise<string[]> => {
  const detector = await loadDetector();
  const agentsMd = await readFile(path.join(universalDir, 'AGENTS.md'), 'utf8');
  const declared = detector.parseElevatedPaths(agentsMd);
  expect(
    declared,
    'templates/agent-os/universal/AGENTS.md carries no elevated-paths block',
  ).not.toBeNull();
  return declared!;
};

describe("the payload's own elevated-paths seed — what a GENERATED workflow rig's sweep can see", () => {
  it('declares .rig/revalidation.json — the detection contract the workflow layer installs', async () => {
    const declared = await loadSeedDeclaredPaths();
    const detector = await loadDetector();
    // 🔴 RP-217: this was empty before the fix. `.rig/revalidation.json`
    // decides STOP/GO and the claim scope fingerprint (`preflight.mjs`,
    // `claim-records.mjs`), is protected from an unattended edit by
    // `unattended-flag.mjs`'s `RULEBOOK_PREFIXES`, and ships with the workflow
    // layer (`layers.json`) — a seed block that does not name it lets a merge
    // rewriting it sweep clean in every rig this tool generates.
    expect(detector.elevatedPathsIn(['.rig/revalidation.json'], declared)).not.toEqual([]);
  });

  it('does not declare .rig/claims/ elevated — a SELECT writes its own baseline there on every claim', async () => {
    const declared = await loadSeedDeclaredPaths();
    const detector = await loadDetector();
    // The directory must stay undeclared: `.rig/claims/<id>.json` is written
    // by every queue SELECT, and declaring the directory would flag
    // essentially every queue merge in a generated rig.
    expect(detector.elevatedPathsIn(['.rig/claims/RP-1.json'], declared)).toEqual([]);
  });
});

describe('every exact-file rulebook path the workflow layer installs is elevated under the payload seed', () => {
  it(
    "matches RULEBOOK_PREFIXES's exact-file entries (never a directory prefix) against " +
      "layers.json's workflow file list, and asserts each survivor is elevated in the seed block — " +
      'independent of both the prefix list and the file list, so this cannot pass by ' +
      'checking either production list against itself',
    async () => {
      const declared = await loadSeedDeclaredPaths();
      const detector = await loadDetector();

      const unattended = (await import(
        pathToFileURL(path.join(universalDir, '.claude', 'scripts', 'unattended-flag.mjs')).href
      )) as { RULEBOOK_PREFIXES: readonly string[] };

      const layers = JSON.parse(
        await readFile(path.join(universalDir, 'layers.json'), 'utf8'),
      ) as Record<string, string[]>;
      const workflowFiles = new Set(layers['workflow'] ?? []);

      // Exact files only — a directory prefix (`.claude/scripts/`, `.claude/rules/`,
      // …) is not "the workflow layer installs this path" in the sense this test
      // asks; it is a whole tree, and every entry under it is checked on its own
      // elsewhere. What is under-checked is the small set of NAMED FILES that are
      // both individually protected from an unattended edit and individually
      // listed as something the workflow layer ships.
      const targets = unattended.RULEBOOK_PREFIXES.filter(
        (prefix) => !prefix.endsWith('/') && workflowFiles.has(prefix),
      );

      // A sanity check on the fixture, not the behaviour under test: if this ever
      // empties out (both source lists changed together), the assertions below
      // would be vacuously green.
      expect(
        targets.length,
        'no exact-file RULEBOOK_PREFIXES entry is shipped by the workflow layer — check the fixture',
      ).toBeGreaterThan(0);

      for (const file of targets) {
        expect(
          detector.elevatedPathsIn([file], declared),
          `${file} is individually protected from an unattended rulebook edit and shipped ` +
            'by the workflow layer, but the seed elevated-paths block does not cover it',
        ).not.toEqual([]);
      }
    },
  );
});
