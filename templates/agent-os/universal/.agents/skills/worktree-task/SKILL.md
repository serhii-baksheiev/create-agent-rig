---
name: worktree-task
description: Start and finish a task in its own git worktree — creation off the remote default branch, and the full cleanup after the merge. Use at the start of every implementation task and after every merge, and whenever two sessions might touch this repo at once.
allowed-tools: Bash, Read
---

# Worktree task lifecycle

`.claude/rules/workflow.md` says **one task, one branch**. A worktree is how
that rule survives a second session: two branches checked out at once, in two
directories, with one `.git`. Without it, an unattended run and a hand-driven
session share a working tree and overwrite each other's edits.

**Use one when** anything else may touch this repo while you work — an
unattended `loop` run, a colleague, a second Claude session. A single attended
session on a quiet repo can just use a branch; the discipline that is never
optional is the branch, not the worktree.

## Start

```bash
cd "$(git rev-parse --show-toplevel)"   # ALWAYS anchor cwd first — see gotcha 1
git fetch origin
git worktree add -b <type>/<slug> .claude/worktrees/<slug> origin/HEAD
git worktree list                       # verify the path is DIRECTLY under .claude/worktrees/
```

- **Branch off the remote default branch**, never a local copy — a stale local
  default is how a task gets built on code that was replaced last week
  (`.claude/rules/autonomy.md`, "Session staleness"). If `origin/HEAD` is not
  set locally, name the branch explicitly: `origin/<default-branch>`.
- **Branch name: `<type>/<slug>`**, type one of `feat|fix|docs|chore|refactor`.
  If the project's queue gives work an id, the branch carries it —
  `feat/<id>-<slug>` — because the branch name is often the only thread between
  a queue item and its code. Work with no queue item keeps the plain form: **do
  not invent an id.**
- If tests will run there, install inside the worktree first. A worktree gets a
  fresh, empty `node_modules`; a missing install fails as a confusing
  module-resolution error rather than as "you forgot to install".

## Finish (after the PR is merged)

```bash
cd "$(git -C <repo root> rev-parse --show-toplevel)"   # cd OUT of the worktree first — gotcha 2
git worktree remove .claude/worktrees/<slug> --force
git worktree prune
git branch -D <type>/<slug>
git push origin --delete <type>/<slug>    # if the merge did not already delete it
rm -rf .claude/worktrees/<slug>           # only if `remove` left the directory behind
```

Add `.claude/worktrees/` to `.gitignore` once, so a live worktree never shows
up as untracked noise in every `git status`.

## Gotchas

1. **A stale cwd creates worktrees inside dead paths.** If your shell sits in a
   directory that has been removed (typically the *previous* task's worktree), a
   relative `git worktree add .claude/worktrees/x` recreates the dead path and
   nests the new worktree inside it. Always `cd` to the repo root by an
   **absolute** path first, and verify with `git worktree list` afterwards.
2. **`git worktree remove` fails while your shell is inside it** — or while a
   watcher or install still holds a handle on `node_modules`. `cd` out first. If
   the directory survives `remove --force`, run `git worktree prune` (the
   metadata is then clean) and delete the leftover directory; retry later if it
   is still busy.
3. **Never touch a worktree you did not create.** Concurrent sessions make
   worktrees appear and vanish mid-task. Removing another session's worktree
   destroys unmerged work — and it is indistinguishable, afterwards, from that
   session never having done the work.
4. **One worktree per task.** Do not reuse a finished task's worktree: its
   branch state and its install are both stale, and the reuse is invisible in
   the diff.
