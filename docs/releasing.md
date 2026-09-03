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
