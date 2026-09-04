/**
 * The Codex adapter: a declaration → the native hook surface Codex wires for
 * it. Codex's hook wiring (`.codex/hooks.json`) is DERIVED from the authoring
 * harness's snapshot by `scripts/sync-codex-adapter.mjs`
 * (`docs/decisions/codex-adapter.md`): it keeps the authoring harness's matcher
 * spellings, adds the canonical edit tool `apply_patch`, and runs the same hook
 * files from the shared hooks directory. So the strings below coincide with the
 * other adapter's today — by derivation, not by accident — and each adapter
 * still owns its own spelling. The correspondence test holds this adapter's
 * matcher and the derived snapshot's to the SAME tool set, so a tool the
 * snapshot gains or loses, or one this adapter drops, is reported for this
 * adapter alone — `test/template/policy-declaration.test.ts` › "reports the
 * no-verify policy on %s when the shell matcher loses PowerShell (mutation:
 * matcher)", › "reports the no-verify policy on %s when the snapshot gains a
 * tool the adapter does not name (mutation: widened snapshot)" and › "reports
 * a policy on %s whose adapter matcher drops a tool the snapshot still wires
 * (mutation: narrowed adapter)".
 *
 * The shared hooks directory is imported from `./shared-hooks.ts` rather than
 * restated, for the same reason the snapshot is derived rather than
 * hand-written: one spelling of one fact.
 */

import type { HarnessAdapter, NativeHookSurface } from '../core/adapter.js';
import type { PolicyDeclaration } from '../core/declaration.js';
import type { EnforcementTiming, Operation } from '../core/vocabulary.js';
import { SHARED_HOOK_ROOT_ENV, SHARED_HOOKS_DIR } from './shared-hooks.js';

const EVENT_OF: Record<EnforcementTiming, string> = {
  'before-operation': 'PreToolUse',
};

const MATCHER_OF: Record<Operation, string> = {
  'file-edit': 'Write|Edit|MultiEdit|NotebookEdit|apply_patch',
  'shell-command': 'Bash|PowerShell',
};

/**
 * The Windows spelling this harness generates for a hook.
 *
 * ⚠ A SECOND implementation of the wrapper that `scripts/sync-codex-adapter.mjs`
 * writes into the shipped file, and deliberately so: that script is a build tool
 * outside the published package, and this module may not import it. The two are
 * held equal by a correspondence check that goes red in BOTH directions —
 * `test/template/policy-coverage.test.ts` (absent in a generated rig) › "the %s
 * snapshot wires %s with exactly the spelling that adapter generates, in every
 * field it generates one for" — which is what `rules/invariants.md` ("One
 * mechanism, one implementation") requires of a copy that has to stay.
 *
 * The wrapper exists because PowerShell owns its stdin, so the hook would
 * receive an empty stream; it copies the original bytes into the child instead
 * of re-encoding them.
 */
const windowsCommand = (hookPath: string): string => {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$repoRoot = git rev-parse --show-toplevel',
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    `$env:${SHARED_HOOK_ROOT_ENV} = $repoRoot`,
    `$hookPath = Join-Path $repoRoot '${hookPath}'`,
    '$startInfo = New-Object System.Diagnostics.ProcessStartInfo',
    "$startInfo.FileName = 'node'",
    "$startInfo.Arguments = '\"' + $hookPath + '\"'",
    '$startInfo.UseShellExecute = $false',
    '$startInfo.RedirectStandardInput = $true',
    '$child = [System.Diagnostics.Process]::Start($startInfo)',
    '[Console]::OpenStandardInput().CopyTo($child.StandardInput.BaseStream)',
    '$child.StandardInput.Close()',
    '$child.WaitForExit()',
    'exit $child.ExitCode',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
};

export const nativeSurfaceOf = (policy: PolicyDeclaration): NativeHookSurface => ({
  event: EVENT_OF[policy.timing],
  matcher: policy.operations.map((operation) => MATCHER_OF[operation]).join('|'),
  hookPath: `${SHARED_HOOKS_DIR}/${policy.mechanism}.mjs`,
  // Both commands this harness generates. It runs the first on POSIX and the
  // second on Windows, so the probe has to know both: replacing only the
  // Windows spelling in the shipped file used to leave every policy reading
  // SUPPORTED while the guard no longer ran there.
  commands: {
    command: [
      `repoRoot="$(git rev-parse --show-toplevel)" && ${SHARED_HOOK_ROOT_ENV}="$repoRoot" node "$repoRoot/${SHARED_HOOKS_DIR}/${policy.mechanism}.mjs"`,
    ],
    commandWindows: [windowsCommand(`${SHARED_HOOKS_DIR}/${policy.mechanism}.mjs`)],
  },
});

export const codexAdapter: HarnessAdapter = Object.freeze({
  harness: 'codex',
  surfaceFile: '.codex/hooks.json',
  nativeSurfaceOf,
});
