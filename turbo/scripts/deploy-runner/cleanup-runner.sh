#!/bin/bash
# Full cleanup of runner for a PR
# This script runs on the Metal server
#
# Usage: ./cleanup-runner.sh <pr-number>

set -e

PR_NUMBER="$1"

if [ -z "$PR_NUMBER" ]; then
  echo "Usage: $0 <pr-number>"
  exit 1
fi

PROCESS_NAME="vm0-runner-pr-${PR_NUMBER}"
LOG_FILE="/tmp/${PROCESS_NAME}.log"
RUNNER_DIR="/opt/vm0-runner/pr-${PR_NUMBER}"

echo "Cleaning up runner for PR #${PR_NUMBER}..."

# Stop pm2 process (if using pm2)
pm2 delete "$PROCESS_NAME" 2>/dev/null || true

# Kill any node processes running from this runner directory
# This catches runners started directly (not via pm2)
pkill -f "node.*${RUNNER_DIR}" 2>/dev/null || true

# Wait a moment for processes to terminate
sleep 1

# Force kill if still running
pkill -9 -f "node.*${RUNNER_DIR}" 2>/dev/null || true

# Remove runner directory (needs sudo as it was created with sudo)
sudo rm -rf "$RUNNER_DIR"

# Remove log file
rm -f "$LOG_FILE"

echo "Runner cleanup complete for PR #${PR_NUMBER}"
