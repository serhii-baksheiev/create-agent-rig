# Changelog

Notable changes per release. The generated projects are the product, so an entry
says what a **newly scaffolded project** gains or loses — not what moved inside
the generator.

Versions are published to npm as [`create-agent-rig`](https://www.npmjs.com/package/create-agent-rig);
`npx github:serhii-baksheiev/create-agent-rig` keeps working for either path.

Numbering is ordinary semver — **additive is a minor, a fix is a patch** — so
that "I only take minors" remains a usable policy; 0.3.2 shipped additive
content as a patch by the owner's call and stays recorded as one.

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

8. **Owner:** `npm publish`.
9. **Owner:** smoke the published artifact — `npx create-agent-rig@<version>` in
   an empty directory, then `pnpm install && pnpm check` inside it; and
   `upgrade --dry-run` in a rig installed from the previous version.
