/**
 * The policy declaration, registry, decision-record schema and harness
 * adapters (RP-76), plus the capability & degradation contract that says what
 * each of them is worth on a given surface (RP-36).
 *
 * Library surface only — nothing here is reached by the CLI commands yet;
 * emitting decision records at runtime, and rendering the coverage report in
 * `doctor`, are separate tasks.
 */

export * from './core/vocabulary.js';
export * from './core/declaration.js';
export * from './core/registry.js';
export * from './core/decision-record.js';
export * from './core/probe.js';
export * from './core/coverage.js';
export * from './core/evidence-matrix.js';
export type { HarnessAdapter, NativeHookSurface } from './core/adapter.js';
export * from './harness/index.js';
