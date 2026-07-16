#!/usr/bin/env bash
set -euo pipefail

REMOTE="${METAL_USER}@${HOST}"

echo "=== Generating config ==="
# shellcheck disable=SC2029
ssh "$REMOTE" "sudo ${BIN_DIR}/runner config \
  --profile vm0/default \
  --rootfs-hash ${DEFAULT_ROOTFS_HASH} \
  --snapshot-hash ${DEFAULT_SNAPSHOT_HASH} \
  --name ${JOB_REF}-cancel \
  --group vm0/cancel-${JOB_REF} \
  --runner-dirname ${JOB_REF}-cancel \
  --max-concurrent 2 \
  --api-url https://not-a-real-server.test \
  --token vm0_official_${OFFICIAL_RUNNER_SECRET}"

echo "=== Running cancel test ==="
ssh "$REMOTE" bash -s -- "${BIN_DIR}" "${JOB_REF}" <<'REMOTE_SCRIPT'
BIN_DIR=$1; JOB_REF=$2
RUNNER_DIR="/var/lib/vm0-runner/runners/${JOB_REF}-cancel"
SVC="${JOB_REF}-cancel"
GROUP="vm0/cancel-${JOB_REF}"
SUBMIT_PID=""

fail() { echo "FAIL: $1"; exit 1; }

cleanup_submit_pid() {
  local pid=$1
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  echo "--- Cleanup ---"
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force || true
  cleanup_submit_pid "$SUBMIT_PID"
}
trap cleanup EXIT

# Clean up any residual transient unit from a previous CI run.
# stop() returns Ok when no service exists, so no need for || true.
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force

# Start transient runner service
echo "--- Starting runner ---"
sudo "$BIN_DIR/runner" service start --name "$SVC" \
  --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

# Submit a long-running job in background
echo "--- Submitting long-running job ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" --prompt 'sleep 120 && echo done' &
SUBMIT_PID=$!

# Wait for sandbox to be running. Post #9552, run_id and sandbox_id
# are distinct: `runner local cancel` takes the run_id (what submit
# returned), while the socket path uses sandbox_id. Read both from
# status.json rather than picking the first UUID we see.
echo "--- Waiting for sandbox ---"
for i in $(seq 1 60); do
  RUN_ID=$(sudo jq -r '.active_runs[0].run_id // empty' \
    "$RUNNER_DIR/status.json" 2>/dev/null)
  SANDBOX_ID=$(sudo jq -r '.active_runs[0].sandbox_id // empty' \
    "$RUNNER_DIR/status.json" 2>/dev/null)
  [ -n "$RUN_ID" ] && [ -n "$SANDBOX_ID" ] \
    && [ -S "/run/vm0/sock/$SANDBOX_ID/control.sock" ] && break
  RUN_ID=""
  SANDBOX_ID=""
  sleep 1
done
[ -z "$RUN_ID" ] && fail "sandbox not found after 60s"
echo "Found run $RUN_ID (sandbox $SANDBOX_ID)"

# Test 1: cancel the job via runner local cancel
echo "--- Test: runner local cancel ---"
sudo "$BIN_DIR/runner" local cancel --run "$RUN_ID" --group "$GROUP" || fail "cancel command failed"
echo "PASS: cancel command succeeded"

# Test 2: submit should exit quickly (not after 300s timeout)
echo "--- Test: waiting for submit to finish ---"
SECONDS=0
wait "$SUBMIT_PID"
SUBMIT_EXIT=$?
SUBMIT_PID=""
ELAPSED=$SECONDS
echo "Submit exited with code $SUBMIT_EXIT in ${ELAPSED}s"
# Cancel should kill the job within 30s, not after the 300s submit timeout
[ "$ELAPSED" -lt 30 ] || fail "submit took ${ELAPSED}s to exit — cancel likely did not work"
# Cancelled job returns non-zero exit code
[ "$SUBMIT_EXIT" -ne 0 ] || fail "expected non-zero exit from cancelled job, got 0"
echo "PASS: submit exited with non-zero after cancel (${ELAPSED}s)"

# Stop transient service
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
trap - EXIT

echo "=== Cancel test passed ==="
REMOTE_SCRIPT
