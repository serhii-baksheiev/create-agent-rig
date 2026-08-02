import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { templatesRoot } from '../templates.js';

/**
 * The version of the rig doing the installing — stamped into every manifest
 * and printed by `--version`.
 *
 * Resolved through {@link templatesRoot} so there is one walk from this file
 * to the package root, valid in the repo, the tarball and a git install alike.
 */
export async function packageVersion(): Promise<string> {
  const pkgPath = path.join(templatesRoot(), '..', 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}
