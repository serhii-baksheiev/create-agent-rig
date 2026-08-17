# Why a fail-open guard must do provably bounded work

The rule this record explains lives in `.claude/rules/invariants.md`, under
"What the enforcement actually is — stated exactly". This file is the evidence
behind it, and it is not loaded into any session — read it when the rule looks
like an over-reaction.

## The trap

Fail-open is the right default: a guard that throws must not make the session
unusable. But fail-open turns **every line of work the guard does into a
potential total bypass**. An exception, a timeout, or a stack overflow anywhere
inside the guard resolves to _allow_ — and not just for the rule that broke, for
**all** of them. The guard does not fail loudly and get fixed; it goes quiet and
keeps reporting success.

## What actually happened

Three review rounds on one hook produced three separate total bypasses. All
three were the same shape: an input made the guard's own code throw, and the
fail-open catch turned that into permission.

| the code                                                   | the failure                | the result |
| ---------------------------------------------------------- | -------------------------- | ---------- |
| an unbounded `spread` over an input-derived array          | `RangeError`               | allow      |
| a recursive expansion whose bound was per-group, not total | stack overflow             | allow      |
| a quadratic loop                                           | killed by the hook timeout | allow      |

One of them was worse than a plain bypass: when its bound was hit it silently
dropped part of the input, so whole commands went unexamined while the guard
reported that it had looked.

That is why the test is not "is it fast enough on realistic input" but **"can
any input make it do unbounded work at all"**. The first question has a
comfortable answer for all three of the defects above.

## Why the corollary is "prefer deleting a rule to adding one"

Each of those three bypasses arrived in a commit whose stated purpose was to
make the guard _stricter_. That is the uncomfortable part, and it is the reason
the rule reads the way it does: subtraction cannot introduce this class of
defect, and addition routinely does. A guard that checks less, reliably, beats a
guard that checks more until the day an input makes it check nothing.
