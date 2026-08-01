#!/usr/bin/env bash
set -euo pipefail

REMOTE="${METAL_USER}@${HOST}"
SVC="${JOB_REF}-keepalive"
GROUP="vm0/keepalive-${JOB_REF}"
RUNNER_DIR="/var/lib/vm0-runner/runners/${SVC}"
GROUP_DIR="/var/lib/vm0-runner/groups/vm0/keepalive-${JOB_REF}"

echo "=== Cleaning stale keep-alive runner state ==="
ssh "$REMOTE" bash -s -- "${BIN_DIR}" "${SVC}" "${GROUP_DIR}" "${RUNNER_DIR}" <<'REMOTE_SCRIPT'
set -euo pipefail
BIN_DIR=$1; SVC=$2; GROUP_DIR=$3; RUNNER_DIR=$4
UNIT="vm0-runner-${SVC}.service"
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force || true
for _ in $(seq 1 30); do
  if ! sudo systemctl is-active --quiet "$UNIT"; then
    break
  fi
  sleep 1
done
if sudo systemctl is-active --quiet "$UNIT"; then
  echo "FAIL: ${UNIT} is still active after cleanup stop" >&2
  exit 1
fi
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
  --max-concurrent 2 \
  --api-url https://not-a-real-server.test \
  --token vm0_official_${OFFICIAL_RUNNER_SECRET}"

echo "=== Running keep-alive test ==="
ssh "$REMOTE" bash -s -- "${BIN_DIR}" "${SVC}" "${GROUP}" "${RUNNER_DIR}" "${GROUP_DIR}" <<'REMOTE_SCRIPT'
set -euo pipefail
BIN_DIR=$1; SVC=$2; GROUP=$3; RUNNER_DIR=$4; GROUP_DIR=$5
UNIT="vm0-runner-${SVC}.service"
SESSION_ID="e2e-keepalive-test-session"
CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
ISOLATED_CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
TAMPER_CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
OVERLAP_CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
OVERLAP_SUBMIT_PID=""
OVERLAP_EXEC_PID=""

fail() { echo "FAIL: $1"; exit 1; }
wait_for_unit_inactive() {
  for _ in $(seq 1 30); do
    if ! sudo systemctl is-active --quiet "$UNIT"; then
      return 0
    fi
    sleep 1
  done
  fail "$UNIT is still active after stop"
}

cleanup() {
  echo "--- Cleanup ---"
  if [ -n "$OVERLAP_EXEC_PID" ]; then
    kill "$OVERLAP_EXEC_PID" 2>/dev/null || true
    wait "$OVERLAP_EXEC_PID" 2>/dev/null || true
  fi
  if [ -n "$OVERLAP_SUBMIT_PID" ]; then
    kill "$OVERLAP_SUBMIT_PID" 2>/dev/null || true
    wait "$OVERLAP_SUBMIT_PID" 2>/dev/null || true
  fi
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force || true
  wait_for_unit_inactive
  sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
}
trap cleanup EXIT

# Clean up any residual transient unit or local queue files for this keep-alive runner.
# stop() returns Ok when no service exists, so no need for || true.
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
wait_for_unit_inactive
sudo rm -rf "$GROUP_DIR"

# Start transient runner service
echo "--- Starting runner ---"
sudo "$BIN_DIR/runner" service start --name "$SVC" \
  --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

INVOCATION_ID=""
for _ in $(seq 1 30); do
  INVOCATION_ID=$(sudo systemctl show "$UNIT" \
    --property=InvocationID --value 2>/dev/null) || true
  [ -n "$INVOCATION_ID" ] && break
  sleep 1
done
[ -n "$INVOCATION_ID" ] || fail "runner invocation ID unavailable"

# Turn 1: submit a thread-bound job with provider session resume — creates a marker file in guest
echo "--- Turn 1: create marker file ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$CHAT_THREAD_ID" \
  --session-id "$SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'touch /tmp/keepalive-marker && echo turn1-done' \
  || fail "Turn 1 failed"

# Turn 2: submit with the same chat thread — should reuse the VM.
# If VM was reused, the marker file from turn 1 still exists (exit 0).
# If a new VM was created, the file is missing and test exits non-zero.
echo "--- Turn 2: verify marker file persists (VM reused) ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$CHAT_THREAD_ID" \
  --session-id "$SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'test -f /tmp/keepalive-marker' \
  || fail "Turn 2: marker file not found — VM was not reused"
echo "PASS: Turn 2 completed (VM reused, filesystem persisted)"

# Turn 3: keep the provider session but use a different chat thread — should create a new VM.
# The marker file must NOT exist in the new VM (thread isolation).
echo "--- Turn 3: different chat thread creates new VM ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$ISOLATED_CHAT_THREAD_ID" \
  --session-id "$SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'test ! -f /tmp/keepalive-marker' \
  || fail "Turn 3: marker file found — chat thread isolation broken"
echo "PASS: Turn 3 completed (new VM for different chat thread)"

# A privileged guest can stack an unrelated mount over the canonical workspace
# after a turn starts. Idle admission must reject that sandbox, so the next turn
# receives a fresh VM whose workspace is backed by /dev/vdb.
TAMPER_SESSION_ID="e2e-keepalive-tampered-mount"
echo "--- Tamper turn 1: replace canonical workspace mount before idle admission ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$TAMPER_CHAT_THREAD_ID" \
  --session-id "$TAMPER_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'set -eu
touch /tmp/keepalive-tampered-mount-marker
cd /tmp
sudo mount -t tmpfs -o size=1m tmpfs /home/user/workspace' \
  || fail "Tamper turn 1 failed"

echo "--- Tamper turn 2: rejected sandbox is replaced with a valid fresh mount ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$TAMPER_CHAT_THREAD_ID" \
  --session-id "$TAMPER_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'set -eu
test ! -f /tmp/keepalive-tampered-mount-marker
source=$(findmnt -rn -o SOURCE --target /home/user/workspace)
test "$(readlink -f "$source")" = /dev/vdb' \
  || fail "Tamper turn 2 reused an unsafe sandbox or exposed the wrong workspace device"
echo "PASS: tampered workspace mount was rejected before reuse"

# Hold an independently owned runner-exec normal operation while the supervised
# turn completes. The atomic final-operation reservation must fail busy, and the
# sandbox must be destroyed instead of entering the idle pool.
OVERLAP_SESSION_ID="e2e-keepalive-overlapping-exec"
echo "--- Overlap turn 1: hold supervised turn open ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$OVERLAP_CHAT_THREAD_ID" \
  --session-id "$OVERLAP_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'set -eu
touch /tmp/keepalive-overlap-marker
rm -f /tmp/keepalive-overlap-release
mkfifo /tmp/keepalive-overlap-release
cat /tmp/keepalive-overlap-release >/dev/null' &
OVERLAP_SUBMIT_PID=$!

OVERLAP_SANDBOX_ID=""
OVERLAP_READY=false
for _ in $(seq 1 60); do
  if ! kill -0 "$OVERLAP_SUBMIT_PID" 2>/dev/null; then
    wait "$OVERLAP_SUBMIT_PID" 2>/dev/null || true
    OVERLAP_SUBMIT_PID=""
    fail "Overlap turn 1 exited before setup completed"
  fi
  OVERLAP_SANDBOX_ID=$(sudo jq -r '.active_runs[0].sandbox_id // empty' \
    "$RUNNER_DIR/status.json" 2>/dev/null || true)
  if [ -n "$OVERLAP_SANDBOX_ID" ] \
    && sudo timeout 3 "$BIN_DIR/runner" exec --timeout 2 \
      --sandbox "$OVERLAP_SANDBOX_ID" -- test -p /tmp/keepalive-overlap-release \
      2>/dev/null; then
    OVERLAP_READY=true
    break
  fi
  sleep 1
done
[ "$OVERLAP_READY" = true ] || fail "Overlap turn sandbox was not ready after 60s"

echo "--- Starting independently owned runner exec ---"
sudo timeout 90 "$BIN_DIR/runner" exec --timeout 80 \
  --sandbox "$OVERLAP_SANDBOX_ID" -- sh -c \
  'rm -f /tmp/keepalive-overlap-exec-release
mkfifo /tmp/keepalive-overlap-exec-release
touch /tmp/keepalive-overlap-exec-ready
cat /tmp/keepalive-overlap-exec-release >/dev/null' &
OVERLAP_EXEC_PID=$!

EXEC_READY=false
for _ in $(seq 1 30); do
  if ! kill -0 "$OVERLAP_EXEC_PID" 2>/dev/null; then
    wait "$OVERLAP_EXEC_PID" 2>/dev/null || true
    OVERLAP_EXEC_PID=""
    fail "Independent runner exec exited before idle admission"
  fi
  if sudo timeout 3 "$BIN_DIR/runner" exec --timeout 2 \
    --sandbox "$OVERLAP_SANDBOX_ID" -- test -f /tmp/keepalive-overlap-exec-ready \
    2>/dev/null; then
    EXEC_READY=true
    break
  fi
  sleep 1
done
[ "$EXEC_READY" = true ] || fail "Independent runner exec did not become active"

sudo timeout 20 "$BIN_DIR/runner" exec --timeout 15 \
  --sandbox "$OVERLAP_SANDBOX_ID" -- sh -c \
  'printf release > /tmp/keepalive-overlap-release' \
  || fail "Failed to release overlap turn"
if ! wait "$OVERLAP_SUBMIT_PID"; then
  OVERLAP_SUBMIT_PID=""
  fail "Overlap turn 1 failed"
fi
OVERLAP_SUBMIT_PID=""

for _ in $(seq 1 20); do
  if ! kill -0 "$OVERLAP_EXEC_PID" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
if kill -0 "$OVERLAP_EXEC_PID" 2>/dev/null; then
  kill "$OVERLAP_EXEC_PID" 2>/dev/null || true
  wait "$OVERLAP_EXEC_PID" 2>/dev/null || true
  OVERLAP_EXEC_PID=""
  fail "Independent runner exec remained alive after rejected sandbox destruction"
fi
wait "$OVERLAP_EXEC_PID" 2>/dev/null || true
OVERLAP_EXEC_PID=""

OVERLAP_LOGS=$(sudo journalctl --no-pager \
  "_SYSTEMD_INVOCATION_ID=$INVOCATION_ID" 2>&1) \
  || fail "failed to read overlap runner logs"
grep -F 'normal operations busy while preparing park' <<<"$OVERLAP_LOGS" >/dev/null \
  || fail "overlapping runner exec did not reject idle admission as busy"

echo "--- Overlap turn 2: busy sandbox was not reused ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$OVERLAP_CHAT_THREAD_ID" \
  --session-id "$OVERLAP_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'set -eu
test ! -f /tmp/keepalive-overlap-marker
source=$(findmnt -rn -o SOURCE --target /home/user/workspace)
test "$(readlink -f "$source")" = /dev/vdb' \
  || fail "Overlap turn 2 reused the sandbox rejected by the final-operation fence"
echo "PASS: overlapping runner exec could not produce a reusable sandbox"

# Regression gate for sandbox_id/run_id conflation (#9552):
# at this point the runner has parked idle VMs whose FC workspace
# names (= sandbox_id) are divorced from any active run_id.
# `runner doctor --name <svc>` must still report 0 warnings.
# Scope to this CI run's runner name so that unrelated runners
# sharing the metal host don't contaminate the check.
echo "--- runner doctor --name $SVC (expect 0 warnings) ---"
DOCTOR_OUT=$(sudo "$BIN_DIR/runner" doctor --name "$SVC" 2>&1 || true)
echo "$DOCTOR_OUT"
if ! grep -q '^0 warning(s) found$' <<<"$DOCTOR_OUT"; then
  fail "runner doctor reported warnings with parked idle VMs — regression for #9552"
fi
echo "PASS: runner doctor clean with parked VMs"

# Stop transient service (drains idle pool)
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
wait_for_unit_inactive
sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
trap - EXIT

echo "=== Keep-alive test passed ==="
REMOTE_SCRIPT
