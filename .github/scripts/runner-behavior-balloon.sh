#!/usr/bin/env bash
set -euo pipefail

REMOTE="${METAL_USER}@${HOST}"

echo "=== Generating config ==="
# shellcheck disable=SC2029
ssh "$REMOTE" "sudo ${BIN_DIR}/runner config \
  --profile vm0/default \
  --rootfs-hash ${DEFAULT_ROOTFS_HASH} \
  --snapshot-hash ${DEFAULT_SNAPSHOT_HASH} \
  --name ${JOB_REF}-balloon \
  --group vm0/balloon-${JOB_REF} \
  --runner-dirname ${JOB_REF}-balloon \
  --max-concurrent 2 \
  --api-url https://not-a-real-server.test \
  --token vm0_official_${OFFICIAL_RUNNER_SECRET}"

echo "=== Running balloon test ==="
ssh "$REMOTE" bash -s -- "${BIN_DIR}" "${JOB_REF}" <<'REMOTE_SCRIPT'
BIN_DIR=$1; JOB_REF=$2
RUNNER_DIR="/var/lib/vm0-runner/runners/${JOB_REF}-balloon"
SVC="${JOB_REF}-balloon"
GROUP="vm0/balloon-${JOB_REF}"
SUBMIT_PID=""
ALLOC_PID=""

fail() {
  echo "FAIL: $1"
  echo "--- Diagnostics ---"
  echo "Balloon stats:"
  sudo curl -sf --unix-socket "$API_SOCK" http://localhost/balloon/statistics 2>/dev/null \
    | jq . 2>/dev/null || echo "(unavailable)"
  echo "Host dmesg (last 10 lines):"
  sudo dmesg | tail -10 2>/dev/null || true
  exit 1
}

cleanup() {
  echo "--- Cleanup ---"
  if [ -n "$ALLOC_PID" ]; then
    kill "$ALLOC_PID" 2>/dev/null || true
  fi
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force || true
  if [ -n "$ALLOC_PID" ]; then
    wait "$ALLOC_PID" 2>/dev/null || true
  fi
  if [ -n "$SUBMIT_PID" ]; then
    kill "$SUBMIT_PID" 2>/dev/null || true
    wait "$SUBMIT_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Clean up any residual transient unit from a previous CI run.
# stop() returns Ok when no service exists, so any non-zero exit is
# a real cleanup failure.
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force \
  || fail "failed to stop residual balloon service"

# Start transient runner service
echo "--- Starting runner ---"
sudo "$BIN_DIR/runner" service start --name "$SVC" \
  --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true \
  || fail "failed to start balloon service"

# Submit a long-running job in background (keeps sandbox alive during tests)
echo "--- Submitting long-running job ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" --prompt 'sleep 360 && echo done' &
SUBMIT_PID=$!

# Helper: fail fast if the keepalive job exits before the balloon
# assertions finish. Otherwise a dead sandbox can look like
# actual_mib=0 and produce misleading follow-on failures.
ensure_submit_running() {
  if ! kill -0 "$SUBMIT_PID" 2>/dev/null; then
    wait "$SUBMIT_PID" 2>/dev/null || true
    SUBMIT_PID=""
    fail "keepalive submit exited before balloon test completed"
  fi
}

# Wait for sandbox control socket. Socket and api.sock paths use
# sandbox_id (distinct from run_id after #9552). `runner exec`
# resolves its CLI arg against sandbox_id sock dirs, so SANDBOX_ID
# is what we need here.
echo "--- Waiting for sandbox control socket ---"
for i in $(seq 1 60); do
  ensure_submit_running
  SANDBOX_ID=$(sudo jq -r '.active_runs[0].sandbox_id // empty' \
    "$RUNNER_DIR/status.json" 2>/dev/null)
  [ -n "$SANDBOX_ID" ] && [ -S "/run/vm0/sock/$SANDBOX_ID/control.sock" ] && break
  SANDBOX_ID=""
  sleep 1
done
[ -z "$SANDBOX_ID" ] && fail "control socket not found after 60s"
echo "Found sandbox: $SANDBOX_ID"

API_SOCK="/run/vm0/sock/$SANDBOX_ID/api.sock"

# Keep these recovery expectations aligned with balloon.rs: the controller
# polls every 5 seconds and inflates only when free_memory is above 384 MiB.
INFLATE_FREE_BOUNDARY_MIB=384
CONTROLLER_OBSERVATION_SECONDS=12
RECOVERY_POLL_SECONDS=2
RECOVERY_TIMEOUT_SECONDS=60

# Helper: read current balloon actual_mib (returns 0 if VM is dead)
balloon_mib() {
  local val
  val=$(sudo curl -sf --unix-socket "$API_SOCK" http://localhost/balloon/statistics \
    | jq -r '.actual_mib // 0' 2>/dev/null)
  echo "${val:-0}"
}

# Helper: read a validated target/actual/free-memory snapshot from one
# Firecracker response. The controller also truncates free_memory to MiB.
balloon_snapshot() {
  sudo curl -sf --unix-socket "$API_SOCK" http://localhost/balloon/statistics \
    | jq -er '
      [.target_mib, .actual_mib, .free_memory] as $values
      | select(all($values[]; type == "number" and . >= 0 and . == floor))
      | [
          $values[0],
          $values[1],
          ($values[2] / 1048576 | floor)
        ]
      | @tsv
    ' 2>/dev/null
}

# Helper: read guest MemAvailable in kB.
guest_avail_kb() {
  local output
  local val
  output=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- grep MemAvailable /proc/meminfo 2>/dev/null) || return 1
  val=$(printf '%s\n' "$output" | awk '/^MemAvailable:/ { print $2; exit }')
  case "$val" in
    ''|*[!0-9]*) return 1 ;;
  esac
  echo "$val"
}

# Helper: check if VM is still alive
vm_alive() {
  sudo curl -sf --unix-socket "$API_SOCK" http://localhost/ >/dev/null 2>&1
}

# Test 1: idle inflate — balloon controller gradually reclaims idle guest memory
# With per-tick cap (256 MiB), balloon inflates over multiple ticks.
echo "--- Test 1: balloon idle inflate ---"
ACTUAL=0
for i in $(seq 1 30); do
  ensure_submit_running
  ACTUAL=$(balloon_mib)
  [ "${ACTUAL:-0}" -gt 0 ] && break
  sleep 1
done
[ "$ACTUAL" -gt 0 ] || fail "balloon did not inflate: actual_mib=$ACTUAL"
echo "PASS: balloon idle inflate (actual_mib=$ACTUAL)"

# Wait for balloon to stabilize (enters hysteresis band)
echo "--- Waiting for balloon to stabilize ---"
PREV=0
STABLE_COUNT=0
for i in $(seq 1 30); do
  ensure_submit_running
  vm_alive || fail "VM exited during balloon stabilization"
  ACTUAL=$(balloon_mib)
  if [ "$ACTUAL" -eq "$PREV" ] && [ "$ACTUAL" -gt 0 ]; then
    STABLE_COUNT=$((STABLE_COUNT + 1))
    [ "$STABLE_COUNT" -ge 2 ] && break
  else
    STABLE_COUNT=0
  fi
  PREV=$ACTUAL
  sleep 3
done
INFLATE_MIB=$ACTUAL
[ "$INFLATE_MIB" -gt 0 ] || fail "balloon stabilized at zero; VM may have exited"
echo "Balloon stabilized at ${INFLATE_MIB} MiB"

# Verify guest-side: MemAvailable decreased
ensure_submit_running
AVAIL=$(guest_avail_kb) || fail "failed to read guest MemAvailable"
[ "$AVAIL" -gt 0 ] || fail "guest MemAvailable unavailable"
[ "$AVAIL" -lt 1536000 ] || fail "MemAvailable too high after balloon: ${AVAIL}kB (expected < 1536000kB)"
echo "PASS: guest MemAvailable reduced (${AVAIL}kB)"

# Test 2: deflate under memory pressure — allocate anonymous memory
# in the guest to push available below deflate threshold (192 MiB).
# Scale the allocator down when the idle balloon state already leaves
# limited guest headroom; otherwise the allocator can starve the
# keepalive job and mask the assertion as "cancelled by user".
# Trailing `# BALLOON_ALLOC_MARKER` is a unique string pkill can
# match on to terminate the guest-side allocator below.
echo "--- Test 2: balloon deflate under memory pressure ---"
MAX_PRESSURE_ALLOC_MIB=300
MIN_PRESSURE_REMAINING_MIB=128
MIN_PRESSURE_AVAIL_KB=$(( MIN_PRESSURE_REMAINING_MIB * 1024 ))
ensure_submit_running
PRE_PRESSURE_AVAIL_KB=$(guest_avail_kb) || fail "failed to read guest MemAvailable before pressure allocation"
if [ "$PRE_PRESSURE_AVAIL_KB" -le "$MIN_PRESSURE_AVAIL_KB" ]; then
  fail "guest MemAvailable too low before pressure allocation: ${PRE_PRESSURE_AVAIL_KB}kB (need > ${MIN_PRESSURE_AVAIL_KB}kB)"
fi
PRE_PRESSURE_AVAIL_MIB=$(( PRE_PRESSURE_AVAIL_KB / 1024 ))
PRESSURE_ALLOC_MIB=$(( PRE_PRESSURE_AVAIL_MIB - MIN_PRESSURE_REMAINING_MIB ))
if [ "$PRESSURE_ALLOC_MIB" -gt "$MAX_PRESSURE_ALLOC_MIB" ]; then
  PRESSURE_ALLOC_MIB=$MAX_PRESSURE_ALLOC_MIB
fi
[ "$PRESSURE_ALLOC_MIB" -gt 0 ] || fail "pressure allocation would be zero: ${PRE_PRESSURE_AVAIL_KB}kB available"
echo "Pre-pressure guest MemAvailable: ${PRE_PRESSURE_AVAIL_KB}kB; allocating ${PRESSURE_ALLOC_MIB}MiB"
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- python3 -c "import ctypes,time; b=bytearray(${PRESSURE_ALLOC_MIB}*1024*1024); ctypes.memset((ctypes.c_char*len(b)).from_buffer(b),1,len(b)); time.sleep(120)  # BALLOON_ALLOC_MARKER" &
ALLOC_PID=$!

# Wait for balloon to deflate (actual_mib decreases)
DEFLATED=0
for i in $(seq 1 30); do
  ensure_submit_running
  vm_alive || fail "VM exited during balloon deflate test"
  ACTUAL=$(balloon_mib)
  if [ "$ACTUAL" -lt "$INFLATE_MIB" ]; then
    DEFLATED=1
    break
  fi
  sleep 2
done
[ "$DEFLATED" -eq 1 ] || fail "balloon did not deflate: actual_mib=$ACTUAL (was $INFLATE_MIB)"
DEFLATE_MIB=$ACTUAL
echo "PASS: balloon deflated from ${INFLATE_MIB} to ${DEFLATE_MIB} MiB"

# Test 3: re-inflate after pressure released — kill the host-side
# exec first (prevents further output), then kill the guest-side
# allocator. The host kill does NOT propagate to the guest process
# because vsock-guest spawns it independently.
echo "--- Test 3: balloon re-inflate after pressure release ---"
kill "$ALLOC_PID" 2>/dev/null || true
wait "$ALLOC_PID" 2>/dev/null || true
ALLOC_PID=""

# Verify VM survived the memory pressure test
vm_alive || fail "VM crashed during memory pressure test"

# Kill guest-side allocator — Test 2 passing means the controller has
# already returned memory to the guest, enough for pkill exec.
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- pkill -f '[B]ALLOON_ALLOC_MARKER' 2>/dev/null || true

# A failed runner exec must not masquerade as allocator absence, so probe
# through a guest command that reports state while always exiting successfully.
ALLOCATOR_STOPPED=0
for i in $(seq 1 5); do
  if ! ALLOCATOR_STATE=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- \
    sh -c 'pgrep -f "[B]ALLOON_ALLOC_MARKER" >/dev/null; status=$?; if [ "$status" -eq 0 ]; then printf "running\n"; elif [ "$status" -eq 1 ]; then printf "stopped\n"; else exit "$status"; fi' \
    2>/dev/null); then
    fail "failed to verify guest pressure allocator state"
  fi
  case "$ALLOCATOR_STATE" in
    stopped)
      ALLOCATOR_STOPPED=1
      break
      ;;
    running)
      sleep 1
      ;;
    *)
      fail "unexpected guest pressure allocator state: $ALLOCATOR_STATE"
      ;;
  esac
done
[ "$ALLOCATOR_STOPPED" -eq 1 ] || fail "guest pressure allocator remained running"

# Accept either realized re-inflation or a stable state inside the controller's
# hysteresis band. Both sides must persist for a complete observation window so
# a single boundary crossing cannot determine the result.
RECOVERY_DEADLINE=$(( SECONDS + RECOVERY_TIMEOUT_SECONDS ))
HIGH_FREE_SINCE=""
LOW_FREE_SINCE=""
TARGET_RAISED=0
RECOVERY_RESULT=""
LAST_TARGET=$DEFLATE_MIB
LAST_ACTUAL=$DEFLATE_MIB
LAST_FREE_MIB=""
while [ "$SECONDS" -lt "$RECOVERY_DEADLINE" ]; do
  ensure_submit_running
  vm_alive || fail "VM exited during balloon re-inflate test"

  if ! SNAPSHOT=$(balloon_snapshot); then
    fail "failed to read valid balloon recovery statistics"
  fi
  IFS=$'\t' read -r LAST_TARGET LAST_ACTUAL LAST_FREE_MIB <<< "$SNAPSHOT"
  echo "Recovery snapshot: target=${LAST_TARGET}MiB actual=${LAST_ACTUAL}MiB free=${LAST_FREE_MIB}MiB"

  if [ "$LAST_TARGET" -gt "$DEFLATE_MIB" ]; then
    TARGET_RAISED=1
  fi
  if [ "$LAST_ACTUAL" -gt "$DEFLATE_MIB" ]; then
    RECOVERY_RESULT="re-inflated"
    break
  fi

  NOW=$SECONDS
  if [ "$LAST_FREE_MIB" -gt "$INFLATE_FREE_BOUNDARY_MIB" ]; then
    LOW_FREE_SINCE=""
    if [ -z "$HIGH_FREE_SINCE" ]; then
      HIGH_FREE_SINCE=$NOW
    fi
    if [ "$TARGET_RAISED" -eq 0 ] \
      && [ $(( NOW - HIGH_FREE_SINCE )) -ge "$CONTROLLER_OBSERVATION_SECONDS" ]; then
      fail "balloon controller did not respond above inflate boundary: target=${LAST_TARGET}MiB actual=${LAST_ACTUAL}MiB free=${LAST_FREE_MIB}MiB boundary=${INFLATE_FREE_BOUNDARY_MIB}MiB"
    fi
  else
    HIGH_FREE_SINCE=""
    if [ -z "$LOW_FREE_SINCE" ]; then
      LOW_FREE_SINCE=$NOW
    fi
    if [ $(( NOW - LOW_FREE_SINCE )) -ge "$CONTROLLER_OBSERVATION_SECONDS" ] \
      && [ "$LAST_TARGET" -eq "$LAST_ACTUAL" ]; then
      RECOVERY_RESULT="hysteresis-settled"
      break
    fi
  fi

  sleep "$RECOVERY_POLL_SECONDS"
done

case "$RECOVERY_RESULT" in
  re-inflated)
    echo "PASS: balloon re-inflated from ${DEFLATE_MIB} to ${LAST_ACTUAL} MiB (target=${LAST_TARGET}MiB free=${LAST_FREE_MIB}MiB)"
    ;;
  hysteresis-settled)
    echo "PASS: balloon settled inside inflate hysteresis (deflated=${DEFLATE_MIB}MiB target=${LAST_TARGET}MiB actual=${LAST_ACTUAL}MiB free=${LAST_FREE_MIB}MiB boundary=${INFLATE_FREE_BOUNDARY_MIB}MiB)"
    ;;
  *)
    if [ "$TARGET_RAISED" -eq 1 ]; then
      fail "balloon target increase was not realized before timeout: deflated=${DEFLATE_MIB}MiB target=${LAST_TARGET}MiB actual=${LAST_ACTUAL}MiB free=${LAST_FREE_MIB:-unknown}MiB"
    fi
    fail "balloon recovery did not reach a stable outcome: deflated=${DEFLATE_MIB}MiB target=${LAST_TARGET}MiB actual=${LAST_ACTUAL}MiB free=${LAST_FREE_MIB:-unknown}MiB"
    ;;
esac

# Stop transient service
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force \
  || fail "failed to stop balloon service"
kill "$SUBMIT_PID" 2>/dev/null || true
wait "$SUBMIT_PID" 2>/dev/null || true
trap - EXIT

echo "=== Balloon test passed ==="
REMOTE_SCRIPT
