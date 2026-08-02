// Rebuild `templates/hash-history.json` from the git tags — run at release,
// never edited by hand.
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

/**
 * Released versions, oldest first: `vX.Y.Z` tags **below** the version being
 * prepared. The current version is excluded on purpose — it has not shipped,
 * so nobody can have its files on disk, and a tag left over from an abandoned
 * release attempt must not be read as a release that happened.
 */
function releasedTags(currentVersion) {
  const tags = git(['tag', '--list', 'v*'])
    .stdout.toString()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^v\d+\.\d+\.\d+$/.test(line))
    .map((tag) => ({ tag, version: tag.slice(1) }))
    .filter(({ version }) => compareVersions(version, currentVersion) < 0);
  return tags.sort((a, b) => compareVersions(a.version, b.version));
}

/** sha256 of every agent-os blob at one tag, keyed by install-relative path. */
function hashesAt(tag) {
  const listing = git(['ls-tree', '-r', tag, '--', AGENT_OS]).stdout.toString();
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

function main() {
  const currentVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const tags = releasedTags(currentVersion);
  const history = buildHistory(tags.map(({ tag, version }) => ({ version, files: hashesAt(tag) })));
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
