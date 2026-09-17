import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Publish brief §8: exactly one package is publishable — the root one.
describe('the inner package is locked against publication', () => {
  // 60 s: npm through a shell on windows-latest measured past the 15 s default (AR-93).
  it('npm publish --dry-run refuses inside packages/cli', { timeout: 60_000 }, async () => {
    // npm 10 does NOT honor "private": true on --dry-run (measured), so the
    // real lock is a failing prepublishOnly script; private stays as belt.
    // `npm` is a `.cmd` shim on Windows, which execFile cannot run without a
    // shell; the arguments are literal words, so the shell adds no parsing risk.
    await expect(
      exec('npm', ['publish', '--dry-run'], {
        cwd: path.join(repoRoot, 'packages', 'cli'),
        shell: process.platform === 'win32',
      }),
    ).rejects.toThrow(/BLOCKED/);
  });

  it('packages/cli is marked private', async () => {
    const pkg = JSON.parse(
      await readFile(path.join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8'),
    );
    expect(pkg.private).toBe(true);
  });
});

// Publish brief §4: the manifest is the npm landing page.
describe('the root manifest is publish-complete', () => {
  it('ships 0.9.1 as one release in both package manifests', async () => {
    const root = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    const inner = JSON.parse(
      await readFile(path.join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(root.version).toBe('0.9.1');
    expect(inner.version).toBe(root.version);
  });

  it('puts the 0.9.1 fixes-only release first in the changelog', async () => {
    const changelog = await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
    const first = changelog.match(/^## (\d+\.\d+\.\d+)\n([\s\S]*?)(?=^## \d+\.\d+\.\d+)/m);
    expect(first?.[1]).toBe('0.9.1');
    // The named subjects of THIS release, not words any release note would
    // contain — so an entry copied forward from 0.9.0 fails here. Each pin
    // pairs the fixed behavior with the ticket that owns it.
    expect(first?.[2]).toMatch(/kept/);
    expect(first?.[2]).toMatch(/RP-182/);
    expect(first?.[2]).toMatch(/--timeout-ms 45000/);
    expect(first?.[2]).toMatch(/RP-183/);
    expect(first?.[2]).toMatch(/authorAssociation/);
    expect(first?.[2]).toMatch(/RP-99/);
    expect(first?.[2]).toMatch(/link-contradicted-by-body/);
    expect(first?.[2]).toMatch(/RP-59/);
    expect(first?.[2]).toMatch(/255 characters/);
    expect(first?.[2]).toMatch(/RP-121/);
    expect(first?.[2]).toMatch(/bounded-retry/);
    expect(first?.[2]).toMatch(/RP-158/);
    // 🔴 the numbering call, inverted from 0.9.0: this release is fixes only,
    // so a PATCH, where 0.9.0 shipped additive content as a MINOR.
    expect(first?.[2]).toMatch(/patch/i);
    // 🔴 The 0.9.0 section must still be BELOW it, unedited in place: a
    // release that rewrites the previous release's note is describing bytes
    // that already shipped.
    expect(changelog).toMatch(/^## 0\.9\.0$/m);
    expect(changelog.indexOf('## 0.9.1')).toBeLessThan(changelog.indexOf('## 0.9.0'));
    expect(changelog.indexOf('## 0.9.0')).toBeLessThan(changelog.indexOf('## 0.8.0'));
    expect(changelog.slice(changelog.indexOf('## 0.9.0'))).toMatch(/setup --memory-root/);
    expect(changelog.slice(changelog.indexOf('## 0.9.0'))).toMatch(
      /Deprecated: the application skeletons/,
    );
  });

  it('records 0.9.0 as the published `latest`, and every overtaken version as neither', async () => {
    const plan = await readFile(path.join(repoRoot, 'PLAN.md'), 'utf8');
    // The `gitHead` 0.9.0 was published from, measured against the registry
    // with `npm view create-agent-rig@0.9.0 gitHead`, read 17 Sep 2026. It is
    // a literal here rather than read out of `templates/release-ledger.json`,
    // the way this test read 0.8.0's while 0.8.0 was current: the
    // just-shipped version deliberately has NO ledger row yet. `docs/releasing.md`
    // writes this release's row at the NEXT release (a commit cannot carry
    // its own sha), and `ledgerFindings` in `scripts/release-preflight.mjs`
    // reads a row for the version in `package.json` as proof it is already
    // published. Until that next release the pair lives in the journal entry
    // and here.
    const publishedSha = 'c27f391e7395accaf09354f255a07e1b9e4710c1';
    // 🔴 This assertion has been wrong in BOTH directions now, one release
    // apart, and it carries a guard for each.
    //
    // 0.6.2's mistake: §11 read "`0.6.2` is prepared and waiting on the owner"
    // while the positive guard asserted /0\.6\.2 prepared/ — one fact in two
    // places, only one of them guarded, and PLAN.md contradicted its own
    // status line for a whole release with the suite green.
    //
    // 0.7.0's mistake, the mirror: it was published while both places still
    // called it pending and still called 0.6.2 `latest`. A status line calling
    // a shipped release unshipped is worse than none — PLAN.md is the map a
    // reader opens first.
    //
    // So the shape from here is: the PUBLISHED version is named published and
    // is the one and only `latest`, and **the version that just shipped** is
    // not left described as pending. Both directions stay red.
    //
    // 🔴 The asymmetry below is deliberate, and this comment is copied forward
    // into the next release's test — which is how the 0.6.2 mistake travelled —
    // so it says exactly what the assertions do. `latest` is a SINGLETON fact:
    // two versions claiming it is a contradiction detectable only by naming
    // each overtaken version, so that negative accumulates — `0.8.0` joined
    // `0.7.1`, `0.7.0` and `0.6.2` on that list the day `0.9.0` shipped.
    // "Pending" is PER-VERSION, and the status line names one version's state
    // at a time, so only the just-shipped version needs guarding; accumulating
    // those would grow a list forever against a shape that cannot recur.
    //
    // 0.9.0 shipped on 14 Sep 2026 — the registry reads `dist-tags.latest`
    // `0.9.0`, published from `gitHead` `c27f391e` — so this assertion moved
    // with it, and the lines that guarded 0.9.0 while it was prepared are now
    // inverted: the sentences they forbade are the sentences the positives
    // below require. `latest` is a fact about the registry, and the guards
    // here are what stop this file drifting from it in either direction again.
    expect(plan).toMatch(/Status \(0\.9\.0 published/);
    expect(plan).toMatch(/0\.9\.0 is `latest`/);
    // The published identity is recorded, not just the version number — and it
    // is asserted BESIDE `gitHead`, so a stray occurrence of those characters
    // elsewhere in the file cannot satisfy it.
    expect(plan).toMatch(new RegExp(`gitHead\`? \`?${publishedSha.slice(0, 8)}`));
    // 0.9.0 is live, so it may not be described as pending anywhere — the
    // 0.6.2 mistake, now pointed at the current release. This is the same fact
    // the positive /`0\.9\.0` is prepared/ used to assert, inverted on the day
    // the release reached the registry rather than deleted.
    expect(plan).not.toMatch(
      /`?0\.9\.0`? (?:is )?prepared|0\.9\.0 publish pending|owner publishes `?0\.9\.0`?|`?0\.9\.0`? is waiting on the owner/,
    );
    // and no superseded version may still be called `latest` — the 0.7.0
    // mistake, kept red for every version that has been overtaken.
    expect(plan).not.toMatch(/`?0\.8\.0`? is `latest`/);
    expect(plan).not.toMatch(/`?0\.7\.1`? is `latest`/);
    expect(plan).not.toMatch(/`?0\.7\.0`? is `latest`/);
    expect(plan).not.toMatch(/`?0\.6\.2`? is `latest`/);
    // the two places that carry it must agree: whatever §11 calls the
    // current `latest` is what the status line calls live.
    expect(plan).toMatch(/done through `0\.9\.0`, the current `latest`/);

    // 🔴 0.9.1 is PREPARED, not published — re-entered here the way the
    // comment below asks, pointed at its own number. The positive says the
    // branch is waiting on the owner; the enumerated negative forbids every
    // voice this file has used to announce a release as shipped, because a
    // negative covering only one of them read green on the others once.
    expect(plan).toMatch(/`0\.9\.1` is prepared/);
    expect(plan).not.toMatch(
      /Status \(0\.9\.1 published|`?0\.9\.1`? is `latest`|through `0\.9\.1` are live|done through `0\.9\.1`, the current `latest`/,
    );

    // 🔴 What is deliberately NOT here any more, so the next reader does not
    // restore it: while 0.9.0 was prepared, an ENUMERATED negative forbade
    // announcing it as shipped in any of this file's voices — `Status (0.9.0
    // published`, ``0.9.0` is \`latest\``, ``0.1.0` through `0.9.0` are live`,
    // `done through \`0.9.0\`, the current \`latest\`` — because a negative
    // covering only `0.9.0 published` would have read green on every one of
    // the others. That enumeration is now the shape the file MUST have: three
    // of those four sentences are required positively above. It was not
    // dropped as a weakening, it was consumed by the release. The NEXT version
    // to be prepared re-enters it, pointed at its own number, together with
    // its `is prepared` positive and its `is \`latest\`` negative.
  });

  // 🔴 The ledger records where a version was published FROM, so a row may
  // exist only once that version is on the registry. 0.8.0's row is written
  // here because 0.8.0 is published; a row for an unpublished version would be
  // a guess wearing the shape of a measurement.
  it('records 0.9.0 in the ledger at the commit it was published from', async () => {
    const ledger = JSON.parse(
      await readFile(path.join(repoRoot, 'templates', 'release-ledger.json'), 'utf8'),
    ) as Record<string, string | null>;
    // `npm view create-agent-rig@0.9.0 gitHead`, read on 2026-09-17
    expect(ledger['0.9.0']).toBe('c27f391e7395accaf09354f255a07e1b9e4710c1');
    // the previous rows are not disturbed by adding a new one
    expect(ledger['0.8.0']).toBe('870f9a3ecae2881908ece8ec3e2ac13f84f505f5');
    expect(ledger['0.7.1']).toBe('52e879b6c103f6ba70493007b6a6466c57ea9824');
    expect(ledger['0.7.0']).toBe('6589db36e1daa63a99ec595191db1cccf7373196');
    // and the just-prepared version has NO row: a commit cannot carry its own sha
    expect(ledger['0.9.1']).toBeUndefined();
    // and every row is a full sha, never an abbreviation
    for (const [version, sha] of Object.entries(ledger)) {
      if (sha !== null) expect(sha, `${version} is not a full sha`).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('has the publishable identity and the npm-facing fields', async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('create-agent-rig');
    expect(pkg.private).toBeUndefined();
    expect(pkg.bin).toEqual({ 'create-agent-rig': 'packages/cli/dist/index.js' });
    expect(pkg.type).toBe('module');
    expect(pkg.engines?.node).toBeTruthy();
    expect(pkg.license).toBe('MIT');
    expect(pkg.description?.length).toBeGreaterThan(20);
    expect(pkg.keywords?.length).toBeGreaterThan(2);
    expect(pkg.files).toContain('templates');
  });

  it('ships a LICENSE file matching the declared license', async () => {
    const license = await readFile(path.join(repoRoot, 'LICENSE'), 'utf8');
    expect(license).toContain('MIT License');
  });

  // npm ships README, LICENSE and package.json without being asked; a CHANGELOG
  // is NOT among them. Someone upgrading from the registry would have no way to
  // see what changed — and this release rewrote the enforcement layer twice.
  it('ships the changelog, and the changelog documents this version', async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
      files: string[];
    };
    expect(pkg.files).toContain('CHANGELOG.md');
    const changelog = await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
    expect(changelog, `CHANGELOG.md must have an entry for ${pkg.version}`).toContain(
      `## ${pkg.version}`,
    );
    // and the release checklist, so the next release is not reassembled from memory
    expect(changelog).toMatch(/npm pack --dry-run/);
    expect(changelog).toMatch(/2FA|owner/i);
  });

  it('the bin entry keeps its shebang', async () => {
    const source = await readFile(
      path.join(repoRoot, 'packages', 'cli', 'src', 'index.ts'),
      'utf8',
    );
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });
});
