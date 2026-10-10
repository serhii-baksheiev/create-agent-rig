import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// RP-353: taken off the namespace rather than by name, the same reasoning
// `test/template/release-preflight.test.ts` already states for its own import
// of this script — a missing export fails only the tests that use it.
// @ts-expect-error — a plain .mjs release script, imported for its pure parts
import * as releasePreflight from '../../scripts/release-preflight.mjs';

const { changelogHeadingFindings } = releasePreflight as {
  changelogHeadingFindings: (changelog: string, version: string) => string[];
};

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
  // RP-374: a literal-version mirror ("both manifests say 1.1.1") is
  // tautological the moment the next release bumps the literal — it would
  // keep passing on a manifest nobody bumped, as long as someone typed the
  // same old string in both files. The relational form instead asks the one
  // question that actually matters at release-prep time: is the version
  // every manifest agrees on strictly ahead of the last version this
  // project has confirmed shipped? The comparator below is written out by
  // hand, independently of any production ordering helper, so this test
  // cannot pass merely because production agrees with itself.
  it('ships one version in both package manifests, strictly after the latest released ledger entry', async () => {
    const root = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    const inner = JSON.parse(
      await readFile(path.join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(inner.version).toBe(root.version);

    const ledger = JSON.parse(
      await readFile(path.join(repoRoot, 'templates', 'release-ledger.json'), 'utf8'),
    ) as Record<string, string | null>;

    const parts = (version: string): [number, number, number] => {
      const [major, minor, patch] = version.split('.').map(Number);
      return [major ?? 0, minor ?? 0, patch ?? 0];
    };
    const compareSemver = (a: string, b: string): number => {
      const [aMajor, aMinor, aPatch] = parts(a);
      const [bMajor, bMinor, bPatch] = parts(b);
      if (aMajor !== bMajor) return aMajor - bMajor;
      if (aMinor !== bMinor) return aMinor - bMinor;
      return aPatch - bPatch;
    };

    const releasedVersions = Object.entries(ledger)
      .filter(([, gitHead]) => gitHead !== null)
      .map(([version]) => version);
    expect(releasedVersions.length).toBeGreaterThan(0);
    const highestReleased = releasedVersions.sort(compareSemver).at(-1) as string;

    expect(compareSemver(root.version, highestReleased)).toBeGreaterThan(0);
  });

  it('puts the 1.5.0 replacement candidate first and preserves frozen 1.4.1 and published 1.4.0 and 1.3.1 history', async () => {
    const changelog = await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
    // RP-374: the previous form of this regex required the heading's digits
    // to be followed immediately by a newline, so a "(release candidate)"
    // suffix fell outside the match and the heading was skipped rather than
    // read — the candidate suffix must be matched explicitly, not relied on
    // to be absent.
    const first = changelog.match(
      /^## (\d+\.\d+\.\d+)(?: \(release candidate\))?\n([\s\S]*?)(?=^## \d+\.\d+\.\d+)/m,
    );
    expect(first?.[1]).toBe('1.5.0');
    // The named subjects of THIS release, not words any release note would
    // contain — so an entry copied forward from 1.4.0 fails here. Each pin
    // pairs the shipped behavior with the ticket that owns it.
    expect(first?.[2]).toMatch(/RP-339/);
    expect(first?.[2]).toMatch(/RP-340/);
    expect(first?.[2]).toMatch(/RP-341/);
    expect(first?.[2]).toMatch(/RP-342/);
    expect(first?.[2]).toMatch(/RP-343/);
    expect(first?.[2]).toMatch(/RP-344/);
    expect(first?.[2]).toMatch(/authority\.mjs/);
    // 🔴 the numbering call: additive on the 1.4 line — a MINOR.
    expect(first?.[2]).toMatch(/is additive on the 1\.4 line/i);
    // RP-344: live Codex acceptance was unavailable for this release, and the
    // entry must say so rather than silently omitting it.
    expect(first?.[2]).toMatch(/Codex/);
    expect(first?.[2]).toMatch(/unavailable/i);
    const patch = changelog.match(
      /^## 1\.4\.1 \(release candidate\)\n([\s\S]*?)(?=^## \d+\.\d+\.\d+)/m,
    );
    expect(patch).not.toBeNull();
    // The named subjects of THIS release, not words any release note would
    // contain — so an entry copied forward from 1.4.0 fails here. Each pin
    // pairs the shipped behavior with the ticket that owns it.
    expect(patch?.[1]).toMatch(/RP-463/);
    expect(patch?.[1]).toMatch(/RP-459/);
    // A patch must say why it is a patch, independently of the version digits.
    expect(patch?.[1]).toMatch(/is a patch on the 1\.4 line/i);
    // RP-463: absolute apply_patch paths remain safe only when containment and
    // credential checks survive in both operating modes.
    expect(patch?.[1]).toMatch(/absolute `apply_patch` paths/i);
    expect(patch?.[1]).toMatch(/path containment and credential checks/i);
    expect(patch?.[1]).toMatch(/attended and unattended modes/i);
    // RP-459: a Move source must still be the verified file before inspection.
    expect(patch?.[1]).toMatch(/Move source/i);
    expect(patch?.[1]).toMatch(/compare its file identity/i);
    // 1.4.0 is published. Its frozen candidate remains the provenance record,
    // but publication reconciles the changelog heading to its plain form.
    const postureMinor = changelog.match(/^## 1\.4\.0\n([\s\S]*?)(?=^## \d+\.\d+\.\d+)/m);
    expect(postureMinor?.[1]).toMatch(/RP-280/);
    expect(postureMinor?.[1]).toMatch(/RP-281/);
    expect(postureMinor?.[1]).toMatch(/RP-282/);
    expect(postureMinor?.[1]).toMatch(/RP-283/);
    expect(postureMinor?.[1]).toMatch(/RP-321/);
    expect(postureMinor?.[1]).toMatch(/posture\.mjs/);
    expect(postureMinor?.[1]).toMatch(/is additive on the 1\.3 line/i);
    const hotfix = changelog.match(/^## 1\.3\.1\n([\s\S]*?)(?=^## \d+\.\d+\.\d+)/m);
    expect(hotfix?.[1]).toMatch(/RP-451/);
    expect(hotfix?.[1]).toMatch(/RP-455/);
    expect(hotfix?.[1]).toMatch(/RP-460/);
    expect(hotfix?.[1]).toMatch(/19a9dc648b336732b495d5dd98eb2e32dd8e3b1f/);
    expect(hotfix?.[1]).toMatch(/source candidate remains unchanged/i);
    // 1.3.0 is published, so its heading is reconciled to the plain form and
    // its pins move one release down.
    const probityMinor = changelog.match(/^## 1\.3\.0\n([\s\S]*?)(?=^## \d+\.\d+\.\d+)/m);
    expect(probityMinor?.[1]).toMatch(/RP-415/);
    expect(probityMinor?.[1]).toMatch(/RP-416/);
    expect(probityMinor?.[1]).toMatch(/RP-417/);
    expect(probityMinor?.[1]).toMatch(/RP-418/);
    expect(probityMinor?.[1]).toMatch(/@nizos\/probity/);
    expect(probityMinor?.[1]).toMatch(/is additive on the 1\.2 line/i);
    // 1.2.1 is published, so its heading is reconciled to the plain form and
    // its pins move one release down, the numbering departure included.
    const reliabilityPatch = changelog.match(/^## 1\.2\.1\n([\s\S]*?)(?=^## \d+\.\d+\.\d+)/m);
    expect(reliabilityPatch?.[1]).toMatch(/RP-252/);
    expect(reliabilityPatch?.[1]).toMatch(/RP-310/);
    expect(reliabilityPatch?.[1]).toMatch(/RP-323/);
    expect(reliabilityPatch?.[1]).toMatch(/RP-279/);
    expect(reliabilityPatch?.[1]).toMatch(/RP-349/);
    expect(reliabilityPatch?.[1]).toMatch(/is a reliability patch on the 1\.2 line/i);
    expect(reliabilityPatch?.[1]).toMatch(/RP-267/);
    const numbering = changelog.slice(0, changelog.search(/^## \d/m));
    expect(numbering).toMatch(/1\.2\.1 is the\s+third/);
    expect(changelog.indexOf('## 1.4.0')).toBeLessThan(changelog.indexOf('## 1.3.1'));
    expect(changelog.indexOf('## 1.3.1')).toBeLessThan(changelog.indexOf('## 1.3.0'));
    expect(changelog.indexOf('## 1.3.0')).toBeLessThan(changelog.indexOf('## 1.2.1'));
    // 1.2.0 is published, so its heading is reconciled to the plain form —
    // a leftover "(release candidate)" suffix does not match here.
    const additiveMinor = changelog.match(/^## 1\.2\.0\n([\s\S]*?)(?=^## \d+\.\d+\.\d+)/m);
    expect(additiveMinor?.[1]).toMatch(/RP-275/);
    expect(additiveMinor?.[1]).toMatch(/RP-330/);
    expect(additiveMinor?.[1]).toMatch(/RP-353/);
    expect(additiveMinor?.[1]).toMatch(/RP-368/);
    expect(additiveMinor?.[1]).toMatch(/RP-398/);
    // 🔴 carried forward from when this was the "first" pin: 1.2.0 is still
    // the additive MINOR it always was, one release further down now.
    expect(additiveMinor?.[1]).toMatch(/is additive on the 1\.1 line/i);
    const corrective = changelog.match(/^## 1\.1\.1\n([\s\S]*?)(?=^## \d+\.\d+\.\d+)/m);
    // The 1.1.1 pins carried forward unchanged, now one release further down.
    expect(corrective?.[1]).toMatch(/RP-309/);
    expect(corrective?.[1]).toMatch(/RP-246/);
    expect(corrective?.[1]).toMatch(/RP-292/);
    expect(corrective?.[1]).toMatch(/RP-295/);
    expect(corrective?.[1]).toMatch(/RP-300/);
    // 🔴 carried forward from when this was the "first" pin: 1.1.1 is still
    // the corrective hardening patch it always was, one release further
    // down now.
    expect(corrective?.[1]).toMatch(/is a corrective hardening patch on the 1\.1 line/i);
    const minor = changelog.match(/^## 1\.1\.0\n([\s\S]*?)(?=^## \d+\.\d+\.\d+)/m);
    expect(minor?.[1]).toMatch(/RP-224/);
    expect(minor?.[1]).toMatch(/RP-297/);
    expect(minor?.[1]).toMatch(/RP-273/);
    expect(minor?.[1]).toMatch(/RP-240/);
    expect(minor?.[1]).toMatch(/RP-269/);
    // 🔴 carried forward from when this was the "first" pin: 1.1.0 is still
    // the additive MINOR it always was, one release further down now.
    expect(minor?.[1]).toMatch(/is additive on the 1\.0 line/i);
    const previous = changelog.match(/^## 1\.0\.1\n([\s\S]*?)(?=^## \d+\.\d+\.\d+)/m);
    expect(previous?.[1]).toMatch(/RP-214/);
    expect(previous?.[1]).toMatch(/RP-215/);
    expect(previous?.[1]).toMatch(/RP-243/);
    expect(previous?.[1]).toMatch(/RP-244/);
    expect(previous?.[1]).toMatch(/RP-238/);
    expect(previous?.[1]).toMatch(/Opus 5\.5/);
    expect(previous?.[1]).toMatch(/RP-232/);
    expect(previous?.[1]).toMatch(/GPT-6 Sol/);
    expect(previous?.[1]).toMatch(/RP-233/);
    // 🔴 carried forward from when this was the "first" pin: 1.0.1 is still
    // the guard-hardening PATCH it always was, further down now.
    expect(previous?.[1]).toMatch(/is a patch on the 1\.0 line/i);
    const historical = changelog.match(/^## 1\.0\.0\n([\s\S]*?)(?=^## \d+\.\d+\.\d+)/m);
    expect(historical?.[1]).toMatch(/command-contract\.md/);
    expect(historical?.[1]).toMatch(/RP-184/);
    expect(historical?.[1]).toMatch(/failure-diagnostician/);
    expect(historical?.[1]).toMatch(/RP-195/);
    expect(historical?.[1]).toMatch(/release-propose/);
    expect(historical?.[1]).toMatch(/RP-203/);
    expect(historical?.[1]).toMatch(/independent-oracle invariant/);
    expect(historical?.[1]).toMatch(/RP-187/);
    // 🔴 carried forward from when this was the "previous" pin: 1.0.0 is
    // still the contract-freeze MAJOR it always was, another release further
    // down.
    expect(historical?.[1]).toMatch(/is a major\s+bump/);
    const patchLine = changelog.match(/^## 0\.10\.1\n([\s\S]*?)(?=^## \d+\.\d+\.\d+)/m);
    expect(patchLine?.[1]).toMatch(/EISDIR/);
    expect(patchLine?.[1]).toMatch(/RP-189/);
    expect(patchLine?.[1]).toMatch(/AGENTS\.md\.rig-new/);
    expect(patchLine?.[1]).toMatch(/RP-202/);
    expect(patchLine?.[1]).toMatch(/monotonic clock/);
    expect(patchLine?.[1]).toMatch(/RP-204/);
    expect(patchLine?.[1]).toMatch(/RP-194/);
    // 🔴 carried forward from when this was the "historical" pin: 0.10.1 is
    // still the fixes-only patch it always was, another release further
    // down.
    expect(patchLine?.[1]).toMatch(/fixes-only patch/i);
    const additive = changelog.match(/^## 0\.10\.0\n([\s\S]*?)(?=^## \d+\.\d+\.\d+)/m);
    expect(additive?.[1]).toMatch(/doctor \[--json\].*aggregates Rig file integrity/s);
    expect(additive?.[1]).toMatch(/provider\/harness wizard/);
    expect(additive?.[1]).toMatch(/Spec Kit setup to\s+the pinned official CLI/);
    expect(additive?.[1]).toMatch(
      /Ownership\s+hashes live alongside provider selection in `\.rig\/integrations\.json`/,
    );
    const legacy = changelog.match(/^## 0\.9\.1\n([\s\S]*?)(?=^## \d+\.\d+\.\d+)/m);
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
      expect(legacy?.[1]).toMatch(subject);
    }
    // 🔴 The legacy 0.9.1 section keeps its fixes-only PATCH rationale;
    // 0.10.0 documents the additive setup composition, 1.0.0 documents the
    // contract-freeze MAJOR, 1.0.1 documents the guard-hardening PATCH on the
    // 1.0 line, 1.1.0 above documents the additive MINOR on the same line,
    // and 1.1.1 documents the corrective PATCH on the 1.1 line.
    expect(legacy?.[1]).toMatch(/patch/i);
    // 🔴 The 0.9.0 section must still be BELOW it, unedited in place: a
    // release that rewrites the previous release's note is describing bytes
    // that already shipped.
    expect(changelog).toMatch(/^## 0\.9\.0$/m);
    expect(changelog.indexOf('## 1.2.1')).toBeLessThan(changelog.indexOf('## 1.2.0'));
    expect(changelog.indexOf('## 1.2.0')).toBeLessThan(changelog.indexOf('## 1.1.1'));
    expect(changelog.indexOf('## 1.1.1')).toBeLessThan(changelog.indexOf('## 1.1.0'));
    expect(changelog.indexOf('## 1.1.0')).toBeLessThan(changelog.indexOf('## 1.0.1'));
    expect(changelog.indexOf('## 1.0.1')).toBeLessThan(changelog.indexOf('## 1.0.0'));
    expect(changelog.indexOf('## 1.0.0')).toBeLessThan(changelog.indexOf('## 0.10.1'));
    expect(changelog.indexOf('## 0.10.1')).toBeLessThan(changelog.indexOf('## 0.10.0'));
    expect(changelog.indexOf('## 0.10.0')).toBeLessThan(changelog.indexOf('## 0.9.1'));
    expect(changelog.indexOf('## 0.9.1')).toBeLessThan(changelog.indexOf('## 0.9.0'));
    expect(changelog.indexOf('## 0.9.0')).toBeLessThan(changelog.indexOf('## 0.8.0'));
    expect(changelog.slice(changelog.indexOf('## 0.9.0'))).toMatch(/setup --memory-root/);
    expect(changelog.slice(changelog.indexOf('## 0.9.0'))).toMatch(
      /Deprecated: the application skeletons/,
    );
  });

  it('records published 1.3.1 and 1.4.0, with 1.4.0 as `latest` and every overtaken version as neither', async () => {
    const plan = await readFile(path.join(repoRoot, 'PLAN.md'), 'utf8');
    // Read from the public registry on 9 Oct 2026. Keep both identities
    // literal: the reconciliation must not turn a published-version claim into
    // a version-only claim.
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
    expect(plan).toMatch(
      /npm contains published `1\.3\.1`\s*\r?\n>\s*\(`gitHead` `19a9dc648b336732b495d5dd98eb2e32dd8e3b1f`\) and `1\.4\.0`/,
    );
    expect(plan).toMatch(
      /and `1\.4\.0`\s*\r?\n>\s*\(`gitHead` `a03c3eed6693658f338fee5aef04102ab02bc83a`\); `latest` is `1\.4\.0`\./,
    );
    expect(plan).toMatch(/`latest` is `1\.4\.0`/);
    expect(plan).toMatch(/Current release:\*\* 1\.4\.0/);
    // 1.3.1 and 1.4.0 are live, so neither may be described as pending.
    expect(plan).not.toMatch(
      /`?1\.3\.1`? (?:is )?prepared|`?1\.3\.1`? is the release candidate|1\.3\.1 publish pending|owner publishes `?1\.3\.1`?|`?1\.3\.1`? is waiting on the owner/,
    );
    expect(plan).not.toMatch(
      /`?1\.4\.0`? (?:is )?prepared|`?1\.4\.0`? is the release candidate|1\.4\.0 publish pending|owner publishes `?1\.4\.0`?|`?1\.4\.0`? is waiting on the owner/,
    );
    // and no superseded version may still be called `latest` — the 0.7.0
    // mistake, kept red for every version that has been overtaken.
    expect(plan).not.toMatch(/`?1\.3\.1`? is `latest`/);
    expect(plan).not.toMatch(/`?1\.3\.0`? is `latest`/);
    expect(plan).not.toMatch(/`?1\.2\.1`? is `latest`/);
    expect(plan).not.toMatch(/`?1\.2\.0`? is `latest`/);
    expect(plan).not.toMatch(/`?1\.1\.1`? is `latest`/);
    expect(plan).not.toMatch(/`?1\.1\.0`? is `latest`/);
    expect(plan).not.toMatch(/`?1\.0\.1`? is `latest`/);
    expect(plan).not.toMatch(/`?1\.0\.0`? is `latest`/);
    expect(plan).not.toMatch(/`?0\.10\.1`? is `latest`/);
    expect(plan).not.toMatch(/`?0\.10\.0`? is `latest`/);
    expect(plan).not.toMatch(/`?0\.9\.1`? is `latest`/);
    expect(plan).not.toMatch(/`?0\.9\.0`? is `latest`/);
    expect(plan).not.toMatch(/`?0\.8\.0`? is `latest`/);
    expect(plan).not.toMatch(/`?0\.7\.1`? is `latest`/);
    expect(plan).not.toMatch(/`?0\.7\.0`? is `latest`/);
    expect(plan).not.toMatch(/`?0\.6\.2`? is `latest`/);
    // 1.5.0 is accepted and frozen, but remains unpublished. Its candidate
    // status is provenance, never evidence of a registry publication.
    expect(plan).toMatch(/`1\.5\.0` is accepted and frozen/);
    expect(plan).not.toMatch(/Status \(1\.5\.0 published/);
    expect(plan).not.toMatch(/`?1\.5\.0`? is `latest`/);
    expect(plan).not.toMatch(/through `?1\.5\.0`? are live/);
    expect(plan).not.toMatch(/done through `1\.5\.0`/);

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
  // exist only once that version is on the registry. 1.1.0's row is written
  // during 1.1.1 work from the measured public-registry gitHead.
  it('records each published release in the ledger at the commit it was published from', async () => {
    const ledger = JSON.parse(
      await readFile(path.join(repoRoot, 'templates', 'release-ledger.json'), 'utf8'),
    ) as Record<string, string | null>;
    // `npm view create-agent-rig@1.1.0 gitHead`, read on 2026-09-29
    expect(ledger['1.1.0']).toBe('3a52a0787c8648899ae5893c4e11b251802cae29');
    expect(ledger['1.0.1']).toBe('f32dfc244fb0b502d3803076aa54a92bff3625a4');
    expect(ledger['1.0.0']).toBe('8876147ce93d54ba8321d2bcdafab7f5dd1f8994');
    expect(ledger['0.10.1']).toBe('738b494806b435f0718f290dc3befb40829e5ebf');
    expect(ledger['0.10.0']).toBe('279fbf928b811b8ebc7ba2d1c4700ee943b7dab1');
    expect(ledger['0.9.1']).toBe('872f7f67f11761c17aad3cbbe26540862581795b');
    expect(ledger['0.9.0']).toBe('c27f391e7395accaf09354f255a07e1b9e4710c1');
    // the previous rows are not disturbed by adding a new one
    expect(ledger['0.8.0']).toBe('870f9a3ecae2881908ece8ec3e2ac13f84f505f5');
    expect(ledger['0.7.1']).toBe('52e879b6c103f6ba70493007b6a6466c57ea9824');
    expect(ledger['0.7.0']).toBe('6589db36e1daa63a99ec595191db1cccf7373196');
    expect(ledger['1.3.0']).toBe('9c2508302e7a04b95c51edab2d256816cedddd82');
    expect(ledger['1.3.1']).toBe('19a9dc648b336732b495d5dd98eb2e32dd8e3b1f');
    expect(ledger['1.4.0']).toBe('a03c3eed6693658f338fee5aef04102ab02bc83a');
    // 1.4.1 remains a release candidate and unpublished, so it has no ledger row.
    expect(ledger).not.toHaveProperty('1.4.1');
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

  // RP-353: the assertion two tests above this one reads
  // `expect(changelog).toContain(`## ${pkg.version}`)`, which also accepts any
  // heading that merely STARTS with the version — `## 1.1.1.1` carries
  // `## 1.1.1` as a literal substring. `changelogHeadingFindings` is the
  // strict form: exactly `## X.Y.Z`, or exactly `## X.Y.Z (release
  // candidate)` for an accepted-but-unpublished candidate, and nothing looser
  // than either.
  it('documents this version under the strict heading syntax, not merely a heading that starts with it', async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    const changelog = await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
    expect(changelogHeadingFindings(changelog, pkg.version)).toEqual([]);
  });

  // The gap the loose `toContain` check cannot see: a heading for a different,
  // merely-prefix-matching version must still be rejected.
  it('rejects a heading that only starts with the version — the gap a toContain check misses', () => {
    expect(changelogHeadingFindings('## 1.1.1.1\n\nnotes\n', '1.1.1')).not.toEqual([]);
  });

  it('accepts the declared release-candidate syntax and nothing looser than it', () => {
    expect(changelogHeadingFindings('## 2.0.0 (release candidate)\n\nnotes\n', '2.0.0')).toEqual(
      [],
    );
    expect(changelogHeadingFindings('## 2.0.0 (candidate)\n\nnotes\n', '2.0.0')).not.toEqual([]);
  });

  it('the bin entry keeps its shebang', async () => {
    const source = await readFile(
      path.join(repoRoot, 'packages', 'cli', 'src', 'index.ts'),
      'utf8',
    );
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });
});
