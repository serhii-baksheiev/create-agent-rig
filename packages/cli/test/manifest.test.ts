import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MANIFEST_REL,
  parseManifest,
  readManifest,
  serializeManifest,
  sha256,
  writeManifest,
} from '../src/lib/manifest.js';
import type { RigManifest } from '../src/lib/manifest.js';
import { removeFixture } from '../../../test/helpers/remove-fixture.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-manifest-'));
});

afterEach(async () => {
  await removeFixture(repo);
});

const sample = (): RigManifest => ({
  version: '0.4.0',
  kind: 'init',
  project: { name: 'host', scope: 'host', region: '' },
  stacks: [],
  // Every real manifest this rig has ever written installed both layers —
  // there was only one payload before RP-180 split it. A fixture that omits
  // this field on purpose is built explicitly, below, not by leaving it off
  // `sample()`.
  layers: ['process', 'workflow'],
  files: { 'b.md': sha256('b'), 'a.md': sha256('a') },
});

describe('the install manifest — the evidence upgrade reads', () => {
  it('hashes content, not paths: same bytes, same hash', () => {
    expect(sha256('hello')).toBe(sha256(Buffer.from('hello', 'utf8')));
    expect(sha256('hello')).not.toBe(sha256('hello '));
    expect(sha256('hello')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('round-trips, and serialises file keys in a stable order', () => {
    const serialised = serializeManifest(sample());
    expect(serialised.endsWith('\n')).toBe(true);
    expect(serialised.indexOf('"a.md"')).toBeLessThan(serialised.indexOf('"b.md"'));
    expect(parseManifest(serialised)).toEqual(sample());
  });

  it('treats an unreadable manifest as no manifest — never as an empty one', () => {
    // The distinction is load-bearing: "no evidence" bootstraps from the hash
    // history, while "evidence saying nothing was installed" would call every
    // file on disk a user's own and refuse to upgrade anything.
    expect(parseManifest('{ not json')).toBeNull();
    expect(parseManifest('{"version":"0.4.0"}')).toBeNull();
    expect(parseManifest('null')).toBeNull();
    expect(parseManifest(JSON.stringify({ ...sample(), files: 'nope' }))).toBeNull();
  });

  // The manifest is committed, so it arrives in a pull request like any other
  // file — and its values are substituted into paths. A name of "../.." would
  // make an upgrade write outside the repository it was pointed at.
  it('rejects a manifest whose values could escape the repository', () => {
    const hostile = (patch: Partial<RigManifest>) =>
      parseManifest(JSON.stringify({ ...sample(), ...patch }));
    expect(hostile({ project: { name: '../pwned', scope: 'host', region: '' } })).toBeNull();
    expect(hostile({ project: { name: 'host', scope: 'a/b', region: '' } })).toBeNull();
    expect(hostile({ project: { name: 'host', scope: 'host', region: '..' } })).toBeNull();
    expect(hostile({ stacks: ['../../../../etc'] })).toBeNull();
    // an empty region is how `init` records "no region" — that stays legal
    expect(hostile({ project: { name: 'host', scope: 'host', region: '' } })).not.toBeNull();
  });

  // Escaping the repository is only half of what a substituted value can do.
  // These values are pasted into *executable* files, not only into paths:
  // `templates/agent-os/universal/.claude/scripts/stop-flag.mjs` embeds
  // __PROJECT_NAME__ inside a single-quoted JS string literal, and
  // `.claude/hooks/guard-bash.mjs` imports that module on every Bash call. A
  // value that closes the quote runs inside the hook process — and moves the
  // kill switch's path off `~/.claude/<name>-loop-STOP`, disarming the brake
  // without failing anything. So the manifest's own values are held to the
  // shape the rig actually produces, and anything else voids the whole file.
  const injectionPayloads = [
    [
      'closes the string literal it is substituted inside',
      "x'); import('node:child_process').execSync('id'); ('",
    ],
    ['escapes a template literal', "x`+require('fs')+`"],
    ['carries a shell substitution', '$(id)'],
    ['carries a shell command separator', 'a; rm -rf ~'],
  ] as const;

  describe.each(injectionPayloads)('a manifest value that %s', (_shape, payload) => {
    const hostile = (patch: Partial<RigManifest>) =>
      parseManifest(JSON.stringify({ ...sample(), ...patch }));

    it('voids the manifest when it is the project name', () => {
      expect(hostile({ project: { name: payload, scope: 'host', region: '' } })).toBeNull();
    });

    it('voids the manifest when it is the project scope', () => {
      expect(hostile({ project: { name: 'host', scope: payload, region: '' } })).toBeNull();
    });

    it('voids the manifest when it is the region', () => {
      expect(hostile({ project: { name: 'host', scope: 'host', region: payload } })).toBeNull();
    });

    it('voids the manifest when it is a stack overlay name', () => {
      expect(hostile({ stacks: ['node-ts', payload] })).toBeNull();
    });

    it('voids the manifest when it is the version', () => {
      expect(hostile({ version: payload })).toBeNull();
    });
  });

  // AR-128: `version` was the one field checked by type alone. `index.ts`
  // prints it raw as `installed by ${plan.fromVersion}` in the upgrade plan
  // header — the screen a maintainer reads immediately before typing `--yes` —
  // so a version carrying a newline or an ANSI escape could forge plan lines
  // the CLI never composed. Same delivery as the other values: the manifest is
  // committed and travels in pull requests.
  describe.each([
    ['a newline that forges a plan line', '0.5.0\n      delete: .claude/hooks/guard-bash.mjs'],
    ['a carriage return that overwrites the line', '0.5.0\r      nothing to do'],
    ['an ANSI escape that recolours the report', '0.5.0\u001b[2K\u001b[32mall clean'],
    ['a NUL byte', '0.5.0\u0000'],
    ['an empty string', ''],
  ] as const)('a manifest version carrying %s', (_shape, payload) => {
    it('voids the manifest as a whole', () => {
      expect(parseManifest(JSON.stringify({ ...sample(), version: payload }))).toBeNull();
    });
  });

  it('still accepts every version string the rig itself writes', () => {
    for (const version of ['0.5.0', '0.5.1', '1.0.0', '0.6.0-rc.1', '0.0.0-dev']) {
      expect(parseManifest(JSON.stringify({ ...sample(), version }))).not.toBeNull();
    }
  });

  // The regression fence for the tightening above: every value the rig itself
  // writes has to keep parsing, or the fix breaks the installed base instead
  // of the attack. These pass today and must still pass afterwards.
  it('still accepts every value `create` and `init` actually write', () => {
    const legitimate = (patch: Partial<RigManifest>) =>
      parseManifest(JSON.stringify({ ...sample(), ...patch }));
    // `create` validates the name against /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/
    // and reuses it as `scope` (RP-177: no npm scope to validate any more, but
    // `scope` remains a manifest field an OLD, pre-0.10 manifest may carry a
    // different value for); `init` slugs a directory name down to [a-z0-9._-].
    for (const name of ['my-app', 'app2', 'a.b_c-d', 'create-agent-rig']) {
      expect(legitimate({ project: { name, scope: name, region: '' } })).not.toBeNull();
    }
    expect(
      legitimate({ project: { name: 'my-app', scope: 'my-app', region: 'eu-central-1' } }),
    ).not.toBeNull();
    // an empty region is how `init` records "no region" — every init-installed
    // rig on disk carries one, so this staying legal is the whole install base
    expect(legitimate({ project: { name: 'my-app', scope: 'my-app', region: '' } })).not.toBeNull();
    expect(legitimate({ kind: 'create', stacks: ['node-ts', 'aws-cdk'] })).not.toBeNull();
    // `projectNameFor` strips a leading `-` or `.` and NOT a leading `_`, so a
    // repository directory named `_work` really does produce this name. It is
    // the one character the injection rule has to allow past the first
    // position — an underscore closes no quote and separates no shell command,
    // and voiding these manifests would be this fix breaking real rigs.
    expect(legitimate({ project: { name: '_work', scope: '_work', region: '' } })).not.toBeNull();
  });

  // `uninstall`'s plan prints `action.rel` raw to a screen a maintainer reads
  // immediately before confirming a deletion — a control character or a
  // Unicode format control (RTL override, zero-width joiner steering how the
  // rest of the line renders) in a manifest KEY could forge that line the same
  // way an unchecked `version` could forge a plan header (AR-128). `files` and
  // `kept` share one path-key validator (`isSafeManifestPath`), so this pins
  // it for both without duplicating the check.
  describe.each([
    ['a literal ESC', '.claude/[2Kevil.md'],
    ['a carriage return', '.claude/rules\r/workflow.md'],
    ['a line feed', 'CLAUDE.md\ndelete: .claude/hooks/guard-bash.mjs'],
    ['a NUL byte', '.claude/ hidden.md'],
    ['a Unicode RTL override (format control)', '.claude/‮evil.md'],
  ] as const)('a manifest key carrying %s', (_shape, key) => {
    it('voids the manifest when it is a `files` key', () => {
      expect(
        parseManifest(JSON.stringify({ ...sample(), files: { [key]: sha256('x') } })),
      ).toBeNull();
    });

    it('voids the manifest when it is a `kept` key', () => {
      expect(
        parseManifest(JSON.stringify({ ...sample(), kept: { [key]: sha256('x') } })),
      ).toBeNull();
    });

    // RP-256 slice 2: `regions` is keyed the same way as `files`/`kept` — a
    // rendered-rulebook body spliced into a user-owned AGENTS.md — so it
    // shares the same path-key validator. Currently RED: `parseManifest`
    // does not read a `regions` field at all yet, so it never gets far
    // enough to void the manifest over an unsafe key in it — the object it
    // returns today is simply valid, with `regions` silently dropped.
    it('voids the manifest when it is a `regions` key', () => {
      expect(
        parseManifest(JSON.stringify({ ...sample(), regions: { [key]: sha256('x') } })),
      ).toBeNull();
    });
  });

  it('writes to .claude/.rig-manifest.json and reads back what it wrote', async () => {
    await writeManifest(repo, sample());
    expect(await readManifest(repo)).toEqual(sample());
    // the path is part of the contract: a rig is recognised by this file
    expect(MANIFEST_REL).toBe('.claude/.rig-manifest.json');
    await readFile(path.join(repo, ...MANIFEST_REL.split('/')), 'utf8');
  });

  it('reads a missing or corrupt manifest as null', async () => {
    expect(await readManifest(repo)).toBeNull();
    await mkdir(path.join(repo, '.claude'), { recursive: true });
    await writeFile(path.join(repo, ...MANIFEST_REL.split('/')), 'garbage');
    expect(await readManifest(repo)).toBeNull();
  });
});

describe('kept — provenance for a file init found on disk and left alone (RP-182)', () => {
  it('accepts a manifest with no `kept` field at all, exactly as before', () => {
    // The compatibility fence: every manifest on disk today has no `kept`
    // key, and reading one must not change once this ships.
    expect(parseManifest(JSON.stringify(sample()))).toEqual(sample());
  });

  it('parses `kept` when present, keyed the same way as `files`', () => {
    const withKept = { ...sample(), kept: { 'c.md': sha256('c') } };
    const parsed = parseManifest(JSON.stringify(withKept));
    expect(parsed?.kept).toEqual({ 'c.md': sha256('c') });
  });

  it('voids a manifest whose `kept` is present but not a string record', () => {
    const hostile = (kept: unknown) => parseManifest(JSON.stringify({ ...sample(), kept }));
    expect(hostile('nope')).toBeNull();
    expect(hostile(['c.md'])).toBeNull();
    expect(hostile({ 'c.md': 1 })).toBeNull();
    expect(hostile({ 'c.md': null })).toBeNull();
  });

  it('serialises `kept` with sorted paths, and round-trips through parseManifest', () => {
    const withKept: RigManifest = {
      ...sample(),
      kept: { 'z.md': sha256('z'), 'a.md': sha256('a') },
    };
    const serialised = serializeManifest(withKept);
    const keptBlock = /"kept":\s*\{([\s\S]*?)\}/.exec(serialised)?.[1] ?? '';
    expect(keptBlock, serialised).toContain('"a.md"');
    expect(keptBlock.indexOf('"a.md"')).toBeLessThan(keptBlock.indexOf('"z.md"'));
    expect(parseManifest(serialised)).toEqual(withKept);
  });

  it('omits the `kept` key entirely when nothing was kept — a clean install serialises byte-identical to today', () => {
    const noKeptField = serializeManifest(sample());
    expect(noKeptField).not.toContain('"kept"');

    // Explicitly empty (`{}`), not merely absent — the serialiser omits it too.
    const emptyKept: RigManifest = { ...sample(), kept: {} };
    const serialisedEmpty = serializeManifest(emptyKept);
    expect(serialisedEmpty).not.toContain('"kept"');
    expect(serialisedEmpty).toBe(noKeptField);
  });
});

// RP-256 slice 2: `regions` is the manifest's evidence for a rendered
// rulebook body spliced into a user-owned AGENTS.md through one bounded
// managed region — additive, like `kept`, and keyed the same way. A clean
// install writes no `regions` key at all; only a region-mode AGENTS.md gets
// one entry, `'AGENTS.md'` → sha256 of the region body alone (never
// including the marker lines themselves).
describe('regions — provenance for a rendered rulebook body spliced into a user-owned AGENTS.md (RP-256 slice 2)', () => {
  it('accepts a manifest with no `regions` field at all, exactly like every manifest on disk today', () => {
    expect(parseManifest(JSON.stringify(sample()))).toEqual(sample());
  });

  it('parses `regions` when present, keyed the same way as `files`/`kept`', () => {
    const withRegions = { ...sample(), regions: { 'AGENTS.md': sha256('the region body') } };
    const parsed = parseManifest(JSON.stringify(withRegions));
    expect((parsed as unknown as { regions?: Record<string, string> } | null)?.regions).toEqual({
      'AGENTS.md': sha256('the region body'),
    });
  });

  it('voids a manifest whose `regions` is present but not a string record', () => {
    const hostile = (regions: unknown) => parseManifest(JSON.stringify({ ...sample(), regions }));
    expect(hostile('nope')).toBeNull();
    expect(hostile(['AGENTS.md'])).toBeNull();
    expect(hostile({ 'AGENTS.md': 1 })).toBeNull();
    expect(hostile({ 'AGENTS.md': null })).toBeNull();
  });

  it('serialises `regions` with sorted paths, and round-trips through parseManifest', () => {
    const withRegions = {
      ...sample(),
      regions: { 'z.md': sha256('z'), 'AGENTS.md': sha256('a') },
    };
    const serialised = serializeManifest(withRegions as unknown as RigManifest);
    const regionsBlock = /"regions":\s*\{([\s\S]*?)\}/.exec(serialised)?.[1] ?? '';
    expect(regionsBlock, serialised).toContain('"AGENTS.md"');
    expect(regionsBlock.indexOf('"AGENTS.md"')).toBeLessThan(regionsBlock.indexOf('"z.md"'));
    expect(parseManifest(serialised)).toEqual(withRegions);
  });

  it('omits the `regions` key entirely when nothing is region-tracked — a clean install serialises byte-identical to today', () => {
    const noRegionsField = serializeManifest(sample());
    expect(noRegionsField).not.toContain('"regions"');

    // Explicitly empty (`{}`), not merely absent — the serialiser omits it too.
    const emptyRegions = { ...sample(), regions: {} };
    const serialisedEmpty = serializeManifest(emptyRegions as unknown as RigManifest);
    expect(serialisedEmpty).not.toContain('"regions"');
    expect(serialisedEmpty).toBe(noRegionsField);
  });
});

describe('layers — which install-time layer(s) this manifest recorded (RP-180)', () => {
  // The highest-risk detail in RP-180: every manifest written before this
  // field existed came from a rig that shipped ONE payload — the workflow
  // layer was not yet optional, so it was always installed. Reading an
  // absent field as "process only" would make the very next `upgrade` on a
  // dogfood repo report every workflow file as `retired` and stop managing
  // it. Absent must mean "both layers", never "core only".
  it('a manifest with no `layers` key parses as though it recorded every layer', () => {
    const withoutLayers: Record<string, unknown> = { ...sample() };
    delete withoutLayers.layers;
    const parsed = parseManifest(JSON.stringify(withoutLayers));
    expect(parsed?.layers).toEqual(['process', 'workflow']);
  });

  // The other direction, and the one a FRESH `init` (no --layer workflow) now
  // produces: an explicit, narrower `layers` value round-trips exactly —
  // it is never silently widened back to "everything".
  it('a freshly written manifest naming only the core layer round-trips exactly', () => {
    const coreOnly: RigManifest = { ...sample(), layers: ['process'] };
    const serialised = serializeManifest(coreOnly);
    expect(parseManifest(serialised)).toEqual(coreOnly);
    expect(parseManifest(serialised)?.layers).toEqual(['process']);
  });

  it('voids the manifest when `layers` is present but not an array of known layer names', () => {
    const hostile = (layers: unknown) => parseManifest(JSON.stringify({ ...sample(), layers }));
    expect(hostile('process')).toBeNull();
    expect(hostile(['process', 'nonsense'])).toBeNull();
    expect(hostile([1, 2])).toBeNull();
    expect(hostile({})).toBeNull();
  });

  // RP-180 round 3, security blocker S2: `layers` was accepted as an
  // ARBITRARY-length array of `'process' | 'workflow'` values, never
  // deduplicated. The closed set has exactly two members, so nothing about a
  // valid manifest ever needs more than two entries — but nothing stopped a
  // committed manifest from repeating one thousands of times, and every
  // caller of `RigManifest.layers` (this file's own `[...m.layers]`,
  // `upgrade.ts`'s `initInstallSet`, `doctor.mjs`'s `layersOf`) then does
  // O(n) or worse work per entry. Deduped at parse, once, so no downstream
  // reader has to defend itself.
  it('dedupes `layers` at parse — a manifest with 2000 duplicate entries parses to the 2-member list', () => {
    const massive = Array.from({ length: 2000 }, (_, i) => (i % 2 === 0 ? 'process' : 'workflow'));
    const start = Date.now();
    const parsed = parseManifest(JSON.stringify({ ...sample(), layers: massive }));
    const elapsed = Date.now() - start;
    expect(parsed?.layers.sort()).toEqual(['process', 'workflow']);
    expect(parsed?.layers.length).toBe(2);
    // Bounded work, not just a fast wall-clock: parsing 2000 duplicate
    // entries into a 2-member set must not scale with the input size in any
    // way a reader would notice.
    expect(elapsed).toBeLessThan(200);
  });
});
