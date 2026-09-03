// The last check before `npm publish`, made mechanical.
//
//   node scripts/release-preflight.mjs
//
// `npm publish` needs 2FA and cannot be undone, so the owner takes the one step
// an agent may not. Until now the only thing standing behind that step was
// prose — CHANGELOG's "Releasing" checklist, restating facts the repository
// already owns: the two manifests, the ledger, the `files` payload. A restated
// fact goes stale, which is the defect class 0.8.0 shipped to remove. This runs
// the checks instead of describing them.
//
// Deliberately phrased as what it LOOKS AT rather than as what it guarantees.
// The limits block below says what it cannot see.
//
// 🔴 IT IS A PREFLIGHT, NOT A GATE. Nothing enforces it: it holds because the
// runbook says to run it, exactly like the reviewer gates in this rulebook. A
// green run means no check below found a fault — never that the release is
// good. `pnpm test`, the reviewer fan-out and CI are the things that decide
// that, and this runs after all of them.
//
// ⚠ The limits, stated rather than implied.
//
//  1. **It cannot tell you the release is correct**, only that six specific
//     mistakes are absent. Every one of them is a mistake this project has
//     actually made or nearly made; none of them is the interesting half of a
//     release.
//  2. **`npm pack` builds.** Reading the payload means running the real pack,
//     which runs `prepare`, which runs `tsc`. That is the point — it inspects
//     the artifact that would ship rather than a description of it — but it is
//     not free and it writes into `packages/cli/dist`.
//  3. **It reads `origin/master` as git already has it.** It does not fetch, so
//     a stale remote ref reads as agreement. Fetch first if that matters.
//  4. **The suspicious-entry list is a denylist**, so it catches the shapes
//     named in `suspiciousTarballEntries` and nothing else. It is not a secret
//     scanner: `node scripts/validate-no-secrets.mjs` is, and it reads tracked
//     files rather than the tarball. The two overlap and neither contains the
//     other.
//  5. **A version absent from the ledger is not proof it is unpublished** — the
//     ledger records where a version was published FROM, and its row is written
//     by the NEXT release. The authoritative answer is
//     `npm view create-agent-rig versions`, which this does not call, because a
//     preflight that fails when the network is down is a preflight nobody runs.
//
// The pure parts are exported and tested; `main` does the reading and hands
// them the results. Pinned in `test/template/release-preflight.test.ts` —
// absent in a generated rig, this being the generator's own script.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The npm package this repository publishes. One name, spelled once. */
const PACKAGE_NAME = 'create-agent-rig';

/**
 * The tree whose presence the git path cannot verify.
 *
 * `npm pack` and `git archive` differ exactly at dotfiles, so a packaging
 * regression drops the rulebook while every git-path test stays green — the
 * scaffolded project installs with no rules and nothing says so.
 */
const RULEBOOK_PAYLOAD_PREFIX = 'templates/agent-os/universal/.claude/';

/**
 * What must never reach a published tarball.
 *
 * 🔴 Written against path SEGMENTS and file NAMES, never against a leading dot.
 * The payload of this package is dotted — `.claude/`, `.agents/`, `.codex/`,
 * `.github/` — so "starts with a dot is suspicious" would strip the thing being
 * shipped, and the tarball would still pack. That direction breaks the release
 * rather than a rule, which is why the test pins it explicitly.
 */
const FORBIDDEN_SEGMENTS = new Set(['node_modules', '.git']);
const FORBIDDEN_NAMES = new Set(['.npmrc', '.DS_Store']);
const FORBIDDEN_SUFFIXES = ['.pem', '.key', '.tgz'];

/**
 * The environment files a real project is SUPPOSED to publish.
 *
 * `templates/skeleton/*` are runnable projects, and an example env file is the
 * ordinary way such a project documents the variables it needs. Flagging one
 * would block a release with a message that is true ("would be published") and
 * wrong.
 *
 * 🔴 Matched on the WHOLE basename, and checked before the `.env.` prefix arm.
 * Written as a prefix — "anything after `.env.` is an example" — it would wave
 * through `.env.local`, which is exactly where a real credential lives and the
 * reason the env arm exists at all. Pinned in
 * `test/template/release-preflight.test.ts` › "still flags the real environment
 * files sitting beside the exempt ones", which asserts both kinds in one list
 * so a widened carve-out shows up as a missing entry.
 *
 * Their CONTENT is not this script's job. `scripts/validate-no-secrets.mjs`
 * reads content, over every tracked file, and would catch a credential pasted
 * into an example.
 */
const ENV_EXAMPLE_NAMES = new Set(['.env.example', '.env.sample', '.env.template']);

const isEnvFile = (name) =>
  !ENV_EXAMPLE_NAMES.has(name) && (name === '.env' || name.startsWith('.env.'));

/**
 * The entries in a packed file list that must not ship.
 *
 * Returns them in the order given, so the report reads in the order the owner
 * would see them in `npm pack`'s own output. One forward pass, no rescanning.
 */
export const suspiciousTarballEntries = (paths) => {
  const offenders = [];
  for (const entry of paths ?? []) {
    const segments = String(entry).split('/');
    const name = segments[segments.length - 1] ?? '';
    const forbidden =
      segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment)) ||
      FORBIDDEN_NAMES.has(name) ||
      isEnvFile(name) ||
      FORBIDDEN_SUFFIXES.some((suffix) => name.endsWith(suffix));
    if (forbidden) offenders.push(entry);
  }
  return offenders;
};

/**
 * The positive half: the payload the git path cannot check is actually there.
 *
 * An empty listing answers the same finding rather than a quieter one — a
 * tarball with no files is the loudest form of "the rulebook did not ship".
 */
export const payloadFindings = (paths) => {
  const present = (paths ?? []).some((entry) => String(entry).includes(RULEBOOK_PAYLOAD_PREFIX));
  return present
    ? []
    : [
        `the tarball carries no file under ${RULEBOOK_PAYLOAD_PREFIX} — ` +
          'a rig scaffolded from it would install with no rulebook',
      ];
};

/**
 * The two manifests, checked against each other and against what publication
 * requires.
 *
 * Each fault is a separate finding: the owner fixes what is named, and a fault
 * folded into another line is a fault that ships.
 */
export const manifestFindings = ({ root: rootManifest, inner }) => {
  const findings = [];

  if (rootManifest?.version !== inner?.version) {
    findings.push(
      `the two manifests disagree about the version: package.json says ${rootManifest?.version} ` +
        `but packages/cli/package.json says ${inner?.version} — release step 3 keeps both in step`,
    );
  }

  // An absent key and an empty object both mean "no dependencies"; a rule that
  // fired on the compliant form is a rule the owner learns to skip past.
  const dependencies = Object.keys(rootManifest?.dependencies ?? {});
  if (dependencies.length > 0) {
    findings.push(
      `the manifest that publishes declares runtime dependencies: ${dependencies.join(', ')} — ` +
        'the zero-dependency bias is what keeps `npx github:…` and the tarball path working',
    );
  }

  if (inner?.private !== true) {
    findings.push(
      'packages/cli/package.json has lost `private: true` — the inner package is never published',
    );
  }

  if (!inner?.scripts?.prepublishOnly) {
    findings.push(
      'packages/cli/package.json has lost its `prepublishOnly` lock — npm 10 ignores `private` ' +
        'on `publish --dry-run`, so the script is the real lock',
    );
  }

  return findings;
};

/**
 * A version the ledger already records is a version already published.
 *
 * Republishing an occupied number is not a retry: it puts different bytes
 * behind a number rigs have already installed from. A `null` row still counts —
 * 0.1.0 is recorded that way on purpose ("published, but the bytes are not
 * recoverable from git"), and reading it as "no row" would wave through a
 * republish of the one version nobody can reconstruct.
 */
export const ledgerFindings = (ledger, version) =>
  Object.prototype.hasOwnProperty.call(ledger ?? {}, version)
    ? [
        `templates/release-ledger.json already has a row for ${version} — ` +
          'that version has been published; a release publishes a version the ledger has never seen',
      ]
    : [];

/** The file `npm pack` writes for a version. */
export const expectedTarballName = (version) => `${PACKAGE_NAME}-${version}.tgz`;

/**
 * The report the owner reads before typing `npm publish`.
 *
 * The passing case says so out loud: "no findings" and "the check never ran"
 * print the same silence otherwise.
 */
export const formatReport = (findings) => {
  if ((findings ?? []).length === 0) {
    return 'release-preflight: PASS — no finding in the checks below. This is not a verdict on the release.';
  }
  const lines = findings.map((finding) => `  - ${finding}`);
  return [`release-preflight: ${findings.length} finding(s) — do not publish yet.`, ...lines].join(
    '\n',
  );
};

const readJson = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));

const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/**
 * The packed file list, from the real `npm pack`.
 *
 * `--json` is asked for so the listing is parsed rather than scraped out of the
 * `npm notice` prose, which is formatting and has changed between npm majors.
 */
const packedPaths = () => {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
  });
  const [packed] = JSON.parse(output);
  return {
    filename: packed?.filename,
    paths: (packed?.files ?? []).map((file) => file.path),
  };
};

function main() {
  const findings = [];

  const rootManifest = readJson('package.json');
  const inner = readJson('packages/cli/package.json');
  const version = rootManifest.version;

  findings.push(...manifestFindings({ root: rootManifest, inner }));
  findings.push(...ledgerFindings(readJson('templates/release-ledger.json'), version));

  // Publishing from a dirty tree publishes bytes that are in no commit, and
  // publishing from an old head publishes something nobody reviewed.
  if (git(['status', '--porcelain']) !== '') {
    findings.push(
      'the working tree is not clean — publish from a checkout whose bytes are all committed',
    );
  }
  const head = git(['rev-parse', 'HEAD']);
  let remote = '';
  try {
    remote = git(['rev-parse', 'origin/master']);
  } catch {
    findings.push('origin/master could not be resolved — cannot confirm HEAD is the merge commit');
  }
  if (remote && head !== remote) {
    findings.push(
      `HEAD is ${head} but origin/master is ${remote} — publish the merge commit, not a branch head`,
    );
  }

  const { filename, paths } = packedPaths();
  findings.push(...payloadFindings(paths));
  const suspicious = suspiciousTarballEntries(paths);
  for (const entry of suspicious) findings.push(`${entry} would be published`);
  if (filename !== expectedTarballName(version)) {
    findings.push(`npm pack produced ${filename}, expected ${expectedTarballName(version)}`);
  }

  console.log(formatReport(findings));
  if (findings.length === 0) {
    console.log(
      `\n  version   ${version}\n  commit    ${head}\n  tarball   ${filename}\n  files     ${paths.length}\n` +
        '\nNext: `npm publish` (2FA), then CHANGELOG "Releasing" step 9 — smoke the REGISTRY artifact.',
    );
  }
  return findings.length === 0 ? 0 : 1;
}

// Run only when executed, never when imported: a test that imports this module
// to check one exported function must not trigger a build or a pack.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
