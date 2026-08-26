#!/usr/bin/env node
// doctor — the harness audits itself (AR-5).
//
//   node .claude/scripts/doctor.mjs                 # the report, ready to paste
//   node .claude/scripts/doctor.mjs --root <dir>    # audit another checkout
//   node .claude/scripts/doctor.mjs --json
//
// One question, asked of every hook this project runs: **does the hook the
// project OWNS have a test beside it?** The three-part pattern in
// `.claude/rules/invariants.md` — a stated rule, a mechanical check, a test for
// the check — is decoration with any part missing, and the part a rig loses
// first is the third: the shipped hooks arrive with their tests in the generator
// that produced them, and the moment one is edited its test is the rig's own.
//
// Ownership is read from `.claude/.rig-manifest.json`, the install manifest the
// generator writes (its `files` map is install-relative path → sha256 of the
// bytes it wrote). It is evidence, and three answers come out of it:
//
//   - `shipped`  — the bytes on disk still hash to the manifest's entry: the
//                  hook is the generator's, tested upstream. Not a finding.
//   - `owned`    — the hash differs, or the manifest has no entry for the file:
//                  authored or edited here, so its test is this project's.
//   - `unknown`  — there is no manifest to read (a pre-0.4.0 rig, or the
//                  generator's own checkout). A hook with a test beside it still
//                  passes — the test is there whoever owns it; one without is
//                  reported `unknown`, never as a pass: "could not look" is not
//                  "it is fine".
//
// The manifest is the only ownership source this script reads. The generator's
// CLI also carries a hash history of every release for manifest-less rigs; it
// lives in the CLI, and a rig script that re-implemented it would be a second
// copy of a table nobody here maintains (`invariants.md`, "one mechanism, one
// implementation"). A rig without a manifest gets `unknown` on every untested
// hook and the advice to run `upgrade`, which writes one.
//
// A test neighbour is `<hook>.test.mjs` in the same directory — the shape
// `.claude/skills/new-invariant/guard-invariant.example.test.mjs` prescribes and
// `node --test` runs. Exemptions are an explicit file list with reasons, in
// `.claude/doctor-exemptions.json` (`{ "<rel path>": "<reason>" }`): an exempt
// hook is reported as `exempt` with its reason, an exemption with no reason is a
// finding, and an exemption naming a file that is not there is a finding too —
// a list that outlives what it exempts is how a check goes quiet by accident.
//
// Scope: every `.mjs` directly in `.claude/hooks/` (not `*.test.mjs`, not
// `lib/`), and every file directly in `.husky/` when that directory exists — a
// husky hook is never in the manifest, so it is `owned` whenever ownership can
// be read at all. When `.husky/` is absent the report says so rather than
// staying silent about a directory it never looked at — the generator's
// `test/template/doctor.test.ts` › "names an absent .husky/ instead of staying
// silent about it" pins the line.
//
// 🔴 What this script does NOT check is printed at the end of every report, the
// same way `preflight.mjs` prints its unchecked items: a script that half-checks
// is only safe while the boundary is visible.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_REL = '.claude/.rig-manifest.json';
export const EXEMPTIONS_REL = '.claude/doctor-exemptions.json';
export const HOOKS_DIR = '.claude/hooks';
export const HUSKY_DIR = '.husky';

/** What this script cannot decide from the file system alone. */
export const UNCHECKED = [
  'that the neighbour test exercises the hook it sits beside — a file named ' +
    '`<hook>.test.mjs` that asserts nothing satisfies this check; run `node --test` on it',
  'that the hook is wired in .claude/settings.json (or .codex/hooks.json) — an ' +
    'unwired hook passes its own test and guards nothing',
  'that a `shipped` hook still matches the rule it enforces — the manifest says ' +
    'the bytes are the generator’s, not that the generator’s rule is this project’s',
];

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * Who owns a hook, from the manifest's evidence.
 *
 * `recorded` is the manifest's hash for the file, `undefined` when the manifest
 * has no entry, and `null` when there is no manifest at all — three inputs that
 * must stay three, because collapsing "no entry" into "no manifest" would read
 * an authored hook as unknowable, and the reverse would read a manifest-less
 * rig's every hook as authored here.
 */
export const ownershipOf = ({ recorded, actual }) => {
  if (recorded === null) return 'unknown';
  if (typeof recorded === 'string' && recorded === actual) return 'shipped';
  return 'owned';
};

/** The test neighbour's path: `guard-x.mjs` → `guard-x.test.mjs`, `pre-commit` → `pre-commit.test.mjs`. */
export const neighbourOf = (rel) => {
  const dir = path.posix.dirname(rel);
  const base = path.posix.basename(rel);
  const stem = base.endsWith('.mjs') ? base.slice(0, -'.mjs'.length) : base;
  return path.posix.join(dir, `${stem}.test.mjs`);
};

/** The same ladder `preflight.mjs` uses: any FAIL stops, any unknown cautions. */
export const verdictOf = (marks) => {
  if (marks.some((mark) => mark === 'FAIL')) return 'STOP';
  if (marks.some((mark) => mark === 'unknown')) return 'CAUTION';
  return 'GO';
};

const reasonOf = (exemptions, rel) => {
  if (!exemptions || typeof exemptions !== 'object' || Array.isArray(exemptions)) return undefined;
  return Object.prototype.hasOwnProperty.call(exemptions, rel) ? exemptions[rel] : undefined;
};

/**
 * The audit, pure: hooks in, marks out. Each hook is `{ rel, ownership,
 * hasTest }`; each result adds `mark` (`pass` | `FAIL` | `unknown` | `exempt`)
 * and a `detail` a reader can act on.
 *
 * Bounded by construction: one pass over the hooks, one over the exemptions.
 */
export const auditHooks = ({ hooks = [], exemptions = {} } = {}) => {
  const seen = new Set();
  const results = [];
  for (const hook of hooks) {
    const { rel, ownership, hasTest } = hook;
    seen.add(rel);
    const reason = reasonOf(exemptions, rel);
    const exempt = reason !== undefined;
    let mark;
    let detail;
    if (exempt && (typeof reason !== 'string' || reason.trim() === '')) {
      mark = 'FAIL';
      detail = `exempted without a reason in ${EXEMPTIONS_REL} — an exemption is a file AND why`;
    } else if (hasTest) {
      mark = 'pass';
      detail =
        ownership === 'shipped'
          ? `test neighbour ${neighbourOf(rel)} (and the generator’s upstream tests)`
          : `test neighbour ${neighbourOf(rel)}`;
    } else if (ownership === 'shipped') {
      mark = 'pass';
      detail = 'unchanged since install — tested upstream, in the generator that produced it';
    } else if (exempt) {
      mark = 'exempt';
      detail = `no test neighbour; exempt — ${reason.trim()}`;
    } else if (ownership === 'owned') {
      mark = 'FAIL';
      detail =
        `owned here (${'edited or authored in this project'}) and no ${neighbourOf(rel)} — ` +
        'copy .claude/skills/new-invariant/guard-invariant.example.test.mjs beside it';
    } else {
      mark = 'unknown';
      detail =
        `no ${MANIFEST_REL} to say who owns it, and no ${neighbourOf(rel)} — ` +
        'not a pass; `upgrade` writes a manifest, or add the test';
    }
    results.push({ rel, ownership, hasTest, mark, detail });
  }
  if (exemptions && typeof exemptions === 'object' && !Array.isArray(exemptions)) {
    for (const rel of Object.keys(exemptions)) {
      if (seen.has(rel)) continue;
      results.push({
        rel,
        ownership: 'absent',
        hasTest: false,
        mark: 'FAIL',
        detail: `stale-exemption: ${EXEMPTIONS_REL} names a file this audit did not find — remove the entry`,
      });
    }
  }
  return { verdict: verdictOf(results.map((r) => r.mark)), hooks: results };
};

// --- the file-system half -----------------------------------------------------

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** The manifest's `files` map, or `null` when there is nothing trustworthy to read. */
export const manifestFilesOf = (root) => {
  const parsed = readJson(path.join(root, ...MANIFEST_REL.split('/')));
  const files = parsed?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) return null;
  return files;
};

const listFiles = (dir) => {
  try {
    return readdirSync(dir)
      .filter((name) => statSync(path.join(dir, name)).isFile())
      .sort();
  } catch {
    return null;
  }
};

/** Every hook in scope, as `{ rel, ownership, hasTest }`, plus the scopes it looked at. */
export const collectHooks = (root) => {
  const files = manifestFilesOf(root);
  const hooks = [];
  const scopes = [];
  const hookNames = listFiles(path.join(root, ...HOOKS_DIR.split('/')));
  scopes.push({ dir: HOOKS_DIR, present: hookNames !== null });
  for (const name of hookNames ?? []) {
    if (!name.endsWith('.mjs') || name.endsWith('.test.mjs')) continue;
    hooks.push(`${HOOKS_DIR}/${name}`);
  }
  const huskyNames = listFiles(path.join(root, HUSKY_DIR));
  scopes.push({ dir: HUSKY_DIR, present: huskyNames !== null });
  for (const name of huskyNames ?? []) {
    if (name.endsWith('.test.mjs')) continue;
    hooks.push(`${HUSKY_DIR}/${name}`);
  }
  return {
    scopes,
    hooks: hooks.map((rel) => {
      const actual = sha256(readFileSync(path.join(root, ...rel.split('/'))));
      const recorded = files === null ? null : files[rel];
      return {
        rel,
        ownership: ownershipOf({ recorded, actual }),
        hasTest: existsSync(path.join(root, ...neighbourOf(rel).split('/'))),
      };
    }),
  };
};

export const report = (root) => {
  const { hooks, scopes } = collectHooks(root);
  const exemptions = readJson(path.join(root, ...EXEMPTIONS_REL.split('/'))) ?? {};
  const audit = auditHooks({ hooks, exemptions });
  const absent = scopes.filter((scope) => !scope.present).map((scope) => scope.dir);
  const lines = [
    `**doctor** — verdict: ${audit.verdict}`,
    '',
    ...audit.hooks.map((hook) => `- ${hook.mark} · ${hook.rel} — ${hook.detail}`),
    ...(absent.length > 0
      ? ['', `_Not present, so not audited: ${absent.join(', ')}._`]
      : []),
    '',
    `_Not checked by this script — still yours (${UNCHECKED.length}):_`,
    ...UNCHECKED.map((item) => `- ${item}`),
  ];
  return { ...audit, scopes, unchecked: UNCHECKED, rendered: lines.join('\n') };
};

const invokedDirectly = () => {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
};

if (invokedDirectly()) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = path.resolve(rootIndex === -1 ? process.cwd() : (args[rootIndex + 1] ?? process.cwd()));
  const result = report(root);
  process.stdout.write(
    args.includes('--json')
      ? `${JSON.stringify({ verdict: result.verdict, hooks: result.hooks, scopes: result.scopes, unchecked: result.unchecked }, null, 2)}\n`
      : `${result.rendered}\n`,
  );
  process.exit(result.verdict === 'STOP' ? 1 : 0);
}
