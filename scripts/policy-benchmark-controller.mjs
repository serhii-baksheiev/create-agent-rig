import { readFile, mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  benchmarkTimeouts,
  createBenchmarkEnv,
  runHarnessWorkers,
  runWorker,
} from './policy-benchmark-runtime.mjs';
import { benchmarkGit, materializeSnapshot } from './policy-benchmark-snapshot.mjs';

const usage = () => {
  throw new Error('usage: policy-benchmark --head <sha> [--root <repo>] [--corpus <json-file>]');
};
const options = (argv) => {
  const result = { root: process.cwd(), head: undefined, corpus: undefined };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--root', '--head', '--corpus'].includes(flag) || value === undefined) usage();
    if (flag === '--root') result.root = path.resolve(value);
    if (flag === '--head') result.head = value;
    if (flag === '--corpus') result.corpus = path.resolve(value);
  }
  if (result.head === undefined) usage();
  return result;
};

const readCorpus = async (file) => {
  const maximum = 1024 * 1024;
  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum)
      throw new Error('benchmark corpus requires a regular file within the byte limit');
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error('benchmark corpus byte limit exceeded');
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally {
    await handle.close();
  }
};

export const runBenchmark = async ({
  argv,
  temporary,
  verifierRoot,
  sourceRoot,
  files,
  contentSha256,
}) => {
  const args = options(argv);
  const home = path.join(temporary, 'home');
  const tmp = path.join(temporary, 'tmp');
  await mkdir(home);
  await mkdir(tmp);
  const environment = createBenchmarkEnv(process.env, { home, tmp });
  const git = async (root, ...args) =>
    (await benchmarkGit(root, environment, args)).toString('utf8').trim();
  const sourceIdentity = async () => {
    const hash = createHash('sha256');
    for (const file of files) {
      const content = await readFile(path.join(sourceRoot, file));
      hash.update(JSON.stringify([file, content.length]));
      hash.update(content);
    }
    return {
      headSha: await git(sourceRoot, 'rev-parse', 'HEAD'),
      contentSha256: hash.digest('hex'),
    };
  };
  const verifier = await sourceIdentity();
  if (verifier.contentSha256 !== contentSha256)
    throw new Error('verifier changed before adapter-process measurement began');
  const actualHead = await git(args.root, 'rev-parse', 'HEAD');
  if (actualHead !== args.head)
    throw new Error(`requested head ${args.head} does not name target tree ${actualHead}`);
  const dirty = await git(args.root, 'status', '--porcelain', '--ignore-submodules=all');
  if (dirty !== '')
    throw new Error(
      'tracked target evidence inputs are dirty; refuse to label adapter-process evidence',
    );
  const corpusModule = await import(
    pathToFileURL(path.join(verifierRoot, 'packages/cli/dist/policy/benchmark/corpus.js')).href
  );
  const corpus = corpusModule.parseBenchmarkCorpus(
    args.corpus === undefined ? corpusModule.BENCHMARK_CORPUS : await readCorpus(args.corpus),
  );
  const snapshot = await materializeSnapshot({
    root: args.root,
    head: actualHead,
    destination: path.join(temporary, 'snapshot'),
    env: environment,
  });
  const policy = await import(
    pathToFileURL(path.join(verifierRoot, 'packages/cli/dist/policy/index.js')).href
  );
  const results = await runHarnessWorkers(
    policy.HARNESS_ADAPTERS,
    async (adapter) => {
      const workspaceRoot = path.join(temporary, adapter.harness);
      await mkdir(workspaceRoot);
      return runWorker(
        path.join(verifierRoot, 'scripts/policy-benchmark-worker.mjs'),
        { ...snapshot, harness: adapter.harness, corpus, workspaceRoot },
        {
          cwd: verifierRoot,
          env: environment,
          timeoutMs: benchmarkTimeouts(process.platform).workerMs,
        },
      );
    },
    { platform: process.platform },
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  const reports = results.map((result) => result.value);
  const finalHead = await git(args.root, 'rev-parse', 'HEAD');
  const finalDirty = await git(args.root, 'status', '--porcelain', '--ignore-submodules=all');
  if (finalHead !== actualHead || finalDirty !== '')
    throw new Error('target tree changed while adapter-process evidence was being measured');
  if (JSON.stringify(await sourceIdentity()) !== JSON.stringify(verifier))
    throw new Error('verifier changed while adapter-process evidence was being measured');
  return {
    headSha: actualHead,
    verifier,
    evidenceKind: 'adapter-process',
    harnesses: reports,
    passed: reports.every((entry) => entry.passed),
    deferredIntegration: ['RP-13', 'RP-14-memory'],
  };
};
