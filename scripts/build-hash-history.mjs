// Rebuild `templates/hash-history.json` from the release ledger — run at
// release, never edited by hand.
//
// The ledger is `templates/release-ledger.json`: `"X.Y.Z": "<commit>"`, the
// commit each version was PUBLISHED from (`npm view create-agent-rig@X.Y.Z
// gitHead`), or `null` where the published bytes are not recoverable from git
// and the version deliberately gets no row. Releases here ship untagged (the
// owner publishes by hand — CHANGELOG.md, "Releasing"), so a tag is neither
// required nor trusted: one that exists and disagrees with the ledger is
// printed as a warning and changes nothing (AR-35).
//
// Rigs installed before 0.4.0 carry no manifest, so `upgrade` cannot ask them
// what they installed. This table is the answer instead: the hashes every
// agent-os file had in every *released* version. A file matching one of them
// was not edited and is safe to replace; anything else is the user's and is
// reported rather than written.
//
// Hand-maintaining such a table would make it lie in the one direction that
// costs something — claiming a file is untouched when somebody changed it —
// so it is generated, and a template test fails when it falls behind.
//
// Usage: node scripts/build-hash-history.mjs
// Fails loudly, exit 1, when a CHANGELOG release below the version being
// prepared has no ledger entry — the message names the version and the command
// that answers it. It never drops a version silently.
// It is idempotent, so "did somebody forget to run it" is answered by running
// it and looking at `git status` — there is no second implementation of that
// question to disagree with this one.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(root, 'templates', 'hash-history.json');
const LEDGER = path.join(root, 'templates', 'release-ledger.json');
const CHANGELOG = path.join(root, 'CHANGELOG.md');
const CANDIDATES = path.join(root, 'scripts', 'release-candidates.json');
const AGENT_OS = 'templates/agent-os';

/**
 * The path a template file installs to, or `null` for files that are tooling
 * metadata rather than payload (`layers.json` is `init`'s own manifest).
 *
 * The layer a file came from is deliberately dropped: `universal/CLAUDE.md`
 * and `init/CLAUDE.md` both land at `CLAUDE.md`, and the question this table
 * answers is only ever "has this path ever held these bytes".
 */
export function installRelPath(repoPath) {
  const rest = repoPath.startsWith(`${AGENT_OS}/`) ? repoPath.slice(AGENT_OS.length + 1) : null;
  if (rest === null) return null;
  const stripped = rest.startsWith('stack/')
    ? rest.split('/').slice(2).join('/')
    : rest.split('/').slice(1).join('/');
  if (stripped === '' || stripped === 'layers.json') return null;
  return stripped;
}

/**
 * `[{version, files: {rel: hash}}]` (oldest first) → the shipped table.
 *
 * Each path carries its deduplicated hashes **and the oldest release that had
 * it**. The second field is what lets an upgrade keep a deletion on a rig with
 * no manifest: a path present in every release the table covers is gone
 * because somebody removed it, while a path added later is simply missing from
 * an older rig and still has to be delivered.
 */
export function buildHistory(perVersion) {
  const files = {};
  for (const { version, files: hashes } of perVersion) {
    for (const [rel, hash] of Object.entries(hashes)) {
      const entry = (files[rel] ??= { since: version, hashes: [] });
      if (!entry.hashes.includes(hash)) entry.hashes.push(hash);
    }
  }
  const sorted = {};
  for (const rel of Object.keys(files).sort()) sorted[rel] = files[rel];
  return { versions: perVersion.map((v) => v.version), files: sorted };
}

const compareVersions = (a, b) => {
  const parse = (v) => v.split('.').map((n) => Number.parseInt(n, 10));
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
};

const git = (args, options = {}) => {
  const result = spawnSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.toString() ?? ''}`);
  }
  return result;
};

const VERSION = /^\d+\.\d+\.\d+$/;
const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Released versions, oldest first, each with the commit it was published from:
 * every CHANGELOG release **below** the version being prepared, resolved through
 * the ledger. The current version is excluded on purpose — it has not shipped,
 * so nobody can have its files on disk, and a ledger entry written ahead of a
 * release must not be read as a release that happened.
 *
 * A `null` ledger value is an explicit decision — "published bytes not
 * recoverable, no row" — and is excluded. An ABSENT entry is the forgotten
 * step, and it throws naming the version and the command that answers it:
 * dropping the version would leave `upgrade` unable to recognise that release,
 * which is exactly the silent failure the table exists to prevent.
 */
export function releasedFromLedger(ledger, currentVersion, changelogVersions) {
  for (const [key, value] of Object.entries(ledger)) {
    if (!VERSION.test(key))
      throw new Error(`release-ledger.json: "${key}" is not a version (X.Y.Z)`);
    if (value !== null && !(typeof value === 'string' && COMMIT.test(value))) {
      throw new Error(
        `release-ledger.json: ${key} must be a 40-character lowercase commit sha or null`,
      );
    }
  }
  const released = [];
  for (const version of changelogVersions) {
    if (compareVersions(version, currentVersion) >= 0) continue;
    if (!(version in ledger)) {
      throw new Error(
        `release-ledger.json has no entry for ${version}, which CHANGELOG.md lists as released. ` +
          `Record the commit it was published from: npm view create-agent-rig@${version} gitHead ` +
          '(or null if its published bytes are not recoverable).',
      );
    }
    if (ledger[version] === null) continue;
    released.push({ version, commit: ledger[version] });
  }
  return released.sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * `vX.Y.Z` tags whose commit is not the ledger's for X.Y.Z — `{ version, tag:
 * <the tag's commit>, ledger: <the ledger's> }`. A warning source only: the
 * table is built from the ledger, and a tag — this repository has one that
 * points at the wrong release — changes nothing.
 */
export function tagDisagreements(ledger, tags) {
  const out = [];
  for (const [tag, sha] of Object.entries(tags)) {
    const version = tag.slice(1);
    if (!/^v\d+\.\d+\.\d+$/.test(tag) || !(version in ledger)) continue;
    const expected = ledger[version];
    if (expected !== null && expected !== sha) out.push({ version, tag: sha, ledger: expected });
  }
  return out;
}

/** `{ "vX.Y.Z": "<commit>" }` for every version tag in the repository. */
function versionTags() {
  const tags = {};
  for (const line of git(['tag', '--list', 'v*']).stdout.toString().split('\n')) {
    const tag = line.trim();
    // `^{commit}` so an annotated tag resolves to the commit, not the tag object
    if (/^v\d+\.\d+\.\d+$/.test(tag)) {
      tags[tag] = git(['rev-parse', `${tag}^{commit}`])
        .stdout.toString()
        .trim();
    }
  }
  return tags;
}

/**
 * `## X.Y.Z` headings in `markdown`, in file order — exact only. Anchored at
 * both ends, so `## X.Y.Z (release candidate)` (RP-353: an accepted but
 * unpublished release candidate, frozen while master moves on) is correctly
 * excluded: it is not a released version, and forcing one into this table
 * would demand a ledger row before the bytes it names have actually shipped.
 */
export function parseChangelogVersions(markdown) {
  return [...markdown.matchAll(/^## (\d+\.\d+\.\d+)$/gm)].map((m) => m[1]);
}

/**
 * Throws when `markdown` carries a `## X.Y.Z (release candidate)` heading for
 * any version OTHER than `currentVersion` — exact only, the same spelling
 * `parseChangelogVersions` excludes. Such a heading is correct for exactly one
 * version: the one currently being prepared. For any other version it can only
 * mean either of two things:
 *
 *   - that version published and nobody reconciled its heading back to the
 *     plain `## X.Y.Z` form afterwards — left alone, `parseChangelogVersions`
 *     quietly drops that version from "released" forever, and it never gets a
 *     ledger row or a hash-history entry; or
 *   - (RP-349) it is a verified, still-frozen, unpublished release-candidate
 *     baseline from `scripts/release-candidates.json` (`baselines`) — allowed
 *     through only while `ledger` still has no row for it. Once a ledger row
 *     exists the candidate has published and the heading is exactly the
 *     forgotten-reconciliation case above.
 *
 * Silent for the current version's own pending candidate heading, and silent
 * when there is no candidate heading at all.
 */
export function assertCandidateHeadingsAreCurrent(
  markdown,
  currentVersion,
  { baselines = {}, ledger = {} } = {},
) {
  for (const match of String(markdown).matchAll(/^## (\d+\.\d+\.\d+) \(release candidate\)$/gm)) {
    const version = match[1];
    if (version === currentVersion) continue;
    const base =
      `CHANGELOG.md still has "## ${version} (release candidate)" but ${currentVersion} is ` +
      'the version being prepared';
    if (version in baselines && !(version in ledger)) continue;
    if (version in baselines) {
      // recorded AND published — the baseline exemption no longer applies
      throw new Error(
        `${base} — ${version} has published, so reconcile its heading to the plain ` +
          `"## ${version}" form`,
      );
    }
    throw new Error(
      `${base} — ${version} is not recorded in scripts/release-candidates.json. If it has ` +
        `published, reconcile its heading to the plain "## ${version}" form; if it is a ` +
        'still-frozen, unpublished release-candidate baseline, record its commit there instead.',
    );
  }
}

/**
 * RP-349: the exact ref a frozen, unpublished release-candidate branch must
 * resolve through. Shared with `scripts/release-preflight.mjs`'s own frozen
 * mode so the spelling exists once.
 */
export function candidateRefName(version) {
  return `refs/remotes/origin/release/${version}-rc`;
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * Pure findings (empty = ok) over a `scripts/release-candidates.json` record.
 *
 * Every entry is validated to be a well-formed `X.Y.Z` key below
 * `currentVersion` with a 40-hex-lowercase sha value — regardless of ledger
 * state. A version that already has a ledger row is historical: its facts are
 * not consulted (the ledger is authoritative for it, see
 * `candidateLedgerDisagreements`), which is also why `facts` need not carry an
 * entry for it. Otherwise `facts[version]` — gathered from git by `main` —
 * must show the exact `candidateRefName(version)` ref still resolving to the
 * recorded sha, that commit's `package.json` carrying exactly `version`, and
 * that commit being an ancestor of HEAD.
 */
export function candidateBaselineFindings(record, { ledger, currentVersion, facts }) {
  const findings = [];
  for (const [version, sha] of Object.entries(record)) {
    if (!VERSION.test(version)) {
      findings.push(`scripts/release-candidates.json: "${version}" is not a version (X.Y.Z)`);
      continue;
    }
    if (typeof sha !== 'string' || !SHA.test(sha)) {
      findings.push(
        `scripts/release-candidates.json: ${version} must be a 40-character lowercase commit sha`,
      );
      continue;
    }
    if (compareVersions(version, currentVersion) >= 0) {
      findings.push(
        `scripts/release-candidates.json: ${version} is not below the version being prepared ` +
          `(${currentVersion})`,
      );
      continue;
    }
    if (version in ledger) continue; // published — the candidate is historical, git unconsulted

    const ref = candidateRefName(version);
    const fact = facts[version];
    if (!fact || fact.refSha !== sha) {
      findings.push(
        fact && fact.refSha
          ? `${ref} is ${fact.refSha} but scripts/release-candidates.json records ${sha} for ` +
              version
          : `${ref} could not be resolved — cannot verify the frozen baseline for ${version}`,
      );
      continue;
    }
    if (fact.packageVersion !== version) {
      findings.push(
        `${ref}'s package.json is version ${fact.packageVersion ?? 'unknown'}, not ${version}`,
      );
      continue;
    }
    if (!fact.isAncestor) {
      findings.push(`${sha} (${version}) is not an ancestor of HEAD`);
    }
  }
  return findings;
}

/**
 * A recorded baseline whose ledger row (once the version actually publishes)
 * disagrees with the frozen RC sha — `ledger: null` counts as a disagreement
 * too, since "no gitHead recoverable" also disagrees with "this is the exact
 * sha it was built from". A version with no ledger row yet is simply not
 * published — not a disagreement, nothing to compare.
 */
export function candidateLedgerDisagreements(ledger, record) {
  const out = [];
  for (const [version, sha] of Object.entries(record)) {
    if (!(version in ledger)) continue;
    const ledgerValue = ledger[version];
    if (ledgerValue !== sha) out.push({ version, ledger: ledgerValue, candidate: sha });
  }
  return out;
}

/** sha256 of every agent-os blob at one commit, keyed by install-relative path. */
function hashesAt(commit) {
  const listing = git(['ls-tree', '-r', commit, '--', AGENT_OS]).stdout.toString();
  const blobs = [];
  for (const line of listing.split('\n')) {
    // Regular files only: mode 120000 is also a `blob`, and `copyTree` never
    // copies a symlink, so hashing one would put a path in the table that no
    // install can ever produce.
    const match = /^(?:100644|100755) blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (match === null) continue;
    const rel = installRelPath(match[2]);
    if (rel !== null) blobs.push({ sha: match[1], rel });
  }
  if (blobs.length === 0) return {};

  // One `cat-file --batch` rather than one `git show` per file: the batch
  // protocol is `<sha> blob <size>\n<content>\n`, read by the size it states.
  const batch = git(['cat-file', '--batch'], { input: `${blobs.map((b) => b.sha).join('\n')}\n` });
  const buffer = batch.stdout;
  const files = {};
  let offset = 0;
  for (const blob of blobs) {
    const headerEnd = buffer.indexOf(0x0a, offset);
    if (headerEnd === -1) throw new Error(`cat-file: truncated output at ${blob.rel}`);
    const header = buffer.subarray(offset, headerEnd).toString('utf8');
    const size = Number.parseInt(header.split(' ')[2] ?? '', 10);
    if (!Number.isFinite(size)) throw new Error(`cat-file: unreadable header "${header}"`);
    const start = headerEnd + 1;
    files[blob.rel] = createHash('sha256')
      .update(buffer.subarray(start, start + size))
      .digest('hex');
    offset = start + size + 1;
  }
  return files;
}

/** `{}` for a missing file — an unpopulated `scripts/release-candidates.json` is normal. */
function readCandidatesRecord() {
  try {
    return JSON.parse(readFileSync(CANDIDATES, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw error;
  }
}

/**
 * The three git facts `candidateBaselineFindings` verifies a recorded baseline
 * against, for one `version`/`sha` pair. Each is read as git already has it
 * — no fetch — the same stance `release-preflight.mjs` takes for its own
 * frozen-candidate ref.
 */
function gatherCandidateFacts(version, sha) {
  const refResult = spawnSync(
    'git',
    ['show-ref', '--verify', '--hash', candidateRefName(version)],
    {
      cwd: root,
    },
  );
  const refSha = refResult.status === 0 ? refResult.stdout.toString().trim() : null;

  const pkgResult = spawnSync('git', ['show', `${sha}:package.json`], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  });
  let packageVersion = null;
  if (pkgResult.status === 0) {
    try {
      packageVersion = JSON.parse(pkgResult.stdout.toString()).version ?? null;
    } catch {
      packageVersion = null;
    }
  }

  const ancestorResult = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], {
    cwd: root,
  });
  if (ancestorResult.status !== 0 && ancestorResult.status !== 1) {
    throw new Error(
      `git merge-base --is-ancestor ${sha} HEAD failed: ${ancestorResult.stderr?.toString() ?? ''}`,
    );
  }
  const isAncestor = ancestorResult.status === 0;

  return { refSha, packageVersion, isAncestor };
}

function main() {
  const currentVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
  const changelog = readFileSync(CHANGELOG, 'utf8');
  const candidates = readCandidatesRecord();

  const disagreements = candidateLedgerDisagreements(ledger, candidates);
  if (disagreements.length > 0) {
    for (const { version, ledger: ledgerSha, candidate } of disagreements) {
      process.stderr.write(
        `scripts/release-candidates.json: ${version} was frozen at ${candidate} but the ` +
          `ledger's published commit is ${ledgerSha ?? 'null'} — reconcile before continuing\n`,
      );
    }
    return 1;
  }

  const facts = {};
  for (const [version, sha] of Object.entries(candidates)) {
    if (version in ledger) continue; // historical; not re-checked
    facts[version] = gatherCandidateFacts(version, sha);
  }

  let released;
  try {
    const findings = candidateBaselineFindings(candidates, { ledger, currentVersion, facts });
    if (findings.length > 0) throw new Error(findings.join('\n'));
    assertCandidateHeadingsAreCurrent(changelog, currentVersion, { baselines: candidates, ledger });
    released = releasedFromLedger(ledger, currentVersion, parseChangelogVersions(changelog));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  for (const { version, tag, ledger: expected } of tagDisagreements(ledger, versionTags())) {
    process.stderr.write(
      `warning: tag v${version} points at ${tag.slice(0, 7)}, not at the commit ${version} ` +
        `was published from (${expected.slice(0, 7)}); the tag is not consulted\n`,
    );
  }
  const history = buildHistory(
    released.map(({ version, commit }) => ({ version, files: hashesAt(commit) })),
  );
  const rendered = `${JSON.stringify(history, null, 2)}\n`;
  writeFileSync(OUTPUT, rendered);
  process.stdout.write(
    `wrote ${path.relative(root, OUTPUT)}: ${Object.keys(history.files).length} paths ` +
      `across ${history.versions.join(', ') || 'no released versions'}\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
