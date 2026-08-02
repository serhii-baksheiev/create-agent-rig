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
