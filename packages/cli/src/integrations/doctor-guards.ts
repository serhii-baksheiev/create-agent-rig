import { initFileContents } from '../commands/init.js';
import { MANIFEST_REL, parseManifest, sha256 } from '../lib/manifest.js';
import { readBounded } from './verify.js';
import { runProviderProcess } from './spawn.js';
import { agentOsUniversalDir } from '../templates.js';
import { isDeepStrictEqual } from 'node:util';

const MAX_BYTES = 1024 * 1024;
const WIRING = ['.claude/settings.json', '.codex/hooks.json'] as const;

export type GuardInspection = {
  status: 'pass' | 'fail';
  reason:
    | 'guards-verified'
    | 'hook-wiring-invalid'
    | 'hook-integrity-invalid'
    | 'guard-fixture-batch-failed';
};
export type InspectGuardsOptions = { repoDir: string; runner?: typeof runProviderProcess };

const failed = (
  reason: Exclude<GuardInspection['reason'], 'guards-verified'>,
): GuardInspection => ({
  status: 'fail',
  reason,
});

function text(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function includesWiring(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.every((entry) => actual.some((candidate) => includesWiring(candidate, entry)))
    );
  if (typeof expected !== 'object' || expected === null) return actual === expected;
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false;
  const wanted = expected as Record<string, unknown>;
  const found = actual as Record<string, unknown>;
  // A hook command must keep its complete behavior (including Windows command,
  // synchronous execution and timeout). Foreign sibling entries remain allowed.
  if ('command' in wanted) return isDeepStrictEqual(actual, expected);
  return Object.entries(wanted).every(([key, value]) => includesWiring(found[key], value));
}

/**
 * Fixed package-owned fixture runner. The payload consists only of bytes from
 * `initFileContents`; it never loads the checked repository's hooks, settings,
 * commands, or input. It makes an isolated root and runs the finite fixtures
 * under a child process managed by the common safe-process boundary.
 */
const FIXTURE_WRAPPER = String.raw`
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),url=require('node:url');
void (async()=>{
const source=process.argv[1];
const root=fs.mkdtempSync(path.join(os.tmpdir(),'rig-guard-fixtures-'));
const parent=path.resolve(os.tmpdir()),resolved=path.resolve(root);
if(!resolved.startsWith(parent+path.sep)||!path.basename(resolved).startsWith('rig-guard-fixtures-'))throw new Error('unsafe fixture root');
let code=1;
try {
 const home=path.join(root,'home'); fs.mkdirSync(path.join(root,'.claude','agents'),{recursive:true});
 fs.writeFileSync(path.join(root,'.claude','agents','code-reviewer.md'),'---\nmodel: gpt-5.6-sol\n---\n');
 const env={...process.env,HOME:home,APPDATA:home,CLAUDE_PROJECT_DIR:root};
 const unattended=path.join(source,'.claude','scripts','unattended-flag.mjs');
 const flag=await import(url.pathToFileURL(unattended).href); flag.writeUnattended({item:'fixture',runDir:root,allow:[]},env);
 const run=(rel,input)=>cp.spawnSync(process.execPath,[path.join(source,...rel.split('/'))],{cwd:root,env,input:JSON.stringify(input),encoding:'utf8',timeout:5000,maxBuffer:8192}).status;
 const pre=(tool_input)=>({hook_event_name:'PreToolUse',tool_name:tool_input.command?'Bash':'Write',tool_input});
 const cases=[
  ['.claude/hooks/guard-secret-file.mjs',pre({file_path:path.join(root,'.env'),content:'TOKEN=x'}),false],
  ['.claude/hooks/guard-secret-file.mjs',pre({file_path:path.join(root,'note.txt'),content:'safe'}),true],
  ['.claude/hooks/block-no-verify.mjs',pre({command:'git commit --no-verify'}),false],
  ['.claude/hooks/block-no-verify.mjs',pre({command:'git status'}),true],
  ['.claude/hooks/guard-bash.mjs',pre({command:'git push --force origin master'}),false],
  ['.claude/hooks/guard-bash.mjs',pre({command:'git status'}),true],
  ['.claude/hooks/guard-rulebook.mjs',{hook_event_name:'PreToolUse',tool_name:'Edit',tool_input:{file_path:path.join(root,'.claude','agents','code-reviewer.md'),new_string:'model: gpt-5.6-terra'}},false],
  ['.claude/hooks/guard-rulebook.mjs',pre({file_path:path.join(root,'note.txt'),content:'safe'}),true],
  ['.claude/hooks/guard-subagent-model.mjs',{hook_event_name:'PreToolUse',tool_name:'Agent',tool_input:{subagent_type:'code-reviewer',model:'haiku'}},false],
  ['.claude/hooks/guard-subagent-model.mjs',{hook_event_name:'PreToolUse',tool_name:'Agent',tool_input:{subagent_type:'code-reviewer'}},true]
 ];
 for(const [rel,input,allowed] of cases){const status=run(rel,input);if(allowed ? status!==0 : status!==2){code=1;break;} code=0;}
} finally { fs.rmSync(resolved,{recursive:true,force:true}); }
process.exitCode=code;
})().catch(()=>{process.exitCode=1;});
`;

export async function inspectGuards(options: InspectGuardsOptions): Promise<GuardInspection> {
  const manifestFile = await readBounded(options.repoDir, MANIFEST_REL, MAX_BYTES);
  const manifest =
    manifestFile.status === 'ok' ? parseManifest(text(manifestFile.bytes) ?? '') : null;
  if (manifest === null) return failed('hook-wiring-invalid');
  const expected = await initFileContents(options.repoDir, manifest.project, manifest.layers);

  for (const rel of WIRING) {
    const observed = await readBounded(options.repoDir, rel, MAX_BYTES);
    const wanted = expected.get(rel);
    const actualText = observed.status === 'ok' ? text(observed.bytes) : null;
    const expectedText = wanted === undefined ? null : wanted;
    if (actualText === null || expectedText === null) return failed('hook-wiring-invalid');
    let actual: unknown, generated: unknown;
    try {
      actual = JSON.parse(actualText);
      generated = JSON.parse(expectedText);
    } catch {
      return failed('hook-wiring-invalid');
    }
    const observedSettings = actual as { hooks?: unknown; disableAllHooks?: unknown } | null;
    const expectedSettings = generated as { hooks?: unknown };
    if (
      observedSettings?.disableAllHooks === true ||
      !includesWiring(observedSettings?.hooks, expectedSettings.hooks)
    )
      return failed('hook-wiring-invalid');
  }
  const dependencies = [...expected.keys()].filter(
    (rel) =>
      rel.startsWith('.claude/hooks/') ||
      rel.startsWith('.claude/scripts/lib/') ||
      rel === '.claude/scripts/stop-flag.mjs' ||
      rel === '.claude/scripts/unattended-flag.mjs' ||
      rel === '.claude/scripts/git-env.mjs',
  );
  for (const rel of dependencies) {
    const observed = await readBounded(options.repoDir, rel, MAX_BYTES);
    const wanted = expected.get(rel);
    if (
      observed.status !== 'ok' ||
      wanted === undefined ||
      sha256(observed.bytes) !== sha256(Buffer.from(wanted))
    )
      return failed('hook-integrity-invalid');
  }

  const batch = await (options.runner ?? runProviderProcess)({
    executable: process.execPath,
    args: ['-e', FIXTURE_WRAPPER, agentOsUniversalDir()],
    repoDir: options.repoDir,
    timeoutMs: 30_000,
    maxOutputBytes: 8 * 1024,
  });
  if (batch.status !== 'ok' || batch.exitCode !== 0) return failed('guard-fixture-batch-failed');
  return { status: 'pass', reason: 'guards-verified' };
}
