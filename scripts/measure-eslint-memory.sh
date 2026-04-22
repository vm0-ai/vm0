#!/usr/bin/env bash
# Measures peak RSS of the ESLint phase in @vm0/app.
# Usage: ./scripts/measure-eslint-memory.sh
# Outputs: elapsed time (ms) and peak RSS (MB)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM_DIR="$REPO_ROOT/turbo/apps/platform"

cd "$PLATFORM_DIR"

echo "Running ESLint in $PLATFORM_DIR ..."
START_NS=$(date +%s%N)

pnpm exec eslint . --max-warnings 0 &
ESLINT_PID=$!

MAX_RSS_KB=0
while kill -0 "$ESLINT_PID" 2>/dev/null; do
  # Sum RSS across main process + direct child processes (worker_threads share RSS)
  PIDS=("$ESLINT_PID")
  mapfile -t CHILDREN < <(pgrep -P "$ESLINT_PID" 2>/dev/null || true)
  PIDS+=("${CHILDREN[@]}")

  TOTAL_KB=0
  for pid in "${PIDS[@]}"; do
    RSS_LINE=$(awk '/^VmRSS/{print $2}' "/proc/$pid/status" 2>/dev/null || echo 0)
    TOTAL_KB=$(( TOTAL_KB + RSS_LINE ))
  done

  if (( TOTAL_KB > MAX_RSS_KB )); then
    MAX_RSS_KB=$TOTAL_KB
  fi

  sleep 0.1
done

wait "$ESLINT_PID"
EXIT_CODE=$?

END_NS=$(date +%s%N)
ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))

echo "---"
echo "Exit code : $EXIT_CODE"
echo "Elapsed   : ${ELAPSED_MS} ms"
echo "Peak RSS  : $(( MAX_RSS_KB / 1024 )) MB  (${MAX_RSS_KB} kB)"
