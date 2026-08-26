/* eslint-disable no-control-regex, @typescript-eslint/no-implied-eval -- throwaway diagnostic */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// THROWAWAY diagnostic for the windows-unit SyntaxError on doctor.mjs (AR-5).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'universal',
  '.claude',
  'scripts',
  'doctor.mjs',
);

describe('doctor.mjs on this platform', () => {
  it('reports which layer refuses the file', async () => {
    const source = await readFile(file, 'utf8');
    const report: Record<string, string> = {
      platform: process.platform,
      node: process.version,
      bytes: String(Buffer.byteLength(source)),
      cr: String(source.includes('\r')),
    };
    try {
      new Function(
        source
          .replace(/^#!.*\n/, '')
          .replace(/\bexport\s+(const|function)\b/g, '$1')
          .replace(/^import .*$/gm, ''),
      );
      report.v8 = 'ok';
    } catch (e) {
      report.v8 = `FAIL ${(e as Error).message}`;
    }
    try {
      const esbuild = await import('esbuild');
      const out = await esbuild.transform(source, { loader: 'js', format: 'esm' });
      report.esbuild = `ok ${out.code.length}`;
      try {
        new Function(
          out.code.replace(/\bexport\s+(const|function)\b/g, '$1').replace(/^import .*$/gm, ''),
        );
        report.esbuildOutputV8 = 'ok';
      } catch (e) {
        const m = (e as Error).message;
        report.esbuildOutputV8 = `FAIL ${m}`;
        const bad = out.code
          .split('\n')
          .find((l) => /[^\x09\x0A\x0D\x20-\x7E]/.test(l) && !l.trim().startsWith('//'));
        report.firstNonAsciiCodeLine = bad ?? '(none)';
      }
    } catch (e) {
      report.esbuild = `FAIL ${(e as Error).message}`;
    }
    try {
      await import(pathToFileURL(file).href);
      report.viteImport = 'ok';
    } catch (e) {
      const err = e as Error & { cause?: unknown; frame?: string; loc?: unknown; id?: string };
      report.viteImport = `FAIL ${err.message}\nname=${err.name}\nid=${String(err.id)}\nloc=${JSON.stringify(err.loc)}\nframe=${String(err.frame)}\nstack=${String(err.stack).slice(0, 1500)}\ncause=${String(err.cause)}`;
    }
    console.log('DOCTOR-DEBUG ' + JSON.stringify(report, null, 2));
    expect(true).toBe(true);
  });
});
