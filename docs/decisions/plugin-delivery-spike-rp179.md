# RP-179 spike — three hook-delivery models, measured

⚠ **Not synced.** Spike evidence for the RP-179 capability decision
(`docs/decisions/plugin-capability-matrix.md`, which cites this file). Not
sourced from `templates/agent-os/universal/docs/decisions/`, carries no rule
a shipped rulebook cites, and is not touched by `scripts/sync-agent-os.mjs`
(it only ever writes files present in its own composed map). **Edit it in
place, like the record that cites it.**

Ran 2026-09-20, in `$HOME/rig-179` at branch head `7e0f01f`, inside WSL
(Ubuntu). Every command below is exactly what was run — re-run them to
re-measure. Nothing here touched this repository's own `~/.claude`/`~/.codex`
or the shared WSL npm/global state: the CLI was installed to a throwaway npm
prefix, and every invocation carried an isolated `HOME` under `/tmp`.

## Setup — isolated, throwaway, never the real profile

```sh
mkdir -p /tmp/rp179-spike/npmprefix
npm install -g --prefix /tmp/rp179-spike/npmprefix @anthropic-ai/claude-code
export PATH=/tmp/rp179-spike/npmprefix/bin:$PATH
claude --version
# 2.1.278 (Claude Code) — provider version this spike measured against
```

A local-directory marketplace and a one-hook plugin, built by hand (not
downloaded), so the payload's identity and size are known exactly:

```sh
mkdir -p /tmp/rp179-spike/marketplace/.claude-plugin \
         /tmp/rp179-spike/marketplace/plugins/rig-guard-demo/.claude-plugin

cat > /tmp/rp179-spike/marketplace/.claude-plugin/marketplace.json <<'EOF'
{ "name": "rp179-spike-marketplace", "owner": { "name": "RP-179 spike" },
  "plugins": [ { "name": "rig-guard-demo",
    "source": "./plugins/rig-guard-demo",
    "description": "spike: one guard hook delivered as a plugin" } ] }
EOF

cat > /tmp/rp179-spike/marketplace/plugins/rig-guard-demo/.claude-plugin/plugin.json <<'EOF'
{ "name": "rig-guard-demo", "description": "spike: one guard hook delivered as a plugin",
  "version": "1.0.0", "author": { "name": "RP-179 spike" },
  "hooks": { "PreToolUse": [ { "matcher": "Write", "hooks": [
    { "type": "command",
      "command": "echo spike-guard-fired >> ${CLAUDE_PROJECT_DIR}/spike-guard.log" }
  ] } ] } }
EOF
```

## Model (a) — tracked project hooks (today's model)

**supported.** This is what Rig ships and runs today:
`.claude/hooks/*.mjs`, wired in `.claude/settings.json`, installed as
ordinary repository files that `.claude/.rig-manifest.json` owns and
`upgrade` reconciles. Not re-measured here because it is already under test
— `packages/cli/test/upgrade.test.ts`, `test/e2e/upgrade.test.ts`. Every
byte of the hook lives inside the repository, always, by construction: there
is no cache, no external payload, nothing to measure.

## Model (b) — native plugin-delivered hooks

### Claude Code — measured directly, project scope, isolated profile

```sh
export HOME=/tmp/rp179-spike/home2
cd /tmp/rp179-spike/project2 && git init -q .

claude plugin marketplace add /tmp/rp179-spike/marketplace --scope project
claude plugin install rig-guard-demo@rp179-spike-marketplace --scope project -y --json
cat .claude/settings.json
claude plugin disable rig-guard-demo@rp179-spike-marketplace --scope project --json
claude plugin enable  rig-guard-demo@rp179-spike-marketplace --scope project --json
claude plugin uninstall rig-guard-demo@rp179-spike-marketplace --scope project --json
find "$HOME/.claude/plugins" -type f
```

**Measured results:**

- **Files created inside the repository (`/tmp/rp179-spike/project2`):**
  exactly one — `.claude/settings.json`. Its entire content after both
  `marketplace add --scope project` and `install --scope project` is:
  ```json
  {
    "extraKnownMarketplaces": {
      "rp179-spike-marketplace": {
        "source": { "source": "directory", "path": "/tmp/rp179-spike/marketplace" }
      }
    },
    "enabledPlugins": { "rig-guard-demo@rp179-spike-marketplace": true }
  }
  ```
  6 lines of enablement/configuration. No copy of `plugin.json`, no copy of
  the hook script, nothing under a `.claude-plugin/` path, anywhere in the
  repository tree.
- **Files created outside the repository** (isolated `$HOME/.claude`):
  `plugins/cache/rp179-spike-marketplace/rig-guard-demo/1.0.0/.claude-plugin/plugin.json`
  (the actual plugin payload — the hook definition itself),
  `plugins/installed_plugins.json`, `plugins/known_marketplaces.json`,
  `settings.json` (holds `extraKnownMarketplaces` when the marketplace is
  added at the default `user` scope instead of `--scope project`, measured
  separately). **This directly falsifies the claim the previous draft of
  the decision record made** — a project-scoped install does not put the
  plugin's payload in the repository; only the enablement stanza lands
  there, and the payload is cached under the user's home directory.
- **Enable/disable:** `claude plugin disable … --scope project` flips
  `enabledPlugins["rig-guard-demo@rp179-spike-marketplace"]` to `false` in
  place (no file removed); `enable` flips it back to `true`. Both are `$0`
  exits with a `--json` result line.
- **Uninstall:** removes the `enabledPlugins` entry from
  `.claude/settings.json` entirely (leaving `extraKnownMarketplaces`
  behind — the marketplace registration and the plugin installation are
  independent). The cached payload under `$HOME/.claude/plugins/cache/...`
  is **not deleted** — it is marked with a sibling `.orphaned_at` file
  (cache eviction is deferred, not immediate; this spike did not wait to
  measure when/whether eviction runs, and reports that gap as
  **unverified**).
- **`--scope local`, restart requirement:** `claude plugin update`'s own
  `--help` text states "restart required to apply" (measured from the CLI's
  own help output, not the docs site) — not independently re-verified by
  running an update, because the spike's one-hook fixture has no second
  version to update to; **unverified**.
- **Trusted vs. untrusted project:** none of the commands above prompted for
  folder trust, even though `/tmp/rp179-spike/project2` was a bare `git
  init` with no prior Claude Code session in it. Headless plugin-management
  commands did not gate on project trust in this run — **measured**, not
  assumed, but only for this one command surface; whether a hook actually
  *executing* during a session hits a trust gate is a separate question
  this spike did not run (see below).
- **`disableAllHooks` / `allowManagedHooksOnly`:** **unverified, and
  reported as a conflict rather than a result.** Two independent doc
  fetches during this same spike returned contradictory summaries of
  whether `disableAllHooks` also disables plugin hooks (one said plugin
  hooks are exempt and stay active; the other said plugin hooks are
  disabled along with user/project/local hooks, and only a managed-level
  `disableAllHooks` reaches managed hooks). Running an actual model turn to
  observe a hook fire or not fire was out of this spike's bound (it would
  spend real inference against the operator's account for a question the
  CLI's own management commands do not answer). **This record does not
  assert either direction.** Whether a tracked project hook has any
  execution advantage over a plugin hook under either setting is therefore
  **unmeasured**, and nothing in the decision record may claim tracked
  hooks are a stronger security boundary on this ground.
- **The managed force-enabled-plugin case:** not run — it requires an
  organization-level managed-settings file this spike had no reason to
  fabricate. **Unverified**, and out of scope for a product-level (not
  enterprise-level) spike.
- **Whether the delivered hook actually fires on a real `Write` tool call
  with the same behaviour as a tracked hook:** not run, same reason as
  `disableAllHooks` above (would require a real session/model turn).
  **Unverified.**

**Conclusion — Claude Code native plugin-delivered hooks: `unverified`.**
The install/enable/disable/uninstall/scope mechanics are `supported`
(measured directly, above) and the tracked-payload reduction is real and
measured. But the property RP-179 actually cares about for a *guard* —
whether the hook keeps firing, and how it behaves under the two lockdown
settings — was not run in this spike. Calling the whole model `supported`
would overstate what was measured; calling it `degraded` would assume a
loss nothing here observed. `unverified` is the honest word, with the
mechanically-proven part stated separately from the unmeasured part.

### Codex — no CLI available in this environment; documented surface only

```sh
which codex
# /mnt/c/Users/<user>/AppData/Roaming/npm/codex   (a Windows npm
# shim on WSL's PATH)
codex --version
# Error: Missing optional dependency @openai/codex-linux-x64.
# Reinstall Codex: npm install -g @openai/codex@latest
npm view @openai/codex-linux-x64 version
# npm ERR! 404  Not Found
```

No working `codex` binary exists in this isolated environment, and a
platform-appropriate build was not chased down further — a spike this
bounded stops at the first honest "not run", not at "eventually got the
binary working by unrelated means." What the official docs state instead
(fetched 2026-09-20, https://learn.chatgpt.com/docs/plugins):

> "In Codex CLI, run the following command to open the plugin browser:
> `codex /plugins`" … "Bundled skills become available when you start a
> new chat or CLI session after installation."

No config key, CLI flag, or API for a non-interactive install is documented
on that page. This is a statement about what the search did and did not
find on this page, on this date — not a claim that no such surface exists
anywhere undocumented.

**Conclusion — Codex native plugin-delivered hooks: `unverified`.** Nothing
on the Codex side was executed in this spike — no working `codex` binary
exists in this isolated environment, and the section above is documented
surface only. Per `docs/compatibility.md`'s own vocabulary, `DEGRADED`
requires "a test executes what remains"; no test ran here, so `DEGRADED`
would overstate this spike's evidence, not merely its confidence.
`unsupported` would also overstate it — nothing was asked for and refused,
the docs simply do not name a non-interactive path. `unverified` is the
word this spike actually earned: a non-interactive path may exist
somewhere undocumented, but this spike ran neither it nor a check that
would confirm its absence. This matches `docs/compatibility.md:99`'s own
`UNVERIFIED` cell for the same capability — one word for one (here,
unmeasured) capability, not two.

## Model (c) — hybrid: tracked security guards + plugin-delivered everything else

Not built or run — there is no Rig-specific implementation to measure yet,
and building one is out of PR #232's scope (a capability decision, not a
migration). Its verdict is **`unverified`** as a *combined* model, composed
from the two measurements above rather than guessed independently:

- the tracked-guard half is model (a), already `supported` (running today);
- the plugin-delivered half is model (b): `unverified` on both providers —
  on Claude Code because the install mechanics are proven but the
  execution/lockdown behaviour is not, on Codex because nothing on that
  side was executed at all;
- nothing about combining them changes either half's measurement — a
  hybrid does not average two verdicts into a third, so this record states
  the parts rather than inventing a combined score.

## What this spike settles, and what it leaves for RP-22

**Settled:** a project-scoped Claude Code plugin genuinely does keep its
payload out of the repository (measured directly, above) — the previous
draft of the decision record's opposite claim was wrong. Codex has native
plugin installation, not "no scriptable surface at all" — also measured,
by reading its own current docs, not carried over from an earlier note.

**Left open, explicitly, for RP-22 to measure before choosing a delivery
model for any specific guard:** whether a plugin-delivered guard actually
fires under a live session, whether `disableAllHooks`/
`allowManagedHooksOnly` reach plugin hooks the same way they reach tracked
ones (the two doc reads this spike ran disagreed — a primary-source read of
the current `code.claude.com/docs/en/hooks` page, or a live session run
against an isolated profile with a real API key, is needed before either
direction goes in a rule), and cache-eviction timing after uninstall.
