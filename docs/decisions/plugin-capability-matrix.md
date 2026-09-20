# Why Rig does not adopt native plugin delivery yet

⚠ **This record is not synced.** Most files in this directory are composed
from `templates/agent-os/universal/docs/decisions/` by
`scripts/sync-agent-os.mjs` and travel into every generated project; the
exceptions are this record, `memory-rig-boundary.md` and
`cost-ceiling-over-growth-ratio.md`, which carry the same banner for the same
reason. This one rules on this product's own delivery mechanism and names no
rule a shipped rulebook cites, so `test/template/decision-records.test.ts`
would refuse it in the template layer. **Edit it in place.**

Status: accepted for RP-179. **Round 2 corrects three factual errors from
the round-1 draft**, below — sourced directly against current official
documentation and a reproducible spike, not carried forward from the
earlier, less certain note that made the mistakes.

**A numbering note, stated once.** Every "acceptance #N" reference in this
record follows the numbering used since RP-179's earlier drafts (matching
the item order in PR #232's own acceptance table). The Jira RP-179
description was rewritten by the owner on 2026-09-20 with a **different**
numbered Acceptance list (1–7), and the two do not line up item-for-item —
e.g. the current ticket's acceptance #2 is "the decision record states, per
scope bullet, whether implemented/rejected/deferred", not "native
installation never silently overwrites a file" (this record's #2). This
record is not renumbered to match, because that is a larger, ticket-wide
correction outside this round's scope; every place below that names an
acceptance number is naming *this record's own*, pre-existing numbering,
not necessarily the current ticket's. Flagged for the gate to rule on.

## Corrections carried into this round

1. **A project-scoped Claude Code plugin does not put its payload in the
   repository.** The round-1 draft implied it did (via "attempts no
   Codex-side plugin install... Both harnesses keep receiving Rig's
   rulebook as installed repository files", read alongside its Claude-side
   bullet). That is false, and measured directly in
   `docs/decisions/plugin-delivery-spike-rp179.md`: `--scope project`
   writes only the enablement — `extraKnownMarketplaces` and
   `enabledPlugins`, 6 lines of JSON in this spike's fixture — into
   `.claude/settings.json`; the plugin's actual payload (`plugin.json`, the
   hook definition) is cached at
   `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, outside any
   repository. **This changes the "does native plugin delivery reduce
   tracked payload" answer honestly: yes, it can** — the previous framing
   below, which reasoned as though it could not, is corrected.
2. **Codex has native plugin installation.** The round-1 draft's "no
   scriptable plugin install surface at all" was read as "no unattended
   install command", but stated only the negative, which reads as
   "impossible" and is not: https://learn.chatgpt.com/docs/plugins,
   fetched 2026-09-20 — "In Codex CLI, run the following command to open
   the plugin browser: `codex /plugins`" — installs a plugin (skills, MCP
   servers, hooks) from a configured marketplace and requires a new session
   afterward. That page documents no config key, CLI flag, or API for a
   *non-interactive* install at this baseline. **The absence of a
   documented non-interactive API is not the same as impossibility of
   cross-harness plugin delivery**, and this record no longer says or
   implies that it is.

   > **Corrected 2026-09-20 by `integration-composition-rp22.md` M6:** that
   > documented-interactive-only baseline has since moved. A live run of
   > `@openai/codex@0.155.1` found `codex plugin add/list/remove/marketplace
   > add`, a full non-interactive CLI with `--json` on every verb — trigger 6
   > below has fired. This does not itself re-decide "why not now"; RP-22
   > owns that re-decision (S6+).
3. **Whether tracked hooks hold any execution advantage over plugin hooks
   under `disableAllHooks`/`allowManagedHooksOnly` is unmeasured**, not
   assumed either way. The spike (`plugin-delivery-spike-rp179.md`) ran two
   independent documentation reads that disagreed on whether
   `disableAllHooks` also disables plugin hooks, and did not run a live
   session to observe it directly (out of the spike's bound — it would
   spend real inference for a question the CLI's own management commands do
   not answer). This record makes no security-boundary claim on that
   ground; "Why not now" below is a scope-and-sequencing argument, never a
   security argument.

## What was evaluated

Both providers' plugin surfaces, verified directly against their official
documentation on 2026-09-20, plus one reproducible spike measuring the
Claude-side install mechanics directly in an isolated profile
(`docs/decisions/plugin-delivery-spike-rp179.md`):

- **Claude Code has a real, scriptable, project-scoped plugin install
  path, and its payload does not land in the repository.** A plugin
  manifest (`.claude-plugin/plugin.json`) and an optional marketplace
  manifest (`.claude-plugin/marketplace.json`, including local-directory
  marketplaces with no publish step) are documented at
  https://code.claude.com/docs/en/plugins-reference and
  https://code.claude.com/docs/en/plugin-marketplaces. Non-interactive,
  project-scoped enablement is exact and documented, and was run directly
  against Claude Code 2.1.278 in an isolated `HOME`: `claude plugin
  marketplace add <path> --scope project`, `claude plugin install
  <plugin>@<marketplace> --scope project -y --json`, `disable`/`enable`,
  `uninstall` — every one exercised in the spike, every one leaving exactly
  one file changed inside the project (`.claude/settings.json`) and the
  actual plugin payload cached under `~/.claude/plugins/cache/...`.
- **Codex has native plugin installation, through the interactive
  `/plugins` command; no documented non-interactive install command or API
  was found at this baseline.** https://learn.chatgpt.com/docs/plugins,
  fetched 2026-09-20: `codex /plugins` opens a plugin browser; installed
  plugins bundle skills, MCP servers, and hooks; a new session is required
  before using them. That page names no config-key or CLI-flag path for a
  non-interactive install, and this record's search did not find one
  elsewhere at this baseline — stated as a dated search result, not as a
  proof that none exists. Codex's skills and hooks are already file-based
  and need no installer either way: `.agents/skills/<name>/SKILL.md` (per
  https://learn.chatgpt.com/docs/build-skills, which names direct file writes
  as a valid alternative to the optional `$skill-creator` convenience
  command) and project-local `.codex/hooks.json` — both exactly what
  `scripts/sync-codex-adapter.mjs` already produces.

## The decision

Rig does not migrate its own guard/skill/agent delivery to a native Claude
Code plugin in this release, and does not attempt a Codex-side plugin
install (the one documented path is interactive, and `init`/`upgrade` run
unattended). This is narrower than the round-1 framing: that draft
effectively argued the Claude-side migration was not *worth* doing, which
correction 1 shows was wrong — it would reduce tracked payload. The real
reason is sequencing (below), not lack of benefit. Both harnesses keep
receiving Rig's rulebook as installed repository files that
`.claude/.rig-manifest.json` owns and `upgrade` reconciles (`unchanged` /
`update` / `conflict` / `deleted` / `wiring`) — RP-179 acceptance #2 and
#3, pinned in `packages/cli/test/upgrade.test.ts`,
`test/e2e/upgrade.test.ts` and `packages/cli/test/upgrade-codex-projection.test.ts`.

## Why not now

1. Moving Claude's delivery to `enabledPlugins`/`extraKnownMarketplaces` would
   move the installed files outside today's raw-byte manifest ownership model
   (`raw-byte-ownership.md`, beside this record) and change how `doctor`,
   `guard-rulebook` and upgrade diffing discover them — a Tier-2 change
   (project `.claude/rules/autonomy.md`: "storage schema / data migrations"
   and "public API contract changes"), not something to fold into a ticket
   whose acceptance criteria are about the capability matrix and the
   generated fallback's determinism. This is a scope-and-sequencing
   argument, not a "no benefit" argument (correction 1) and not a security
   argument (correction 3) — whether a plugin-delivered guard fires
   correctly under a live session and under the two lockdown settings is
   left **unmeasured** by this record, for RP-22 to close before choosing
   this model for any specific guard.
2. Codex documents no non-interactive install command, so for Codex today's
   generated fallback is not a fallback of last resort — for Rig's own
   *unattended* `init`/`upgrade`, it is the only mechanism that requires no
   human at a keyboard, and it already exists and is already tested
   (`scripts/sync-codex-adapter.mjs`, `test/template/codex.test.ts`). A
   person running `codex /plugins` interactively once per machine is a real
   option (correction 2) — it is just not equivalent to Rig's own installer
   doing it unattended.

   > **Corrected 2026-09-20 by `integration-composition-rp22.md` M6:**
   > "Codex documents no non-interactive install command" is no longer
   > accurate as a blanket statement — `codex plugin add/list/remove
   > /marketplace add --json` is a live, measured, non-interactive surface.
   > Trigger 6 has fired; this bullet's *sequencing* argument (already
   > tested, no human at a keyboard needed today) is unaffected until RP-22
   > re-decides whether to adopt the new surface.
3. Project `CLAUDE.md` asks for the narrowest change that satisfies the
   ticket ("Minimize scope of changes"); a native-plugin migration on the
   Claude side is a distinct proposal with its own capability-matrix-backed
   case and its own manifest-model rework, not a side effect of this one.

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
*not* extracting it is below.

## The measured cost of the tracked Codex projection

This answers the current Jira RP-179 acceptance list's item 6, quoted
exactly: "The cost of the retained tracked projection is recorded in
numbers measured from the tree."

Numbers, not adjectives, measured at branch head `7e0f01f` (re-run these
commands to re-measure at a later head):

- **Tracked files: 14.**
  `git ls-files templates/agent-os/universal/.codex
  templates/agent-os/universal/.agents templates/agent-os/universal/AGENTS.md
  | wc -l`
- **Tracked lines: 2,408.**
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
  --include='*.mjs' --include='*.ts' scripts packages/cli test` (10 files) —
  and (b) files that hardcode one of the projected paths —
  `grep -rl '\.codex/agents\|\.agents/skills\|\.codex/hooks\.json\|\.codex/config\.toml'
  --include='*.ts' --include='*.mjs' --include='*.json' test
  packages/cli/src packages/cli/test scripts
  templates/agent-os/universal/layers.json` (15 files) — deduplicated to 20.
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
6. Codex ships a documented, non-interactive plugin install path — the gap
   named in "What was evaluated" above. That is the trigger that reopens
   "Why not now" and RP-22's own installer-selection logic, not a reason to
   touch the projection itself.

   > **Fired, 2026-09-20** — `integration-composition-rp22.md` M6 measured
   > exactly this: `@openai/codex@0.155.1` ships `codex plugin
   > add/list/remove/marketplace add`, non-interactive, `--json` on every
   > verb. This note records that the trigger condition is now true; it does
   > not reopen "Why not now" itself — that re-decision is RP-22 S6+'s, not
   > this record's, to make.

This section does not itself argue for or against extraction or migration —
"Why not now" and the corrections above already do that, on scope and
measurement grounds respectively.

## Ruler and Superpowers

(numbers below are this record's own — see "A numbering note" above; the
current Jira ticket does not enumerate Ruler/Superpowers separately, and
folds both into its own acceptance #5)

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
build, and so is the vocabulary it is written in: the installation-mode words
RP-22's ticket text proposes (`external-installer`, `native-plugin`,
`hosted-service`, `external-executable`) live in that ticket and appear
nowhere in this repository — no enum, no schema, no type. This ticket
reserves nothing and produces no receipt; it leaves RP-22 the evidence above
to classify. Stated here because an earlier draft of this record claimed to
"reserve" a word in a vocabulary that does not exist.

## Recommendations for RP-22 and RP-186

Neither ticket inherits a settled architecture from this one; both inherit
evidence.

**RP-22** (official-installer composition, receipts, pin/version policy)
should, per guard/skill/agent and per provider:

- prefer the native Claude Code plugin path (correction 1) only after
  measuring, on a live session against an isolated profile, whether a
  plugin-delivered hook fires with the same reliability as a tracked one,
  and how it behaves under `disableAllHooks`/`allowManagedHooksOnly` —
  unmeasured here (correction 3), and not something this record's spike
  could close without spending real inference;
- treat Codex's `/plugins` as a real, documented, but interactive-only
  mechanism (correction 2) — a guided one-time step a person runs, never
  something `init`/`upgrade` invokes unattended, unless a future Codex
  release documents a non-interactive form (trigger 6 in the cost section
  above);

  > **Corrected 2026-09-20 by `integration-composition-rp22.md` M6:** trigger
  > 6 has fired — a non-interactive form (`codex plugin add/list/remove
  > /marketplace add --json`) is documented (via `--help`) and live-run,
  > measured there. Whether `init`/`upgrade` should invoke it unattended is
  > RP-22's decision to make (S6+), not decided or reversed by this note.
- build the receipt and its installation-mode vocabulary from the measured
  states in `plugin-delivery-spike-rp179.md` (`supported` /
  `degraded` / `unsupported` / `unverified`) rather than inventing new
  words, since none exist in this repository today (see "Receipt
  vocabulary" below).

**RP-186** (the AGENTS.md/CLAUDE.md migration parked on
`origin/wip/rp-186-agents-canonical`) inherits nothing from this record
about *how* to migrate — that work was explored in an earlier round of
this same branch and deliberately removed from PR #232's diff, per this
round's scope (a capability decision, not an instructions migration). What
this record does hand RP-186 is unrelated to plugin delivery and worth
stating anyway: nothing measured here (the plugin CLI spike, the Codex
`/plugins` finding) bears on whether `AGENTS.md` should become canonical —
that question turns on Claude Code's *instruction-file* reader, a
different mechanism from the plugin installer this record evaluates, and
RP-186 should verify that mechanism's own behaviour directly rather than
citing this record for it.

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
- `docs/decisions/plugin-delivery-spike-rp179.md` — the reproducible spike
  behind corrections 1–3 above: every command run, its exact output, and
  the per-model conclusion (`supported` / `degraded` / `unsupported` /
  `unverified`) for tracked hooks, Claude Code native plugin-delivered
  hooks, Codex native plugin-delivered hooks, and the hybrid model, with
  what was not run named explicitly.
