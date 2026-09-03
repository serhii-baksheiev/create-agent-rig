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
// @ts-expect-error — see above; the same script, taken as a namespace
import * as preflight from '../../scripts/release-preflight.mjs';
import {
  CREDENTIAL_BASENAMES,
  CREDENTIAL_EXTENSIONS,
  CREDENTIAL_SEGMENTS,
  isCredentialPath,
  // @ts-expect-error — the rulebook scripts are .mjs without type declarations
} from '../../.claude/scripts/lib/secrets.mjs';

// The parts of the script that do not exist yet are taken off the NAMESPACE
// rather than by name. A named import of an absent export is a link-time error
// that fails the whole file, which would hide every guarantee below it behind
// one red line; off the namespace, a missing export fails exactly the tests that
// use it and leaves the rest readable.
const { exitCodeFor, gitFindings, tarballNameFindings } = preflight as {
  exitCodeFor: (findings: readonly string[]) => number;
  gitFindings: (state: { status: string; head: string; remote: string }) => string[];
  tarballNameFindings: (filename: string | undefined, version: string) => string[];
};

// `npm publish` here needs 2FA and cannot be undone, so the last check before it
// is the one that has to be mechanical. When these tests were written it was
// prose: step 8 of CHANGELOG's "Releasing" section handed the owner a checklist
// that restated facts the repository already owns — the two manifests, the
// ledger, the `files` payload — and a restated fact is a fact that goes stale.
// The same branch changed step 8 to name the script, so that sentence describes
// the world these tests were written against, not this one.
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

  // 🔴 The junk arms do their OWN separator normalisation, and this is the test
  // that says so. The backslash case above it is a credential, which
  // `isCredentialPath` normalises internally — so deleting the `replaceAll` in
  // `suspiciousTarballEntries` left every other test green. A mutation run found
  // that gap: with the normalisation gone, `a\b\node_modules\x.js` is one
  // segment that matches no junk name, and a packed `node_modules` ships.
  it('flags junk spelled with Windows separators, which the credential arm cannot cover', () => {
    expect(suspiciousTarballEntries([...PAYLOAD, 'a\\b\\node_modules\\x.js'])).toEqual([
      'a\\b\\node_modules\\x.js',
    ]);
    expect(suspiciousTarballEntries([...PAYLOAD, 'templates\\.git\\HEAD'])).toEqual([
      'templates\\.git\\HEAD',
    ]);
    expect(suspiciousTarballEntries([...PAYLOAD, 'templates\\.DS_Store'])).toEqual([
      'templates\\.DS_Store',
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

// 🔴 The block above pins the tarball-specific arms — `node_modules/`, `.git/`,
// a stray `.tgz`, a `.DS_Store`. This one pins the OTHER half, and the reason it
// is a separate block is that the other half is not this script's to decide.
//
// `.claude/scripts/lib/secrets.mjs` is where this project spells "is this file a
// credential BY ITS NAME" — one vocabulary, read by the guard, the commit-time
// sweep and the ignore rules (`.claude/rules/invariants.md`, "one mechanism, one
// implementation"). A second spelling inside the release script is two lists
// answering one question, and the one nobody is looking at is the one that is
// wrong. It already was: when these tests were written, the hand-typed positive
// entries below — `.ENV`, `.envrc`, `id_rsa`, `.netrc`, `.pgpass`, the
// `secrets/` segment, the backslash path — were credentials the shared module
// refused and the local list would have published. NOT every entry below: the
// negative cases are here precisely because they must stay clean, and three of
// the generated fixtures (`.npmrc`, `server.pem`, `server.key`) the local list
// did catch. They are red-to-green history, and they stay because the
// delegation they forced is the thing that can regress — put that weaker list
// back and they go red again.
describe('release preflight — the credential vocabulary is the shared one, not a second copy', () => {
  // 🔴 macOS and Windows are case-insensitive filesystems, so `.ENV` and `.env`
  // are the SAME FILE — git records whichever spelling was typed, and the owner
  // publishes from Windows. `isCredentialPath` lowercases once before every arm
  // and says so in its own comment; a case-sensitive copy refuses one spelling
  // and waves the other through, which is the worse of the two failures because
  // it reads as coverage.
  it('flags a credential file however its name is cased', () => {
    for (const entry of ['.ENV', '.Env.local', '.NPMRC', 'x.PEM', 'id_rsa.KEY']) {
      expect(suspiciousTarballEntries([...PAYLOAD, entry]), entry).toEqual([entry]);
    }
  });

  // The shapes a hand-written local list never had. `.envrc` is the expensive
  // one: direnv writes `export …_TOKEN=…` into it verbatim, and the shared
  // module carries it deliberately wider than the router for exactly that
  // reason.
  it('flags the credential filenames the tarball-local list never knew', () => {
    for (const entry of ['.envrc', 'id_rsa', '.netrc', '.pgpass']) {
      expect(suspiciousTarballEntries([...PAYLOAD, entry]), entry).toEqual([entry]);
    }
  });

  // A directory whose contents are credentials whatever the files are called —
  // the arm no suffix list can express, because the give-away is the segment.
  it('flags anything sitting under a secrets or credentials directory', () => {
    expect(suspiciousTarballEntries([...PAYLOAD, 'a/secrets/x.json'])).toEqual([
      'a/secrets/x.json',
    ]);
    expect(suspiciousTarballEntries([...PAYLOAD, 'credentials/x'])).toEqual(['credentials/x']);
  });

  // `npm pack --json` reports POSIX paths, but the listing is not the only way
  // a path reaches this function and the release is cut on Windows. Splitting on
  // '/' alone reads a backslash path as one long basename, and one long basename
  // matches nothing. `isCredentialPath` normalises the separators first.
  it('flags a path spelled with Windows separators', () => {
    const entry = 'templates\\skeleton\\.env';
    expect(suspiciousTarballEntries([...PAYLOAD, entry])).toEqual([entry]);
  });

  // 🔴 The test that stops the copy coming back. It is driven from the shared
  // module's OWN exported lists rather than from names typed here, so a word
  // added to the vocabulary tomorrow is a name this release check must already
  // flag — nobody has to remember to come back and widen a second list. The
  // first assertion guards the fixture: if a list member stops being a
  // credential, this reports the fixture, not the preflight.
  const sharedCredentialNames = [
    ...[...CREDENTIAL_BASENAMES].map((name: string) => `templates/skeleton/node-service/${name}`),
    ...[...CREDENTIAL_EXTENSIONS].map((ext: string) => `packages/cli/dist/server.${ext}`),
    ...[...CREDENTIAL_SEGMENTS].map((segment: string) => `templates/${segment}/anything.json`),
  ];

  it('flags every name the shared vocabulary calls a credential', () => {
    expect(
      sharedCredentialNames.length,
      'the vocabulary exported nothing to check',
    ).toBeGreaterThan(6);
    for (const entry of sharedCredentialNames) {
      expect(isCredentialPath(entry), `${entry}: the fixture is wrong, not the preflight`).toBe(
        true,
      );
      expect(suspiciousTarballEntries([...PAYLOAD, entry]), entry).toEqual([entry]);
    }
  });

  // The negative half, and the guarantee the delegation must not cost. The
  // shared module ALREADY exempts these: `PLACEHOLDER_SUFFIXES` in secrets.mjs
  // is `['.example', '.sample', '.template']`, applied inside its env arm, so
  // `isCredentialPath('.env.example')` is false and the carve-out survives
  // delegation without a local wrapper. Asserted here rather than assumed,
  // because "the shared module handles it" is the sentence that would be
  // discovered to be wrong by a blocked release.
  it('leaves the conventional example env files alone, as the shared vocabulary does', () => {
    for (const name of ['.env.example', '.env.sample', '.env.template']) {
      expect(isCredentialPath(name), `${name} is exempt in secrets.mjs`).toBe(false);
    }
    expect(
      suspiciousTarballEntries([
        ...PAYLOAD,
        'templates/skeleton/node-service/.env.example',
        'templates/skeleton/aws-serverless/.env.sample',
        '.env.template',
        // The lowercasing must not widen the carve-out either: shouted or not,
        // an example file is still an example file.
        'templates/skeleton/node-service/.ENV.EXAMPLE',
      ]),
    ).toEqual([]);
  });

  // 🔴 And the direction that costs a release rather than a rule, restated
  // against the shared module: it is now the thing deciding, so the payload has
  // to survive ITS judgement too. `.claude/`, `.agents/`, `.github/` and a file
  // literally named `secrets.mjs` all ship in this tarball on purpose — and so
  // does a dotted BASENAME, which the payload above happens not to carry: every
  // dot in it leads a directory, so a filter reading "the basename starts with a
  // dot" would pass that list and still strip half of every skeleton.
  it('leaves the real payload alone once the shared vocabulary is the one deciding', () => {
    const shipped = [
      ...PAYLOAD,
      'templates/agent-os/universal/.claude/scripts/lib/secrets.mjs',
      'templates/skeleton/node-service/.gitignore',
      'templates/agent-os/universal/.codex/config.toml',
    ];
    expect(suspiciousTarballEntries(shipped)).toEqual([]);
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

  // The comparison, not just the expected name. `npm pack --json` reports what
  // it actually wrote, and a mismatch means the bytes about to be published
  // belong to a different version than the manifest the checks above cleared.
  it('clears a tarball named for the version being released', () => {
    expect(tarballNameFindings(expectedTarballName('0.9.0'), '0.9.0')).toEqual([]);
  });

  it('reports a tarball named for another version, naming what it got and what it wanted', () => {
    const findings = tarballNameFindings('create-agent-rig-0.8.0.tgz', '0.9.0');
    expect(findings).toHaveLength(1);
    // Both names, so the owner does not have to reconstruct the expected one to
    // see which half is wrong — the same courtesy the version finding pays.
    expect(findings[0]).toContain('create-agent-rig-0.8.0.tgz');
    expect(findings[0]).toContain('create-agent-rig-0.9.0.tgz');
  });

  // 🔴 What `npm pack --json` gives if its output shape changes: no filename at
  // all. The comparison must read that as a mismatch, never as "nothing to
  // compare" — a silent pass here is the whole check going quiet on the day the
  // tool it reads changes, which is exactly when it is needed.
  it('treats a filename it never got as a mismatch rather than as nothing to check', () => {
    for (const filename of [undefined, '']) {
      const findings = tarballNameFindings(filename, '0.9.0');
      expect(findings, String(filename)).toHaveLength(1);
      expect(findings[0]).toContain('create-agent-rig-0.9.0.tgz');
    }
  });
});

const HEAD_SHA = '1f0c9a4b2d3e5f60718293a4b5c6d7e8f9012345';
const MASTER_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

// 🔴 These four rules decide WHICH BYTES get published, and until now nothing
// tested them. The demonstration is a one-character mutation: inverting
// `head !== remote` to `head === remote`, or dropping the `remote &&` guard,
// leaves the rest of this file green while the preflight prints PASS on any
// branch head — and the owner publishes something that is not the reviewed
// merge commit. That is not a rule failing loudly; it is the check agreeing.
describe('release preflight — the checkout the bytes would be published from', () => {
  it('clears a clean checkout sitting exactly on origin/master', () => {
    expect(gitFindings({ status: '', head: HEAD_SHA, remote: HEAD_SHA })).toEqual([]);
  });

  // Publishing from a dirty tree publishes bytes that are in no commit — nothing
  // reviewed them, and nothing can reconstruct them afterwards.
  it('reports a working tree carrying uncommitted bytes', () => {
    const findings = gitFindings({
      status: ' M scripts/release-preflight.mjs\n?? notes.txt',
      head: HEAD_SHA,
      remote: HEAD_SHA,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/clean/i);
  });

  // 🔴 The pair that must never both fire. When `origin/master` cannot be
  // resolved there is nothing to compare HEAD against, so a head-comparison
  // finding here would name an empty sha and contradict the finding beside it —
  // and a contradictory pair is worse than either alone, because the owner has
  // to decide which of the two the script means. Dropping the `remote &&` guard
  // is what produces it, and the count below is what catches that.
  it('reports an unresolvable origin/master without also comparing HEAD against nothing', () => {
    const findings = gitFindings({ status: '', head: HEAD_SHA, remote: '' });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('origin/master');
    expect(findings[0]).toMatch(/resolv/i);
  });

  // The rule the whole block exists for: publish the merge commit, not a branch
  // head. Both shas are named because "HEAD disagrees" without them tells the
  // owner to go run two git commands to find out how.
  it('reports a HEAD that is not the commit origin/master points at, naming both shas', () => {
    const findings = gitFindings({ status: '', head: HEAD_SHA, remote: MASTER_SHA });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(HEAD_SHA);
    expect(findings[0]).toContain(MASTER_SHA);
  });

  it('names each fault separately when the checkout is wrong in every way', () => {
    const findings = gitFindings({
      status: ' M package.json',
      head: HEAD_SHA,
      remote: MASTER_SHA,
    });
    // A dirty tree and a wrong head are two independent things to fix, and a
    // fault folded into another line is a fault that ships.
    expect(findings).toHaveLength(2);
    expect(new Set(findings).size, 'two findings read identically').toBe(2);
  });
});

// The contract the owner's shell reads, and the only part of `main` that decides
// whether a release stops. `npm publish` is typed by hand after this, so an exit
// code that says 0 while findings were printed is a check that has been running
// green through every one of the faults above.
describe('release preflight — the exit code, which is what actually stops a publish', () => {
  it('exits 0 when there is no finding and 1 when there is any', () => {
    expect(exitCodeFor([])).toBe(0);
    expect(exitCodeFor(['.env would be published'])).toBe(1);
    expect(exitCodeFor(['a', 'b', 'c'])).toBe(1);
  });

  // The two halves of the same answer, pinned together. The report is what the
  // owner reads and the code is what a script reads, and the combination that
  // gets a bad release published is the one where they disagree.
  it('agrees with the report printed above it, in both directions', () => {
    for (const findings of [[], ['one finding'], ['one finding', 'another']]) {
      const passed = /PASS/.test(formatReport(findings));
      expect(passed, `report and exit code disagree for ${findings.length} finding(s)`).toBe(
        exitCodeFor(findings) === 0,
      );
    }
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

  // 🔴 The same shape, for the same reason, on the one value the owner's shell
  // reacts to. `exitCodeFor` is pinned above, but nothing reached the wiring:
  // replacing `main`'s last line with `return 0` left the whole suite green
  // while the preflight exited 0 over a list of findings it had just printed —
  // a measured mutation, not a hypothetical. Running `main` in a test is not
  // the alternative: it would spawn a real `npm pack`, and a check that
  // expensive is a check that gets skipped.
  it('returns exitCodeFor from main rather than a literal the report can contradict', async () => {
    const source = await readFile(script, 'utf8');
    expect(source).toMatch(/return exitCodeFor\(findings\);/);
    expect(source).toMatch(/process\.exit\(main\(\)\)/);
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
