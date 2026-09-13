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

/**
 * The version of the command contract (`docs/command-contract.md`) this rig
 * implements. Independent of the package version: many releases ship against
 * one contract, and a consumer compares this field's major alone.
 */
export const RIG_CONTRACT_VERSION = '1.0';

export type RigHandshake = {
  schemaVersion: 1;
  name: 'create-agent-rig';
  version: string;
  contractVersion: typeof RIG_CONTRACT_VERSION;
};

/** What `--version --json` answers — the handshake object of the contract. */
export async function rigHandshake(): Promise<RigHandshake> {
  return {
    schemaVersion: 1,
    name: 'create-agent-rig',
    version: await packageVersion(),
    contractVersion: RIG_CONTRACT_VERSION,
  };
}
