# Publishing a release

Status: installed behaviour. The procedure itself is **not here** — it is
`CHANGELOG.md`, "Releasing", steps 1-9, and this document deliberately does not
restate it. A second copy of a nine-step checklist is a copy that drifts, and
the release this document was written alongside exists to remove three such
copies.

What is here is the one thing that checklist could not carry: a command.

## Before step 8

```sh
node scripts/release-preflight.mjs
```

Exit 0 and it prints the version, the commit, the tarball name and the file
count you are about to publish. Any finding, and it names what to fix and exits
non-zero.

It checks the six mistakes this project has actually made or nearly made: the
two manifests out of step, a runtime dependency on the manifest that publishes,
the inner package losing either of its two publication locks, a version the
ledger already records, a dirty working tree, a `HEAD` that is not the merge
commit, a tarball missing the dotted `templates/agent-os/universal/.claude/`
tree, and anything credential-shaped or stale inside it.

It is a preflight, not a gate — nothing runs it for you, and a green run is not
a verdict on the release. Its own header states what it cannot see; read that
rather than assuming coverage it does not claim. Pinned in
`test/template/release-preflight.test.ts`.

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

Record the published `gitHead` and `dist.shasum` where the next release's step 4
will read them; `templates/release-ledger.json` gets this release's row at the
**next** release, never at its own, because a commit cannot carry its own sha.
