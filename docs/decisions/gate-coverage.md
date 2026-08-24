# Why the fan-out is checked in `pr-ship`, and never in a hook

The check lives in the `pr-ship` skill, step 5 ("Coverage"), and its rule is one
sentence: *a merge is not gated by a fan-out whose reviewers did not all answer
for the commit being merged.* This file explains why that check sits in a skill
rather than in `guard-bash`. The hook version is the one that keeps being
proposed, and a refusal nobody wrote down gets proposed again. It is not loaded
into any session.

## The shape that was refused

The proposal: `guard-bash` denies a merge command unless the run journal holds a
`SHIP` from every reviewer the router named, for the PR's head commit. It is the
attractive version — mechanical, at the tool layer, impossible for a hurried
session to skip.

It was refused on four costs, each of them a rule this project already paid for.

**1. It needs to recognise a merge command while the brake is off.** The kill
switch can be coarse — it denies the network clients *as a class of binaries*,
reading no merge semantics at all, while still allowing the wind-down it asks
for — because a false block is cheap when the session is already stopped. `invariants.md` states that
directly: match a rule's precision to the cost of a false positive. A merge gate
runs during ordinary work, where a false block lands on the last step of finished
work. The one attempt at enumerating merge routes was reverted, and what it cost
is recorded where the attempt was made rather than restated here:
`.claude/hooks/guard-bash.mjs`, the comment above `NETWORK_CLIENTS`.

**2. It needs the head commit, inside a hook that must stay pure.** For
`gh pr merge <number>` the head is only knowable over the network, and
`guard-bash` records what an unbounded hook costs: killed by its own timeout, and
a killed hook does not block — so **every** rule silently switched off, not just
the new one.

**3. It needs to parse the journal in a guard that fails open.** The journal
reader refuses a malformed line by throwing, which is right for a reader and
fatal for a fail-open guard: the throw resolves to *allow*, again for every rule
at once. `stop-flag.mjs` is not the precedent it resembles — that is `existsSync`
over a capped list of fixed paths, not a parse.

**4. Its sweep half cannot exist.** The natural companion — audit merged PRs from
outside — has nothing to read: the run directory is gitignored, and the sweep
sees labels and PR bodies only.

## And the reason the four costs were not worth paying

Even fully built, the guard would read a file **the audited run wrote itself**.
For the threat model a hook actually has — drift, not an adversary — that is
tolerable, and it is why the skill-level check below is worth having at all. What
it is not is the *guarantee* the hook version promised, and the four costs above
were being paid for that word.

## What was built instead

`.claude/scripts/lib/gate-coverage.mjs` compares the three sets the journal already holds —
routed, launched, answered — and `pr-ship` runs it through
`verdict.mjs coverage <commit>` before its own verdict. It sits in the layer that
already knows the head commit, is allowed to run git, and is allowed to throw.

Two limits, and both are stated in the skill beside the step rather than only
here:

- with no `RIG_RUN_DIR` there is no journal, so the check says it was skipped and
  exits 0 — an honest nothing, never a pass;
- a session that skips `pr-ship` entirely skips this with it. That is the gap the
  hook version was reaching for, and it stays open.

So `CLAUDE.md` keeps its sentence unchanged: *no hook launches the gates, so "the
gate ran" is a claim, not a guarantee.* What changed is narrower and worth
having on its own — the driver can no longer accept a fan-out that did not
answer, or one that answered about a commit two pushes ago.

## The variant that removes self-report, and why it is not the default

Running the reviewers as CI check runs is the only shape where the evidence is
authored by something other than the audited run, and where the driver cannot
skip the gate at all. It is not refused on its merits.

It is refused **as a default for this layer**: everything under `.claude/` ships
into every project this rulebook generates, so making it the shape would require
a model credential in every generated project's CI and a per-PR cost, for
projects that never asked for either. A project that wants that guarantee should
adopt it deliberately; the check above is what every project gets.
