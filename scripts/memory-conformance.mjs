#!/usr/bin/env node
// The Rig-side, offline half of the conformance matrix (RP-13,
// docs/command-contract.md "Conformance matrix"): given a Memory checkout the
// caller names, check — through process boundaries only — that what is there
// and what the two bins answer match the schemas under contracts/conformance/v1,
// and that the Rig consumes that Memory the way its `setup` and `memory` verbs
// promise (RP-147, RP-19).
//
//   node scripts/memory-conformance.mjs --from <checkout-root> [--json] [--out <file>]
//
// `--from` is mandatory: this script fetches nothing, holds no credential and
// reaches no network. The authoritative run lives in the private claude-config
// repository, whose workflow checks out this repository at an exact SHA and
// points `--from` at its own working tree; the report carries both SHAs
// (`rigSha` from this checkout, `memorySha` from the --from root when it is a
// git checkout, else null) and `verifierDigest` — sha256 over this file, the
// validator and the contract files, in that order — so a report can be tied
// to exactly what judged it. Pinned in test/template/memory-conformance.test.ts
// › "derives verifierDigest from the runner, its validator and the contract
// files, in that order, and writes the same report to --out".
//
// Rows, in order: contract-document, event-schema, fixtures-present,
// memory-handshake, memory-doctor, memory-load (Memory spawned directly),
// rig-handshake, rig-setup, rig-memory-doctor (the built rig bin registering
// Memory under a temporary configuration root of this run's own and passing
// `doctor --json` through it), rig-foreign-major (the rig refusing a stub that
// answers contract major 2 with exit 4 — the consumer-owned refusal, which
// Memory itself never emits). Each row is pass | fail | skip; the exit code is
// 0 iff no row failed, 1 otherwise, 2 for an invalid invocation.
//
// What it never does: import anything from the checkout, read Memory's
// storage, write into the caller's configuration root, or copy fixtures into
// this repository. The Memory executable is spawned exactly as
// `create-agent-rig memory` would spawn it, with a minimal environment
// (`memoryProcessEnv` is the allow-list), and only its stdout is parsed —
// against the contract schemas, with the dependency-free validator in
// ./lib/json-schema-subset.mjs. No `detail` names a path, and text a
// subprocess chose is cut before it enters one: the report travels into CI
// logs and PR comments.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { validate } from './lib/json-schema-subset.mjs';

const execFileAsync = promisify(execFile);
const selfPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(selfPath), '..');
const contractDir = path.join(repoRoot, 'contracts', 'conformance', 'v1');
const validatorPath = path.join(repoRoot, 'scripts', 'lib', 'json-schema-subset.mjs');
const rigBin = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const SPAWN_TIMEOUT_MS = 30_000;
const MAX_ECHOED_CHARACTERS = 32;
const SHA = /^[0-9a-f]{40}$/;
/** What the spawned Memory and rig processes may see of this process's environment. */
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
      maxBuffer: 4 * 1024 * 1024,
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

const pass = (id, detail) => ({ id, status: 'pass', detail });
const fail = (id, detail) => ({ id, status: 'fail', detail });
const skip = (id, detail) => ({ id, status: 'skip', detail });

/** One JSON answer, validated: a row and the parsed payload. Exit 0 is part of the shape. */
const validatedAnswer = ({ id, answer, schema, what }) => {
  if (answer.spawnError)
    return { row: fail(id, `${what} could not be started (${answer.spawnError})`) };
  let payload;
  try {
    payload = JSON.parse(answer.stdout);
  } catch {
    return { row: fail(id, `${what} did not answer one JSON object (exit ${answer.code})`) };
  }
  if (answer.code !== 0)
    return {
      row: fail(id, `${what} failed (exit ${answer.code}), answering ${echo(payload?.result)}`),
    };
  const result = validate(schema, payload);
  if (!result.ok)
    return {
      row: fail(id, `${what} answered outside the schema: ${result.errors.slice(0, 3).join('; ')}`),
    };
  return { row: pass(id, `${what} answered within the schema (exit 0)`), payload };
};

const gitHead = async (cwd) => {
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd });
  const sha = head.stdout.trim();
  return head.code === 0 && SHA.test(sha) ? sha : null;
};

const verifierDigest = async (manifest) => {
  const hash = createHash('sha256');
  const files = [
    selfPath,
    validatorPath,
    path.join(contractDir, 'manifest.json'),
    ...manifest.schemas.map((name) => path.join(contractDir, name)),
  ];
  for (const file of files) hash.update(await readFile(file));
  return hash.digest('hex');
};

const countMarkdown = async (dir) => {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.md')).length;
  } catch {
    return 0;
  }
};

/** A stub Memory that answers a foreign contract major: what the rig must refuse. */
const FOREIGN_STUB =
  "process.stdout.write(JSON.stringify({ schemaVersion: 1, name: 'memory', version: '9.9.9', contractVersion: '2.0' }) + '\\n');\n";

const contractRows = async (root, manifest) => {
  const rows = [];
  const dir = path.join(root, ...manifest.memory.contractDirectory.split('/'));

  const contractDoc = path.join(dir, `contract-${manifest.contractVersion}.md`);
  if (await exists(contractDoc)) {
    const text = await readFile(contractDoc, 'utf8');
    const named = text.includes('contractVersion') && text.includes(manifest.contractVersion);
    rows.push(
      named
        ? pass(
            'contract-document',
            `contract-${manifest.contractVersion}.md is present and names contractVersion ${manifest.contractVersion}`,
          )
        : fail(
            'contract-document',
            `contract-${manifest.contractVersion}.md is present but does not name contractVersion ${manifest.contractVersion}`,
          ),
    );
  } else rows.push(fail('contract-document', `contract-${manifest.contractVersion}.md is missing`));

  try {
    const schema = await readJson(path.join(dir, 'event-schema-v1.json'));
    const isObject = typeof schema === 'object' && schema !== null && !Array.isArray(schema);
    rows.push(
      isObject
        ? pass('event-schema', 'event-schema-v1.json parses as an object')
        : fail('event-schema', 'event-schema-v1.json is not an object'),
    );
  } catch {
    rows.push(fail('event-schema', 'event-schema-v1.json is missing or does not parse'));
  }

  const accept = await countMarkdown(path.join(dir, 'fixtures', 'event-schema-v1', 'accept'));
  const reject = await countMarkdown(path.join(dir, 'fixtures', 'event-schema-v1', 'reject'));
  rows.push(
    (accept > 0 && reject > 0 ? pass : fail)(
      'fixtures-present',
      `event-schema-v1 fixtures: ${accept} accept, ${reject} reject`,
    ),
  );
  return rows;
};

const memoryRows = async (root, manifest, schemas, childEnv) => {
  const executable = path.join(root, ...manifest.memory.executable.split('/'));
  const spawnMemory = (args) =>
    run(process.execPath, [executable, ...args], { cwd: root, env: childEnv });
  const rows = [];

  const handshake = validatedAnswer({
    id: 'memory-handshake',
    answer: await spawnMemory(['--version', '--json']),
    schema: schemas.handshake,
    what: 'memory --version --json',
  });
  if (handshake.payload) {
    const major = majorOf(handshake.payload.contractVersion);
    if (handshake.payload.name !== 'memory')
      handshake.row = fail(
        'memory-handshake',
        `the handshake names "${echo(handshake.payload.name)}", not memory`,
      );
    else if (major !== majorOf(manifest.contractVersion))
      handshake.row = fail(
        'memory-handshake',
        `contract major ${major ?? 'unreadable'} is not ${majorOf(manifest.contractVersion)}`,
      );
    else
      handshake.row = pass(
        'memory-handshake',
        `memory ${echo(handshake.payload.version)} implements contract ${echo(handshake.payload.contractVersion)}`,
      );
  }
  rows.push(handshake.row);

  const doctor = validatedAnswer({
    id: 'memory-doctor',
    answer: await spawnMemory(['doctor', '--json']),
    schema: schemas.doctor,
    what: 'memory doctor --json',
  });
  if (doctor.payload)
    doctor.row = pass(
      'memory-doctor',
      `doctor status ${echo(doctor.payload.status)}, ${doctor.payload.checks.length} check(s)`,
    );
  rows.push(doctor.row);

  // Shape only: whether this checkout's remote is mapped is the Memory
  // workflow's assertion, so `unsupported` is as much a pass here as `ok`.
  const load = validatedAnswer({
    id: 'memory-load',
    answer: await spawnMemory(['load', '--json', '--cwd', root]),
    schema: schemas.load,
    what: 'memory load --json --cwd <checkout>',
  });
  if (load.payload)
    load.row = pass(
      'memory-load',
      `load result ${echo(load.payload.result)}, identity ${echo(load.payload.identity.status)}`,
    );
  rows.push(load.row);
  return rows;
};

const rigRows = async (root, schemas, childEnv, scratch) => {
  const rows = [];
  // The rig writes its subsystem manifest under HOME (POSIX) or APPDATA
  // (Windows); both point at this run's scratch directory, so the caller's
  // configuration root is never read or written.
  const configRoot = path.join(scratch, 'config');
  await mkdir(configRoot, { recursive: true });
  const rigEnv = { ...childEnv, HOME: configRoot, APPDATA: configRoot };
  const spawnRig = (args) => run(process.execPath, [rigBin, ...args], { env: rigEnv });

  const handshake = validatedAnswer({
    id: 'rig-handshake',
    answer: await spawnRig(['--version', '--json']),
    schema: schemas.handshake,
    what: 'create-agent-rig --version --json',
  });
  if (handshake.payload && handshake.payload.name !== 'create-agent-rig')
    handshake.row = fail('rig-handshake', 'the rig handshake does not name create-agent-rig');
  rows.push(handshake.row);

  const setup = await spawnRig(['setup', '--memory-root', root]);
  const registered = setup.code === 0 && !setup.spawnError;
  rows.push(
    registered
      ? pass('rig-setup', 'setup --memory-root registered the checkout (exit 0)')
      : fail(
          'rig-setup',
          `setup --memory-root failed (exit ${setup.spawnError ?? setup.code})${setup.code === 4 ? ': foreign contract major refused' : ''}`,
        ),
  );

  if (!registered) rows.push(skip('rig-memory-doctor', 'not run: setup did not register Memory'));
  else {
    const through = validatedAnswer({
      id: 'rig-memory-doctor',
      answer: await spawnRig(['memory', 'doctor', '--json']),
      schema: schemas.doctor,
      what: 'create-agent-rig memory doctor --json',
    });
    if (through.payload)
      through.row = pass(
        'rig-memory-doctor',
        `the rig passed doctor through: status ${echo(through.payload.status)}, ${through.payload.checks.length} check(s)`,
      );
    rows.push(through.row);
  }

  const foreignRoot = path.join(scratch, 'foreign');
  await mkdir(path.join(foreignRoot, 'shared-memory'), { recursive: true });
  await writeFile(path.join(foreignRoot, 'shared-memory', 'memory.mjs'), FOREIGN_STUB);
  const foreign = await spawnRig(['setup', '--memory-root', foreignRoot]);
  rows.push(
    foreign.code === 4 && !foreign.spawnError
      ? pass('rig-foreign-major', 'setup refused a contract major 2 stub with exit 4')
      : fail(
          'rig-foreign-major',
          `setup answered a contract major 2 stub with exit ${foreign.spawnError ?? foreign.code}, not 4`,
        ),
  );
  return rows;
};

export const runConformance = async ({ from, manifest, schemas, env = process.env }) => {
  const root = path.resolve(from);
  const childEnv = memoryProcessEnv(env);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'memory-conformance-'));
  let rows;
  try {
    rows = [
      ...(await contractRows(root, manifest)),
      ...(await memoryRows(root, manifest, schemas, childEnv)),
      ...(await rigRows(root, schemas, childEnv, scratch)),
    ];
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  return {
    schemaVersion: 1,
    contractVersion: manifest.contractVersion,
    rigSha: await gitHead(repoRoot),
    memorySha: await gitHead(root),
    verifierDigest: await verifierDigest(manifest),
    rows,
    passed: rows.every((row) => row.status !== 'fail'),
  };
};

const readContractFile = async (name) => {
  try {
    return await readJson(path.join(contractDir, name));
  } catch {
    throw new Error(`cannot read the contract file ${name} under contracts/conformance/v1`);
  }
};

const USAGE = 'usage: memory-conformance.mjs --from <checkout-root> [--json] [--out <file>]\n';

const main = async () => {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? (args[index + 1] ?? '') : null;
  };
  const from = option('--from');
  const out = option('--out');
  if (!from || out === '') {
    process.stderr.write(USAGE);
    return 2;
  }
  const manifest = await readContractFile('manifest.json');
  const schemas = {
    handshake: await readContractFile('version-handshake.schema.json'),
    doctor: await readContractFile('doctor.schema.json'),
    load: await readContractFile('load.schema.json'),
  };
  const result = await runConformance({ from, manifest, schemas });
  const json = `${JSON.stringify(result)}\n`;
  if (out !== null) await writeFile(out, json);
  if (args.includes('--json')) process.stdout.write(json);
  else
    process.stdout.write(
      `memory conformance (rig ${result.rigSha?.slice(0, 7) ?? 'unknown'}, memory ${result.memorySha?.slice(0, 7) ?? 'not a git checkout'}): ${result.passed ? 'passed' : 'FAILED'}\n` +
        result.rows.map((row) => `  ${row.status.padEnd(4)} ${row.id} — ${row.detail}\n`).join(''),
    );
  return result.passed ? 0 : 1;
};

if (process.argv[1] && path.resolve(process.argv[1]) === selfPath) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`memory-conformance: ${error.message}\n`);
      process.exit(1);
    },
  );
}
