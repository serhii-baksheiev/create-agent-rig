#!/usr/bin/env node
import { mkdir, readFile, rm, cp, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parseSessionSchema, parseFlagBasename } from './policy-benchmark-schema.mjs';
import { createBenchmarkEnv, runProcess } from './policy-benchmark-runtime.mjs';

const requireFromHere = createRequire(import.meta.url);
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clone = (value) => JSON.parse(JSON.stringify(value));
const hookEntries = (snapshot) =>
  Object.values(snapshot.hooks)
    .flatMap((groups) => groups ?? [])
    .flatMap((group) => group.hooks ?? []);
const firstPolicy = (policies) =>
  policies.find((policy) => policy.policyId === 'secret-write-refusal') ?? policies[0];
const CHILD_TIMEOUT_MS = 10_000;
const MAX_STDERR_BYTES = 64 * 1024;

const resolved = (value) => {
  try {
    return realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
};
const inside = (candidate, parent) => {
  const relative = path.relative(resolved(parent), resolved(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const requiredDirectory = (value, name) => {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`${name} must be a directory`);
  return resolved(value);
};
const benchmarkInput = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('benchmark worker payload must be an object');
  const expected = [
    'root',
    'surfaceRoot',
    'contractRoot',
    'harness',
    'corpus',
    'workspaceRoot',
  ].sort();
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    throw new Error('benchmark worker payload has an invalid envelope');
  const root = requiredDirectory(value.root, 'root');
  const surfaceRoot = requiredDirectory(value.surfaceRoot, 'surfaceRoot');
  const contractRoot = requiredDirectory(value.contractRoot, 'contractRoot');
  const workspaceRoot = requiredDirectory(value.workspaceRoot, 'workspaceRoot');
  if (!inside(surfaceRoot, root) || !inside(contractRoot, root))
    throw new Error('benchmark snapshot paths escape its root');
  return { ...value, root, surfaceRoot, contractRoot, workspaceRoot };
};

const rejectsForeignMajor = async (contractRoot) => {
  const schema = parseSessionSchema(await readFile(path.join(contractRoot, 'schema.ts'), 'utf8'));
  const loadedAjv = requireFromHere('ajv/dist/2020.js');
  const Ajv2020 = loadedAjv.default ?? loadedAjv;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const loadedFormats = requireFromHere('ajv-formats');
  (loadedFormats.default ?? loadedFormats)(ajv);
  const fixture = JSON.parse(
    await readFile(
      path.join(contractRoot, 'fixtures', 'negative', 'envelope-foreign-major.json'),
      'utf8',
    ),
  );
  if (fixture.definition !== 'Envelope')
    throw new Error('foreign-major fixture must target Envelope');
  const validate = ajv.compile({
    $schema: schema.$schema,
    $defs: schema.$defs,
    $ref: '#/$defs/Envelope',
  });
  const rejected =
    validate(fixture.value) === false &&
    validate.errors?.some(
      (error) => error.keyword === 'const' && error.instancePath === '/contractMajor',
    ) === true;
  const positive = JSON.parse(
    await readFile(
      path.join(contractRoot, 'fixtures', 'positive', 'envelope-supported-major.json'),
      'utf8',
    ),
  );
  return rejected && positive.definition === 'Envelope' && validate(positive.value) === true;
};

const mutate = (snapshot, adapter, policy, id) => {
  const next = clone(snapshot);
  const native = adapter.nativeSurfaceOf(policy);
  const matches = (entry) =>
    Object.values(entry).some(
      (value) => typeof value === 'string' && value.includes(native.hookPath),
    );
  if (id === 'unwired-enforcement') {
    for (const groups of Object.values(next.hooks))
      for (const group of groups ?? [])
        group.hooks = group.hooks.filter((entry) => !matches(entry));
  } else if (id === 'disabled-enforcement') {
    for (const entry of hookEntries(next))
      if (matches(entry))
        for (const key of Object.keys(native.commands)) entry[key] = 'echo guard-disabled';
  } else if (id === 'narrowed-enforcement') {
    for (const groups of Object.values(next.hooks))
      for (const group of groups ?? [])
        if (group.hooks.some(matches) && typeof group.matcher === 'string')
          group.matcher = group.matcher.split('|').slice(0, -1).join('|');
  } else if (id === 'bypassed-enforcement') {
    for (const entry of hookEntries(next))
      if (matches(entry))
        for (const key of Object.keys(native.commands)) entry[key] = `true || ${entry[key]}`;
  } else if (id === 'unreadable-input') {
    for (const entry of hookEntries(next)) if (matches(entry)) entry.command = 42;
  }
  return next;
};

const createRealGuardRunner = ({ surfaceRoot, workspaceRoot }) => {
  let workspace;

  const setup = async () => {
    const scratch = path.join(workspaceRoot, 'scratch');
    const home = path.join(workspaceRoot, 'home');
    const tmp = path.join(workspaceRoot, 'tmp');
    if (![scratch, home, tmp].every((entry) => inside(entry, workspaceRoot)))
      throw new Error('benchmark workspace escapes its parent');
    await mkdir(home, { recursive: true });
    await mkdir(tmp, { recursive: true });
    await cp(surfaceRoot, scratch, { recursive: true, dereference: false });
    const env = {
      ...createBenchmarkEnv(process.env, { home, tmp }),
      CLAUDE_PROJECT_DIR: scratch,
    };
    const flagModule = await import(
      pathToFileURL(path.join(scriptRoot, '.claude', 'scripts', 'unattended-flag.mjs')).href
    );
    const flagSource = await readFile(
      path.join(surfaceRoot, '.claude/scripts/unattended-flag.mjs'),
      'utf8',
    );
    const targetBasename = parseFlagBasename(flagSource);
    const [trustedFlag] = flagModule.unattendedFlags(env);
    const suffix = path
      .basename(trustedFlag)
      .slice(flagModule.FLAG_BASENAME.length - '-loop-UNATTENDED'.length);
    const flag = path.join(home, '.claude', targetBasename.replace('-loop-UNATTENDED', suffix));
    if (typeof flag !== 'string' || !inside(flag, home))
      throw new Error('benchmark unattended flag escapes its isolated home');
    const initialized = await runProcess('git', ['init', '-q'], {
      cwd: scratch,
      env,
      input: '',
      timeoutMs: CHILD_TIMEOUT_MS,
      maxBytes: MAX_STDERR_BYTES,
      boundaryPid: process.pid,
    });
    if (initialized.code !== 0 || initialized.timedOut)
      throw new Error(`benchmark git init failed: ${initialized.stderr}`);
    return { scratch, home, flag, env };
  };

  const run = async (adapter, policy, scenario) => {
    workspace ??= await setup();
    const { scratch, flag, env } = workspace;
    const clearScenarioState = async () => {
      if (!inside(flag, workspaceRoot)) throw new Error('benchmark flag escapes its workspace');
      await rm(flag, { force: true, maxRetries: 3, retryDelay: 50 });
      await rm(path.join(scratch, '.rig-run'), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    };
    await clearScenarioState();
    try {
      let payload = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: path.join(scratch, '.env'), content: 'x' },
        cwd: scratch,
      };
      let expectedCode = 2;
      if (scenario === 'hook-input') {
        payload = {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: ['git', 'commit', '--no-verify', '-m', 'x'] },
          cwd: scratch,
        };
      }
      if (scenario === 'protected-rulebook' || scenario === 'widening') {
        const allow = scenario === 'widening' ? ['.'] : [];
        await mkdir(path.dirname(flag), { recursive: true });
        await writeFile(
          flag,
          JSON.stringify({ item: 'RP-111', runDir: path.join(scratch, '.rig-run'), allow }),
        );
        payload = {
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          tool_input: { file_path: path.join(scratch, '.claude/rules/autonomy.md'), content: 'x' },
          cwd: scratch,
        };
        expectedCode = 2;
      }
      const native = adapter.nativeSurfaceOf(policy);
      const command = native.commands.command?.[0];
      if (command === undefined) return false;
      const invoke = async (nextPayload) => {
        if (process.platform === 'win32' && adapter.harness === 'codex') {
          const encoded = native.commands.commandWindows?.[0]?.match(
            /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/,
          )?.[1];
          if (encoded === undefined) return 1;
          return (
            await runProcess(
              'powershell.exe',
              ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
              {
                cwd: scratch,
                env,
                input: JSON.stringify(nextPayload),
                timeoutMs: CHILD_TIMEOUT_MS,
                maxBytes: MAX_STDERR_BYTES,
                boundaryPid: process.pid,
              },
            )
          ).code;
        }
        if (process.platform === 'win32')
          return (
            await runProcess(process.execPath, [path.join(scratch, native.hookPath)], {
              cwd: scratch,
              env,
              input: JSON.stringify(nextPayload),
              timeoutMs: CHILD_TIMEOUT_MS,
              maxBytes: MAX_STDERR_BYTES,
              boundaryPid: process.pid,
            })
          ).code;
        return (
          await runProcess('/bin/sh', ['-c', command], {
            cwd: scratch,
            env,
            input: JSON.stringify(nextPayload),
            timeoutMs: CHILD_TIMEOUT_MS,
            maxBytes: MAX_STDERR_BYTES,
            boundaryPid: process.pid,
          })
        ).code;
      };
      if (scenario === 'widening') {
        const refused = (await invoke(payload)) === 2;
        await writeFile(
          flag,
          JSON.stringify({
            item: 'RP-111',
            runDir: path.join(scratch, '.rig-run'),
            allow: ['.claude/scripts/queue/'],
          }),
        );
        const allowed = await invoke({
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          tool_input: {
            file_path: path.join(scratch, '.claude/scripts/queue/core.mjs'),
            content: 'x',
          },
          cwd: scratch,
        });
        return refused && allowed === 0;
      }
      return (await invoke(payload)) === expectedCode;
    } finally {
      await clearScenarioState();
    }
  };

  return {
    run,
  };
};

const benchmark = async (input) => {
  input = benchmarkInput(input);
  const { workspaceRoot, surfaceRoot, contractRoot } = input;
  const policyModule = await import(
    pathToFileURL(path.join(scriptRoot, 'packages', 'cli', 'dist', 'policy', 'index.js')).href
  );
  const corpusModule = await import(
    pathToFileURL(
      path.join(scriptRoot, 'packages', 'cli', 'dist', 'policy', 'benchmark', 'corpus.js'),
    ).href
  );
  const corpus = corpusModule.parseBenchmarkCorpus(input.corpus);
  const adapter = policyModule.HARNESS_ADAPTERS.find(
    (candidate) => candidate.harness === input.harness,
  );
  if (adapter === undefined) throw new Error(`unknown harness ${String(input.harness)}`);
  const defaultPolicy = firstPolicy(policyModule.POLICIES);
  const snapshot = JSON.parse(await readFile(path.join(surfaceRoot, adapter.surfaceFile), 'utf8'));
  const scenarios = [];
  const realGuards = createRealGuardRunner({ surfaceRoot, workspaceRoot });
  for (const scenario of corpus.scenarios) {
    const policy =
      scenario.id === 'hook-input'
        ? policyModule.findPolicy('no-verify-refusal')
        : scenario.id === 'protected-rulebook' || scenario.id === 'widening'
          ? policyModule.findPolicy('rulebook-mutation-restriction')
          : defaultPolicy;
    if (policy === null || policy === undefined) throw new Error(`no policy for ${scenario.id}`);
    let state;
    let actionPassed = true;
    if (scenario.id === 'foreign-major') {
      state = 'UNSUPPORTED';
      actionPassed = await rejectsForeignMajor(contractRoot);
    } else {
      state = policyModule.probePolicy(
        policy,
        adapter,
        mutate(snapshot, adapter, policy, scenario.id),
      ).state;
      if (['real-wiring', 'hook-input', 'protected-rulebook', 'widening'].includes(scenario.id))
        actionPassed =
          state === 'SUPPORTED' && (await realGuards.run(adapter, policy, scenario.id));
    }
    if (!actionPassed) state = 'INTEGRATION-FAILED';
    const diagnosis = corpusModule.classifyCapability(state);
    scenarios.push({
      id: scenario.id,
      capabilityState: state,
      classification: diagnosis.classification,
      integrationFailed: diagnosis.integrationFailed,
      passed: scenario.expectedStates.includes(state) && actionPassed,
    });
  }
  const report = {
    harness: adapter.harness,
    evidence: { kind: 'adapter-process' },
    execution:
      process.platform === 'win32' && adapter.harness === 'claude'
        ? 'direct-hook-target; Claude shell expansion is resolved by the runner'
        : 'configured-adapter-command',
    passed: scenarios.every((scenario) => scenario.passed),
    scenarios,
  };
  return report;
};

let receivedRun = false;
process.on('message', async (message) => {
  if (receivedRun) return;
  receivedRun = true;
  if (
    message === null ||
    typeof message !== 'object' ||
    Array.isArray(message) ||
    message.type !== 'policy-benchmark:run' ||
    Object.keys(message).length !== 2 ||
    !Object.hasOwn(message, 'payload') ||
    !Object.hasOwn(message, 'type')
  ) {
    process.send?.({
      type: 'policy-benchmark:error',
      message: 'invalid benchmark worker envelope',
    });
    return;
  }
  try {
    process.send?.({ type: 'policy-benchmark:result', report: await benchmark(message.payload) });
  } catch (error) {
    process.send?.({
      type: 'policy-benchmark:error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
