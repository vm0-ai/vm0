#!/usr/bin/env bash
set -euo pipefail

REMOTE="${METAL_USER}@${HOST}"
SVC="${JOB_REF}-cancel"
RUNNER_DIR="/var/lib/vm0-runner/runners/${SVC}"
GROUP="vm0/cancel-${JOB_REF}"
GROUP_DIR="/var/lib/vm0-runner/groups/${GROUP}"

echo "=== Cleaning stale cancel runner state ==="
ssh "$REMOTE" bash -s -- "$BIN_DIR" "$SVC" "$GROUP_DIR" "$RUNNER_DIR" <<'REMOTE_SCRIPT'
set -euo pipefail
BIN_DIR=$1; SVC=$2; GROUP_DIR=$3; RUNNER_DIR=$4
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
REMOTE_SCRIPT

echo "=== Generating config ==="
# shellcheck disable=SC2029
ssh "$REMOTE" "sudo ${BIN_DIR}/runner config \
  --profile vm0/default \
  --rootfs-hash ${DEFAULT_ROOTFS_HASH} \
  --snapshot-hash ${DEFAULT_SNAPSHOT_HASH} \
  --name ${SVC} \
  --group ${GROUP} \
  --runner-dirname ${SVC} \
  --max-concurrent 1 \
  --api-url https://not-a-real-server.test \
  --token vm0_official_${OFFICIAL_RUNNER_SECRET}"

echo "=== Running cancel test ==="
ssh "$REMOTE" bash -s -- \
  "$BIN_DIR" "$SVC" "$GROUP" "$GROUP_DIR" "$RUNNER_DIR" <<'REMOTE_SCRIPT'
set -euo pipefail
BIN_DIR=$1; SVC=$2; GROUP=$3; GROUP_DIR=$4; RUNNER_DIR=$5
SUBMIT_PID=""
SUBMIT_OUTPUT=$(mktemp)

fail() { echo "FAIL: $1"; exit 1; }

print_service_logs() {
  echo "--- ${SVC} service logs ---"
  sudo "$BIN_DIR/runner" service logs --name "$SVC" --lines 200 || true
}

cleanup_submit_pid() {
  local pid=$1
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    print_service_logs
  fi
  echo "--- Cleanup ---"
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force || true
  cleanup_submit_pid "$SUBMIT_PID"
  sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
  rm -f "$SUBMIT_OUTPUT"
  exit "$status"
}
trap cleanup EXIT

# Start transient runner service
echo "--- Starting runner ---"
sudo "$BIN_DIR/runner" service start --name "$SVC" \
  --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

# Submit a long-running job in background
echo "--- Submitting long-running job ---"
sudo "$BIN_DIR/runner" local submit \
  --group "$GROUP" --prompt 'sleep 60 && echo done' >"$SUBMIT_OUTPUT" 2>&1 &
SUBMIT_PID=$!

# Resolve this submission from its claim instead of selecting the first active
# run. A failed prior attempt must never redirect cancellation to stale work.
echo "--- Waiting for sandbox ---"
RUN_ID=""
SANDBOX_ID=""
SANDBOX_READY=false
for _ in $(seq 1 60); do
  mapfile -t CLAIM_FILES < <(
    sudo find "$GROUP_DIR/claims" -maxdepth 1 -type f -name '*.claim' \
      -printf '%f\n' 2>/dev/null | sort
  )
  [ "${#CLAIM_FILES[@]}" -le 1 ] \
    || fail "expected one claimed job, found ${#CLAIM_FILES[@]}"
  if [ "${#CLAIM_FILES[@]}" -eq 1 ]; then
    RUN_ID=${CLAIM_FILES[0]%.claim}
    SANDBOX_ID=$(sudo jq -r --arg run_id "$RUN_ID" \
      '.active_runs[]? | select(.run_id == $run_id) | .sandbox_id' \
      "$RUNNER_DIR/status.json" 2>/dev/null)
    if [ -n "$SANDBOX_ID" ] \
      && [ -S "/run/vm0/sock/$SANDBOX_ID/control.sock" ]; then
      SANDBOX_READY=true
      break
    fi
  fi
  SANDBOX_ID=""
  sleep 1
done
[ "$SANDBOX_READY" = true ] || fail "sandbox not found after 60s"
echo "Found run $RUN_ID (sandbox $SANDBOX_ID)"

# Test 1: cancel the job via runner local cancel
echo "--- Test: runner local cancel ---"
sudo "$BIN_DIR/runner" local cancel --run "$RUN_ID" --group "$GROUP" || fail "cancel command failed"
echo "PASS: cancel command succeeded"

# Test 2: submit should exit quickly, well before the prompt completes.
echo "--- Test: waiting for submit to finish ---"
SECONDS=0
if wait "$SUBMIT_PID"; then
  SUBMIT_EXIT=0
else
  SUBMIT_EXIT=$?
fi
SUBMIT_PID=""
ELAPSED=$SECONDS
cat "$SUBMIT_OUTPUT"
echo "Submit exited with code $SUBMIT_EXIT in ${ELAPSED}s"
SUBMIT_JSON=$(awk '/^\{/{line=$0} END{print line}' "$SUBMIT_OUTPUT")
SUBMIT_RUN_ID=$(jq -r '.run_id // empty' <<<"$SUBMIT_JSON")
[ "$SUBMIT_RUN_ID" = "$RUN_ID" ] \
  || fail "cancelled run $RUN_ID but submit returned ${SUBMIT_RUN_ID:-missing}"
# Cancel should kill the job within 30s, not after the 60s prompt.
[ "$ELAPSED" -lt 30 ] || fail "submit took ${ELAPSED}s to exit — cancel likely did not work"
# Cancelled job returns non-zero exit code
[ "$SUBMIT_EXIT" -ne 0 ] || fail "expected non-zero exit from cancelled job, got 0"
echo "PASS: submit exited with non-zero after cancel (${ELAPSED}s)"

# Stop transient service
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
rm -f "$SUBMIT_OUTPUT"
trap - EXIT

echo "=== Cancel test passed ==="
REMOTE_SCRIPT
