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
  it('ships 0.10.1 as one release in both package manifests', async () => {
    const root = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    const inner = JSON.parse(
      await readFile(path.join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(root.version).toBe('0.10.1');
    expect(inner.version).toBe(root.version);
  });

  it('puts the 0.10.1 fixes-only release first in the changelog and preserves 0.10.0 and 0.9.1 history', async () => {
    const changelog = await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
    const first = changelog.match(/^## (\d+\.\d+\.\d+)\n([\s\S]*?)(?=^## \d+\.\d+\.\d+)/m);
    expect(first?.[1]).toBe('0.10.1');
    // The named subjects of THIS release, not words any release note would
    // contain — so an entry copied forward from 0.10.0 fails here. Each pin
    // pairs the fixed behavior with the ticket that owns it.
    expect(first?.[2]).toMatch(/EISDIR/);
    expect(first?.[2]).toMatch(/RP-189/);
    expect(first?.[2]).toMatch(/AGENTS\.md\.rig-new/);
    expect(first?.[2]).toMatch(/RP-202/);
    expect(first?.[2]).toMatch(/monotonic clock/);
    expect(first?.[2]).toMatch(/RP-204/);
    expect(first?.[2]).toMatch(/RP-194/);
    // 🔴 the numbering call: fixes only, so a PATCH on the 0.10 line.
    expect(first?.[2]).toMatch(/fixes-only patch/i);
    const previous = changelog.match(/^## 0\.10\.0\n([\s\S]*?)(?=^## \d+\.\d+\.\d+)/m);
    expect(previous?.[1]).toMatch(/doctor \[--json\].*aggregates Rig file integrity/s);
    expect(previous?.[1]).toMatch(/provider\/harness wizard/);
    expect(previous?.[1]).toMatch(/Spec Kit setup to\s+the pinned official CLI/);
    expect(previous?.[1]).toMatch(
      /Ownership\s+hashes live alongside provider selection in `\.rig\/integrations\.json`/,
    );
    const historical = changelog.match(/^## 0\.9\.1\n([\s\S]*?)(?=^## \d+\.\d+\.\d+)/m);
    for (const subject of [
      /kept/,
      /RP-182/,
      /--timeout-ms 45000/,
      /RP-183/,
      /authorAssociation/,
      /RP-99/,
      /link-contradicted-by-body/,
      /RP-59/,
      /255 characters/,
      /RP-121/,
      /bounded-retry/,
      /RP-158/,
    ]) {
      expect(historical?.[1]).toMatch(subject);
    }
    // 🔴 The historical 0.9.1 section keeps its fixes-only PATCH rationale;
    // 0.10.0 instead documents the additive setup composition above.
    expect(historical?.[1]).toMatch(/patch/i);
    // 🔴 The 0.9.0 section must still be BELOW it, unedited in place: a
    // release that rewrites the previous release's note is describing bytes
    // that already shipped.
    expect(changelog).toMatch(/^## 0\.9\.0$/m);
    expect(changelog.indexOf('## 0.10.1')).toBeLessThan(changelog.indexOf('## 0.10.0'));
    expect(changelog.indexOf('## 0.10.0')).toBeLessThan(changelog.indexOf('## 0.9.1'));
    expect(changelog.indexOf('## 0.9.1')).toBeLessThan(changelog.indexOf('## 0.9.0'));
    expect(changelog.indexOf('## 0.9.0')).toBeLessThan(changelog.indexOf('## 0.8.0'));
    expect(changelog.slice(changelog.indexOf('## 0.9.0'))).toMatch(/setup --memory-root/);
    expect(changelog.slice(changelog.indexOf('## 0.9.0'))).toMatch(
      /Deprecated: the application skeletons/,
    );
  });

  it('records 0.10.0 as the published `latest`, and every overtaken version as neither', async () => {
    const plan = await readFile(path.join(repoRoot, 'PLAN.md'), 'utf8');
    // Measured from the public registry on 22 Sep 2026. The release itself
    // could not carry its own gitHead in the ledger; 0.10.1 work records it now.
    const publishedSha = '279fbf928b811b8ebc7ba2d1c4700ee943b7dab1';
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
    // each overtaken version, so that negative accumulates.
    // "Pending" is PER-VERSION, and the status line names one version's state
    // at a time, so only the just-shipped version needs guarding; accumulating
    // those would grow a list forever against a shape that cannot recur.
    //
    // 0.10.0 shipped on 22 Sep 2026 and is the registry's current `latest`.
    // These guards move with that fact instead of leaving the plan pending.
    expect(plan).toMatch(/Status \(0\.10\.0 published/);
    expect(plan).toMatch(/0\.10\.0 is `latest`/);
    // The published identity is recorded, not just the version number — and it
    // is asserted BESIDE `gitHead`, so a stray occurrence of those characters
    // elsewhere in the file cannot satisfy it.
    expect(plan).toMatch(new RegExp(`gitHead\`? \`?${publishedSha.slice(0, 8)}`));
    // 0.10.0 is live, so it may not be described as pending anywhere — the
    // 0.6.2 mistake, now pointed at the current release. This is the same fact
    // the positive /`0\.9\.0` is prepared/ used to assert, inverted on the day
    // the release reached the registry rather than deleted.
    expect(plan).not.toMatch(
      /`?0\.10\.0`? (?:is )?prepared|0\.10\.0 publish pending|owner publishes `?0\.10\.0`?|`?0\.10\.0`? is waiting on the owner/,
    );
    // and no superseded version may still be called `latest` — the 0.7.0
    // mistake, kept red for every version that has been overtaken.
    expect(plan).not.toMatch(/`?0\.9\.1`? is `latest`/);
    expect(plan).not.toMatch(/`?0\.9\.0`? is `latest`/);
    expect(plan).not.toMatch(/`?0\.8\.0`? is `latest`/);
    expect(plan).not.toMatch(/`?0\.7\.1`? is `latest`/);
    expect(plan).not.toMatch(/`?0\.7\.0`? is `latest`/);
    expect(plan).not.toMatch(/`?0\.6\.2`? is `latest`/);
    // the two places that carry it must agree: whatever §11 calls the
    // current `latest` is what the status line calls live.
    expect(plan).toMatch(/done through `0\.10\.0`, the current `latest`/);
    // 0.10.1 is prepared, not published: its `is prepared` positive, and every
    // voice that would announce it as shipped, until the registry says so.
    expect(plan).toMatch(/`0\.10\.1`, a fixes-only patch, is prepared/);
    expect(plan).not.toMatch(/Status \(0\.10\.1 published/);
    expect(plan).not.toMatch(/`?0\.10\.1`? is `latest`/);
    expect(plan).not.toMatch(/through `?0\.10\.1`? are live/);
    expect(plan).not.toMatch(/done through `0\.10\.1`/);

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
  // exist only once that version is on the registry. 0.10.0's row is written
  // during 0.10.1 work from the measured public-registry gitHead.
  it('records 0.10.0 in the ledger at the commit it was published from', async () => {
    const ledger = JSON.parse(
      await readFile(path.join(repoRoot, 'templates', 'release-ledger.json'), 'utf8'),
    ) as Record<string, string | null>;
    // `npm view create-agent-rig@0.10.0 gitHead`, read on 2026-09-22
    expect(ledger['0.10.0']).toBe('279fbf928b811b8ebc7ba2d1c4700ee943b7dab1');
    expect(ledger['0.9.1']).toBe('872f7f67f11761c17aad3cbbe26540862581795b');
    expect(ledger['0.9.0']).toBe('c27f391e7395accaf09354f255a07e1b9e4710c1');
    // the previous rows are not disturbed by adding a new one
    expect(ledger['0.8.0']).toBe('870f9a3ecae2881908ece8ec3e2ac13f84f505f5');
    expect(ledger['0.7.1']).toBe('52e879b6c103f6ba70493007b6a6466c57ea9824');
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

  it('raises the Node floor to >=22 for the 1.0 contract freeze (RP-184)', async () => {
    // CI tests Node 22 only, and Node 20 has been end-of-life since April
    // 2026 — the one behaviour change the freeze allows, landing before 1.0.
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.engines?.node).toBe('>=22');
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
