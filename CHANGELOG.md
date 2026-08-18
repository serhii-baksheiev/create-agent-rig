# Changelog

Notable changes per release. The generated projects are the product, so an entry
says what a **newly scaffolded project** gains or loses — not what moved inside
the generator.

Versions are published to npm as [`create-agent-rig`](https://www.npmjs.com/package/create-agent-rig);
`npx github:serhii-baksheiev/create-agent-rig` keeps working for either path.

Numbering is ordinary semver — **additive is a minor, a fix is a patch** — so
that "I only take minors" remains a usable policy; 0.3.2 shipped additive
content as a patch by the owner's call and stays recorded as one.

## Unreleased

### Added

- **Codex is now a native target of the Agent OS.** Generated and `init`ed
  projects receive `AGENTS.md`, repository skills in `.agents/skills/`, custom
  agent profiles in `.codex/agents/`, and portable `.codex/hooks.json` wiring.
  These files are derived from the Claude Code sources and drift-checked.
- Architecture guards now understand Codex `apply_patch` payloads and inspect
  only added lines, so removing an old violation does not create a false block.

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
  deprecation above: `--force` is refused in this same unreleased version, so
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
4. `node scripts/build-hash-history.mjs` — regenerate the released-hash table
   from the tags **after** the version bump, so the version now shipping is the
   first one it excludes. Forgetting it would leave `upgrade` unable to
   recognise the previous release.
5. This file, and `PLAN.md` if the plan's claims changed.
6. **`pnpm test` again — this run, not step 1, is the one that can catch a
   stale hash table.** The check compares the table against the versions this
   file lists below the one in `package.json`, so before steps 3–5 it is
   comparing the _old_ release to the _old_ table and passes either way. A
   guard that can only fire after the thing it guards has changed has to be run
   after it.
7. `git tag v<version> && git push --tags` — **first check that the tag does not
   already exist** (`git ls-remote --tags origin`). A leftover from an abandoned
   attempt is a published ref: deleting or moving it is an **owner** action, and
   the release stops here until it is gone. A tag pointing at the wrong commit
   is not cosmetic: the next release builds its hash table from it, so the table
   ends up **naming a version whose bytes it does not carry**, and everything
   that version actually changed is absent from it. A rig with a manifest is
   unaffected — the manifest is consulted first — which is exactly why the
   damage is quiet rather than loud.
8. **Owner:** `npm publish`.
9. **Owner:** smoke the published artifact — `npx create-agent-rig@<version>` in
   an empty directory, then `pnpm install && pnpm check` inside it; and
   `upgrade --dry-run` in a rig installed from the previous version.
