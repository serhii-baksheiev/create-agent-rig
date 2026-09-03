import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  expectedTarballName,
  formatReport,
  ledgerFindings,
  manifestFindings,
  payloadFindings,
  suspiciousTarballEntries,
  // @ts-expect-error — a plain .mjs release script, imported for its pure parts
} from '../../scripts/release-preflight.mjs';

// `npm publish` here needs 2FA and cannot be undone, so the last check before it
// is the one that has to be mechanical. Today it is prose: step 8 of CHANGELOG's
// "Releasing" section hands the owner a checklist that restates facts the
// repository already owns — the two manifests, the ledger, the `files` payload —
// and a restated fact is a fact that goes stale.
//
// So these pin the PURE parts: functions that take already-read data and return
// findings. Nothing here runs `npm pack` or reads the network; the script's own
// entry point does the reading and hands the results to these. That split is
// what makes the release check testable at all, and it is the same shape
// `scripts/prepare.mjs` and `scripts/build-hash-history.mjs` already use —
// exported pure parts, an entry-point guard at the bottom.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(repoRoot, 'scripts', 'release-preflight.mjs');

/** The root manifest — the one that actually publishes. */
const rootManifest = (over: Record<string, unknown> = {}) => ({
  name: 'create-agent-rig',
  version: '0.9.0',
  type: 'module',
  bin: { 'create-agent-rig': 'packages/cli/dist/index.js' },
  files: ['packages/cli/dist', 'templates', 'scripts/prepare.mjs', 'CHANGELOG.md'],
  ...over,
});

/** The inner package — locked against publication twice over, on purpose. */
const innerManifest = (over: Record<string, unknown> = {}) => ({
  name: '@create-agent-rig/cli',
  version: '0.9.0',
  private: true,
  type: 'module',
  scripts: {
    prepublishOnly: 'node -e "console.error(\'BLOCKED\'); process.exit(1)"',
  },
  ...over,
});

describe('release preflight — the two manifests have to agree before an irreversible publish', () => {
  it('clears a pair of manifests that are in step and properly locked', () => {
    expect(manifestFindings({ root: rootManifest(), inner: innerManifest() })).toEqual([]);
  });

  // The "one of them was forgotten" case, and the reason step 3 of the release
  // runbook says "and the private inner package, kept in step".
  it('reports the two manifests disagreeing about the version', () => {
    const findings = manifestFindings({
      root: rootManifest({ version: '0.9.0' }),
      inner: innerManifest({ version: '0.8.0' }),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/version/i);
    // both numbers, so the owner does not have to open two files to see which
    // one is behind
    expect(findings[0]).toContain('0.9.0');
    expect(findings[0]).toContain('0.8.0');
  });

  // "the CLI keeps zero runtime deps" is what keeps `npx github:…` and the
  // tarball path working (CLAUDE.md, repo-specific rule 3). A dependency added
  // during a release is a dependency nobody notices until an install fails.
  it('reports a runtime dependency on the manifest that publishes', () => {
    const findings = manifestFindings({
      root: rootManifest({ dependencies: { chalk: '^5.0.0' } }),
      inner: innerManifest(),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/dependenc/i);
  });

  // The negative half. A rule that fires on the compliant form is a rule the
  // owner learns to skip past — and an empty object is what a tool leaves behind
  // after the last dependency is removed.
  it('treats an absent dependencies key and an empty one alike, as no dependencies', () => {
    expect(manifestFindings({ root: rootManifest(), inner: innerManifest() })).toEqual([]);
    expect(
      manifestFindings({ root: rootManifest({ dependencies: {} }), inner: innerManifest() }),
    ).toEqual([]);
  });

  // Flipped to false and deleted outright are the same fault: the inner package
  // is no longer refused by npm.
  it('reports the inner package losing its private flag, however it was lost', () => {
    for (const inner of [
      innerManifest({ private: false }),
      innerManifest({ private: undefined }),
    ]) {
      const findings = manifestFindings({ root: rootManifest(), inner });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatch(/private/i);
    }
  });

  // npm 10 ignores `private` on `publish --dry-run`, so the script is the real
  // lock and the flag alone is not enough (CLAUDE.md, "Only the repo root
  // publishes").
  it('reports the inner package losing its prepublishOnly lock, however it was lost', () => {
    for (const inner of [innerManifest({ scripts: {} }), innerManifest({ scripts: undefined })]) {
      const findings = manifestFindings({ root: rootManifest(), inner });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatch(/prepublishOnly/);
    }
  });

  it('names each fault separately when the manifests are wrong in every way', () => {
    const findings = manifestFindings({
      root: rootManifest({ version: '0.9.0', dependencies: { chalk: '^5.0.0' } }),
      inner: innerManifest({ version: '0.8.0', private: false, scripts: {} }),
    });
    // Four independent faults must not collapse into one line: the owner fixes
    // what is named, and an unnamed fault is one that ships.
    expect(findings).toHaveLength(4);
    expect(new Set(findings).size, 'two findings read identically').toBe(4);
  });

  // The fixtures above are this suite's idea of the shipping shape. This is the
  // shape itself — the same check, over the bytes the release will actually
  // publish, so a fixture that drifts from the repository is caught here.
  it('clears the manifests this repository has on disk right now', async () => {
    const read = async (relative: string) =>
      JSON.parse(await readFile(path.join(repoRoot, relative), 'utf8'));
    expect(
      manifestFindings({
        root: await read('package.json'),
        inner: await read('packages/cli/package.json'),
      }),
    ).toEqual([]);
  });
});

const LEDGER: Record<string, string | null> = {
  '0.1.0': null,
  '0.7.1': '52e879b6c103f6ba70493007b6a6466c57ea9824',
};

describe('release preflight — a version the ledger already records has already been published', () => {
  // Republishing an occupied version number is not a retry: it puts different
  // bytes behind a number rigs already installed from.
  it('refuses a version the ledger already has a row for', () => {
    const findings = ledgerFindings(LEDGER, '0.7.1');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('0.7.1');
  });

  it('passes a version the ledger has never seen', () => {
    expect(ledgerFindings(LEDGER, '0.9.0')).toEqual([]);
  });

  // 0.1.0 is recorded as `null` on purpose — "published, but the bytes are not
  // recoverable from git". Reading that as "no row" would wave through a
  // republish of the one version nobody can reconstruct.
  it('counts a null row as published, not as absent', () => {
    const findings = ledgerFindings(LEDGER, '0.1.0');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('0.1.0');
  });
});

/**
 * A realistic slice of what `npm pack` ships — dotted directories included,
 * because those are the ones a naive filter kills.
 */
const PAYLOAD = [
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'scripts/prepare.mjs',
  'packages/cli/dist/index.js',
  'packages/cli/dist/lib/copy-tree.js',
  'templates/release-ledger.json',
  'templates/agent-os/universal/CLAUDE.md',
  'templates/agent-os/universal/.claude/rules/autonomy.md',
  'templates/agent-os/universal/.claude/hooks/guard-bash.mjs',
  'templates/agent-os/universal/.agents/skills/loop/SKILL.md',
  'templates/skeleton/node-service/package.json',
  'templates/skeleton/node-service/.github/workflows/ci.yml',
];

describe('release preflight — what must never reach a published tarball', () => {
  it('flags an environment file at any depth, whatever suffix it carries', () => {
    expect(suspiciousTarballEntries([...PAYLOAD, '.env'])).toEqual(['.env']);
    expect(suspiciousTarballEntries([...PAYLOAD, '.env.local'])).toEqual(['.env.local']);
    expect(suspiciousTarballEntries([...PAYLOAD, 'a/b/.env'])).toEqual(['a/b/.env']);
  });

  // `templates/skeleton/*` are real runnable projects, and a `.env.example` is
  // the ordinary way such a project documents the variables it needs — it is
  // meant to be published. Flagging it would block the release with a message
  // that is true ("would be published") and wrong. Whether such a file has a
  // real credential pasted into it is another tool's job: this script reads
  // names, `scripts/validate-no-secrets.mjs` reads content over every tracked
  // file, and the split is what keeps each of them checkable.
  it('leaves the conventional no-secrets example files alone', () => {
    expect(
      suspiciousTarballEntries([
        ...PAYLOAD,
        'templates/skeleton/node-service/.env.example',
        'templates/skeleton/aws-serverless/.env.sample',
        '.env.template',
      ]),
    ).toEqual([]);
  });

  // 🔴 The direction that matters. An exemption written as "anything after
  // `.env.` is an example" waves through `.env.local` — which is exactly where
  // a real credential lives, and the reason the `.env` arm exists at all. So
  // the two are asserted in ONE list: a carve-out that widened would show up
  // here as a missing entry, not as a separate green test somewhere else.
  it('still flags the real environment files sitting beside the exempt ones', () => {
    expect(
      suspiciousTarballEntries([
        ...PAYLOAD,
        '.env.example',
        '.env',
        '.env.sample',
        '.env.local',
        '.env.template',
      ]),
    ).toEqual(['.env', '.env.local']);
  });

  // The one that would publish the publish token itself.
  it('flags an .npmrc', () => {
    expect(suspiciousTarballEntries([...PAYLOAD, '.npmrc'])).toEqual(['.npmrc']);
  });

  it('flags anything under node_modules or a git directory', () => {
    expect(suspiciousTarballEntries([...PAYLOAD, 'node_modules/left-pad/index.js'])).toEqual([
      'node_modules/left-pad/index.js',
    ]);
    expect(
      suspiciousTarballEntries([...PAYLOAD, 'templates/skeleton/node-service/node_modules/x.js']),
    ).toEqual(['templates/skeleton/node-service/node_modules/x.js']);
    expect(suspiciousTarballEntries([...PAYLOAD, '.git/config'])).toEqual(['.git/config']);
    expect(suspiciousTarballEntries([...PAYLOAD, 'templates/.git/HEAD'])).toEqual([
      'templates/.git/HEAD',
    ]);
  });

  it('flags key material', () => {
    expect(suspiciousTarballEntries([...PAYLOAD, 'certs/server.pem'])).toEqual([
      'certs/server.pem',
    ]);
    expect(suspiciousTarballEntries([...PAYLOAD, 'id_rsa.key'])).toEqual(['id_rsa.key']);
  });

  // A tarball inside a tarball is a previous pack that was never cleaned up —
  // it doubles the published size and ships stale bytes under a fresh version.
  it('flags a stray archive', () => {
    expect(suspiciousTarballEntries([...PAYLOAD, 'create-agent-rig-0.8.0.tgz'])).toEqual([
      'create-agent-rig-0.8.0.tgz',
    ]);
  });

  it('flags a .DS_Store', () => {
    expect(suspiciousTarballEntries([...PAYLOAD, 'templates/.DS_Store'])).toEqual([
      'templates/.DS_Store',
    ]);
  });

  it('reports every offender in one pass, not just the first', () => {
    expect(suspiciousTarballEntries([...PAYLOAD, '.env', '.npmrc', 'x.pem'])).toEqual([
      '.env',
      '.npmrc',
      'x.pem',
    ]);
    // Input order is the owner's reading order, and skipping an entry must not
    // disturb it — a carve-out implemented by shifting entries out of a shared
    // accumulator is how the third offender ends up in the second slot.
    expect(
      suspiciousTarballEntries([
        ...PAYLOAD,
        '.env.example',
        '.env',
        '.npmrc',
        '.env.sample',
        'x.pem',
      ]),
    ).toEqual(['.env', '.npmrc', 'x.pem']);
  });

  // 🔴 The direction that breaks the release rather than a rule. The whole
  // payload of this package is a dotted tree — `.claude/`, `.agents/`,
  // `.codex/`, `.github/` — so a filter written as "starts with a dot is
  // suspicious" strips the thing being shipped and the tarball still packs.
  it('leaves the real payload alone, dotted .claude tree and all', () => {
    expect(suspiciousTarballEntries(PAYLOAD)).toEqual([]);
  });

  it('says nothing about an empty file list, rather than inventing a finding', () => {
    expect(suspiciousTarballEntries([])).toEqual([]);
  });
});

describe('release preflight — the payload the git path cannot check', () => {
  // Step 2 of the release runbook, mechanised: "this is where scaffolders
  // break, and the git path cannot catch it". The two file sets differ exactly
  // at dotfiles, so a tarball missing the rulebook installs a rig with no rules.
  it('reports a tarball carrying no .claude tree under the universal layer', () => {
    const findings = payloadFindings(PAYLOAD.filter((p) => !p.includes('/.claude/')));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('templates/agent-os/universal/.claude/');
  });

  it('is satisfied by one file under that tree', () => {
    expect(payloadFindings(['templates/agent-os/universal/.claude/rules/autonomy.md'])).toEqual([]);
    expect(payloadFindings(PAYLOAD)).toEqual([]);
  });

  it('reports an empty tarball listing, which is the loudest form of the same fault', () => {
    expect(payloadFindings([])).toHaveLength(1);
  });
});

describe('release preflight — the artifact the owner is about to publish', () => {
  it('names the tarball npm pack produces for a version', () => {
    expect(expectedTarballName('0.9.0')).toBe('create-agent-rig-0.9.0.tgz');
    expect(expectedTarballName('0.10.1')).toBe('create-agent-rig-0.10.1.tgz');
  });
});

describe('release preflight — the report the owner reads before typing npm publish', () => {
  it('names every finding it was given', () => {
    const findings = [
      'package.json says 0.9.0 but packages/cli/package.json says 0.8.0',
      'the root manifest declares runtime dependencies: chalk',
      '.env would be published',
    ];
    const report = formatReport(findings);
    // Substance, not layout: a report that drops the third finding is a report
    // that ships the third fault.
    for (const finding of findings) expect(report).toContain(finding);
  });

  // "no findings" and "the check never ran" print the same thing unless the
  // passing case says so out loud — the same reason validate-no-secrets states
  // the size of the set it read.
  it('says the preflight passed when there is nothing to report', () => {
    const report = formatReport([]);
    expect(report).toMatch(/pass/i);
  });
});

describe('release preflight — importing the module must not run the release check', () => {
  // The style prepare.mjs uses, asserted the way git-env.test.ts asserts it.
  it('carries the entry-point guard prepare.mjs uses', async () => {
    const source = await readFile(script, 'utf8');
    expect(source).toMatch(/import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
  });

  // And the behaviour, because the grep above passes on a module that runs its
  // main through some other idiom. A preflight that fires on import would run
  // `npm pack` from inside a test run, and a `process.exit` in it would take the
  // importing process with it.
  it('produces no output and no exit when it is merely imported', async () => {
    const url = pathToFileURL(script).href;
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `await import(${JSON.stringify(url)}); console.log('IMPORTED');`,
        ],
        { cwd: repoRoot },
        (error, stdout, stderr) =>
          resolve({
            code: error ? ((error as { code?: number }).code ?? 1) : 0,
            out: stdout + stderr,
          }),
      );
    });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('IMPORTED');
    expect(result.out.replace('IMPORTED', '').trim(), 'the module did something on import').toBe(
      '',
    );
  });
});
