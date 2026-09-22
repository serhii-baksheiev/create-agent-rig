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
// 0 iff no row failed, 1 otherwise, 2 for an invalid invocation, 3 when the
// runner itself failed (test/template/memory-conformance.test.ts › "exits 3,
// not 1, when the runner itself fails — an --out path whose directory does not
// exist").
//
// What it never does: import anything from the checkout, read Memory's
// storage, write into the caller's configuration root, or copy fixtures into
// this repository. The Memory executable is spawned exactly as
// `create-agent-rig memory` would spawn it, with a minimal environment
// (`memoryProcessEnv` is the allow-list), and only its stdout is parsed —
// against the contract schemas, with the dependency-free validator in
// ./lib/json-schema-subset.mjs. No `detail` names a path, and text a
// subprocess chose is cut before it enters one (both in
// test/template/memory-conformance.test.ts › "records the HEAD of a git --from
// root as memorySha, keeps memory-doctor passing when the doctor answers status
// fail, passes a load answer shaped like the contract fixture, and cuts a
// subprocess-chosen value before it enters a detail"): the
// report travels into CI logs and PR comments.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
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
const RIG_BIN = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const SPAWN_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
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
      maxBuffer: MAX_STDOUT_BYTES,
      windowsHide: true,
      ...options,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    // A child that started and was then killed for writing more than
    // maxBuffer reports this same error.code shape as a real spawn failure
    // (RP-206 C2) — it is not one: the child ran, it just overran the
    // buffer, so it must not read as "could not start".
    const overflowed = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      spawnError: typeof error.code === 'string' && !overflowed ? error.code : undefined,
      overflowed,
      signal: typeof error.signal === 'string' ? error.signal : undefined,
      timedOut: error.killed === true,
    };
  }
};

/**
 * How a spawn ended, for a row's detail: the exit code or the signal, then the
 * first error code the child's stderr names — never its text, which can carry
 * a path. A bare "exit 1" is what RP-188 could not diagnose: a missing `dist`
 * and a killed child both read that way.
 */
const endedWith = (answer) => {
  const how = answer.overflowed
    ? `killed for exceeding the ${MAX_STDOUT_BYTES} byte output buffer`
    : answer.spawnError
      ? `could not start: ${answer.spawnError}`
      : answer.signal
        ? `killed by ${answer.signal}${answer.timedOut ? ` after the ${SPAWN_TIMEOUT_MS} ms budget` : ''}`
        : `exit ${answer.code}`;
  // The shapes Node prints an error code in, most specific first, so an
  // upper-case path segment earlier in the text is not mistaken for one.
  const code = (/\bcode: '([A-Z][A-Z0-9_]+)'/.exec(answer.stderr) ??
    /\[([A-Z][A-Z0-9_]+)\]/.exec(answer.stderr) ??
    /\b(E[A-Z]{3,})\b/.exec(answer.stderr))?.[1];
  return code === undefined ? how : `${how}, ${echo(code)}`;
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
  if (answer.overflowed)
    return { row: fail(id, `${what} exceeded the ${MAX_STDOUT_BYTES} byte output buffer`) };
  if (answer.spawnError)
    return { row: fail(id, `${what} could not be started (${answer.spawnError})`) };
  let payload;
  try {
    payload = JSON.parse(answer.stdout);
  } catch {
    return { row: fail(id, `${what} did not answer one JSON object (${endedWith(answer)})`) };
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

/** `git rev-parse HEAD` with the same allow-listed env as every other spawn, and no global or system git config. */
const sameDirectory = async (a, b) => {
  try {
    const [x, y] = await Promise.all([realpath(a), realpath(b)]);
    return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
  } catch {
    return false;
  }
};

/**
 * The HEAD of the checkout whose ROOT is `cwd` — null for a directory that is
 * not a git checkout root, including one nested inside somebody else's
 * repository, whose HEAD would otherwise be reported as if it were Memory's.
 */
const gitHead = async (cwd, childEnv) => {
  const env = {
    ...childEnv,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  };
  const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd, env });
  if (top.code !== 0 || !(await sameDirectory(top.stdout.trim(), cwd))) return null;
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd, env });
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
    // `contractVersion` followed, within the same line, by the version as a
    // whole token — `0.1.0` does not satisfy `1.0`.
    const named = new RegExp(
      `contractVersion[^\\n]{0,40}(?<![\\d.])${manifest.contractVersion.replace(/\./g, '\\.')}(?!\\.?\\d)`,
    ).test(text);
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
      // `identity` is beyond the contract's fixture — typed when present,
      // tolerated when absent — so the detail must not depend on it.
      `load result ${echo(load.payload.result)}, identity ${echo(load.payload.identity?.status ?? 'not reported')}`,
    );
  rows.push(load.row);
  return rows;
};

const rigRows = async (root, schemas, childEnv, scratch, rigBin) => {
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
          `setup --memory-root failed (${endedWith(setup)})${setup.code === 4 ? ': foreign contract major refused' : ''}`,
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
          `setup answered a contract major 2 stub with ${endedWith(foreign)}, not exit 4`,
        ),
  );
  return rows;
};

export const runConformance = async ({
  from,
  manifest,
  schemas,
  env = process.env,
  rigBin = RIG_BIN,
}) => {
  const root = path.resolve(from);
  const childEnv = memoryProcessEnv(env);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'memory-conformance-'));
  let rows;
  try {
    rows = [
      ...(await contractRows(root, manifest)),
      ...(await memoryRows(root, manifest, schemas, childEnv)),
      ...(await rigRows(root, schemas, childEnv, scratch, rigBin)),
    ];
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  return {
    schemaVersion: 1,
    contractVersion: manifest.contractVersion,
    rigSha: await gitHead(repoRoot, childEnv),
    memorySha: await gitHead(root, childEnv),
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
    if (index < 0) return null;
    const value = args[index + 1] ?? '';
    // A flag where a value should be is an invalid invocation, not a path.
    return value.startsWith('--') ? '' : value;
  };
  const from = option('--from');
  const out = option('--out');
  if (!from || out === '') {
    process.stderr.write(USAGE);
    return 2;
  }
  const manifest = await readContractFile('manifest.json');
  // The version reaches a file name and a regex: refuse a manifest whose
  // contractVersion is not the `major.minor` shape before either use.
  if (majorOf(manifest.contractVersion) === null)
    throw new Error('manifest.json contractVersion is not of the form <major>.<minor>');
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
  // `exitCode`, not `exit()`: the report has just been written to stdout, and
  // an immediate exit can truncate a pipe. A runner failure is 3 — distinct
  // from 1, a failed row, so the authoritative workflow can tell a crash from
  // a conformance failure.
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`memory-conformance: ${error.message}\n`);
      process.exitCode = 3;
    },
  );
}
