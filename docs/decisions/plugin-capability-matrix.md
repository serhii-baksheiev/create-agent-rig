# Why Rig does not adopt native plugin delivery yet

⚠ **This record is not synced.** Most files in this directory are composed
from `templates/agent-os/universal/docs/decisions/` by
`scripts/sync-agent-os.mjs` and travel into every generated project; the
exceptions are this record, `memory-rig-boundary.md` and
`cost-ceiling-over-growth-ratio.md`, which carry the same banner for the same
reason. This one rules on this product's own delivery mechanism and names no
rule a shipped rulebook cites, so `test/template/decision-records.test.ts`
would refuse it in the template layer. **Edit it in place.**

Status: accepted for RP-179.

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
extraction belongs, argued on that ticket's own defect.

## Ruler and Superpowers (acceptance #6, #7)

- **Ruler is not used for projection.** The accepted RP-179 scope note
  records that Spike F found Ruler's projection destructive on a bounded
  fixture. This ticket produced no new bounded fixture that disproves that
  result, so the prior finding stands and Ruler stays unadopted. Mechanically
  pinned: `test/template/no-vendored-plugins.test.ts` asserts no path or file
  content under `templates/` names Ruler.
- **Superpowers is not part of the default/product profile.** Its overlapping
  capabilities (relative to Rig's own guards and skills) have not been
  enumerated or shown to be selectively disableable, so acceptance #7's
  precondition is unmet. Mechanically pinned by the same test.

## No third-party source, no marketplace, zero runtime dependencies (acceptance #5)

Already true before this ticket — root `package.json` has never declared a
`dependencies` field, and nothing under `templates/` has ever vendored a
third-party plugin. RP-179 makes both mechanically enforced rather than
merely currently true:
`test/template/no-vendored-plugins.test.ts` (no `.claude-plugin/` directory,
no `marketplace.json` file, anywhere under `templates/`) and
`packages/cli/test/package-contents.test.ts` (the same two checks against the
actual `npm pack` tarball, plus the zero-runtime-dependency assertion against
the published `package.json`).

## Receipt vocabulary, not receipt code (for RP-22)

RP-179's scope bullet asks that a future `doctor` receipt record
provider/plugin identity and observed version. That receipt is RP-22's to
build. This ticket only reserves the vocabulary word: `native-plugin` joins
`external-installer`, `hosted-service` and `external-executable` as a legal
installation-mode value, for the day a capability in `docs/compatibility.md`
moves from `UNVERIFIED`/`NOT-APPLICABLE` to a native-plugin `SUPPORTED`. No
code in this repository reads or writes that value yet, and nothing here
claims otherwise.

## Evidence

- `test/template/no-vendored-plugins.test.ts` — all four tests: no
  `.claude-plugin/`, no `marketplace.json`, no Ruler/Superpowers reference
  under `templates/`, and the non-vacuous mutation check.
- `packages/cli/test/package-contents.test.ts` › "keeps a `.claude-plugin/`
  directory and a `marketplace.json` file out of the published tarball" and
  › "declares no runtime `dependencies` in the published package.json".
- `packages/cli/test/upgrade-codex-projection.test.ts` › "%s: unchanged
  upgrades cleanly", "%s: an edit is reported as a conflict, never silently
  overwritten" and "%s: a deletion stays deleted" — parametrized over
  `AGENTS.md`, `.codex/agents/test-writer.toml` and
  `.agents/skills/loop/SKILL.md`.
- `test/template/codex.test.ts` › "is in sync with its Claude Code sources".
