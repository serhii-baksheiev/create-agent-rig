// create-agent-rig's own Probity policy (RP-418): adopted, not Rig-generated.
// The generator's code lives under packages/cli, scripts and the template's
// hook and script trees, and is edited from .claude/worktrees/<task>/ as well
// as the root, so every glob starts with `**` (Probity anchors any other glob
// to this file's directory). Prose, rules and fixtures stay outside the gate.
import { defineConfig, enforceTdd } from '@nizos/probity';
import { createProbityAi } from './tools/dogfood/probity-ai.mjs';

// Probity's public --agent flag uses its first separated value; Config.ai is global.
const agentIndex = process.argv.indexOf('--agent');
const codexValidator =
  agentIndex !== -1 && process.argv[agentIndex + 1] === 'codex' ? { ai: createProbityAi() } : {};

export default defineConfig({
  ...codexValidator,
  rules: [
    {
      files: [
        '**/packages/cli/src/**/*.ts',
        '**/packages/cli/test/**/*.ts',
        '**/test/**/*.ts',
        '**/scripts/**/*.mjs',
        '**/templates/agent-os/universal/.claude/hooks/**/*.mjs',
        '**/templates/agent-os/universal/.claude/scripts/**/*.mjs',
      ],
      rules: [enforceTdd()],
    },
  ],
});
