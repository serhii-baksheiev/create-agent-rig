# Why the close command looks the way it does

The rule lives in the `loop` skill, section 9 ("State updates bracket the task").
This file is the evidence behind each argument in the `recordCompletedTier`
call, and it is not loaded into any session. Read it before "simplifying" that
command.

Four of the five were live defects; the fifth (`execFileSync` with an argument
array) is prophylaxis. They do **not** fail the same way, and the difference is
the whole reason each is pinned rather than left to judgement:

| argument | how it fails when wrong |
| --- | --- |
| `-z` | silently, **permissively** — records `normal` for an elevated change |
| `env: withoutGitLocation()` | silently, **permissively** — records a tier from another repository |
| `runDir` | silently, but toward a **stop** nobody can clear |
| the diff form | **loudly** — the call refuses on an empty file list |
| `execFileSync` array | it does not; nothing is interpolated into a shell today |

## `runDir`

It is what resets the escalation streak: the close is the "something landed in
between" that makes the run-level stop "two escalations **in a row**" mean two
in a row. Omit it and the counter only ever rises — two escalations an hour
apart end the run however many tasks closed between them.

The parameter is optional in the signature. So leaving it out does not throw; it
fails quietly, and in the direction of a stop nobody can clear.

## `<merge-sha>^1 <merge-sha>`, never `origin/<default>...<merge-sha>`

A three-dot diff is `merge-base..head`. Once the remote-tracking ref includes the
merge — which is exactly its state at the moment this step runs — the merge base
_is_ the merge, so the file list comes back **empty** and the call refuses.

The three-dot form appeared to work for a while. It only ever worked while the
local ref happened to be stale: an accident of ordering, not a property of the
command.

## `-z`, and splitting on `\0`

With `core.quotePath` on (the default) a path containing a non-ASCII byte
arrives quoted and octal-escaped — `".claude/caf\303\251.mjs"`. That string
matches no declared elevated prefix, so an elevated change records as `normal`.
Separately, a filename containing a newline splits into two junk paths. `-z`
removes both failure modes at once.

## `execFileSync` with an argument array, never a shell string

Nothing in the current command is interpolated into a shell. The point of the
argument array is that the next session cannot start doing so: the safe form has
to be the one already written down, or it will not be the one copied.

## `env: withoutGitLocation()`

Run under a git hook, this command inherits `GIT_DIR` — absolute, when the hook
fired in a worktree — and then computes the diff of **another repository**,
recording a tier from it. Silently: the file list comes back non-empty, so
nothing refuses and nothing looks wrong.

The source sweep in `test/template/git-env.test.ts` cannot read markdown, so
this particular line is guarded by a sweep over the fenced code blocks in the
rulebook documents instead.

## The shape the dangerous ones share

The two that matter most — `-z` and `withoutGitLocation()` — never announced
themselves. Each returned a plausible answer: a tier of `normal`, a diff of the
wrong repository. A plausible answer is what a run acts on, and neither leaves
anything behind to say it was never measured.

The empty-file-list case is the deliberate counter-example: `recordCompletedTier`
**throws** rather than guessing `normal`, because an absence and a zero look
identical in a count and mean opposite things. That refusal is the behaviour the
loop skill relies on — do not soften it into a default.
