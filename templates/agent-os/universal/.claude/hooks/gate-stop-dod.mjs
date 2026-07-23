// Stop hook: the Definition of Done as a mechanical gate. The session may not
// end while a named DoD check fails — the checklist stops being a wish.
//
// The stack layer supplies the checks (.claude/hooks/dod-checks.json — an
// array of shell commands, cheap and deterministic). Universal supplies only
// the mechanism: no config → nothing to gate.
//
// Anti-loop discipline (the classic Stop-hook trap):
//   - stop_hook_active in the payload means we already blocked this stop once
//     — never block again, or an agent that cannot go green spins forever;
//   - a clean git tree stops instantly: nothing changed, nothing to gate;
//   - fail open on any hook error — a crashed gate must not make the session
//     unquittable.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0;
  }
  if (input.hook_event_name !== 'Stop' && input.hook_event_name !== 'SubagentStop') return 0;
  if (input.stop_hook_active) return 0;

  try {
    const status = execSync('git status --porcelain', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (status.trim() === '') return 0;
  } catch {
    // not a git repo — run the checks anyway
  }

  let checks;
  try {
    checks = JSON.parse(readFileSync(new URL('./dod-checks.json', import.meta.url), 'utf8'));
  } catch {
    return 0;
  }
  if (!Array.isArray(checks) || checks.length === 0) return 0;

  for (const command of checks) {
    try {
      execSync(command, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const tail = String(error.stdout ?? '')
        .split('\n')
        .slice(-15)
        .join('\n');
      process.stderr.write(
        `STOP GATED — a Definition of Done check fails: ${command}\n` +
          (tail.trim() ? `${tail}\n` : '') +
          `Fix the failure before ending the session. If this failure has resisted ` +
          `repeated attempts, follow the stop rules instead: end with a written ` +
          `diagnosis (.claude/rules/autonomy.md). This gate never fires twice in a row.\n`,
      );
      return 2;
    }
  }
  return 0;
}

process.exit(main());
