# Why Rig does not adopt native plugin delivery yet

⚠ **This record is not synced.** Most files in this directory are composed
from `templates/agent-os/universal/docs/decisions/` by
`scripts/sync-agent-os.mjs` and travel into every generated project. This one
rules on this product's own delivery mechanism and names no rule a shipped
rulebook cites, so `test/template/decision-records.test.ts` would refuse it
in the template layer — that is what makes it, and every other file in this
directory that opens with this same banner, the exceptions. Trust the banner
on each file over an enumerated list here: run `grep -l 'not synced'
docs/decisions/*.md` for the current set rather than believing a name list,
which goes stale the moment a new one is added and did exactly that once
already. **Edit it in place.**

Status: accepted for RP-179, reclassified by the owner as a capability
evaluation and architecture decision (see "What RP-22 owns" below) rather
than an implementation ticket.

## What was evaluated

Both providers' plugin surfaces, verified directly against their official
documentation on 2026-09-20 (not carried over from an older, less certain
note):

- **Claude Code has a real, scriptable, project-scoped plugin install path.**
  A plugin manifest (`.claude-plugin/plugin.json`) and an optional marketplace
  manifest (`.claude-plugin/marketplace.json`, including local-directory
  marketplaces with no publish step) are documented at
  https://code.claude.com/docs/en/plugins-reference and
  https://code.claude.com/docs/en/plugin-marketplaces. Non-interactive,
  project-scoped enablement is exact and documented:
  `.claude/settings.json`'s `extraKnownMarketplaces` and `enabledPlugins`
  keys, or the CLI form `claude plugin install <plugin>@<marketplace>
  --yes`.
- **Codex has no scriptable plugin install surface at all.**
  https://learn.chatgpt.com/docs/plugins documents exactly one installation
  path, the interactive `codex /plugins` browser, and no
  `plugins.<plugin>.enabled`-shaped config key or project-local
  `.codex/config.toml` capability for declarative enablement. Codex's skills
  and hooks are already file-based and need no installer:
  `.agents/skills/<name>/SKILL.md` (per
  https://learn.chatgpt.com/docs/build-skills, which names direct file writes
  as a valid alternative to the optional `$skill-installer` convenience
  command) and project-local `.codex/hooks.json` — both exactly what
  `scripts/sync-codex-adapter.mjs` already produces.

## The decision

Rig does not migrate its own guard/skill/agent delivery to a native Claude
Code plugin in this release, and attempts no Codex-side plugin install (none
is scriptable). Both harnesses keep receiving Rig's rulebook as installed
repository files that `.claude/.rig-manifest.json` owns and `upgrade`
reconciles (`unchanged` / `update` / `conflict` / `deleted` / `wiring`) —
RP-179 acceptance #2 and #3, pinned in `packages/cli/test/upgrade.test.ts`,
`test/e2e/upgrade.test.ts` and `packages/cli/test/upgrade-codex-projection.test.ts`.

## Why not now

1. Moving Claude's delivery to `enabledPlugins`/`extraKnownMarketplaces` would
   move the installed files outside today's raw-byte manifest ownership model
   (`raw-byte-ownership.md`, beside this record) — a Tier-2 change (project
   `.claude/rules/autonomy.md`: "storage schema / data migrations" and
   "public API contract changes"), not something to fold into a ticket whose
   acceptance criteria are about the capability matrix and the generated
   fallback's determinism.
2. Codex has no scriptable install surface at all, so for Codex the
   "generated fallback" is not a fallback of last resort — it is the entire
   mechanism, and it already exists and is already tested
   (`scripts/sync-codex-adapter.mjs`, `test/template/codex.test.ts`).
3. Project `CLAUDE.md` asks for the narrowest change that satisfies the
   ticket ("Minimize scope of changes"); a native-plugin migration on the
   Claude side is a distinct proposal with its own capability-matrix-backed
   case, not a side effect of this one.

## What RP-22 owns (owner ruling)

RP-179 is reclassified by the owner as a capability evaluation and
architecture decision — not an implementation ticket, and not a delivery
promise binding on whatever ticket comes next. Stated plainly, because an
earlier draft of this record read as though RP-22 inherited "plugin-first
delivery" as a settled architecture: **it does not.** RP-22 owns, on its own
authority, not as a continuation of this record's scope:

- official installers and native mechanisms where a provider's own
  documentation shows one exists and is non-interactive — the capability
  matrix in `docs/compatibility.md` is evidence for that decision, not a
  mandate to adopt one;
- pin/version policy for whatever RP-22 installs;
- receipts (including the installation-mode vocabulary this record explicitly
  declines to create — see "Receipt vocabulary" below) and `doctor`
  verification of them;
- no repackaging of third-party payload — the same invariant this record's
  artifact checks pin (see "No third-party payload, checked by shape"),
  carried forward as a constraint on RP-22, not reargued by it;
- fallback projection **only** where native non-interactive installation is
  absent for that provider and that capability. RP-22 does not default to
  generating a fallback first and reaching for a native mechanism later.

## Receipt vocabulary — RP-179 defines none

RP-179's scope bullet asks that a future `doctor` receipt record
provider/plugin identity and observed version. That receipt, and the
vocabulary it is written in, are RP-22's to design from the capability
matrix above. RP-179 defines no installation-mode vocabulary for it to join:
no enum, no schema, no type for these words exists anywhere in this
repository's code. `PLAN.md` does use "native-plugin" as plain English — §1:
"Native-plugin and MCP composition through supported official installers
belongs to the remaining 0.10.0 work"; §7: "RP-179 and RP-180 establish
native-plugins-first composition" — but neither sentence defines a value; it
is prose describing the same architecture this record evaluates, not a
vocabulary. RP-22's own ticket text separately proposes candidate words
(`external-installer`, `native-plugin`, `hosted-service`,
`external-executable`); those are likewise prose in a ticket, not a
vocabulary this repository has adopted. This ticket reserves nothing and
produces no receipt; it leaves RP-22 the evidence above to classify.

## The "one tested projection library" scope bullet — why it stays unextracted

RP-179's scope bullet asks Rig to "use one tested projection library from
`init` and `upgrade`". Read literally against the current code, that could
mean extracting the pure functions in `scripts/sync-codex-adapter.mjs`
(`parseAgent`, `codexAgent`, `codexHooks`, `expectedFiles`) into a
`packages/cli/src/` module imported by both the dev-time sync script and the
CLI. This record states why that extraction did not happen in RP-179:
neither `init` nor `upgrade` re-derives the Codex projection at install
time today — they copy its **committed output**
(`templates/agent-os/universal/.codex/`, `.agents/`) exactly like any other
template file, through the same manifest/upgrade machinery every other
installed file uses (`packages/cli/src/commands/init.ts`, `initManifest`,
which lists `.codex/agents/*.toml` and `.agents/skills/**` in
`templates/agent-os/universal/layers.json` alongside ordinary rule and skill
files). There is exactly one source of truth already —
`scripts/sync-codex-adapter.mjs` — checked for drift on every push
(`test/template/codex.test.ts` › "is in sync with its Claude Code sources",
which runs `node scripts/sync-codex-adapter.mjs --check`), and the installed
output goes through the ordinary upgrade verdict tests
(`packages/cli/test/upgrade-codex-projection.test.ts`, describe: "planUpgrade
— the Codex projection files use the general verdict machinery (RP-179)").

No concrete defect surfaced during RP-179 that this extraction would fix.
`.claude/rules/invariants.md` names the corollary directly: prefer deleting a
rule to adding one, and an abstraction added without a defect behind it is
exactly the kind `invariants.md` warns against. If a future ticket needs
`init` or `upgrade` to re-derive the Codex projection at install time —
rather than copy its already-generated output — that is where the
extraction belongs, argued on that ticket's own defect. The measured cost of
*not* extracting it is below ("The measured cost of the tracked Codex
projection").

## Ruler and Superpowers (acceptance #6, #7) — no longer a name check

An earlier draft of this record enforced acceptance #6 and #7 by grepping
`templates/` for the literal words `Ruler` and `Superpowers`. The owner ruled
that out: **product names are not a security or licensing boundary.** A name
check proves only that a word is absent from the text it scans — it says
nothing about an unnamed fork, a renamed vendor drop, or a differently
branded tool that does the same thing, and it invites exactly the wrong fix
(renaming the text, not removing the payload). The name-based assertions in
`test/template/no-vendored-plugins.test.ts` are **deleted, not weakened**,
and replaced by what they were only ever a proxy for:

- **Ruler is not used for projection.** The accepted RP-179 scope note
  records that Spike F found Ruler's projection destructive on a bounded
  fixture; this ticket produced no new bounded fixture that disproves that,
  so the prior finding stands. What is now mechanically true, and checked, is
  stronger than a name's absence: Rig's Codex projection has exactly one
  source (`scripts/sync-codex-adapter.mjs`, pinned by
  `test/template/codex.test.ts` › "is in sync with its Claude Code sources"),
  and the published-artifact allowlist below would fail on a second
  projection tool's output — Ruler's or anyone else's — without needing to
  know its name.
- **Superpowers is not part of the default/product profile.** Its overlapping
  capabilities have not been enumerated or shown to be selectively disabled,
  so acceptance #7's precondition is unmet — and what makes that true
  mechanically is the same allowlist: `templates/` and the published tarball
  contain nothing but this repository's own authored content and its own
  compiled CLI, so no plugin bundle can be present without the allowlist
  test failing on its shape, regardless of what it is called.

## No third-party payload, checked by shape (acceptance #5)

Proved by artifact shape, not by name, per the owner's ruling above. Three
independent checks in `packages/cli/test/package-contents.test.ts`, each
closing a different way a third-party payload could arrive in the published
tarball:

1. **A strict allowlist over the actual published file list.** ›
   "publishes only paths under the declared roots — an unexpected path fails
   by shape, not by name" packs the real tarball (`npm pack --json`) and
   asserts every path matches one of five roots: `CHANGELOG.md`, `LICENSE`,
   `README.md`, `package.json`, `scripts/prepare.mjs` (exact), or
   `packages/cli/dist/` / `templates/` (prefix). A vendored directory,
   however named, matches none of them.
2. **The compiled output is provably ours.** › "ships only compiled CLI
   output under packages/cli/dist — every path there is a plain .js file,
   nothing else" asserts every `packages/cli/dist/` path ends in `.js` — no
   leaked TypeScript source, source map, or a second tool's bundle sitting
   beside the compiler's own output.
3. **No vendor, cache, or dependency-install-shaped directory**, checked a
   second, independent way: › "carries no vendor, cache, or
   dependency-install-shaped directory — a second, independent proof of the
   same property" rejects any published path containing a `node_modules`,
   `vendor`, `third_party`, `third-party` or `.cache` segment.

The source-side counterpart, before a build even runs, is
`test/template/no-vendored-plugins.test.ts`'s `isVendoredArtifact` over
`templates/` — the same shape predicate, checked earlier and faster.

**Together these prove the premise the license question depends on** —
*nothing third-party is redistributed* — **rather than asserting the
conclusion.** The owner's correction, stated exactly because an earlier
instinct here was wrong: the absence of a third-party `LICENSE` or `NOTICE`
file is not itself evidence of anything, and is not asserted by anything in
this repository. Some permitted distribution methods *require* such a
notice; a bare "no LICENSE file ships" check would have rewarded a project
for omitting a notice it might owe, which is a worse invariant than none.
This record asserts the premise instead, and states only the conclusion that
premise actually supports: **because the checks above prove nothing
third-party is redistributed, no third-party license or notice obligation
exists today.** If a future ticket vendors or bundles an external tool's
payload, the allowlist test is the forcing function — a new root has to be
added to it deliberately — and *that* is the point where this section must
be rewritten with that tool's licence terms and provenance, not before.

**Provenance for external tools actually integrated with: none today.** Rig
integrates with zero third-party tools by shipped payload. The Memory
subsystem (`packages/cli/src/lib/subsystems.ts`) is contacted at runtime
through a subprocess version handshake (`--version --json`); it is never
vendored or bundled, and ships no code of its own. There is no provenance to
document yet — this paragraph is the placeholder a future integration must
replace with real terms, not a claim that none will ever be needed.

**Both published manifests keep zero runtime dependencies.**
`package-contents.test.ts` › "declares no runtime `dependencies` in the
published package.json" (the root manifest a published install resolves)
and › "declares no runtime `dependencies` in packages/cli/package.json, the
manifest the CLI is actually built from" — checked separately because a
dependency declared only in `packages/cli/package.json` would never appear
as a literal path in the tarball (`tsc` does not inline imports), so the
allowlist checks above cannot see it; this closes that gap at the source,
even though the package itself is never published (`prepublishOnly` refuses
it).

## The measured cost of the tracked Codex projection

Numbers, not adjectives, measured at branch head `7e0f01f` (re-run these
commands to re-measure at a later head):

- **Tracked files: 14.**
  `git ls-files templates/agent-os/universal/.codex
  templates/agent-os/universal/.agents templates/agent-os/universal/AGENTS.md
  | wc -l`
- **Tracked lines: 2,408.** The same file list piped to `wc -l` per file:
  `git ls-files templates/agent-os/universal/.codex
  templates/agent-os/universal/.agents templates/agent-os/universal/AGENTS.md
  | xargs wc -l | tail -1`
- **Dedicated test cases: 24.** 15 in `test/template/codex.test.ts`'s first
  describe block, `'Codex adapter is generated from the Claude Code Agent
  OS'` (`sed -n '54,568p' test/template/codex.test.ts | grep -cE
  '^\s*it\('`, the range ending where the next top-level `describe` starts),
  plus 9 in `packages/cli/test/upgrade-codex-projection.test.ts` (3
  `it.each` blocks × 3 projected paths each).
- **Synchronisation points: 20 distinct files.** The union of (a) files that
  import or call the generator's own functions —
  `grep -rl 'sync-codex-adapter\|codexAgent\|codexHooks\|expectedFiles'
  --include='*.mjs' --include='*.ts' scripts packages/cli test` (9 files) —
  and (b) files that hardcode one of the projected paths —
  `grep -rl '\.codex/agents\|\.agents/skills\|\.codex/hooks\.json\|\.codex/config\.toml'
  --include='*.ts' --include='*.mjs' --include='*.json' test
  packages/cli/src packages/cli/test scripts
  templates/agent-os/universal/layers.json` (19 files) — deduplicated to 20.
  Any one of these 20 can go stale independently if the projection's shape
  changes; none of them is optional to keep current.

**What kinds of upstream change would force a Rig edit**, read directly from
`scripts/sync-codex-adapter.mjs`'s own logic:

1. Claude changes which frontmatter fields an agent spec carries (`name`,
   `description`, `tools`, `model`, `effort`) — `parseAgent()` and
   `codexAgent()` read exactly these five.
2. Claude changes hook event names or the `matcher` syntax in
   `.claude/settings.json` — `codexHooks()`'s event/matcher mapping is
   written against the current shape.
3. Codex changes its own `.codex/hooks.json` schema, or the `command` /
   `commandWindows` split — `codexHooks()`, `portableHookCommand()` and
   `windowsHookCommand()` all assume the current one.
4. Codex changes its custom-agent TOML schema (`model_reasoning_effort`,
   `sandbox_mode`, `developer_instructions`) — `codexAgent()`'s field names
   are written against the current one.
5. Codex changes where it discovers skills or hooks (today `.agents/skills`
   and project-local `.codex/hooks.json`) — every destination path in
   `expectedFiles()` and every literal path in `layers.json` would need to
   move together.
6. Codex ships a scriptable, non-interactive plugin install path — the gap
   this whole record is written around. That is the trigger that reopens
   "Why not now" above and RP-22's own installer-selection logic, not a
   reason to touch the projection itself.

## Evidence

- `test/template/no-vendored-plugins.test.ts` — all three tests: no
  vendored, bundled, or plugin-catalog-shaped path under `templates/`, and
  the non-vacuous predicate check.
- `packages/cli/test/package-contents.test.ts` › "publishes only paths under
  the declared roots — an unexpected path fails by shape, not by name" and ›
  "is non-vacuous: the allowlist rejects a vendored or plugin-catalog path of
  every shape, and clears the real roots" and › "carries no vendor, cache,
  or dependency-install-shaped directory — a second, independent proof of
  the same property" and › "ships only compiled CLI output under
  packages/cli/dist — every path there is a plain .js file, nothing else"
  and › "declares
  no runtime `dependencies` in the published package.json" and › "declares
  no runtime `dependencies` in packages/cli/package.json, the manifest the
  CLI is actually built from".
- `packages/cli/test/upgrade-codex-projection.test.ts` › "%s: unchanged
  upgrades cleanly" and › "%s: an edit is reported as a conflict, never
  silently overwritten" and › "%s: a deletion stays deleted" — parametrized
  over `AGENTS.md`, `.codex/agents/test-writer.toml` and
  `.agents/skills/loop/SKILL.md`.
- `test/template/codex.test.ts` › "is in sync with its Claude Code sources".
