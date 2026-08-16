import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'caf-manifest-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const sample = (): RigManifest => ({
  version: '0.4.0',
  kind: 'init',
  project: { name: 'host', scope: 'host', region: '' },
  stacks: [],
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
  });

  // The regression fence for the tightening above: every value the rig itself
  // writes has to keep parsing, or the fix breaks the installed base instead
  // of the attack. These pass today and must still pass afterwards.
  it('still accepts every value `create` and `init` actually write', () => {
    const legitimate = (patch: Partial<RigManifest>) =>
      parseManifest(JSON.stringify({ ...sample(), ...patch }));
    // `create` validates the name against /^[a-z0-9][a-z0-9._-]*$/ and reuses
    // it as the npm scope; `init` slugs a directory name down to [a-z0-9._-].
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
