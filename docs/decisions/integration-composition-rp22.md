# RP-22 S0 — integration composition, measured

⚠ **Not synced.** Measurement evidence for RP-22 (installer/receipt composition
across native plugin surfaces and MCP registration). Not sourced from
`templates/agent-os/universal/docs/decisions/`, carries no rule a shipped
rulebook cites, and is not touched by `scripts/sync-agent-os.mjs` (it only
ever writes files present in its own composed map). **Edit it in place, like
`plugin-delivery-spike-rp179.md`, which this record extends rather than
repeats.**

Ran 2026-09-20, in `~/rig-175` at branch head `fc75fe22c3b77cfd4289b4a470a9134e39e4c24d`,
inside WSL (Ubuntu), from a Windows 11 host for the one measurement that is
platform-specific (M7). Nothing here touched this repository's own
`~/.claude`/`~/.codex` or the shared WSL npm/global state: every command below
ran with an isolated `HOME` (and, for Codex, `CODEX_HOME`) under a throwaway
`/tmp` directory, and every CLI under test was installed to a throwaway npm
prefix. Docs are the only product of S0 — no code under `packages/cli/`
changed.

This record picks up exactly where `plugin-delivery-spike-rp179.md` left off:
that spike measured install/enable/disable/uninstall mechanics for a
Claude Code plugin and left the JSON contract without `-y`, the local
scope/`.gitignore` mechanism, the `upgrade --dry-run` interaction, MCP
registration, Codex's actual plugin CLI, and the Windows spawn question
explicitly open. Those are what this record measures, plus the RP-179 record
is available for anything not repeated here (the `--scope project` payload
location, the `enabledPlugins`/`extraKnownMarketplaces` shape, and the
`disableAllHooks` question, which is still unmeasured after this spike too).

## Setup — isolated, throwaway, never the real profile

```sh
WORK=/tmp/rp22-s0
mkdir -p "$WORK/npmprefix"
npm install -g --prefix "$WORK/npmprefix" @anthropic-ai/claude-code
export PATH="$WORK/npmprefix/bin:$PATH"
claude --version
# 2.1.278 (Claude Code)
```

The same one-hook fixture as the RP-179 spike (`marketplace.json` +
`plugin.json` under `.claude-plugin/`, built by hand, not downloaded), so its
identity and size are known exactly. Reused across every Claude Code
measurement below without modification.

## M1 — `plugin install --json` without `-y`, and `plugin list --json`

```sh
export HOME="$WORK/home1"
cd /tmp/rp22-s0-project1 && git init -q .
claude plugin marketplace add "$WORK/marketplace" --scope project
claude plugin install rig-guard-demo@rp22-s0-marketplace --scope project --json
```

Verbatim output — one line, exit 0, no prompt, no `shownCommand` field:

```json
{"command":"install","outcome":"ok","plugin":"rig-guard-demo@rp22-s0-marketplace","pluginId":"rig-guard-demo@rp22-s0-marketplace","scope":"project","message":"Successfully installed plugin: rig-guard-demo@rp22-s0-marketplace (scope: project)"}
```

`claude plugin list --json` immediately after:

```json
[
  {
    "id": "rig-guard-demo@rp22-s0-marketplace",
    "version": "1.0.0",
    "scope": "project",
    "enabled": true,
    "installPath": "/tmp/rp22-s0/home1/.claude/plugins/cache/rp22-s0-marketplace/rig-guard-demo/1.0.0",
    "installedAt": "2026-09-20T15:26:47.629Z",
    "lastUpdated": "2026-09-20T15:26:47.629Z",
    "projectPath": "/tmp/rp22-s0-project1"
  }
]
```

**Conclusion — measured.** `-y`/`--yes` is not required for `plugin install`
to complete non-interactively for a local-directory marketplace at project
scope: no confirmation prompt was hit, and the result carries no
`shownCommand` field (that field, if it exists on some other path, was not
observed here — RP-179's fixture also never triggered it). `plugin list
--json` is a flat array, one object per installed plugin, with an absolute
`installPath` under the isolated `$HOME` and an absolute `projectPath` back to
the repo — both paths are per-machine and would need redaction before landing
in any tracked receipt.

## M2 — `--scope local` / `--scope project` file effects and `.gitignore`

`--scope project` writes `.claude/settings.json` (tracked; RP-179 already
measured its content). `--scope local` writes a **different** file,
`.claude/settings.local.json`, with the same two keys:

```sh
export HOME="$WORK/home2"
cd /tmp/rp22-s0-project2 && git init -q .
claude plugin marketplace add "$WORK/marketplace" --scope local
claude plugin install rig-guard-demo@rp22-s0-marketplace --scope local --json
find .claude -type f
cat .claude/settings.local.json
```

```
.claude/settings.local.json
```

```json
{
  "extraKnownMarketplaces": {
    "rp22-s0-marketplace": { "source": { "source": "directory", "path": "/tmp/rp22-s0/marketplace" } }
  },
  "enabledPlugins": { "rig-guard-demo@rp22-s0-marketplace": true }
}
```

**The `.gitignore` question, and the surprising part.** The project itself
never got a `.gitignore` file — before or after either command. Yet
`git check-ignore -v .claude/settings.local.json` reports the file as
ignored:

```
<home>/.config/git/ignore:1:**/.claude/settings.local.json	.claude/settings.local.json
```

Reproduced from a second, completely fresh isolated `$HOME` with the ignore
mechanism checked *before* any Claude Code command ran:

```sh
export HOME="$WORK/home3"
ls -la "$HOME/.config/git/"          # no such file or directory
cd /tmp/rp22-s0-project3 && git init -q .
cat "$HOME/.config/git/ignore"       # still absent
claude plugin marketplace add "$WORK/marketplace" --scope local
cat "$HOME/.config/git/ignore"       # now: **/.claude/settings.local.json
```

**Conclusion — measured, and it corrects an assumption this ticket's own
wording invites.** `settings.local.json` does get git-ignored, but not by a
line Claude Code writes into the *repository's* `.gitignore` — it is written
into the *user's global* git ignore file
(`$HOME/.config/git/ignore`, i.e. whatever `core.excludesFile` resolves to
in this environment), the first time a `--scope local` marketplace/plugin
command runs for that `$HOME`. A repository with no committed `.gitignore`
entry for `.claude/settings.local.json` still reports it clean under `git
status` **on a machine that has ever run this command** — but a fresh
clone on a machine whose global git config lacks that line will see the file
as untracked. This is a per-machine, not a per-repository, guarantee, and
RP-22's receipt/registry work should not assume a repo-committed
`.gitignore` line covers it — Rig's own generated `.gitignore` should carry
its own entry if project-scope-local plugin files are ever meant to be
uniformly ignored across machines.

## M3 — built CLI `init` → project-scope plugin install → `upgrade --dry-run`

```sh
CLI=~/rig-175/packages/cli/dist/index.js       # pnpm install && pnpm build first
mkdir -p /tmp/rp22-s0-m3 && cd /tmp/rp22-s0-m3 && git init -q .
node "$CLI" init                                # 53 files installed
export HOME="$WORK/home4"
claude plugin marketplace add "$WORK/marketplace" --scope project
claude plugin install rig-guard-demo@rp22-s0-marketplace --scope project --json
node "$CLI" upgrade --dry-run
```

The plugin install appended two top-level keys to the rig's own
`.claude/settings.json` (the file `init` had just written, carrying the rig's
hook wiring):

```diff
@@ -65,5 +65,16 @@
         ]
       }
     ]
+  },
+  "extraKnownMarketplaces": {
+    "rp22-s0-marketplace": {
+      "source": { "source": "directory", "path": "/tmp/rp22-s0/marketplace" }
+    }
+  },
+  "enabledPlugins": { "rig-guard-demo@rp22-s0-marketplace": true }
   }
 }
```

`upgrade --dry-run` verbatim (trimmed to the summary and the relevant file
line):

```
agent-rig upgrade — init rig in /tmp/rp22-s0-m3
  installed by 0.9.1
  upgrading to 0.9.1

  ! .claude/settings.json  — edited since it was installed — merge the entries below by hand

  0 to replace, 0 new, 0 yours (kept), 1 wiring handed over, 52 already current

!  .claude/settings.json was handed over rather than replaced — the reason is
   on its line above. It is hook wiring, so it is never overwritten
   without proof the rig wrote those exact bytes.
   This version wires it like this; merge in what is missing:
   { …the rig's own canonical wiring, unchanged… }

Dry run — nothing written.
```

**Conclusion — measured.** A project-scope plugin install is, from
`upgrade`'s point of view, indistinguishable from a hand-edit of
`.claude/settings.json`: it lands on the `wiring` verdict (never `conflict`,
never a silent overwrite), the dry run prints the rig's canonical wiring for
manual merge, and nothing is lost or clobbered. This is the reproduction
`docs/compatibility.md`'s "delivered as installed repository files … rather
than a native plugin" row already cites conceptually (acceptance #2); this
run is the first time it was exercised specifically against a
plugin-install-shaped edit rather than a hand edit.

## M4 — `claude mcp add --scope project --transport http`

```sh
export HOME="$WORK/home5"
cd /tmp/rp22-s0-m4 && git init -q .
claude mcp add --scope project --transport http alpha https://example.com/alpha
claude mcp add --scope project --transport http beta  https://example.com/beta
cat .mcp.json
```

```json
{
  "mcpServers": {
    "alpha": { "type": "http", "url": "https://example.com/alpha" },
    "beta":  { "type": "http", "url": "https://example.com/beta" }
  }
}
```

**Key-order stability, across two independent projects, opposite insertion
order:** project 1 added `alpha` then `beta` → key order `alpha, beta`;
a second, fresh project added `beta` then `alpha` → key order `beta, alpha`.
In both cases the on-disk order matched **insertion order exactly**, never
alphabetical or any other normalization. So `.mcp.json` key order is stable
*for a given sequence of adds*, but not canonicalized — two rigs that install
the same two MCP servers in a different order will produce a byte-different
(if semantically identical) `.mcp.json`, which matters for any diff-based
drift check RP-22 adds.

**Remove, exact argv:**

```
$ claude mcp remove --help
Usage: claude mcp remove [options] <name>

Remove an MCP server

Options:
  -h, --help           Display help for command
  -s, --scope <scope>  Configuration scope (local, user, or project) - if not
                       specified, removes from whichever scope it exists in
```

`claude mcp remove alpha --scope project` removed exactly the `alpha` entry
and left `beta` and the `mcpServers` wrapper intact — a clean, minimal diff,
not a rewrite of the whole file.

**Conclusion — measured.** `.mcp.json` under `--scope project` is a small,
hand-editable JSON file (no cache, no `$HOME`-side payload — unlike
plugins, the entire MCP server declaration lives in the repository), key
order is insertion-order-stable but not canonical, and remove is scoped to
the one named server.

## M5 — offline behaviour

```sh
$ unshare -n true
unshare: unshare failed: Operation not permitted
```

**NOT MEASURED.** This WSL environment does not permit unprivileged network
namespaces (`unshare -n` refuses outright, verbatim above). No probe below
this line was run with network actually cut; every command that succeeded
above had working network available (verified: `curl -sI
https://registry.npmjs.org/` returned `HTTP/2 200`). Whether `plugin
install`/`plugin list`/`mcp add` for an already-cached, local-directory
source works with no network reachable at all is unmeasured, not merely
unconfirmed — the isolation this repo's own probe safety rules require
(`unshare -n`) was refused by the kernel, and no substitute (e.g. a firewall
rule) was attempted, because that would step outside "isolated, throwaway,
read-only where possible."

## M6 — Codex: the plugin CLI, corrected

**This corrects a factual claim in `plugin-delivery-spike-rp179.md` and in
the current `docs/compatibility.md` row for "Codex non-interactive,
scriptable plugin installation."** Both state, as of 2026-09-20, that only
interactive `codex /plugins` is documented and no scriptable path exists.
That was true of the *documentation page* fetched that day
(`https://learn.chatgpt.com/docs/plugins`) and of the *binary* available in
that spike's environment (which could not even run —
`Missing optional dependency @openai/codex-linux-x64`). It is not true of the
current `@openai/codex` npm package.

```sh
WORK=/tmp/rp22-s0
npm install --prefix "$WORK/codexprefix" @openai/codex@latest
CODEXBIN="$WORK/codexprefix/node_modules/.bin/codex"
"$CODEXBIN" --version
# codex-cli 0.155.1
```

`codex --help` lists a top-level `plugin` command (alongside `mcp`, `exec`,
`review`, …), and `codex plugin --help` shows a full CRUD-shaped
non-interactive surface:

```
Manage Codex plugins

Usage: codex plugin [OPTIONS] <COMMAND>

Commands:
  add          Install a plugin from a configured or remote marketplace
  list         List plugins available from configured and remote marketplaces
  marketplace  Add, list, upgrade, or remove configured plugin marketplaces
  remove       Uninstall a plugin and remove its local cache
  help         Print this message or the help of the given subcommand(s)
```

`codex plugin add --help` documents `codex plugin add sample@debug` and
`codex plugin add sample --marketplace debug`; `codex plugin marketplace add
--help` documents a local path, `owner/repo[@ref]`, or a Git URL as
`<SOURCE>`, plus a `--json` flag; `codex plugin list --help` and `codex
plugin remove --help` both document `--json` too.

**Run against the same fixture marketplace the Claude Code measurements
used** (unmodified — Codex's marketplace loader accepts the
`.claude-plugin/marketplace.json` shape directly, without a Codex-specific
manifest):

```sh
export HOME="$WORK/codexhome1"
export CODEX_HOME="$WORK/codexhome1/.codex"
cd /tmp/rp22-s0-codex1 && git init -q .
"$CODEXBIN" plugin marketplace add "$WORK/marketplace"
"$CODEXBIN" plugin add rig-guard-demo@rp22-s0-marketplace --json
```

```
WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "/tmp" (codex_home: AbsolutePathBuf("<home>/.codex"))
Added marketplace `rp22-s0-marketplace` from <home>/rp22-s0/marketplace.
Installed marketplace root: <home>/rp22-s0/marketplace
```

```json
{
  "pluginId": "rig-guard-demo@rp22-s0-marketplace",
  "name": "rig-guard-demo",
  "marketplaceName": "rp22-s0-marketplace",
  "version": "1.0.0",
  "installedPath": "<home>/.codex/plugins/cache/rp22-s0-marketplace/rig-guard-demo/1.0.0",
  "installed": true,
  "enabled": true,
  "source": { "source": "local", "path": "<home>/rp22-s0/marketplace/plugins/rig-guard-demo" },
  "marketplaceSource": { "sourceType": "local", "source": "<home>/rp22-s0/marketplace" },
  "installPolicy": "AVAILABLE",
  "authPolicy": "ON_INSTALL"
}
```

`codex plugin remove rig-guard-demo@rp22-s0-marketplace --json` returned exit
0 and a matching JSON object; no interactive prompt occurred at any step.
**Zero files landed in the project repository** (`find /tmp/rp22-s0-codex1`
after install shows only ordinary `git init` output — no `.codex/` and no
marker file in the repo itself); the entire marketplace registration and
plugin payload live under `$CODEX_HOME` (`config.toml` gets one
`[marketplaces.<name>]` table; the cached plugin payload sits under
`plugins/cache/<marketplace>/<plugin>/<version>/`). This is a stronger
repo-cleanliness property than Claude Code's `--scope project`, which does
write an enablement stanza into the tracked `.claude/settings.json`.

**One environment-specific wrinkle, worth naming because it will recur in
CI or any sandboxed runner:** every plugin-CLI invocation printed
`WARNING: proceeding, even though we could not create PATH aliases: Refusing
to create helper binaries under temporary dir "/tmp"` — Codex refuses to
place helper-binary PATH shims when `$CODEX_HOME` resolves under a path
literally named `/tmp`. The command still completed and the JSON result was
correct, so this is a warning, not a failure, but it means the "isolated
`HOME`/`CODEX_HOME` under `mktemp -d`" pattern this repo's probes standardize
on will always print this line for Codex specifically (`mktemp -d` on Linux
defaults under `/tmp`). Harmless for a spike; worth a one-line note if RP-22
ever writes a script that greps Codex plugin-CLI output for a clean success
signal.

**Conclusion — measured, and it changes S5–S9's starting premise.**
Codex is **not** guided/interactive-only for plugin delivery. It has a full
non-interactive plugin CLI (`add`/`list`/`remove`/`marketplace add`), with
`--json` on every verb, that keeps the tracked repository untouched and
puts everything under `$CODEX_HOME`. The only side of RP-179's "Codex has no
scriptable install path" claim that still stands is the *bundled skill*
surface cited from `learn.chatgpt.com/docs/plugins` (`codex /plugins`,
interactive) — that page was describing a different, older or
narrower feature than the `codex plugin` subcommand this spike found, and
this record does not reconcile which page is authoritative, only that the
binary's own `--help` and a live run are unambiguous. What is **still**
unmeasured on the Codex side: whether a plugin-delivered hook actually fires
in a live session, and the `disableAllHooks`/`allowManagedHooksOnly`
interaction — exactly the two gaps RP-179 left for Claude Code, now
mirrored for Codex, and not closed here for either provider (see NOT
MEASURED below).

## M7 — Windows `.cmd` spawn refusal, no shell

Run from the Windows host (not WSL), via `node` on the Windows side:

```js
import { execFile, spawn } from 'node:child_process';
// fake-tool.cmd: "@echo off\r\necho hello from cmd\r\n"
execFile(cmdPath, [], { shell: false }, cb);   // throws synchronously
spawn(cmdPath, [], { shell: false });          // throws synchronously
execFile(cmdPath, [], { shell: true }, cb);    // succeeds: "hello from cmd"
```

```
node version: v24.18.0
platform: win32
--- execFile(.cmd, shell:false) ---
threw synchronously: Error spawn EINVAL EINVAL -4071
--- spawn(.cmd, shell:false) ---
spawn threw synchronously: Error spawn EINVAL EINVAL -4071
--- execFile(.cmd, shell:true) for comparison ---
shell:true stdout: hello from cmd
```

**Conclusion — measured.** On Windows, Node 24.18.0, spawning a `.cmd` file
directly with `shell: false` (the safe default this repo's own security
posture prefers — no shell string interpolation) throws **synchronously**
(not via the error callback/event) with `Error: spawn EINVAL`, `code:
'EINVAL'`, `errno: -4071`. Any RP-22 code path that shells out to a
provider CLI resolved to a `.cmd` shim on Windows (npm-installed `claude`,
`codex`, or a future third CLI all commonly install as `<name>.cmd` on
Windows) **must** either pass `shell: true` (reintroducing the string-escaping
concerns `shell: false` exists to avoid) or resolve to the underlying `.js`
entry point and invoke it with `node` directly — mirroring what this record's
own probe scripts already do (`$WORK/npmprefix/bin/claude` on WSL is a
symlink to the `.js` entry; the equivalent Windows npm install would need the
same treatment, not a bare `execFile`). This was only reproduced with a
synthetic `.cmd`, not against the real `claude.cmd`/`codex.cmd` shims — see
NOT MEASURED.

## M8 — Spec Kit non-interactive invocation

No live run: this WSL environment has no `uv`, `uvx`, or `pipx` (checked:
`which uv`, `which uvx`, `which pipx` all failed), and Spec Kit's own
installation path is `uvx --from git+https://github.com/github/spec-kit.git
specify init …` — a Python toolchain this spike's safety rules do not license
installing globally (only "the OFFICIAL package … via `npm install --prefix
<tmp>`" is pre-approved, and Spec Kit is not an npm package). Recorded as
**NOT MEASURED** for the live run rather than skipped silently.

From official documentation (fetched 2026-09-20,
`https://github.github.io/spec-kit/reference/core.html` and the project
README at `https://github.com/github/spec-kit`):

- Command: `specify init [<project_name>]`.
- Flags: `--integration <key>` (e.g. `copilot`, `claude`, `gemini`),
  `--integration-options`, `--script sh|ps|py`, `--here` (init in the
  current directory instead of a new one), `--force` (merge/overwrite into
  an existing directory), `--ignore-agent-tools`, `--preset <id>`.
- Non-interactive: the docs state it runs fully non-interactively once
  `--integration` is given explicitly; without it, "interactive terminals
  prompt you to choose an integration. Non-interactive sessions, such as CI
  or piped runs, default to GitHub Copilot."
- Marker files: initializes a `.specify/` directory holding "necessary
  directory structure, templates, scripts, and AI coding agent integration
  files," and a managed `.specify/.gitignore` that excludes `feature.json`
  and per-machine extension overrides while keeping shareable content
  tracked.
- Version file: the fetched documentation does not state that `specify
  init` writes any version file. **Unverified** independently, since no live
  run was performed.

**Conclusion — documentation only, not run.** The non-interactive shape
(`specify init <name> --integration <key> [--here] [--force] [--script …]`)
is real per the official reference, but nothing above was executed against
an actual install in this spike.

## NOT MEASURED — explicit list

- Offline behaviour for any of the above commands (M5): `unshare -n` refused
  by the kernel in this WSL environment; no alternative isolation was
  substituted.
- Whether a plugin-delivered hook (Claude Code or Codex) actually fires
  during a live model session, and the `disableAllHooks` /
  `allowManagedHooksOnly` interaction with plugin-sourced hooks, on
  **either** provider — carried over unresolved from
  `plugin-delivery-spike-rp179.md` (Claude Code side) and newly opened for
  Codex by M6 above.
- Cache-eviction timing after `plugin uninstall`/`plugin remove`, on either
  provider (RP-179 measured that Claude Code marks the cache
  `.orphaned_at` rather than deleting it immediately; Codex's equivalent
  behaviour was not probed here).
- `claude plugin update`'s "restart required to apply" claim for
  `--scope local` — not independently re-run this round either (RP-179's
  fixture still has no second plugin version to update to).
- The managed, organization-forced-plugin case for either provider (needs a
  managed-settings file neither spike had reason to fabricate).
- M7's finding was reproduced only against a synthetic `.cmd` file, not
  against the real `claude.cmd` / `codex.cmd` npm shims that a Windows
  install of either CLI actually produces — the failure mode (spawn EINVAL
  on `shell:false`) is a documented Node/Windows behaviour for `.cmd`/`.bat`
  files generally, but this spike did not additionally confirm the specific
  shim files trigger it identically (no reason to expect otherwise, but not
  run).
- Spec Kit's actual behaviour end-to-end (M8): documentation only, no
  `uv`/`uvx`/`pipx` available in this environment and none was installed.
- Whether `claude plugin install --json` ever emits a `shownCommand` field
  on some path this spike's one fixture never triggers (e.g. a Git-sourced
  marketplace, or one requiring project trust) — only the local-directory,
  already-trusted path was exercised.
