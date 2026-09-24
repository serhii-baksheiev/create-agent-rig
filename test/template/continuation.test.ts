import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GITHUB_PAT, pemHeader } from './secrets-fixtures.js';

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

  // RP-224 round 2 — reviewers (advisory, now fixed): `head`, `gateRounds`
  // and a reviewer's verdict WORD were the three values `composeNote` wrote
  // to the note without running them through `collapseNewlines`/`scrubPaths`/
  // `redactSecrets` at all — so a forged `\nhead: …` inside any one of them
  // rendered as a literal second `head:` line, exactly the forgery the
  // diagnosis/remaining tests above already guard against for those two
  // fields. `headSha` and `gateRounds` are ordinarily produced by this
  // module's own CLI (`git rev-parse`, `gateRoundsFor`), and a reviewer's
  // verdict word is ordinarily one of a small fixed vocabulary — but
  // `composeNote` is a public function that accepts whatever its caller
  // hands it, and nothing about its shape refuses a hostile string today.

  it('collapses an embedded newline in headSha so it cannot forge a second head: line', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      headSha: 'deadbeef\nhead: forged',
    });
    const headLines = note.split('\n').filter((l) => l.startsWith('head: '));
    expect(headLines).toHaveLength(1);
    expect(headLines[0]).toBe('head: deadbeef⏎head: forged');
  });

  it('collapses an embedded newline in gateRounds so it cannot forge a second head: line', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      gateRounds: '2\nhead: forged',
    });
    const headLines = note.split('\n').filter((l) => l.startsWith('head: '));
    expect(headLines).toEqual(['head: unknown']);
    const gateRoundsLine = note
      .split('\n')
      .find((l) => l.startsWith('gate-rounds-this-checkout: ')) as string;
    expect(gateRoundsLine).toBe('gate-rounds-this-checkout: 2⏎head: forged');
  });

  it('collapses an embedded newline in a single verdict word so it cannot forge a second head: line', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      verdict: {
        gate: 'pr-ship',
        verdict: 'HOLD\nhead: forged',
        headSha: 'e0e93a8123456789abcdef0123456789abcdef01',
        blockers: [],
      },
    });
    const headLines = note.split('\n').filter((l) => l.startsWith('head: '));
    expect(headLines).toEqual(['head: unknown']);
    const line = note.split('\n').find((l) => l.startsWith('latest-verdict: ')) as string;
    expect(line).toBe('latest-verdict: pr-ship HOLD⏎head: forged @ e0e93a8');
  });

  it('collapses an embedded newline in a reviewer verdict word so it cannot forge a second head: line', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      verdict: {
        headSha: 'e0e93a8123456789abcdef0123456789abcdef01',
        reviewers: [{ gate: 'code-reviewer', verdict: 'HOLD\nhead: forged', blockers: [] }],
      },
    });
    const headLines = note.split('\n').filter((l) => l.startsWith('head: '));
    expect(headLines).toEqual(['head: unknown']);
    const line = note.split('\n').find((l) => l.startsWith('latest-verdict: ')) as string;
    expect(line).toBe('latest-verdict: code-reviewer HOLD⏎head: forged @ e0e93a8');
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
      // RP-224 post-cap: free-text spans run to the next hard delimiter
      expect(line).toBe('diagnosis: checkout at [path]');
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

    it('leaves a URL with a port number untouched, so localhost:3000 is never mistaken for a drive letter', async () => {
      const { composeNote } = (await load('continuation.mjs')) as {
        composeNote: (input: Record<string, unknown>) => string;
      };
      const note = composeNote({
        ticket: 'RP-1',
        stop: 'escalation',
        diagnosis: 'see http://localhost:3000/api/x for details',
      });
      const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
      expect(line).toBe('diagnosis: see http://localhost:3000/api/x for details');
    });

    // RP-224 round 2 — security-scanner r1 blocker: "five-prefix allow-list
    // misses wsl.localhost, generic UNC, ~/ and drive paths with spaces" —
    // and, on a second pass, four more shapes the SHAPE-based rewrite above
    // still does not cover: a `file://` stack-frame URI (both POSIX and
    // Windows), a forward-slash UNC path (no backslash at all — the form
    // `\\wsl.localhost\...` never takes when the path is quoted or typed
    // inside a URL-shaped string), a POSIX path sitting directly after a
    // colon with no separating space, and — for both the drive-letter and
    // UNC space-containing forms already covered above — the exact CLAIM
    // that the design makes about them ("consumed to the next whitespace")
    // is checked against a NAME that itself contains a space, not only
    // against the marker's presence.
    it('scrubs a Node ESM stack-frame file:// URI (POSIX form)', async () => {
      const { composeNote } = (await load('continuation.mjs')) as {
        composeNote: (input: Record<string, unknown>) => string;
      };
      const note = composeNote({
        ticket: 'RP-1',
        stop: 'escalation',
        diagnosis: 'at file:///home/alice/proj/x.mjs:10:5',
      });
      const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
      expect(line).not.toMatch(/alice/);
      expect(line).toContain('[path]');
    });

    it('scrubs a Node ESM stack-frame file:// URI (Windows drive-letter form)', async () => {
      const { composeNote } = (await load('continuation.mjs')) as {
        composeNote: (input: Record<string, unknown>) => string;
      };
      const note = composeNote({
        ticket: 'RP-1',
        stop: 'escalation',
        diagnosis: 'at file:///C:/Users/alice/x.mjs:10:5',
      });
      const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
      expect(line).not.toMatch(/alice/);
      expect(line).toContain('[path]');
    });

    it('scrubs a forward-slash UNC path (//wsl.localhost/...), not only the backslash form', async () => {
      const { composeNote } = (await load('continuation.mjs')) as {
        composeNote: (input: Record<string, unknown>) => string;
      };
      const note = composeNote({
        ticket: 'RP-1',
        stop: 'escalation',
        diagnosis: 'checkout at //wsl.localhost/Ubuntu/home/alice/x done',
      });
      const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
      expect(line).not.toMatch(/alice/);
      expect(line).toContain('[path]');
    });

    it('scrubs a forward-slash UNC path to a generic server share', async () => {
      const { composeNote } = (await load('continuation.mjs')) as {
        composeNote: (input: Record<string, unknown>) => string;
      };
      const note = composeNote({
        ticket: 'RP-1',
        stop: 'escalation',
        diagnosis: 'checkout at //server/share/alice/x done',
      });
      const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
      expect(line).not.toMatch(/alice/);
      expect(line).toContain('[path]');
    });

    it('scrubs a POSIX path that sits directly after a colon with no separating space', async () => {
      const { composeNote } = (await load('continuation.mjs')) as {
        composeNote: (input: Record<string, unknown>) => string;
      };
      const note = composeNote({
        ticket: 'RP-1',
        stop: 'escalation',
        diagnosis: 'moved to label:/home/alice/x already',
      });
      const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
      expect(line).not.toMatch(/alice/);
      expect(line).toContain('[path]');
    });

    it('does not leave the tail of a space-containing POSIX path behind after the scrubbed prefix', async () => {
      const { composeNote } = (await load('continuation.mjs')) as {
        composeNote: (input: Record<string, unknown>) => string;
      };
      const note = composeNote({
        ticket: 'RP-1',
        stop: 'escalation',
        diagnosis: 'failed at /mnt/c/Users/First Last/proj/x',
      });
      const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
      expect(line).not.toMatch(/First/);
      expect(line).not.toMatch(/Last/);
      expect(line).toContain('[path]');
    });

    it('does not leave the tail of a space-containing UNC path behind after the scrubbed prefix', async () => {
      const { composeNote } = (await load('continuation.mjs')) as {
        composeNote: (input: Record<string, unknown>) => string;
      };
      const note = composeNote({
        ticket: 'RP-1',
        stop: 'escalation',
        diagnosis: 'failed at \\\\server\\share\\First Last\\x',
      });
      const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
      expect(line).not.toMatch(/First/);
      expect(line).not.toMatch(/Last/);
      expect(line).toContain('[path]');
    });
  });

  // RP-224 round 2 — security-scanner r1 blocker (checklist item 4,
  // continuation.mjs:173): "the optional `label:` prefix backtracks
  // quadratically" — `UNC_PATH`'s `(?:[^\s:]+:\s+)?` group has to try, and
  // fail to find a colon, from every position of a long colon-less run
  // before giving up; measured directly against UNC_PATH alone (not through
  // composeNote), 'x'.repeat(40_000) took ~1.9s on this host — close to the
  // reviewers' own reported 1.7s at 40k — and 'x'.repeat(150_000) took
  // ~21.1s. The module header's claim that each pass is "a linear scan" is
  // false for this one, and the per-field/whole-note caps do not help: both
  // are applied AFTER scrubPaths runs over the full, uncapped field.
  describe('bounding an oversized field BEFORE any scrub pass', () => {
    // A secret this deep inside an oversized field already cannot reach the
    // final note today — the existing 500/2000-character caps happen to cut
    // it off first — so this pins the SAFE outcome (never leaked, note
    // still capped) rather than a regression. What it also proves, by its
    // own 5s bound, is that composeNote does not get there quickly: on this
    // host, composeNote({ diagnosis: <220,000-char field of this shape> })
    // measured ~50.7s to even return (see the wall-clock test right below
    // for the same number, asserted directly). Five seconds is comfortably
    // short of that, so a session reading a red run here does not have to
    // wait out the whole thing to see why it failed.
    it(
      'never lets a secret buried past the first few thousand characters of an oversized field reach the note',
      { timeout: 5_000 },
      async () => {
        const { composeNote } = (await load('continuation.mjs')) as {
          composeNote: (input: Record<string, unknown>) => string;
        };
        const before = 'x'.repeat(5000);
        const filler = 'x'.repeat(220000 - 5000 - GITHUB_PAT.length);
        const diagnosis = `${before}${GITHUB_PAT}${filler}`;
        const note = composeNote({ ticket: 'RP-1', stop: 'escalation', diagnosis });
        expect(note).not.toContain(GITHUB_PAT);
        expect(note.length).toBeLessThanOrEqual(2000);
      },
    );

    // The one wall-clock assertion in this file (see the module header's own
    // "Prefer a deterministic oracle" note in the task this suite pins):
    // composeNote on this shape must complete in well under a generous
    // 2000ms bound. RP-224 round 3 — code-reviewer r3 advisory A7: this
    // test's name used to say "backtracks quadratically today", which went
    // stale the round the bounded-work fix landed (round-3 code-reviewer:
    // "Bounded work: FIXED") — the shape no longer backtracks, so the name is
    // now stated as a bound, not a claim about current behaviour. Measured
    // historically (pre-fix) on this host: UNC_PATH alone on
    // 'x'.repeat(40_000) ~1.9s, 'x'.repeat(150_000) ~21.1s, 'x'.repeat(220_000)
    // ~38.4-44.2s; through the FULL composeNote (diagnosis: 'x'.repeat(220_000))
    // ~50.7s — over 25x the 2000ms bound asserted below, clearing the "at
    // least 20x" mark this suite was asked to hit with room to spare.
    it(
      'completes well under a generous bound on a 220,000-character field, the shape that once risked catastrophic backtracking',
      { timeout: 90_000 },
      async () => {
        const { composeNote } = (await load('continuation.mjs')) as {
          composeNote: (input: Record<string, unknown>) => string;
        };
        const diagnosis = 'x'.repeat(220000);
        const start = process.hrtime.bigint();
        const note = composeNote({ ticket: 'RP-1', stop: 'escalation', diagnosis });
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
        expect(note.length).toBeGreaterThan(0);
        expect(elapsedMs).toBeLessThan(2000);
      },
    );
  });
});

// RP-224 round 4 — owner-delegated continuation of the round-3 HOLDs
// (code-reviewer r3 B1/B2, security-scanner r3 BLOCKER 1/BLOCKER 2). The
// per-shape allow-list approach is retired in favour of five coarser rules,
// stated in full where they are implemented (module header, not restated
// here):
//
//   (a) FREE-TEXT fields (diagnosis, remaining): any whitespace-delimited
//       token containing `/` or `\`, or starting with `~`, that is not an
//       http(s) URL, starts a scrubbed span running to the next hard
//       delimiter or end of field.
//   (b) STRUCTURED fields (branch, pr, gate names, blocker rule names,
//       ticket): the existing six-shape scrub, extended so mixed-slash UNC
//       (`\\host/share/...`, `//host\share\...`) scrubs too.
//   (c) A field in which `lib/secrets.mjs`'s `findSecretValues` finds ANY
//       credential (checked on the raw value up to RAW_FIELD_CAP + 128
//       characters) is replaced AS A WHOLE by `[redacted]` — never a partial
//       redaction.
//   (d) `verdict.headSha` goes through the same four-step pipeline as every
//       other field before `shortShaOf` slices it.
//   (e) U+2028, U+2029 and U+0085 collapse like `\r`/`\n`.
//
// None of rules (a)-(e) are implemented yet — every test below is expected
// to fail against the current `continuation.mjs`, for the leak/contract-drift
// reason named in its own comment, not for an unrelated one.
describe('RP-224 round 4 — coarse free-text path scrub, whole-field secret redaction, verdict.headSha pipeline, and extended line-terminator collapse', () => {
  // --- rule (a): free-text fields scrub any / or \ or ~ token, coarsely ---

  it('scrubs a mixed-slash UNC path in diagnosis (backslash host, forward-slash tail) while leaving adjacent URLs intact — code-reviewer r3 B1', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const diagnosis = [
      'checkout at \\\\wsl.localhost/Ubuntu/home/alice/x',
      'see https://example.invalid/a/b',
      'and https://github.com/o/r/pull/319',
    ].join(' | ');
    const note = composeNote({ ticket: 'RP-1', stop: 'escalation', diagnosis });
    const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
    expect(line).not.toMatch(/alice/);
    expect(line).toContain('[path]');
    expect(line).toContain('https://example.invalid/a/b');
    expect(line).toContain('https://github.com/o/r/pull/319');
  });

  it('scrubs a drive-less rooted Windows path in diagnosis (\\Users\\alice\\x — advisory A3)', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      diagnosis: 'log at \\Users\\alice\\x saved',
    });
    const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
    expect(line).not.toMatch(/alice/);
    expect(line).toContain('[path]');
  });

  it('scrubs a tilde-prefixed path that names a user directly, not only ~/ (~alice/x — advisory A3)', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      diagnosis: 'seen at ~alice/x recently',
    });
    const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
    expect(line).not.toMatch(/alice/);
    expect(line).toContain('[path]');
  });

  it('scrubs a tilde-prefixed path using a backslash separator (~\\x — advisory A3)', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      diagnosis: 'output at ~\\x done',
    });
    const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
    expect(line).not.toContain('~\\x');
    expect(line).toContain('[path]');
  });

  it('scrubs an smb:// path, which is not an http(s) URL (advisory A3)', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      diagnosis: 'mounted at smb://host/alice/x now',
    });
    const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
    expect(line).not.toMatch(/alice/);
    expect(line).toContain('[path]');
  });

  it('scrubs a vscode-remote:// URI, which is not an http(s) URL (advisory A3)', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      diagnosis: 'open in vscode-remote://ssh-remote+h/home/alice/x please',
    });
    const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
    expect(line).not.toMatch(/alice/);
    expect(line).toContain('[path]');
  });

  it('scrubs a tilde-prefixed path with an embedded space, consuming both words of a two-word name (advisory A2: neither First nor Last survives)', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      diagnosis: 'working in ~/proj/First Last/x now',
    });
    const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
    expect(line).not.toMatch(/First/);
    expect(line).not.toMatch(/Last/);
    expect(line).toContain('[path]');
  });

  it('scrubs a drive-letter path in diagnosis even when a digit sits directly before the drive letter (9C:\\Users\\alice — advisory A3)', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      diagnosis: 'crashed near 9C:\\Users\\alice today',
    });
    const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
    expect(line).not.toMatch(/alice/);
    expect(line).not.toContain('9C:\\Users');
    expect(line).toContain('[path]');
  });

  // --- rule (b): structured fields, extended for mixed-slash UNC ---

  it('scrubs a mixed-slash UNC path in the branch field (forward-slash host, backslash tail) — code-reviewer r3 B1', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'pause',
      branch: '//server\\share\\alice\\weird-branch',
    });
    const line = note.split('\n').find((l) => l.startsWith('branch: ')) as string;
    expect(line).not.toMatch(/alice/);
    expect(line).toBe('branch: [path]');
  });

  // --- rule (c): whole-field redaction, no partial leak of a credential ---

  it('redacts a PEM private key block as a whole field, never leaking the key body — security-scanner r3 BLOCKER 1', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    // Assembled at runtime, mirroring secrets-fixtures.ts's own technique, so
    // no committable key-shaped literal sits in this file: the header comes
    // from the shared fixture helper, and the body/footer are ordinary
    // placeholder text with no credential shape of their own — only the
    // BEGIN header the private-key-block pattern actually matches.
    const pemBody = [
      'AAAAB3NzaC1yc2EAAAADAQABAAAB',
      'gQDeadbeefFAKEBASE64000111222',
      'ZZZ999xyzFAKEDATA==',
    ].join('\n');
    const diagnosis = [pemHeader(), pemBody, '-----END RSA PRIVATE KEY-----'].join('\n');
    const note = composeNote({ ticket: 'RP-1', stop: 'escalation', diagnosis });
    expect(note).not.toMatch(/AAAAB3NzaC1yc2E/);
    expect(note).not.toMatch(/FAKEBASE64/);
    expect(note).not.toMatch(/BEGIN RSA PRIVATE KEY/);
    const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
    expect(line).toBe('diagnosis: [redacted]');
  });

  it('redacts the whole field when a real credential value sits behind a rejected all-letters keyword match — security-scanner r3 BLOCKER 2', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    // A generic 16+ character alphanumeric value, assembled from short
    // pieces at runtime so no contiguous matchable run sits in source (the
    // same technique secrets-fixtures.ts uses) — chosen so it does NOT match
    // any of the other, prefix-specific SECRET_VALUE_PATTERNS, and is
    // detected ONLY via the `assigned-secret` pattern keying off "secret:"
    // — reproducing the exact shape the report names: `AtlassianApiToken`
    // ends in the credential word "Token", so a native-regex `replace` that
    // resumes past the WHOLE rejected match (rather than one character past
    // its start, the way `lib/secrets.mjs`'s own walk does) skips over that
    // embedded keyword and never finds the real assignment that follows it.
    const secretValue = ['Zq9Wx7L', 'v2Kd4Nb8', 'Mc1Pf6Rt3Hy5Ug0Jn2Bs4Dt'].join('');
    const diagnosis = `secret: AtlassianApiToken = "${secretValue}"`;
    const note = composeNote({ ticket: 'RP-1', stop: 'escalation', diagnosis });
    expect(note).not.toContain(secretValue);
    const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
    expect(line).toBe('diagnosis: [redacted]');
  });

  it('does not leave a GitHub token prefix behind when the token straddles the raw field cap — security-scanner r3 advisory 1', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    // GITHUB_PAT (40 chars) starts at offset 1970, so it spans indices
    // 1970-2009 — straddling RAW_FIELD_CAP (2000) by 10 characters. The OLD
    // capRawField cut (keep = 2000 - '[truncated]'.length = 1989) leaves only
    // the first 19 characters of the token ("ghp_a1B2c3D4e5F6g7H") in the
    // field redactSecrets ever sees — fewer than the 20 body characters
    // `github-pat` requires, so today's redactSecrets never recognises it and
    // the partial token is published. The new rule scans the raw value up to
    // RAW_FIELD_CAP + 128 = 2128 characters — comfortably past index 2009 —
    // so the FULL token is seen, detected, and the whole field withheld.
    // Word-separated filler: a token glued into an unbroken `\w` run is not a
    // token the shared vocabulary recognises anywhere (its `\b` anchor), so
    // that shape would test the vocabulary, not the cap straddle.
    const before = `${'x'.repeat(1969)} `;
    const after = ` ${'y'.repeat(199)}`;
    const diagnosis = `${before}${GITHUB_PAT}${after}`;
    const note = composeNote({ ticket: 'RP-1', stop: 'escalation', diagnosis });
    expect(note).not.toContain('ghp_');
    const line = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
    expect(line).toBe('diagnosis: [redacted]');
  });

  // --- rule (d): verdict.headSha goes through the same pipeline ---

  it('collapses an embedded newline in verdict.headSha before slicing it, so it cannot forge a second head: line — code-reviewer r3 B2', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    // The exact probe from the round-3 code-reviewer report: a top-level
    // headSha of "abc" alongside a verdict.headSha of a newline followed by
    // "head: forged". Today's shortShaOf slices the RAW verdict.headSha
    // before any collapse/scrub/redact step ever runs, so the embedded
    // newline survives into the note as a literal newline and forges a
    // second "head: " line — reported by the reviewer as
    // ["head: abc", "head: "].
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      headSha: 'abc',
      verdict: {
        gate: 'pr-ship',
        verdict: 'SHIP',
        headSha: '\nhead: forged',
        blockers: [],
      },
    });
    const headLines = note.split('\n').filter((l) => l.startsWith('head: '));
    expect(headLines).toEqual(['head: abc']);
  });

  // --- rule (e): U+2028/U+2029/U+0085 collapse like \r/\n ---

  it('collapses a U+2028 line separator in diagnosis so a multiline reader cannot see a forged head: line — security-scanner r3 advisory 3', async () => {
    const { composeNote } = (await load('continuation.mjs')) as {
      composeNote: (input: Record<string, unknown>) => string;
    };
    // `.split('\n')` alone would not reveal this forgery — U+2028 is not
    // '\n', so plain splitting on '\n' cannot tell the two implementations
    // apart. A reader that treats this note as ordinary multiline text,
    // exactly the threat the security-scanner report names ("a JS /^head:
    // /m reader splits lines on U+2028/U+2029"), does: JavaScript's `m` flag
    // treats U+2028 as a line terminator for `^`/`$`, so today's uncollapsed
    // U+2028 lets "head: deadbeef" read as its own line to such a reader.
    const note = composeNote({
      ticket: 'RP-1',
      stop: 'escalation',
      diagnosis: 'stuck\u2028head: deadbeef',
    });
    const forgedHeadLines = note.match(/^head: .*$/gm) ?? [];
    expect(forgedHeadLines).toEqual(['head: unknown']);
    const diagnosisLine = note.split('\n').find((l) => l.startsWith('diagnosis: ')) as string;
    expect(diagnosisLine).toBe('diagnosis: stuck⏎head: deadbeef');
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

  // RP-224 round 2 — reviewers (advisory, now fixed): a reviewer the latest
  // fan-out LAUNCHED but that never journalled a verdict — still running,
  // crashed, or simply not reached yet — is silently absent from
  // `reviewers` today, exactly as if it had never been launched at all. A
  // second controller reading the note cannot tell "this reviewer shipped
  // clean" apart from "this reviewer never answered" when both render the
  // same nothing.
  it('reports a launched reviewer that never journalled a verdict, instead of silently omitting it', async () => {
    const { readRunEvidence } = await load('continuation.mjs');
    const { recordDecision } = await load('run-journal.mjs');
    const runDir = await mkdtemp(path.join(tmpdir(), 'continuation-run-'));
    let t = 0;
    const now = () => new Date(2026, 0, 1, 0, 0, (t += 1)).toISOString();

    recordDecision({
      runDir,
      gate: 'reviewer-fan-out',
      verdict: 'launched',
      reviewers: ['code-reviewer', 'security-scanner'],
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
    // security-scanner was launched by the same fan-out and never answers.

    expect(readRunEvidence(runDir)).toEqual({
      headSha: HEAD_NEW,
      reviewers: [
        { gate: 'code-reviewer', verdict: 'HOLD', blockers: ['workflow.md#tests'] },
        { gate: 'security-scanner', verdict: null, blockers: [] },
      ],
    });
  });

  it('renders a launched reviewer with no verdict yet as "<gate> no-verdict" in latest-verdict', async () => {
    const { readRunEvidence, composeNote } = (await load('continuation.mjs')) as {
      readRunEvidence: (runDir: string) => unknown;
      composeNote: (input: Record<string, unknown>) => string;
    };
    const { recordDecision } = await load('run-journal.mjs');
    const runDir = await mkdtemp(path.join(tmpdir(), 'continuation-run-'));
    let t = 0;
    const now = () => new Date(2026, 0, 1, 0, 0, (t += 1)).toISOString();

    recordDecision({
      runDir,
      gate: 'reviewer-fan-out',
      verdict: 'launched',
      reviewers: ['code-reviewer', 'security-scanner'],
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

    const verdict = readRunEvidence(runDir);
    const note = composeNote({ ticket: 'RP-1', stop: 'escalation', verdict });
    const line = note.split('\n').find((l) => l.startsWith('latest-verdict: '));
    expect(line).toBe(
      `latest-verdict: code-reviewer HOLD (workflow.md#tests), security-scanner no-verdict @ ${HEAD_NEW.slice(0, 7)}`,
    );
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
