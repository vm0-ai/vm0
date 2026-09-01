#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=$1; JOB_REF=$2
RUNNER_DIR="/var/lib/vm0-runner/runners/${JOB_REF}-bench"

echo "=== Running benchmark (default) ==="
sudo "$BIN_DIR/runner" benchmark \
  --config "${RUNNER_DIR}/runner.yaml" \
  --profile vm0/default \
  'curl -sf --max-time 10 --output /dev/null https://www.vm0.ai'

echo "=== Running benchmark (browser automation) ==="
# Retry once — snapshot restore can trigger transient Chromium
# ERR_NETWORK_CHANGED due to stale netlink messages.
sudo "$BIN_DIR/runner" benchmark \
  --config "${RUNNER_DIR}/runner.yaml" \
  --profile vm0/default \
  '(agent-browser open https://github.com/ && agent-browser get title && agent-browser close) || (sleep 2 && agent-browser open https://github.com/ && agent-browser get title && agent-browser close)'
