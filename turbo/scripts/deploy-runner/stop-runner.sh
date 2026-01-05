#!/bin/bash
# Stop runner via pm2 and cleanup
# This script runs on the Metal server
#
# Usage: ./stop-runner.sh <pr-number> [--show-logs]

set -e

PR_NUMBER="$1"
SHOW_LOGS="$2"

if [ -z "$PR_NUMBER" ]; then
  echo "Usage: $0 <pr-number> [--show-logs]"
  exit 1
fi

PROCESS_NAME="vm0-runner-pr-${PR_NUMBER}"
LOG_FILE="/tmp/${PROCESS_NAME}.log"
RUNNER_DIR="/opt/vm0-runner/pr-${PR_NUMBER}"

echo "Stopping runner for PR #${PR_NUMBER}..."

# Show logs if requested
if [ "$SHOW_LOGS" = "--show-logs" ]; then
  echo "Final runner logs:"
  cat "$LOG_FILE" 2>/dev/null || echo "No logs found"
fi

# Stop pm2 process
pm2 delete "$PROCESS_NAME" 2>/dev/null || true

# Clean up VM workspaces directory (contains rootfs copies ~2GB each)
WORKSPACES_DIR="${RUNNER_DIR}/workspaces"
if [ -d "$WORKSPACES_DIR" ]; then
  echo "Cleaning up workspaces: $WORKSPACES_DIR"
  rm -rf "$WORKSPACES_DIR"
fi

# Clean up TAP devices that may have been left behind
TAP_DEVICES=$(ip link show 2>/dev/null | grep -oE "tap[a-f0-9]+" | sort -u)
if [ -n "$TAP_DEVICES" ]; then
  echo "Cleaning up orphaned TAP devices..."
  for tap in $TAP_DEVICES; do
    sudo ip link delete "$tap" 2>/dev/null && echo "  Deleted: $tap"
  done
fi

# Clean up runner log file
rm -f "$LOG_FILE" 2>/dev/null

echo "Runner stopped for PR #${PR_NUMBER}"
