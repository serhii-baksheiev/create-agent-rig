# Why one run directory per run, and why nothing can enforce it

The rule lives in the `loop` skill, section 1 ("Declare the run directory here").
This file explains what the enforcement does and does not reach, so nobody
mistakes the warning for a guarantee. It is not loaded into any session.

## An undeclared run is not a run with a missing journal

`RIG_RUN_DIR` holds two unrelated things: the machine trace, and the run's
**stop conditions** — the escalation streak, the deploy verdict, the budget flag.

With `RIG_RUN_DIR` unset, the two verdicts a session writes by hand
(`run-state.mjs deploy …`, `run-state.mjs budget …`) refuse loudly, so it finds
out. **The escalation count does not.** It is recorded nowhere, silently, and
selection then hands out work after two walls in a row with nothing on stderr to
say why.

So an undeclared run is a run whose main brake is off, and which looks exactly
like a healthy one from the outside.

The trace's first call site is **selection**, which runs before every task.
Declared later, it misses everything that already happened — which is why the
declaration belongs in preflight or nowhere.

## What the reuse check catches

- Two writers landing on the same sequence number.
- A directory that already carries its run-end marker.

Both are refused. Selection still works and says so on stderr, and that run's
trace ends there — **loudly**, which is the good case.

## What it cannot catch

Two runs whose records happen not to collide.

A run that died before writing its end marker — and dying unexpectedly is
exactly the case the checkpoint discipline exists for — leaves an intact
sequence behind it. The next run pointed at that directory **continues it in
silence**: one seamless trace of two runs, with nothing in the file able to say
so.

Nothing detects this after the fact. A fresh directory per run is the only thing
that prevents it, and it is the session's to do.
