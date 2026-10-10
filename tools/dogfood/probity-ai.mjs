import { rmdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Codex } from '@openai/codex-sdk';

const validatorTimeoutMs = 40_000;

export function createProbityAi({ codex = new Codex() } = {}) {
  return {
    async reason(prompt) {
      let workingDirectory;
      let verdict;

      try {
        workingDirectory = mkdtempSync(path.join(tmpdir(), 'probity-codex-'));
        const thread = codex.startThread({
          workingDirectory,
          skipGitRepoCheck: true,
          sandboxMode: 'read-only',
          approvalPolicy: 'never',
          networkAccessEnabled: false,
          webSearchEnabled: false,
        });
        const turn = await thread.run(prompt, { signal: AbortSignal.timeout(validatorTimeoutMs) });
        verdict = parseVerdict(turn.finalResponse, turn.usage);
      } catch (error) {
        verdict = {
          kind: 'violation',
          reason: error instanceof Error && error.message ? error.message : 'validator failed',
        };
      } finally {
        if (workingDirectory) {
          try {
            rmdirSync(workingDirectory);
          } catch {
            verdict = { kind: 'violation', reason: 'validator cleanup failed' };
          }
        }
      }

      return verdict;
    },
  };
}

function parseVerdict(response, usage) {
  if (typeof response !== 'string') {
    return { kind: 'violation', reason: 'validator returned an invalid response' };
  }

  let parsed;
  try {
    parsed = JSON.parse(response);
  } catch {
    return { kind: 'violation', reason: 'validator returned malformed JSON' };
  }

  if (
    parsed === null ||
    Array.isArray(parsed) ||
    typeof parsed !== 'object' ||
    (parsed.kind !== 'pass' && parsed.kind !== 'violation') ||
    typeof parsed.reason !== 'string'
  ) {
    return { kind: 'violation', reason: 'validator returned an invalid verdict' };
  }

  const meta = buildMeta(usage);
  const verdict = { kind: parsed.kind, reason: parsed.reason };
  return meta ? { ...verdict, meta } : verdict;
}

function buildMeta(usage) {
  const meta = {};
  if (usage && typeof usage.input_tokens === 'number') {
    meta.inputTokens = usage.input_tokens;
  }
  if (usage && typeof usage.output_tokens === 'number') {
    meta.outputTokens = usage.output_tokens;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}
