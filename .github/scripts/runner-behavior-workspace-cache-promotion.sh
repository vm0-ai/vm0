#!/usr/bin/env bash
set -euo pipefail

REMOTE="${METAL_USER}@${HOST}"
SVC="${JOB_REF}-workspace-cache-promotion"
GROUP="vm0/workspace-cache-promotion-${JOB_REF}"
RUNNER_DIR="/var/lib/vm0-runner/runners/${SVC}"
GROUP_DIR="/var/lib/vm0-runner/groups/vm0/workspace-cache-promotion-${JOB_REF}"

echo "=== Cleaning stale workspace cache promotion runner state ==="
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
  --max-concurrent 1 \
  --api-url https://not-a-real-server.test \
  --token vm0_official_${OFFICIAL_RUNNER_SECRET}"

echo "=== Running workspace cache promotion test ==="
ssh "$REMOTE" bash -s -- "${BIN_DIR}" "${SVC}" "${GROUP}" "${RUNNER_DIR}" "${GROUP_DIR}" <<'REMOTE_SCRIPT'
set -euo pipefail
BIN_DIR=$1; SVC=$2; GROUP=$3; RUNNER_DIR=$4; GROUP_DIR=$5
UNIT="vm0-runner-${SVC}.service"
SESSION_ID="e2e-workspace-cache-promotion-session"
SUBMIT_PID=""
WRITER_EXEC_PID=""
SANDBOX_ID=""

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
  if [ -n "$WRITER_EXEC_PID" ]; then
    kill "$WRITER_EXEC_PID" 2>/dev/null || true
    wait "$WRITER_EXEC_PID" 2>/dev/null || true
  fi
  if [ -n "$SUBMIT_PID" ]; then
    kill "$SUBMIT_PID" 2>/dev/null || true
    wait "$SUBMIT_PID" 2>/dev/null || true
  fi
  sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
}
trap cleanup EXIT

sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
wait_for_unit_inactive
sudo rm -rf "$GROUP_DIR"

echo "--- Starting runner ---"
sudo "$BIN_DIR/runner" service start --name "$SVC" \
  --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

# Keep the supervised turn active while an independently owned runner exec
# creates the live writer. Supervised descendants are reclaimed before
# promotion, so creating the writer from the turn would not exercise the
# freeze boundary.
echo "--- Turn 1: create live workspace state ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --session-id "$SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'set -eu
rm -f /tmp/vm0-workspace-cache-release
mkfifo /tmp/vm0-workspace-cache-release
printf "workspace-cache-marker\n" > /home/user/workspace/cache-marker
mkdir -p /home/user/workspace/nested
sudo mount -t tmpfs -o size=1m tmpfs /home/user/workspace/nested
sudo touch /home/user/workspace/nested/ephemeral
cat /tmp/vm0-workspace-cache-release >/dev/null' &
SUBMIT_PID=$!

echo "--- Waiting for active workspace sandbox ---"
SANDBOX_READY=false
for _ in $(seq 1 60); do
  if ! kill -0 "$SUBMIT_PID" 2>/dev/null; then
    wait "$SUBMIT_PID" 2>/dev/null || true
    SUBMIT_PID=""
    fail "Workspace cache turn 1 exited before setup completed"
  fi
  SANDBOX_ID=$(sudo jq -r '.active_runs[0].sandbox_id // empty' \
    "$RUNNER_DIR/status.json" 2>/dev/null || true)
  if [ -n "$SANDBOX_ID" ] \
    && sudo timeout 3 "$BIN_DIR/runner" exec --timeout 2 \
      --sandbox "$SANDBOX_ID" -- sh -c \
      'test -p /tmp/vm0-workspace-cache-release && test -f /home/user/workspace/nested/ephemeral' \
      2>/dev/null; then
    SANDBOX_READY=true
    break
  fi
  sleep 1
done
[ "$SANDBOX_READY" = true ] || fail "Active workspace sandbox was not ready after 60s"

echo "--- Starting independent live workspace writer ---"
sudo "$BIN_DIR/runner" exec --timeout 240 --sandbox "$SANDBOX_ID" -- sh -c \
  'cd /home/user/workspace && exec 3>>live-writer && printf "writer-start\n" >&3 && while :; do printf x >&3; sleep 0.05; done' &
WRITER_EXEC_PID=$!

WRITER_READY=false
for _ in $(seq 1 30); do
  if ! kill -0 "$WRITER_EXEC_PID" 2>/dev/null; then
    wait "$WRITER_EXEC_PID" 2>/dev/null || true
    WRITER_EXEC_PID=""
    fail "Independent workspace writer exited before promotion"
  fi
  WRITER_SIZE=$(sudo "$BIN_DIR/runner" exec --timeout 2 \
    --sandbox "$SANDBOX_ID" -- stat -c %s /home/user/workspace/live-writer \
    2>/dev/null || true)
  case "$WRITER_SIZE" in
    ''|*[!0-9]*) ;;
    *)
      if [ "$WRITER_SIZE" -gt 13 ]; then
        WRITER_READY=true
        break
      fi
      ;;
  esac
  sleep 1
done
[ "$WRITER_READY" = true ] || fail "Independent workspace writer did not become active"

# Enter draining while both the supervised turn and independent writer are
# live. Releasing the turn then drives freeze, stop, and promotion without
# allowing a supervised-descendant cleanup to remove the writer first.
echo "--- Draining runner to promote the workspace cache ---"
sudo "$BIN_DIR/runner" service drain --name "$SVC"
kill -0 "$WRITER_EXEC_PID" 2>/dev/null \
  || fail "Independent workspace writer was not live before the freeze boundary"
sudo timeout 20 "$BIN_DIR/runner" exec --timeout 15 \
  --sandbox "$SANDBOX_ID" -- sh -c \
  'printf release > /tmp/vm0-workspace-cache-release' \
  || fail "Failed to release workspace cache turn 1"
if ! wait "$SUBMIT_PID"; then
  SUBMIT_PID=""
  fail "Workspace cache turn 1 failed"
fi
SUBMIT_PID=""
wait_for_unit_inactive
wait "$WRITER_EXEC_PID" 2>/dev/null || true
WRITER_EXEC_PID=""

# Clear the drain drop-in before starting a fresh transient service.
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
sudo "$BIN_DIR/runner" service start --name "$SVC" \
  --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

echo "--- Turn 2: restore promoted workspace ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --session-id "$SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'test "$(cat /home/user/workspace/cache-marker)" = workspace-cache-marker && test -s /home/user/workspace/live-writer && test ! -e /home/user/workspace/nested/ephemeral' \
  || fail "Workspace cache turn 2: promoted workspace state was not restored correctly"
echo "PASS: workspace cache restored after freeze-based promotion"

sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
wait_for_unit_inactive
sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
trap - EXIT

echo "=== Workspace cache promotion test passed ==="
REMOTE_SCRIPT
