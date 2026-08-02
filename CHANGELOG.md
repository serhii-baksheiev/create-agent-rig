# Changelog

Notable changes per release. The generated projects are the product, so an entry
says what a **newly scaffolded project** gains or loses — not what moved inside
the generator.

Versions are published to npm as [`create-agent-rig`](https://www.npmjs.com/package/create-agent-rig);
`npx github:serhii-baksheiev/create-agent-rig` keeps working for either path.

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
**stops at that command**. Everything before it is mechanical:

1. `pnpm test` — the full suite, including the e2e that generates both targets
   cold and runs their own checks through the git path **and** the pack path.
2. `npm pack --dry-run` — confirm the templates, including the dotted `.claude/`
   tree, are in the tarball. This is where scaffolders break, and the git path
   cannot catch it.
3. Version in `package.json` (and the private inner package, kept in step).
4. `node scripts/build-hash-history.mjs` — regenerate the released-hash table
   from the tags **after** the version bump, so the version now shipping is the
   first one it excludes. A template test fails while it is stale; forgetting it
   would leave `upgrade` unable to recognise the previous release.
5. This file, and `PLAN.md` if the plan's claims changed.
6. `git tag v<version> && git push --tags`.
7. **Owner:** `npm publish`.
8. **Owner:** smoke the published artifact — `npx create-agent-rig@<version>` in
   an empty directory, then `pnpm install && pnpm check` inside it.
