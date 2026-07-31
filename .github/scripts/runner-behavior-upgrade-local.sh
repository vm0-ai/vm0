#!/usr/bin/env bash
set -euo pipefail

REMOTE="${METAL_USER}@${HOST}"
GROUP="vm0/upgrade-${JOB_REF}"

echo "=== Generating configs for runner A and B ==="
for SUFFIX in upgrade-a upgrade-b; do
  # shellcheck disable=SC2029
  ssh "$REMOTE" "sudo ${BIN_DIR}/runner config \
    --profile vm0/default \
    --rootfs-hash ${DEFAULT_ROOTFS_HASH} \
    --snapshot-hash ${DEFAULT_SNAPSHOT_HASH} \
    --name ${JOB_REF}-${SUFFIX} \
    --group ${GROUP} \
    --runner-dirname ${JOB_REF}-${SUFFIX} \
    --max-concurrent 2 \
    --api-url https://not-a-real-server.test \
    --token vm0_official_${OFFICIAL_RUNNER_SECRET}"
done

echo "=== Running upgrade test ==="
ssh "$REMOTE" bash -s -- "${BIN_DIR}" "${JOB_REF}" "${GROUP}" <<'REMOTE_SCRIPT'
BIN_DIR=$1; JOB_REF=$2; GROUP=$3
RUNNER_DIR_A="/var/lib/vm0-runner/runners/${JOB_REF}-upgrade-a"
RUNNER_DIR_B="/var/lib/vm0-runner/runners/${JOB_REF}-upgrade-b"
SVC_A="${JOB_REF}-upgrade-a"
SVC_B="${JOB_REF}-upgrade-b"
SUBMIT1_PID=""
SUBMIT2_PID=""

FAILED=0
fail() { FAILED=1; echo "FAIL: $1"; exit 1; }

cleanup_submit_pid() {
  local pid=$1
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

# Poll `systemctl is-active` with a bounded budget; fail if the unit
# is still active afterward so the EXIT trap dumps journalctl at the
# right diagnostic boundary (instead of hanging inside systemctl stop).
wait_for_exit() {
  # Budget must exceed the 10s heartbeat tick — drain can only
  # complete on a tick boundary, so anything <10s has no headroom
  # for real teardown work (idle pool + namespace cleanup
  # + mitm/dns/kmsg shutdown) and slow shutdown tails like
  # background memory prefetch. Shared metal-host contention can also make
  # namespace cleanup exceed 30s while it is still making progress, so allow
  # six heartbeat ticks before treating the drain as stuck. See issues #10869
  # and #13688.
  local svc=$1 budget=${2:-60}
  echo "--- Waiting up to ${budget}s for $svc to exit ---"
  for i in $(seq 1 "$budget"); do
    systemctl is-active --quiet "vm0-runner-${svc}" || return 0
    sleep 1
  done
  # One final check covers units that exit during the last sleep.
  systemctl is-active --quiet "vm0-runner-${svc}" || return 0
  fail "$svc still active after ${budget}s (stuck on drain?)"
}

cleanup() {
  echo "--- Cleanup: uninstalling services ---"
  sudo "$BIN_DIR/runner" service uninstall --name "$SVC_A" --force 2>/dev/null || true
  sudo "$BIN_DIR/runner" service uninstall --name "$SVC_B" --force 2>/dev/null || true
  cleanup_submit_pid "$SUBMIT2_PID"
  cleanup_submit_pid "$SUBMIT1_PID"
  if [ "$FAILED" -ne 0 ]; then
    echo "--- Cleanup: dumping logs (test failed) ---"
    journalctl --unit "vm0-runner-${SVC_A}" --lines 50 --no-pager 2>/dev/null || true
    journalctl --unit "vm0-runner-${SVC_B}" --lines 50 --no-pager 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Pre-cleanup: uninstall leftover services from previous CI runs
sudo "$BIN_DIR/runner" service uninstall --name "$SVC_A" --force 2>/dev/null || true
sudo "$BIN_DIR/runner" service uninstall --name "$SVC_B" --force 2>/dev/null || true

# 1. Install runner A
echo "--- Installing runner A ---"
sudo "$BIN_DIR/runner" service install --name "$SVC_A" \
  --config "$RUNNER_DIR_A/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

# 2. Submit job 1 (background, long-running) → only A running
echo "--- Submit job 1 (only A, long-running) ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" --prompt 'sleep 12 && echo job1' &
SUBMIT1_PID=$!

# 3. Install runner B while job 1 still in-flight on A
echo "--- Installing runner B ---"
sudo "$BIN_DIR/runner" service install --name "$SVC_B" \
  --config "$RUNNER_DIR_B/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

# 4. Submit job 2 (background, long-running) → A and B compete
echo "--- Submit job 2 (A and B compete, long-running) ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" --prompt 'sleep 12 && echo job2' &
SUBMIT2_PID=$!

# 5. Drain A while jobs may be in-flight
echo "--- Draining runner A ---"
sudo "$BIN_DIR/runner" service drain --name "$SVC_A"

# 6. Verify both jobs complete despite drain
echo "--- Waiting for job 1 ---"
wait "$SUBMIT1_PID" || fail "Job 1 failed"
SUBMIT1_PID=""
echo "--- Waiting for job 2 ---"
wait "$SUBMIT2_PID" || fail "Job 2 failed"
SUBMIT2_PID=""

# 7. Wait for A to exit after drain, then verify drain still disables
# an inactive-but-enabled installed unit.
wait_for_exit "$SVC_A"
echo "--- Re-enable inactive runner A, then drain again ---"
sudo systemctl enable --no-reload "vm0-runner-${SVC_A}.service"
sudo systemctl is-enabled --quiet "vm0-runner-${SVC_A}.service" \
  || fail "runner A should be enabled before inactive drain"
sudo "$BIN_DIR/runner" service drain --name "$SVC_A" \
  || fail "inactive drain of runner A failed"
if sudo systemctl is-enabled --quiet "vm0-runner-${SVC_A}.service"; then
  fail "runner A remained enabled after inactive drain"
fi
echo "PASS: inactive drain disabled runner A"

echo "--- Uninstalling runner A ---"
sudo "$BIN_DIR/runner" service uninstall --name "$SVC_A" --force

# 8. Submit job 3 → only B is left
echo "--- Submit job 3 (only B) ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" --prompt 'echo job3' || fail "Job 3 failed"

# 9. Drain B, wait for it to exit, then uninstall
echo "--- Draining runner B ---"
sudo "$BIN_DIR/runner" service drain --name "$SVC_B"
wait_for_exit "$SVC_B"
echo "--- Uninstalling runner B ---"
sudo "$BIN_DIR/runner" service uninstall --name "$SVC_B" --force
trap - EXIT

echo "=== Upgrade test passed ==="
REMOTE_SCRIPT
