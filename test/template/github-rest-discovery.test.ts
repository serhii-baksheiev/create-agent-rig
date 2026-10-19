import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stubCommand, type StubHandle } from '../helpers/stub-command.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const scriptPath = (name: string) => path.join(scriptsDir, name);

type Run = { code: number; stdout: string; out: string };
type Pull = Record<string, unknown>;

const run = (script: string, args: string[], cwd: string): Promise<Run> =>
  new Promise((resolve) => {
    const env = { ...process.env };
    delete env.RIG_RUN_DIR;
    execFile(
      process.execPath,
      [path.isAbsolute(script) ? script : scriptPath(script), ...args],
      { cwd, env },
      (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout,
          out: stdout + stderr,
        });
      },
    );
  });

const mergedPull = (number: number, over: Pull = {}): Pull => ({
  number,
  title: `merged change ${number}`,
  body: '',
  merged_at: '2026-10-18T12:00:00Z',
  html_url: `https://example.invalid/acme/widgets/pull/${number}`,
  labels: [],
  head: { ref: `fix/rp-${number}-change`, repo: { id: 10 } },
  base: { repo: { id: 10 } },
  ...over,
});

const installedDetector = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rp524-detector-'));
  await mkdir(path.join(dir, '.claude', 'scripts'), { recursive: true });
  await copyFile(
    scriptPath('detect-missed-gate.mjs'),
    path.join(dir, '.claude', 'scripts', 'detect-missed-gate.mjs'),
  );
  await writeFile(path.join(dir, 'AGENTS.md'), '```elevated-paths\ninfra/\n```\n');
  return dir;
};

describe('detect-missed-gate REST discovery', () => {
  const stubs: StubHandle[] = [];

  afterEach(() => {
    while (stubs.length) stubs.pop()!.restore();
  });

  it('reads merged PRs and changed files beyond the first REST page before reporting a missed elevated gate', async () => {
    const dir = await installedDetector();
    const bin = await mkdtemp(path.join(tmpdir(), 'rp524-rest-gh-'));
    const calls = path.join(bin, 'calls.jsonl');
    const pages = {
      merged: [[mergedPull(1)], [mergedPull(2)]],
      files: [
        [{ filename: 'src/ordinary.ts' }],
        [{ filename: 'infra/only-on-second-file-page.ts' }],
      ],
    };
    const gh = await stubCommand(
      'gh',
      [
        `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');`,
        "if (args[0] !== 'api' || args.some((arg) => /graphql|^pr$|^query$/i.test(arg))) {",
        "  process.stderr.write('fixture accepts REST gh api only\\n'); return { exitCode: 2 };",
        '}',
        `const pages = ${JSON.stringify(pages)};`,
        "const endpoint = args.find((arg) => /repos\\/.+\\/pulls/.test(arg)) || '';",
        'const number = endpoint.match(/\\/pulls\\/(\\d+)/)?.[1];',
        "const list = endpoint.includes('/files') ? pages.files : pages.merged;",
        "if (number && !endpoint.includes('/files')) return { stdout: JSON.stringify({ ...pages.merged[Number(number) - 1]?.[0], changed_files: number === '2' ? 2 : 1 }) + '\\n' };",
        "if (args.includes('--paginate') && args.includes('--slurp')) return { stdout: JSON.stringify(list) + '\\n' };",
        "const page = Number(new URL(endpoint || '/', 'https://fixture.invalid').searchParams.get('page') || 1);",
        "return { stdout: JSON.stringify(list[page - 1] || []) + '\\n' };",
      ].join('\n'),
    );
    stubs.push(gh);

    const result = await run(
      path.join(dir, '.claude', 'scripts', 'detect-missed-gate.mjs'),
      ['--since', '2026-10-01', '--json'],
      dir,
    );
    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ kind: string; pr: number }> };
    expect(parsed.findings).toContainEqual(expect.objectContaining({ kind: 'missed-gate', pr: 2 }));
    const entries = (await readFile(calls, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    expect(entries, 'the detector never called gh').not.toHaveLength(0);
    expect(
      entries.every((args) => args[0] === 'api'),
      JSON.stringify(entries),
    ).toBe(true);
  });

  it('never reports a clean sweep when a later REST changed-files page fails', async () => {
    const dir = await installedDetector();
    const gh = await stubCommand(
      'gh',
      [
        "if (args[0] !== 'api' || args.some((arg) => /graphql|^pr$|^query$/i.test(arg))) return { exitCode: 2 };",
        "const endpoint = args.find((arg) => /repos\\/.+\\/pulls/.test(arg)) || '';",
        "const page = Number(new URL(endpoint || '/', 'https://fixture.invalid').searchParams.get('page') || 1);",
        "if (endpoint.includes('/files') && page === 2) { process.stderr.write('second file page failed\\n'); return { exitCode: 2 }; }",
        "if (/\\/pulls\\/2(?:\\?|$)/.test(endpoint)) return { stdout: JSON.stringify({ number: 2, title: 'merged', body: '', merged_at: '2026-10-18T12:00:00Z', html_url: 'https://example.invalid/2', labels: [], head: { ref: 'fix/rp-524', repo: { id: 10 } }, base: { repo: { id: 10 } }, changed_files: 2 }) + '\\n' };",
        "if (endpoint.includes('/files')) return { stdout: JSON.stringify([{ filename: 'src/ordinary.ts' }]) + '\\n' };",
        "return { stdout: JSON.stringify(page === 1 ? [{ number: 2, merged_at: '2026-10-18T12:00:00Z' }] : []) + '\\n' };",
      ].join('\n'),
    );
    stubs.push(gh);

    const result = await run(
      path.join(dir, '.claude', 'scripts', 'detect-missed-gate.mjs'),
      ['--since', '2026-10-01', '--json'],
      dir,
    );
    expect(result.code, result.out).not.toBe(0);
    expect(result.out).toMatch(/not a clean|could not|unknown|incomplete/i);
  });

  it('keeps the existing detector --input fixture path offline', async () => {
    const dir = await installedDetector();
    const input = path.join(dir, 'merged.json');
    await writeFile(
      input,
      JSON.stringify([
        {
          number: 4,
          title: 'offline fixture',
          mergedAt: '2026-10-18T12:00:00Z',
          url: 'https://example.invalid/acme/widgets/pull/4',
          labels: [],
          files: ['infra/offline.ts'],
          changedFiles: 1,
        },
      ]),
    );
    const bin = await mkdtemp(path.join(tmpdir(), 'rp524-rest-gh-'));
    const calls = path.join(bin, 'calls.log');
    const gh = await stubCommand(
      'gh',
      `require('node:fs').appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n'); return { exitCode: 2 };`,
    );
    stubs.push(gh);

    const result = await run(
      path.join(dir, '.claude', 'scripts', 'detect-missed-gate.mjs'),
      ['--input', input, '--json'],
      dir,
    );
    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ kind: string; pr: number }> };
    expect(parsed.findings).toContainEqual(expect.objectContaining({ kind: 'missed-gate', pr: 4 }));
    await expect(readFile(calls, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a live REST PR without changed-file completeness metadata as unknown', async () => {
    const dir = await installedDetector();
    const gh = await stubCommand(
      'gh',
      [
        "if (args[0] !== 'api' || args.some((arg) => /graphql|^pr$|^query$/i.test(arg))) return { exitCode: 2 };",
        "const endpoint = args.find((arg) => /repos\\/.+\\/pulls/.test(arg)) || '';",
        "if (/\\/pulls\\/5(?:\\?|$)/.test(endpoint)) return { stdout: JSON.stringify({ number: 5, title: 'unknown completeness', body: '', merged_at: '2026-10-18T12:00:00Z', html_url: 'https://example.invalid/5', labels: [], head: { ref: 'fix/rp-524', repo: { id: 10 } }, base: { repo: { id: 10 } } }) + '\\n' };",
        "if (endpoint.includes('/files')) return { stdout: JSON.stringify([{ filename: 'src/ordinary.ts' }]) + '\\n' };",
        "return { stdout: JSON.stringify([{ number: 5, merged_at: '2026-10-18T12:00:00Z' }]) + '\\n' };",
      ].join('\n'),
    );
    stubs.push(gh);

    const result = await run(
      path.join(dir, '.claude', 'scripts', 'detect-missed-gate.mjs'),
      ['--since', '2026-10-01', '--json'],
      dir,
    );
    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ kind: string; pr: number }> };
    expect(parsed.findings).toContainEqual(
      expect.objectContaining({ kind: 'unknown-file-list', pr: 5 }),
    );
  });

  it('reports a REST PR above GitHub files-endpoint maximum as unknown', async () => {
    const dir = await installedDetector();
    const gh = await stubCommand(
      'gh',
      [
        "if (args[0] !== 'api' || args.some((arg) => /graphql|^pr$|^query$/i.test(arg))) return { exitCode: 2 };",
        "const endpoint = args.find((arg) => /repos\\/.+\\/pulls/.test(arg)) || '';",
        "if (/\\/pulls\\/6(?:\\?|$)/.test(endpoint)) return { stdout: JSON.stringify({ number: 6, title: 'too many changed files', body: '', merged_at: '2026-10-18T12:00:00Z', html_url: 'https://example.invalid/6', labels: [], head: { ref: 'fix/rp-524', repo: { id: 10 } }, base: { repo: { id: 10 } }, changed_files: 3001 }) + '\\n' };",
        "if (endpoint.includes('/files')) return { stdout: JSON.stringify([{ filename: 'src/ordinary.ts' }]) + '\\n' };",
        "return { stdout: JSON.stringify([{ number: 6, merged_at: '2026-10-18T12:00:00Z' }]) + '\\n' };",
      ].join('\n'),
    );
    stubs.push(gh);

    const result = await run(
      path.join(dir, '.claude', 'scripts', 'detect-missed-gate.mjs'),
      ['--since', '2026-10-01', '--json'],
      dir,
    );
    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ kind: string; pr: number }> };
    expect(parsed.findings).toContainEqual(
      expect.objectContaining({ kind: 'unknown-file-list', pr: 6 }),
    );
  });

  it('reports a REST PR as unknown when its file pages end before changed_files', async () => {
    const dir = await installedDetector();
    const gh = await stubCommand(
      'gh',
      [
        "if (args[0] !== 'api' || args.some((arg) => /graphql|^pr$|^query$/i.test(arg))) return { exitCode: 2 };",
        "const endpoint = args.find((arg) => /repos\\/.+\\/pulls/.test(arg)) || '';",
        "const page = Number(new URL(endpoint || '/', 'https://fixture.invalid').searchParams.get('page') || 1);",
        "if (/\\/pulls\\/7(?:\\?|$)/.test(endpoint)) return { stdout: JSON.stringify({ number: 7, title: 'early terminal file page', body: '', merged_at: '2026-10-18T12:00:00Z', html_url: 'https://example.invalid/7', labels: [], head: { ref: 'fix/rp-524', repo: { id: 10 } }, base: { repo: { id: 10 } }, changed_files: 2 }) + '\\n' };",
        "if (endpoint.includes('/files')) return { stdout: JSON.stringify(page === 1 ? [{ filename: 'src/ordinary.ts' }] : []) + '\\n' };",
        "return { stdout: JSON.stringify([{ number: 7, merged_at: '2026-10-18T12:00:00Z' }]) + '\\n' };",
      ].join('\n'),
    );
    stubs.push(gh);

    const result = await run(
      path.join(dir, '.claude', 'scripts', 'detect-missed-gate.mjs'),
      ['--since', '2026-10-01', '--json'],
      dir,
    );
    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ kind: string; pr: number }> };
    expect(parsed.findings).toContainEqual(
      expect.objectContaining({ kind: 'unknown-file-list', pr: 7 }),
    );
  });

  it('reports an oversized REST file page as unknown instead of trusting more than per_page rows', async () => {
    const dir = await installedDetector();
    const oversizedPage = Array.from({ length: 101 }, (_, index) => ({
      filename: `src/file-${index}.ts`,
    }));
    const gh = await stubCommand(
      'gh',
      [
        "if (args[0] !== 'api' || args.some((arg) => /graphql|^pr$|^query$/i.test(arg))) return { exitCode: 2 };",
        "const endpoint = args.find((arg) => /repos\\/.+\\/pulls/.test(arg)) || '';",
        "if (/\\/pulls\\/8(?:\\?|$)/.test(endpoint)) return { stdout: JSON.stringify({ number: 8, title: 'oversized files page', body: '', merged_at: '2026-10-18T12:00:00Z', html_url: 'https://example.invalid/8', labels: [], head: { ref: 'fix/rp-524', repo: { id: 10 } }, base: { repo: { id: 10 } }, changed_files: 101 }) + '\\n' };",
        "if (endpoint.includes('/files')) { if (!endpoint.includes('per_page=100') && !args.includes('per_page=100')) { process.stderr.write('expected per_page=100\\n'); return { exitCode: 2 }; } return { stdout: " +
          JSON.stringify(JSON.stringify(oversizedPage) + '\n') +
          ' }; }',
        "return { stdout: JSON.stringify([{ number: 8, merged_at: '2026-10-18T12:00:00Z' }]) + '\\n' };",
      ].join('\n'),
    );
    stubs.push(gh);

    const result = await run(
      path.join(dir, '.claude', 'scripts', 'detect-missed-gate.mjs'),
      ['--since', '2026-10-01', '--json'],
      dir,
    );
    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ kind: string; pr: number }> };
    expect(parsed.findings).toContainEqual(
      expect.objectContaining({ kind: 'unknown-file-list', pr: 8 }),
    );
  });

  it('reports a malformed REST file row without filename as unknown', async () => {
    const dir = await installedDetector();
    const gh = await stubCommand(
      'gh',
      [
        "if (args[0] !== 'api') return { exitCode: 2 };",
        "const endpoint = args.find((arg) => /repos\\/.+\\/pulls/.test(arg)) || '';",
        "const page = Number(new URL(endpoint || '/', 'https://fixture.invalid').searchParams.get('page') || 1);",
        "if (/\\/pulls\\/10(?:\\?|$)/.test(endpoint)) return { stdout: JSON.stringify({ number: 10, title: 'malformed file row', body: '', merged_at: '2026-10-18T12:00:00Z', html_url: 'https://example.invalid/10', labels: [], head: { ref: 'fix/rp-524', repo: { id: 10 } }, base: { repo: { id: 10 } }, changed_files: 1 }) + '\\n' };",
        "if (endpoint.includes('/files')) return { stdout: JSON.stringify([{}]) + '\\n' };",
        "return { stdout: JSON.stringify(page === 1 ? [{ number: 10, merged_at: '2026-10-18T12:00:00Z' }] : []) + '\\n' };",
      ].join('\n'),
    );
    stubs.push(gh);

    const result = await run(
      path.join(dir, '.claude', 'scripts', 'detect-missed-gate.mjs'),
      ['--since', '2026-10-01', '--json'],
      dir,
    );
    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ kind: string; pr: number }> };
    expect(parsed.findings).toContainEqual(
      expect.objectContaining({ kind: 'unknown-file-list', pr: 10 }),
    );
  });

  it('does not filter a REST detail missing number and merged_at into a clean sweep', async () => {
    const dir = await installedDetector();
    const gh = await stubCommand(
      'gh',
      [
        "if (args[0] !== 'api') return { exitCode: 2 };",
        "const endpoint = args.find((arg) => /repos\\/.+\\/pulls/.test(arg)) || '';",
        "const page = Number(new URL(endpoint || '/', 'https://fixture.invalid').searchParams.get('page') || 1);",
        "if (/\\/pulls\\/11(?:\\?|$)/.test(endpoint)) return { stdout: JSON.stringify({ title: 'incomplete detail schema', body: '', html_url: 'https://example.invalid/11', labels: [], head: { ref: 'fix/rp-524', repo: { id: 10 } }, base: { repo: { id: 10 } }, changed_files: 0 }) + '\\n' };",
        "return { stdout: JSON.stringify(page === 1 ? [{ number: 11, merged_at: '2026-10-18T12:00:00Z' }] : []) + '\\n' };",
      ].join('\n'),
    );
    stubs.push(gh);

    const result = await run(
      path.join(dir, '.claude', 'scripts', 'detect-missed-gate.mjs'),
      ['--since', '2026-10-01', '--json'],
      dir,
    );
    const parsed =
      result.code === 0
        ? (JSON.parse(result.stdout) as { findings: Array<{ kind: string }> })
        : null;
    expect(
      result.code !== 0 ||
        parsed?.findings.some((finding) => finding.kind === 'unknown-file-list') === true,
      result.out,
    ).toBe(true);
  });

  it('does not report a nested REST pull-list response as a clean sweep', async () => {
    const dir = await installedDetector();
    const gh = await stubCommand(
      'gh',
      [
        "if (args[0] !== 'api') return { exitCode: 2 };",
        "const endpoint = args.find((arg) => /repos\\/.+\\/pulls/.test(arg)) || '';",
        'if (!/pulls\\?/.test(endpoint)) return { exitCode: 2 };',
        "return { stdout: JSON.stringify([[]]) + '\\n' };",
      ].join('\n'),
    );
    stubs.push(gh);

    const result = await run(
      path.join(dir, '.claude', 'scripts', 'detect-missed-gate.mjs'),
      ['--since', '2026-10-01', '--json'],
      dir,
    );
    const parsed =
      result.code === 0
        ? (JSON.parse(result.stdout) as { findings: Array<{ kind: string }> })
        : null;
    expect(
      result.code !== 0 ||
        parsed?.findings.some((finding) => finding.kind === 'unknown-file-list') === true,
      result.out,
    ).toBe(true);
  });

  it('does not filter a REST detail with an invalid merged_at timestamp into a clean sweep', async () => {
    const dir = await installedDetector();
    const gh = await stubCommand(
      'gh',
      [
        "if (args[0] !== 'api') return { exitCode: 2 };",
        "const endpoint = args.find((arg) => /repos\\/.+\\/pulls/.test(arg)) || '';",
        "if (/\\/pulls\\/13(?:\\?|$)/.test(endpoint)) return { stdout: JSON.stringify({ number: 13, title: 'invalid merged timestamp', body: '', merged_at: 'not-a-date', html_url: 'https://example.invalid/13', labels: [], head: { ref: 'fix/rp-524', repo: { id: 10 } }, base: { repo: { id: 10 } }, changed_files: 0 }) + '\\n' };",
        "return { stdout: JSON.stringify([{ number: 13, merged_at: '2026-10-18T12:00:00Z' }]) + '\\n' };",
      ].join('\n'),
    );
    stubs.push(gh);

    const result = await run(
      path.join(dir, '.claude', 'scripts', 'detect-missed-gate.mjs'),
      ['--since', '2026-10-01', '--json'],
      dir,
    );
    const parsed =
      result.code === 0
        ? (JSON.parse(result.stdout) as { findings: Array<{ kind: string; pr: number }> })
        : null;
    expect(
      result.code !== 0 ||
        parsed?.findings.some(
          (finding) => finding.kind === 'unknown-file-list' && finding.pr === 13,
        ) === true,
      result.out,
    ).toBe(true);
  });

  it('bounds merged-PR acquisition with two explicit REST pages and refuses the overflow', async () => {
    const dir = await installedDetector();
    const bin = await mkdtemp(path.join(tmpdir(), 'rp524-detector-cap-'));
    const calls = path.join(bin, 'calls.jsonl');
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      number: index + 100,
      merged_at: '2026-10-18T12:00:00Z',
    }));
    const gh = await stubCommand(
      'gh',
      [
        `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');`,
        "if (args[0] !== 'api') return { exitCode: 2 };",
        "if (args.includes('--paginate')) { process.stderr.write('unbounded pagination is forbidden\\n'); return { exitCode: 2 }; }",
        "const endpoint = args.find((arg) => /repos\\/.+\\/pulls/.test(arg)) || '';",
        "const page = Number(new URL(endpoint || '/', 'https://fixture.invalid').searchParams.get('page') || 0);",
        'if (page === 1) return { stdout: ' +
          JSON.stringify(JSON.stringify(firstPage) + '\n') +
          ' };',
        "if (page === 2) return { stdout: JSON.stringify([{ number: 201, merged_at: '2026-10-18T12:00:00Z' }]) + '\\n' };",
        "process.stderr.write('unexpected third page\\n'); return { exitCode: 2 };",
      ].join('\n'),
    );
    stubs.push(gh);

    const result = await run(
      path.join(dir, '.claude', 'scripts', 'detect-missed-gate.mjs'),
      ['--since', '2026-10-01', '--json'],
      dir,
    );
    expect(result.code, result.out).not.toBe(0);
    const pages = (await readFile(calls, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
      .map((args) => args.find((arg) => /repos\/.+\/pulls/.test(arg)) ?? '')
      .map((endpoint) => new URL(endpoint, 'https://fixture.invalid').searchParams.get('page'));
    expect(pages).toEqual(['1', '2']);
  });

  it('sweeps a recent merged PR without exhausting older closed history ordered below --since', async () => {
    const dir = await installedDetector();
    const bin = await mkdtemp(path.join(tmpdir(), 'rp524-detector-since-'));
    const calls = path.join(bin, 'calls.jsonl');
    const oldRows = Array.from({ length: 99 }, (_, index) => ({
      number: index + 100,
      updated_at: '2026-09-01T00:00:00Z',
      merged_at: null,
    }));
    const firstPage = [
      { number: 12, updated_at: '2026-10-18T12:00:00Z', merged_at: '2026-10-18T12:00:00Z' },
      ...oldRows,
    ];
    const secondPage = [{ number: 999, updated_at: '2026-08-01T00:00:00Z', merged_at: null }];
    const gh = await stubCommand(
      'gh',
      [
        `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');`,
        "if (args[0] !== 'api') return { exitCode: 2 };",
        `const firstPage = ${JSON.stringify(firstPage)};`,
        `const secondPage = ${JSON.stringify(secondPage)};`,
        "const endpoint = args.find((arg) => /repos\\/.+\\/pulls/.test(arg)) || '';",
        "if (/\\/pulls\\/12(?:\\?|$)/.test(endpoint)) return { stdout: JSON.stringify({ number: 12, title: 'recent elevated merge', body: '', merged_at: '2026-10-18T12:00:00Z', html_url: 'https://example.invalid/12', labels: [], head: { ref: 'fix/rp-524', repo: { id: 10 } }, base: { repo: { id: 10 } }, changed_files: 1 }) + '\\n' };",
        "if (endpoint.includes('/files')) return { stdout: JSON.stringify([{ filename: 'infra/recent.ts' }]) + '\\n' };",
        "if (args.includes('--paginate') && args.includes('--slurp')) return { stdout: JSON.stringify([firstPage, secondPage]) + '\\n' };",
        "const page = Number(new URL(endpoint || '/', 'https://fixture.invalid').searchParams.get('page') || 0);",
        "if (page === 1) return { stdout: JSON.stringify(firstPage) + '\\n' };",
        "if (page === 2) return { stdout: JSON.stringify(secondPage) + '\\n' };",
        "process.stderr.write('unexpected history page\\n'); return { exitCode: 2 };",
      ].join('\n'),
    );
    stubs.push(gh);

    const result = await run(
      path.join(dir, '.claude', 'scripts', 'detect-missed-gate.mjs'),
      ['--since', '2026-10-01', '--json'],
      dir,
    );
    expect(result.code, result.out).toBe(0);
    const parsed = JSON.parse(result.stdout) as { findings: Array<{ kind: string; pr: number }> };
    expect(parsed.findings).toContainEqual(
      expect.objectContaining({ kind: 'missed-gate', pr: 12 }),
    );
    const listPages = (await readFile(calls, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
      .map((args) => args.find((arg) => /repos\/.+\/pulls\?state=closed/.test(arg)) ?? '')
      .filter(Boolean)
      .map((endpoint) => new URL(endpoint, 'https://fixture.invalid').searchParams.get('page'));
    expect(listPages).toEqual(['1']);
  });
});

describe('duplicate-work REST discovery', () => {
  const stubs: StubHandle[] = [];

  afterEach(() => {
    while (stubs.length) stubs.pop()!.restore();
  });

  it('finds a matching open PR returned on a later REST page', async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), 'rp524-duplicate-'));
    const runGit = (args: string[]) =>
      new Promise<Run>((resolve) => {
        execFile('git', args, { cwd: checkout }, (error, stdout, stderr) => {
          resolve({
            code: error ? ((error as { code?: number }).code ?? 1) : 0,
            stdout,
            out: stdout + stderr,
          });
        });
      });
    expect((await runGit(['init', '-q', '-b', 'master'])).code).toBe(0);
    await writeFile(path.join(checkout, 'README.md'), 'fixture\n');
    expect((await runGit(['add', 'README.md'])).code).toBe(0);
    expect(
      (
        await runGit([
          '-c',
          'user.email=t@example.invalid',
          '-c',
          'user.name=t',
          'commit',
          '-q',
          '-m',
          'fixture',
        ])
      ).code,
    ).toBe(0);
    expect((await runGit(['checkout', '-q', '-b', 'fix/rp-524-own-work'])).code).toBe(0);
    expect(
      (await runGit(['remote', 'add', 'origin', 'bogus://github.com/acme/widgets.git'])).code,
    ).toBe(0);

    const bin = await mkdtemp(path.join(tmpdir(), 'rp524-rest-gh-'));
    const calls = path.join(bin, 'calls.jsonl');
    const gh = await stubCommand(
      'gh',
      [
        `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');`,
        "if (args[0] !== 'api' || args.some((arg) => /graphql|^pr$|^query$/i.test(arg))) {",
        "  process.stderr.write('fixture accepts REST gh api only\\n'); return { exitCode: 2 };",
        '}',
        "const endpoint = args.find((arg) => /repos\\/.+\\/pulls/.test(arg)) || '';",
        "const open = [[{ number: 1, title: 'ordinary work', html_url: 'https://example.invalid/1', head: { ref: 'fix/ordinary', repo: { id: 10 } }, base: { repo: { id: 10 } } }], [{ number: 2, title: 'fix RP-524 elsewhere', html_url: 'https://example.invalid/2', head: { ref: 'fix/rp-524-elsewhere', repo: { id: 10 } }, base: { repo: { id: 10 } } }]];",
        "if (args.includes('--paginate') && args.includes('--slurp')) return { stdout: JSON.stringify(open) + '\\n' };",
        "const page = Number(new URL(endpoint || '/', 'https://fixture.invalid').searchParams.get('page') || 1);",
        "return { stdout: JSON.stringify(open[page - 1] || []) + '\\n' };",
      ].join('\n'),
    );
    stubs.push(gh);

    const result = await run('duplicate-work.mjs', ['--ticket', 'RP-524', '--json'], checkout);
    expect(result.code, result.out).toBe(2);
    const parsed = JSON.parse(result.stdout) as {
      verdict: string;
      matches: Array<{ source: string; ref: string }>;
    };
    expect(parsed.verdict).toBe('duplicate-work');
    expect(parsed.matches).toContainEqual(
      expect.objectContaining({ source: 'pr', ref: 'fix/rp-524-elsewhere' }),
    );
    const entries = (await readFile(calls, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    expect(
      entries.every((args) => args[0] === 'api'),
      JSON.stringify(entries),
    ).toBe(true);
  });

  it('marks a nested REST open-PR response unavailable instead of reading it as empty', async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), 'rp524-nested-open-'));
    const origin = await mkdtemp(path.join(tmpdir(), 'rp524-nested-open-origin-'));
    const runGit = (args: string[]) =>
      new Promise<Run>((resolve) => {
        execFile('git', args, { cwd: checkout }, (error, stdout, stderr) => {
          resolve({
            code: error ? ((error as { code?: number }).code ?? 1) : 0,
            stdout,
            out: stdout + stderr,
          });
        });
      });
    expect((await runGit(['init', '-q', '--bare', origin])).code).toBe(0);
    expect((await runGit(['init', '-q', '-b', 'master'])).code).toBe(0);
    await writeFile(path.join(checkout, 'README.md'), 'fixture\n');
    expect((await runGit(['add', 'README.md'])).code).toBe(0);
    expect(
      (
        await runGit([
          '-c',
          'user.email=t@example.invalid',
          '-c',
          'user.name=t',
          'commit',
          '-q',
          '-m',
          'fixture',
        ])
      ).code,
    ).toBe(0);
    expect((await runGit(['remote', 'add', 'origin', origin])).code).toBe(0);
    expect((await runGit(['push', '-q', '-u', 'origin', 'master'])).code).toBe(0);

    const gh = await stubCommand(
      'gh',
      [
        "if (args[0] !== 'api') return { exitCode: 2 };",
        "const endpoint = args.find((arg) => /repos\\/.+\\/pulls/.test(arg)) || '';",
        'if (!/pulls\\?/.test(endpoint)) return { exitCode: 2 };',
        "return { stdout: JSON.stringify([[]]) + '\\n' };",
      ].join('\n'),
    );
    stubs.push(gh);

    const result = await run('duplicate-work.mjs', ['--ticket', 'RP-524', '--json'], checkout);
    const parsed = JSON.parse(result.stdout) as {
      verdict: string;
      sources: Array<{ name: string; status: string }>;
    };
    expect(parsed.sources).toContainEqual({ name: 'branch', status: 'read' });
    expect(parsed.sources).toContainEqual({ name: 'pr', status: 'unavailable' });
    expect(parsed.verdict).toBe('unverifiable');
    expect(result.code, result.out).toBe(3);
  });

  it('does not exclude an own-branch REST PR when both repository identities are missing', async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), 'rp524-uncertain-identity-'));
    const runGit = (args: string[]) =>
      new Promise<Run>((resolve) => {
        execFile('git', args, { cwd: checkout }, (error, stdout, stderr) => {
          resolve({
            code: error ? ((error as { code?: number }).code ?? 1) : 0,
            stdout,
            out: stdout + stderr,
          });
        });
      });
    expect((await runGit(['init', '-q', '-b', 'master'])).code).toBe(0);
    await writeFile(path.join(checkout, 'README.md'), 'fixture\n');
    expect((await runGit(['add', 'README.md'])).code).toBe(0);
    expect(
      (
        await runGit([
          '-c',
          'user.email=t@example.invalid',
          '-c',
          'user.name=t',
          'commit',
          '-q',
          '-m',
          'fixture',
        ])
      ).code,
    ).toBe(0);
    const ownBranch = 'fix/rp-524-own-work';
    expect((await runGit(['checkout', '-q', '-b', ownBranch])).code).toBe(0);
    expect(
      (await runGit(['remote', 'add', 'origin', 'bogus://github.com/acme/widgets.git'])).code,
    ).toBe(0);
    const gh = await stubCommand(
      'gh',
      [
        "if (args[0] !== 'api') return { exitCode: 2 };",
        "const endpoint = args.find((arg) => /repos\\/.+\\/pulls/.test(arg)) || '';",
        "const page = Number(new URL(endpoint || '/', 'https://fixture.invalid').searchParams.get('page') || 1);",
        "return { stdout: JSON.stringify(page === 1 ? [{ number: 9, title: 'fix RP-524 elsewhere', html_url: 'https://example.invalid/9', head: { ref: 'fix/rp-524-own-work', repo: {} }, base: { repo: {} } }] : []) + '\\n' };",
      ].join('\n'),
    );
    stubs.push(gh);

    const result = await run('duplicate-work.mjs', ['--ticket', 'RP-524', '--json'], checkout);
    expect(result.code, result.out).toBe(2);
    const parsed = JSON.parse(result.stdout) as { matches: Array<{ source: string; ref: string }> };
    expect(parsed.matches).toContainEqual(
      expect.objectContaining({ source: 'pr', ref: ownBranch }),
    );
  });

  it('bounds open-PR acquisition with two explicit REST pages and refuses the overflow', async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), 'rp524-duplicate-cap-'));
    const runGit = (args: string[]) =>
      new Promise<Run>((resolve) => {
        execFile('git', args, { cwd: checkout }, (error, stdout, stderr) => {
          resolve({
            code: error ? ((error as { code?: number }).code ?? 1) : 0,
            stdout,
            out: stdout + stderr,
          });
        });
      });
    expect((await runGit(['init', '-q', '-b', 'master'])).code).toBe(0);
    await writeFile(path.join(checkout, 'README.md'), 'fixture\n');
    expect((await runGit(['add', 'README.md'])).code).toBe(0);
    expect(
      (
        await runGit([
          '-c',
          'user.email=t@example.invalid',
          '-c',
          'user.name=t',
          'commit',
          '-q',
          '-m',
          'fixture',
        ])
      ).code,
    ).toBe(0);
    expect(
      (await runGit(['remote', 'add', 'origin', 'bogus://github.com/acme/widgets.git'])).code,
    ).toBe(0);
    const bin = await mkdtemp(path.join(tmpdir(), 'rp524-duplicate-cap-gh-'));
    const calls = path.join(bin, 'calls.jsonl');
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      title: `ordinary work ${index}`,
      html_url: `https://example.invalid/${index}`,
      head: { ref: `fix/ordinary-${index}`, repo: { id: 10 } },
      base: { repo: { id: 10 } },
    }));
    const gh = await stubCommand(
      'gh',
      [
        `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');`,
        "if (args[0] !== 'api') return { exitCode: 2 };",
        "if (args.includes('--paginate')) { process.stderr.write('unbounded pagination is forbidden\\n'); return { exitCode: 2 }; }",
        "const endpoint = args.find((arg) => /repos\\/.+\\/pulls/.test(arg)) || '';",
        "const page = Number(new URL(endpoint || '/', 'https://fixture.invalid').searchParams.get('page') || 0);",
        'if (page === 1) return { stdout: ' +
          JSON.stringify(JSON.stringify(firstPage) + '\n') +
          ' };',
        "if (page === 2) return { stdout: JSON.stringify([{ number: 101, title: 'ordinary overflow', html_url: 'https://example.invalid/101', head: { ref: 'fix/ordinary-overflow', repo: { id: 10 } }, base: { repo: { id: 10 } } }]) + '\\n' };",
        "process.stderr.write('unexpected third page\\n'); return { exitCode: 2 };",
      ].join('\n'),
    );
    stubs.push(gh);

    const result = await run('duplicate-work.mjs', ['--ticket', 'RP-524', '--json'], checkout);
    expect(result.code, result.out).toBe(3);
    const pages = (await readFile(calls, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
      .map((args) => args.find((arg) => /repos\/.+\/pulls/.test(arg)) ?? '')
      .map((endpoint) => new URL(endpoint, 'https://fixture.invalid').searchParams.get('page'));
    expect(pages).toEqual(['1', '2']);
  });

  it('marks a REST PR with missing matching fields unavailable instead of treating it as an empty read', async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), 'rp524-invalid-pr-row-'));
    const runGit = (args: string[]) =>
      new Promise<Run>((resolve) => {
        execFile('git', args, { cwd: checkout }, (error, stdout, stderr) => {
          resolve({
            code: error ? ((error as { code?: number }).code ?? 1) : 0,
            stdout,
            out: stdout + stderr,
          });
        });
      });
    expect((await runGit(['init', '-q', '-b', 'master'])).code).toBe(0);
    await writeFile(path.join(checkout, 'README.md'), 'fixture\n');
    expect((await runGit(['add', 'README.md'])).code).toBe(0);
    expect(
      (
        await runGit([
          '-c',
          'user.email=t@example.invalid',
          '-c',
          'user.name=t',
          'commit',
          '-q',
          '-m',
          'fixture',
        ])
      ).code,
    ).toBe(0);
    expect(
      (await runGit(['remote', 'add', 'origin', 'bogus://github.com/acme/widgets.git'])).code,
    ).toBe(0);
    const gh = await stubCommand(
      'gh',
      [
        "if (args[0] !== 'api') return { exitCode: 2 };",
        "return { stdout: JSON.stringify([[{ number: 13, title: null, html_url: 'https://example.invalid/13', head: { ref: null, repo: { id: 10 } }, base: { repo: { id: 10 } } }]]) + '\\n' };",
      ].join('\n'),
    );
    stubs.push(gh);

    const result = await run('duplicate-work.mjs', ['--ticket', 'RP-524', '--json'], checkout);
    expect(result.code, result.out).toBe(3);
    const parsed = JSON.parse(result.stdout) as {
      verdict: string;
      sources: Array<{ name: string; status: string }>;
    };
    expect(parsed.verdict).toBe('unverifiable');
    expect(parsed.sources).toContainEqual({ name: 'pr', status: 'unavailable' });
  });
});
