#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePattern = /\/\* limits-fixture:start\n([\s\S]*?)\nlimits-fixture:end \*\//;
const startMarker = '// <!-- limits:start -->';
const endMarker = '// <!-- limits:end -->';

const fail = (message) => {
  process.stderr.write(`limits-table: ${message}\n`);
  process.exitCode = 1;
};

const parseFixtures = async () => {
  let directory = scriptDir;
  while (true) {
    const fixtureFile = path.join(directory, 'test', 'template', 'guard-hardening.test.ts');
    try {
      const source = await readFile(fixtureFile, 'utf8');
      const fixture = fixturePattern.exec(source)?.[1];
      if (!fixture) throw new Error(`missing LIMITS fixture in ${fixtureFile}`);
      return JSON.parse(fixture);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`missing LIMITS fixture above ${scriptDir}`);
    directory = parent;
  }
};

const validateTable = (hookName, table) => {
  if (!table || !Array.isArray(table.notCaught) || !Array.isArray(table.scope)) {
    throw new Error(`unknown or malformed LIMITS fixture for ${hookName}`);
  }
  const entries = [...table.notCaught, ...table.scope];
  if (entries.some((entry) => typeof entry?.prose !== 'string') || typeof table.footer !== 'string') {
    throw new Error(`malformed LIMITS fixture for ${hookName}`);
  }
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
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start < 0 || end < start) throw new Error('missing or malformed limits ownership markers');
  return source.slice(0, start) + generated + source.slice(end + endMarker.length);
};

const main = async () => {
  const [hookName, ...flags] = process.argv.slice(2);
  const check = flags.length === 1 && flags[0] === '--check';
  if (!hookName || (flags.length > 0 && !check)) {
    throw new Error('usage: limits-table.mjs <hook> [--check]');
  }

  const fixtures = await parseFixtures();
  const table = fixtures[hookName];
  validateTable(hookName, table);

  const hookFile = path.join(scriptDir, '..', 'hooks', `${hookName}.mjs`);
  const source = await readFile(hookFile, 'utf8');
  const expected = replaceOwnedBlock(source, render(table));
  if (expected === source) return;
  if (check) throw new Error(`${hookName} limits table is out of date (drift detected)`);
  await writeFile(hookFile, expected);
};

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
