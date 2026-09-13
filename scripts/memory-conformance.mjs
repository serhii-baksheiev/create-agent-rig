#!/usr/bin/env node
// The executable form of the conformance matrix (RP-13, docs/command-contract.md
// "Conformance matrix"): fetch the Memory contract directory at the ref the
// payload pins, and check — through process boundaries only — that what is
// there and what the two bins answer match the schemas the rig ships.
//
// Two sources. Without `--from`, the checkout named by
// `.claude/contracts/conformance-v1/manifest.json` (`memory.repository` at
// `memory.ref`, a commit SHA) is fetched into a temporary directory with plain
// git — `planFetch` is the exact command list, pinned by
// test/template/memory-conformance.test.ts › "builds git init, remote add,
// fetch and checkout from the manifest repository and ref". With `--from <dir>` an existing
// checkout root is used (`source: "local"`) and the ref is not verified; that is
// what the tests use, offline, and what a developer uses against a working copy.
//
// The pin is enforced, not reported: a ref that is not a 40-hex commit SHA is
// refused before anything is fetched, and a fetched commit that is not the pin
// is refused before anything from the tree is spawned — both leave every other
// row `skip`. Pinned in test/template/memory-conformance.test.ts › "refuses a
// ref that is not a 40-hex commit SHA with every other row skipped, and spawns
// nothing".
//
// The Memory repository is private. The fetch carries a read-only token the
// environment supplies as MEMORY_CONFORMANCE_TOKEN — through git's
// GIT_CONFIG_* environment entries for the git processes only, never as an
// argument, never on a URL, never in the report, and never in the environment
// of the Memory process this script spawns (`memoryProcessEnv` is the
// allow-list). Absent, the fetch is attempted anonymously and the failure
// names the variable.
//
// What it never does: import anything from the fetched tree, read Memory's
// storage, or copy fixtures into this repository. The Memory executable is
// spawned exactly as `create-agent-rig memory` would spawn it, and only its
// stdout is parsed — against the payload's schemas, with the dependency-free
// validator in ./lib/json-schema-subset.mjs.
//
// Output: `--json` prints exactly one JSON object —
// { schemaVersion: 1, ref, contractVersion, source, checks: [{ id, status, detail }], passed }
// with status ∈ ok | fail | skip — and the exit code is 0 iff no check failed.
// No `detail` names a path, and text a subprocess chose is cut before it enters
// one: the report travels into CI logs and PR comments.
import { execFile } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { validate } from './lib/json-schema-subset.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const payloadDir = path.join(repoRoot, '.claude', 'contracts', 'conformance-v1');
const SHA = /^[0-9a-f]{40}$/;
const SPAWN_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 120_000;
const MAX_ECHOED_CHARACTERS = 32;
const CHECK_IDS = [
  'ref-pinned',
  'contract-document',
  'event-schema',
  'fixtures-present',
  'memory-handshake',
  'memory-doctor',
  'rig-handshake',
];
/** What the spawned Memory process may see of this process's environment. */
const MEMORY_ENV_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TMP',
  'TEMP',
  'TMPDIR',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'LANG',
  'LC_ALL',
];

export const planFetch = (manifest) => [
  ['init'],
  ['remote', 'add', 'origin', `https://github.com/${manifest.memory.repository}.git`],
  ['fetch', '--depth', '1', 'origin', manifest.memory.ref],
  ['checkout', 'FETCH_HEAD', '--', 'shared-memory'],
];

export const gitAuthConfig = (env) => {
  const token = env.MEMORY_CONFORMANCE_TOKEN;
  if (typeof token !== 'string' || token === '') return { env: {}, source: 'none' };
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    env: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    },
    source: 'MEMORY_CONFORMANCE_TOKEN',
  };
};

export const memoryProcessEnv = (env) =>
  Object.fromEntries(
    MEMORY_ENV_KEYS.filter((key) => typeof env[key] === 'string').map((key) => [key, env[key]]),
  );

const echo = (value) => String(value).slice(0, MAX_ECHOED_CHARACTERS);
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

const exists = async (file) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

/** Spawn and collect; never throws for a non-zero exit — the caller classifies. */
const run = async (file, args, options = {}) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: SPAWN_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      ...options,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      spawnError: typeof error.code === 'string' ? error.code : undefined,
    };
  }
};

const majorOf = (contractVersion) => {
  const match = /^(\d+)\.\d+$/.exec(String(contractVersion));
  return match ? Number(match[1]) : null;
};

/** One handshake or doctor answer, validated: a check record and the parsed payload. */
const validatedAnswer = ({ id, answer, schema, what }) => {
  if (answer.spawnError)
    return {
      record: { id, status: 'fail', detail: `${what} could not be started (${answer.spawnError})` },
    };
  let payload;
  try {
    payload = JSON.parse(answer.stdout);
  } catch {
    return {
      record: {
        id,
        status: 'fail',
        detail: `${what} did not answer one JSON object (exit ${answer.code})`,
      },
    };
  }
  const result = validate(schema, payload);
  if (!result.ok)
    return {
      record: {
        id,
        status: 'fail',
        detail: `${what} answered outside the schema: ${result.errors.slice(0, 3).join('; ')}`,
      },
    };
  return {
    record: {
      id,
      status: 'ok',
      detail: `${what} answered within the schema (exit ${answer.code})`,
    },
    payload,
  };
};

const acquire = async (manifest, from, env) => {
  if (from)
    return { root: path.resolve(from), source: 'local', cleanup: async () => {}, fetchedRef: null };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-conformance-'));
  const cleanup = () => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  const auth = gitAuthConfig(env);
  const gitEnv = { ...memoryProcessEnv(env), ...auth.env, GIT_TERMINAL_PROMPT: '0' };
  for (const step of planFetch(manifest)) {
    const result = await run('git', step, { cwd: dir, env: gitEnv, timeout: FETCH_TIMEOUT_MS });
    if (result.code !== 0 || result.spawnError) {
      await cleanup();
      const why =
        auth.source === 'none'
          ? 'no MEMORY_CONFORMANCE_TOKEN in the environment, and the Memory repository is private'
          : `authenticated through ${auth.source}`;
      throw new Error(
        `git ${step[0]} failed while fetching the pinned Memory ref (${why}); ` +
          'the matrix is UNVERIFIABLE until the fetch succeeds',
      );
    }
  }
  const head = await run('git', ['rev-parse', 'FETCH_HEAD'], { cwd: dir, env: gitEnv });
  return { root: dir, source: 'fetched', fetchedRef: head.stdout.trim(), cleanup };
};

const countMarkdown = async (dir) => {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.md')).length;
  } catch {
    return 0;
  }
};

/** Every row but `ref-pinned`, skipped for the reason the pin gave. */
const skippedRows = (detail) =>
  CHECK_IDS.filter((id) => id !== 'ref-pinned').map((id) => ({ id, status: 'skip', detail }));

const report = (manifest, source, checks) => ({
  schemaVersion: 1,
  ref: manifest.memory.ref,
  contractVersion: manifest.contractVersion,
  source,
  checks,
  passed: checks.every((check) => check.status !== 'fail'),
});

export const runConformance = async ({
  from = null,
  manifest,
  schemas,
  rigBin,
  env = process.env,
}) => {
  if (!SHA.test(manifest.memory.ref))
    return report(manifest, from ? 'local' : 'fetched', [
      { id: 'ref-pinned', status: 'fail', detail: 'the manifest ref is not a 40-hex commit SHA' },
      ...skippedRows('not run: the pin is not a commit SHA, so nothing was fetched or spawned'),
    ]);
  const source = await acquire(manifest, from, env);
  const checks = [];
  try {
    if (source.source === 'local')
      checks.push({ id: 'ref-pinned', status: 'skip', detail: 'local checkout, ref not verified' });
    else if (source.fetchedRef === manifest.memory.ref)
      checks.push({
        id: 'ref-pinned',
        status: 'ok',
        detail: 'fetched commit equals the pinned ref',
      });
    else
      return report(manifest, source.source, [
        { id: 'ref-pinned', status: 'fail', detail: 'fetched commit differs from the pinned ref' },
        ...skippedRows(
          'not run: the fetched commit is not the pin, so nothing from it was spawned',
        ),
      ]);

    const contractDir = path.join(source.root, ...manifest.memory.contractDirectory.split('/'));
    const executable = path.join(source.root, ...manifest.memory.executable.split('/'));
    const childEnv = memoryProcessEnv(env);
    const spawnMemory = (args) =>
      run(process.execPath, [executable, ...args], { cwd: source.root, env: childEnv });

    const contractDoc = path.join(contractDir, 'contract-1.0.md');
    if (await exists(contractDoc)) {
      const text = await readFile(contractDoc, 'utf8');
      const named = text.includes('contractVersion') && text.includes('1.0');
      checks.push({
        id: 'contract-document',
        status: named ? 'ok' : 'fail',
        detail: named
          ? 'contract-1.0.md is present and names contractVersion 1.0'
          : 'contract-1.0.md is present but does not name contractVersion 1.0',
      });
    } else
      checks.push({
        id: 'contract-document',
        status: 'fail',
        detail: 'contract-1.0.md is missing',
      });

    try {
      const schema = await readJson(path.join(contractDir, 'event-schema-v1.json'));
      const isObject = typeof schema === 'object' && schema !== null && !Array.isArray(schema);
      checks.push({
        id: 'event-schema',
        status: isObject ? 'ok' : 'fail',
        detail: isObject
          ? 'event-schema-v1.json parses as an object'
          : 'event-schema-v1.json is not an object',
      });
    } catch {
      checks.push({
        id: 'event-schema',
        status: 'fail',
        detail: 'event-schema-v1.json is missing or does not parse',
      });
    }

    const accept = await countMarkdown(
      path.join(contractDir, 'fixtures', 'event-schema-v1', 'accept'),
    );
    const reject = await countMarkdown(
      path.join(contractDir, 'fixtures', 'event-schema-v1', 'reject'),
    );
    checks.push({
      id: 'fixtures-present',
      status: accept > 0 && reject > 0 ? 'ok' : 'fail',
      detail: `event-schema-v1 fixtures: ${accept} accept, ${reject} reject`,
    });

    const handshake = validatedAnswer({
      id: 'memory-handshake',
      answer: await spawnMemory(['--version', '--json']),
      schema: schemas.handshake,
      what: 'memory --version --json',
    });
    if (handshake.payload) {
      const major = majorOf(handshake.payload.contractVersion);
      if (handshake.payload.name !== 'memory')
        handshake.record = {
          id: 'memory-handshake',
          status: 'fail',
          detail: `the handshake names "${echo(handshake.payload.name)}", not memory`,
        };
      else if (major !== 1)
        handshake.record = {
          id: 'memory-handshake',
          status: 'fail',
          detail: `contract major ${major ?? 'unreadable'} is not 1`,
        };
      else
        handshake.record.detail = `memory ${echo(handshake.payload.version)} implements contract ${echo(handshake.payload.contractVersion)}`;
    }
    checks.push(handshake.record);

    const doctor = validatedAnswer({
      id: 'memory-doctor',
      answer: await spawnMemory(['doctor', '--json']),
      schema: schemas.doctor,
      what: 'memory doctor --json',
    });
    if (doctor.payload)
      doctor.record.detail = `doctor status ${echo(doctor.payload.status)}, ${doctor.payload.checks.length} check(s)`;
    checks.push(doctor.record);

    const rig = validatedAnswer({
      id: 'rig-handshake',
      answer: await run(process.execPath, [rigBin, '--version', '--json'], { env: childEnv }),
      schema: schemas.handshake,
      what: 'create-agent-rig --version --json',
    });
    if (rig.payload && rig.payload.name !== 'create-agent-rig')
      rig.record = {
        id: 'rig-handshake',
        status: 'fail',
        detail: 'the rig handshake does not name create-agent-rig',
      };
    checks.push(rig.record);
  } finally {
    await source.cleanup();
  }
  return report(manifest, source.source, checks);
};

const readPayloadFile = async (name) => {
  try {
    return await readJson(path.join(payloadDir, name));
  } catch {
    throw new Error(`cannot read the payload file ${name} under .claude/contracts/conformance-v1`);
  }
};

const main = async () => {
  const args = process.argv.slice(2);
  const fromIndex = args.indexOf('--from');
  const from = fromIndex >= 0 ? args[fromIndex + 1] : null;
  if (fromIndex >= 0 && !from) {
    process.stderr.write('usage: memory-conformance.mjs [--json] [--from <checkout-root>]\n');
    return 2;
  }
  const manifest = await readPayloadFile('manifest.json');
  const schemas = {
    handshake: await readPayloadFile('version-handshake.schema.json'),
    doctor: await readPayloadFile('doctor.schema.json'),
  };
  const result = await runConformance({
    from,
    manifest,
    schemas,
    rigBin: path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js'),
  });
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(result)}\n`);
  else
    process.stdout.write(
      `memory conformance at ${result.ref.slice(0, 7)} (${result.source}): ${result.passed ? 'passed' : 'FAILED'}\n` +
        result.checks
          .map((check) => `  ${check.status.padEnd(4)} ${check.id} — ${check.detail}\n`)
          .join(''),
    );
  return result.passed ? 0 : 1;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`memory-conformance: ${error.message}\n`);
      process.exit(1);
    },
  );
}
