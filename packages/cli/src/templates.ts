import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the repo/package `templates/` directory.
 *
 * This file lives at `packages/cli/src/templates.ts` in the repo and at
 * `packages/cli/dist/templates.js` in the published package — three levels below
 * the root in both cases, so one relative walk serves dev, tarball and git installs.
 */
export function templatesRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'templates');
}

/**
 * The one payload this package ships (RP-177 retired the per-target skeleton
 * and the per-stack overlays that used to sit alongside it).
 */
export function agentOsUniversalDir(): string {
  return path.join(templatesRoot(), 'agent-os', 'universal');
}
