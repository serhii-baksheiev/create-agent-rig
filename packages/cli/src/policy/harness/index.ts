/**
 * The harness adapters this generator knows. Adding a harness is one new
 * module beside these two and one entry in the list below — nothing in
 * `../core/` changes, which `test/template/policy-declaration.test.ts` ›
 * "codex is named only by its own adapter and the adapter index" pins by
 * naming exactly the files that may mention each harness.
 */

import type { HarnessAdapter } from '../core/adapter.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';

export { claudeAdapter, codexAdapter };
export { SHARED_HOOKS_DIR } from './shared-hooks.js';

export const HARNESS_ADAPTERS: readonly HarnessAdapter[] = Object.freeze([
  claudeAdapter,
  codexAdapter,
]);
