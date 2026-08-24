#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const startMarker = '// <!-- limits:start -->';
const endMarker = '// <!-- limits:end -->';
const safeHookName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const fail = (message) => {
  process.stderr.write(`limits-table: ${message}\n`);
  process.exitCode = 1;
};

const assertSingleLine = (value, location) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`malformed LIMITS fixture: ${location} must be a non-empty string`);
  }
  if (/[\r\n\u2028\u2029]/u.test(value)) {
    throw new Error(
      `malformed LIMITS fixture: ${location} contains a carriage return, line feed, line separator, or paragraph separator`,
    );
  }
};

const readTable = async (hookName) => {
  const fixtureFile = path.join(scriptDir, 'limits', `${hookName}.json`);
  let fixtureInfo;
  try {
    fixtureInfo = await lstat(fixtureFile);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`unknown LIMITS fixture for ${hookName}`, { cause: error });
    }
    throw error;
  }
  if (fixtureInfo.isSymbolicLink() || !fixtureInfo.isFile()) {
    throw new Error(`LIMITS fixture for ${hookName} must be a regular file, not a symlink`);
  }

  const table = JSON.parse(await readFile(fixtureFile, 'utf8'));
  if (!table || !Array.isArray(table.notCaught) || !Array.isArray(table.scope)) {
    throw new Error(`malformed LIMITS fixture for ${hookName}`);
  }
  for (const [section, entries] of [
    ['notCaught', table.notCaught],
    ['scope', table.scope],
  ]) {
    for (const [index, entry] of entries.entries()) {
      assertSingleLine(entry?.prose, `${section}[${index}].prose`);
      if (section === 'scope') {
        if (!Array.isArray(entry?.variants) || entry.variants.length === 0) {
          throw new Error(`malformed LIMITS fixture: ${section}[${index}].variants must be non-empty`);
        }
        for (const [variantIndex, variant] of entry.variants.entries()) {
          const location = `${section}[${index}].variants[${variantIndex}]`;
          assertSingleLine(variant?.command, `${location}.command`);
          if (variant?.decision !== 'allow' && variant?.decision !== 'deny') {
            throw new Error(`malformed LIMITS fixture: ${location}.decision must be allow or deny`);
          }
          if (variant.brake !== undefined && typeof variant.brake !== 'boolean') {
            throw new Error(`malformed LIMITS fixture: ${location}.brake must be a boolean`);
          }
        }
      }
    }
  }
  assertSingleLine(table.footer, 'footer');
  return table;
};

const render = (table) =>
  [
    startMarker,
    '// Not caught:',
    ...table.notCaught.map(({ prose }) => `//   - ${prose};`),
    '//',
    '// And the SCOPE of each rule:',
    ...table.scope.map(({ prose }) => `//   - ${prose};`),
    '//',
    `// ${table.footer}`,
    endMarker,
  ].join('\n');

const replaceOwnedBlock = (source, generated) => {
  const starts = source.split(startMarker).length - 1;
  const ends = source.split(endMarker).length - 1;
  if (starts !== 1 || ends !== 1) {
    throw new Error('limits ownership markers must contain exactly one start and one end marker');
  }
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (end < start) throw new Error('limits ownership markers are in the wrong order');
  return source.slice(0, start) + generated + source.slice(end + endMarker.length);
};

const resolveRegularHook = async (hookName) => {
  const hooksDir = path.join(scriptDir, '..', 'hooks');
  const directoryInfo = await lstat(hooksDir);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new Error('hooks directory must be a regular directory, not a symlink');
  }

  const hookFile = path.join(hooksDir, `${hookName}.mjs`);
  const hookInfo = await lstat(hookFile);
  if (hookInfo.isSymbolicLink() || !hookInfo.isFile()) {
    throw new Error(`${hookName} hook must be a regular file, not a symlink`);
  }

  const [resolvedDirectory, resolvedHook] = await Promise.all([realpath(hooksDir), realpath(hookFile)]);
  if (path.dirname(resolvedHook) !== resolvedDirectory) {
    throw new Error(`${hookName} hook resolves outside the hooks directory`);
  }
  return { hookFile, mode: hookInfo.mode & 0o777 };
};

const atomicWrite = async (hookFile, content, mode) => {
  const temporary = path.join(
    path.dirname(hookFile),
    `.${path.basename(hookFile)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, hookFile);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
};

const main = async () => {
  const [hookName, ...flags] = process.argv.slice(2);
  const check = flags.length === 1 && flags[0] === '--check';
  if (!hookName || (flags.length > 0 && !check)) {
    throw new Error('usage: limits-table.mjs <hook> [--check]');
  }
  if (!safeHookName.test(hookName)) throw new Error(`unsafe hook name: ${hookName}`);

  const table = await readTable(hookName);
  const { hookFile, mode } = await resolveRegularHook(hookName);
  const source = await readFile(hookFile, 'utf8');
  const expected = replaceOwnedBlock(source, render(table));
  if (expected === source) return;
  if (check) throw new Error(`${hookName} limits table is out of date (drift detected)`);
  await atomicWrite(hookFile, expected, mode);
};

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
