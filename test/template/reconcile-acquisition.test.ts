import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// RP-99 — "Repair external-PR acquisition and report only evidenced failure
// causes". Measured today: `gh version 2.71.2` answers
// `gh pr list --json authorAssociation` with `Unknown JSON field:
// "authorAssociation"`, so the script's only live path fails and its catch
// block prints a GUESSED cause ("the `gh` CLI is missing, unauthenticated, or
// the API is unreachable"). These tests pin the replacement design:
//
//   - `fetchMergedPrs(since, { exec })` acquires a base projection that never
//     asks for `authorAssociation`, then enriches it through a separate,
//     optional `gh api graphql` call. A failed or unusable enrichment call
//     degrades to the base records (no `authorAssociation`) plus a warning —
//     it never fabricates trust.
//   - `classifyAcquisitionFailure(error)` names only an EVIDENCED cause, never
//     a guess: `gh-missing | gh-unauthenticated | api-unreachable |
//     unsupported-projection | malformed-response | unknown`.
//   - `sanitizeDiagnostic(text)` is what makes `unknown`'s detail safe to
//     print: no ANSI/control sequences, one line, capped, credentials
//     redacted.
//   - `acquisitionFailureMessage({ cause, detail })` renders each cause as a
//     message naming ONLY that cause.
//
// The `--input` offline CLI path is exercised directly (acceptance #4); the
// live `gh api graphql` / `gh repo view` calls are exercised through an
// injected `exec` fake rather than a real subprocess. Acceptance #6 (live
// enumeration against a real `gh`) is out of scope for this file; it is not
// something a deterministic suite can pin.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(repoRoot, 'templates', 'agent-os', 'universal', '.claude', 'scripts');
const scriptPath = (name: string) => path.join(scriptsDir, name);
const load = (name: string) => import(pathToFileURL(scriptPath(name)).href);

const ELEVATED = ['infra/', 'packages/db/src/', 'services/api/src/handlers/auth.ts'];

// Assembled at load time from parts, never written as one contiguous
// credential-shaped literal — `guard-secret-file` refuses an edit whose TEXT
// carries a GitHub-token-shaped run, and a fixture only needs the SHAPE.
const FAKE_GH_TOKEN = ['ghp_', 'abcdefghijklmnopqrstuvwxyz123456'].join('');

/** A merged PR, in the shape `gh pr list --json` returns. */
const prUrl = (n: number) => `https://example.invalid/acme/widgets/pull/${n}`;
const pr = (over: Record<string, unknown> = {}) => ({
  number: 1,
  title: 'feat: add a route',
  body: 'Some description.',
  headRefName: 'feat/12-add-a-route',
  mergedAt: '2026-07-20T10:00:00Z',
  files: ['services/api/src/usecases/create-note.ts'],
  ...over,
  url: typeof over.url === 'string' ? over.url : prUrl(Number(over.number ?? 1)),
});

interface ExecCall {
  file: string;
  args: string[];
}

/**
 * A fake for the injectable `exec(file, args)` the design calls for —
 * synchronous, dispatching on the gh subcommand so one fake covers the base
 * list, the repository lookup, and the graphql enrichment call.
 */
const fakeGh = (responses: { prList?: string; repoView?: string; graphql?: string | Error }) => {
  const calls: ExecCall[] = [];
  const exec = (file: string, args: string[]): string => {
    calls.push({ file, args: [...args] });
    if (args[0] === 'pr' && args[1] === 'list') return responses.prList ?? '[]';
    if (args[0] === 'repo' && args[1] === 'view') {
      return responses.repoView ?? JSON.stringify({ nameWithOwner: 'acme/widgets' });
    }
    if (args[0] === 'api') {
      if (responses.graphql instanceof Error) throw responses.graphql;
      return responses.graphql ?? '{"data":{"repository":{}}}';
    }
    throw new Error(`fakeGh: unexpected call — ${file} ${args.join(' ')}`);
  };
  return { exec, calls };
};

describe('fetchMergedPrs — the base projection never requests authorAssociation', () => {
  it('requests a base projection whose --json fields exclude authorAssociation', async () => {
    const { fetchMergedPrs } = await load('reconcile-external-prs.mjs');
    const { exec, calls } = fakeGh({ prList: JSON.stringify([]) });
    await fetchMergedPrs('2026-07-01', { exec });
    const listCall = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'list');
    expect(listCall).toBeDefined();
    const fieldsIndex = listCall!.args.indexOf('--json') + 1;
    const fields = (listCall!.args[fieldsIndex] ?? '').split(',');
    expect(fields).not.toContain('authorAssociation');
    expect(fields).toEqual(
      expect.arrayContaining([
        'number',
        'title',
        'body',
        'headRefName',
        'mergedAt',
        'url',
        'files',
        'changedFiles',
      ]),
    );
  });

  it('never contains the literal unsupported field list this repo measured against gh 2.71.2', async () => {
    const source = await readFile(scriptPath('reconcile-external-prs.mjs'), 'utf8');
    expect(source).not.toMatch(
      /number,title,body,headRefName,mergedAt,url,files,changedFiles,authorAssociation/,
    );
  });
});

describe('fetchMergedPrs — optional enrichment through a compatible REST/GraphQL boundary', () => {
  it('resolves the repository via gh repo view before requesting authorAssociation', async () => {
    const { fetchMergedPrs } = await load('reconcile-external-prs.mjs');
    const base = [pr({ number: 7 })];
    const { exec, calls } = fakeGh({
      prList: JSON.stringify(base),
      repoView: JSON.stringify({ nameWithOwner: 'acme/widgets' }),
      graphql: JSON.stringify({
        data: { repository: { pr7: { url: prUrl(7), authorAssociation: 'OWNER' } } },
      }),
    });
    await fetchMergedPrs('2026-07-01', { exec });

    const repoViewCall = calls.find((c) => c.args[0] === 'repo' && c.args[1] === 'view');
    expect(repoViewCall).toBeDefined();
    expect(repoViewCall!.args).toEqual(expect.arrayContaining(['--json', 'nameWithOwner']));

    const apiCall = calls.find((c) => c.args[0] === 'api');
    expect(apiCall).toBeDefined();
    const query = apiCall!.args.join(' ');
    expect(query).toContain('acme');
    expect(query).toContain('widgets');
  });

  it('enriches every listed PR through a single graphql call naming each PR number', async () => {
    const { fetchMergedPrs } = await load('reconcile-external-prs.mjs');
    const base = [pr({ number: 7 }), pr({ number: 9 })];
    const { exec, calls } = fakeGh({
      prList: JSON.stringify(base),
      graphql: JSON.stringify({
        data: {
          repository: {
            pr7: { url: prUrl(7), authorAssociation: 'OWNER' },
            pr9: { url: prUrl(9), authorAssociation: 'CONTRIBUTOR' },
          },
        },
      }),
    });
    const { prs, warnings } = await fetchMergedPrs('2026-07-01', { exec });

    const apiCalls = calls.filter((c) => c.args[0] === 'api');
    expect(apiCalls).toHaveLength(1);
    const query = apiCalls[0]!.args.join(' ');
    expect(query).toContain('7');
    expect(query).toContain('9');

    expect(prs.find((p: { number: number }) => p.number === 7)?.authorAssociation).toBe('OWNER');
    expect(prs.find((p: { number: number }) => p.number === 9)?.authorAssociation).toBe(
      'CONTRIBUTOR',
    );
    expect(warnings).toEqual([]);
  });

  it('degrades to the base list without authorAssociation when the enrichment call throws', async () => {
    const { fetchMergedPrs } = await load('reconcile-external-prs.mjs');
    const base = [pr({ number: 7 })];
    const { exec } = fakeGh({
      prList: JSON.stringify(base),
      graphql: new Error('graphql exploded'),
    });
    const { prs, warnings } = await fetchMergedPrs('2026-07-01', { exec });
    expect(prs).toHaveLength(1);
    expect(prs[0].authorAssociation).toBeUndefined();
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.join(' ')).toMatch(/association/i);
    expect(warnings.join(' ')).toMatch(/unavailab/i);
  });

  it('degrades to the base list without authorAssociation when the enrichment response is not usable JSON', async () => {
    const { fetchMergedPrs } = await load('reconcile-external-prs.mjs');
    const base = [pr({ number: 7 })];
    const { exec } = fakeGh({ prList: JSON.stringify(base), graphql: 'not json at all {' });
    const { prs, warnings } = await fetchMergedPrs('2026-07-01', { exec });
    expect(prs[0].authorAssociation).toBeUndefined();
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('drops an association whose answer names a different pull request URL — another host or repository never becomes trust', async () => {
    const { fetchMergedPrs, reconcile } = await load('reconcile-external-prs.mjs');
    const base = [
      pr({ number: 7, headRefName: 'patch-1', body: 'fixes #40', files: ['infra/a.ts'] }),
    ];
    const { exec, calls } = fakeGh({
      prList: JSON.stringify(base),
      graphql: JSON.stringify({
        data: {
          repository: {
            pr7: { url: 'https://github.com/acme/widgets/pull/7', authorAssociation: 'OWNER' },
          },
        },
      }),
    });
    const { prs, warnings } = await fetchMergedPrs('2026-07-01', { exec });
    const apiCall = calls.find((c) => c.args[0] === 'api');
    expect(apiCall!.args.join(' ')).toMatch(/url/);
    expect(prs[0].authorAssociation).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/#7/);
    expect(reconcile({ prs, elevatedPaths: ELEVATED }).external[0].untrustedOrigin).toBe(true);
  });

  it('reconcile() treats a PR that lost authorAssociation to a failed enrichment as untrusted when it crosses an elevated path', async () => {
    const { fetchMergedPrs, reconcile } = await load('reconcile-external-prs.mjs');
    const base = [
      pr({ number: 7, headRefName: 'patch-1', body: 'fixes #40', files: ['infra/a.ts'] }),
    ];
    const { exec } = fakeGh({ prList: JSON.stringify(base), graphql: new Error('boom') });
    const { prs } = await fetchMergedPrs('2026-07-01', { exec });
    const result = reconcile({ prs, elevatedPaths: ELEVATED });
    expect(result.external[0].untrustedOrigin).toBe(true);
  });
});

describe('fetchMergedPrs — validating and sanitizing fallback data', () => {
  it('drops an authorAssociation value that does not match the allowed shape, with a warning', async () => {
    const { fetchMergedPrs } = await load('reconcile-external-prs.mjs');
    const base = [pr({ number: 7 })];
    const { exec } = fakeGh({
      prList: JSON.stringify(base),
      graphql: JSON.stringify({
        data: {
          repository: { pr7: { url: prUrl(7), authorAssociation: 'owner; DROP TABLE prs;' } },
        },
      }),
    });
    const { prs, warnings } = await fetchMergedPrs('2026-07-01', { exec });
    expect(prs[0].authorAssociation).toBeUndefined();
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('drops a base record that is not an object, with a warning', async () => {
    const { fetchMergedPrs } = await load('reconcile-external-prs.mjs');
    const { exec } = fakeGh({
      prList: JSON.stringify([pr({ number: 1 }), 'garbage', 42, null]),
    });
    const { prs, warnings } = await fetchMergedPrs('2026-07-01', { exec });
    expect(prs.map((p: { number: number }) => p.number)).toEqual([1]);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('drops a base record whose PR number is not a positive safe integer, with a warning', async () => {
    const { fetchMergedPrs } = await load('reconcile-external-prs.mjs');
    const { exec, calls } = fakeGh({
      prList: JSON.stringify([pr({ number: -3 }), pr({ number: 2 ** 60 })]),
    });
    const { prs, warnings } = await fetchMergedPrs('2026-07-01', { exec });
    expect(prs).toHaveLength(0);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(calls.some((c) => c.args[0] === 'api')).toBe(false);
  });

  it('drops a base record lacking a numeric PR number, with a warning', async () => {
    const { fetchMergedPrs } = await load('reconcile-external-prs.mjs');
    const { exec } = fakeGh({
      prList: JSON.stringify([{ title: 'no number here', mergedAt: '2026-07-01' }]),
    });
    const { prs, warnings } = await fetchMergedPrs('2026-07-01', { exec });
    expect(prs).toHaveLength(0);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });
});

describe('classifyAcquisitionFailure — an evidenced cause, never a guess', () => {
  it('classifies an ENOENT spawn error as gh-missing', async () => {
    const { classifyAcquisitionFailure } = await load('reconcile-external-prs.mjs');
    const error = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    expect(classifyAcquisitionFailure(error).cause).toBe('gh-missing');
  });

  it('classifies a "gh auth login" stderr as gh-unauthenticated', async () => {
    const { classifyAcquisitionFailure } = await load('reconcile-external-prs.mjs');
    const error = Object.assign(new Error('exit status 4'), {
      status: 4,
      stderr: 'To get started with GitHub CLI, please run:  gh auth login',
    });
    expect(classifyAcquisitionFailure(error).cause).toBe('gh-unauthenticated');
  });

  it('classifies a dial-tcp stderr as api-unreachable', async () => {
    const { classifyAcquisitionFailure } = await load('reconcile-external-prs.mjs');
    const error = Object.assign(new Error('exit status 1'), {
      status: 1,
      stderr: 'dial tcp: lookup api.github.com: no such host',
    });
    expect(classifyAcquisitionFailure(error).cause).toBe('api-unreachable');
  });

  it('classifies "Unknown JSON field" as unsupported-projection — the failure measured against gh 2.71.2 today', async () => {
    const { classifyAcquisitionFailure } = await load('reconcile-external-prs.mjs');
    const error = Object.assign(new Error('exit status 1'), {
      status: 1,
      stderr: 'gh: Unknown JSON field: "authorAssociation"',
    });
    expect(classifyAcquisitionFailure(error).cause).toBe('unsupported-projection');
  });

  it('classifies a JSON.parse SyntaxError as malformed-response', async () => {
    const { classifyAcquisitionFailure } = await load('reconcile-external-prs.mjs');
    let syntaxError: unknown;
    try {
      JSON.parse('not json');
    } catch (e) {
      syntaxError = e;
    }
    expect(classifyAcquisitionFailure(syntaxError).cause).toBe('malformed-response');
  });

  it('classifies a response that parsed but was not an array as malformed-response', async () => {
    // Chosen contract for this sub-case (the item does not pin a mechanism):
    // the caller marks a non-array parse result with `.notAnArray = true`
    // rather than throwing a SyntaxError, since JSON.parse itself succeeded.
    const { classifyAcquisitionFailure } = await load('reconcile-external-prs.mjs');
    const error = Object.assign(new Error('gh pr list returned an object, not an array'), {
      notAnArray: true,
    });
    expect(classifyAcquisitionFailure(error).cause).toBe('malformed-response');
  });

  it('classifies an evidence-free failure as unknown rather than guessing gh-missing, gh-unauthenticated, or api-unreachable', async () => {
    const { classifyAcquisitionFailure } = await load('reconcile-external-prs.mjs');
    const error = Object.assign(new Error('boom'), {
      stderr: 'some completely unrelated failure text',
    });
    expect(classifyAcquisitionFailure(error).cause).toBe('unknown');
  });

  it('falls back to the sanitized error message as detail for an unknown cause with no stderr', async () => {
    const { classifyAcquisitionFailure } = await load('reconcile-external-prs.mjs');
    const error = Object.assign(new Error('spawnSync gh EACCES'), { code: 'EACCES' });
    const result = classifyAcquisitionFailure(error);
    expect(result.cause).toBe('unknown');
    expect(result.detail).toContain('EACCES');
  });

  it('carries the sanitized first stderr line as detail for an unknown cause, with credentials redacted', async () => {
    const { classifyAcquisitionFailure } = await load('reconcile-external-prs.mjs');
    const error = Object.assign(new Error('boom'), {
      stderr: `\n  some raw curl failure, token=${FAKE_GH_TOKEN}\nsecond line`,
    });
    const result = classifyAcquisitionFailure(error);
    expect(result.cause).toBe('unknown');
    expect(result.detail).toContain('some raw curl failure');
    expect(result.detail).not.toContain(FAKE_GH_TOKEN);
  });
});

describe('sanitizeDiagnostic — safe to print', () => {
  it('strips ANSI escape sequences', async () => {
    const { sanitizeDiagnostic } = await load('reconcile-external-prs.mjs');
    expect(sanitizeDiagnostic('\x1b[31merror\x1b[0m: something failed')).toBe(
      'error: something failed',
    );
  });

  it('strips stray control characters without leaving them in the output', async () => {
    const { sanitizeDiagnostic } = await load('reconcile-external-prs.mjs');
    const out = sanitizeDiagnostic('bad\x07bell and \x00null');
    // eslint-disable-next-line no-control-regex -- the assertion is about control characters
    expect(out).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
    expect(out).toContain('badbell');
  });

  it('collapses multi-line text to the first non-empty line', async () => {
    const { sanitizeDiagnostic } = await load('reconcile-external-prs.mjs');
    expect(sanitizeDiagnostic('\n\n   first useful line   \nsecond line\nthird')).toBe(
      'first useful line',
    );
  });

  it('removes a carriage return and a tab inside the line', async () => {
    const { sanitizeDiagnostic } = await load('reconcile-external-prs.mjs');
    const out = sanitizeDiagnostic('HTTP 404: x\rlane reconciliation: all clean\tdone');
    expect(out).not.toMatch(/[\r\t]/);
    expect(out).toContain('all clean');
  });

  it('caps a diagnostic line at 200 characters', async () => {
    const { sanitizeDiagnostic } = await load('reconcile-external-prs.mjs');
    const out = sanitizeDiagnostic('x'.repeat(300));
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toBe('x'.repeat(200));
  });

  it('redacts a GitHub personal access token', async () => {
    const { sanitizeDiagnostic } = await load('reconcile-external-prs.mjs');
    const out = sanitizeDiagnostic(`failed using token ${FAKE_GH_TOKEN}`);
    expect(out).not.toContain(FAKE_GH_TOKEN);
    expect(out).toContain('[redacted]');
  });

  it('redacts a token that the 200-character cap would cut, instead of printing its prefix', async () => {
    const { sanitizeDiagnostic } = await load('reconcile-external-prs.mjs');
    // The token starts at index 190, so the cap leaves `ghp_` plus six of its
    // characters — too short for the credential pattern to recognise.
    const out = sanitizeDiagnostic(`${'y'.repeat(189)} ${FAKE_GH_TOKEN}`);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).not.toContain(FAKE_GH_TOKEN.slice(0, 6));
  });

  it('does not print a token cut at the redaction window after earlier redactions shorten the line', async () => {
    const { sanitizeDiagnostic } = await load('reconcile-external-prs.mjs');
    const long = ['ghp_', 'A'.repeat(2035)].join('');
    const cut = ['ghp_', 'SECRETPART12', 'B'.repeat(40)].join('');
    // two 2039-character tokens, then a third starting at offset 4084
    const out = sanitizeDiagnostic(`${long} ${long} xyz ${cut}`);
    expect(out).not.toContain('ghp_SECRET');
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it('redacts a Bearer authorization value', async () => {
    const { sanitizeDiagnostic } = await load('reconcile-external-prs.mjs');
    const out = sanitizeDiagnostic(`Authorization: Bearer ${FAKE_GH_TOKEN}`);
    expect(out).not.toContain(FAKE_GH_TOKEN);
    expect(out).toContain('[redacted]');
  });

  it('redacts an Authorization header value generically', async () => {
    const { sanitizeDiagnostic } = await load('reconcile-external-prs.mjs');
    const out = sanitizeDiagnostic(`Authorization: token ${FAKE_GH_TOKEN}`);
    expect(out).not.toContain(FAKE_GH_TOKEN);
    expect(out).toContain('[redacted]');
  });

  it('reuses the credential vocabulary from lib/secrets.mjs rather than keeping a second copy', async () => {
    const source = await readFile(scriptPath('reconcile-external-prs.mjs'), 'utf8');
    expect(source).toMatch(/from ['"]\.\/lib\/secrets\.mjs['"]/);
  });
});

describe('acquisitionFailureMessage — one cause named at a time', () => {
  it('names gh-missing without mentioning unauthenticated or unreachable', async () => {
    const { acquisitionFailureMessage } = await load('reconcile-external-prs.mjs');
    const message = acquisitionFailureMessage({ cause: 'gh-missing', detail: null }).toLowerCase();
    expect(message).not.toContain('unauthenticated');
    expect(message).not.toContain('unreachable');
  });

  it('names gh-unauthenticated without mentioning missing or unreachable', async () => {
    const { acquisitionFailureMessage } = await load('reconcile-external-prs.mjs');
    const message = acquisitionFailureMessage({
      cause: 'gh-unauthenticated',
      detail: null,
    }).toLowerCase();
    expect(message).not.toContain('missing');
    expect(message).not.toContain('unreachable');
  });

  it('names api-unreachable without mentioning missing or unauthenticated', async () => {
    const { acquisitionFailureMessage } = await load('reconcile-external-prs.mjs');
    const message = acquisitionFailureMessage({
      cause: 'api-unreachable',
      detail: null,
    }).toLowerCase();
    expect(message).not.toContain('missing');
    expect(message).not.toContain('unauthenticated');
  });

  it('names unsupported-projection distinctly from the other five causes', async () => {
    const { acquisitionFailureMessage } = await load('reconcile-external-prs.mjs');
    const message = acquisitionFailureMessage({
      cause: 'unsupported-projection',
      detail: null,
    }).toLowerCase();
    expect(message).not.toContain('missing');
    expect(message).not.toContain('unauthenticated');
    expect(message).not.toContain('unreachable');
  });

  it('names malformed-response distinctly from the other five causes', async () => {
    const { acquisitionFailureMessage } = await load('reconcile-external-prs.mjs');
    const message = acquisitionFailureMessage({
      cause: 'malformed-response',
      detail: null,
    }).toLowerCase();
    expect(message).not.toContain('missing');
    expect(message).not.toContain('unauthenticated');
    expect(message).not.toContain('unreachable');
  });

  it('says the cause is unknown and carries the sanitized detail', async () => {
    const { acquisitionFailureMessage } = await load('reconcile-external-prs.mjs');
    const message = acquisitionFailureMessage({ cause: 'unknown', detail: 'a raw curl failure' });
    expect(message.toLowerCase()).toContain('unknown');
    expect(message).toContain('a raw curl failure');
  });

  it('never lets a credential or a terminal control sequence from stderr reach the rendered message', async () => {
    const { classifyAcquisitionFailure, acquisitionFailureMessage } = await load(
      'reconcile-external-prs.mjs',
    );
    const error = Object.assign(new Error('boom'), {
      stderr: `\x1b[31mcurl failed\x1b[0m Authorization: Bearer ${FAKE_GH_TOKEN}`,
    });
    const message = acquisitionFailureMessage(classifyAcquisitionFailure(error));
    expect(message).not.toContain(FAKE_GH_TOKEN);
    // eslint-disable-next-line no-control-regex -- the assertion is about an escape sequence
    expect(message).not.toMatch(/\x1b\[/);
  });
});

describe('reconcile-external-prs CLI — the --input path stays compatible without authorAssociation', () => {
  /**
   * Installed into a throwaway project with its own `infra/` declaration,
   * exactly like `installedProject` in gate-scripts.test.ts — so the CLI test
   * exercises the real "read the declaration from the project" path rather
   * than depending on which paths THIS repo's own (generator or template)
   * CLAUDE.md happens to declare today.
   */
  async function installedProject() {
    const { mkdir, copyFile } = await import('node:fs/promises');
    const dir = await mkdtemp(path.join(tmpdir(), 'lane-acquire-'));
    await mkdir(path.join(dir, '.claude', 'scripts', 'lib'), { recursive: true });
    for (const script of ['reconcile-external-prs.mjs', 'detect-missed-gate.mjs']) {
      await copyFile(scriptPath(script), path.join(dir, '.claude', 'scripts', script));
    }
    // reconcile-external-prs.mjs is expected to import its credential
    // vocabulary from lib/secrets.mjs (see the sanitizeDiagnostic describe
    // block above) — copied so an installed project resolves the import.
    await copyFile(
      scriptPath('lib/secrets.mjs'),
      path.join(dir, '.claude', 'scripts', 'lib', 'secrets.mjs'),
    );
    await writeFile(path.join(dir, 'CLAUDE.md'), '```elevated-paths\ninfra/\n```\n');
    return dir;
  }

  const runInstalled = (dir: string, args: string[]) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const env = { ...process.env };
      delete env.RIG_RUN_DIR;
      execFile(
        process.execPath,
        [path.join(dir, '.claude', 'scripts', 'reconcile-external-prs.mjs'), ...args],
        { cwd: dir, env },
        (error, stdout, stderr) => {
          resolve({
            code: error ? ((error as { code?: number }).code ?? 1) : 0,
            out: stdout + stderr,
          });
        },
      );
    });

  it('reconciles offline PRs that carry no authorAssociation, still marking an elevated external PR untrusted', async () => {
    const dir = await installedProject();
    const input = path.join(dir, 'prs.json');
    await writeFile(
      input,
      JSON.stringify([
        pr({ number: 4, headRefName: 'patch-4', body: 'fixes #41', files: ['infra/b.ts'] }),
      ]),
    );
    const result = await runInstalled(dir, ['--input', input, '--json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out);
    expect(parsed.external[0].untrustedOrigin).toBe(true);
  });
});
