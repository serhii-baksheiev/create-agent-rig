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
// 🔴 IT IS A PREFLIGHT, NOT A GATE. Nothing runs it: no hook fires it and no CI
// job invokes it. It holds only because `CHANGELOG.md`'s "Releasing" step 8 and
// `docs/releasing.md` tell the owner to. A green run means no check below found
// a fault — never that the release is good. `pnpm test`, the reviewer fan-out
// and CI are what decide that, and this runs after all of them.
//
// 🔴 WHAT IT CHECKS IS THE CODE BELOW, and this header states no count of them
// on purpose. An earlier draft said "six specific mistakes" while the code
// emitted eleven findings — the same stale second copy of a fact that
// `.claude/rules/autonomy.md` carried about `guard-secret-file` for four
// releases, reproduced inside the change written to remove it. A corrected
// number would only restart that clock. Read the exported functions, or run it.
//
// ⚠ The limits, stated rather than implied.
//
//  1. **It cannot tell you the release is correct**, only that the specific
//     mistakes below are absent. Every one of them is a mistake this project
//     has made or nearly made; none is the interesting half of a release.
//  2. **`npm pack` builds.** Reading the payload means running the real pack,
//     which runs `prepare`, which runs `tsc`. That is the point — it inspects
//     the artifact that would ship rather than a description of it — but it is
//     not free and it writes into `packages/cli/dist`.
//  3. **It reads `origin/master` as git already has it.** It does not fetch, so
//     a stale remote ref reads as agreement. Fetch first if that matters.
//  4. **It asks about NAMES, never content.** The credential question is
//     delegated to `isCredentialPath` in `.claude/scripts/lib/secrets.mjs` — the
//     same module `guard-secret-file` and `validate-no-secrets.mjs` read, so the
//     vocabulary has one spelling rather than three. A credential inside a file
//     with an innocent name is invisible here; `validate-no-secrets.mjs` is the
//     one that reads content, over TRACKED files. Neither set contains the
//     other: the tarball carries `packages/cli/dist`, which is built and
//     untracked, and the sweep reads `.claude/`, `test/` and `docs/`, which
//     `files` never packs.
//  5. **A version absent from the ledger is not proof it is unpublished** — the
//     ledger records where a version was published FROM, and its row is written
//     by the NEXT release. The authoritative answer is
//     `npm view create-agent-rig versions`, which this does not call, because a
//     preflight that fails when the network is down is a preflight nobody runs.
//
// The pure parts are exported and tested; `main` reads the world and hands them
// the results. Pinned in `test/template/release-preflight.test.ts` — absent in a
// generated rig, this being the generator's own script.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// One spelling of the credential vocabulary, imported rather than restated.
// `.claude/rules/invariants.md`: "One mechanism, one implementation. And one
// spelling of a fact… the copy nobody is looking at is the one that is wrong."
// A first draft of this file re-listed those names and was already weaker on the
// day it landed — it missed `.envrc`, `id_rsa`, `.netrc`, `.pgpass`, the
// `secrets/` segment arm, every uppercase spelling and every backslash path.
// The dynamic form is how `scripts/validate-no-secrets.mjs` reaches the same
// module from this directory.
const { isCredentialPath } = await import(
  pathToFileURL(path.join(here, '..', '.claude', 'scripts', 'lib', 'secrets.mjs')).href
);

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
 * The junk arms — the ones about a TARBALL rather than about credentials.
 *
 * These stay local because they are not credential vocabulary, and the shared
 * module rightly says nothing about them: a `node_modules` tree, a `.git`
 * directory, a previous pack left lying around, a Finder artifact. Each doubles
 * the published size or ships stale bytes under a fresh version.
 *
 * 🔴 Written against path SEGMENTS and file NAMES, never against a leading dot.
 * The payload of this package is dotted — `.claude/`, `.agents/`, `.codex/`,
 * `.github/` — so "starts with a dot is suspicious" would strip the thing being
 * shipped, and the tarball would still pack. That direction breaks the release
 * rather than a rule, which is why the test pins it explicitly.
 */
const JUNK_SEGMENTS = new Set(['node_modules', '.git']);
const JUNK_NAMES = new Set(['.DS_Store']);
const JUNK_SUFFIXES = ['.tgz'];

/**
 * The entries in a packed file list that must not ship.
 *
 * Returns them in the order given, so the report reads in the order the owner
 * would see them in `npm pack`'s own output. One forward pass, no rescanning.
 *
 * The credential half is `isCredentialPath`'s answer, which already lowercases
 * every segment and normalises `\` to `/` — so `.ENV`, `.Env.local` and
 * `templates\skeleton\.env` are caught here without this file knowing why. It
 * also already exempts the documented placeholder forms (`.env.example`,
 * `.env.sample`, `.env.template`), which a real skeleton is supposed to ship.
 */
export const suspiciousTarballEntries = (paths) => {
  const offenders = [];
  for (const entry of paths ?? []) {
    const text = String(entry);
    const segments = text.replaceAll('\\', '/').split('/');
    const name = segments[segments.length - 1] ?? '';
    const junk =
      segments.some((segment) => JUNK_SEGMENTS.has(segment)) ||
      JUNK_NAMES.has(name) ||
      JUNK_SUFFIXES.some((suffix) => name.endsWith(suffix));
    if (junk || isCredentialPath(text)) offenders.push(entry);
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

/**
 * The checkout the publish would run from.
 *
 * `status` is `git status --porcelain` (empty means clean), `head` and `remote`
 * are shas, and `remote` is `''` when `origin/master` could not be resolved.
 *
 * 🔴 The `remote` guard is load-bearing in both directions. Dropping it reports
 * a mismatch against nothing on top of the unresolvable finding — two lines for
 * one fault, the second naming a comparison nobody made. Inverting the
 * comparison is worse: the preflight then passes on any branch head and the
 * owner publishes bytes that are not the reviewed merge commit. Both mutations
 * are pinned by the finding COUNT rather than by wording, in
 * `test/template/release-preflight.test.ts`.
 *
 * `--porcelain` counts untracked files deliberately: `npm pack` reads the
 * working directory rather than the index, so an untracked file under
 * `templates/` ships.
 */
export const gitFindings = ({ status, head, remote }) => {
  const findings = [];

  if (String(status ?? '') !== '') {
    findings.push(
      'the working tree is not clean — publish from a checkout whose bytes are all committed, ' +
        'since npm pack reads the working directory and not the index',
    );
  }

  if (!remote) {
    findings.push(
      'origin/master could not be resolved — cannot confirm HEAD is the merge commit that was reviewed',
    );
  } else if (head !== remote) {
    findings.push(
      `HEAD is ${head} but origin/master is ${remote} — publish the merge commit, not a branch head`,
    );
  }

  return findings;
};

/** The file `npm pack` writes for a version. */
export const expectedTarballName = (version) => `${PACKAGE_NAME}-${version}.tgz`;

/**
 * The tarball npm actually produced, against the one this version should make.
 *
 * A missing filename is a mismatch rather than nothing to check: `npm pack
 * --json` changing shape would otherwise read as agreement, which is the
 * failure mode of every check that treats absence as a pass.
 */
export const tarballNameFindings = (filename, version) => {
  const expected = expectedTarballName(version);
  return filename === expected
    ? []
    : [`npm pack produced ${filename || '(no filename)'}, expected ${expected}`];
};

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

/**
 * The one value the owner's shell reacts to.
 *
 * Exported so it is pinned beside the report rather than left as a ternary
 * inside `main`, where no test could reach it: a preflight whose exit code
 * disagrees with its printed verdict is worse than one that prints nothing.
 */
export const exitCodeFor = (findings) => ((findings ?? []).length === 0 ? 0 : 1);

const readJson = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));

const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/**
 * The packed file list, from the real `npm pack`.
 *
 * `--json` is asked for so the listing is parsed rather than scraped out of the
 * `npm notice` prose, which is formatting and has changed between npm majors.
 *
 * `shell` on win32 because `npm` is a `.cmd` shim there, which `execFile`
 * cannot run without one; the argv is three literal words with nothing
 * interpolated, so the shell adds no parsing risk. Same construct and the same
 * reasoning as `test/template/packaging.test.ts`.
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

  const head = git(['rev-parse', 'HEAD']);
  let remote = '';
  try {
    remote = git(['rev-parse', 'origin/master']);
  } catch {
    // Left as '' — `gitFindings` reports it, and reports it once.
  }
  findings.push(...gitFindings({ status: git(['status', '--porcelain']), head, remote }));

  const { filename, paths } = packedPaths();
  findings.push(...payloadFindings(paths));
  for (const entry of suspiciousTarballEntries(paths)) findings.push(`${entry} would be published`);
  findings.push(...tarballNameFindings(filename, version));

  console.log(formatReport(findings));
  if (findings.length === 0) {
    console.log(
      `\n  version   ${version}\n  commit    ${head}\n  tarball   ${filename}\n  files     ${paths.length}\n` +
        '\nNext: `npm publish` (2FA), then CHANGELOG "Releasing" step 9 — smoke the REGISTRY artifact.',
    );
  }
  return exitCodeFor(findings);
}

// Run only when executed, never when imported: a test that imports this module
// to check one exported function must not trigger a build or a pack.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
