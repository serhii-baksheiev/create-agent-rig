import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GITHUB_PAT } from './secrets-fixtures.js';

// RP-224 — "[RIG 1.1][CONTINUITY] Publish bounded continuation notes for
// unfinished workflow stops".
//
// A second controller/machine has to be able to resume or revalidate a
// claimed item from durable, shared evidence alone — a tracker note, the PR,
// the branch, the claim — without depending on the first controller's local
// run journal or Memory. `continuation.mjs` is the one place that composes
// that note and (optionally) posts it, on exactly four workflow-level stops:
// escalation, an owner/external blocker, an intentional pause/handoff, and
// session termination while a claimed item remains unfinished. It is
// deliberately NOT called on every technical Claude Stop, subagent stop, or
// review round.
//
// This file is written against `.claude/scripts/continuation.mjs`, which does
// not exist yet — every test below is expected to fail because the module
// cannot be imported/spawned. It assumes these exports:
//
//   composeNote({ ticket, stop, branch, pr, headSha, gateRounds, verdict,
//                 diagnosis, remaining }) -> string
//   readRunEvidence(runDir) -> { gate, verdict, headSha, blockers }
//     (all null / blockers: [] when there is no run dir or it is unreadable)
//
// and a CLI:
//   node .claude/scripts/continuation.mjs --ticket <id> --stop <kind>
//        [--pr <n>] [--diagnosis <text>] [--remaining <text>] [--post]
//
// The independent oracle (`invariants.md`): every expected string below is
// typed out by hand in the test, never computed by calling the module's own
// scrubbing/redaction/cap logic — and the credential fixture is assembled at
// runtime (`secrets-fixtures.ts`) so this file itself carries no committable
// secret shape.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universalDir = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const scriptsDir = path.join(universalDir, '.claude', 'scripts');
const queueDir = path.join(scriptsDir, 'queue');
const scriptPath = (name: string) => path.join(scriptsDir, name);
const queueScriptPath = (name: string) => path.join(queueDir, name);
const load = (name: string) => import(pathToFileURL(scriptPath(name)).href);
const loadQueue = (name: string) => import(pathToFileURL(queueScriptPath(name)).href);
const skillPath = (...parts: string[]) =>
  path.join(universalDir, '.claude', 'skills', ...parts, 'SKILL.md');

const { withoutGitLocation } = (await import(pathToFileURL(scriptPath('git-env.mjs')).href)) as {
  withoutGitLocation: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

const run = (
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string; out: string }> =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, env }, (error, stdout, stderr) => {
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        stdout,
        stderr,
        out: stdout + stderr,
      });
    });
  });

const git = async (args: string[], cwd: string): Promise<string> => {
  const result = await run(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
    cwd,
    withoutGitLocation(),
  );
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
  return result.stdout.trim();
};

const hermeticEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (!('RIG_RUN_DIR' in extra)) delete env.RIG_RUN_DIR;
  return env;
};

const runCli = (
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; out: string; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [scriptPath('continuation.mjs'), ...args],
      { cwd, env },
      (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          out: stdout + stderr,
          stdout,
          stderr,
        });
      },
    );
  });

// --- composeNote -------------------------------------------------------

describe('composeNote — the shared shape', () => {
  it('starts with the fixed marker line, then key: value lines in the fixed order', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-224',
      stop: 'pause',
      branch: 'feat/rp-224-continuation-notes',
      pr: 315,
      headSha: 'e0e93a8123456789abcdef0123456789abcdef01',
      gateRounds: 2,
      verdict: {
        gate: 'pr-ship',
        verdict: 'HOLD',
        headSha: 'e0e93a8123456789abcdef0123456789abcdef01',
        blockers: ['workflow.md#pr-flow'],
      },
      diagnosis: 'short diagnosis',
      remaining: 'short remaining',
    });
    expect(note).toBe(
      [
        'rig-continuation v1',
        'ticket: RP-224',
        'stop: pause',
        'branch: feat/rp-224-continuation-notes',
        'pr: 315',
        'head: e0e93a8123456789abcdef0123456789abcdef01',
        'gate-rounds-this-checkout: 2',
        'latest-verdict: pr-ship HOLD @ e0e93a8 — blockers: workflow.md#pr-flow',
        'diagnosis: short diagnosis',
        'remaining: short remaining',
      ].join('\n'),
    );
  });

  it('prints unknown for every absent value — never omitted, never guessed', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({ ticket: 'RP-224', stop: 'terminated' });
    expect(note).toBe(
      [
        'rig-continuation v1',
        'ticket: RP-224',
        'stop: terminated',
        'branch: unknown',
        'pr: unknown',
        'head: unknown',
        'gate-rounds-this-checkout: unknown',
        'latest-verdict: unknown',
        'diagnosis: unknown',
        'remaining: unknown',
      ].join('\n'),
    );
  });

  it('does not throw when ticket is absent — it prints unknown, never guesses', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({ stop: 'pause' });
    expect(note.split('\n')[1]).toBe('ticket: unknown');
  });

  it('accepts each of the four stop kinds', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    for (const stop of ['escalation', 'blocker', 'pause', 'terminated']) {
      expect(() => composeNote({ ticket: 'RP-1', stop }), stop).not.toThrow();
      expect(composeNote({ ticket: 'RP-1', stop })).toContain(`stop: ${stop}`);
    }
  });

  it('refuses an unknown stop kind', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    expect(() => composeNote({ ticket: 'RP-1', stop: 'confused' })).toThrow(/stop/i);
  });

  it('refuses an absent stop kind', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    expect(() => composeNote({ ticket: 'RP-1' })).toThrow(/stop/i);
  });

  it('renders latest-verdict as "<gate> <verdict> @ <short sha>", short sha only', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      verdict: {
        gate: 'pr-ship',
        verdict: 'SHIP',
        headSha: 'e0e93a8123456789abcdef0123456789abcdef01',
        blockers: [],
      },
    });
    const line = note.split('\n').find((l) => l.startsWith('latest-verdict: '));
    expect(line).toBe('latest-verdict: pr-ship SHIP @ e0e93a8');
  });

  it('renders latest-verdict with an unknown short sha when the verdict named no head', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      verdict: { gate: 'pr-ship', verdict: 'SHIP', headSha: null, blockers: [] },
    });
    const line = note.split('\n').find((l) => l.startsWith('latest-verdict: '));
    expect(line).toBe('latest-verdict: pr-ship SHIP @ unknown');
  });

  it('caps diagnosis and remaining at 500 characters, with an explicit [truncated] marker', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const long = 'a'.repeat(600);
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      diagnosis: long,
      remaining: long,
    });
    // The rule (module header: "diagnosis and remaining are each capped at
    // 500 characters"): FIELD_CAP is the field's total length INCLUDING the
    // marker, not the number of original characters kept before it — so a
    // truncated field is 489 kept characters + the 11-character
    // '[truncated]' marker, 500 in total, never 500 kept characters plus the
    // marker on top.
    const expectedField = `${'a'.repeat(489)}[truncated]`;
    expect(expectedField).toHaveLength(500);
    expect(note).toContain(`diagnosis: ${expectedField}`);
    expect(note).toContain(`remaining: ${expectedField}`);
  });

  it('scrubs an absolute path of every shape the design names, once each', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const diagnosis = [
      'posix home: /home/serhiibaksheiev/rig-224/file.js',
      'posix users: /Users/serhii/project/file.ts',
      'posix tmp: /tmp/scratch/out.log',
      'windows: C:\\Users\\SerhiiBaksheiev\\Documents\\create-agent-rig\\file.ts',
      'wsl unc: \\\\wsl$\\Ubuntu\\home\\serhiibaksheiev\\rig-224\\file.ts',
    ].join(' | ');
    const note = composeNote({ ticket: 'RP-1', stop: 'escalation', diagnosis });
    const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
    expect(line).not.toMatch(/\/home\/serhiibaksheiev/);
    expect(line).not.toMatch(/\/Users\/serhii/);
    expect(line).not.toMatch(/\/tmp\/scratch/);
    expect(line).not.toMatch(/C:\\Users/);
    expect(line).not.toMatch(/wsl\$/i);
    expect((line.match(/\[path\]/g) ?? []).length).toBe(5);
  });

  it('redacts a credential-shaped value rather than printing it', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      diagnosis: `token leaked: ${GITHUB_PAT}`,
    });
    expect(note).toContain('[redacted]');
    expect(note).not.toContain(GITHUB_PAT);
  });

  it('caps the whole note, even when no single field is over its own cap', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({ ticket: 'RP-1', stop: 'escalation', branch: 'x'.repeat(5000) });
    expect(note.length).toBeLessThanOrEqual(2000);
    expect(note.endsWith('\n[truncated]')).toBe(true);
  });

  // RP-224 round 2 — code-reviewer r1 (checklist item 4, continuation.mjs:25):
  // "scrub gaps; pr ticket branch rules unscrubbed" — path scrubbing and
  // credential redaction ran over `diagnosis`/`remaining` only. EVERY string
  // field goes through the same two passes, or a path/credential typed into
  // any of the other fields is printed (and, with --post, published) verbatim.

  it('scrubs a path out of the ticket field, not only diagnosis/remaining', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({ ticket: '/home/serhiibaksheiev/notes/RP-224', stop: 'pause' });
    expect(note.split('\n')[1]).toBe('ticket: [path]');
  });

  it('scrubs a path out of the branch field', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'pause',
      branch: '/home/serhiibaksheiev/weird-branch-name',
    });
    const line = note.split('\n').find((l) => l.startsWith('branch: ')) as string;
    expect(line).toBe('branch: [path]');
  });

  it('scrubs a path out of the latest-verdict gate name', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      verdict: {
        gate: '/home/serhiibaksheiev/rig-224/gate-name',
        verdict: 'HOLD',
        headSha: 'e0e93a8123456789abcdef0123456789abcdef01',
        blockers: [],
      },
    });
    const line = note.split('\n').find((l) => l.startsWith('latest-verdict: '));
    expect(line).toBe('latest-verdict: [path] HOLD @ e0e93a8');
  });

  it('scrubs a path out of a blocker rule name in the latest-verdict line', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      verdict: {
        gate: 'pr-ship',
        verdict: 'HOLD',
        headSha: 'e0e93a8123456789abcdef0123456789abcdef01',
        blockers: ['/home/serhiibaksheiev/rules.md#tests'],
      },
    });
    const line = note.split('\n').find((l) => l.startsWith('latest-verdict: '));
    expect(line).toBe('latest-verdict: pr-ship HOLD @ e0e93a8 — blockers: [path]');
  });

  it('redacts a credential-shaped blocker rule name in the latest-verdict line', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      verdict: {
        gate: 'pr-ship',
        verdict: 'HOLD',
        headSha: 'e0e93a8123456789abcdef0123456789abcdef01',
        blockers: [GITHUB_PAT],
      },
    });
    const line = note.split('\n').find((l) => l.startsWith('latest-verdict: ')) as string;
    expect(line).toBe('latest-verdict: pr-ship HOLD @ e0e93a8 — blockers: [redacted]');
    expect(line).not.toContain(GITHUB_PAT);
  });

  // RP-224 round 2 — security-scanner r1 advisory: "newline line forgery". A
  // `\n` inside diagnosis/remaining must not be able to render as a second
  // `key: value` line — a forged `\nhead: deadbeef` would read as this note's
  // OWN head field to a reader who only greps for `^head: `.

  it('collapses an embedded newline in diagnosis so it cannot forge a second head: line', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      diagnosis: 'stuck\nhead: deadbeef',
    });
    const headLines = note.split('\n').filter((l) => l.startsWith('head: '));
    expect(headLines).toEqual(['head: unknown']);
    const diagnosisLine = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
    expect(diagnosisLine).toBe('diagnosis: stuck⏎head: deadbeef');
  });

  it('collapses an embedded newline in remaining so it cannot forge a second head: line', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      remaining: 'two left\nhead: deadbeef',
    });
    const headLines = note.split('\n').filter((l) => l.startsWith('head: '));
    expect(headLines).toEqual(['head: unknown']);
    const remainingLine = note.split('\n').find((l) => l.startsWith('remaining: ')) as string;
    expect(remainingLine).toBe('remaining: two left⏎head: deadbeef');
  });

  // RP-224 round 2 — code-reviewer r1 blocker (checklist item 6,
  // continuation.mjs:218): "last decision of any kind, not the latest
  // checked verdict". `readRunEvidence` is redesigned below to report the
  // latest REVIEW ROUND (the reviewers a `reviewer-fan-out` decision
  // launched, and what each answered), not merely the journal's last record.
  // `composeNote` needs a render path for that multi-reviewer shape —
  // `{ headSha, reviewers: [{ gate, verdict, blockers }, ...] }` — alongside
  // the single-verdict shape already pinned above, which stays valid for a
  // caller that hands composeNote one verdict directly.

  it('renders a multi-reviewer latest-verdict as "<gate> <verdict>, <gate> <verdict> @ <short sha>", a HOLD carrying its blocker rule names', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      verdict: {
        headSha: 'e0e93a8123456789abcdef0123456789abcdef01',
        reviewers: [
          { gate: 'code-reviewer', verdict: 'HOLD', blockers: ['workflow.md#tests'] },
          { gate: 'prose-reviewer', verdict: 'SHIP', blockers: [] },
        ],
      },
    });
    const line = note.split('\n').find((l) => l.startsWith('latest-verdict: '));
    expect(line).toBe(
      'latest-verdict: code-reviewer HOLD (workflow.md#tests), prose-reviewer SHIP @ e0e93a8',
    );
  });

  it('renders "unknown" for a multi-reviewer verdict whose round has no answers yet', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      verdict: { headSha: 'e0e93a8123456789abcdef0123456789abcdef01', reviewers: [] },
    });
    const line = note.split('\n').find((l) => l.startsWith('latest-verdict: '));
    expect(line).toBe('latest-verdict: unknown');
  });

  // RP-224 round 2 — security-scanner r1 blocker: "five-prefix allow-list
  // misses wsl.localhost, generic UNC, ~/ and drive paths with spaces" — the
  // scrub is redesigned by SHAPE (a drive letter, a UNC host\share, a tilde
  // home, a slash-rooted POSIX path) rather than a fixed prefix list. One
  // case per shape; the existing "scrubs an absolute path of every shape the
  // design names, once each" test above stays valid — /home, /Users, /tmp
  // and a bare Windows path are each a special case of a shape pinned here.
  describe('path scrubbing by SHAPE, not a fixed prefix list', () => {
    it('scrubs a tilde-prefixed home path', async () => {
      const { composeNote } = (await load('continuation.mjs')) as {
        composeNote: (input: Record<string, unknown>) => string;
      };
      const note = composeNote({
        ticket: 'RP-1',
        stop: 'escalation',
        diagnosis: 'checkout at ~/rig-224/output.log done',
      });
      const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
      expect(line).toBe('diagnosis: checkout at [path] done');
    });

    it('scrubs a Windows drive-letter path with spaces, consuming to end of line rather than the first space', async () => {
      const { composeNote } = (await load('continuation.mjs')) as {
        composeNote: (input: Record<string, unknown>) => string;
      };
      const note = composeNote({
        ticket: 'RP-1',
        stop: 'escalation',
        diagnosis: 'failed at C:\\Users\\Some Name\\Documents\\x.ts',
      });
      const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
      expect(line).toBe('diagnosis: failed at [path]');
    });

    it('scrubs a forward-slash drive-letter path, and stops at a closing quote rather than swallowing the rest of the line', async () => {
      const { composeNote } = (await load('continuation.mjs')) as {
        composeNote: (input: Record<string, unknown>) => string;
      };
      const note = composeNote({
        ticket: 'RP-1',
        stop: 'escalation',
        diagnosis: 'stack: "D:/Some Project/src/x.ts" then continue',
      });
      const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
      expect(line).toBe('diagnosis: stack: "[path]" then continue');
    });

    it('scrubs a generic UNC network path, including \\\\wsl.localhost\\..., not only \\\\wsl$\\...', async () => {
      const { composeNote } = (await load('continuation.mjs')) as {
        composeNote: (input: Record<string, unknown>) => string;
      };
      const diagnosis = [
        'generic unc: \\\\BUILD-SERVER\\share\\logs\\out.log',
        'wsl.localhost: \\\\wsl.localhost\\Ubuntu\\home\\serhiibaksheiev\\rig-224\\file.ts',
      ].join(' | ');
      const note = composeNote({ ticket: 'RP-1', stop: 'escalation', diagnosis });
      const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
      expect(line).not.toMatch(/BUILD-SERVER/);
      expect(line).not.toMatch(/wsl\.localhost/i);
      expect((line.match(/\[path\]/g) ?? []).length).toBe(2);
    });

    it('scrubs a slash-rooted POSIX path outside the four originally-named prefixes', async () => {
      const { composeNote } = (await load('continuation.mjs')) as {
        composeNote: (input: Record<string, unknown>) => string;
      };
      const diagnosis = [
        'root: /root/secrets.txt',
        'var: /var/folders/ab/xyz123/T/scratch.log',
        'private var: /private/var/folders/ab/xyz123/T/scratch.log',
        'mnt: /mnt/c/Users/serhii/file.ts',
      ].join(' | ');
      const note = composeNote({ ticket: 'RP-1', stop: 'escalation', diagnosis });
      const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
      expect(line).not.toMatch(/\/root\/secrets/);
      expect(line).not.toMatch(/\/var\/folders/);
      expect(line).not.toMatch(/\/private\/var/);
      expect(line).not.toMatch(/\/mnt\/c\/Users/);
      expect((line.match(/\[path\]/g) ?? []).length).toBe(4);
    });

    it('leaves a URL untouched even though its path segment looks like an absolute POSIX path', async () => {
      const { composeNote } = (await load('continuation.mjs')) as {
        composeNote: (input: Record<string, unknown>) => string;
      };
      const note = composeNote({
        ticket: 'RP-1',
        stop: 'escalation',
        diagnosis: 'see https://example.invalid/a/b for details',
      });
      const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
      expect(line).toBe('diagnosis: see https://example.invalid/a/b for details');
    });
  });
});

// --- readRunEvidence -----------------------------------------------------

// RP-224 round 2 — code-reviewer r1 HOLD (checklist item 6, continuation.mjs:218):
// "last decision of any kind, not the latest checked verdict". The three
// writers `lib/gate-coverage.mjs` already names are what a real run leaves
// behind — the router's `review-routing:<lane>` line, `pr-ship`'s
// `reviewer-fan-out` line (the set it actually LAUNCHED, for which head), and
// each reviewer's own verdict journalled under its own gate name. So
// "latest-verdict" means: find the LAST `reviewer-fan-out` decision, then
// report every verdict journalled under one of ITS reviewer names, after it
// — never `item-selection`, `review-routing:*`, or a verdict from a round
// before the latest fan-out. This is the same journal `coverageOf` reads
// (`lib/gate-coverage.mjs`), so these fixtures use the same record shapes.
describe('readRunEvidence — the latest REVIEW ROUND, not the last decision of any kind', () => {
  const HEAD_NEW = '1234567890abcdef1234567890abcdef12345678';
  const HEAD_OLD = 'abcdef1234567890abcdef1234567890abcdef12';

  it('reports every reviewer verdict journalled after the latest reviewer-fan-out, ignoring item-selection and review-routing records', async () => {
    const { readRunEvidence } = await load('continuation.mjs');
    const { recordDecision } = await load('run-journal.mjs');
    const runDir = await mkdtemp(path.join(tmpdir(), 'continuation-run-'));
    let t = 0;
    const now = () => new Date(2026, 0, 1, 0, 0, (t += 1)).toISOString();

    recordDecision({ runDir, gate: 'item-selection', verdict: 'RP-1', now: now() });
    recordDecision({
      runDir,
      gate: 'review-routing:model',
      verdict: 'route',
      reviewers: ['code-reviewer', 'prose-reviewer'],
      now: now(),
    });
    recordDecision({
      runDir,
      gate: 'reviewer-fan-out',
      verdict: 'launched',
      reviewers: ['code-reviewer', 'prose-reviewer'],
      headSha: HEAD_NEW,
      now: now(),
    });
    recordDecision({
      runDir,
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: [{ rule: 'workflow.md#tests', note: 'missing a test' }],
      headSha: HEAD_NEW,
      now: now(),
    });
    // A second selection and a second routing line, both AFTER the verdict —
    // neither is a reviewer verdict, and neither belongs to this round.
    recordDecision({ runDir, gate: 'item-selection', verdict: 'RP-2', now: now() });
    recordDecision({
      runDir,
      gate: 'review-routing:model',
      verdict: 'route',
      reviewers: ['someone-else'],
      now: now(),
    });
    recordDecision({
      runDir,
      gate: 'prose-reviewer',
      verdict: 'SHIP',
      blockers: [],
      headSha: HEAD_NEW,
      now: now(),
    });

    expect(readRunEvidence(runDir)).toEqual({
      headSha: HEAD_NEW,
      reviewers: [
        { gate: 'code-reviewer', verdict: 'HOLD', blockers: ['workflow.md#tests'] },
        { gate: 'prose-reviewer', verdict: 'SHIP', blockers: [] },
      ],
    });
  });

  it('reports both reviewers when one HOLDs and another SHIPs, the HOLD carrying its blocker rule names', async () => {
    const { readRunEvidence } = await load('continuation.mjs');
    const { recordDecision } = await load('run-journal.mjs');
    const runDir = await mkdtemp(path.join(tmpdir(), 'continuation-run-'));
    let t = 0;
    const now = () => new Date(2026, 0, 1, 0, 0, (t += 1)).toISOString();

    recordDecision({
      runDir,
      gate: 'reviewer-fan-out',
      verdict: 'launched',
      reviewers: ['security-scanner', 'code-reviewer'],
      headSha: HEAD_NEW,
      now: now(),
    });
    recordDecision({
      runDir,
      gate: 'security-scanner',
      verdict: 'SHIP',
      blockers: [],
      headSha: HEAD_NEW,
      now: now(),
    });
    recordDecision({
      runDir,
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: [
        { rule: 'workflow.md#tests', note: 'missing a test' },
        { rule: 'autonomy.md#never', note: 'force push' },
      ],
      headSha: HEAD_NEW,
      now: now(),
    });

    expect(readRunEvidence(runDir)).toEqual({
      headSha: HEAD_NEW,
      reviewers: [
        { gate: 'security-scanner', verdict: 'SHIP', blockers: [] },
        {
          gate: 'code-reviewer',
          verdict: 'HOLD',
          blockers: ['workflow.md#tests', 'autonomy.md#never'],
        },
      ],
    });
  });

  it('does not report a verdict from an older round once a newer fan-out has run', async () => {
    const { readRunEvidence } = await load('continuation.mjs');
    const { recordDecision } = await load('run-journal.mjs');
    const runDir = await mkdtemp(path.join(tmpdir(), 'continuation-run-'));
    let t = 0;
    const now = () => new Date(2026, 0, 1, 0, 0, (t += 1)).toISOString();

    recordDecision({
      runDir,
      gate: 'reviewer-fan-out',
      verdict: 'launched',
      reviewers: ['code-reviewer'],
      headSha: HEAD_OLD,
      now: now(),
    });
    recordDecision({
      runDir,
      gate: 'code-reviewer',
      verdict: 'HOLD',
      blockers: [{ rule: 'old-round-rule', note: 'fixed since' }],
      headSha: HEAD_OLD,
      now: now(),
    });
    // The branch was re-gated for a newer head; this round's reviewer has not
    // answered yet. The OLD HOLD above must not leak through as "the latest".
    recordDecision({
      runDir,
      gate: 'reviewer-fan-out',
      verdict: 'launched',
      reviewers: ['prose-reviewer'],
      headSha: HEAD_NEW,
      now: now(),
    });

    expect(readRunEvidence(runDir)).toEqual({ headSha: HEAD_NEW, reviewers: [] });
  });

  it('returns nulls (never a throw) when the run directory does not exist', async () => {
    const { readRunEvidence } = await load('continuation.mjs');
    const missing = path.join(tmpdir(), 'continuation-run-does-not-exist', String(Date.now()));
    expect(readRunEvidence(missing)).toEqual({ headSha: null, reviewers: [] });
  });

  it('returns nulls when the run directory carries no fan-out at all', async () => {
    const { readRunEvidence } = await load('continuation.mjs');
    const runDir = await mkdtemp(path.join(tmpdir(), 'continuation-run-empty-'));
    expect(readRunEvidence(runDir)).toEqual({ headSha: null, reviewers: [] });
  });
});

// --- CLI -------------------------------------------------------------------

describe('continuation.mjs CLI', () => {
  const BRANCH = 'feat/rp-1-continuation-cli';

  const freshRepo = async (): Promise<{ repoDir: string; headSha: string }> => {
    const repoDir = await mkdtemp(path.join(tmpdir(), 'continuation-repo-'));
    await git(['init', '-q'], repoDir);
    await git(['checkout', '-q', '-b', BRANCH], repoDir);
    await writeFile(path.join(repoDir, 'a.txt'), 'x\n');
    await git(['add', '-A'], repoDir);
    await git(['commit', '-q', '-m', 'init'], repoDir);
    const headSha = await git(['rev-parse', 'HEAD'], repoDir);
    return { repoDir, headSha };
  };

  it('prints ticket, stop, branch and head gathered from the checkout, and reports gate rounds as unknown — never 0 — with no counter entry for this branch', async () => {
    const { repoDir, headSha } = await freshRepo();
    const result = await runCli(repoDir, ['--ticket', 'RP-1', '--stop', 'pause'], hermeticEnv());
    expect(result.code, result.out).toBe(0);
    expect(result.stdout).toContain('ticket: RP-1');
    expect(result.stdout).toContain('stop: pause');
    expect(result.stdout).toContain(`branch: ${BRANCH}`);
    expect(result.stdout).toContain(`head: ${headSha}`);
    // RP-224 round 2 — task spec: "gate rounds are labelled as local ...
    // when this checkout has no counter entry for the branch → unknown,
    // never 0". `gateRoundsFor` already answers 0 for "no entry at all" (it
    // can never observe a genuine, journalled 0 — the counter file only ever
    // holds positive integers), so a bare `0` on this line is always the
    // absent-entry case wearing the wrong word.
    expect(result.stdout).toContain('gate-rounds-this-checkout: unknown');
    expect(result.stdout).not.toContain('gate-rounds-this-checkout: 0');
  });

  it('reports the gate rounds already counted for this branch in this checkout', async () => {
    const { repoDir } = await freshRepo();
    await mkdir(path.join(repoDir, '.claude'), { recursive: true });
    const { recordGateRound } = await loadQueue('gate-rounds.mjs');
    recordGateRound({ branch: BRANCH, projectRoot: repoDir });
    recordGateRound({ branch: BRANCH, projectRoot: repoDir });

    const result = await runCli(repoDir, ['--ticket', 'RP-1', '--stop', 'blocker'], hermeticEnv());
    expect(result.code, result.out).toBe(0);
    expect(result.stdout).toContain('gate-rounds-this-checkout: 2');
  });

  it('includes the latest review-round verdict from RIG_RUN_DIR when one is declared', async () => {
    const { repoDir, headSha } = await freshRepo();
    const runDir = await mkdtemp(path.join(tmpdir(), 'continuation-run-cli-'));
    const { recordDecision } = await load('run-journal.mjs');
    let t = 0;
    const now = () => new Date(2026, 0, 1, 0, 0, (t += 1)).toISOString();
    recordDecision({
      runDir,
      gate: 'reviewer-fan-out',
      verdict: 'launched',
      reviewers: ['pr-ship'],
      headSha,
      now: now(),
    });
    recordDecision({
      runDir,
      gate: 'pr-ship',
      verdict: 'HOLD',
      blockers: [{ rule: 'workflow.md#pr-flow', note: 'x' }],
      headSha,
      now: now(),
    });

    const result = await runCli(
      repoDir,
      ['--ticket', 'RP-1', '--stop', 'escalation'],
      hermeticEnv({ RIG_RUN_DIR: runDir }),
    );
    expect(result.code, result.out).toBe(0);
    expect(result.stdout).toContain(
      `latest-verdict: pr-ship HOLD (workflow.md#pr-flow) @ ${headSha.slice(0, 7)}`,
    );
  });

  // RP-224 round 2 — task spec item 4: "a token-shaped --pr value, built at
  // runtime from pieces as the existing fixtures do, is redacted". `--pr` is
  // free text on the CLI, same as `--diagnosis`/`--remaining` — a value
  // typed there that happens to look like a live credential must not reach
  // stdout, or a posted comment, unredacted.
  it('redacts a credential-shaped --pr value, assembled at runtime like every other fixture in this suite', async () => {
    const { repoDir } = await freshRepo();
    const result = await runCli(
      repoDir,
      ['--ticket', 'RP-1', '--stop', 'pause', '--pr', GITHUB_PAT],
      hermeticEnv(),
    );
    expect(result.code, result.out).toBe(0);
    expect(result.stdout).toContain('pr: [redacted]');
    expect(result.stdout).not.toContain(GITHUB_PAT);
  });

  // RP-224 round 2 — task spec item 5: `--ticket` must match a tracker-key
  // or bare-number shape before it is used for anything, including a
  // `--post`. An unvalidated ticket is a value this module later interpolates
  // into an adapter call (`comment({ id: ticket }, ...)`); refusing early is
  // cheaper than trusting whatever a caller (or a scripted retry) supplies.
  it('refuses a --ticket value that is neither a tracker-key nor a bare-number shape, before any adapter call', async () => {
    const { repoDir } = await freshRepo();
    await mkdir(path.join(repoDir, '.claude'), { recursive: true });
    await writeFile(
      path.join(repoDir, '.claude', 'queue.json'),
      JSON.stringify({ adapter: 'jira' }),
    );
    const env = hermeticEnv();
    delete env.JIRA_BASE_URL;
    delete env.JIRA_EMAIL;
    delete env.JIRA_API_TOKEN;

    const result = await runCli(
      repoDir,
      ['--ticket', '/etc/passwd', '--stop', 'pause', '--post'],
      env,
    );
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/ticket/i);
    // If the CLI had validated nothing, it would reach the jira adapter's
    // own refusal (missing JIRA_BASE_URL) — the same independent proof the
    // "never touches the network" test below relies on.
    expect(result.out).not.toMatch(/JIRA_BASE_URL/);
  });

  it('scrubs the --diagnosis argument through the same rules composeNote pins', async () => {
    const { repoDir } = await freshRepo();
    const result = await runCli(
      repoDir,
      ['--ticket', 'RP-1', '--stop', 'pause', '--diagnosis', 'fails at /tmp/scratch/out.log'],
      hermeticEnv(),
    );
    expect(result.code, result.out).toBe(0);
    expect(result.stdout).toContain('diagnosis: fails at [path]');
    expect(result.stdout).not.toContain('/tmp/scratch');
  });

  it('refuses an unknown --stop value', async () => {
    const { repoDir } = await freshRepo();
    const result = await runCli(repoDir, ['--ticket', 'RP-1', '--stop', 'confused'], hermeticEnv());
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/stop/i);
  });

  it('refuses a missing --ticket', async () => {
    const { repoDir } = await freshRepo();
    const result = await runCli(repoDir, ['--stop', 'pause'], hermeticEnv());
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/ticket/i);
  });

  it('without --post, never touches the network — no adapter call is made', async () => {
    const { repoDir } = await freshRepo();
    await mkdir(path.join(repoDir, '.claude'), { recursive: true });
    await writeFile(
      path.join(repoDir, '.claude', 'queue.json'),
      JSON.stringify({ adapter: 'jira' }),
    );
    const env = hermeticEnv();
    delete env.JIRA_BASE_URL;
    delete env.JIRA_EMAIL;
    delete env.JIRA_API_TOKEN;

    const result = await runCli(repoDir, ['--ticket', 'RP-1', '--stop', 'pause'], env);
    // If the CLI had attempted to post through the jira adapter with no
    // --post, `comment()` would fail immediately because the jira adapter's
    // own `request()` refuses with no JIRA_BASE_URL/EMAIL/TOKEN — that
    // refusal message is the independent proof that no attempt was made.
    expect(result.code, result.out).toBe(0);
    expect(result.out).not.toMatch(/JIRA_BASE_URL/);
    expect(result.out).not.toMatch(/JIRA_API_TOKEN/);
  });

  it('--post on the plan-md adapter refuses to post, and still prints the note', async () => {
    const { repoDir } = await freshRepo();
    const result = await runCli(
      repoDir,
      ['--ticket', 'RP-1', '--stop', 'pause', '--post'],
      hermeticEnv(),
    );
    expect(result.code).not.toBe(0);
    expect(result.out).toContain('rig-continuation v1');
    expect(result.out).toMatch(/journal/i);
  });
});

// --- wired into the workflow layer -----------------------------------------

describe('continuation.mjs is wired into the workflow layer', () => {
  it('layers.json lists the script under the workflow array', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(universalDir, 'layers.json'), 'utf8'),
    ) as Record<string, string[]>;
    expect(manifest['workflow']).toContain('.claude/scripts/continuation.mjs');
  });

  it('the loop skill names continuation.mjs and each of the four stop kinds', async () => {
    const content = await readFile(skillPath('loop'), 'utf8');
    expect(content).toMatch(/continuation\.mjs/);
    for (const kind of ['escalation', 'blocker', 'pause', 'terminated']) {
      expect(
        content,
        `loop/SKILL.md does not mention the stop kind "${kind}" near continuation.mjs`,
      ).toMatch(new RegExp(`\\b${kind}\\b`, 'i'));
    }
  });

  // RP-224 round 2 — code-reviewer r1 advisory: "loose regex in the skill
  // test". `/not\b[^.]{0,160}\b(stop|round)\b/is` over an 2800-char window
  // does not pin the four-stop-exclusion sentence specifically — that window
  // spans §6's own stop-rule prose and §7's run-end-marker prose, both dense
  // with unrelated "not ... stop" text, so the assertion could stay green
  // against a rewritten §6a that dropped the caveat, as long as SOME other
  // "not"-near-"stop" sentence still fell inside the slice. Pinned as an
  // exact, whitespace-normalised sentence instead — a real oracle: it names
  // the actual current wording, once, rather than a shape wide enough to
  // match text this test was never written to check.
  it('the loop skill states, in this exact sentence, that continuation.mjs is not run on an ordinary Claude Stop, a subagent stop, or a review round', async () => {
    const content = await readFile(skillPath('loop'), 'utf8');
    const normalized = content.replace(/\s+/g, ' ');
    expect(normalized).toContain(
      'It is deliberately **not** invoked on every ordinary Claude Stop, a subagent ' +
        'stop, or a review round — those are technical checkpoints internal to this ' +
        'session, not one of the four workflow-level stops above, and running it on ' +
        'each one would turn a rare, durable note into routine noise nobody reads.',
    );
  });

  // RP-224 round 2 — code-reviewer r1 HOLD (checklist item 6,
  // SKILL.md:805/prose-reviewer item 3): "escalation procedure never invokes
  // continuation.mjs; blocker pause terminated have no procedure anchor".
  // §6a today only introduces the four kinds together, in one summary
  // sentence, next to the CLI's own usage synopsis — it never says the
  // escalation procedure (§6) itself runs the command, and it never gives
  // blocker/pause/terminated their OWN concrete "run it here" moment outside
  // that shared sentence.

  it('the §6 escalation procedure itself runs continuation.mjs --stop escalation --post, as one of its numbered steps', async () => {
    const content = await readFile(skillPath('loop'), 'utf8');
    const start = content.indexOf('## 6. Escalation');
    expect(start, '"## 6. Escalation" heading not found').toBeGreaterThan(-1);
    const end = content.indexOf('## 6a. Continuation notes', start);
    expect(end, '"## 6a. Continuation notes" heading not found after §6').toBeGreaterThan(-1);
    const escalationSection = content.slice(start, end);
    expect(escalationSection, '§6 does not mention continuation.mjs at all').toMatch(
      /continuation\.mjs/,
    );
    expect(escalationSection, '§6 does not run --stop escalation').toMatch(/--stop\s+escalation/);
    expect(escalationSection, '§6 does not pass --post').toMatch(/--post/);
  });

  // For blocker/pause/terminated: the shared summary sentence in §6a names
  // all four kinds together right next to its one inline `--post` mention —
  // a proximity check with no more care than that would already pass today,
  // for the wrong reason (that one shared sentence, not a concrete per-kind
  // moment). So a window only counts when it is NOT also that summary
  // sentence — i.e. it does not additionally carry the other three kind
  // words — forcing a genuinely separate, kind-specific mention.
  const stripFencedCode = (text: string): string => text.replace(/```[\s\S]*?```/g, '');
  const OTHER_STOP_KINDS: Record<string, string[]> = {
    blocker: ['escalation', 'pause', 'terminated'],
    pause: ['escalation', 'blocker', 'terminated'],
    terminated: ['escalation', 'blocker', 'pause'],
  };

  for (const kind of ['blocker', 'pause', 'terminated']) {
    it(`names a concrete moment, in its own prose (not the four-kind summary sentence), to run continuation.mjs --post for a "${kind}" stop`, async () => {
      const content = await readFile(skillPath('loop'), 'utf8');
      const prose = stripFencedCode(content);
      const wordRe = new RegExp(`\\b${kind}\\b`, 'gi');
      const indices: number[] = [];
      let match: RegExpExecArray | null;
      while ((match = wordRe.exec(prose))) indices.push(match.index);
      expect(
        indices.length,
        `"${kind}" is not mentioned anywhere in loop/SKILL.md prose`,
      ).toBeGreaterThan(0);

      const hasOwnMoment = indices.some((idx) => {
        const windowText = prose.slice(Math.max(0, idx - 300), idx + 300);
        const mentionsPost = /--post/.test(windowText);
        const isSharedSummarySentence = OTHER_STOP_KINDS[kind]!.every((other) =>
          new RegExp(`\\b${other}\\b`, 'i').test(windowText),
        );
        return mentionsPost && !isSharedSummarySentence;
      });
      expect(
        hasOwnMoment,
        `every "${kind}" mention within 300 chars of --post is the shared four-kind ` +
          'summary sentence in §6a — there is no separate, kind-specific moment stated.',
      ).toBe(true);
    });
  }
});
