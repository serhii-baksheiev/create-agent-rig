# Changelog

Notable changes per release. The generated projects are the product, so an entry
says what a **newly scaffolded project** gains or loses — not what moved inside
the generator.

Versions are published to npm as [`create-agent-rig`](https://www.npmjs.com/package/create-agent-rig);
`npx github:serhii-baksheiev/create-agent-rig` keeps working for either path.

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
4. This file, and `PLAN.md` if the plan's claims changed.
5. `git tag v<version> && git push --tags`.
6. **Owner:** `npm publish`.
7. **Owner:** smoke the published artifact — `npx create-agent-rig@<version>` in
   an empty directory, then `pnpm install && pnpm check` inside it.
