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
than an implementation ticket. Round 3 corrects three factual errors from
the round-1/round-2 drafts (below) and adds the one implementation change
those corrections justify (see "AGENTS.md is canonical").

## Corrections carried into this record (round 3)

Three claims in the round-1/round-2 drafts were wrong. Each is sourced here
directly against the official docs, not carried forward from the earlier,
less certain note that made the mistake:

1. **Claude Code reads `AGENTS.md` natively since v2.1.277.**
   https://code.claude.com/docs/en/memory, section "AGENTS.md": with an
   `AGENTS.md` and no `CLAUDE.md`/`.claude/CLAUDE.md`/`CLAUDE.local.md` at or
   above the working directory, Claude reads `AGENTS.md` directly; with a
   `CLAUDE.md` present, Claude reads `CLAUDE.md` only (default
   `claude-md-or-agents-md`); a `CLAUDE.md` that imports `@AGENTS.md` gets
   both, the import first. The reader is itself a built-in plugin
   (`agents-md@builtin`), configured via `pluginConfigs` →
   `options.instructionFiles`, values `claude-md-or-agents-md` (default),
   `claude-md-and-agents-md`, `claude-md`, `managed-only`. Direct reading is
   unavailable: on a Claude Code version before v2.1.277; in a session that
   cannot fetch feature flags (Bedrock, another third-party provider,
   telemetry disabled); in the first session after an install or upgrade to
   a version with support; and when `disableAllHooks`, `allowManagedHooksOnly`,
   or a disabled built-in `agents-md` plugin applies. `AGENTS.md` does **not**
   appear in `/memory` or `/context`, and `InstructionsLoaded` hooks do not
   fire for it (only for a `CLAUDE.md`-imported copy) — both relevant to what
   a future `doctor` check could observe. The official page's own recommended
   migration for "a `CLAUDE.md` containing `@AGENTS.md`" is: "you can leave
   it... keep it if some of your sessions can't load `AGENTS.md` directly" —
   exactly the shape this record adopts below. This finding did **not**
   change whether `AGENTS.md` support implies `.agents/skills/` support — it
   does not; skills remain a separate, already file-based mechanism on both
   harnesses.
2. **A project-scoped Claude plugin does not put its payload in the
   repository.** The round-2 draft implied it did; that is false. Per
   https://code.claude.com/docs/en/plugins-reference, installed plugin
   payloads are cached at `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`,
   outside any repository. `--scope project` writes only the enablement —
   the `enabledPlugins` field — into the project's `.claude/settings.json`.
   The CLI is scriptable: `claude plugin marketplace add <url> [--scope
   project] [--json]`, `claude plugin install <plugin> [--scope user|project|
   local] [--config key=value] [-y|--yes] [--accept-command <sha256>]
   [--json]` (`--accept-command`, v2.1.271+), `claude plugin update`,
   `claude plugin uninstall [--keep-data] [--json]`, `claude plugin enable/
   disable`, `claude plugin list`, `claude plugin validate <path>
   [--strict]`. `version` in `plugin.json` pins. This changes the "does a
   native plugin reduce tracked payload" conclusion honestly: **yes, for the
   guard scripts themselves** — only the enablement stanza would need to be
   tracked, not `.claude/hooks/*.mjs`. The counter-consideration the earlier
   draft reached for — plugin hooks disappearing under `disableAllHooks`/
   `allowManagedHooksOnly` — was **also wrong** and is corrected in "The
   security promise, restated" below: it is not a reason to prefer tracked
   hooks, because tracked hooks have no surviving advantage there either.
3. **Codex has native plugin installation — just no documented unattended
   command.** The round-1/round-2 drafts' "no scriptable plugin install
   surface at all" was read, correctly, as "no unattended install command",
   but is corrected here to state the positive case too, because the
   negative framing alone reads as "impossible" and it is not:
   https://learn.chatgpt.com/docs/plugins — "In Codex CLI, enter `/plugins`
   to open the plugin browser. Install a plugin from a configured
   marketplace, then start a new session before using its bundled skills or
   tools." Installed plugins bundle skills, MCP servers, and hooks. Cross-
   harness plugin delivery **is possible**, with one interactive confirmation
   on the Codex side; there is still no documented non-interactive/scriptable
   install command or API at this baseline, which is the accurate, narrower
   claim.

## AGENTS.md is canonical

Correction 1 is evidence for RP-179's own "remove tracked duplicate
projections when replacement evidence exists" scope bullet, which had no
target until now. `templates/agent-os/universal/AGENTS.md` is the authoring
surface for the shared rulebook; `templates/agent-os/universal/CLAUDE.md` is
reduced to the one-line compatibility shim the official docs themselves
recommend — `@AGENTS.md` and nothing else, because no genuinely
Claude-specific instruction exists in this rulebook today. The shim keeps
working on a Claude Code build before v2.1.277 and in every configuration
where direct `AGENTS.md` reading is unavailable (listed in correction 1
above) — that is what the import is for.

`scripts/sync-codex-adapter.mjs` composes the one document (`CLAUDE_MD_SHIM`,
a single exported constant, `'@AGENTS.md\n'`) instead of two; the direction
reverses what it did before round 3 — it used to derive `AGENTS.md` from
`CLAUDE.md`'s content, and now verifies `AGENTS.md` exists and derives
`CLAUDE.md` from that. `scripts/sync-agent-os.mjs` composes this repository's
own root `AGENTS.md` (the full rulebook plus this repo's addendum) and root
`CLAUDE.md` (the same shim) the same way.
`templates/agent-os/universal/.claude/scripts/detect-missed-gate.mjs`'s
`readDeclaredPaths` — the shipped, elevated-path enforcement layer every
generated rig receives — now reads both `CLAUDE.md` and `AGENTS.md` per
project layer and unions whatever `elevated-paths` block either carries,
rather than reading `CLAUDE.md` alone: a project that customises `CLAUDE.md`
past the shim is still read, and the canonical block in `AGENTS.md` is found
either way.

The byte-equality assertion that used to prove Claude and Codex got the same
map (`test/template/codex.test.ts`, previously "%s exposes the same
repository map as AGENTS.md") is **re-aimed, not deleted**: it now asserts
`CLAUDE.md` equals the exported `CLAUDE_MD_SHIM` constant exactly, which goes
red the moment anyone re-duplicates the shared text into `CLAUDE.md` instead
of editing `AGENTS.md`. Every other test that read installed/composed
`CLAUDE.md` for rulebook content (twenty-plus call sites across
`test/template/`, `packages/cli/test/`, and `test/e2e/` — found by grepping
for `CLAUDE.md` content assertions, not guessed) now reads `AGENTS.md`
instead, and a new assertion beside each confirms `CLAUDE.md` is exactly the
shim. `generator-neutrality.test.ts`, `decision-records.test.ts`'s
orphan-citation check, `packages/cli/src/commands/init.ts`'s pre-existing-
file handling, and the e2e init/create tests were checked and needed no
change beyond the content re-aim above: `init.ts` treats `CLAUDE.md` and
`AGENTS.md` as two ordinary managed files (both refuse to clobber a
pre-existing copy) with no content-specific logic; the neutrality scan
checks both paths exist and are ticket-free, which holds regardless of which
one carries the prose; and `decision-records.test.ts`'s citer set already
holds — `CLAUDE.md` carried zero direct `docs/decisions/` citations before
this change, so nothing was orphaned by moving its (absent) citations.

## What was evaluated

Both providers' plugin surfaces, verified directly against their official
documentation on 2026-09-20 (round 1) and 2026-09-21 (round 3 corrections,
above):

- **Claude Code has a real, scriptable, project-scoped plugin install path,
  and its payload never lands in the repository.** A plugin manifest
  (`.claude-plugin/plugin.json`) and an optional marketplace manifest
  (`.claude-plugin/marketplace.json`, including local-directory marketplaces
  with no publish step) are documented at
  https://code.claude.com/docs/en/plugins-reference and
  https://code.claude.com/docs/en/plugin-marketplaces. Installed payloads
  cache at `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`;
  `--scope project` writes only `enabledPlugins`/`extraKnownMarketplaces`
  into `.claude/settings.json`. The full command surface is in correction 2
  above.
- **Codex supports plugin installation through one interactive step; no
  unattended command is documented.** https://learn.chatgpt.com/docs/plugins:
  the `/plugins` browser installs a plugin (skills, MCP servers, hooks) from
  a configured marketplace and requires a new session afterward. No
  `plugins.<plugin>.enabled`-shaped config key or project-local
  `.codex/config.toml` capability for declarative, non-interactive
  enablement is documented. Codex's skills and hooks are already file-based
  and need no installer either way: `.agents/skills/<name>/SKILL.md` (per
  https://learn.chatgpt.com/docs/build-skills, which names direct file writes
  as a valid alternative to the optional `$skill-installer` convenience
  command) and project-local `.codex/hooks.json` — both exactly what
  `scripts/sync-codex-adapter.mjs` already produces.

## The decision

Rig does not migrate its own guard/skill/agent delivery to a native Claude
Code plugin in **this** release, and attempts no Codex-side plugin install
(none is unattended). This is narrower than the round-1/round-2 framing:
those drafts effectively argued the migration was not *worth* doing (wrong,
per correction 2 — it would reduce tracked payload); the real reason is that
it is a distinct, Tier-2-adjacent proposal (below), not that native delivery
lacks merit. Both harnesses keep receiving Rig's rulebook and guards as
installed repository files that `.claude/.rig-manifest.json` owns and
`upgrade` reconciles (`unchanged` / `update` / `conflict` / `deleted` /
`wiring`) — RP-179 acceptance #2 and #3, pinned in
`packages/cli/test/upgrade.test.ts`, `test/e2e/upgrade.test.ts` and
`packages/cli/test/upgrade-codex-projection.test.ts`. The one exception is
project instructions: `AGENTS.md` is canonical and `CLAUDE.md` is a
generated shim, per the section above — that change ships in this PR because
correction 1 gave RP-179's "remove tracked duplicate projections" bullet a
concrete target for the first time.

## Why not now

1. Moving the guard/hook/skill/agent *delivery mechanism* to
   `enabledPlugins`/`extraKnownMarketplaces` would move those files outside
   today's raw-byte manifest ownership model (`raw-byte-ownership.md`, beside
   this record) and change how `doctor`, `guard-rulebook` and upgrade
   diffing all discover them — a Tier-2 change (project
   `.claude/rules/autonomy.md`: "storage schema / data migrations" and
   "public API contract changes"), not something to fold into a ticket whose
   acceptance criteria are about the capability matrix and the generated
   fallback's determinism. This is a scope-and-sequencing argument, not a
   "no benefit" argument — see "Three delivery models" below for the benefit
   that argument was wrongly denying.
2. Codex has no unattended install surface, so for Codex the "generated
   fallback" is not a fallback of last resort today — it is the only
   mechanism that requires no interactive step, and it already exists and is
   already tested (`scripts/sync-codex-adapter.mjs`,
   `test/template/codex.test.ts`). A human running `codex /plugins`
   interactively once per machine is a real option RP-22 can choose; it is
   not equivalent to Rig's own `init`/`upgrade` doing it unattended.
3. Project `CLAUDE.md` asks for the narrowest change that satisfies the
   ticket ("Minimize scope of changes"); a native-plugin migration for
   guards/hooks/skills/agents is a distinct proposal with its own
   capability-matrix-backed case and its own manifest-model rework, not a
   side effect of this one.

## Three delivery models

The corrected capability picture (above) supports three distinct models,
not the two-way "native or tracked" framing the earlier drafts implied.
RP-22 picks among them per provider and per capability; none is a default
the other two are deviations from.

1. **Native plugin.** Hook/skill/agent payload lives in the provider's own
   cache (`~/.claude/plugins/cache/...` for Claude Code); the repository
   tracks only the desired-state declaration — plugin id, marketplace/source,
   requested version or pin policy, required/optional, capabilities used,
   licence/provenance — plus whatever enablement stanza the provider's
   settings format needs (`enabledPlugins`/`extraKnownMarketplaces` for
   Claude Code). Update and uninstall go through the official plugin manager;
   `doctor` checks installed / enabled / effective (see "The security
   promise, restated" for why those three are not the same thing).
2. **Tracked fallback.** Used where a measured support matrix shows the
   provider or the project's supported version range lacks suitable plugin
   support — not on an assumption about `disableAllHooks` (corrected below).
   Codex is this model entirely today (no unattended install exists to
   choose model 1 with); Claude Code guard delivery is this model today
   because moving it is a distinct Tier-2 proposal (`Why not now`, item 1),
   not because model 1 does not work.
3. **Managed deployment.** An enterprise model — organisation-wide managed
   settings force-enabling plugins (`managed-settings.json`'s `enabledPlugins`)
   so they survive even `allowManagedHooksOnly`. Explicitly **not** required
   scope for user-facing Rig 0.10.0; noted here so a future ticket does not
   have to rediscover that it exists.

## The Claude-side plugin spike — UNVERIFIED, and why

The owner asked whether Rig's current guard scripts can be delivered through
a project-scoped Claude Code plugin with no behaviour loss, measured by
actually building a local-directory marketplace from this repository's own
guards and installing it (`claude plugin marketplace add` +
`claude plugin install <plugin>@<marketplace> -y --scope project --json`,
with `HOME`/`USERPROFILE` pointed at a throwaway profile so nothing touches
a real `~/.claude`, and full cleanup after).

**Not run.** The `claude` CLI is not installed in the isolated environment
this evaluation ran in (`which claude` / `claude --version`: command not
found). Per the safety rule this spike was given, an install is not attempted
without a reliably isolated profile — this is reported as a gap, not
papered over with an assumption. **This entire empirical question is
UNVERIFIED**, and RP-22 must measure it before choosing model 1 for any
Claude-side guard.

What the official docs alone DO answer, without running the install (cited,
not assumed):

- **Event/matcher schema parity is documented, not measured here.**
  https://code.claude.com/docs/en/hooks: plugin hooks (`hooks/hooks.json`
  in the plugin directory) "run on all the same events with the same matcher
  patterns" as project `settings.json` hooks, and merge with them rather than
  replacing them. Rig's own shipped `.claude/settings.json` declares exactly
  three events — `PreToolUse` (matchers `Write|Edit|MultiEdit|NotebookEdit|
  apply_patch`, `Bash|PowerShell`, `Agent`), `Stop`, `SessionStart` (measured:
  `node -e` over the parsed JSON) — all three are in the documented events
  list and none is plugin-hook-incompatible on paper.
- **Handler types, path placeholders, and Windows execution are documented
  identically for both delivery forms.** Both support `type: "command"`
  (plus `http`, `mcp_tool`, `prompt`, `agent`); both resolve
  `${CLAUDE_PROJECT_DIR}`; a plugin hook additionally resolves
  `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}`; both accept a
  `"shell": "powershell"` field for Windows execution. Whether Rig's actual
  guard scripts — which read `CLAUDE_PROJECT_DIR` today, and whose Codex
  projection already carries a separate `commandWindows` form — need any
  change to run correctly as a plugin (e.g. would they need
  `${CLAUDE_PLUGIN_ROOT}` instead, or does `${CLAUDE_PROJECT_DIR}` keep
  working unchanged for a project-scoped plugin) is **UNVERIFIED**: the docs
  describe the placeholder, not this repository's own scripts' behaviour
  under it.
- **UNVERIFIED and named for RP-22 to measure:** whether a plugin manifest's
  `skills` path may point outside the plugin root at a shared directory (so
  a plugin could reference Rig's existing `.claude/skills/` without copying
  it) — not stated on the pages fetched for this record; what happens to
  guard enforcement between a plugin's uninstall and its marketplace
  disappearing (a gap window, or atomic); exactly what `doctor` would need
  recorded to tell installed / enabled / disabled / effective apart (see
  next section); and which minimal bootstrap files would still need to stay
  tracked under model 1 (candidates, unverified: the enablement stanza in
  `.claude/settings.json`, `.claude/.rig-manifest.json`, and anything a
  guard imports today that a plugin cannot carry, such as
  `.claude/hooks/lib/edit-input.mjs`).

## The security promise, restated (correction to round 2)

Round 2 argued tracked project hooks should be kept because plugin hooks
"disappear together with the plugin under `disableAllHooks`/
`allowManagedHooksOnly`". **The owner caught that this is wrong,** per
https://code.claude.com/docs/en/hooks: `disableAllHooks` disables user,
project, local, **and** plugin hooks alike — only a managed-level
`disableAllHooks` can disable managed hooks, and nothing here is managed.
`allowManagedHooksOnly` blocks user, project, local, **and** plugin hooks,
with exactly one exception: hooks from plugins force-enabled in managed
settings' `enabledPlugins` remain active. So a tracked project hook has **no
execution advantage** over a plugin hook under either lockdown — if
anything, a managed-forced plugin is the more resilient of the two, since it
is the only delivery form that survives `allowManagedHooksOnly` at all.

The corrected promise, stated the way the owner asked it to be stated:
**Rig installs and verifies guard capability; if harness policy disables
hooks, Rig does not claim protection, and `doctor` returns an explicit
degraded/disabled status rather than staying silent.** Delivery mechanism
(native plugin vs. tracked fallback) and permission to execute
(`disableAllHooks`, `allowManagedHooksOnly`, a session that never trusted
the folder) are two different axes, and this record does not conflate them:
neither delivery form promises execution the harness's own policy has
switched off, and the only thing a delivery choice controls is *how the
guard code reaches the machine*, not *whether it is allowed to run there*.

## What RP-22 owns (owner ruling, corrected)

RP-179 is reclassified by the owner as a capability evaluation and
architecture decision — not an implementation ticket, and not a delivery
promise binding on whatever ticket comes next. Stated plainly, because an
earlier draft of this record read as though RP-22 inherited "plugin-first
delivery" as a settled architecture: **it does not.** RP-22 owns, on its own
authority, not as a continuation of this record's scope:

- the desired-state declaration for whatever it installs: plugin id,
  marketplace/source, requested version or pin policy, required/optional,
  capabilities used, licence/provenance;
- Claude-side automation through the official, scriptable CLI (correction 2
  above: `marketplace add`, `install --scope project -y`, `update`,
  `uninstall`), where the capability matrix shows it is sufficient;
- a Codex-side guided `/plugins` step (one interactive confirmation, per
  correction 3) followed by machine verification — not a promise of full
  Codex automation, because none is documented;
- pin/version policy for whatever it installs;
- receipts (including the installation-mode vocabulary this record explicitly
  declines to create — see "Receipt vocabulary" below), `doctor`
  verification of installed / enabled / disabled / effective, and uninstall
  guidance;
- no repackaging of third-party payload — the same invariant this record's
  artifact checks pin (see "No third-party payload, checked by shape"),
  carried forward as a constraint on RP-22, not reargued by it;
- choosing among the three delivery models above per provider and per
  capability — **fallback projection only where native non-interactive
  installation is measured absent**, not assumed absent. RP-22 does not
  default to generating a fallback first and reaching for a native mechanism
  later, and it does not skip the Claude-side plugin spike above just
  because this record could not run it.

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

### What remains duplicated after the AGENTS.md shim, per surface

Not every tracked pair is the same kind of cost. Measured at this head, one
command per row:

| pair | shape | measured |
| --- | --- | --- |
| `AGENTS.md` (canonical) vs `CLAUDE.md` (shim) | **duplication removed** — the shim is one line, not a copy | `wc -l templates/agent-os/universal/AGENTS.md templates/agent-os/universal/CLAUDE.md` → 207 and 1 |
| `.claude/skills/**` vs `.agents/skills/**` | **byte-identical duplication**, still tracked | `diff -rq templates/agent-os/universal/.claude/skills templates/agent-os/universal/.agents/skills` → no differences; `git ls-files templates/agent-os/universal/.claude/skills \| wc -l` → 7 files; `git ls-files templates/agent-os/universal/.claude/skills \| xargs wc -l \| tail -1` → 2,114 lines, each side |
| `.claude/agents/*.md` vs `.codex/agents/*.toml` | **projection, not duplication** — 393 lines of agent specs compress to 24 lines of routing data (name/description/model/effort/sandbox), not a copy of the prose | `git ls-files templates/agent-os/universal/.claude/agents \| xargs wc -l \| tail -1` → 393; `git ls-files templates/agent-os/universal/.codex/agents \| xargs wc -l \| tail -1` → 24 |
| `.claude/settings.json` vs `.codex/hooks.json` | **schema projection** — same wiring, two hook-config schemas (Claude's matcher groups vs. Codex's `command`/`commandWindows` pair) | `wc -l templates/agent-os/universal/.claude/settings.json templates/agent-os/universal/.codex/hooks.json` → 69 and 60 |

The skills pair is the one place this record found real, avoidable
duplication left after the `AGENTS.md` shim — not projected, not derived
differently per harness, just the same bytes tracked twice because Codex
reads `.agents/skills/` and Claude reads `.claude/skills/`. Whether that is
worth collapsing (a symlink, a single source both harnesses' installers
point at) is not decided here: it is a smaller, narrower version of the same
Tier-2-adjacent question "Why not now" already deferred, and it does not
change under RP-179's minimal-scope instruction just because the shim above
happened to be small enough to do in this PR.

## The final table — one row per surface

Per the owner's requested shape: **native plugin** (a provider's own
mechanism carries the capability, repository tracks only the desired-state
declaration) / **tracked fallback** (repository carries the payload because
no suitable native mechanism is available, measured, not assumed) /
**provider-specific projection** (one source, two schemas, by necessity —
not a delivery-model choice) / **duplication removed** (this PR) /
**deferred to RP-22** (the model choice is RP-22's to make, informed by the
measurement gaps above).

| surface | model | why |
| --- | --- | --- |
| project instructions (`AGENTS.md` + `CLAUDE.md` shim) | **duplication removed** | Claude Code reads `AGENTS.md` natively since v2.1.277 (correction 1); no plugin or projection was ever the right model for prose Codex also reads directly from `.agents`-adjacent conventions — the fix was deleting the second copy, not projecting it. |
| hooks/guards (`.claude/hooks/*.mjs`, wired in `.claude/settings.json`) | **tracked fallback today; deferred to RP-22** | The Claude-side plugin spike is UNVERIFIED (no `claude` CLI in this environment) — model 1 (native plugin) is not ruled out, only unmeasured. Model 2 (tracked fallback) is what ships, justified by scope/sequencing (`Why not now`, item 1), not by a security argument (corrected above: delivery model does not change what `disableAllHooks`/`allowManagedHooksOnly` can switch off). |
| skills (`.claude/skills/**`, `.agents/skills/**`) | **tracked fallback on both harnesses; byte-identical duplication, unresolved** | Neither harness's skill mechanism needs an installer (both are "a directory with a file", read directly) — so there is no native-plugin model to move to; the two copies exist because the two harnesses look in different directories, not because of any capability gap. See the duplication table above. |
| subagent definitions (`.claude/agents/*.md` → `.codex/agents/*.toml`) | **provider-specific projection** | Codex's custom-agent format has no place to reference an external Claude agent spec; the 393→24-line compression is `scripts/sync-codex-adapter.mjs` deriving Codex's own schema from Claude's, which is what a projection is for. |
| permissions (`.claude/settings.json`'s tool matchers, `PermissionRequest`) | **deferred to RP-22** | Not evaluated by this record at all — RP-179's scope was guard/skill/agent delivery and the compatibility matrix, not the permission model. Flagged here so RP-22 does not assume silence means "no work needed". |
| provider settings (`.claude/settings.json` vs `.codex/hooks.json`, `.codex/config.toml`) | **provider-specific projection** | Two incompatible hook-wiring schemas for the same intent; `codexHooks()` is the projection, and it is necessary regardless of which delivery model (1 or 2) eventually carries the hooks themselves — a native Claude plugin would still need Codex's own file-based wiring generated the same way. |
| the Codex projection as a whole (`.codex/`, `.agents/`) | **tracked fallback, and the entire mechanism for Codex** | Correction 3: Codex has no unattended install command, so "fallback" undersells it — it is the only delivery path RP-22 can automate without a human at a keyboard. `doctor` verification and the desired-state declaration RP-22 owns still apply; there is no model-1 alternative to defer to until Codex documents one (`Why not now`, item 2). |

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
- `test/template/codex.test.ts` › "is in sync with its Claude Code sources"
  and › "%s: CLAUDE.md is the @AGENTS.md shim, and AGENTS.md carries
  the shared rulebook" and › "declares generated Codex hook wiring as an
  elevated path".
- `test/template/dogfood.test.ts` › "the composed AGENTS.md names this repo
  and keeps the repo addendum" and › "CLAUDE.md is the @AGENTS.md shim, and
  restates none of the composed rulebook" and › "declares elevated paths
  that actually exist in THIS repo" and › "declares every file that
  declares elevated paths of its own".
- `test/template/gate-scripts.test.ts` › "the shipped AGENTS.md declares a
  non-empty, commented block".
- `packages/cli/test/init.test.ts` › "installs the process layer into an
  existing repo" and › "CLAUDE.md is the @AGENTS.md shim, and restates none
  of the rulebook" and › "declares elevated paths that exist here, not in
  the generated shape".
