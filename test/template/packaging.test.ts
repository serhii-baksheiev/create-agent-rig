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
  it('prepares 0.7.1 as one release in both package manifests', async () => {
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

  it('records 0.7.1 as prepared, 0.7.0 as published, and only one of them as `latest`', async () => {
    const plan = await readFile(path.join(repoRoot, 'PLAN.md'), 'utf8');
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
    // So the shape from here is: the PREPARED version is named prepared and
    // never published; the PUBLISHED version is named published and is the one
    // and only `latest`. Both directions are red.
    expect(plan).toMatch(/Status \(0\.7\.1 prepared/);
    expect(plan).toMatch(/0\.7\.0 published/);
    expect(plan).toMatch(/0\.7\.0 is `latest`/);
    // 0.7.1 is not published, and must not be described as though it were —
    // this is the guard the previous release needed pointing the other way.
    expect(plan).not.toMatch(
      /`?0\.7\.1`? (?:is |was )?published|`?0\.7\.1`? is `latest`|through `?0\.7\.1`?, the current/,
    );
    // 0.7.0 is published, so it may not be described as pending.
    expect(plan).not.toMatch(
      /`?0\.7\.0`? (?:is )?prepared|0\.7\.0 publish pending|owner publishes `?0\.7\.0`?/,
    );
    expect(plan).not.toMatch(/`?0\.6\.2`? is `latest`/);
    // and the two places that carry it must agree: whatever §11 calls the
    // current `latest` is what the status line calls live.
    expect(plan).toMatch(/done through `0\.7\.0`, the current `latest`/);
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
