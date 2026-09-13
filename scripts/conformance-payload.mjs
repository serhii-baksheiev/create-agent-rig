#!/usr/bin/env node
// The generated half of the conformance payload (RP-13).
//
// `templates/agent-os/universal/.claude/contracts/conformance-v1/session-identity.schema.json`
// is DERIVED from the RP-12 schema in `contracts/session-messaging/v1/schema.ts`
// — the SessionIdentity definition and the contract-major constant — so the
// rig ships one spelling of that fact, generated, rather than a hand copy
// that drifts. `--check` exits 1 when the committed file differs from the
// derivation, `--write` regenerates it; `scripts/sync-agent-os.mjs` runs the
// check before composing the dogfood copy, and the payload test runs it too.
//
// The TypeScript module is evaluated in a child Node with type stripping
// (`--experimental-strip-types`, Node ≥ 22.6; the file is type-only syntax
// plus `as const`), so no build and no dependency stands between the source
// schema and the payload. `--root <dir>` points both the source and the
// payload at a copy, which is how the tests prove both directions of drift.
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE = ['contracts', 'session-messaging', 'v1', 'schema.ts'];
const TARGET = [
  'templates',
  'agent-os',
  'universal',
  '.claude',
  'contracts',
  'conformance-v1',
  'session-identity.schema.json',
];

/** Inline every `#/$defs/<name>` reference so the payload stands alone. */
const inline = (node, defs, depth = 0) => {
  if (depth > 16) throw new Error('conformance-payload: $ref nesting deeper than 16');
  if (Array.isArray(node)) return node.map((item) => inline(item, defs, depth + 1));
  if (typeof node !== 'object' || node === null) return node;
  if (typeof node.$ref === 'string') {
    const name = node.$ref.replace(/^#\/\$defs\//, '');
    if (!(name in defs)) throw new Error(`conformance-payload: unresolved $ref ${node.$ref}`);
    return inline(defs[name], defs, depth + 1);
  }
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, inline(value, defs, depth + 1)]),
  );
};

export const deriveSessionIdentitySchema = (source) => {
  const defs = source.$defs ?? {};
  if (!defs.SessionIdentity)
    throw new Error('conformance-payload: schema.ts has no SessionIdentity');
  if (!defs.ContractMajor) throw new Error('conformance-payload: schema.ts has no ContractMajor');
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:create-agent-rig:conformance:v1:session-identity',
    title: 'Session identity and contract major (RP-12), as the conformance payload carries them',
    description:
      'Generated from contracts/session-messaging/v1/schema.ts by scripts/conformance-payload.mjs; ' +
      'edit the source, not this file.',
    sourceId: source.$id ?? null,
    contractMajor: inline(defs.ContractMajor, defs),
    sessionIdentity: inline(defs.SessionIdentity, defs),
  };
};

export const readSourceSchema = async (root) => {
  const file = path.join(root, ...SOURCE);
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      '--input-type=module',
      '-e',
      `const m = await import(${JSON.stringify(pathToFileURL(file).href)}); ` +
        'process.stdout.write(JSON.stringify(m.sessionMessagingSchema));',
    ],
    { maxBuffer: 4 * 1024 * 1024, timeout: 30_000, windowsHide: true },
  );
  return JSON.parse(stdout);
};

const render = (schema) => `${JSON.stringify(schema, null, 2)}\n`;

const main = async () => {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = rootIndex >= 0 ? path.resolve(args[rootIndex + 1] ?? '') : defaultRoot;
  const mode = args.includes('--write') ? 'write' : args.includes('--check') ? 'check' : null;
  if (mode === null || (rootIndex >= 0 && !args[rootIndex + 1])) {
    process.stderr.write('usage: conformance-payload.mjs (--check | --write) [--root <dir>]\n');
    return 2;
  }
  const expected = render(deriveSessionIdentitySchema(await readSourceSchema(root)));
  const target = path.join(root, ...TARGET);
  if (mode === 'write') {
    await writeFile(target, expected);
    return 0;
  }
  let actual;
  try {
    actual = await readFile(target, 'utf8');
  } catch {
    actual = null;
  }
  if (actual === expected) return 0;
  process.stderr.write(
    `conformance-payload: ${path.relative(root, target)} ${actual === null ? 'is missing' : 'differs from what schema.ts derives'}; ` +
      'run `node scripts/conformance-payload.mjs --write` and commit the result.\n',
  );
  return 1;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`conformance-payload: ${error.message}\n`);
      process.exit(1);
    },
  );
}
