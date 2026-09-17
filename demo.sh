#!/bin/sh
# The 2-minute demo — what installing the rig gives you, end to end:
#   1. init the rig into a scratch directory, with its pristine baseline commit
#   2. an attempted pre-commit bypass is BLOCKED by a hook (the point)
#
# From this repo:            ./demo.sh
# From a clean machine:      CAF="npx github:<user>/create-agent-rig" ./demo.sh
set -eu

START=$(date +%s)
REPO_ROOT=$(cd "$(dirname "$0")" && pwd)
CAF=${CAF:-"node $REPO_ROOT/packages/cli/dist/index.js"}
WORK=$(mktemp -d)
APP="$WORK/demo-app"
trap 'rm -rf "$WORK"' EXIT

say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

say "1/2 install the rig into a fresh directory"
[ -f "$REPO_ROOT/packages/cli/dist/index.js" ] || (cd "$REPO_ROOT" && pnpm build)
$CAF "$APP"
cd "$APP"
git log --oneline | grep -q 'Pristine template' && echo "pristine baseline commit ✔"

say "2/2 an agent tries to bypass pre-commit…"
VIOLATION='{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git commit --no-verify -m \"skip the hooks\""}}'
if printf '%s' "$VIOLATION" | node .claude/hooks/block-no-verify.mjs; then
  echo "ERROR: the hook should have refused this command" >&2
  exit 1
else
  echo "…and the block-no-verify hook REFUSED the edit at the tool layer (exit 2). ✔"
fi

say "done in $(( $(date +%s) - START ))s"
