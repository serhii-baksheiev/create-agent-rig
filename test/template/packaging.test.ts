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
  it('ships 0.7.1 as one release in both package manifests', async () => {
    const root = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    const inner = JSON.parse(
      await readFile(path.join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(root.version).toBe('0.7.1');
    expect(inner.version).toBe(root.version);
  });

  it('puts the 0.7.1 owner-directed-gate release first in the changelog', async () => {
    const changelog = await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
    const first = changelog.match(/^## (\d+\.\d+\.\d+)\n([\s\S]*?)(?=^## \d+\.\d+\.\d+)/m);
    expect(first?.[1]).toBe('0.7.1');
    // The named subjects of THIS release, not words any release note would
    // contain — so an entry copied forward from 0.7.0 fails here.
    expect(first?.[2]).toMatch(/owner-directed/);
    expect(first?.[2]).toMatch(/BEFORE_PR/);
    expect(first?.[2]).toMatch(/--ticket/);
    // The four refusals are the reason this is not a bypass, so the note that
    // omits them is a note that undersells what a reader has to know.
    expect(first?.[2]).toMatch(/take-up/);
    expect(first?.[2]).toMatch(/\.rig\/claims/);
    expect(first?.[2]).toMatch(/BEFORE_CLOSE/);
    // and why it is a patch rather than a minor, since that is the call a
    // consumer on "I only take minors" depends on being made deliberately.
    expect(first?.[2]).toMatch(/patch/i);
    // 🔴 The 0.7.0 section must still be BELOW it, unedited in place: a patch
    // that rewrites the previous release's note is describing bytes that
    // already shipped.
    expect(changelog).toMatch(/^## 0\.7\.0$/m);
    expect(changelog.indexOf('## 0.7.1')).toBeLessThan(changelog.indexOf('## 0.7.0'));
  });

  it('records 0.7.1 as published and names it `latest` in both places', async () => {
    const plan = await readFile(path.join(repoRoot, 'PLAN.md'), 'utf8');
    // The published sha has ONE source here — the ledger row, which the test
    // below pins to a full literal. Spelling it a third time as a bare
    // substring would both duplicate the fact and match anywhere in the file,
    // including inside an unrelated hash.
    const publishedSha = (
      JSON.parse(
        await readFile(path.join(repoRoot, 'templates', 'release-ledger.json'), 'utf8'),
      ) as Record<string, string | null>
    )['0.7.1'] as string;
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
    // each overtaken version, so that negative accumulates. "Pending" is
    // PER-VERSION, and the status line names one version's state at a time, so
    // only the just-shipped version needs guarding; accumulating those would
    // grow a list forever against a shape that cannot recur.
    //
    // 0.7.1 shipped, so this assertion moved with it. `latest` is a fact about
    // the registry, and the guards below are what stop this file drifting from
    // it in either direction again.
    expect(plan).toMatch(/Status \(0\.7\.1 published/);
    expect(plan).toMatch(/0\.7\.1 is `latest`/);
    // The published identity is recorded, not just the version number — and it
    // is asserted BESIDE `gitHead`, so a stray occurrence of those characters
    // elsewhere in the file cannot satisfy it.
    expect(plan).toMatch(new RegExp(`gitHead\`? \`?${publishedSha.slice(0, 8)}`));
    // 0.7.1 is live, so it may not be described as pending anywhere — the
    // 0.6.2 mistake, now pointed at the current release.
    expect(plan).not.toMatch(
      /`?0\.7\.1`? (?:is )?prepared|0\.7\.1 publish pending|owner publishes `?0\.7\.1`?|`?0\.7\.1`? is waiting on the owner/,
    );
    // and no superseded version may still be called `latest` — the 0.7.0
    // mistake, kept red for every version that has been overtaken.
    expect(plan).not.toMatch(/`?0\.7\.0`? is `latest`/);
    expect(plan).not.toMatch(/`?0\.6\.2`? is `latest`/);
    // the two places that carry it must agree: whatever §11 calls the
    // current `latest` is what the status line calls live.
    expect(plan).toMatch(/done through `0\.7\.1`, the current `latest`/);
  });

  // 🔴 The ledger records where a version was published FROM, so a row may
  // exist only once that version is on the registry. 0.7.1's row is written
  // here because 0.7.1 is published; a row for an unpublished version would be
  // a guess wearing the shape of a measurement.
  it('records 0.7.1 in the ledger at the commit it was published from', async () => {
    const ledger = JSON.parse(
      await readFile(path.join(repoRoot, 'templates', 'release-ledger.json'), 'utf8'),
    ) as Record<string, string | null>;
    expect(ledger['0.7.1']).toBe('52e879b6c103f6ba70493007b6a6466c57ea9824');
    // the previous release's row is not disturbed by adding a new one
    expect(ledger['0.7.0']).toBe('6589db36e1daa63a99ec595191db1cccf7373196');
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
