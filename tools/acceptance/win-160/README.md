# 1.6.0 native-Windows acceptance

An independent acceptance run of the frozen 1.6.0 candidate
(`40e6eff7e0000150489de3c47abe72184c748c07`, `release/1.6.0-rc`) on a real
Windows host. It builds the package from the exact SHA, checks each packed
file against `manifest-160.json` (the 181-file content manifest of the
candidate tarball), installs that tarball, and drives `init`, `upgrade` from
the published 1.5.2, `doctor`, `preflight`, the `minimal` and `sdd` presets,
the Claude Code and Codex hook wiring, Windows path boundaries (non-ASCII
root, `subst` drive, UNC administrative share, junction, file symlink, git
worktree), the 1.6.0 evidence contract and the repository's own smoke,
unit/template and e2e suites.

Run from `cmd.exe` on the Windows host — not WSL, and not PowerShell, whose
`>` re-encodes the files (the script then reports `package.manifest-file`
FAILED). Inside a clone of this repository:

```
git fetch origin acceptance/1.6.0-windows
git show origin/acceptance/1.6.0-windows:tools/acceptance/win-160/win-accept-160.mjs > %TEMP%\win-accept-160.mjs
git show origin/acceptance/1.6.0-windows:tools/acceptance/win-160/manifest-160.json > %TEMP%\manifest-160.json
node %TEMP%\win-accept-160.mjs
```

Options: `--work <empty dir>` (default: a new directory under `%TEMP%`),
`--skip-suites` (skip the long pnpm suites; they are then reported NOT
TESTED), `--live-claude` (one real `claude -p` session that tries a
`--no-verify` commit; costs a model call).

Requirements: Node 22+, git, pnpm, npm, network access to GitHub and the npm
registry. Claude Code and Codex are probed if installed. The script writes
only inside its work directory, plus a temporary `subst` drive letter it
removes; it never pushes, publishes or touches the release ref.

The result is `<work>\report.md` and `<work>\report.json`. Every check is
classified LIVE OBSERVED, DETERMINISTIC PATH TESTED, NOT OBSERVABLE, NOT
TESTED or FAILED; a FAILED marked `known` is a pre-existing defect tracked
elsewhere (RP-495, also present in the published 1.5.2), not a 1.6.0
regression.
