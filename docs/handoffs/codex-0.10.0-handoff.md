# Handoff — release 0.10.0 loop

This is the cold-start record for the 0.10.0 release loop. It carries only what
does **not** change between sessions: the product boundary, the owner's
rulings, the sequencing constraints, the owner-only list, and the commands that
read live state.

⚠ **It deliberately carries no snapshot of PR or Jira state.** An earlier
version of this file kept a table of every item's status; it was stale within a
day, and a stale table is worse than none, because it reads like evidence.
**Repository heads and Jira are the authority.** Read them with §5 before you
act on anything here.

---

## 1. Release boundary

0.10.0 makes Rig a package-manager and composition layer for repository-scoped
Claude Code and Codex configuration. It configures harnesses; it does not
generate applications or recreate capabilities already supplied by native
plugins, MCP, skills, or official package managers.

Keep: thin `create`, manifest-aware `upgrade`, raw-byte ownership, conflict
reporting, deleted-stays-deleted behaviour, portable project wiring, security
guards, `doctor`, safe `uninstall`, and supported external-solution
installation and receipts.

Do not add: app skeletons, policy benchmark/evidence frameworks under a new
name, session messaging, a workflow runtime, a provider marketplace/SDK, or a
Memory release gate. Custom Memory providers remain optional external opt-ins.

`RP-92` is the release gate. Changing this boundary is owner-only (§4).

## 2. Sequencing constraints — the ones that are not obvious from the board

These are ordering facts, not status. They stay true until the work lands.

- **RP-180 waits for RP-181's merge.** RP-180 splits the single `process` array
  in `templates/agent-os/universal/layers.json` into a core layer and a
  workflow layer, and records the choice in the manifest, so it collides with
  RP-181's manifest work. Rebase RP-180 onto the merged RP-181 and resolve the
  overlap on the ownership model RP-181 settled — do not re-decide ownership.
- **RP-22 → RP-21 → RP-24, in that order.** RP-22 blocks RP-21; RP-24 is the
  clean-machine acceptance that consumes both.
- **RP-22 does not inherit a plugin-first promise.** RP-179 is a capability
  decision, not a migration; the ruling is recorded on RP-22 itself.
- **RP-179 is evaluation only.** Capability evaluation, bounded spikes, the
  architecture decision, the measured cost of the current tracked projection,
  and recommendations. The `AGENTS.md`/`CLAUDE.md` migration is its own ticket
  and must not appear in RP-179's diff.
- **Memory is not a 0.10.0 release blocker**, and Memory is not relocated into
  `packages/memory`.

## 3. `uninstall` — the three data-loss classes, so nobody re-derives them

`uninstall` deletes files from a repository on the evidence of a **committed**
manifest, which arrives in pull requests like any other file. Three ways that
went wrong. Each needs a regression test; this section records the shape of the
harm and the repro, not whether any one of them is currently open — that is on
the PR.

1. **Ownership drawn at a top-level path segment.** A manifest entry pairing
   any file under `.claude/`, `.rig/`, `docs/` or `journal/` with its true hash
   was treated as rig-owned and deleted. Repro: add `.claude/user-secret.txt`
   (or `.rig/run-state.json`) to `.claude/.rig-manifest.json` with that file's
   real sha256, run `uninstall --yes`, watch it disappear. The boundary is the
   install set's **exact** paths.
2. **The manifest itself read and deleted through a symlinked ancestor.**
   Repro: make `.claude` a symlink to a directory outside the repository
   holding a manifest; the plan reads it and the apply unlinks it outside the
   repository. The manifest goes through the same segment-by-segment walk as
   any owned path, at read and again before the unlink.
3. **A file changed between the plan and the apply is still deleted.** Repro:
   run `uninstall` (or `--dry-run` then `uninstall --yes`), edit a file the
   plan marked `remove` after the plan prints and after consent. The expected
   raw-byte hash must be carried on each `remove` action, re-read and compared
   immediately before each unlink; a mismatch preserves that one path with a
   "changed since planning" reason rather than deleting it or aborting the run.
   The same window applies to the manifest: its digest is recorded at plan time
   and verified before the first removal and again before the manifest unlink.

**A fourth shape, found later and worth the same treatment:** protecting a hook
file is not enough if the modules it imports are removed underneath it. A
surviving, still-wired hook that cannot import exits non-2 and is therefore
non-blocking — a brake that looks installed and is not. Protection has to
follow the transitive import closure, bounded to the install set.

**Windows junction / reparse points are a merge requirement, not a footnote**
(owner ruling, 2026-09-20). A written "not measured" is not acceptable for a
command that deletes data on a supported platform, and the guard must not rest
on being able to create a Unix-style symlink.

**The product model is settled** (owner ruling, 2026-09-20):

- an ordinary `uninstall` stays conservative; anything that cannot be removed
  safely makes the run **partial**, and the manifest is kept;
- `--detach` removes the manifest after the same safe cleanup, leaves every
  preserved file to the user, and prints the full handover list;
- `--detach` never deletes a conflicting or modified file, and there is no
  `--force` in RP-181;
- the JSON result distinguishes `uninstalled`, `partial` and `detached`
  explicitly.

## 4. Owner-only conditions

`npm publish`; deleting published remote branches; force-pushing shared history
outside a branch this loop was explicitly granted; external irreversible
deletion; secrets and credentials; paid operations or third-party terms;
owner-only repository settings; and a material change to the accepted 0.10.0
boundary (§1).

Everything else — implementation, decomposition, rebases, CI changes, Jira,
review, labels and merge — is delegated to the loop (owner, 2026-09-20).

**Review cycles are authorized without asking.** A materially changed head
earns a new full gate cycle; an unchanged head is never re-reviewed; every
earlier finding is carried into the new cycle's checklist; review runs against
the exact SHA; and merge waits until every required lens returns SHIP.

## 5. How to read live state — run these, do not trust a table

```sh
git fetch --all --prune && git log --oneline -10 origin/master
gh pr list --state open --json number,title,headRefName,headRefOid,isDraft
gh pr view <n> --json body,headRefOid,statusCheckRollup,comments
```

Jira is the queue; read it through the adapter or the board, never from a copy
in a document:

```sh
node .claude/scripts/queue/index.mjs next
```

**Confirm the merge criterion by head SHA, never by a watcher command.** The
required checks are `ci`, `e2e` and `windows-smoke`, and they must be green for
the **exact** head being merged:

```sh
SHA=$(gh pr view <n> --json headRefOid -q .headRefOid)
gh api "repos/{owner}/{repo}/commits/$SHA/check-runs" \
  -q '.check_runs[] | "\(.name) \(.conclusion)"'
gh api "repos/{owner}/{repo}/actions/runs?head_sha=$SHA" \
  -q '.workflow_runs[] | "\(.name) \(.event) \(.status) \(.conclusion)"'
```

A head that gets **no run at all** is a third state, not a slow one — see
`.claude/rules/node-ts.md`, "Confirming the merge criterion". `windows-e2e` is
skipped on pull requests by design; dispatch it per branch with
`gh workflow run e2e.yml --ref <branch>`, or read the post-merge master `E2E`
run. Never merge on an older head's green.

## 6. How this loop works on this machine

- **Work happens in full WSL clones, never in a linked worktree.** The Windows
  checkout cannot reach green on `pnpm test:unit`, so every commit is made in a
  clone where the pre-commit hook runs unmodified. Reach them as
  `wsl -d Ubuntu -u serhiibaksheiev -e bash -c '…'`; the default WSL distro on
  this host is not Ubuntu, and the default user is not the one that owns the
  clones.
- **Never let a commit or a full suite span a turn end.** A Windows Stop hook
  runs the unit suite at every turn end and starves the WSL VM, which fails an
  in-flight commit spuriously. Start the run in the background, then wait for
  it in the foreground inside the same turn.
- **Every PR takes the full gate:** `gate-round`, `revalidate --point
BEFORE_PR`, `decision-router`, the reviewer fan-out, `verdict.mjs check` on
  each report, the fan-out and verdict records, then `verdict.mjs coverage` on
  the head.
- **GitHub-hosted runners are the primary CI.** Self-hosted configuration is a
  fallback for exhausted hosted minutes; no PR may depend on a laptop being on.

## 7. Environment note

The user-level Codex configuration was checked separately:

```toml
[features.context_management]
experimental_mode = true
```

It is present in `~/.codex/config.toml`. This is local configuration, not a
repository artifact and not a release acceptance criterion.
