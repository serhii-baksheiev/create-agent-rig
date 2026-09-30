#!/usr/bin/env node
// PreToolUse hook: in an UNATTENDED run, the rulebook is never edited outside
// the current item's allow-list (AR-51).
//
// The rulebook is the set of files that decide what this session may do — hooks
// and settings wiring, the queue config and selector, all scripts, rules, skills
// and agents, the `.codex/` configuration, the integrity manifest,
// `.claude/doctor-exemptions.json`, the revalidation detection contract
// `.rig/revalidation.json` — but not the claim records beside it under
// `.rig/claims/`, which a SELECT has to write — `AGENTS.md` and `CLAUDE.md`.
// Every one of them was editable by the run it governs: a
// Write to `.claude/hooks/dod-checks.json` with `[]` switched the stop gate
// off, and nothing refused it until the merge sweep, long after.
//
// How it decides — and it is deliberately dumb:
//   1. No unattended flag on disk (`.claude/scripts/unattended-flag.mjs`) → an
//      attended session → exit 0 for everything. A human at the keyboard edits
//      the rulebook on purpose.
//   2. Flag present and readable → every edit fragment whose repo-relative path
//      sits under a rulebook prefix is refused (exit 2) unless it also sits
//      under one of the item's `allow` prefixes. A known path outside the
//      rulebook is never judged — › "allows a MultiEdit beyond the fragment cap
//      when its known path is outside the rulebook". A pathless global refusal
//      for an oversized or unsupported `apply_patch` payload is blocked while
//      armed because its scope cannot be proved — › "states the pathless
//      global-refusal limit for oversized and unsupported apply_patch payloads".
//   3. Flag present and UNREADABLE → a rulebook edit is refused and the reason
//      names the flag; an edit outside the rulebook still passes. Refusing to
//      inspect is not allowing (`.claude/rules/invariants.md`).
//
// Limits — each stated here and, unless it is marked untested, measured in
// the generator's
// `test/template/guard-rulebook.test.ts` (absent in a generated rig), by the
// test named beside it:
//   - it sees one edit at a time, as text, before it lands — a rulebook file
//     rewritten through a Bash redirect (`echo … > .claude/settings.json`), a
//     generated file, or `git checkout` of another branch is not an edit tool
//     call and never reaches it, and `guard-bash` does not cover that either —
//     › "a Bash redirect into the rulebook is not an edit tool call and passes
//     — guard-bash does not cover it either";
//   - the flag in either home arms it (the env-derived one and the password
//     database one, like the kill switch), and ONLY a flag arms it: an
//     exported variable changes nothing, and an attended session that never
//     set a flag is exactly as free as before — › "only a flag arms it — an
//     exported RIG_UNATTENDED=1 with no flag changes nothing";
//   - it judges paths, not content: a README that merely mentions
//     `.claude/hooks/guard-bash.mjs` is not a rulebook edit — › "guards the
//     path, not prose that mentions a guarded path";
//   - it compares both roots and payload paths in their selected and canonical
//     spellings, whether selection came from `CLAUDE_PROJECT_DIR` or the
//     working-directory fallback — › "canonicalizes a differently spelled
//     checkout root before guarding a canonical payload path", › "blocks when
//     the checkout root and payload use the same symlink spelling", and
//     › "blocks an existing rulebook file when only the payload path uses a symlink spelling";
//   - an `apply_patch` destination keeps the lexical spelling it named even when
//     a guarded prefix (`.claude/hooks`, say) is itself a symlink/junction to
//     somewhere else inside the checkout — `edit-input.mjs`'s `repositoryPatchPath`
//     carries that spelling alongside the realpath-resolved one, RP-60 — ›
//     "refuses an apply_patch through a guarded prefix junctioned to a target
//     inside the checkout";
//   - an `allow` prefix is a string prefix of the repo-relative path and may
//     not widen the rulebook — an entry that is itself a prefix of a rulebook
//     prefix (`.`, `.claude/`, `.claude/scripts/`) makes the flag unreadable
//     and the guard refuses — › "a flag whose allow-list widens the rulebook is
//     unreadable, so `--allow .` cannot disarm it";
//   - a miscased payload path is judged against the rulebook's CANONICAL
//     spelling (`unattended-flag.mjs`'s `canonicalRulebookPath`), but an
//     `allow` entry never is — a miscased entry authorizes nothing, including
//     the one prefix deliberately withheld as an allow root
//     (`.claude/scripts/`) and the board selector, refused regardless of case
//     — › "guard-rulebook: an allow-list entry is judged by its literal
//     spelling, not the one the payload folds to (RP-215 round 2)";
//   - fail-open on its own errors and on a payload it cannot parse — › "allows
//     an empty payload object" and › "allows non-JSON stdin" — and fail-closed
//     on a flag it cannot read — › "blocks a rulebook edit when the flag exists
//     but cannot be read, and names the file": the guard targets drift, not an
//     adversary;
//   - a `//`-prefixed normalised path is refused rather than resolved while
//     armed exactly when it does not relativise under any comparison root —
//     a repository root spelled as a plain path can never strip a UNC admin
//     share or a device path with no drive letter (`\\?\Volume{GUID}\…`), but
//     a root that is itself UNC-spelled (`CLAUDE_PROJECT_DIR` as
//     `\\server\share\repo`) strips a payload path genuinely under it, and
//     such a path is judged normally instead — › "guard-rulebook: an
//     unjudgeable UNC/device-namespace path is refused, not silently allowed
//     (RP-244 round 2)" and › "guard-rulebook: a `//`-prefixed path is
//     refused only when it resolves under no repository root (RP-244
//     round 3)". The same refusal covers a MultiEdit past the fragment cap
//     (the `appliesToAll` global refusal) aimed at such a path, not only the
//     ordinary per-fragment case — › "guard-rulebook: a MultiEdit global
//     refusal is not exempt from the `//`-prefix refusal (RP-244 round 3)";
//   - the reverse direction is covered too: when the repository root is
//     itself spelled as a UNC admin share (`\\host\X$\…`), the LOCAL DRIVE
//     spelling of the same file (`X:\…`) is also placed in `comparisonRoots`,
//     from the pure text mapping `canonical-path.mjs` exports as
//     `adminShareDriveSpelling` — › "guard-rulebook: an admin-share-spelled
//     repository root must also recognise the local-drive spelling of the
//     same payload path (RP-246)";
//   - `protectedRelative` judges EVERY spelling a fragment carries — its REAL,
//     resolved location (`canonicalPath`) and both literal spellings
//     (`filePath`, `rawFilePath`) — and returns every one of them that names a
//     rulebook path, never just the first. Neither spelling gets to hide a
//     rulebook match the other one names: a literal spelling under an allowed
//     prefix that resolves, through a symlink, to a DIFFERENT, non-allowed
//     rulebook prefix does not authorize the edit (RP-246 part 2, › "guard-rulebook:
//     a literal spelling under an allowed prefix must not authorize the
//     different rulebook prefix it resolves to (RP-246)"), and — the mirror
//     case round 2 closed — a literal spelling under a NON-allowed prefix that
//     resolves to an ALLOWED one is not hidden by that resolved match either
//     — › "guard-rulebook: a literal spelling outside an allowed prefix is not
//     hidden by a resolved match inside it (RP-246 round 2)". The edit is
//     refused if ANY collected spelling names a rulebook path the item's
//     allow-list does not cover, and the refusal names that one;
//
// The rule it enforces is stated in `.claude/rules/autonomy.md`, "Never".
import { realpathSync } from 'node:fs';
import { adminShareDriveSpelling, canonicalPath } from './lib/canonical-path.mjs';
import { editFragments, pathComponentOverflowFragment } from './lib/edit-input.mjs';
import { RULEBOOK_PREFIXES, canonicalRulebookPath, isRulebookPath, readUnattended } from '../scripts/unattended-flag.mjs';
import { readHookInput } from './lib/hook-input.mjs';

export { RULEBOOK_PREFIXES, isRulebookPath };

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

// RP-247 round 2: `protectedRelative`'s third outcome — `canonicalPath`
// crossed the component bound, so this fragment's real, resolved location is
// unknown. A `Symbol`, not a string or `undefined`, so it can never collide
// with an actual rulebook path or with "never judged".
const COMPONENT_OVERFLOW = Symbol('componentOverflow');

const toPosix = (value) => String(value ?? '').replaceAll('\\', '/');

// RP-54: `.native`, never plain `realpathSync`. Both resolve symlinks and
// normalise separators; only the native one expands a Windows 8.3 short name,
// so `C:\Users\RUNNER~1\…` and `C:\Users\runneradmin\…` otherwise survive as
// two spellings of one directory. The root arrives from
// `git rev-parse --show-toplevel` (long) while a payload path arrives however
// the tool spelled it (short under an 8.3 temp or home), and a root that
// matches no spelling of the payload makes this fail-open guard allow the
// rulebook edit it exists to refuse. Both sites take the same canonicaliser or
// the comparison is between two different normalisations. Measured on Windows
// by codex.test.ts (absent in a generated rig) › "anchors a nested-cwd Windows
// Codex rulebook edit to the canonical repository root".
const canonicalRoot = (root) => {
  try {
    return realpathSync.native(root);
  } catch {
    return root;
  }
};

// RP-247 round 3: `canonicalPath` — resolve symlinks in the nearest existing
// ancestor of a fragment's `filePath`, preserving a missing tail, returning
// `null` (never the raw `filePath`) once the resolved path crosses the
// component bound — now lives in `./lib/canonical-path.mjs`, side-effect
// free so it can be pinned directly, in-process (this file calls
// `process.exit(main())` at module top level, so importing IT in-process
// would kill the test worker). See that module's own docstring for why the
// bound check runs before any `realpath` call, and why round 1's fail-OPEN
// fallback here — returning the raw, unresolved `filePath` past the bound —
// was itself the vulnerability security-scanner found on PR #350: a real
// Win32 junction aliasing `.claude`, and independently a short, ordinary
// `file_path` resolved against a merely deep `cwd`, both bypassed the
// rulebook because `protectedRelative` below reads an unresolved lexical
// spelling as "not under the rulebook" — the REAL, resolved location might
// be, but never gets the chance to say so. `null` is `protectedRelative`'s
// signal to refuse rather than to treat the fragment as harmless.

/** The repo-relative tail of an absolute path, or the path itself when it is not under the root. */
export const relativeTo = (root, filePath) => {
  const dir = toPosix(root).replace(/\/+$/, '');
  const file = toPosix(filePath);
  if (dir !== '' && file.startsWith(`${dir}/`)) return file.slice(dir.length + 1);
  return file.replace(/^\.\//, '');
};

export const isAllowed = (rel, allow) =>
  (Array.isArray(allow) ? allow : []).some((prefix) => prefix !== '' && (rel === prefix || rel.startsWith(prefix)));

// RP-60: `rawFilePath` is the lexical spelling `apply_patch` fragments carry
// alongside the realpath-resolved `filePath` (`edit-input.mjs`,
// `repositoryPatchPath`) — a guarded prefix that is itself a symlink/junction
// to somewhere else inside the checkout resolves away the rulebook spelling
// otherwise, the same way `canonicalRoot`/`comparisonRoots` above seed both
// spellings of the checkout root. Every other edit surface never sets it, so
// this is a no-op for them.
//
// RP-215 round 2: the return value is the CANONICAL rulebook spelling
// (`canonicalRulebookPath`), not the candidate that matched it. `isAllowed`
// and the `.claude/queue.board` carve-out below both compare this result
// against literal allow-list entries, so a miscased entry (`.Claude/`,
// `.claude/Scripts/`) never matches — only the path is canonicalised, never
// the allow-list. See the generator's `test/template/guard-rulebook.test.ts` (absent in a generated rig) ›
// "guard-rulebook: an allow-list entry is judged by its literal spelling,
// not the one the payload folds to (RP-215 round 2)".
//
// RP-247 round 2: a THIRD return value, `COMPONENT_OVERFLOW` — distinct from
// a rulebook path (a string) and from "outside the rulebook, never judged"
// (`undefined`) — for the one case neither of those two readings fits:
// `canonicalPath(filePath)` crossed the component bound, so the REAL,
// resolved location is unknown, and every literal spelling this function
// also tried (`filePath`, `rawFilePath`) failed to name a rulebook path on
// its own. That is not "never judged"; it is "could not be judged", and
// `.claude/rules/invariants.md` reads the two differently: refuse it while
// armed, the same as every other case this file cannot resolve.
//
// RP-246 round 2: neither the REAL, resolved location (`canonical`) nor
// either literal spelling (`filePath`, `rawFilePath`) is allowed to hide a
// rulebook match the other one names — round 1 fixed the direction where a
// harmless-looking literal spelling under an allowed prefix resolved to a
// non-allowed one, but still returned the FIRST rulebook match found
// (canonical first, literals only once canonical named nothing at all), so
// the mirror case slipped through: a literal spelling under a NON-allowed
// prefix that resolves, through a symlink, to an ALLOWED one was read as
// fully authorized, because the allowed resolved match was the only one ever
// returned. So every spelling this fragment carries — at most three
// candidates: `canonical`, `filePath`, `rawFilePath` — is resolved against
// the rulebook independently, and ALL of the rulebook paths any of them names
// are returned, deduplicated, as an array; the caller refuses the edit if ANY
// of them is not covered by the item's allow-list. `canonicalPath` is still
// called at most once per fragment, exactly as before — only the reading of
// its result changed, from "first match wins" to "every match is collected".
// › "guard-rulebook: a literal spelling under an allowed prefix must not
// authorize the different rulebook prefix it resolves to (RP-246)" pins the
// round-1 direction still held; see the generator's `test/template/guard-rulebook.test.ts` (absent in a generated rig) ›
// "guard-rulebook: a literal spelling outside an allowed prefix is not hidden
// by a resolved match inside it (RP-246 round 2)" for the mirror case this
// round closed.
const protectedRelative = (roots, filePath, rawFilePath) => {
  const canonical = canonicalPath(filePath);
  const matches = [];
  if (typeof canonical === 'string' && canonical !== '') {
    for (const root of roots) {
      const rel = canonicalRulebookPath(relativeTo(root, canonical));
      if (rel !== undefined) {
        matches.push(rel);
        break;
      }
    }
  }
  const literalCandidates = [...new Set([filePath, rawFilePath].filter((spelling) => typeof spelling === 'string' && spelling !== ''))]
    .flatMap((spelling) => roots.map((root) => relativeTo(root, spelling)));
  for (const candidate of literalCandidates) {
    const rel = canonicalRulebookPath(candidate);
    if (rel !== undefined && !matches.includes(rel)) matches.push(rel);
  }
  if (matches.length > 0) return matches;
  return canonical === null ? COMPONENT_OVERFLOW : undefined;
};

// RP-244 round 3: a `//`-prefixed normalised path is undecidable ONLY when it
// does not relativise under any comparison root — reusing `relativeTo`, the
// same comparison `protectedRelative` above already makes, rather than a
// second implementation. A UNC-spelled repository root (`CLAUDE_PROJECT_DIR`
// itself a `\\server\share\repo` spelling) maps to the same `//`-prefixed
// shape a payload path under it normalises to, so `relativeTo` CAN strip it —
// and a path that strips cleanly is judged normally, not refused as
// unjudgeable, whether or not it lands inside the rulebook.
const isUnjudgeablePath = (roots, filePath) => {
  if (typeof filePath !== 'string' || !filePath.startsWith('//')) return false;
  const file = toPosix(filePath);
  return !roots.some((root) => relativeTo(root, filePath) !== file);
};

function main() {
  const input = readHookInput();
  if (input === null) return 0; // unparseable payload: not ours to judge
  if (!EDIT_TOOLS.has(input?.tool_name)) return 0;

  const selectedRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = canonicalRoot(selectedRoot);
  // RP-246 part 1: when the checkout root is itself spelled as a Windows
  // admin-share UNC path (`\\host\X$\…`), `canonicalRoot` above never folds
  // it to the local-drive spelling of the same directory — seed that
  // spelling too, mirroring the existing two-spellings pattern for
  // `root`/`selectedRoot`, so a payload path spelled with the local drive
  // still relativises under a comparison root.
  const driveSpellings = [root, selectedRoot]
    .map((candidate) => adminShareDriveSpelling(candidate))
    .filter((value) => value !== undefined);
  const comparisonRoots = [...new Set([root, selectedRoot, ...driveSpellings])];
  const unattendedEnv = { ...process.env, CLAUDE_PROJECT_DIR: root };
  const fragments = editFragments(input);
  const globalRefusal = fragments.find(
    ({ inspectionRefusal, appliesToAll }) => appliesToAll && inspectionRefusal,
  );
  if (globalRefusal) {
    if (globalRefusal.filePath) {
      // No `rawFilePath` argument here: the only `appliesToAll` refusal that
      // carries a non-empty `filePath` at all is the MultiEdit fragment-cap
      // refusal (`edit-input.mjs`), and it never sets `rawFilePath` — so
      // there is nothing a third argument would add for this call site.
      const rel = protectedRelative(comparisonRoots, globalRefusal.filePath);
      if (rel === undefined) {
        // RP-244 round 3: `rel === undefined` used to read as "outside the
        // rulebook, never judged" unconditionally — exactly the reading the
        // per-fragment block below already proved wrong for a `//`-prefixed
        // path that resolves under no comparison root. A global refusal
        // carrying such a path is refused the same way, instead of exiting 0
        // before `isUnjudgeablePath` is ever consulted.
        if (!isUnjudgeablePath(comparisonRoots, globalRefusal.filePath)) return 0;
        const mode = readUnattended(unattendedEnv);
        if (!mode.on) return 0;
        process.stderr.write(
          `BLOCKED — "${globalRefusal.filePath}" could not be resolved against the repository root: ` +
            'a UNC or device-namespace path is refused rather than judged while unattended. ' +
            'Write through the repository path instead.\n',
        );
        return 2;
      }
    }
    const mode = readUnattended(unattendedEnv);
    if (!mode.on) return 0;
    process.stderr.write(
      `BLOCKED — cannot safely inspect this unattended edit: ${globalRefusal.inspectionRefusal}\n` +
        `${globalRefusal.remedy ?? 'Split it into a smaller edit and retry.'}\n`,
    );
    return 2;
  }
  // RP-244 round 2: `normalisePath` (`edit-input.mjs`) maps a UNC or other
  // device-namespace spelling to a `//`-prefixed result — `relativeTo` can
  // only strip a path that starts with the literal repository root, and a
  // `//`-prefixed path never does, on any platform or root. That is not
  // "outside the rulebook": it is undecidable, and undecidable is refused,
  // not allowed, while armed (`.claude/rules/invariants.md`, "The remedy
  // belongs to the refusal"). RP-244 round 3: "does not relativise under any
  // comparison root" replaces the plain `startsWith('//')` check — a
  // UNC-spelled repository root makes a payload path under it decidable, so
  // it is judged normally rather than refused as unjudgeable.
  const unjudgeable = fragments.find(({ filePath }) => isUnjudgeablePath(comparisonRoots, filePath));

  const paths = [];
  let componentOverflow = false;
  for (const { filePath, rawFilePath } of fragments) {
    if (typeof filePath !== 'string' || filePath === '') continue;
    const rel = protectedRelative(comparisonRoots, filePath, rawFilePath);
    if (rel === COMPONENT_OVERFLOW) {
      componentOverflow = true;
      continue;
    }
    // RP-246 round 2: `protectedRelative` now returns EVERY rulebook path any
    // spelling of this fragment names, not just the first — every one of them
    // joins `paths` so the refusal check below sees all of them, not only
    // whichever spelling happened to be tried first.
    if (Array.isArray(rel)) {
      for (const candidate of rel) {
        if (!paths.includes(candidate)) paths.push(candidate);
      }
    }
  }
  // RP-247 round 2: checked before the "nothing under the rulebook" bail-out
  // below — a fragment `canonicalPath` could not resolve within the
  // component bound is not "never judged", the same distinction
  // `protectedRelative` now draws. `.claude/rules/invariants.md`, "Refusing
  // to inspect is not allowing". RP-247 round 3: the message is
  // `pathComponentOverflowFragment()` itself, imported from `edit-input.mjs`,
  // not a hand-written second copy of its wording — one spelling of one
  // refusal, since both report the same bound.
  if (componentOverflow) {
    const mode = readUnattended(unattendedEnv);
    if (!mode.on) return 0; // attended session
    const { inspectionRefusal, remedy } = pathComponentOverflowFragment();
    process.stderr.write(`BLOCKED — cannot safely inspect this unattended edit: ${inspectionRefusal}\n${remedy}\n`);
    return 2;
  }
  if (paths.length === 0 && !unjudgeable) return 0; // nothing under the rulebook: never judged

  const mode = readUnattended(unattendedEnv);
  if (!mode.on) return 0; // attended session

  if (mode.unreadable) {
    // RP-244 round 3: `paths[0] ?? unjudgeable.filePath` used to print "is
    // part of the rulebook" even when `paths` was empty and only an
    // unjudgeable `//`-prefixed path put this branch on the table — a claim
    // this guard never established. An unjudgeable path gets the same
    // "could not be resolved" reason it gets everywhere else in this file.
    const target = paths[0];
    if (target === undefined) {
      process.stderr.write(
        `BLOCKED — "${unjudgeable.filePath}" could not be resolved against the repository root, ` +
          `and the unattended flag at ${mode.path} is unreadable (${mode.why}). ` +
          'Refusing to inspect is not allowing: fix it, or clear this checkout with `node .claude/scripts/unattended-flag.mjs off --root "$PWD"`, then retry.\n',
      );
      return 2;
    }
    process.stderr.write(
      `BLOCKED — "${target}" is part of the rulebook and the unattended flag at ${mode.path} is unreadable (${mode.why}). ` +
        'Refusing to inspect is not allowing: fix it, or clear this checkout with `node .claude/scripts/unattended-flag.mjs off --root "$PWD"`, then retry.\n',
    );
    return 2;
  }

  if (unjudgeable) {
    process.stderr.write(
      `BLOCKED — "${unjudgeable.filePath}" could not be resolved against the repository root: ` +
        'a UNC or device-namespace path is refused rather than judged while unattended. ' +
        'Write through the repository path instead.\n',
    );
    return 2;
  }

  const refused = paths.filter(
    (rel) => rel === '.claude/queue.board' || !isAllowed(rel, mode.allow),
  );
  if (refused.length === 0) return 0;
  if (refused[0] === '.claude/queue.board') {
    process.stderr.write(
      'BLOCKED — ".claude/queue.board" is the checkout board selector and cannot be changed while unattended, even through an item allow-list. ' +
        'Disarm unattended mode before deliberately switching queues.\n',
    );
    return 2;
  }
  process.stderr.write(
    `BLOCKED — "${refused[0]}" is part of the rulebook, and an unattended run never edits the rulebook outside its item's allow-list ` +
      `(item ${mode.item ?? '(none)'}; allowed prefixes: ${mode.allow.length === 0 ? 'none' : mode.allow.join(', ')}). ` +
      'If the item really needs this path, it belongs in the allow-list the loop wrote at claim time — a decision, not a default. ' +
      'See .claude/rules/autonomy.md, "Never".\n',
  );
  return 2;
}

try {
  process.exit(main());
} catch {
  process.exit(0); // a crashed guard must not block the session
}
