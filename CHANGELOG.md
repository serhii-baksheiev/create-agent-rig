# Changelog

Notable changes per release. The generated projects are the product, so an entry
says what a **newly scaffolded project** gains or loses — not what moved inside
the generator.

Versions are published to npm as [`create-agent-rig`](https://www.npmjs.com/package/create-agent-rig);
`npx github:serhii-baksheiev/create-agent-rig` keeps working for either path.

Numbering is ordinary semver — **additive is a minor, a fix is a patch** — so
that "I only take minors" remains a usable policy; 0.3.2 shipped additive
content as a patch by the owner's call and stays recorded as one. 0.8.0 is the
second recorded departure; its own entry states the direction and the reason,
and this paragraph deliberately does not restate them — a numbering rule with
two copies of its exceptions is the shape 0.8.0 exists to remove.

## Unreleased

`setup apply` and `setup remove` manage explicitly selected Figma and Atlassian
MCP configuration through Claude Code's documented project config. Dry-run and
consent apply before changes; existing user entries are preserved. Receipts
record configuration separately from authorization, which the user completes
with the provider. Codex setup remains guided. An old unsupported declaration
does not activate when its provider becomes available: run `setup add` first.

**`AGENTS.md` is now the canonical rulebook; `CLAUDE.md` is a short
compatibility shim.** A new project gets the full rulebook text in
`AGENTS.md` and a `CLAUDE.md` that is just an `@AGENTS.md` import (Claude
Code's own import syntax) plus Claude-Code-specific notes — never a second
copy of the rulebook. This is not a claim that Claude Code always reads
`AGENTS.md` on its own: that support is version- and configuration-dependent,
and the shim exists precisely for the sessions where it is not active (see
`docs/decisions/agents-md-canonical.md` for what is verified and what is
not). Provider-specific wiring (`.claude/settings.json`, `.claude/agents/`,
`.codex/hooks.json`, `.codex/config.toml`) is unaffected.

Migrating an existing rig: `upgrade` treats both files as the ordinary
manifest-tracked paths they always were, with one deliberate coupling. An
untouched pair is replaced with the new shim/canonical split. A `CLAUDE.md`
or `AGENTS.md` the user edited is reported as a conflict and kept exactly as
edited, never force-shimmed or overwritten — and if the kept CLAUDE.md is not
already the `@AGENTS.md` shim, the reason also says it **shadows AGENTS.md**
(by Claude Code's own default, a `CLAUDE.md` is read _instead of_ `AGENTS.md`,
not alongside it) and names the fix. A file the user deleted stays deleted.
**Security fix, content-based since round 5:** CLAUDE.md is held back —
kept as its old, still-readable content, never replaced with the shim —
only when the on-disk AGENTS.md genuinely cannot serve as the rulebook:
absent, or present but carrying no non-empty `elevated-paths` block. A
CUSTOMISED AGENTS.md that still carries a readable block lets the shim
through — the shim then imports the user's own rulebook, which is the whole
point of it — and AGENTS.md itself stays a perfectly ordinary, quiet
conflict, because a customised `elevated-paths` block is this project's own
designed steady state, not a broken rulebook (an earlier version of this
rule keyed on AGENTS.md's verdict alone, which could not tell the two
apart). Without the hold at all, an unreadable AGENTS.md combined with an
untouched CLAUDE.md would silently install a shim over a rulebook that may
carry no `elevated-paths` declaration at all. Holding CLAUDE.md back
re-vouches it for its own current bytes — the same mechanism that lets a
later `upgrade` resolve cleanly — which means a later `uninstall` reads it
as rig-owned and unedited and **removes it**, not "leaves it in place" the
way an ordinary, never-vouched conflict does; the decision record's
uninstall column and a dedicated test cover this.

The one always-reachable remedy for a genuinely unreadable AGENTS.md:
`upgrade` WRITES the already-rendered content to a real sibling file,
`AGENTS.md.rig-new` (never recorded in the manifest, and appearing ONLY in
the genuinely held-back state — never for an ordinary, readable conflict),
instead of printing it to stdout for a verbatim paste — measured (gate cycle
3, round 3's own remedy) not to survive a real copy-paste byte-for-byte. Its
status (`would-write` / `identical` / `differs` / `unsafe`) is decided
entirely at plan time, so a dry run and a real run agree, and a symlink or
directory at the path is refused BEFORE anything else is written. `mv
AGENTS.md.rig-new AGENTS.md` is printed only for bytes this run wrote or
verified — for a pre-existing, differing rescue file the remedy is `rm` (or
restoring AGENTS.md some other way), never `mv`, since that file is not this
run's bytes. The instruction is the short, delimited, LAST thing the run
prints, not buried between the plan and the consent prompt. Once AGENTS.md
resolves and the rig is no longer held back, a leftover matching rescue file
is cleaned up and the run says so; unrelated clutter at the path (a stray
directory or symlink) on an otherwise healthy rig is never touched and never
mentioned. **Round 4, security disclosure:** `uninstall` removing CLAUDE.md
or AGENTS.md while the other of the pair is not a clean removal now says so,
naming which file stays and as what — a bare `- CLAUDE.md` line previously
did not. See `docs/decisions/agents-md-canonical.md`, "The remedy that
actually works", for what was measured and what did not work.

Pinned by `packages/cli/test/upgrade.test.ts`'s describe block "RP-186:
AGENTS.md becomes canonical, CLAUDE.md becomes its shim" (untouched pair,
edited/deleted each side, the shadow-note cases, the held-back cases, the
rescue-file state machine, the held-back uninstall case, and the re-derived
4×3 pristine/edited-with-block/edited-without-block/deleted grid across both
files), `packages/cli/test/uninstall.test.ts`'s pair-disclosure and
rescue-file tests, `packages/cli/test/cli-report.test.ts`'s CLI-boundary
tests for the rescue file (an independent oracle, never `plan.contents`) and
for the quiet, customised-AGENTS.md conflict, and
`test/e2e/agents-md-migration.test.ts` (the same migration, including the
rescue-file remedy end to end and the customised-rulebook case, against a
rig built from the actual pre-RP-186 payload).

**Breaking: the application skeletons are removed, exactly as 0.9.0
announced.** `create <dir>` no longer takes `--target` and no longer
scaffolds `aws-serverless` or `node-service` — there is one payload, the same
one `init` installs, and `create` is now a thin wrapper: `mkdir` → `git init`
→ that install → the pristine baseline commit. The product is a package
manager for repository-scoped Claude Code and Codex configuration, never an
application generator (owner ruling, 2026-09-13). The universal layer's
create-only "architecture group" (`.claude/rules/architecture.md`,
`guard-core-purity`, `guard-web-boundary`, and the monorepo-shaped
`CLAUDE.md`/`AGENTS.md` map) is retired along with it — it was an
application-shape promise a harness configurator has no business making.
`templates/agent-os/stack/*` (the node-ts and aws-cdk overlays) and
`templates/agent-os/init/*` (the override layer `init` used to shadow
`universal` with) are deleted; the init flavour's map and process-only scope
_is_ the universal layer now.

Migration for a repository this tool already generated: nothing breaks.
`upgrade` still recognises your rig, still refreshes the files it installed
and you did not touch, and still leaves your application code alone — it was
never part of any install set, before or after this release. A path from a
retired layer (an aws-cdk or node-ts rule, an architecture hook) gets a new
verdict, `retired`: never written, never deleted, dropped from the manifest,
and reported as no longer shipped — it is yours now. `upgrade`'s `--dry-run`
output and its summary line both show a `retired` count when there is one.
The full pre-0.10 migration path is pinned in `test/e2e/upgrade.test.ts` ›
"retires the deleted stack overlay, and preserves the application and the
process layer".

**Fixed: Codex rejected the `SessionStart` rules refresh.** `inject-rules`
printed plain text opening with `[agent-os]`, and Codex 0.154.0 was measured
failing the hook with `hook returned invalid session start JSON output`, so
that session started without the autonomy rules. The hook now prints one JSON object —
`hookSpecificOutput.additionalContext`, the shape both harnesses document —
carrying the same text, character for character, that Claude Code received
before. It also waits for that write to finish instead of exiting over it,
and a stdout failure other than an abandoned reader is reported on stderr
with a non-zero exit rather than looking like a healthy session
(`docs/decisions/session-start-wire-format.md`). That decision record now
ships with the hook that cites it — the process layer's manifest
(`layers.json`) had omitted it, so a generated rig received the hook's
citation but not the file it pointed at.

**Breaking: the workflow layer (queue/loop/pr-ship/run-state/journal/
revalidation/claim-records/PR-lifecycle helpers) is now an experimental,
opt-in install (RP-180).** A default `init`/`create` installs Lean Core only
— rules, gates, stop rules, the review-gate agents and their hooks — and
never the autonomous, cooperative multi-session machinery on top of it. Pass
`--layer workflow` to `init` or to `create-agent-rig <dir>` to install it too;
a rig that already has it keeps it on a plain re-run of `init` with no flag.
`RigManifest` gains a `layers` field recording the choice, and `upgrade`
refreshes only the layer(s) a rig recorded. Migration for an existing rig:
nothing breaks and nothing is deleted — a manifest written before this field
existed carries no `layers` key, and that absence is read as "every layer,"
exactly what every release before this one installed, so `upgrade` keeps
managing the workflow files a rig already has. Revalidation and claim-records
keep their existing behavior unchanged (RP-53's freeze through the RP-26 gate
on 2026-10-27) — this release only relocates their install-time layer.
`uninstall` (RP-181) needs no layer awareness of its own: it walks
`manifest.files` and `manifest.kept` directly, and those two records already
reflect exactly what a given install wrote, by construction — a Core-only
rig's manifest simply has no workflow-layer entries in `files` for
`uninstall` to find, and an inherited pre-0.10 rig's workflow files are
recorded in `files` exactly as every other installed path is (its manifest
carries no `layers` key, read as "every layer" the same way `upgrade` reads
it), so `uninstall` removes them under the same byte-hash check as anything
else it owns. Nothing about the layer split widens or narrows what
`uninstall` was already willing to remove.

**This repository's own node-ts conventions move out of the shipped
package**, into `scripts/dogfood/` — a repo-local overlay `sync-agent-os.mjs`
composes into this repository's own rulebook, same as before, just no longer
a template any generated rig receives.

### Added

- **`setup list | add | verify` (RP-22)**, alongside the existing
  `setup --memory-root …` (unchanged). `list [--json]` prints the closed,
  release-owned integrations registry — id, capability, mode, licence or
  terms, source, and each harness's route and automation — read-only.
  `add <id> [--required] [--version <pin>] [--dry-run] [--json]` validates
  `<id>` against that registry and creates or updates its entry in the
  committed `.rig/integrations.json`, through `resolveWritableInside` with
  sorted, stable bytes; a flag left off a later call keeps the value an
  earlier call recorded rather than dropping it, and it installs nothing.
  `verify [--only <id>] [--json]` is read-only and classifies every declared
  integration against what can currently be observed, exiting 1 when a
  required one is not installed (or the declaration itself does not parse)
  and 0 otherwise. `add` never prunes a declaration entry the current
  registry rejects — it is preserved as the same JSON value (not necessarily
  the same original formatting), named together with its
  rejection reason in both `--json` and prose, so declaring a provider ahead
  of its own slice landing survives every later `add` for a different id.
  Every filesystem read on this surface (the declaration, a receipt, the
  receipts directory) is symlink-safe and size-bounded, and the receipts scan
  is capped with an explicit signal when the cap is hit. No route adapter
  exists yet at this release — every harness of every declared integration
  reads `unverified` — so this is the command surface and the
  declaration/receipt file formats, not yet a working installer for any
  provider (`docs/command-contract.md`, "## setup integrations (RP-22)").
- **`uninstall [dir] [--dry-run] [--yes] [--json]`** removes what a rig
  installed, file by file, against the evidence `.claude/.rig-manifest.json`
  carries and nothing else: a path is removed only when its bytes on disk
  still match the recorded hash exactly (compared as raw bytes, never a
  UTF-8-decoded string — ADR-RP-003), the path is a plain file the whole way
  down from the repository root (never a symlinked ancestor or a symlink
  itself), and the path is itself one of the EXACT paths this release
  actually installs — a boundary drawn at a top-level directory would let a
  manifest pair almost any path under `.claude/`, `.rig/`, `docs/` or
  `journal/` with its true hash and have it removed. Anything under `.git` is
  refused outright, for the whole run, for any segment that NORMALISES to
  `.git` (case folded, a Windows alternate-data-stream suffix stripped,
  trailing dots and spaces stripped) at any depth — not only a literal
  top-level `.git` — regardless of the hash a manifest pairs it with; the same
  refusal covers a manifest that lists one path under both `files` and
  `kept`, which this tool's own writer never produces. An edited,
  already-deleted, foreign, `init`-kept, or otherwise unrecognised file is
  reported and left in place, and so is modified hook wiring
  (`.claude/settings.json`, `.codex/hooks.json`), which names the hooks still
  referenced — and so is a hook file such wiring still calls, even when that
  hook file's own bytes are pristine, naming the wiring file that holds it, so
  a kept settings file is never left pointing at a hook `uninstall` just
  deleted. The manifest itself is read, and later removed, through the same
  symlink-safe per-segment check every other manifest-owned path gets, never
  a plain lexical one. It prints the plan, then asks before removing anything
  — `--yes` up front, a prompt on a terminal, an outright refusal off one, and
  always required with `--json`, which never prompts, never deletes
  unattended, and reports an unplanned filesystem error (not only its own
  refusals) as the same one JSON object rather than a bare stack trace. The
  manifest is deleted last, and only once nothing was preserved: a CRLF
  checkout, an edit, or any other conflict keeps the manifest even after
  every removal that WAS planned succeeded, because the rig still owns bytes
  it did not remove and the manifest is the only record naming them. A run
  interrupted partway also keeps it and reports what finished and what a
  re-run still owes — including the manifest itself, whenever a clean re-run
  really would go on to delete it — so a repeat run is safe, and a repeat run
  that finds no manifest at all is a no-op, exit 0. `.rig/` itself is never
  removed, empty or not; the one manifest-owned file the rig installs
  directly inside it is removed like any other file when it is pristine.
  `--json` prints one JSON object and nothing else on stdout — `removed` is
  always what was actually deleted, and `planned` carries the plan's own
  answer regardless of outcome — documented next to the other command
  contracts in `docs/command-contract.md` ("## uninstall (RP-181)"). A
  successful removal names its own next step (`git add -A` and a commit) —
  `uninstall` never touches git history itself. Removing plugin/MCP
  registrations this rig owns is deferred to RP-179/RP-22 (RP-181).
- **`uninstall` re-verifies bytes twice more, and gains `--detach`.** A plan
  can go stale in the window a confirmation prompt sits in: each `remove`
  action now carries the plan's own recorded hash, re-read and compared
  immediately before that one file's removal — a mismatch skips that file
  (reported `preserved`, reason "changed since planning"), never aborts the
  run, and never deletes it. The manifest's own bytes are checked the same
  way at two points: once before the first removal (a mismatch refuses the
  whole apply, nothing removed) and once immediately before the manifest's
  own deletion (a mismatch keeps the manifest and reports an honest partial
  result — what finished, and that the manifest is what a re-run still owes).
  `--json`'s payload now names which of three outcomes a completed,
  non-dry-run reached — `uninstalled`, `partial`, `detached`; a `--dry-run`
  preview names none of them, since it has no end state to name — and folds
  any
  changed-since-planning path into `preserved` rather than a separate,
  easy-to-miss list. **`--detach`** performs the identical safe cleanup and
  then removes the manifest anyway, leaving every preserved (or
  changed-since-planning) path for the user and printing the complete
  handover list — it never forces away a conflicting or modified file, and
  there is no `--force`. A hook file a wiring file still calls survives even
  when that protection is only discoverable at apply time — a symlinked
  wiring file (whose referenced hooks cannot be safely read, so every owned
  hook is protected instead of a guessed subset) or one edited inside the
  confirmation-prompt window, re-checked immediately before the first hook
  removal, since hook files sort ahead of the wiring that references them.
  **Protection also now follows a hook's own imports to a fixed point**: a
  wired hook is not self-contained (`guard-bash.mjs` imports
  `.claude/hooks/lib/hook-input.mjs`, `.claude/scripts/stop-flag.mjs`,
  `.claude/scripts/lib/shell-tools.mjs`, …), and protecting only the
  directly-named hook while deleting what it imports left every one of
  those dying at module resolution with exit 1 — silently inert, since a
  `PreToolUse` hook that exits non-2 is non-blocking. Every REAL read this
  walk performs is gated by the same symlink-safe check every other read in
  this command gets, not the purely lexical containment alone: a hook file
  swapped for a symlink to an unbounded or blocking special file — reachable
  from nothing worse than `git clone`ing a hostile branch, before consent —
  no longer makes the walk's own read hang or exhaust the heap; the file
  stays protected regardless, since that is recorded before the read is
  attempted. A `kept` wiring file (a pre-existing `.claude/settings.json`
  `init` never took ownership of — the ordinary "starts from an existing
  repository" path) now protects its hooks too: it used to protect NONE of
  them, silently, because the pass that decides this read only `files`'
  hashes and a `kept` path has none. **The reason a protected hook reports
  now names WHY its wiring file survives, not only THAT it does** — a `kept`
  wiring file's hook used to say "which was preserved as edited" too, which
  is false (nobody edited it; the rig never wrote it), and told a
  contradictory story two lines apart from `.claude/settings.json`'s own
  "user-owned (kept by init)" verdict in the same report. It now reads
  "which init found already in place and never took ownership of"; a hook
  whose wiring file could not be safely read at all (itself a symlink) now
  says so ("which could not be safely read…") instead of "edited" too. A
  file reached only through another protected file's own import, rather
  than named by the wiring file directly, now gets its own reason wording
  naming the immediate importer, since the wiring file itself may never
  mention it at all. **A hook file that cannot itself be safely read (a
  symlink) now protects the conservative superset of every owned `.mjs`
  path, not only itself.** Two dependencies in the shipped tree have exactly
  ONE hook that imports them — `.claude/scripts/lib/secrets.mjs` (only
  `guard-secret-file.mjs`) and `.claude/scripts/unattended-flag.mjs` (only
  `guard-rulebook.mjs`) — so symlinking that one seeder used to drop the
  dependency's protection entirely: measured end to end through a real
  `git commit` and a fresh `git clone`, the credential guard went from
  blocking a credential write (exit 2) to dying at module resolution (exit 1,
  non-blocking for `PreToolUse`) once its own import was gone, wiring still
  in place and still claiming to enforce it. **The sweep that protects a
  dependency it could not trace now says so, instead of claiming it as a
  confirmed reference.** Reusing the "still referenced by … which was
  preserved as edited" wording for a swept-in path made the sentence that
  sounds most certain describe the files the command was least sure about:
  in one reproduced run, of 84 owned paths under one preserved wiring file,
  only ~7 were genuinely referenced by it, and ~30 were swept in by caution
  alone — including a test fixture no hook could ever import — all reported
  with the identical, fully-confident wording. A fifth reason string now
  names the file whose own unreadability triggered the sweep instead
  ("protected because `<file>` could not be read…"), and the plain-text
  summary adds a one-line roll-up — how many `preserved` paths were
  genuinely traced versus kept only as a precaution — once any are.
  Which wording a hook gets does not depend on where the unreadable file
  sits in the wiring file's own order: a hook the wiring names, or one a
  readable file imports, is reported as referenced or imported whether the
  precaution sweep ran before or after the command reached it. The sweep
  itself is also
  now narrower: it fires on a file that could not be SAFELY READ, never on one that is simply gone. Sweeping on absence bought
  nothing (an absent file has no imports that can fail to resolve, because
  the module that would make them is itself gone) and cost a real one: an
  ordinary "I turned this hook off by hand" deletion, with the wiring still
  naming it, used to turn 83 planned removals into 40 planned / 43
  preserved on a repository that had done nothing hostile at all. Two other
  apply-time-only fixes in the same area: the removal loop now re-reads a
  wiring file's bytes fresh, immediately before that file's own removal,
  instead of reusing a copy `protectedHooksFor` read before the loop even
  started (an edit landing in that window was previously missed); and a
  filesystem error surfacing from the new apply-time hook-protection re-check
  itself is now caught the same way `planUninstall`'s own errors are, so
  `--json` still gets its one promised object rather than a bare stack trace.
  A manifest key with more path segments than any real path this release ever
  installs no longer reaches the native path-join call that segment count
  could otherwise overflow — reported the same honest, per-path `preserved`
  way any other unowned path is (deeper than any path this release could ever
  own), rather than aborting the whole run, `--dry-run` included, through a
  message that used to claim the path "resolves outside" the repository,
  which was simply false for one that never left it lexically at all; the
  genuine `..`/absolute escape check is unweakened and still aborts the whole
  run exactly as before.
  Every ancestor check now makes two independent tests per segment, not one:
  the existing symlink/type classification, and a separate `realpath`
  containment check that does not read that classification at all — the
  second is what makes the containment guarantee hold for a Windows
  directory junction (or any future reparse-point kind) by construction,
  rather than resting on `isSymbolicLink()` reporting it correctly, which is
  the one part of this that a Windows-only test in the `windows-e2e` lane
  (`packages/cli/test/uninstall.test.ts`, gated by `onlyOnWindows`) actually
  measures — this repository's own development environment cannot build a
  junction to verify it directly. Also: a manifest segment with a very long
  run of trailing dots or spaces no longer costs quadratic time to
  normalise (a hostile committed manifest could otherwise hang
  `uninstall --dry-run`); `rigOwnedPaths` reads the bare install-manifest
  list rather than rendering every template's content just to learn which
  paths exist.

### Generator (not a rig-facing change)

**Generator-only (RP-178): nothing a newly scaffolded project receives changes.**
No file under `templates/` moved. This entry records what changed inside the
generator's own repository, ahead of 0.10.0.

- **The speculative policy-declaration library and its benchmark are gone.**
  `packages/cli/src/policy/` (a declaration schema, registry, decision-record
  format and per-harness adapters, RP-36/RP-76) and
  `scripts/policy-benchmark*.mjs` (the child-process benchmark that measured
  it) shipped nothing a CLI command, an installed hook, or the sync scripts
  ever called — its own module header said so. Removed as dead code, along
  with `contracts/session-messaging/` (its sole remaining consumer) and the
  vitest `benchmark` project. RP-157, RP-160 and RP-161 are closed by
  deletion rather than by fix, since all three findings were against this
  unreachable surface; the consumer graph behind each deletion is on pull
  request #227.
- **`docs/compatibility.md`** replaces the removed framework's claim to be a
  compatibility check: a Claude Code × Codex × capability matrix — every
  wired hook, the Windows command strings, skills/agents delivery, and the
  optional external-subsystem contract — with one status vocabulary for the
  matrix (SUPPORTED, DEGRADED, UNSUPPORTED, NOT-APPLICABLE, UNVERIFIED).
  `test/template/compatibility-matrix.test.ts` refuses a status outside it,
  a measured status without a test pointer, and a pointer whose test file is
  gone or no longer contains the quoted test name. Windows is stated as
  measured: the Claude Code wiring and most Codex `commandWindows` scripts
  are UNVERIFIED there.
- **`test/template/guard-acceptance.test.ts`** invokes the retained
  `PreToolUse` guards through the real `.claude/settings.json` /
  `.codex/hooks.json` wiring strings on POSIX, with one allowed and one
  denied fixture per guard for each harness that wires it, in the payload
  shape that harness sends (Codex edits arrive as `apply_patch`); the denied
  one must exit exactly 2 and name its reason. It is the wiring a generated
  project actually runs, not a parallel path. The guard list is derived from
  the two wiring files, so a newly wired guard with no fixture and no
  reasoned exception fails the suite, and so does one without a
  `docs/compatibility.md` row. `guard-subagent-model` is Claude-only and
  runs through the Claude Code wiring alone.
- **Meta-tests that pinned shape instead of behaviour were removed or cut
  down to the assertion that survives review as real**, each with its own
  reason recorded in the pull request: a citation count nothing rereads
  (RP-82, `generator-neutrality.test.ts`), an exact skip-site count that
  named the deleted benchmark files, and the project-count/ordering
  assertions that named the deleted `benchmark` vitest project.
- **RP-110: the CI spawn-baseline diagnostic is removed** from the
  `windows-smoke` job. It measured bare `node` startup, which stayed flat
  across a red run and its green rerun while their wall clocks differed by
  roughly half, so it read "healthy" on the run it was built to diagnose — a
  diagnostic that argues against the correct conclusion is worse than none.
  No replacement baseline was added, per the ticket's own accepted
  resolution.

## 0.9.1

**A patch, numbered by the owner.** Every entry corrects existing behaviour;
two of them (RP-182, RP-59) do it by recording or reporting something new.
Nothing is added to what `create`, `init` or `upgrade` install beyond the
corrected files, the contract version stays `1.0`, and the application
skeletons remain deprecated and scheduled for removal in 0.10.0 exactly as
0.9.0 announced.

### Fixed

- **`init` records the files it kept.** When `init` finds a payload path
  already present and leaves it alone, the manifest now records that file's
  hash under `kept`, so a later `upgrade` can say whether the file is
  unchanged or edited since `init` found it instead of reporting it with no
  history (RP-182). A manifest with nothing kept is written exactly as
  before.
- **`memory load` passes Memory a deadline of its own.** A `load` that names
  no `--timeout-ms` gets `--timeout-ms 45000` appended, below the rig's 60 s
  kill. A well-formed `--timeout-ms <value>` pair raises that kill to the
  value plus 15 s when that is above 60 s, capped at Node's timer limit of
  2 147 483 647 ms; any other spelling passes through unchanged. `doctor`'s
  arguments are untouched. The README example adds `--cwd .`, which the Memory
  owner names as part of Memory's own contract (RP-183).
- **`reconcile-external-prs.mjs` works on a `gh` that does not serve
  `authorAssociation`** from `gh pr list`: the association is fetched
  separately and kept only when it answers for the same pull request, and a
  failed lookup leaves those pull requests untrusted rather than failing the
  sweep. A failure now names the one cause the evidence shows, with terminal
  control sequences and credential shapes removed from the detail (RP-99).
- **The queue reports a Blocks link the ticket body says was removed but the
  tracker still carries** — a body line of the form
  `The Blocks link A -> B is removed` — as a `link-contradicted-by-body`
  hygiene finding (RP-59).
- **A Jira triage proposal with a long `change` is filed, not refused by the
  tracker.** Jira rejects a summary over 255 characters; the summary is now
  cut to fit and the full text stays in the description (RP-121).

### Generator CI (not a rig-facing change)

Test-fixture cleanup goes through one bounded-retry helper, and an audit holds
every other recursive removal and every in-repository fixture to a written
reason. The four child-process time bounds are measured inside the child, and
the package-manager CLI-start cases carry their own measured budget. The e2e
installs run in a vitest group of their own, so they no longer compete with
the template tests on the Windows full-suite runner (RP-158).

## 0.9.0

**The harness ↔ Memory boundary is executable, and the rig is a consumer of
Memory rather than a host for it.** The CLI gains a `setup --memory-root
<checkout>` command that records the Memory executable in a machine-scoped
subsystem manifest after a `--version --json` handshake, and a `memory
<doctor|load>` command that runs the registered executable through that
handshake and refuses a foreign contract major with exit 4 before any verb
runs; the CLI itself answers `--version --json` with its name, version and
contract version. These are commands of the tool, not files in a project: the
manifest is machine-scoped and nothing Memory-related is added to what
`create`, `init` or `upgrade` write into a project. None of this puts
Memory code inside the rig: the executable is spawned across a process
boundary and only its handshake is parsed (`docs/command-contract.md`, "The
version handshake"; `docs/decisions/memory-rig-boundary.md`).

**Deprecated: the application skeletons.** `create <dir> [--target <name>]`
still scaffolds `aws-serverless` and `node-service` in this release, unchanged, and they are
**scheduled for removal in 0.10.0**. The product boundary the owner fixed on
2026-09-13 is a package manager for repository-scoped Claude Code and Codex
configuration — `init` into an existing repository, `upgrade`, `doctor`, the
Memory handshake — and application scaffolding is outside it. Take `init` for
a new project's rig; a skeleton generated today is yours and stays yours, but
`upgrade` will not carry skeleton files forward once they are gone.

**Numbered a minor by the rule at the top of this file**: two new commands and
a new payload are additive.

### Added

- **`setup --memory-root <checkout> [--memory-ref <sha>] [--dry-run]`** and the
  machine subsystem manifest it writes (`~/.config/create-agent-rig/subsystems.json`,
  `%APPDATA%` on Windows) — RP-147. `upgrade` re-runs the same derivation when a
  manifest exists, so `installedVersion` follows the executable the root holds.
- **`memory <doctor|load> [args…]`** through the registered executable, with the
  handshake first and Memory's answer passed through unchanged; `--version
--json` on the rig bin — RP-19. Exit codes on that surface: 0 unsupported /
  absent, 1 integration-failed, 2 invalid invocation, 3 prerequisite unmet, 4
  foreign contract major.
- **Role-specific subagent routing** in the payload: one routing table
  (`templates/agent-os/subagent-routing.json`) pins each reviewer's model and
  effort for both harnesses; the Claude agent specs carry the pins, the Codex
  profiles are derived from the same table, and two Claude Code hooks —
  `guard-subagent-model` (refuses a call-site `model` override on a pinned
  reviewer) and `warn-subagent-routing` (says so at session start when an
  effort override is in force) — are wired in `.claude/settings.json`
  (RP-166, RP-173; `docs/decisions/subagent-routing.md`).
- **`preflight` fails on an unreadable configured queue** instead of selecting
  from nothing (RP-56).
- **Concurrent sessions on one machine** — the ruling on what shared state
  they may touch, and a bounded rename retry so a Windows gate-round counter
  is not lost to a transient lock (RP-120; `docs/decisions/concurrent-sessions.md`).
- **A mechanical release preflight**, `node scripts/release-preflight.mjs`,
  for the step the owner types by hand (`docs/releasing.md`).
- **The Rig-side conformance runner** for the Memory boundary,
  `scripts/memory-conformance.mjs --from <checkout> --json`, and the contract
  schemas under `contracts/conformance/v1/` (RP-13) — generator repository
  only, never delivered to a rig; the authoritative cross-repository run lives
  in the private Memory repository and checks this one out at an exact SHA.
- **The policy benchmark** (`docs/policy-benchmark.md`, RP-111): adapter-process
  evidence for both harnesses on an immutable snapshot of the tree. It remains
  in 0.9.0; whether it stays is a 0.10.0 decision.

### Fixed

- **`edit-input`** — an unreadable `tool_input` is a refusal on every edit
  surface, never a clean edit (RP-85); a widening `--allow` entry no longer
  leaves an unattended run with no flag on disk, and the `loop` skill verifies
  the flag armed instead of trusting that it did (RP-103).
- **Capability coverage** — the policy capability contract names exactly what
  the code covers, and the two silent passes it had are closed (RP-36); policy
  validators read own-and-enumerable record fields (RP-153).
- **Windows** — the node-service skeleton's static-dir tests use a native file
  URL (RP-168); the e2e harness spawns package managers and file checks on
  Windows (RP-169); the one PowerShell case carries its own measured budget
  (RP-162); the benchmark's guard-spawning cases are classified UNVERIFIABLE
  on the hosted Windows image rather than reported green on nothing (RP-111),
  and the Windows governance fixtures are set up under a bound that names the
  stage that timed out (RP-172).
- **Repository scans skip sibling worktrees** under `.claude/worktrees/`, so a
  second checkout is no longer reported as this one's drift (RP-155).

### Generator CI (not a rig-facing change)

The pull-request path runs on GitHub-hosted runners only: in `ci.yml`, `ci`
and the two template checks on Linux and `windows-smoke` (the CLI's unit
project) on Windows; in `e2e.yml`, the Linux `e2e` job — the full suite with
the e2e installs and the benchmark — when the pull request touches the CLI,
the templates, the e2e harness or that workflow. The full suite on Windows
runs in `e2e.yml` on master, nightly and by dispatch only, and a
`runner_mode` switch there selects a self-hosted fallback that no pull
request can reach (`docs/runners.md`).

## 0.8.0

**Three stale second copies, spread over three payload files a rig obeys,
described the mechanisms behind them wrongly — and each fix is a deletion.** A
count and a path list, both in `.claude/rules/autonomy.md`, and a paraphrase of
that same path list in `loop/SKILL.md`, which ships in both harnesses' copies.
Every one of them was a second writing of a fact the code owns, and every one
had drifted from its source while the suite stayed green.

**The `templates/agent-os/` payload gains no file and loses none**, measured
tarball to tarball — `npm pack create-agent-rig@0.7.1` unpacked, against this
release's own `npm pack`. That payload is the same 95 files either way, and
exactly three of them differ in content. ⚠ The tarball as a whole is **not**
unchanged: it grows by eleven files, and the section below names which and why.

**Numbered a minor by the owner's call, not by this file's rule.** The rule at
the top — additive is a minor, a fix is a patch — makes this delta a patch,
because nothing is added to what a project installs. It ships as `0.8.0`
because the owner's milestone of that name closes here and the number was fixed
before the delta was measured. Recorded rather than reconciled, the way `0.3.2`
is recorded above: a consumer on "I only take minors" receives three corrected
documents and no new capability.

### Fixed

- **`.claude/rules/autonomy.md` stated a blind-spot count `guard-secret-file`
  had outgrown.** The Never bullet said the guard's header "states the four
  blind spots"; the header had been raised past four in `51402e99`, and the
  stale copy shipped in 0.6.1, 0.6.2, 0.7.0 and 0.7.1 — a security rule
  describing its own mechanism wrongly for four releases. The fix is not a
  corrected number, which would only restart the same clock: the prose states
  no count and points at the header, and `README.md` moved with it for the same
  reason. Pinned in the generator's `test/template/guard-secret-file.test.ts`
  (absent in a generated rig) › "no live rulebook document restates the guard’s
  limit count" and › "the rule and the README still send the reader to the
  guard’s own header".

- **The same file re-listed the paths `guard-rulebook` protects, and its list
  was incomplete.** The enumeration of trees an unattended run may not edit
  omitted `.claude/doctor-exemptions.json`, which the guard does refuse. It is
  replaced by a pointer to `RULEBOOK_PREFIXES` in
  `.claude/scripts/unattended-flag.mjs` — the set the guard judges an edit
  against — so there is one spelling of it rather than two. One fact that
  pointer cannot carry is stated beside it, because it does not follow from the
  set: the checkout board selector is refused **even when an item's allow-list
  names it**.

- **`loop/SKILL.md` paraphrased that set too, in both harnesses' copies.** The
  step where a session composes an allow-list summarised the protected rulebook
  in prose, so the one moment the set is read in anger was the moment it was
  read from a summary that had already drifted. It now names
  `RULEBOOK_PREFIXES` and says to open it. Both copies carry the change — the
  Claude skill at `.claude/skills/loop/SKILL.md` and its Codex projection at
  `.agents/skills/loop/SKILL.md`.

### Inside the generator, and not inside a rig

`packages/cli/src/policy/` is new — a typed policy declaration, a registry, a
decision-record schema and one adapter per harness. Its compiled output adds
eleven files to the published tarball, 245 → 256. **No command imports it**, so nothing a
project scaffolded from this release does comes from it. What such a project
does get from this release is the three corrected documents above — and an
installed 0.7.1 rig still needs `create-agent-rig upgrade` to receive them —
which is a necessary condition and not a sufficient one, because a rig whose
owner has edited one of those three files is handed a conflict to merge rather
than an overwrite.
This module is named here only because a reader diffing the two tarballs sees
eleven new files and is owed the reason they are not part of that answer.

`templates/release-ledger.json` carries `0.7.1` at `52e879b6`, the commit it was
published from, read from `npm view create-agent-rig@0.7.1 gitHead` and verified
an ancestor of `master`. `templates/hash-history.json` is regenerated from it and
now covers eleven releases, `0.2.0` through `0.7.1`, so `upgrade` can tell an
untouched file from an edited one in a rig installed from 0.7.1.

## 0.7.1

**The gate could not be run on work that has no queue item.** `pr-ship` names
owner-directed work and hotfixes with no item as a legitimate path — step 4
tells the fan-out to declare it and have the reviewer skip the item-contract
check openly. Step 1 then made that path unexecutable: it called
`revalidate.mjs` with an unconditional `--ticket`, and the script refused
without one. A newly scaffolded project inherited a rulebook that contradicted
itself at the one checkpoint before every PR, so the first hotfix in a fresh rig
had nothing it was allowed to do. Found downstream while integrating published
0.7.0.

A patch: no file is added or removed, no new dependency, and the public CLI of
the generator is untouched. What changes is one flag on one internal script and
the skill step that calls it.

### Fixed

- **`revalidate.mjs` BEFORE_PR now has two modes, and neither is inferred.**
  `--ticket <key>` is unchanged, including the mandatory claim comparison.
  `--owner-directed` runs the same default-branch drift comparison for work
  with no item, reaching no tracker, no adapter and no claim record — so it
  needs no tracker credentials. Passing both flags, or neither, is exit 1: a
  mode chosen by absence is a mode nobody reviewed.

  It is not a lighter checkpoint. A default-branch change under a path the
  branch touches, or one a `check-premises` record cited, holds with the same
  exit 2. What it drops is the claim comparison, because work with no item has
  no claim to compare, and it records `ticket: null` rather than inventing an
  id.

  **Four refusals keep it from becoming a bypass** — exit 1, nothing
  journalled: when the run carries an unresolved `revalidationHold`, when the
  run declares a take-up, when the branch touches a tracked
  `.rig/claims/*.json` in any direction (added, modified, removed or renamed),
  and at `BEFORE_CLOSE`. The first is the one that makes re-running a held or
  `UNVERIFIABLE` ticketed call in this mode a refusal rather than a way past
  it; the run's stop inputs are read fail-closed, so an unreadable
  `state.json` refuses instead of reading as an empty run.

  An owner-directed HOLD is answered the same way a ticketed one is, with
  `revalidate.mjs outcome` at the same point, passing `--owner-directed`
  instead of `--ticket`. It addresses the detection by mode, since that
  detection carries no ticket to name.

  ⚠ Its stated limits, because a governance mode is trusted as far as it is
  described. Nothing can prove an item does not exist. With no `RIG_RUN_DIR`
  there is no run state, so the hold and take-up refusals cannot fire — the
  command says so on stdout and in `evidence.runState` rather than reporting a
  clean check. The claim refusal reads the branch diff, so a record already on
  the default branch or not yet committed is not seen. And `--base` is the sole
  authority for the verdict here, the claim comparison that would otherwise
  survive a wrong base being absent.

- **`pr-ship` step 1 states both paths**, and step 4 now spells the words the
  fan-out is launched with — `no item — owner-directed` — and says that this
  skips the item-contract check and **nothing else**: the checks, the routing,
  the security, code and prose/governance reviews, the coverage check and the
  DoD all still run.

## 0.7.0

**A durable claim record under the revalidation 0.6.2 already had, and the
governance fixes that followed it.** 0.6.2 could already re-check at a
checkpoint whether the branch about to ship is still the branch the run took
up. What a newly scaffolded project gains here is the layer under that: a
content-blind record of what was claimed, so the re-check no longer rests on
the run's own take-up snapshot. The public CLI is unchanged — no new command,
no new flag, no new dependency.

**Numbered a minor deliberately.** The rule at the top of this file is that
additive is a minor and a fix is a patch, so that "I only take minors" stays a
usable policy. **Five** files land in a generated rig that the published 0.6.2
does not contain — the four listed under Added, plus
`.claude/scripts/lib/shell-tools.mjs`, the shared shell-tool list the Never-tier
guards read. One of the five is a config file the project owns. Shipping that as
a patch is the case the rule exists to prevent.

### Added

- **Content-blind revalidation claims.** A run records what it claimed at each
  checkpoint and compares it later without copying the tracker's content, so the
  re-check does not depend on the run remembering correctly. A generated project
  receives `.claude/scripts/lib/claim-records.mjs`,
  `.claude/scripts/lib/revalidation-evidence.mjs`, `.rig/revalidation.json` and
  the decision record `docs/decisions/content-blind-revalidation.md`.

### Fixed

- **The Never-tier guards, and the kill switch they carry, run on every shell
  surface — where before they ran on one.** They were wired under a single tool
  matcher, so a second shell surface reached none of them: a force-push of a shared branch, a filesystem wipe and a
  pre-commit bypass all ran there with the brake armed. The guards now read one
  shared list of shell tools rather than each comparing its own literal, and the
  tests spawn them on every entry in that list instead of checking the wiring
  alone — which is how the gap survived its own test suite.

  ⚠ Running is not the same as covering, and the limit is stated where the list
  is. The rules match a command NAME, so they refuse an operation only in that
  spelling: with the brake armed, `gh pr merge …` is refused on both surfaces
  while `gh.exe pr merge …` and `Remove-Item -Recurse -Force C:\` are not. That
  bound belongs to the rule set rather than to the matcher — the `.exe` spelling
  was allowed on the original surface too — and it is unchanged by this
  release.

- **A shell command the two shell guards cannot read is refused, where it used
  to be allowed.** `guard-bash` and `block-no-verify` read the `command` a hook
  hands them on a shell tool, and asked only whether it was a string. A command
  that was **there** in some other container — an array of argv words, an
  object — failed that test and returned _allow_ before the kill switch was ever
  consulted, so restating a forbidden command in another shape stepped over an
  armed brake. Those two guards now decide the three outcomes in one shared
  place: an **absent** command still allows, because there is nothing to judge;
  a **string** is inspected as before; a command that is present in a shape they
  cannot read is **refused**, naming the shape they expected.

  ⚠ The scope is those two guards, and it is narrow on purpose — it is **not** a
  repository-wide ruling on the word `command`. `guard-secret-file` reads an
  `apply_patch` `command` that is a _list of strings_, exactly the shape this
  contract calls unreadable, and it is right to; routing a third guard through
  the same place without checking what its tool actually sends would start
  refusing input another guard exists to read.

  ⚠ Two further limits. This changes only the unreadable case — the name-exact
  bound described just above is untouched, and an absent field remains fail-open
  on purpose, since a guard that blocked when handed nothing would be turned off
  within the hour. And the **edit** surfaces are not part of this: what
  `.claude/hooks/lib/edit-input.mjs` does with a `tool_input` it cannot read is
  unchanged by this release.

- **An adapter it cannot read is `UNVERIFIABLE`, not a stack trace.** A
  revalidation whose queue adapter could not be reached exited on a raw Node
  stack trace, which a caller could read as noise rather than as a hold. It now
  takes the same hold path a real drift takes and never returns a pass. The
  reason it prints is withheld whenever it carries userinfo — as a class, not as
  a list of spellings, after two rounds in which each fix closed the form just
  found and left the next one open. A queue configuration that cannot be
  resolved at all is a refusal with a readable message rather than a crash.

- **The instruction surface no longer cites this repository's backlog.** The
  `loop` and `pr-ship` skills and the Node/TypeScript stack rule carried ticket
  identifiers, commit SHAs and PR numbers from the tracker that built them —
  provenance a downstream reader cannot open, in artifacts whose only job is to
  instruct. A mechanical check now scans every layer's rules, skills, agent
  specs and top-level instruction files and fails on a backlog identifier,
  without banning those letters repository-wide.

  ⚠ Scoped deliberately, and the scope is not the whole rig. Two of the check's
  exclusions ship: the `.claude/scripts/**` and `.claude/hooks/**` trees, whose
  citations are comments addressed to whoever edits the mechanism rather than
  instructions the agent follows, and `docs/decisions/`, where a record's whole
  job is to say what happened. Together **86 citations across 27 files** still
  arrive with a generated project — 78 in the first pair, 8 in the records.
  Whether they are the same defect is a live question this release does not
  settle.

- **Evidence pointers are checked rather than trusted.** A pointer of the form
  `file › "test name"` is what keeps a claim about a mechanism honest; several
  named tests that had been renamed or moved. A check now resolves them, and a
  pointer into a suite a generated project never receives has to say so.

  ⚠ Its coverage is partial and it states that itself: it reads a citation's
  names from the line the file is named on and the two after it, and resolves a
  target by basename, so a test moved to another directory still passes. A green
  run means no citation it read has gone dead — not that every pointer was
  verified.

- **The `loop` skill now describes how the run directory actually reaches each
  command.** It had described a directory most of its own commands could not be
  told about, so a reader could journal into one place while a check looked in
  another. The correction is to the skill's text, not to the plumbing: the two
  commands that take it as an argument rather than from the environment are now
  named, and a correspondence check walks every script rather than a list
  somebody maintains.

### Documentation

- `docs/command-contract.md` records what the CLI promises and which of its
  commands conform today. Generator-only; it does not ship into a rig.

## 0.6.2

**Patch hardening for the Agent OS shipped by 0.6.1.** This release closes six
downstream-found governance and transport defects without changing the public
CLI or adding a dependency.

### Fixed

- **A UTF-8 BOM on a hook's stdin no longer disarms it.** PowerShell prepends
  one on some Windows hosts, `JSON.parse` throws on a leading U+FEFF, and every
  hook resolved that to its documented fail-open — so a well-formed refusal
  became an allow. On such a host all eight hooks failed open together,
  `guard-bash` among them, which carries the Never tier and the kill switch.
  They now read through one shared `.claude/hooks/lib/hook-input.mjs`. Pinned in
  `test/template/hook-stdin.test.ts` › "blocks the same command when PowerShell
  prepends a UTF-8 BOM" and › "reads stdin through the one shared reader, in
  every hook that reads it".
- **Windows 8.3 short paths no longer hide a rulebook edit from the guard.**
  `realpathSync` normalises separators but leaves a short name (`RUNNER~1`,
  `SERHII~1`) unexpanded, so a checkout reached by two spellings hashed to two
  unattended-flag names and compared as two directories. Both
  `guard-rulebook` and `unattended-flag` now canonicalise with
  `realpathSync.native`. Pinned in `test/template/unattended-flag.test.ts` ›
  "scopes the flag by the checkout, so two spellings of one directory arm one
  file".
- **Codex hooks carry the canonical repository root in `CLAUDE_PROJECT_DIR` on
  POSIX and Windows.** A session started in a nested directory therefore judges
  a rulebook edit against the checkout the hook came from. Pinned in
  `test/template/codex.test.ts` › "anchors a nested-cwd Codex rulebook edit to
  the canonical repository root"; the same test file decodes and checks the
  Windows command.
- **Jira retry is limited to safe reads and the semantically read-only search
  POST.** Comment, transition, issue-create and issue-update mutations return
  the first ambiguous transient failure instead of replaying the write. Pinned
  in `test/template/queue-jira.test.ts` › "does not retry %s" and › "retries a
  semantically read-only search POST after a 429".
- **`.claude/doctor-exemptions.json` is protected as rulebook input.** An
  unattended edit is refused unless the current item's allow-list names that
  exact file. Pinned in `test/template/guard-rulebook.test.ts` › "allows doctor
  exemptions only when the item names that exact rulebook file" and the guarded
  path table in the same suite.
- **`lastCompletedTier` is explicitly repository-global across board switches.**
  A selector change cannot reset the spacing brake and admit a second elevated
  mechanism change in the same checkout. The ruling is in
  `docs/decisions/spacing-rations-mechanisms.md`, pinned by
  `test/template/queue-board.test.ts` › "keeps completed-tier spacing
  repository-global when the active board switches".

## 0.6.1

**Security and upgrade hardening for the Agent OS shipped by 0.6.0.** This patch
closes the rulebook, unattended-run and queue-board gaps found while upgrading a
live generated repository; it adds no dependency and changes no public CLI
command.

### Security

- **`guard-rulebook` now covers the whole shared rulebook and symlink aliases on
  either side of the comparison.** `AGENTS.md` and `.codex/hooks.json` are
  protected alongside the Claude files. Checkout roots and payload paths are
  judged in both their selected and canonical spellings, including a
  payload-only alias.
- **Queue board names containing terminal control characters are rejected before
  selection, diagnostics or selector writes.** Ordinary names, including names
  with spaces, remain valid; ANSI, OSC, C1 and DEL bytes from repository-owned
  `queue.json` keys can no longer repaint terminal output.
- **Unattended authorization is checkout-scoped.** Concurrent worktrees derive
  distinct flag paths from canonical checkout identity, legacy machine-wide
  state fails closed, and migration or cleanup refuses when any armed flag cannot
  be removed instead of reporting a partial disarm as success.

### Fixed

- The generated prose-reviewer exception for upstream-only tests now applies
  only to manifest-proven generator snapshots and expires on local drift. This
  keeps intentional generator test references available without turning a dead
  reference in an edited downstream rulebook into a pass.

## 0.6.0

**The loop now checks its premises against the tracker at three points, and
the rulebook cannot be edited from an unattended run.** Everything below is what
a newly scaffolded or `init`ed project receives.

**The released-hash table no longer depends on tags** (AR-35). It is built
from `templates/release-ledger.json` — the commit each version was published
from — so it now carries 0.5.0's bytes, 0.4.0's real bytes (the stale `v0.4.0`
tag is reported and ignored) and a 0.2.0 row; the consequence 0.5.0's notes
state for a rig upgraded without a readable manifest is closed for every
release the ledger records. This release itself is excluded, as every release
being prepared is: commit `.claude/.rig-manifest.json`.

### Added

- **Revalidation at SELECT, BEFORE_PR and BEFORE_CLOSE** (AR-133, AR-134,
  AR-135, AR-136). `.claude/scripts/revalidate.mjs` compares the item the run
  took against the tracker's current state — at selection against this run's
  take-up, before a PR against the item and the default branch, and before a
  close against the item's fields and its dependants — and every point records
  one evidence shape in the run directory; `revalidation-report.mjs` reads them
  back. A close now proves it transitioned rather than reporting the write. The
  points themselves have one spelling, `.claude/scripts/lib/revalidation-points.mjs`,
  and the `loop` and `pr-ship` skills are checked against it in both directions
  (AR-137).
- **`guard-rulebook`** (AR-51): a `PreToolUse` hook that refuses an edit to the
  hooks, their wiring, `.claude/queue.json`, the queue adapters, the router, the
  gate sweep, the rules or `CLAUDE.md` while the unattended flag the `loop` skill
  writes at claim time is on disk (`.claude/scripts/unattended-flag.mjs`), unless
  the item's allow-list names the path. Attended sessions are untouched. Its
  header states its limits, each one under test in the generator.
- **`doctor`** (AR-5): `node .claude/scripts/doctor.mjs` reads
  `.claude/.rig-manifest.json` and reports every hook the project owns — bytes
  that differ from what the generator installed, or no manifest entry — that has
  no `<hook>.test.mjs` beside it. Exemptions are an explicit list with reasons in
  `.claude/doctor-exemptions.json`, a file the project writes (none ships); a
  doctor that looked nowhere never says GO.
- **Fan-out coverage is checked, not just recorded** (AR-79, AR-118): `pr-ship`
  compares the reviewers that answered against the route the router gave the
  head, bound to that head; `docs/decisions/gate-coverage.md` records the shape
  and the unreadable states.
- **Queue items carry more of the tracker's meaning into selection:**
  - an item marked for another repository (`owner-<name>`; `[owner:<name>]` in
    `PLAN.md`) is held, never taken — a checkout names itself in
    `options.owner` (AR-132);
  - the lifecycle vocabulary `keep-core` / `re-scope` / `obsolete` and the
    `parked` pile are read above the adapter seam, and the loop infers none of
    it (AR-144);
  - a proposal the loop files records the commit it was measured against
    (`asOf`), and `hygiene` reports the one git has overtaken (AR-116); it also
    names what it measured and what it inferred, and an inference past the
    measurement is refused at filing (AR-142);
  - the take-up baseline reaches into earlier runs, so a marker the adapter's
    own write produced is not read back as a catch (AR-138, AR-140);
  - `gate-round` refuses to count a round on a checkout that cannot ship, and
    states the cap as a spent count rather than a convergence verdict (AR-141,
    AR-115).

### Changed

- **The Jira adapter is harder to knock over** (AR-54): a request timeout that
  stays armed through the body read, transient retry honouring `Retry-After`
  (capped at 60 s), cursor pagination with a stated page cap, a priority-id
  fallback, and a JQL that is always project-qualified — an explicit
  `options.jql` must begin with `project = <KEY>`.
- **The adapter contract gained `find` and `listProposals`** (AR-135, AR-116)
  and the ticket shape gained `updatedAt`, `owner`, `lifecycle` and `parked`.
  On `jira`, `limit` is now the **page** size, not a result cap.
- **A close is a close only when the tracker says so** (AR-135): all three
  adapters read the item back and return `transitioned` from what they read,
  instead of from the argument they were given or a `gh` exit code.
- **`gate-stop-dod` measures the project the hook belongs to, not the cwd**, and
  names the tree in its refusal (AR-119).
- **`.claude/rules/node-ts.md` names the third state of a PR head** — one that
  gets no workflow run at all — and says it is retriggered per required check,
  never merged on an older head's green (AR-149).
- **The autonomy and invariants rules state the enforcement they have exactly**:
  `guard-secret-file`'s four blind spots, the unattended flag as what arms
  `guard-rulebook`, and the unbacked-claim rule with its two exits (delete, or
  point at the test).

### Fixed

- **`MultiEdit` and `NotebookEdit` reached every content guard and produced no
  fragment**, so an impure edit to the core through either passed unchecked.
  `hooks/lib/edit-input.mjs` now yields one fragment per edit for both (AR-51).
- **`manifest.version` is held to the same value check its siblings get**, and
  the comment no longer claims a prerelease the rig never wrote (AR-128).
- **Hooks resolve the project root inside `main()`**, so a throw there announces
  itself instead of failing open silently (AR-119).

- **The upgrade plan's header told you your rig was old when it could not know
  that.** It greeted every rig it could not read a manifest for with "no manifest
  here (a pre-0.4.0 rig)". There are three ways to reach that branch and the
  claim is false for two of them: a manifest you deleted, and one that is on disk
  and voided by its own reader — the case 0.5.0's notes below single out. The
  header now states the condition the code actually has, **no readable manifest
  here**, and offers the three causes without asserting any of them.
- **`--no-color` is accepted by `upgrade` and `init`**, not only by the
  scaffolder. It was advertised under Options without being scoped to one
  command, and the other two exited 1 with "Unknown option". **Nothing about
  their output changes** — the CLI builds its palette on the `create` path alone,
  so neither command had colour to switch off, and neither read `NO_COLOR`
  either. What changes is that a flag the help offers is no longer a refusal.
- **The plan's summary now accounts for every action, not four kinds out of
  six.** It counted files to replace, new files, yours-kept and already-current,
  while the plan above it also prints a line for a hook wiring hand-over and for
  a file you removed — so the four buckets could not add up to what was printed.
  Both are counted now, in the order the plan lists them, and they appear only
  when they occurred: a plan without them reads exactly as it did.

## 0.5.0

**Codex is a harness of this rig now, not a thing you adapt it to.** A generated
project carries one rulebook and two readers: `CLAUDE.md` for Claude Code and
the same text as `AGENTS.md` for Codex, with repository skills in
`.agents/skills/`, agent profiles in `.codex/agents/` and portable hook wiring
in `.codex/hooks.json`. Neither harness gets the weaker policy, and the derived
half is drift-checked rather than maintained twice.

**This release ships untagged, by the owner's decision, and it has exactly one
consequence — read it if you ever run `upgrade` on a rig whose
`.claude/.rig-manifest.json` is missing or unreadable.**
`templates/hash-history.json`, the table such a rig is measured against, is
built from `v*` tags. So 0.5.0's bytes never enter it, and the `0.4.0` row it
gained in this release carries the _previous_ release's bytes: that tag points at
0.3.2's content, which is why the row adds no hash to any path. Both paths 0.4.0
actually changed — `.claude/skills/loop/SKILL.md` and `PLAN.md` — are in the
table with their 0.3.x hashes; what is absent is 0.4.0's bytes from their hash
lists.

**Who that reaches, and who it does not.** `create`, `init` and `upgrade` each
write the manifest, and `upgrade` matches it **before** it consults the table, so
a rig whose manifest is present and parseable is unaffected whatever the table
says. Without a readable manifest the table decides, and it decides in the
conservative direction: bytes it recognises are replaced, bytes it does not are
kept and reported as yours — see `packages/cli/test/upgrade.test.ts` › "replaces
a file that matches a released version, and reports the rest".

A rig installed **before** 0.4.0 is not the exposed case: its 0.3.x bytes are in
the table, so those two files are recognised and replaced. The rig that keeps
them is one installed at **0.4.0** whose manifest is unreadable.

**And the scale of it grows with this release, which matters more than those two
files.** Because 0.5.0 is untagged, nothing it ships enters the table either — so
a rig installed at 0.5.0 and later upgraded **without a readable manifest** has
most of its agent-os files unrecognised, and many of them are paths the table has
no row for at all. Every one is kept and reported as yours, so no edit is lost
and no file is silently skipped, but almost nothing would be refreshed either. **Commit `.claude/.rig-manifest.json`** — that single habit makes the
table irrelevant to you, and it is what `README.md` puts in bold.

### Added

- **Codex is now a native target of the Agent OS.** Generated and `init`ed
  projects receive `AGENTS.md`, repository skills in `.agents/skills/`, custom
  agent profiles in `.codex/agents/`, and portable `.codex/hooks.json` wiring.
  These files are derived from the Claude Code sources and drift-checked.
- Architecture guards now understand Codex `apply_patch` payloads, inspecting
  additions and bounded existing content for moves, so removing an old
  violation does not create a false block.

### Changed

- **`upgrade` now replaces `.claude/settings.json` when the manifest proves you
  never touched it** — closing the decision 0.4.0's notes left open below. The
  case it exists for is a release that adds a hook: the hook file arrived and
  the wiring that calls it did not, so the guard sat on disk doing nothing. When
  the on-disk bytes hash-match the entry the manifest recorded for the installed
  release, they are provably the rig's own and the release's version is written.

  **Three limits. The first two are there because not having them was tried,
  and each produced a regression two reviewers reproduced independently.**

  1. **The released-hash fallback does not apply to this file.** Every other
     file the rig installed can be recognised by matching a tagged release even
     with no manifest entry. This one cannot: a rig with no manifest that has
     run `init` is recorded as `kind: "init"`, and the wiring that flavour
     writes deliberately omits the hooks `init` does not install.
  2. **A replacement that would stop calling a hook still present in
     `.claude/hooks/` is handed over instead**, whatever the manifest says. This
     is the guard that does not depend on getting `kind` right — a manifest
     saying `init` on a rig `create` produced reaches the same wrong wiring
     through the hash arm alone.
  3. **Anything else is unchanged:** the new entries are printed for you to
     merge, and nothing is written.

- **`init --force` is deprecated.** It refuses, names `upgrade` as the command
  that refreshes a rig, and writes nothing. It only ever replaced `CLAUDE.md`,
  which `upgrade` now does per file and with the manifest behind it. **The flag
  is removed in 0.6** — this release is the one warning you get.

  The way into a `create` rig that `--force` used to provide is a deleted
  `CLAUDE.md`; that is what `init`'s refusal is actually about, and it is the
  case the manifest-preserving fix below was written for.

### Security

- 🔴 **A committed `.claude/.rig-manifest.json` could run code on the machine
  of whoever upgraded the rig.** `project.name`, `project.scope`,
  `project.region` and `stacks` were each validated — but only as _path_
  segments, a predicate that asks whether a value can steer a write. Two of
  them are also substituted into installed **files**:
  `.claude/scripts/stop-flag.mjs` embeds the name inside a single-quoted
  JavaScript string literal that `guard-bash` imports on every Bash call. A
  value closing that quote steers no path at all and passed — it executed in
  the hook process, **and** moved the kill switch's path off
  `~/.claude/<name>-loop-STOP`, so the brake read as installed while doing
  nothing. The manifest travels in pull requests, so the delivery was an
  ordinary PR plus an `upgrade`. All four are now held to the shape the rig
  actually produces (`^[a-z0-9_][a-z0-9._-]*$`), and a manifest carrying
  anything else is void as a whole rather than corrected.

  **Checking a rig you upgraded from a manifest you did not write — three
  places, because the name is not the only value that travelled.**
  `.claude/scripts/stop-flag.mjs` is the executable sink: its kill-switch line
  must read your own project name. `region` lands in
  `.claude/skills/ro-debug/SKILL.md` as `export AWS_REGION=…` on rigs carrying
  the `aws-cdk` overlay — and a manifest also declares `stacks`, so it can
  request that overlay on a rig that never had it. The name is substituted into
  the documents the agent obeys as well (`CLAUDE.md`, `PLAN.md`, the `loop`
  skill), where a hostile value arrives as injected text rather than as code.

  Nothing `create` or `init` writes is rejected by the new rule — including an
  empty `region` and a name with a leading underscore, which
  `projectNameFor` really can produce.

### Fixed

- **`init --force` inside a generated project used to make `upgrade` stop
  refreshing the stack overlays — silently.** ⚠ Read this next to the
  deprecation above: `--force` is refused in this same release, so
  the route described here is gone. The fix is not idle — the manifest is
  preserved on **every** `init` over a `create` rig, and the remaining route in
  is a deleted `CLAUDE.md`. `init` rewrote the rig manifest
  as `kind: "init"`, `stacks: []`, empty `region`, and `upgrade` trusts a
  manifest wholesale rather than re-detecting: the stack files simply left the
  plan, reported neither as deleted nor as a conflict, and `CLAUDE.md` came
  back in the `init` flavour. `init` now carries the `kind`, `project` and
  `stacks` it found in the manifest through unchanged, and adds an entry for
  each file it wrote without dropping the entries already there. It also says,
  before writing anything, that this rig came from `create` and `upgrade` is
  the command that refreshes it.

  ⚠ **Both halves read the manifest, so a rig that has none — anything
  installed before 0.4.0 — is not covered.** There `init` still writes
  `kind: "init"`, `stacks: []`, empty `region`, and prints no advisory; worse,
  such a rig could previously be recovered by `upgrade`, which re-detects the
  install from the files on disk **only when there is no manifest at all**, and
  the one `init` writes takes that route away. On a pre-0.4.0 rig, run
  `upgrade` before `init`.

  **Recovering a rig whose manifest was already flattened:** delete
  `.claude/.rig-manifest.json` and run `upgrade` — the detection restores
  `kind`, `stacks` and `region` from the files themselves; hand-writing the
  manifest is not needed and `parseManifest` rejects the whole file on any
  malformed field. What that does **not** repair is `CLAUDE.md`: the flattening
  `init` overwrote it with the `init` flavour, so `upgrade` reports it as
  `conflict` ("not a version this rig ever released — treated as yours") and
  the create flavour has to be merged back by hand.

- **The `jira` queue adapter was calling an endpoint Atlassian removed.** Both
  selection and the triage dedupe went through `GET /rest/api/3/search`, which
  answers `410 Gone`; the adapter threw on the status line and the loop read
  that as an unreadable queue. It now uses `POST /rest/api/3/search/jql`. If
  your rig is on the `jira` adapter, this is the difference between a loop that
  works and one that reports an empty board. Cursor pagination
  (`nextPageToken`) is **not** implemented yet, so a board with more open issues
  than `limit` (default 100) still loses its tail.

### Changed — action needed if your board uses the `jira` adapter

- 🔴 **The elevated-tier marker on Jira is now the `elevated` label, not
  `human-review`.** A board that marked elevated work with `human-review` will,
  after this upgrade, hand every item to the loop as `normal` — the
  elevated-spacing ration silently stops holding anything back. **Relabel those
  issues to `elevated` before running the loop again.** The change is
  deliberate: on a Jira board `human-review` reads as "a human is looking at
  it", which is a different claim from "this change is expensive to reverse".
  The `github-issues` adapter is unaffected and still reads `human-review`,
  where it does mean a human reviewed the diff.
- **Selection now excludes the `operator-queue` label as well as `triage`.** An
  item in the owner's lane is work a human has taken, so the loop no longer
  picks one up. If you used `operator-queue` for something else, rename it
  first.

## 0.4.0

Upgrading is a command now: **`npx create-agent-rig@0.4.0 upgrade`** (`@latest`
once you know what latest is — this section will not). That sentence replaces
the six-file manual procedure 0.3.2 had to print, and it is the whole point of
this release: a rig you cannot bring forward stops being maintained at whatever
version you installed it at.

Read the [Upgrading](README.md#upgrading-a-rig-you-already-have) section before
the first run on an existing rig; `--dry-run` prints the plan and writes
nothing.

### Added

- **`create-agent-rig upgrade [--dry-run] [--yes]`** — brings an installed rig
  to this version: it replaces the files the rig wrote **and you have not
  touched**, installs what the release adds, and **reports everything else**.
  There is no three-way merge and no patching, by decision rather than
  omission: silently folding your edits into the documents an agent loop obeys
  is how a rig stops meaning what its owner thinks it means. Every conflict
  names the file, why it was kept, and the path to the new version, so the diff
  you may want is one command away.
- **`.claude/.rig-manifest.json`** — written by `create` and by `init`: the rig
  version and a hash per installed file. **Commit it.** It is what lets an
  upgrade tell a file the rig wrote from a file you own, and without it in the
  repository the command is blind on CI and on a colleague's machine. `init`
  records only files it actually wrote — never one it kept, which would be
  claiming somebody else's document.
- **A released-hash table travels in the package**, generated from the git tags
  at release time and never by hand. It is what makes a 0.3.x rig upgradable at
  all, and it answers a second question too: a file that shipped in every
  release it covers and is gone from disk was **deleted on purpose**, so it
  stays deleted. The rules tell you to delete the invariants your project does
  not have; an upgrade that quietly restored them would be undoing your work.
- **The `loop` skill writes back what a close unblocked**, in a required
  journal field with three distinct answers — the items that were waiting, by
  name; "nothing was waiting"; or "this queue has no dependency links" where
  the adapter cannot answer at all. It is a **report, not an edit** to those
  items: correcting queue state by hand destroys the evidence that the state is
  unreliable, which the rules forbid by name.

### Two things `upgrade` deliberately will not do

- **Replace `.claude/settings.json`.** It is where your own hooks live, so the
  new wiring is printed for you to merge — in the dry run too. The cost is
  real and stated: a release that adds a hook delivers the file and not its
  wiring, and whether a manifest-proven-unmodified settings file should be
  refreshed is an open decision for 0.5.
- **Touch the skeleton.** After `create`, the code is your project. The manifest
  covers the agent-os layer and nothing else.

### Deferred, and on what condition

- The clarify-gate (`C-0…C-2`) — unchanged from 0.3.2: it enters once that gate
  has fired at least once anywhere. Until then there is nothing to copy but an
  intention.
- `init --force` now overlaps `upgrade`, and its future is an open question
  rather than a deprecation: decided in 0.5, unchanged here.

## 0.3.2

Numbered as a patch by the owner's call; the content below is additive, so
nothing that shipped in 0.3.1 changed shape.

A generated project gains two review gates it did not have — one before the work
starts, one over the prose that instructs it — and three more queue-hygiene
checks.

**Upgrading an existing rig: `init` alone is not enough, and here is exactly
why.** `create-agent-rig init` installs files that are not there and **keeps
every file that is** — `--force` replaces `CLAUDE.md` and nothing else
(`packages/cli/src/commands/init.ts`). Re-running it on a 0.3.1 rig therefore
delivers the two new files, `.claude/agents/prose-reviewer.md` and
`.claude/skills/check-premises/SKILL.md`, and **none of their wiring**: the
skill arrives with nothing calling it, and the agent arrives with `pr-ship`
never launching it. Six files below changed rather than appeared, and `init`
will not touch them:

```
.claude/agents/code-reviewer.md          # the sixth blocking item
.claude/skills/loop/SKILL.md             # calls check-premises, and §3/§6/§8
.claude/skills/pr-ship/SKILL.md          # fans out prose-reviewer, passes the item
.claude/scripts/queue/core.mjs           # the three hygiene checks + Ticket.body
.claude/scripts/detect-missed-gate.mjs   # sees a rulebook outside the repo root
.claude/hooks/gate-stop-dod.mjs          # judges the tree it is in
```

Delete those six and re-run `init`, or copy them across by hand. This note tells
you the manual steps rather than an easy sentence that leaves half the release
inert — that failure mode is the whole subject of 0.3.1, immediately below.

> **Superseded in 0.4.0.** `create-agent-rig upgrade` delivers exactly these
> files, and the ones every release after it changes. The procedure above is
> kept as the record of what 0.3.2 asked of its users; do not follow it if you
> have 0.4.0 or later.

### Added

- **`check-premises` skill** — a queue item is a _claim about the code_, written
  by someone who was not reading the code at the time, and nothing downstream
  re-checks it: the failing test is written against the item, the implementation
  against the test, and the reviewer compares the diff to the item. A false
  premise therefore produces work that is correct, tested, reviewed and useless.
  The skill runs between taking the item and the Red step, is read-only by
  frontmatter so it cannot start implementing, and returns `PREMISES HOLD` /
  `PREMISE FALSE` / `UNVERIFIABLE`. Its two boundaries are the point: a false
  load-bearing premise is **stop and report**, never a silent re-aim of the task,
  and only load-bearing claims are checked — an audit is what makes the step
  expensive enough to skip. The `loop` skill calls it, and treats `PREMISE FALSE`
  as a per-task escalation rather than a licence to rewrite the item.
- **`prose-reviewer` agent** — a fourth gate, read-only. In this layer the prose
  _is_ the implementation: a rule that overstates its own enforcement fails
  exactly like broken code, silently and in the direction of false confidence. It
  blocks on five things — enforcement claimed beyond the mechanism, a dead
  reference, two rules that contradict each other, stated limits gone stale in
  either direction, and domain that must not travel (a vendor name, a host path,
  a tracker key or a credential in a layer meant to be neutral) — and its
  boundary comes before its checklist: it is **not
  a literary editor**, and prose that is merely clumsy is not a finding. Wired
  into the `pr-ship` fan-out and named in both maps.
- **A sixth blocking item for `code-reviewer`** — a change that contradicts the
  queue item it claims to implement. The instruction is to report the mismatch,
  never to decide which side "must have been meant": a reviewer who reconciles
  the two silently turns a visible mismatch into an invisible one. Where no item
  was supplied, it says so rather than reconstructing one from the PR body —
  which is evidence `autonomy.md` refuses by name. `pr-ship` now passes the item.
- **Three queue-hygiene checks** — a parent that says it was split up and is
  still open; a dependency line naming a blocker no link carries (worse than a
  stale label: selection reads the item as unblocked); and a document link that
  is broken on its face. The neutral `Ticket` shape gains a **nullable `body`**
  so these live in one pure function instead of once per adapter — and `null`
  means "this adapter cannot answer", never "checked, found nothing".

### Fixed

- **The baseline commit of a generated project could land in the caller's
  repository.** Git hands its hooks an absolute `GIT_DIR`, and the CLI spawned
  git with the environment intact — so `git init` re-initialised the caller's
  repo, `add -A` staged its tree, and the commit landed on whatever branch it had
  checked out, while the generated project got no `.git` at all. A redirected
  `git init` can also flip the caller's repository to `core.bare=true`. The path
  that triggers it is a pre-commit hook running a suite that generates projects —
  which is what made the `worktree-task` skill unusable. Every git call site now
  strips the variables that locate a repository, including the shipped
  `gate-stop-dod` hook (which asked git whether _which_ tree was clean) and
  `preflight`.
- **The Tier-2 gate sweep could not see a rulebook outside the repository root.**
  `detect-missed-gate` exempts the rulebook from its inert-file rule so a merge
  rewriting the autonomy tiers cannot pass as "just prose" — but the exemption
  was anchored at `CLAUDE.md` / `.claude/`. Any project that vendors, templates
  or nests a rig keeps its rulebook elsewhere, and every `.md` there was dropped
  before the elevated-path test ran. It is now recognised wherever it sits, and
  the sweep's verdict vocabulary knows the words `pr-ship` actually emits.

### Deferred, and on what condition

Two pieces of the source brief did **not** travel, because shipping an unproven
gate into other people's projects is worse than not having one:

- the queue-closing discipline for blocked dependents — enters when it has been
  merged and used in the project it came from;
- the clarify-gate (`C-0…C-2`) — enters once that gate has fired at least once
  anywhere. Until then there is nothing to copy but an intention.

## 0.3.1

`create-agent-rig init` shipped a rig that looked installed and enforced
nothing. Everything below is that one failure, in its four parts — a repo
`init`ed with 0.3.0 should be re-run with this version (`--force` to replace the
CLAUDE.md it wrote).

### Fixed

- **The hooks are wired.** `init` laid the hook files down and stopped there: no
  `.claude/settings.json` meant `guard-bash`, `block-no-verify`, `gate-stop-dod`
  and `inject-rules` were never called, while the installed `CLAUDE.md` claimed
  they were enforced at the tool layer. The wiring is now _derived_ from the
  shipped settings, so it names exactly the hooks that travelled — never one that
  did not. Where the repo already has a `settings.json`, `init` keeps it and
  prints the entries to merge rather than failing silently.
- **The kill switch works.** `init` copied templates byte-for-byte, leaving
  `__PROJECT_NAME__` in six places — including `stop-flag.mjs`, so the brake
  looked for `~/.claude/__PROJECT_NAME__-loop-STOP` while the operator, following
  the instructions in the same install, created `~/.claude/<repo>-loop-STOP`. It
  never fired, and never said so.
- **The installed `CLAUDE.md` describes the repo it landed in.** It used to be
  the generated monorepo's map — `packages/core/`, `apps/web/`, links to an
  `architecture.md` and two guards that `init` deliberately does not install. It
  is now its own document: what was installed, what was not, and that the
  architecture rules are yours to write.
- **The elevated-path block names paths that exist.** It seeded
  `packages/db/src/` into repos that have no such directory, so the Tier-2 gate
  sweep reported "clean" while looking at nothing.

### Added

- A template test that fails if anything `init` installs references a `.claude`
  file `init` does not install — the drift that produced three of the four
  findings above, now mechanical.

## 0.3.0

The factory extraction: a scaffolded project now arrives with a working
autonomous loop and the mechanisms that watch it, rather than an empty `.claude/`.

### Added

- **`guard-bash` hook** — the "Never" tier made mechanical: force-pushing or
  deleting a shared branch, a direct push to the default branch, a production
  deploy trigger, a catastrophic delete. It **parses** the command (quotes
  honoured) instead of pattern-matching, so a commit message that mentions a
  forbidden flag is prose, not a bypass.
- **A kill switch that is a real file.** `touch ~/.claude/<project>-loop-STOP`
  and no merge lands until it is removed. Everything short of the merge stays
  allowed on purpose — stopping cleanly must not mean losing work.
- **The queue seam.** `loop` no longer reads one tracker: selection goes through
  `.claude/scripts/queue/`, with a pure core (filters, blocker resolution, tier
  ration, sort, stop conditions) and three adapters — `plan-md` (the default; the
  only one that works before a project has a remote), `github-issues`, `jira`.
- **Two sweeps that run outside any session** — `detect-missed-gate` finds merges
  that crossed an elevated path with no recorded reviewer verdict;
  `reconcile-external-prs` accounts for work that reached the default branch
  outside the queue. Both exist because a run cannot report its own missed gate.
- **`preflight`** — the pre-run checks, which also print the items it did _not_
  check, every time.
- **Skills** — `worktree-task` (isolation when a second session may run) and
  `new-invariant` (a generator for the invariant→hook→test pattern, with a
  working example and its test).
- **`rules/invariants.md`** — the pattern behind every hook here, stated once, so
  the hooks read as examples rather than as laws.
- **`aws-cdk` target extras** — the `ro-debug` skill (read-only runtime
  investigation, with the traps that produce confident wrong diagnoses) and the
  transferable AWS rules.
- **`elevated-paths`** — a declaration in `CLAUDE.md`, composed with any block in
  `.claude/rules/`, naming the paths where Tier-2 changes live.

### Changed

- The governance summary counts `.mjs` hooks only — a config file listed as an
  enforced hook overstated the one number this tool exists to make credible.
- `autonomy.md`: the tier is decided by what a change **touches**, not by what
  the task predicted it would touch.

### Fixed

Four review rounds, ten reviewers, on this release's own code. What they caught,
each reproduced before the fix and re-verified after:

- a PR body could **forge its own reviewer verdict** and suppress the gate sweep
  — the body is written by the actor being audited, so only the `human-review`
  label (which needs repository permission) suppresses now;
- the `plan-md` adapter's close **deleted the wrong line**, destroying a human's
  Operator-queue entry and leaving the shipped item selectable;
- every `github-issues` write **threw on success** (those `gh` subcommands print
  text, not JSON) — `escalate` posted its diagnosis and then died before applying
  the label that stops the item being re-picked;
- the kill switch could be **disarmed by an env variable**, and was fixed in the
  hook while the identical hole sat in `preflight` — the brake now has one
  implementation;
- three **total bypasses** in the guard, each an exception inside its own work
  that the fail-open catch turned into "allow": an unbounded spread, a recursive
  brace expansion, and a quadratic path collapse;
- a heredoc pre-pass that could **hide any command** from every rule;
- a ReDoS in the blocker parser reachable by anyone able to open an issue.

Rounds 4 and 5, on the fixes themselves:

- a here-string (`cat <<<X`) and an arithmetic left shift (`$((1<<n))`) were each
  read as heredoc markers, **hiding every command up to the next matching line**;
- `git commit -nm "msg"` bypassed the pre-commit gate outright — the one thing
  that hook exists to stop, in the spelling people actually type;
- with the kill switch armed, `git merge feat/x && git push` still landed a merge
  on the default branch; a push must now name its ref while stopped;
- pointing `HOME` at an empty directory disarmed the brake; it is now found
  through the password database as well as the environment;
- `gh --json files` truncates at 100 with **no marker**, and the gate sweep read
  the short list as "touched nothing elevated" — a PR padded past 100 files hid
  its elevated change. The sweep now compares against `changedFiles`;
- declaring `.claude/` elevated was a no-op, because every `.md` under it counted
  as inert — so a merge rewriting the autonomy tiers passed the gate meant to
  catch exactly that;
- a quadratic reviewer-name regex cost ~4 s per crafted PR body, minutes across a
  sweep that reports nothing when killed.

The README's enforcement claims were overstated and are now scoped to what the
guard actually inspects, with the omissions listed in the hook itself: only `rm`
for deletes, only a workflow dispatch for deploys, only a push that names its
branch, and nothing carried as a flag value.

The lesson that generalises is now a rule (`invariants.md`): **a guard that fails
open must do provably bounded work**, because fail-open makes every line of work
a potential total bypass — and prefer deleting a rule to adding one.

## 0.2.0

Distribution hardening (file modes, the `gitignore`→`.gitignore` trick, a
pack-path e2e per target), agent-os v2 (`pr-ship`, `post-deploy-verify`,
`cdk-diff-reviewer`, review-context isolation, session staleness), the `apps/web`
frontend proving core purity across the wire, the `gate-stop-dod` and
`inject-rules` hooks, `agent-rig init`, the `loop` skill, and the dev deploy
workflows.

## 0.1.0

First release: the CLI, `agent-os/universal` + the `node-ts`/`aws-cdk` stack
layers, and the `aws-serverless` and `node-service` targets.

---

## Releasing

`npm publish` needs 2FA and cannot be undone, so an agent prepares a release and
**stops at the first step it is not allowed to take** — normally `npm publish`,
sometimes earlier (step 6). Everything before that is mechanical:

1. `pnpm test` — the full suite, including the e2e that generates both targets
   cold and runs their own checks through the git path **and** the pack path.
2. `npm pack --dry-run` — confirm the templates, including the dotted `.claude/`
   tree, are in the tarball. This is where scaffolders break, and the git path
   cannot catch it.
3. Version in `package.json` (and the private inner package, kept in step).
4. **Record where the previous release was published from, then regenerate
   the released-hash table.** `templates/release-ledger.json` maps each released
   version to the commit it was published from; the entry for the release
   _before_ this one is written now, because a commit cannot carry its own sha:

   ```sh
   npm view create-agent-rig@<previous> gitHead   # → the sha for the ledger
   node scripts/build-hash-history.mjs             # rebuilds the table from it
   ```

   The builder reads every `## X.Y.Z` this file lists below the version in
   `package.json` and **refuses, naming the version and that command**, when
   the ledger has no entry for one — it never drops a release silently, since a
   dropped release is one `upgrade` can no longer recognise. A value of `null`
   is the one other answer: the published bytes are not recoverable from git
   (0.1.0 was published from a commit whose `package.json` already read
   0.2.0), so that version deliberately gets no row. Pinned in
   `test/template/hash-history.test.ts` › "throws for a released version the
   ledger does not mention, naming the version and the npm command" and ›
   "points at a commit whose package.json carries that version".

5. This file, and `PLAN.md` if the plan's claims changed.
6. **`pnpm test` again — this run, not step 1, is the one that can catch a
   stale hash table.** The check compares the table against the versions this
   file lists below the one in `package.json`, so before steps 3–5 it is
   comparing the _old_ release to the _old_ table and passes either way. A
   guard that can only fire after the thing it guards has changed has to be run
   after it.
7. **Tagging is not part of this project's release process** — standing owner
   decision, recorded at 0.5.0: the owner publishes by hand and does not tag.
   Since 0.6.0 (AR-35) that costs nothing: the table is built from the ledger in
   step 4, not from tags, and a `v*` tag is neither required nor trusted. One
   that exists and points elsewhere than the ledger — `v0.4.0` does, at 0.3.2's
   content — is printed as a warning by the builder and changes nothing:
   `test/template/hash-history.test.ts` › "builds the table from the ledger
   alone — tags are a warning source, never an input".

8. **Owner:** `npm publish` — and immediately before it, from the checkout you
   are about to publish from:

   ```sh
   node scripts/release-preflight.mjs   # exit 0, or it names what to fix
   ```

   It checks the manifests, the ledger, the checkout, and the tarball `npm pack`
   would actually produce. What it looks at is the code, not this list; what it
   cannot see is stated in its own header. It is a preflight, not a gate —
   nothing runs it for you, and exit 0 is not a verdict on the release.

9. **Owner:** smoke the published artifact — `npx create-agent-rig@<version>` in
   an empty directory, then `pnpm install && pnpm check` inside it; and
   `upgrade --dry-run` in a rig installed from the previous version.
