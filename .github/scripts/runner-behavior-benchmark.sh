#!/usr/bin/env bash
set -euo pipefail

REMOTE="${METAL_USER}@${HOST}"
# shellcheck disable=SC2088
RUNNER_DIR="/var/lib/vm0-runner/runners/${JOB_REF}-bench"

echo "=== Generating config ==="
# shellcheck disable=SC2029
ssh "$REMOTE" "sudo ${BIN_DIR}/runner config \
  --profile vm0/default \
  --rootfs-hash ${DEFAULT_ROOTFS_HASH} \
  --snapshot-hash ${DEFAULT_SNAPSHOT_HASH} \
  --hostname ${HOST} \
  --group vm0/benchmark-${JOB_REF} \
  --runner-dirname ${JOB_REF}-bench \
  --api-url https://not-a-real-server.test \
  --token vm0_official_${OFFICIAL_RUNNER_SECRET}"

echo "=== Running benchmark (default) ==="
# shellcheck disable=SC2029
ssh "$REMOTE" "sudo ${BIN_DIR}/runner benchmark \
  --config ${RUNNER_DIR}/runner.yaml \
  --profile vm0/default \
  'curl -sf --max-time 10 --output /dev/null https://www.vm0.ai'"

echo "=== Running benchmark (browser automation) ==="
# Retry once — snapshot restore can trigger transient Chromium
# ERR_NETWORK_CHANGED due to stale netlink messages.
# shellcheck disable=SC2029
ssh "$REMOTE" "sudo ${BIN_DIR}/runner benchmark \
  --config ${RUNNER_DIR}/runner.yaml \
  --profile vm0/default \
  '(agent-browser open https://github.com/ && agent-browser get title && agent-browser close) || (sleep 2 && agent-browser open https://github.com/ && agent-browser get title && agent-browser close)'"
