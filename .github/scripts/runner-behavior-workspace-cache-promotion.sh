#!/usr/bin/env bash
set -euo pipefail

REMOTE="${METAL_USER}@${HOST}"
SVC="${JOB_REF}-workspace-cache-promotion"
GROUP="vm0/workspace-cache-promotion-${JOB_REF}"
RUNNER_DIR="/var/lib/vm0-runner/runners/${SVC}"
GROUP_DIR="/var/lib/vm0-runner/groups/vm0/workspace-cache-promotion-${JOB_REF}"
# JOB_REF is stable across reruns, while promoted cache entries outlive runner cleanup.
WORKFLOW_RUN_KEY="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"

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
ssh "$REMOTE" bash -s -- \
  "${BIN_DIR}" "${SVC}" "${GROUP}" "${RUNNER_DIR}" "${GROUP_DIR}" "${WORKFLOW_RUN_KEY}" <<'REMOTE_SCRIPT'
set -euo pipefail
BIN_DIR=$1; SVC=$2; GROUP=$3; RUNNER_DIR=$4; GROUP_DIR=$5; WORKFLOW_RUN_KEY=$6
UNIT="vm0-runner-${SVC}.service"
MAX_ATTEMPTS=3
PROMOTION_VERIFIED=false
SUBMIT_PID=""
WRITER_EXEC_PID=""
SANDBOX_ID=""
TURN1_INVOCATION_ID=""
TURN2_INVOCATION_ID=""

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

for ((ATTEMPT = 1; ATTEMPT <= MAX_ATTEMPTS; ATTEMPT++)); do
  SESSION_ID="e2e-workspace-cache-promotion-session-${WORKFLOW_RUN_KEY}-${ATTEMPT}"
  SUBMIT_PID=""
  WRITER_EXEC_PID=""
  SANDBOX_ID=""
  TURN1_INVOCATION_ID=""
  TURN2_INVOCATION_ID=""

  echo "--- Workspace cache promotion attempt ${ATTEMPT}/${MAX_ATTEMPTS} ---"
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
  wait_for_unit_inactive
  sudo rm -rf "$GROUP_DIR"

  echo "--- Starting runner ---"
  sudo "$BIN_DIR/runner" service start --name "$SVC" \
    --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

  for _ in $(seq 1 30); do
    TURN1_INVOCATION_ID=$(sudo systemctl show "$UNIT" \
      --property=InvocationID --value 2>/dev/null) || true
    [ -n "$TURN1_INVOCATION_ID" ] && break
    sleep 1
  done
  [ -n "$TURN1_INVOCATION_ID" ] || fail "turn 1 runner invocation ID unavailable"

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

  PROMOTION_LOGS=$(sudo journalctl --no-pager \
    "_SYSTEMD_INVOCATION_ID=$TURN1_INVOCATION_ID" 2>&1) \
    || fail "failed to read workspace cache promotion runner logs"
  if grep -F 'workspace image cache promotion skipped: capacity lock busy' \
    <<<"$PROMOTION_LOGS" >/dev/null; then
    if [ "$ATTEMPT" -eq "$MAX_ATTEMPTS" ]; then
      fail "Workspace cache promotion capacity lock remained busy after ${MAX_ATTEMPTS} attempts"
    fi
    echo "RETRY: workspace cache promotion capacity lock was busy on attempt ${ATTEMPT}"
    continue
  fi
  if ! grep -F 'workspace image cache promoted' \
    <<<"$PROMOTION_LOGS" >/dev/null; then
    echo "--- Workspace cache logs for invocation ${TURN1_INVOCATION_ID} ---"
    PROMOTION_LINES=$(grep -F 'workspace image cache' <<<"$PROMOTION_LOGS" || true)
    if [ -n "$PROMOTION_LINES" ]; then
      printf '%s\n' "$PROMOTION_LINES"
    else
      echo "No workspace image cache logs found"
    fi
    fail "Workspace cache turn 1 did not publish a reusable cache entry"
  fi

  # Clear the drain drop-in before starting a fresh transient service.
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
  sudo "$BIN_DIR/runner" service start --name "$SVC" \
    --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

  # Scope restore diagnostics to the restarted runner, never the promotion invocation.
  for _ in $(seq 1 30); do
    TURN2_INVOCATION_ID=$(sudo systemctl show "$UNIT" \
      --property=InvocationID --value 2>/dev/null) || true
    if [ -n "$TURN2_INVOCATION_ID" ] \
      && [ "$TURN2_INVOCATION_ID" != "$TURN1_INVOCATION_ID" ]; then
      break
    fi
    TURN2_INVOCATION_ID=""
    sleep 1
  done
  [ -n "$TURN2_INVOCATION_ID" ] || fail "turn 2 runner invocation ID unavailable"

  echo "--- Turn 2: restore promoted workspace ---"
  if sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
    --session-id "$SESSION_ID" \
    --feature-flag sandboxReuse=true \
    --prompt 'test "$(cat /home/user/workspace/cache-marker)" = workspace-cache-marker && test -s /home/user/workspace/live-writer && test ! -e /home/user/workspace/nested/ephemeral'; then
    echo "PASS: workspace cache restored after freeze-based promotion"
    PROMOTION_VERIFIED=true
    break
  fi

  RESTORE_LOGS=$(sudo journalctl --no-pager \
    "_SYSTEMD_INVOCATION_ID=$TURN2_INVOCATION_ID" 2>&1) \
    || fail "failed to read workspace cache restore runner logs"
  if grep -F 'workspace image cache lock busy or unavailable; using fresh workspace image' \
    <<<"$RESTORE_LOGS" >/dev/null \
    && grep -F 'lock is already held by another process' \
      <<<"$RESTORE_LOGS" >/dev/null; then
    if [ "$ATTEMPT" -eq "$MAX_ATTEMPTS" ]; then
      fail "Workspace cache restore entry lock remained busy after ${MAX_ATTEMPTS} attempts"
    fi
    echo "RETRY: workspace cache restore entry lock was busy on attempt ${ATTEMPT}"
    continue
  fi

  echo "--- Workspace cache logs for invocation ${TURN2_INVOCATION_ID} ---"
  RESTORE_LINES=$(grep -F 'workspace image cache' <<<"$RESTORE_LOGS" || true)
  if [ -n "$RESTORE_LINES" ]; then
    printf '%s\n' "$RESTORE_LINES"
  else
    echo "No workspace image cache logs found"
  fi
  fail "Workspace cache turn 2: promoted workspace state was not restored correctly"
done

[ "$PROMOTION_VERIFIED" = true ] || fail "Workspace cache promotion was not verified"

sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
wait_for_unit_inactive
sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
trap - EXIT

echo "=== Workspace cache promotion test passed ==="
REMOTE_SCRIPT
