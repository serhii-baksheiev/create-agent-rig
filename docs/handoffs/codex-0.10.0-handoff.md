# Handoff — release 0.10.0 loop, for continuation in Codex

**Written:** 2026-09-17, at the end of a Claude Code session that ran out of budget.
**Base of everything below:** `master` = `872f7f6` (`docs(journal): record RP-121, RP-158 and the 0.9.1 release candidate (#225)`).
**0.9.1 is published** — `npm view create-agent-rig version` → `0.9.1`, `dist-tags.latest` → `0.9.1`.

This file is the durable state of the loop. It is written to be read cold: it
states what is true, what is only claimed, and what the next session must do
first. Where a fact was measured, the command that measured it is given.

---

## 1. Release goal

0.10.0 is the last feature release before the 1.0 contract freeze. Rig becomes a
package manager and composition layer for repository-scoped Claude Code and
Codex configuration. It configures harnesses; it does not generate applications
and does not reimplement what a harness, a plugin or an official CLI already
does.

**Core keeps:** `init`, manifest-aware `upgrade`, raw-byte ownership, conflict
reporting, "deleted stays deleted", portable project wiring, the security
guards, `doctor`, safe `uninstall`, installation and registration of supported
external solutions through official channels, receipts and provenance, and the
existing external-executable subsystem compatibility (the published 0.9
contract: `subsystems.json`, the version handshake, contract-major exit 4,
bounded pass-through).

**Non-goals (do not build):** scheduler, universal queue, workflow DSL,
cross-session transport, a new orchestration runtime, provider
marketplace/SDK, Memory engine, Agent Bus/Relay, AMQ/AMAQ, application
scaffolding, exactly-once/CAS for Jira, distributed multi-controller.

**Profiles:** `solo` (native harness capabilities and native memory; no
Python/uv, no paid service, no external Memory package) and `product` (optional
Spec Kit, Figma MCP, GitHub Issues or Jira/Atlassian MCP, coordinated team mode;
native memory stays the default). OpenSpec and BMAD are alternatives to Spec
Kit, never additive owners of the same stage. Superpowers stays experimental and
is not combined with Spec Kit without proven non-overlapping ownership.

**Memory providers:** `native | basic-memory | custom-executable`. Basic Memory
and custom executables are external opt-ins. New Memory development does **not**
block 0.10.0: RP-8, RP-58, RP-83, RP-109 and RP-115 relate to RP-92 through
`relates to`, not `blocks`, and must not be returned to the release gate.

**Frozen:** revalidation and claim-records do not change until the RP-26 ruling
on RP-53, scheduled 2026-10-27. RP-175 is not 0.10.0 work. There is no 0.9.2.

---

## 2. The gate and its real blockers

`RP-92` is the only release gate. Its blockers, with the state they were left in:

| item                                              | state on 2026-09-17                   | where the work is                                                                 |
| ------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------- |
| RP-177 remove app skeletons, thin `create`        | **In Progress, uncommitted**          | WSL clone `~/rig-177`, branch `feat/rp-177-remove-app-skeletons` (no commits yet) |
| RP-178 compatibility matrix, benchmark removal    | **In Progress, PR #227 open**         | WSL clone `~/rig-178`, head `601970d` pushed                                      |
| RP-179 plugin-first delivery                      | To Do, not started                    | research brief only (see §7)                                                      |
| RP-180 workflow layer becomes experimental opt-in | To Do, not started                    | —                                                                                 |
| RP-181 ownership-bounded uninstall                | **In Progress, PR #226 open**         | WSL clone `~/rig-181`, head `e98199e` pushed                                      |
| RP-22 composition/setup with receipts             | To Do, not started                    | research brief only (see §7)                                                      |
| RP-21 doctor                                      | To Do (reset this session)            | —                                                                                 |
| RP-24 clean-machine acceptance                    | To Do, runs last on the candidate SHA | —                                                                                 |

`RP-88` (the release ticket) is In Progress.

### Jira graph changes made this session

- `RP-88` → In Progress.
- `RP-21` → back to To Do (comment 18531). Its In Progress state was stale: the
  only branch, `feat/rp-21-product-doctor` @ `e327a4e`, carried a take-up claim
  baseline written 2026-09-13, before the ticket's scope was rewritten
  2026-09-14, plus uncommitted Red-step tests. That branch and its worktree were
  deleted; the old tests are kept as `rp21-old-wip.patch` (see §6).
- The direction `RP-21 blocks RP-22` was **reversed**: it is now
  `RP-22 blocks RP-21`, verified from both sides. Doctor must diagnose the
  profiles and receipts that setup defines, so receipts stabilise first.
- `RP-177`, `RP-178`, `RP-181` → In Progress with take-up comments.

⚠ Jira links, not labels, define blockers. `relates to` is not a block. After
any graph edit, re-read the link from both issues — a `POST /rest/api/3/issueLink`
treats `inwardIssue` as the **blocking** side, which is the opposite of what the
field name suggests.

---

## 3. Open pull requests

### PR #226 — RP-181, `create-agent-rig uninstall`

- Branch `feat/rp-181-uninstall`, head **`e98199e`**, draft.
- **Scope as it actually stands:** `planUninstall`/`applyUninstall` plus CLI
  wiring; removal only of manifest-owned paths whose hash still matches;
  `preserved` for modified, `line-endings-only`, kept-by-init, wiring-modified
  and symlinked paths; `absent` for already-deleted; empty-parent cleanup that
  stops at `.rig`; dry-run and `--json`; a partial failure reports
  completed/remaining; docs in `README.md`, `docs/command-contract.md`,
  `CHANGELOG.md`; 24 unit + 7 e2e cases.
- **Checks performed:** on `e98199e`, in `~/rig-181`, independently re-run by
  the lead — `pnpm lint`, `pnpm typecheck`, full `pnpm test`: **130 files, 4363
  tests passed, 4 skipped, exit 0**. No CI run on the PR head was read.
- **Gate round 1 verdicts:** `code-reviewer` HOLD (4 blockers),
  `security-scanner` HOLD (3 blockers), `prose-reviewer` HOLD (4 blockers).
- **Uncommitted round-2 work exists** in `~/rig-181` (10 files) — see §6.

### PR #227 — RP-178, compatibility matrix

- Branch `feat/rp-178-compatibility-matrix`, head **`601970d`**, draft.
- **Scope as it actually stands:** deletes `packages/cli/src/policy/**`, the
  seven `scripts/policy-benchmark*.mjs`, `contracts/session-messaging/**` (44
  files), `docs/policy-benchmark.md` and 12 test files; adds
  `docs/compatibility.md`, `test/template/guard-acceptance.test.ts` (allowed and
  denied fixtures per guard per harness, executed through the shipped wiring
  strings) and `test/helpers/evidence-row.ts`; removes the `benchmark` vitest
  project and the RP-62 spawn-baseline CI steps. RP-82 and RP-110 fixed; RP-157,
  RP-160, RP-161 closed by deletion with a consumer graph.
- **Checks performed:** at `a04a8ef`, independently re-run by the lead in
  `~/rig-178` — lint, typecheck, full `pnpm test`: **118 files, 3421 tests
  passed, 4 skipped, exit 0**.
  🔴 The two newer commits (`6aba6fe`, `601970d`) passed `pre-commit`
  (`test:unit`) only. The **full** suite has not been run on `601970d`.
- **Gate round 1 verdicts:** `code-reviewer` HOLD (5 blockers),
  `prose-reviewer` HOLD (2 blockers), `security-scanner` SHIP (3 advisories).
- **Uncommitted round-2 work exists** in `~/rig-178` (2 files) — see §6.

### No PR for RP-177

The branch `feat/rp-177-remove-app-skeletons` exists **only inside `~/rig-177`**
and has **no commits** — the session was stopped mid-commit. All of its work is
an uncommitted working tree. See §6 before touching that clone.

---

## 4. Review results that are merge blockers

These came from cold-context reviewers and were confirmed by the lead where
stated. **Do not merge either PR on green CI alone** — every item below has to be
resolved or explicitly re-decided and recorded first.

### PR #226 (RP-181) — blockers

1. **Symlink traversal.** `resolveInside` is lexical only. A symlinked ancestor
   (for example `.claude/hooks` pointing outside the repository) let the command
   read through it and unlink a file outside the repository when the bytes
   matched. **Fixed in `e98199e`** by an `lstat` walk of every path segment plus
   a re-check before each unlink, with three tests. **Residual, still open:**
   `removeEmptyParents` does `readdir`/`rmdir` by joined path with no symlink
   check, so it can still `rmdir` an empty directory through a symlinked
   ancestor; and the symlink branch is documented nowhere in `README.md`,
   `CHANGELOG.md` or `docs/command-contract.md` (the contract's "per manifest
   path, in order" list presents itself as exhaustive and omits it).
2. **Raw-byte ownership hashing.** The manifest hashes `readFile(path, 'utf8')`
   — decoded text, not raw bytes — in `create`, `init`, `upgrade` and now
   `uninstall`. RP-178's acceptance explicitly requires raw-byte ownership
   hashing with `line-endings-only` as a separate verdict. Consequence today: a
   non-UTF-8 installed file can never match and is permanently
   `preserved: modified`. This is cross-cutting (it belongs to
   `packages/cli/src/lib/manifest.ts`, which RP-177 also edits) and was
   deliberately left to be decided once, not twice. **Decide and fix before
   either PR merges**, and record the decision in `docs/decisions/`.
3. **`removed` is wrong on a partial failure, and on a dry run.**
   `uninstallPayload` (`packages/cli/src/index.ts:395-401`) derives `removed`
   from the **plan** (`of('remove')`), never from `applyUninstall`'s
   `result.removed`. So a partial failure emits `removed: [a, b]` beside
   `remaining: [b]` and an error naming `b`; the contract fixture at
   `docs/command-contract.md:885-902` encodes that contradiction. The same
   derivation is what a dry run reports, so `removed` means "planned" there too
   while nothing was deleted, and no prose says so. Neither JSON payload has a
   test.
4. **The manifest is deleted even when nothing was removed.** On a CRLF checkout
   every file is `line-endings-only`, so the run deletes only the manifest,
   exits 0, and leaves the rig installed with its ownership evidence destroyed —
   `upgrade` is then blind and a repeat `uninstall` says "nothing to uninstall".
   `README.md` and `CHANGELOG.md` promise the opposite.
5. **No consent on a destructive run.** `applyUninstall` runs **before** the plan
   is printed, and there is no `--yes`, no confirmation and no non-interactive
   refusal — while `upgrade`, which only writes, has all three.
6. **A hostile manifest reaches `.git`.** Manifest keys are not restricted to
   rig-owned paths, so a manifest arriving in a pull request that pairs
   `.git/hooks/pre-commit`, `.husky/pre-commit` or `.github/workflows/ci.yml`
   with its true (publicly known) hash makes `uninstall` delete it. Also,
   `isSafeSegment` accepts ESC/CR/LF, and the plan prints path keys raw, so a
   crafted key can forge plan lines.
7. **Contradictions in prose:** `README.md:189-191`, `CHANGELOG.md:30` and the
   comment at `uninstall.ts:56` claim `.rig/` is never touched, while
   `.rig/revalidation.json` is in `layers.json`'s process layer and is removed
   on a hash match (`docs/command-contract.md:760-765` states this correctly);
   `docs/command-contract.md:596` still claims `--json` is read on `--version`
   only; the re-scoped "no file paths in any JSON" rule now contradicts its own
   three surviving statements at `:100-101`, `:364-365`, `:486-490`.

A full fix packet for all of the above was sent to the implementing agent; the
uncommitted tree in `~/rig-181` is a partial application of it (§6).

### PR #227 (RP-178) — blockers

1. **Rebase after RP-177.** RP-177 rewrites `packages/cli/src/commands/`,
   `templates/`, `package.json`, `vitest.config.ts`, CI and the rulebook. This
   branch must be rebased onto RP-177 **after** RP-177 merges, and its full
   suite re-run — not merged first because it is closer to done.
2. **Skeleton-only promises must go.** Once RP-177 removes the skeletons and the
   stack layers, any remaining promise in `docs/compatibility.md`, the CHANGELOG
   or the guard rows that a guard protects a generated application's shape —
   above all `guard-core-purity` and `guard-web-boundary`, which exist only for
   the app skeleton — is false. Re-check every row after the rebase and delete or
   re-point the rows whose subject no longer ships.
3. **Windows evidence must be honest.** `guard-acceptance.test.ts` executes on
   POSIX only (`posixShellAvailable`); on Windows it asserts merely that the
   Windows command string is non-empty. The matrix must not read as Windows
   acceptance. Related: the same PR deletes the platform-skip site count while
   adding a suite that skips wholesale on Windows.
4. **Compatibility-matrix vocabulary.** `supported / degraded / unsupported`
   must mean one thing per row and each must carry an executable test pointer or
   an exact release-evidence pointer. Today the lead sentence claims every one of
   the nine guard rows has an allow/deny fixture through both wirings, while
   `gate-stop-dod` (Stop) and `warn-subagent-routing` (SessionStart) are not
   `PreToolUse` at all and `guard-subagent-model` is covered elsewhere; the doc
   also says "the six guards above" where Claude wires seven.
5. **The correspondence lost a direction** (partially addressed in `6aba6fe`,
   unverified): the deleted `policy-declaration.test.ts` asserted over the real
   shipped snapshots that every wired guard is declared; a hand-written fixture
   list cannot go red when a new guard is wired. `.claude/rules/invariants.md`
   requires that bidirectional check to land with the prose.
6. **Round-1 items not yet confirmed done:** the stale
   `RULEBOOK_PREFIXES` prose copy in `guard-acceptance.test.ts:205`; restoring
   `exactVersion` and the closed-shape check in `test/helpers/evidence-row.ts`
   (partially staged, uncommitted); deleting
   `docs/session-messaging-contract-v0.md` and
   `test/template/session-messaging-contract.test.ts` (lead decision: delete —
   Agent Bus / session messaging is outside the 0.10.0 boundary and git history
   keeps the design); dead "Pinned in …policy-coverage.test.ts" pointers in
   `docs/decisions/capability-coverage.md` (partially staged, uncommitted).

---

## 5. Merge order

1. **RP-177** first — it is the widest change and everything else rebases onto
   it. It needs commits, a PR, a gate round and a full-suite run before it can
   merge.
2. **RP-178** second — rebase onto the new `master`, re-run the full suite,
   re-check the matrix rows against the reduced product, finish the round-1
   blockers, gate again.
3. **RP-181** third — rebase, finish the seven blockers above (the raw-byte
   hashing decision is shared with RP-177 and should be settled in RP-177's PR),
   gate again.
4. Then wave 2 (RP-179, RP-180), wave 3 (RP-22 then RP-21), wave 5 (RP-24 on the
   exact candidate SHA), and only then RP-92 and the release.

Never merge on green CI alone. The criterion is: named required checks green
**for that exact head**, every blocking finding resolved, and the Definition of
Done in `.claude/rules/workflow.md` walked.

---

## 6. Working state — nothing here is committed, do not lose it

Windows main checkout `C:\Users\SerhiiBaksheiev\Documents\create-agent-rig` is on
`master` `872f7f6` and carries no work of this session. `git status` there shows
only two untracked files that predate this session
(`.rig/claims/RP-111.json.local`, `docs/rig-0.9.0-codex-loop-prompt.md`) and the
untracked, git-ignored run directory `.claude/runs/release-0100-20260917/`.

Implementation happens in **full Linux clones inside WSL**, because this Windows
host cannot finish `pnpm test:unit` (the Stop hook times out at 600 s on every
turn end) and committing from a linked worktree corrupts the shared repository.

| clone       | branch                             | committed                  | uncommitted                    |
| ----------- | ---------------------------------- | -------------------------- | ------------------------------ |
| `~/rig-177` | `feat/rp-177-remove-app-skeletons` | nothing (HEAD = `872f7f6`) | large, mid-commit when stopped |
| `~/rig-178` | `feat/rp-178-compatibility-matrix` | `601970d`, pushed          | 2 files (round-2 fixes)        |
| `~/rig-181` | `feat/rp-181-uninstall`            | `e98199e`, pushed          | 10 files (round-2 fixes)       |
| `~/rig`     | `master`                           | clean                      | —                              |

**Backup copies of every uncommitted tree** were taken with `git add -A -N` +
`git diff --binary` and exist twice:

- in WSL: `~/wip-rp-177.patch` (294 191 B), `~/wip-rp-177.staged.patch`
  (600 326 B), `~/wip-rp-178.staged.patch` (8 205 B), `~/wip-rp-181.patch`
  (55 410 B);
- on Windows, in the git-ignored run directory
  `.claude/runs/release-0100-20260917/wip/` (same four files).

The clones themselves are the source of truth; the patches are a second copy.
The same run directory also holds `HANDOFF.md` (the earlier, shorter note),
`research-providers.md` (§7) and `rp21-old-wip.patch` (the discarded RP-21
Red-step tests, whose manifest/handshake cases are worth reusing when RP-21 is
implemented).

⚠ RP-177's uncommitted tree includes deletions of `.claude/hooks/guard-core-purity.mjs`,
`.claude/hooks/guard-web-boundary.mjs` and `.claude/rules/architecture.md` in the
**dogfood** copy, plus edits to `CLAUDE.md`, `AGENTS.md`, `.claude/settings.json`
and `.codex/hooks.json`. That is intended by the ticket (the app-shape promises
retire with the skeletons), but it means the next session must re-run
`node scripts/sync-agent-os.mjs` and its `--check` before committing, and must
expect the rulebook guard (`guard-rulebook`) to have opinions in an unattended run.

---

## 7. Research already done (for waves 2 and 3)

`.claude/runs/release-0100-20260917/research-providers.md` holds a cited brief on
native plugin capabilities (Claude Code plugins, marketplaces, project-scoped
non-interactive install; Codex skills/`AGENTS.md`/`.codex/config.toml`/hooks) and
on official installers and licences for Spec Kit, OpenSpec, BMAD, Superpowers,
Figma MCP, Atlassian MCP, GitHub MCP and Basic Memory (AGPL-3.0 — keep behind an
external process boundary, never vendored).

🔴 Treat it as **unverified**: it was produced with very few tool calls, and its
claims must be re-checked against official documentation before any of them
becomes a provider descriptor, an installer invocation or a licence field in a
receipt. A wrong installer command in RP-22 is a change that touches a user's
machine.

---

## 8. What needs owner approval

- publishing to npm (the release itself);
- entering, creating or passing any credential or secret;
- any paid operation or acceptance of third-party terms of service;
- irreversible deletion of external data;
- force-pushing published history;
- changing the accepted 0.10.0 product boundary (§1);
- a confirmed contradiction that code, Jira and the accepted decisions cannot
  resolve.

Everything else — implementation, decomposition, branches, PRs, reviews, Jira
status and links, merges of green and gated PRs, tests, CI matrix, docs,
changelog, release ledger — is delegated.

---

## 9. Exact commands to continue

```bash
# WSL is where the work happens. -d Ubuntu is mandatory.
wsl -d Ubuntu -e bash -lc 'source ~/.nvm/nvm.sh; nvm use --silent 22; cd ~/rig-177; git status -sb'

# Resume RP-177 (its tree is already populated; nothing to apply):
wsl -d Ubuntu -e bash -lc 'source ~/.nvm/nvm.sh; nvm use --silent 22; cd ~/rig-177; \
  node scripts/sync-agent-os.mjs && node scripts/sync-agent-os.mjs --check && \
  node scripts/validate-no-secrets.mjs && pnpm lint && pnpm typecheck && pnpm test'
# then stage explicit paths (never `git commit -a`) and commit in the FOREGROUND;
# pre-commit runs the secret sweep, lint, typecheck and test:unit (~2 min).

# Recover a tree from the backup instead, if a clone is ever lost:
#   git checkout -B <branch> origin/master && git apply ~/wip-rp-177.staged.patch && git apply ~/wip-rp-177.patch

# Full verification of a branch head (this is the only trustworthy suite run):
wsl -d Ubuntu -e bash -lc 'source ~/.nvm/nvm.sh; nvm use --silent 22; cd ~/rig-178; \
  git fetch origin && git rebase origin/master && pnpm install --frozen-lockfile && \
  pnpm lint && pnpm typecheck && pnpm test'

# Route a diff before spending a gate round on it (from the Windows checkout):
node .claude/scripts/decision-router.mjs --base origin/master --head origin/<branch> --json

# Jira REST (the MCP connector is a different access and is not a substitute):
MSYS_NO_PATHCONV=1 node --env-file=C:/Users/SerhiiBaksheiev/.config/create-agent-rig/jira.env \
  <helper>.mjs GET /rest/api/3/issue/RP-92?fields=summary,status,issuelinks
# transitions: 11 To Do, 21 In Progress, 31 In Review, 41 Done
# a link POST treats inwardIssue as the BLOCKING side — verify from both issues after any edit

# Named-check merge criterion (never "some checks passed"):
SHA=$(gh pr view <n> --json headRefOid -q .headRefOid)
gh api "repos/{owner}/{repo}/commits/$SHA/check-runs" -q '.check_runs[] | select(.name=="ci") | .conclusion'
```

Windows-host facts worth carrying: the Stop hook runs `pnpm test:unit` in the
main checkout at every turn end and never finishes inside 600 s (`UNMEASURED`,
which is not a pass); stale `memory-sync.sh` bash trees from a global hook pile up
and must be counted and stopped before any timing is believed; `TaskStop` on a
background WSL command leaves the child alive, so kill it by command line.

---

## 10. Final note

**Date:** 2026-09-17. **master:** `872f7f6`. **Open PRs:** #226 (`e98199e`,
RP-181) and #227 (`601970d`, RP-178), both draft, both HOLD from gate round 1.
**RP-177:** implemented but uncommitted in `~/rig-177`.

**NEXT ACTION:** in `~/rig-177`, run
`node scripts/sync-agent-os.mjs && node scripts/sync-agent-os.mjs --check && pnpm lint && pnpm typecheck && pnpm test`,
fix what is red, then commit the RP-177 work in small single-purpose commits and
open its PR — RP-177 merges first and everything else rebases onto it.
