# Why the workflow layer is opt-in, and where the line falls

The rule lives in `CLAUDE.md`, under "The opt-in workflow layer (experimental)".
This file explains why `layers.json` (RP-180) draws the line where it does,
and why a few files that look like PR-lifecycle automation stayed in Lean Core
instead of moving with the rest of it.

## What moved, and why

Before this split, `templates/agent-os/universal/layers.json` had one array,
and `init`/`create` installed all of it unconditionally — including the queue
adapter, the `loop` and `pr-ship` skills, run-state, the run journal,
revalidation, claim-records and the PR-lifecycle helpers named below. None of
that is required by Lean Core: a thin CRUD service or a solo-maintained
library gets the same review gates and stop rules with none of the
autonomous, cooperative machinery, and shipping it anyway made every fresh
rig carry queue-selection semantics it never asked for.

The workflow layer is what a project opts into with `init --layer workflow`:
the queue adapter (`.claude/scripts/queue/`, `.claude/queue.json`), the
`loop` and `pr-ship` skills, `run-state.mjs`, the run journal
(`run-journal.mjs` — see the one exception below —, `journal/README.md`),
revalidation and claim-records, and the PR-lifecycle helpers
`decision-router.mjs`, `detect-missed-gate.mjs` and
`reconcile-external-prs.mjs`.

## The exception: why `verdict.mjs`, `lib/verdict.mjs`, `lib/gate-coverage.mjs`
## and `run-journal.mjs` stayed in Lean Core

These four read as PR-lifecycle automation — the ticket's own wording groups
"PR-lifecycle helpers" with the workflow layer — and the first draft of this
split moved them too. It does not survive contact with what Lean Core
actually installs, for one mechanical reason: `check-premises` is a Lean Core
skill (a session runs it standalone, with no queue and no loop, "before the
Red step" and again "before the gate"), and its own second entry point tells
the reader to run `node .claude/scripts/verdict.mjs check <report>
check-premises` on its own output. `.claude/scripts/verdict.mjs` is a single
module with **static, top-level imports** of `./lib/gate-coverage.mjs` and
`./run-journal.mjs` — Node resolves the whole file before any subcommand
runs, so a core-only install that shipped `verdict.mjs` without those two
would break `check-premises`'s own documented command on the very first
`check` subcommand, not only on `coverage`.

The three reviewer agent specs (`code-reviewer.md`, `security-scanner.md`,
`prose-reviewer.md`) are Lean Core for the same reason `check-premises` is —
review applies to any PR, loop-driven or not — and all three cite
`.claude/scripts/verdict.mjs` as the shape their own report is checked
against.

So the dependency runs from Lean Core outward: `check-premises` (core) needs
`verdict.mjs` (core) to load at all, `verdict.mjs`'s own module graph needs
`lib/gate-coverage.mjs` and `run-journal.mjs`, and neither of those two
imports anything outside itself (`node:fs`, `node:path`, and in
`gate-coverage.mjs`'s case nothing at all — the mention of
`decision-router.mjs` in its header is a comment, not an import). Moving the
leaves and leaving the root behind was the option that did not exist;
`invariants.md`'s "a file a core guard imports must stay core" generalises
past hooks to this case on the same reasoning.

`decision-router.mjs` itself has no such pull: `lib/gate-coverage.mjs`
mentions it only in a comment, and the one real static import of it
(`.claude/hooks/lib/edit-input.mjs`) is also a comment, not code. It moved
with the rest of the workflow layer, and `workflow.md`'s "PR flow" section
states the Lean Core fallback when it is not installed: every change still
reaches `code-reviewer`, and a human or the session decides which additional
reviewers apply, by the same triggers `decision-router` would have read.

`docs/decisions/gate-coverage.md` stayed with `pr-ship` (workflow) rather
than `lib/gate-coverage.mjs` (core) for a different reason: nothing in Lean
Core cites the record, only `pr-ship`'s own skill file does. The module and
the rationale for *why it exists* travel separately on purpose — the module
is a dependency of a core skill's documented command, the essay about why a
hook version of the same check was rejected is not.

## The freeze this split does not touch

RP-53 holds revalidation and claim-records' *behavior* frozen through the
RP-26 gate (2026-10-27): no feature expansion, no experiment restart, no bias
introduced by this or any other 0.10 change. This split moves their
*install-time layer* only — which `layers.json` array they sit in — and
changes not one line of `revalidate.mjs`, `revalidation-report.mjs`,
`lib/revalidation-evidence.mjs`, `lib/revalidation-points.mjs` or
`lib/claim-records.mjs` beyond that relocation. After the gate: GO retains
them in the optional workflow layer as they are today; NO-GO removes them in
a bounded follow-up. Missing evidence is not a NO-GO.

## What the manifest records, and the direction that matters

`RigManifest.layers` records which layer(s) a rig installed, and `upgrade`
refreshes only what it names. The one detail worth restating here because
getting it backwards is silent and destructive: a manifest written **before**
this field existed recorded nothing about layers because there was only one
payload to record — so `parseManifest` reads that absence as `['process',
'workflow']`, never as `['process']`. A fresh `init` with no
`--layer workflow` flag writes `['process']` explicitly. The two defaults
point in opposite directions on purpose, and swapping them would make the
very next `upgrade` on an existing dogfood repository report every workflow
file it already has as `retired` and stop managing it.

## Interaction with `uninstall` (RP-181, merged after this split was written)

`uninstall` needs no separate awareness of `layers` at all, and gains none:
it walks `manifest.files` and `manifest.kept` directly (`commands/uninstall.ts`),
and both of those already name exactly the paths a given install wrote or
found, regardless of which `layers.json` array a path happens to live in. Three
cases, all covered by the same unmodified byte-hash check:

- **A Core-only rig** (no `--layer workflow`) never has a workflow-layer path in
  `manifest.files` in the first place — `initManifest` only reads the layers
  `effectiveLayers` resolved — so `uninstall` has nothing workflow-shaped to
  remove and reports nothing about it.
- **A rig that opted into the workflow layer** has those paths in
  `manifest.files` exactly like any process-layer path, and `uninstall` removes
  or preserves them by the same pristine-bytes check as everything else it
  owns.
- **An inherited pre-0.10 rig** (a manifest with no `layers` key at all) had its
  workflow files recorded in `files` the only way any release before this one
  ever wrote a manifest — there was no `kept`/`files` split by layer to begin
  with — so `uninstall` already treats them as owned, the same as it always
  has. Nothing here widens what `uninstall` is willing to remove, and nothing
  narrows it: a manifest either names a path in `files`/`kept` with the right
  hash, or `uninstall` leaves it alone, and that rule does not read `layers`.

Pinned in `packages/cli/test/uninstall.test.ts` (absent in a generated rig —
this is the generator's own test suite, not a payload path) › "removes an
installed workflow-layer file exactly like any Core file, when the rig opted
in", › "a workflow-layer file never installed here (Core-only rig) is simply
absent from the manifest, never reported \"not a path this release installs\"",
and › "an inherited pre-layers manifest (no `layers` key) still owns its
workflow files, exactly like any other installed path".

## There is no opt-out short of `uninstall`

Once a rig has the workflow layer — `init --layer workflow`, or inherited
from before RP-180 — nothing in `init` or `upgrade` ever drops a layer a
READABLE manifest already recorded; `effectiveLayers` (`init.ts`) is
additive by construction, full stop. `detectLayersOnDisk` (`upgrade.ts`) is
a narrower claim: it only ever runs when there is NO readable manifest at
all, and even then it does not treat "a layer's files exist" as license to
keep them regardless of how many — it is additive in the same direction
(never narrows what a READABLE manifest said), but on the bootstrapped path
it decides per layer by quorum (`LAYER_ADOPTION_QUORUM`, more than half of
the layer's own files present), and can legitimately decide a layer is NOT
this rig's: a Core-only rig with one or a few stray files that happen to
share a workflow-layer path is left at Core, its stray files untouched and
unrecorded (round 4, blocker A — round 3's fix asked only "does at least one
file exist", which re-adopted the whole layer from a single stray path).
The only supported way back to Core-only for a rig the manifest genuinely
still names as having the workflow layer is `uninstall` (removing the
workflow files this rig owns) followed by a fresh `init` with no `--layer`
flag — see "The exact opt-out procedure, measured" below for what that
takes when `uninstall` had to preserve something.

**Hand-editing `layers` in `.claude/.rig-manifest.json` down to `["process"]`
is not that opt-out, and it does not do what it looks like it does.** The
files themselves are untouched by the edit itself — nothing deletes them —
but the next `upgrade` reads the manifest's `layers` as authoritative
(`upgrade.ts`'s `initInstallSet(repoDir, project, layers)`), so every
workflow path drops out of that plan's own install set and is reported
`retired`, reason `"no longer shipped by this release — the rig no longer
manages it; it is now yours"` — the same verdict RP-177 gave a deleted stack
overlay, applied here to files that are simply no longer read as this rig's
layer. `applyUpgrade` then writes a manifest whose `files` map has no entry
for any of the roughly three dozen workflow paths at all — measured, on a
clean `--layer workflow` install, at exactly 94 file entries down to 60
(`packages/cli/test/upgrade.test.ts`, absent in a generated rig, pins "a
clean workflow-layer install hand-edited down to a core-only layers array
goes from 94 manifest entries to 60"; the figure moved by one from an
earlier 86/53 when RP-186 added `docs/decisions/agents-md-canonical.md` to
the process layer, by two more when `implementation-agent` joined it, by
one more (89→90) when RP-209 added the proposal-filing script to the
workflow layer — the core-only figure stayed 56 because that file is
workflow-only — by two more (90→92, 56→58) when the `skill-authoring`
skill joined the process layer, and by two more again (92→94, 58→60) when
`failure-diagnostician` joined it).
The files stay on disk, silently un-hashed and unowned —
and a LATER `uninstall`, reading the same manifest, has nothing there to
recognise them by: they read as an ordinary foreign/untracked path, not as
something this release ever installed, and are left alone. The manifest
itself does not warn about this because it has no opinion on why `layers`
changed; the tool trusts its own evidence file. This is measured behaviour,
not a guess: `packages/cli/test/upgrade.test.ts` (absent in a generated rig)
pins the `retired` verdict and the orphaning it causes in "hand-editing
`layers` down to `["process"]` on a rig that already has the workflow
layer retires every workflow file — on disk, unowned, never deleted".

**The mirror hand-edit — `layers: ["workflow"]` alone, dropping `process` —
does the identical thing in the other direction, on a still-readable
manifest.** `initInstallSet` reads exactly the array it is given; a `layers`
that never names `process` un-owns every Core file the same way dropping
`workflow` un-owns every workflow file: the next `upgrade` retires them from
the plan and drops them from `files`, silently, files untouched on disk.
(This is not the bootstrapped path's own normalisation — `detectLayersOnDisk`
always forces `process` into a layer set it INFERS from disk; a READABLE
manifest is trusted as written, `process` included, and nothing here
prevents an operator from writing one that omits it.)

## The exact opt-out procedure, measured (RP-180 round 4, blocker B)

`uninstall --yes` followed by a fresh `init` (no `--layer` flag) reaches
Core-only in exactly ONE of the two cases that matter, and round 3 stated it
as though it always worked. Measured on the built CLI, both ways:

- **Nothing on the rig was ever edited.** `uninstall --yes` removes every
  file it owns — Core and workflow alike — and, because nothing was left to
  preserve, deletes the manifest too. A fresh `init` then finds no manifest
  and no workflow files: Core-only, as documented. A fresh `init` then
  installs Core only.
- **Anything was edited — one file is enough.** `uninstall --yes` preserves
  that one file (and reports it) and, because something was preserved,
  **keeps the manifest** — still recording `layers: ["process","
  workflow"]`. The next plain `init` reads that surviving manifest
  (`effectiveLayers` in `init.ts`: `previous?.layers.includes('workflow')`)
  and reinstalls the entire workflow layer right back. `uninstall --yes` leaves
  the one preserved file plus the manifest, and a plain `init` afterward
  brings the whole workflow layer back, `layers` still both. The
  "fresh `init`" instruction alone does NOT reach Core-only here — round 3
  said it did.

**The procedure that actually reaches Core-only when something was
preserved: pass `--detach`.** `uninstall --yes --detach` performs the
identical safe removal and then deletes the manifest regardless of what is
left behind, handing the preserved file(s) over to the operator outright
(they stay on disk, no longer named by anything). The next plain `init`
then finds no manifest at all and installs Core only. A fresh `init` then installs
Core, leaves the preserved file untouched, and records `layers: ["process"]`. No new flag
was added for this — `--detach` already existed (RP-181) for the identical
reason: a manifest kept alive only by something it has no business
prescribing further action over.

Equivalently, without `--detach`: remove the file(s) `uninstall --yes`
reported as preserved, then remove `.claude/.rig-manifest.json` by hand,
then run a plain `init`. Both procedures were measured to reach the same
end state; `--detach` is the one to recommend because it is one command
instead of a report a human has to read and act on by hand.

Pinned end-to-end on the built CLI in `test/e2e/uninstall.test.ts` (absent in
a generated rig) › `describe('the opt-out procedure to Core-only, measured
(RP-180 round 4, blocker B)')`: both cases end in `layers: ["process"]` and
no un-preserved workflow file left on disk.
