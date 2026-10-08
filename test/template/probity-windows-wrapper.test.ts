import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { gitEnv as withoutGitLocation } from '../../packages/cli/src/lib/git-env.js';
import { onlyOnWindows, skipUnless } from '../helpers/env.js';
import { removeFixture } from '../helpers/remove-fixture.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const universal = path.join(repoRoot, 'templates', 'agent-os', 'universal');
const CASE_TIMEOUT_MS = 60_000;
const WRAPPER_SAFETY_NET_TIMEOUT_MS = 20_000;
const FAKE_MARKER_ENV = 'RIG_TEST_PROBITY_WRAPPER_MARKER';
const RELAY = ' { "decision": "block", "reason": "fixture-\u0442\u0435\u0441\u0442-\u00e9" }\n';

interface WrapperResult {
  code: number;
  stderr: Buffer;
  stdout: Buffer;
}

async function probityWrapper(): Promise<string | undefined> {
  const config = JSON.parse(
    await readFile(path.join(universal, '.codex', 'hooks.json'), 'utf8'),
  ) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>>;
  };
  return Object.values(config.hooks)
    .flatMap((groups) => groups.flatMap((group) => group.hooks))
    .find((hook) => hook.command.includes('probity-gate.mjs'))
    ?.commandWindows?.match(
      /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
    )?.[1];
}

function runWrapper(
  encoded: string,
  payload: Buffer,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<WrapperResult> {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };
    const safetyTimer = setTimeout(() => {
      if (child.pid) {
        try {
          execFileSync(
            path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'],
            { stdio: 'ignore', timeout: 5_000, windowsHide: true },
          );
        } catch {
          // The child may already have exited between the timeout and taskkill.
        }
      }
      stderr.push(
        Buffer.from(`test wrapper safety net timed out after ${WRAPPER_SAFETY_NET_TIMEOUT_MS}ms\n`),
      );
      finish(1);
    }, WRAPPER_SAFETY_NET_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', () => finish(1));
    child.once('close', (code) => finish(code ?? 1));
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
  });
}

function withCp437ConsoleOutput(encoded: string): string {
  const wrapper = Buffer.from(encoded, 'base64').toString('utf16le');
  return Buffer.from(
    `[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(437); ${wrapper}`,
    'utf16le',
  ).toString('base64');
}

async function selectedProbityProject(root: string): Promise<void> {
  await exec('git', ['init', '-q', root], { env: withoutGitLocation() });
  await cp(path.join(universal, '.claude'), path.join(root, '.claude'), { recursive: true });
  await mkdir(path.join(root, '.rig'), { recursive: true });
  await writeFile(
    path.join(root, '.rig', 'integrations.json'),
    JSON.stringify({
      schemaVersion: 1,
      integrations: [{ id: 'probity', version: '1.10.1', harnesses: ['codex'], selected: true }],
    }),
  );
  const bin = path.join(root, 'node_modules', '@nizos', 'probity', 'dist');
  await mkdir(bin, { recursive: true });
  await writeFile(
    path.join(bin, 'bin.js'),
    [
      "const fs = require('node:fs');",
      `const marker = process.env.${FAKE_MARKER_ENV};`,
      'const chunks = [];',
      "process.stdin.on('data', (chunk) => chunks.push(chunk));",
      "process.stdin.on('end', () => {",
      "  fs.writeFileSync(marker, JSON.stringify({ argv: process.argv.slice(2), stdinBase64: Buffer.concat(chunks).toString('base64') }));",
      `  process.stdout.write(${JSON.stringify(RELAY)});`,
      '});',
    ].join('\n'),
  );
}

describe('the generated Windows Codex Probity wrapper preserves selected enforcement roots (RP-460)', () => {
  it(
    'forwards exact Codex input and relays the selected Probity block from an ordinary root',
    { timeout: CASE_TIMEOUT_MS },
    async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
      const root = await mkdtemp(path.join(tmpdir(), 'probity-wrapper-normal-'));
      const marker = path.join(root, 'probity-forwarded.json');
      const payload = Buffer.from(
        ` { "hook_event_name": "PreToolUse", "tool_name": "apply_patch", "tool_input": { "input": "fixture-\u0442\u0435\u0441\u0442" }, "cwd": ${JSON.stringify(root)} }\n`,
      );
      try {
        await selectedProbityProject(root);
        const encoded = await probityWrapper();
        expect(encoded).toBeDefined();
        const result = await runWrapper(encoded!, payload, root, {
          ...process.env,
          PATH: `${path.dirname(process.execPath)};${process.env.PATH ?? ''}`,
          [FAKE_MARKER_ENV]: marker,
        });
        expect(result.code, result.stderr.toString('utf8')).toBe(0);
        expect(result.stdout).toEqual(Buffer.from(RELAY));
        expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({
          argv: ['--agent', 'codex'],
          stdinBase64: payload.toString('base64'),
        });
      } finally {
        await removeFixture(root);
      }
    },
  );

  it(
    'forwards exact Codex input and relays the selected Probity block from a non-ASCII root',
    { timeout: CASE_TIMEOUT_MS },
    async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
      const root = await mkdtemp(
        path.join(tmpdir(), 'probity-wrapper-\u0442\u0435\u0441\u0442-\u00e9-'),
      );
      const marker = path.join(root, 'probity-forwarded.json');
      const payload = Buffer.from(
        ` { "hook_event_name": "PreToolUse", "tool_name": "apply_patch", "tool_input": { "input": "fixture-\u0442\u0435\u0441\u0442" }, "cwd": ${JSON.stringify(root)} }\n`,
      );
      try {
        await selectedProbityProject(root);
        const encoded = await probityWrapper();
        expect(encoded).toBeDefined();
        const result = await runWrapper(encoded!, payload, root, {
          ...process.env,
          PATH: `${path.dirname(process.execPath)};${process.env.PATH ?? ''}`,
          [FAKE_MARKER_ENV]: marker,
        });
        expect(result.code, result.stderr.toString('utf8')).toBe(0);
        expect(result.stdout).toEqual(Buffer.from(RELAY));
        expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({
          argv: ['--agent', 'codex'],
          stdinBase64: payload.toString('base64'),
        });
      } finally {
        await removeFixture(root);
      }
    },
  );

  it(
    'forwards exact Codex input and relays the selected Probity block from a CP437 non-ASCII root',
    { timeout: CASE_TIMEOUT_MS },
    async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
      const root = await mkdtemp(
        path.join(tmpdir(), 'probity-wrapper-cp437-\u0442\u0435\u0441\u0442-\u00e9-'),
      );
      const marker = path.join(root, 'probity-forwarded.json');
      const payload = Buffer.from(
        ` { "hook_event_name": "PreToolUse", "tool_name": "apply_patch", "tool_input": { "input": "fixture-\u0442\u0435\u0441\u0442" }, "cwd": ${JSON.stringify(root)} }\n`,
      );
      try {
        await selectedProbityProject(root);
        const encoded = await probityWrapper();
        expect(encoded).toBeDefined();
        const result = await runWrapper(withCp437ConsoleOutput(encoded!), payload, root, {
          ...process.env,
          PATH: `${path.dirname(process.execPath)};${process.env.PATH ?? ''}`,
          [FAKE_MARKER_ENV]: marker,
        });
        expect(result.code, result.stderr.toString('utf8')).toBe(0);
        expect(result.stdout).toEqual(Buffer.from(RELAY));
        expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({
          argv: ['--agent', 'codex'],
          stdinBase64: payload.toString('base64'),
        });
      } finally {
        await removeFixture(root);
      }
    },
  );

  it(
    'forwards exact Codex input and relays the selected Probity block from a UNC root',
    { timeout: CASE_TIMEOUT_MS },
    async (ctx) => {
      skipUnless(ctx, onlyOnWindows().ok, onlyOnWindows().reason);
      const localRoot = await mkdtemp(path.join(tmpdir(), 'probity-wrapper-unc-'));
      const driveMatch = /^([A-Za-z]):(\\.*)$/.exec(localRoot);
      const unc = driveMatch ? `\\\\127.0.0.1\\${driveMatch[1]}$${driveMatch[2]}` : null;
      skipUnless(
        ctx,
        unc !== null && existsSync(unc),
        'the local admin-share UNC root is unreachable',
      );
      const marker = path.join(localRoot, 'probity-forwarded.json');
      const payload = Buffer.from(
        ` { "hook_event_name": "PreToolUse", "tool_name": "apply_patch", "tool_input": { "input": "fixture-UNC" }, "cwd": ${JSON.stringify(unc)} }\n`,
      );
      try {
        await selectedProbityProject(localRoot);
        const encoded = await probityWrapper();
        expect(encoded).toBeDefined();
        const result = await runWrapper(encoded!, payload, unc!, {
          ...process.env,
          PATH: `${path.dirname(process.execPath)};${process.env.PATH ?? ''}`,
          [FAKE_MARKER_ENV]: marker,
        });
        expect(result.code, result.stderr.toString('utf8')).toBe(0);
        expect(result.stdout).toEqual(Buffer.from(RELAY));
        expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({
          argv: ['--agent', 'codex'],
          stdinBase64: payload.toString('base64'),
        });
      } finally {
        await removeFixture(localRoot);
      }
    },
  );
});
