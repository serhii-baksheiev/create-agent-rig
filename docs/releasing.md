# Publishing a release

Status: installed behaviour. The procedure itself is **not here** — it is
`CHANGELOG.md`, "Releasing", steps 1-9, and this document deliberately does not
restate it. A second copy of a nine-step checklist is a copy that drifts, and
the release this document was written alongside exists to remove three such
copies.

What is here is the one thing that checklist could not carry: a command, and the
reasoning behind the boundary it stops at.

## Before step 8

```sh
node scripts/release-preflight.mjs
```

Exit 0 and it prints the version, the commit, the tarball name and the file
count you are about to publish. Any finding, and it names what to fix and exits
non-zero. Step 8 of the "Releasing" checklist calls it too, so this document is
a companion to that step rather than a second route into it.

**What it checks is the code, not a list here.** An earlier draft of this
document enumerated the checks and got the count wrong in the same breath — it
said six and listed eight, while the script emitted eleven findings. That is the
stale-second-copy defect these very releases exist to remove, so the enumeration
is gone rather than corrected: read `scripts/release-preflight.mjs`'s exported
functions, or just run it and read what it names.

**What it does not check**, because the distinction decides whether you are
covered: it asks about **names**, never about content. The credential question
is delegated to `isCredentialPath` in `.claude/scripts/lib/secrets.mjs` — the
same vocabulary `guard-secret-file` and `validate-no-secrets.mjs` use — so a
credential sitting inside a file with an innocent name is invisible to it.
`node scripts/validate-no-secrets.mjs` is the one that reads content, and it
reads **tracked** files rather than the tarball. Neither covers the other, and
the script's own header says where each is blind.

It is a preflight, not a gate: nothing runs it for you, and a green run is not a
verdict on the release. Pinned in `test/template/release-preflight.test.ts`.

### Preflighting a frozen, unpublished release candidate

A release candidate that was accepted and frozen under `release/<version>-rc`
can sit there while `origin/master` keeps moving — a later version prepared on
top of it. Ordinary mode above refuses that checkout outright: it requires HEAD
to be origin/master's **current** tip, and a frozen candidate is, by design,
no longer that. For exactly this situation:

```sh
node scripts/release-preflight.mjs --frozen-candidate <40-char-lowercase-hex-sha>
```

It keeps ordinary mode's manifest, ledger and CHANGELOG heading checks:
`CHANGELOG.md` must document the version being prepared under exactly `## X.Y.Z` or exactly
`## X.Y.Z (release candidate)`, nothing looser. What frozen mode replaces is
only the git question: instead of "is HEAD origin/master's current tip", it
asks three things specific to a frozen candidate — HEAD must be exactly the
given sha; the fully-qualified
`refs/remotes/origin/release/<package.json version>-rc` must resolve and name
that same sha; and the sha must still be an ancestor of `origin/master`. Both
refs are resolved exactly (`git show-ref --verify --hash`), never through
git's own short-name fallback onto a same-named tag or branch. The working
tree must still be clean, exactly as in ordinary mode. Like ordinary mode, it
reads refs as git already has them and does not fetch.

This mode does not publish or tag
anything by itself — it only tells you whether the frozen bytes still check
out clean against the three facts above. Any git finding in this mode stops
the run there: `npm pack` is never reached once one has fired.

Pinned end to end, against the real script and real git, in
`test/template/release-preflight-frozen-e2e.test.ts` — "clears the exact
candidate on the real remote-tracking release ref, ancestor of origin/master,
and still reaches npm", "reports the release ref missing, naming it, and never
reaches npm (B: a frozen git finding must stop before packing)", "still reports
the release ref missing when a TAG shadows its exact name (A: only the exact
remote-tracking ref counts)", "still reports the release ref missing when a
BRANCH shadows its exact name (A: only the exact remote-tracking ref counts)",
"reports a release ref that resolves to a different commit, and never reaches
npm", "reports a candidate that is not reachable from origin/master, and never
reaches npm", and "reports origin/master as unresolvable rather than silently
trusting a TAG that shadows its name".

#### A frozen predecessor RC, while a later one is being prepared on top of it

The scenario above is about preflighting the frozen candidate itself. A
different situation (RP-349) is preparing the **next** candidate while the
earlier one is still frozen and unpublished underneath it — e.g. 1.2.1 is
being prepared while 1.2.0, itself an accepted, frozen RC, has not published
yet. `templates/hash-history.json`'s builder would otherwise read 1.2.0's
`## 1.2.0 (release candidate)` heading as a forgotten reconciliation (see
CHANGELOG.md, "Releasing" step 4) and refuse to run.

The fix is `scripts/release-candidates.json`: `{ "1.2.0": "<the frozen
sha>" }`, verified against git rather than asserted by hand — the exact
`release/1.2.0-rc` ref must still resolve to that sha, that commit's
`package.json` must read `1.2.0`, and it must be an ancestor of HEAD (pinned
in `test/template/hash-history.test.ts` › "rejects a baseline whose exact ref
is missing or names another sha" and › "rejects a baseline whose package.json
version differs, or that is not an ancestor of HEAD", and end to end in
`test/template/build-hash-history-candidates-e2e.test.ts` › "reports the release
ref missing, naming it, even when a TAG shadows its exact name"). While
1.2.0 has no row in the ledger, its heading is left as the pending
release-candidate form. Once 1.2.0 actually publishes, add its ledger row from
`npm view` exactly as step 4 already describes, and reconcile the heading; a
recorded sha that disagrees with what the ledger says was published stops the
build rather than trusting either one silently — pinned in
`test/template/hash-history.test.ts` › "flags a published ledger gitHead, or
null, that disagrees with the frozen RC sha".

The baseline record remains as historical provenance after publication; it
does not declare that the package is still unpublished. For example, 1.4.0's
preserved candidate SHA now agrees with its published ledger row. Published
state comes from the ledger and the reconciled changelog heading.

## Exact-SHA network acceptance

The existing E2E workflow has an opt-in release lane. A dispatch with
`release_acceptance=true` and a full `release_sha` checks out that candidate,
runs the normal suite, provisions pinned uv on the runner, then runs
`node scripts/release-acceptance.mjs --sha <candidate-sha>` against a packed Rig.
The lane uses real pinned Spec Kit downloads and disposable fixture/cache
directories. It does not publish a package or install providers globally.

```sh
gh workflow run e2e.yml --ref master \
  -f release_acceptance=true \
  -f release_sha=<full-candidate-sha>
```

The network lane is absent from PR, push and scheduled
runs unless explicitly selected by dispatch. Ordinary tests keep isolated fake
upstream executables. Record the Linux, Windows and macOS job links for the exact
candidate; an earlier branch run is not evidence for a later SHA.

`test/template/release-acceptance.test.ts` pins "rejects an invalid candidate SHA
before packing or mutating its fixture" and "rejects a well-formed candidate SHA
that does not match the checked-out Git HEAD before packing or mutating its
fixture". The dispatch supplies the real provider evidence; those negative
tests alone do not establish release acceptance.

The same run also upgrades a rig generated by the published predecessor —
its identity checked against the repo's own ledger and integrity record,
never trusted from the registry alone. See
`test/template/release-acceptance-upgrade.test.ts` › "derives its result
only from the ledger and the integrity record — a registry-shaped field
changes nothing" and › "takes the predecessor’s expected identity from the
repo records, never from the registry" for that binding, and
`test/e2e/release-acceptance-upgrade.test.ts` › "accepts an immutable
published predecessor upgrade with an exact packed candidate" for the
upgrade itself.

## Why the owner types the publish

`npm publish` needs 2FA and cannot be undone, so an agent prepares a release and
stops at that command. That boundary is not an inconvenience to route around: it
is the reason a compromised or confused session cannot ship bytes under a
version number that rigs already trust.

## After the publish

Step 9 of the same checklist smokes the **registry** artifact, not a checkout.
That distinction is the whole point of the step — a local build passing proves
nothing about what npm actually serves — and it is why the step cannot run
before the publish rather than being merely postponed until after it.

Two values are worth writing down at that moment, because nothing in the
repository can derive them and the next release needs one of them: the published
`gitHead` and `dist.shasum`, from `npm view create-agent-rig@<version> gitHead
dist.shasum`. Record them in the release's journal entry under `journal/`, which
is where 0.7.0's and 0.7.1's pairs live. They do **not** go in
`templates/release-ledger.json` now: that file gets this release's row at the
**next** release, per step 4, because a commit cannot carry its own sha.
