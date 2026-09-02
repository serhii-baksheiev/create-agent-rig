/**
 * The Codex adapter: a declaration → the native hook surface Codex wires for
 * it. Codex's hook wiring (`.codex/hooks.json`) is DERIVED from the authoring
 * harness's snapshot by `scripts/sync-codex-adapter.mjs`
 * (`docs/decisions/codex-adapter.md`): it keeps the authoring harness's matcher
 * spellings, adds the canonical edit tool `apply_patch`, and runs the same hook
 * files from the shared hooks directory. So the strings below coincide with the
 * other adapter's today — by derivation, not by accident — and each adapter
 * still owns its own spelling: if the derived snapshot ever diverges,
 * `test/template/policy-declaration.test.ts` › "every registered policy is
 * wired in the %s snapshot under its event, matcher and hook path" goes red
 * for this adapter alone.
 *
 * The shared hooks directory is imported from `./shared-hooks.ts` rather than
 * restated, for the same reason the snapshot is derived rather than
 * hand-written: one spelling of one fact.
 */

import type { HarnessAdapter, NativeHookSurface } from '../core/adapter.js';
import type { PolicyDeclaration } from '../core/declaration.js';
import type { EnforcementTiming, Operation } from '../core/vocabulary.js';
import { SHARED_HOOKS_DIR } from './shared-hooks.js';

const EVENT_OF: Record<EnforcementTiming, string> = {
  'before-operation': 'PreToolUse',
};

const MATCHER_OF: Record<Operation, string> = {
  'file-edit': 'Write|Edit|MultiEdit|NotebookEdit|apply_patch',
  'shell-command': 'Bash|PowerShell',
};

export const nativeSurfaceOf = (policy: PolicyDeclaration): NativeHookSurface => ({
  event: EVENT_OF[policy.timing],
  matcher: policy.operations.map((operation) => MATCHER_OF[operation]).join('|'),
  hookPath: `${SHARED_HOOKS_DIR}/${policy.mechanism}.mjs`,
});

export const codexAdapter: HarnessAdapter = Object.freeze({
  harness: 'codex',
  surfaceFile: '.codex/hooks.json',
  nativeSurfaceOf,
});
