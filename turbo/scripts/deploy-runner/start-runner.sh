#!/bin/bash
# Start runner via pm2
# This script runs on the Metal server
# Expects runner.yaml to already be in RUNNER_DIR
#
# Usage: ./start-runner.sh <runner-dir> <pr-number>
# Environment variables:
#   VERCEL_AUTOMATION_BYPASS_SECRET - Vercel bypass secret (optional)
#   USE_MOCK_CLAUDE - Use mock Claude for testing (optional)

set -e

RUNNER_DIR="$1"
PR_NUMBER="$2"

if [ -z "$RUNNER_DIR" ] || [ -z "$PR_NUMBER" ]; then
  echo "Usage: $0 <runner-dir> <pr-number>"
  exit 1
fi

PROCESS_NAME="vm0-runner-pr-${PR_NUMBER}"
LOG_FILE="/tmp/${PROCESS_NAME}.log"

echo "Starting runner for PR #${PR_NUMBER}..."

# Stop any existing runner
echo "Stopping any existing runner..."
pm2 delete "$PROCESS_NAME" 2>/dev/null || true
sleep 1

# Clean up old tap devices from previous runs
echo "Cleaning up old TAP devices..."
for tap in $(ip link show 2>/dev/null | grep -o 'tap[0-9a-f]*' | head -20); do
  sudo ip link delete "$tap" 2>/dev/null || true
done

# Clear old log file
rm -f "$LOG_FILE"

# Create wrapper script for pm2 (preserves arguments on restart)
cat > "${RUNNER_DIR}/run.sh" << 'WRAPPER'
#!/bin/bash
cd "$(dirname "$0")"
exec node index.js start --config ./runner.yaml
WRAPPER
chmod +x "${RUNNER_DIR}/run.sh"

# Start via pm2 with environment variables
echo "Starting runner via pm2..."
cd "$RUNNER_DIR"
VERCEL_AUTOMATION_BYPASS_SECRET="${VERCEL_AUTOMATION_BYPASS_SECRET}" \
USE_MOCK_CLAUDE="${USE_MOCK_CLAUDE}" \
pm2 start run.sh --name "$PROCESS_NAME" --log "$LOG_FILE" --interpreter bash

# Wait for process to be online (max 10 attempts)
echo "Waiting for runner to start..."
for i in $(seq 1 10); do
  STATUS=$(pm2 jlist | jq -r ".[] | select(.name==\"$PROCESS_NAME\") | .pm2_env.status" 2>/dev/null || echo 'unknown')
  if [ "$STATUS" = "online" ]; then
    echo "Runner process is online"
    break
  fi
  echo "  Attempt $i: status=$STATUS, waiting..."
  sleep 1
done

# Wait for runner to fully initialize (setup network bridge, start polling)
# The runner logs "Press Ctrl+C to stop" when it's ready to accept jobs
echo "Waiting for runner to initialize..."
for i in $(seq 1 10); do
  if grep -q "Press Ctrl+C to stop" "$LOG_FILE" 2>/dev/null; then
    echo "Runner is fully initialized and polling for jobs"
    break
  fi
  echo "  Waiting for initialization... (attempt $i)"
  sleep 1
done

# Show status
pm2 status "$PROCESS_NAME"

# Show initial logs
echo "Runner logs:"
cat "$LOG_FILE" 2>/dev/null || echo "No logs yet"
