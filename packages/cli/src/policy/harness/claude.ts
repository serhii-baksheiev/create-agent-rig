/**
 * The Claude Code adapter: a declaration → the native hook surface Claude Code
 * wires for it. The authoring surface of this rulebook is Claude-shaped
 * (`CLAUDE.md`, "One operating system, two harnesses"), so the hook files
 * themselves live in the historical directory `./shared-hooks.ts` names and are
 * shared by every harness.
 *
 * What is native here and nowhere in the core: the `PreToolUse` event, the
 * tool names in the matchers, and the snapshot path. The matcher strings are
 * the ones `.claude/settings.json` carries, and the correspondence test holds
 * the two to the SAME tool set, not a subset: a tool dropped here or gained
 * there is reported for this adapter —
 * `test/template/policy-declaration.test.ts` › "reports the no-verify policy
 * on %s when the shell matcher loses PowerShell (mutation: matcher)", › "reports
 * the no-verify policy on %s when the snapshot gains a tool the adapter does
 * not name (mutation: widened snapshot)" and › "reports a policy on %s whose
 * adapter matcher drops a tool the snapshot still wires (mutation: narrowed
 * adapter)". The shell matcher's tool set is owned by `shell-tools.mjs` in the
 * shipped scripts, and `test/template/shell-tools.test.ts` holds that
 * correspondence.
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

export const nativeSurfaceOf = (policy: PolicyDeclaration): NativeHookSurface => ({
  event: EVENT_OF[policy.timing],
  matcher: policy.operations.map((operation) => MATCHER_OF[operation]).join('|'),
  hookPath: `${SHARED_HOOKS_DIR}/${policy.mechanism}.mjs`,
  // The exact command this harness generates for a hook. The probe compares
  // against this rather than parsing what it finds, so this string and the one
  // in the shipped snapshot must agree — pinned in both directions by
  // `test/template/policy-coverage.test.ts` (absent in a generated rig) ›
  // "the %s snapshot wires %s with exactly the command that adapter generates".
  commands: [`node "$${SHARED_HOOK_ROOT_ENV}/${SHARED_HOOKS_DIR}/${policy.mechanism}.mjs"`],
});

export const claudeAdapter: HarnessAdapter = Object.freeze({
  harness: 'claude',
  surfaceFile: '.claude/settings.json',
  nativeSurfaceOf,
});
