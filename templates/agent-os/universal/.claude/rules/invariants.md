# Invariants — the pattern this project enforces with

Most of the rules in `.claude/rules/` are prose: they work because they are read.
A handful are different — they are the ones where being followed *most of the
time* is not good enough, because the violation is cheap to write, hard to see in
review, and expensive to undo.

Those get the pattern below. It is the reusable part of this whole layer, and the
`new-invariant` skill walks you through applying it.

## The pattern: three parts, and all three are required

1. **A stated invariant** — one sentence, in a rule file, in the form "X never
   happens in Y". Written where a reader looking for it would look.
2. **A mechanical check that blocks the violation** — a `PreToolUse` hook in
   `.claude/hooks/`, wired in `.claude/settings.json`, that refuses the edit.
3. **A test for the check** — proving it blocks the violation *and* allows the
   compliant form.

**Two of the three is decoration.**

- A rule with no check is a wish. It will be followed until the day it is
  inconvenient, and that day will not be noticed.
- A check with no test is a guess. A guard that has quietly stopped matching is
  worse than no guard, because everyone believes they are covered.
- A check with no stated rule is a booby trap. Someone will hit it, not
  understand it, and route around it — reasonably, because nothing told them why.

## What makes an invariant hookable

A hook sees **one edit at a time**, as text, before it lands. So the invariant has
to be decidable from that much:

| Good fit | Poor fit |
| --- | --- |
| "no clock, randomness or I/O in this directory" | "this function is too complex" |
| "this layer never imports that layer" | "the naming is inconsistent" |
| "this flag is never passed to that command" | "this needs a migration plan" |
| "secrets never appear in a config file" | "the abstraction is wrong here" |

The test is mechanical: could you decide it by reading the diff fragment alone,
in milliseconds, with no network and no whole-repo scan? If not, it is a review
concern (`code-reviewer`), a lint rule, or a type — **not everything worth
insisting on belongs in a hook**, and stuffing judgement into one produces a guard
that fires on honest work.

**One invariant per hook.** Two invariants in one file is how a guard becomes
unreadable, then unmaintained, then untrusted.

## What the enforcement actually is — stated exactly

A `PreToolUse` hook is a **best-effort text scan of one edit fragment before it
lands**. Two consequences, both worth knowing before you rely on it:

- An `Edit` shows the hook its *new text*, not the resulting file. A violation
  assembled across two edits, or already present in a file being edited
  elsewhere, is not seen.
- A determined evasion — an obfuscated string, a generated file, a shell
  redirect — slips it. The guard targets **drift**, not an adversary.

That is enough, because it stops the normal path cold and the layers behind it
(`code-reviewer`, the test suite, CI) catch the rest. But a rulebook that sells
enforcement has to describe its enforcement precisely, or the first surprise
costs it all its credibility.

**Fail closed on a match, fail open on an error.** If the hook itself throws or
gets a payload it does not understand, it must allow the edit. A crashed guard
that blocks everything gets deleted within the hour.

## The worked example — and it is one project's answer, not a law

`.claude/hooks/guard-core-purity.mjs` is this pattern, filled in:

| Part | Where |
| --- | --- |
| the invariant | `.claude/rules/architecture.md`, "The core is pure" |
| the check | `.claude/hooks/guard-core-purity.mjs` |
| the test | the hook's blocking behaviour, under test |

**It is an example, not a truth.** "The domain core is pure" is a good rule for
the shape this project was generated in; it is not a law of software. If your
project has no pure core — a thin CRUD service, a CLI, a data pipeline — then
**delete the hook, the rule and its test**, and spend the slot on the invariant
your project actually has. An inherited rule nobody chose is worse than an empty
rule file: the empty one is visibly incomplete, the inherited one is invisibly
wrong.

The invariants worth your slots are the ones you can finish this sentence about:
*"the last time this went wrong, it cost us ___."* If you cannot finish it, you
are guessing, and a guessed invariant is the one that will fire on honest work.

## Adding one

Use the `new-invariant` skill. It asks what the invariant is (it will not invent
one for you), writes the failing test first, then the hook, then wires it and
states the rule — so all three parts land in the same change and none of them can
be forgotten.
