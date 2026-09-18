# create-agent-rig

Configure an **agent operating system** for Claude Code and Codex — rules,
review gates, and hooks; the wired hooks enforce the configured process
mechanically rather than by prose. It is a harness configurator, not an
application generator: it never scaffolds application code.

The same Agent OS is native to both **Claude Code and Codex**. Claude-facing
files remain the authoring surface; the generator derives Codex's `AGENTS.md`,
repository skills under `.agents/skills/`, custom agents under `.codex/agents/`,
and `.codex/hooks.json`. `node scripts/sync-codex-adapter.mjs --check` refuses
drift between the two projections.

```sh
npx create-agent-rig my-app   # mkdir + git init + the rig, into a new directory
```

There is exactly one payload — no `--target`, no application skeleton to
choose between. `--no-git` skips the initial baseline commit; `--no-color`
(and `NO_COLOR`) plainens the output. Pinned in
`packages/cli/test/create.test.ts` › "makes the directory and installs the one
payload into it" and `test/e2e/generate.test.ts` › "rejects retired --target
without creating the requested directory".

Already have a repo? Install the same payload into it directly:

```sh
npx create-agent-rig init            # rules, gates, stop rules into the current repo
npx create-agent-rig init --dry-run  # print the plan, write nothing
```

`create <dir>` is a thin convenience wrapper over exactly this: make the
directory, initialize Git, run `init` inside it, then commit the pristine
baseline. The ordering is pinned in `packages/cli/test/create-order.test.ts` ›
"initialises Git before handing the directory to init"; the baseline is pinned
in `packages/cli/test/create.test.ts` › "initialises git with a
pristine-template baseline commit".

`init` drops in the autonomy tiers, stop rules, workflow, and the enforcement
hooks — **wired** for both harnesses, in `.claude/settings.json` and
`.codex/hooks.json`, each naming exactly the hooks it installed — plus matching
`CLAUDE.md` and `AGENTS.md` maps that describe the rig itself, never an
application shape it does not know your repository has. It refuses to clobber
either existing map; if the repo already has a Claude or Codex hook config, it
keeps it and prints the entries to merge, because a hook nothing calls is not
enforcement.

Pinned in `test/e2e/init.test.ts` › "leaves a rig whose hooks are wired and
whose scripts parse", › "tells the operator when it could not wire the hooks
itself", and › "tells the operator when it kept existing Codex hook wiring".

Two things it deliberately leaves to you, and says so in the installed
maps: the Definition-of-Done gate has no `dod-checks.json` (it cannot know
your commands), and the elevated-path list names only what every repo has.

After generation or upgrade, review the checked-in `.codex/hooks.json` in Codex's
`/hooks` view and explicitly trust it if Codex presents a trust prompt. The
[official Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
records trust against the current hook hash, so a changed hook definition may
require that review again; the adapter does not silently replace user-owned hook
configuration.

## Upgrading a rig you already have

A release changes files, and `init` only ever _adds_ — so bringing an existing
rig forward is its own command:

```sh
npx create-agent-rig@latest upgrade --dry-run  # print the plan, write nothing
npx create-agent-rig@latest upgrade            # print the plan, then ask before writing
npx create-agent-rig@latest upgrade --yes      # the answer up front (required off a terminal)
```

It replaces the files the rig installed **and you have not touched**, installs
what the release added, and **reports everything else** — no three-way merge, no
patching. Silently merging your edits into the documents an agent loop obeys is
how a rig quietly stops meaning what you think it means; a conflict report is how
it does not. Each conflict names the file, why it was kept, and the path to the
new version so you can diff it yourself.

How it knows: `create` and `init` write `.claude/.rig-manifest.json` — the rig
version plus a hash per installed file. A file `init` found already in place and
left alone is recorded separately, under `kept`, with the hash of the bytes it
found, and never as the rig's (`packages/cli/test/init.test.ts` › "records what
it kept, with the sha256 of the bytes actually on disk — never in `files`"). An
`upgrade` conflict on such a file says it was kept by init and whether it was
edited since (`packages/cli/test/upgrade.test.ts` › "says "edited since"
instead, once the disk sha no longer matches what init recorded"). **Commit it**; without it in the
repository the command is blind on CI and on a colleague's machine. Rigs
installed before 0.4.0 have no manifest, so the package also carries the hashes
of every release whose published commit is on record (0.2.0 onward — 0.1.0's
published bytes are not recoverable, and a rig from it reports every file as
yours) and recognises a file matching one of them. The record is
`templates/release-ledger.json`, written at the release _after_ the one it
describes, so the newest release is never in the table a rig installed from it
carries — one more reason committing the manifest is the sentence in bold above
and not an aside.

`.claude/settings.json` is replaced only when the manifest's recorded hash
proves the rig wrote those exact bytes and you have not touched them — the case
where a release adds a hook and the wiring that calls it. Anything else, and it
is where your own hooks live: the new wiring is printed for you to merge, never
written. Unlike every other file, a match against the released hashes is not
enough for this one, and a replacement that would stop calling a hook the
current wiring names — while that hook's file is still in `.claude/hooks/` — is
handed over instead.

### Registering Memory on this machine

Memory is a separate subsystem with its own version; the rig never imports it
and never searches for it. `setup` records where it is, once per machine:

```sh
npx create-agent-rig@latest setup --memory-root ~/claude-config             # the checkout that holds shared-memory/memory.mjs
npx create-agent-rig@latest setup --memory-root ~/claude-config --dry-run   # handshake only, write nothing
```

It derives the invocation from that one root, runs Memory's `--version --json`
first, and refuses a foreign contract major with exit 4 before writing anything.
What it writes is one machine-scoped manifest —
`~/.config/create-agent-rig/subsystems.json` (`%APPDATA%\create-agent-rig\` on
Windows) — carrying the invocation, the required contract major, the pinned
Memory ref (`--memory-ref`) and the version the handshake observed. `upgrade`
re-runs the same derivation when the manifest exists; it never creates one. The
behaviour is pinned in `packages/cli/test/setup.test.ts` and
`packages/cli/test/subsystems.test.ts`; the seam itself is ADR-RP-002 R6
(`docs/decisions/memory-rig-boundary.md`).

Both bins answer the same handshake, and the rig consumes Memory only through it
(RP-19):

```sh
npx create-agent-rig@latest --version --json          # {"schemaVersion":1,"name":"create-agent-rig","version":"…","contractVersion":"1.0"}
npx create-agent-rig@latest memory doctor --json      # handshake first, then Memory's doctor, answer passed through unchanged
npx create-agent-rig@latest memory load --json --cwd .   # same, for load (`--cwd`: Memory's own contract, per its owner — RP-183); arguments pass to Memory verbatim, plus `--timeout-ms 45000` when you name none
```

`memory` reads the manifest above, runs Memory's `--version --json`, and only
then the verb: a foreign contract major exits 4 and the verb never runs; no
manifest (or an executable that has moved) is `unsupported`/`absent`, exit 0;
an executable that answers but not as the manifest promised — a broken
`VERSION`, a malformed handshake — is `integration-failed`, exit 1, never
"absent". Pinned in `packages/cli/test/memory.test.ts` and
`packages/cli/test/cli-version.test.ts`.

**A file you deleted stays deleted.** The rules invite you to delete the ones
whose invariant your project does not have, so an upgrade that quietly restored
them would be undoing your work. With a manifest that is direct — it names the
file, the disk does not have it, and the manifest is _evidence_, not a command.
Without one, the shipped table answers instead: a file that was in every release
it covers was there to be removed. The single case nothing can tell apart is a
file a **later** release added, which your rig never had — that one is installed,
and `--dry-run` lists it before anything is written.

**A file this release no longer ships is `retired`, not deleted.** A rig
generated before 0.10 may have paths from a per-target overlay this version no
longer composes (0.10 retired application scaffolding entirely — see
`CHANGELOG.md`). Such a path is never written and never deleted: it drops out
of the manifest's `files`, the report says it is no longer shipped, and it is
now yours to keep, edit, or remove on your own schedule. Pinned in
`packages/cli/test/upgrade.test.ts` › "retires a stack-overlay path this release
no longer ships — never written, never deleted" and
`test/e2e/upgrade.test.ts` › "retires the deleted stack overlay, and preserves
the application and the process layer".

### Conformance runner

`contracts/conformance/v1/` holds the JSON schemas of the command contract's
`--version --json`, `doctor --json` and `load --json` answers, and
`scripts/memory-conformance.mjs` checks a Memory checkout against them:

```sh
pnpm build
node scripts/memory-conformance.mjs --from <claude-config checkout> --json [--out report.json]
```

It is offline by construction — `--from` is mandatory, nothing is fetched, no
credential is read — and it never imports Memory code or copies a Memory
fixture into this repository (`test/template/memory-conformance.test.ts` ›
"carries no fetch, clone or credential: the checkout is always the caller's"
and › "the repository carries no Memory fixture"). The contract directory is
this repository's own, not a rig payload: `create`, `init` and `upgrade` do
not deliver it (`test/template/conformance-contract.test.ts` › "is not
delivered to rigs: no template carries a conformance contract"). The report's
rows, its `rigSha` / `memorySha` / `verifierDigest` fields and the `--out`
file are pinned by the same test file's › "passes every row against a
well-formed local fixture root and names both SHAs and the verifier digest"
and › "derives verifierDigest from the runner, its validator and the contract
files, in that order, and writes the same report to --out". The authoritative
cross-repository run lives in the private `claude-config` repository, which
checks this repository out at an explicit full SHA and runs the command above
against its own tree; the CI here runs only the offline tests.

## What you get

**A system of boundaries, each held by tooling.** An agent (or a human using
one) cannot talk its way past them — each guard is a pre-write scan that stops
the normal path cold (review and tests back it; the claim is stated exactly,
never inflated). The hook implementations live once in `.claude/hooks/` and are
wired by both `.claude/settings.json` and `.codex/hooks.json` — except the two
marked Claude Code, which only `.claude/settings.json` wires:

- **`guard-rulebook`** — in an unattended run (a flag file the `loop` skill
  writes at claim time), refuses an edit to the rulebook — hooks, wiring,
  `queue.json` and its board selector, the queue adapters, the router, the gate sweep, the rules,
  `CLAUDE.md` — outside the current item's allow-list; does nothing in an
  attended session.
- **`guard-secret-file`** — refuses an edit that writes a credential: either the
  path names one (`jira.env`, `id_rsa`, anything under `secrets/`) or the text
  carries a credential VALUE. Both arms read one vocabulary,
  `.claude/scripts/lib/secrets.mjs`, and a refusal names the pattern and the line
  and **never the matched value** — printing it would leak the secret in the act
  of refusing it. Its blind spots are in its own header, each naming the
  test that pins it or saying plainly that none does — and those tests live in
  this generator, not in the rig;
- **`block-no-verify`** — refuses bypassing pre-commit checks (and knows the
  difference between using the `--no-verify`/`-n` flag and merely mentioning it
  in a message);
- **`guard-bash`** — refuses the part of the "Never" tier a text scan can decide:
  a force-push or `--delete` naming a shared branch, a push that names the default
  branch, `gh workflow run`/`gh api …/dispatches` against a production workflow,
  and `rm` on a catastrophic target. It **parses** the command rather than
  pattern-matching it, so a commit message mentioning a forbidden flag is prose,
  not a bypass — and the file states exactly what it does **not** inspect
  (an infrastructure CLI driving a production deploy directly, `find -delete`,
  a bare `git push`, and more);
- **`gate-stop-dod`** — refuses to end the session while a Definition-of-Done
  check is red; it fails open (a missing or corrupt config never makes the
  session unquittable) and never blocks twice in a row;
- **`inject-rules`** — re-injects the autonomy rules at session start, so they
  survive compaction and resumes: the whole file, minus the regions the file
  itself marks as reference. What is left out is a decision written in
  `autonomy.md` on the line above it, not one this hook infers;
- **`guard-subagent-model`** (Claude Code) — refuses an `Agent` dispatch that
  passes a call-site `model` for a subagent whose definition pins one: the
  definition, not the call, decides which model a gate reads with;
- **`warn-subagent-routing`** (Claude Code) — at session start, warns when
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set (it replaces every model pin below),
  when `CLAUDE_CODE_EFFORT_LEVEL` is set (it replaces every effort pin), when
  Claude Code is older than 2.1.251 (the unnamed default then replaces the model
  pins), or when its version cannot be read (so the pins cannot be confirmed to
  hold). It warns and never blocks.

**A brake that is a real file.** `touch ~/.claude/<project>-loop-STOP` and no
merge lands until it is removed — enforced at the tool layer, so it holds even if
nothing reads the rule. Everything short of the merge stays allowed on purpose:
finish the task, push the branch, open the PR, write the journal. Stopping
cleanly must not mean losing work.

**Two sweeps meant to run outside any session** — nothing schedules them for you;
that is deliberate, because a check a run performs on itself is one a hurried run
skips. `detect-missed-gate` finds merges
that crossed an elevated path with no recorded reviewer verdict;
`reconcile-external-prs` accounts for work that reached the default branch outside
the queue. They exist because the one failure a run cannot report is its own
missed gate — the run that skipped it is exactly the run that will not mention it.

**A queue behind an adapter.** The `loop` driver selects through
`.claude/scripts/queue/`: a pure core (filters in order, blocker resolution, the
elevated-tier ration, stop conditions) with adapters for `PLAN.md` (the default,
working before a project has a remote), GitHub Issues, and Jira. Two rules are
load-bearing and tested from both directions — **blockers resolve from links,
never labels**, and **the agent never files its own work items**.

Around all of it: **autonomy tiers** (what an agent does alone / after review /
never), **stop rules** (three strikes, flaky ≠ retry, session staleness),
**subagent gates** (`test-writer`, `code-reviewer`, `security-scanner`,
`prose-reviewer`), **skills** (`pr-ship` pre-merge gate;
`loop` queue driver; `worktree-task` for concurrent sessions; `new-invariant`, a
generator for the invariant→hook→test pattern; `check-premises` for verifying
a queue item's own claims), and matching one-page `CLAUDE.md` / `AGENTS.md`
maps a fresh session orients by.

**Each gate reads with a pinned model and effort**, so a SHIP does not change
meaning with whatever model the session was started on. `code-reviewer` and
`security-scanner` pin `claude-opus-5`; `test-writer` and
`prose-reviewer` pin `claude-sonnet-5`; all pin `high` effort — and their Codex
profiles pin `gpt-5.6-sol` / `gpt-5.6-terra` from the same role table. A subagent
with no definition defaults to `claude-sonnet-5` through
`CLAUDE_CODE_SUBAGENT_MODEL` in `.claude/settings.json`; its effort cannot be
pinned and follows the session. The driver session's own model and effort stay
yours. To change a role in a generated project, edit `model:` / `effort:` in its
`.claude/agents/<role>.md` — and the matching `.codex/agents/<role>.toml` — in a
reviewed change; `upgrade` then reports the edited file as yours instead of
replacing it. Why these values, and what voids them: `docs/decisions/subagent-routing.md`.

**The hooks are examples, not laws.** `.claude/rules/invariants.md` states the
pattern behind each one — a stated invariant, a mechanical check, a test for the
check — so you can delete the ones whose invariant your project does not have and
spend the slot on one it does. An inherited rule nobody chose is worse than an
empty rule file: the empty one is visibly incomplete, the inherited one is
invisibly wrong.

## What it deliberately does not do

No application skeleton, no target to choose, no scaffolded code of any kind.
No authentication, design system, state manager, i18n, analytics, error
tracking, or cloud promise — none of that is a rig's business either. A rig
that configures agent harnesses makes no promise about your application's
architecture; if your project has a boundary worth enforcing mechanically
(a pure core, a storage seam, a service boundary), the `new-invariant` skill
walks you through writing that hook yourself, in your own repository.

## The 2-minute demo

```sh
./demo.sh   # from a clone of this repo
```

installs the rig into a scratch directory, with its pristine baseline commit
→ **an attempted pre-commit bypass is refused live by a hook**:

```
== 2/2 an agent tries to bypass pre-commit… ==
…and the block-no-verify hook REFUSED the edit at the tool layer (exit 2). ✔
```

## Requirements

- Node ≥ 20. The CLI carries zero runtime dependencies — the
  `npx github:…`, tarball, and published-package paths all work.

## How it stays honest

The template is real, tracked content, and every e2e run generates a fresh
repository from it and exercises the installed rig cold; the pack-path and
git-path installs are both under test, because that is exactly where
scaffolders break. A grep-test keeps the universal rules free of any cloud
provider or infrastructure vendor mention; the hook-blocking behavior itself
is under test. This repo dogfoods its own rulebook — the Claude and Codex
projections are composed from the same templates a generated rig receives,
plus this repository's own node-ts conventions, and drift fails the suite.

**And the enforcement layer is adversarially reviewed, not just tested.** The
Bash guard went through four review rounds with ten reviewers, who executed it
rather than read it. They found a PR body that could forge its own reviewer
verdict, a queue write that deleted the wrong line, and three ways to make the
guard crash into permitting everything. Each round's findings — including the
ones introduced by the previous round's _fix_ — are in the git history and in
`CHANGELOG.md`. The rule that came out of it is now part of what ships: a guard
that fails open must do provably bounded work, because fail-open turns every line
of its own work into a potential bypass.

Development (from a clone — `PLAN.md` and `demo.sh` live in the repository, not
in the published tarball): `pnpm test` (full), `pnpm test:unit` (fast loop),
`pnpm test:smoke` (the unit project only — the Windows pull-request lane). The
plan of record is `PLAN.md`; release notes and the release checklist ship in
`CHANGELOG.md`.
