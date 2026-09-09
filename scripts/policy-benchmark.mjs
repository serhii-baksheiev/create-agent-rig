#!/usr/bin/env node
import { readFile, readdir, mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const main = async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'policy-benchmark-controller-'));
  try {
    const verifierRoot = path.join(temporary, 'verifier');
    const files = [
      'scripts/policy-benchmark.mjs',
      'scripts/policy-benchmark-controller.mjs',
      'scripts/policy-benchmark-worker.mjs',
      'scripts/policy-benchmark-schema.mjs',
      'scripts/policy-benchmark-runtime.mjs',
      'scripts/policy-benchmark-snapshot.mjs',
      '.claude/scripts/unattended-flag.mjs',
      '.claude/scripts/stop-flag.mjs',
      'pnpm-lock.yaml',
      'package.json',
    ];
    const collect = async (directory) => {
      for (const entry of await readdir(path.join(sourceRoot, directory), {
        withFileTypes: true,
      })) {
        const relative = `${directory}/${entry.name}`;
        if (entry.isDirectory()) await collect(relative);
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(relative);
      }
    };
    await collect('packages/cli/dist/policy');
    const hash = createHash('sha256');
    for (const file of files.sort()) {
      const content = await readFile(path.join(sourceRoot, file));
      hash.update(JSON.stringify([file, content.length]));
      hash.update(content);
      const target = path.join(verifierRoot, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, { flag: 'wx' });
    }
    await symlink(
      path.join(sourceRoot, 'node_modules'),
      path.join(verifierRoot, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const { runBenchmark } = await import(
      pathToFileURL(path.join(verifierRoot, 'scripts/policy-benchmark-controller.mjs')).href
    );
    const report = await runBenchmark({
      argv: process.argv.slice(2),
      temporary,
      verifierRoot,
      sourceRoot,
      files,
      contentSha256: hash.digest('hex'),
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.passed) process.exitCode = 1;
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
