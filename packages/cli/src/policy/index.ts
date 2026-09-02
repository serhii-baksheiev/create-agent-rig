/**
 * The policy declaration, registry, decision-record schema and harness
 * adapters (RP-76). Library surface only — nothing here is reached by the CLI
 * commands yet; emitting decision records at runtime is a separate task.
 */

export * from './core/vocabulary.js';
export * from './core/declaration.js';
export * from './core/registry.js';
export * from './core/decision-record.js';
export type { HarnessAdapter, NativeHookSurface } from './core/adapter.js';
export * from './harness/index.js';
