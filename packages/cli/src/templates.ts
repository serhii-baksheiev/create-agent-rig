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

export function skeletonDir(skeleton: string): string {
  return path.join(templatesRoot(), 'skeleton', skeleton);
}
