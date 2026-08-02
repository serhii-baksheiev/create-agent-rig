#!/bin/sh
# The 2-minute demo — what a generated project gives you, end to end:
#   1. generate a project        2. its own tests pass
#   3. an attempted invariant violation is BLOCKED by a hook (the point)
#   4. the service actually runs: smoke request → 201, event processed, DLQ empty
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

say "1/4 generate (target: node-service)"
[ -f "$REPO_ROOT/packages/cli/dist/index.js" ] || (cd "$REPO_ROOT" && pnpm build)
$CAF "$APP" --target node-service

say "2/4 the generated project passes its own gates"
cd "$APP"
pnpm install --silent --no-frozen-lockfile
pnpm check

say "3/4 an agent tries to put I/O and clock access into the pure core…"
VIOLATION='{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"packages/core/src/note.ts","content":"import { readFile } from \"node:fs/promises\";\nexport const now = () => Date.now();"}}'
if printf '%s' "$VIOLATION" | node .claude/hooks/guard-core-purity.mjs; then
  echo "ERROR: the hook should have refused this edit" >&2
  exit 1
else
  echo "…and the guard-core-purity hook REFUSED the edit at the tool layer (exit 2). ✔"
fi

say "4/4 it runs: smoke request through every layer"
DATA_DIR="$WORK/var/data" QUEUE_DIR="$WORK/var/queue" PORT=3210 \
  pnpm --filter '@demo-app/api' start >"$WORK/api.log" 2>&1 &
API_PID=$!
trap 'kill "$API_PID" 2>/dev/null || true; rm -rf "$WORK"' EXIT
sleep 2
BODY=$(curl -sf -X POST localhost:3210/notes \
  -H 'content-type: application/json' \
  -d '{"title":"demo smoke test","tags":["demo"]}')
echo "$BODY" | grep -q '"slug":"demo-smoke-test"'
echo "POST /notes → 201: $BODY"

QUEUE_DIR="$WORK/var/queue" DLQ_DIR="$WORK/var/dlq" POLL_INTERVAL_MS=200 \
  pnpm --filter '@demo-app/worker' start >"$WORK/worker.log" 2>&1 &
WORKER_PID=$!
sleep 2
kill "$WORKER_PID" 2>/dev/null || true
grep -q 'note.created processed' "$WORK/worker.log" && echo "worker processed the event ✔"
[ -z "$(ls "$WORK/var/queue" 2>/dev/null)" ] && echo "queue drained ✔"
[ -z "$(ls -A "$WORK/var/dlq" 2>/dev/null)" ] && echo "DLQ empty ✔"

say "done in $(( $(date +%s) - START ))s"
