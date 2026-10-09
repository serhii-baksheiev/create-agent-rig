import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configPath = path.join(repoRoot, 'probity.config.mjs');
const probityBin = path.join(repoRoot, 'node_modules', '@nizos', 'probity', 'dist', 'bin.js');

function configForProbityArgv(agentArguments) {
  const program = [
    `process.argv = ${JSON.stringify([process.execPath, probityBin, ...agentArguments])};`,
    `const { default: config } = await import(${JSON.stringify(pathToFileURL(configPath).href)});`,
    "process.stdout.write(JSON.stringify({ hasAi: Object.hasOwn(config, 'ai'), hasReason: typeof config.ai?.reason === 'function' }));",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runProbity(agentArguments) {
  return spawnSync(process.execPath, [probityBin, ...agentArguments], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: '{',
  });
}

test('uses the bounded Codex validator when the documented CLI argv selects codex', () => {
  assert.deepEqual(configForProbityArgv(['--agent', 'codex']), {
    hasAi: true,
    hasReason: true,
  });
});

test('leaves the Claude Code validator to Probity’s selected vendor', () => {
  const config = configForProbityArgv(['--agent', 'claude-code']);

  assert.equal(
    config.hasAi,
    false,
    'Config.ai is global: declaring it replaces the official validator selected by --agent claude-code',
  );
});

test('leaves Probity’s default validator available when no agent is selected', () => {
  assert.equal(configForProbityArgv([]).hasAi, false);
});

test('uses the first documented --agent value when duplicate flags are supplied', () => {
  const firstClaude = runProbity(['--agent', 'claude-code', '--agent', 'codex']);
  assert.equal(firstClaude.status, 0, firstClaude.stderr);
  assert.equal(JSON.parse(firstClaude.stdout).hookSpecificOutput?.permissionDecision, 'deny');

  const firstCodex = runProbity(['--agent', 'codex', '--agent', 'claude-code']);
  assert.equal(firstCodex.status, 0, firstCodex.stderr);
  assert.equal(JSON.parse(firstCodex.stdout).decision, 'block');
});

test('creates isolated bounded Codex validators that preserve valid verdicts and fail closed', async () => {
  const { createProbityAi } = await import('./probity-ai.mjs');
  const originalTimeout = AbortSignal.timeout;
  const timeoutCalls = [];
  const threadCalls = [];

  const makeCodex = ({ response, usage, error }) => ({
    startThread(options) {
      threadCalls.push(options);
      return {
        async run(prompt, runOptions) {
          assert.equal(prompt, 'validate this exact prompt');
          assert.ok(runOptions.signal instanceof AbortSignal);
          if (error) throw error;
          return { finalResponse: response, usage };
        },
      };
    },
  });

  Object.defineProperty(AbortSignal, 'timeout', {
    configurable: true,
    value(milliseconds) {
      timeoutCalls.push(milliseconds);
      return originalTimeout(1);
    },
  });

  try {
    const pass = await createProbityAi({
      codex: makeCodex({
        response: '{"kind":"pass","reason":""}',
        usage: { input_tokens: 13, output_tokens: 5 },
      }),
    }).reason('validate this exact prompt');

    assert.deepEqual(pass, {
      kind: 'pass',
      reason: '',
      meta: { inputTokens: 13, outputTokens: 5 },
    });

    const violation = await createProbityAi({
      codex: makeCodex({ response: '{"kind":"violation","reason":"test is not red"}' }),
    }).reason('validate this exact prompt');
    assert.deepEqual(violation, { kind: 'violation', reason: 'test is not red' });

    const forgedTelemetry = await createProbityAi({
      codex: makeCodex({
        response: '{"kind":"pass","reason":"","meta":{"inputTokens":999},"unexpected":true}',
      }),
    }).reason('validate this exact prompt');
    assert.deepEqual(forgedTelemetry, { kind: 'pass', reason: '' });

    for (const response of [
      '',
      'not json',
      '{"kind":"pass"}',
      'null',
      '[]',
      '{"kind":"unknown","reason":"unrecognized"}',
      '{"kind":"pass","reason":7}',
    ]) {
      const result = await createProbityAi({ codex: makeCodex({ response }) }).reason(
        'validate this exact prompt',
      );
      assert.equal(result.kind, 'violation');
      assert.notEqual(result.reason, '');
    }

    const thrown = await createProbityAi({
      codex: makeCodex({ error: new Error('validator transport failed') }),
    }).reason('validate this exact prompt');
    assert.deepEqual(thrown, { kind: 'violation', reason: 'validator transport failed' });

    assert.deepEqual(timeoutCalls, Array(11).fill(40_000));
    assert.equal(threadCalls.length, 11);
    const directories = new Set(threadCalls.map((options) => options.workingDirectory));
    assert.equal(directories.size, threadCalls.length);
    for (const options of threadCalls) {
      assert.equal(options.skipGitRepoCheck, true);
      assert.equal(options.sandboxMode, 'read-only');
      assert.equal(options.approvalPolicy, 'never');
      assert.equal(options.networkAccessEnabled, false);
      assert.equal(options.webSearchEnabled, false);
      assert.equal(Object.hasOwn(options, 'model'), false);
      assert.equal(path.isAbsolute(options.workingDirectory), true);
      assert.equal(options.workingDirectory === repoRoot, false);
      assert.equal(options.workingDirectory.startsWith(`${repoRoot}${path.sep}`), false);
    }
    await Promise.all([...directories].map((directory) => assert.rejects(access(directory))));
  } finally {
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: originalTimeout });
  }
});
