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
CACHE_SESSION_ID="e2e-workspace-cache-promotion-session"

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

# Turn 1: submit job with session ID and sandboxReuse flag — creates a marker file in guest
echo "--- Turn 1: create marker file ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --session-id "$SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'touch /tmp/keepalive-marker && echo turn1-done' \
  || fail "Turn 1 failed"

# Turn 2: submit job with same session ID and flag — should reuse the VM.
# If VM was reused, the marker file from turn 1 still exists (exit 0).
# If a new VM was created, the file is missing and test exits non-zero.
echo "--- Turn 2: verify marker file persists (VM reused) ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --session-id "$SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'test -f /tmp/keepalive-marker' \
  || fail "Turn 2: marker file not found — VM was not reused"
echo "PASS: Turn 2 completed (VM reused, filesystem persisted)"

# Turn 3: submit with a DIFFERENT session — should create a new VM.
# The marker file must NOT exist in the new VM (session isolation).
echo "--- Turn 3: different session creates new VM ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --session-id "different-session" \
  --feature-flag sandboxReuse=true \
  --prompt 'test ! -f /tmp/keepalive-marker' \
  || fail "Turn 3: marker file found — session isolation broken"
echo "PASS: Turn 3 completed (new VM for different session)"

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

# Exercise the terminal workspace-cache promotion path with guest references
# that make clean unmount unreliable: a nested mount and a detached writer
# whose cwd and open file descriptor both point into the workspace.
echo "--- Workspace cache turn 1: create live workspace state ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --session-id "$CACHE_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'set -eu
printf "workspace-cache-marker\n" > /home/user/workspace/cache-marker
printf "writer-start\n" > /home/user/workspace/live-writer
mkdir -p /home/user/workspace/nested
sudo mount -t tmpfs -o size=1m tmpfs /home/user/workspace/nested
sudo touch /home/user/workspace/nested/ephemeral
setsid -f sh -c "cd /home/user/workspace && exec 3>>live-writer && while :; do printf x >&3; sleep 0.05; done" </dev/null >/dev/null 2>&1
test -f /home/user/workspace/nested/ephemeral' \
  || fail "Workspace cache turn 1 failed"

# Drain while Firecracker is still owned by the runner so idle teardown can
# unpark, freeze, stop, and promote the workspace before the service exits.
echo "--- Draining runner to force workspace cache promotion ---"
sudo "$BIN_DIR/runner" service drain --name "$SVC"
wait_for_unit_inactive
# Clear the drain drop-in before starting a fresh transient service.
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
sudo "$BIN_DIR/runner" service start --name "$SVC" \
  --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

echo "--- Workspace cache turn 2: restore promoted workspace ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --session-id "$CACHE_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'test "$(cat /home/user/workspace/cache-marker)" = workspace-cache-marker && test -s /home/user/workspace/live-writer && test ! -e /home/user/workspace/nested/ephemeral' \
  || fail "Workspace cache turn 2: promoted workspace state was not restored correctly"
echo "PASS: workspace cache restored after freeze-based promotion"

# Stop transient service (drains idle pool)
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
wait_for_unit_inactive
sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
trap - EXIT

echo "=== Keep-alive test passed ==="
REMOTE_SCRIPT
