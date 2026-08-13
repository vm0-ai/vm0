#!/usr/bin/env bash
set -euo pipefail

REMOTE="${METAL_USER}@${HOST}"
SVC="${JOB_REF}-process-containment"
GROUP="vm0/process-containment-${JOB_REF}"
RUNNER_DIR="/var/lib/vm0-runner/runners/${SVC}"
GROUP_DIR="/var/lib/vm0-runner/groups/vm0/process-containment-${JOB_REF}"

echo "=== Cleaning stale process-containment runner state ==="
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

echo "=== Running process-containment test ==="
ssh "$REMOTE" bash -s -- "${BIN_DIR}" "${SVC}" "${GROUP}" "${RUNNER_DIR}" "${GROUP_DIR}" <<'REMOTE_SCRIPT'
set -euo pipefail
BIN_DIR=$1; SVC=$2; GROUP=$3; RUNNER_DIR=$4; GROUP_DIR=$5
UNIT="vm0-runner-${SVC}.service"
SESSION_ID="e2e-process-containment-session"
CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
PRESSURE_SUBMIT_PID=""
PRESSURE_SUBMIT_OUTPUT=""

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
  if [ -n "$PRESSURE_SUBMIT_PID" ]; then
    kill "$PRESSURE_SUBMIT_PID" 2>/dev/null || true
    wait "$PRESSURE_SUBMIT_PID" 2>/dev/null || true
  fi
  if [ -n "$PRESSURE_SUBMIT_OUTPUT" ]; then
    rm -f "$PRESSURE_SUBMIT_OUTPUT"
  fi
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force || true
  wait_for_unit_inactive
  sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
}
trap cleanup EXIT

sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
wait_for_unit_inactive
sudo rm -rf "$GROUP_DIR"

echo "--- Starting runner ---"
sudo "$BIN_DIR/runner" service start --name "$SVC" \
  --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

for _ in $(seq 1 30); do
  INVOCATION_ID=$(sudo systemctl show "$UNIT" --property=InvocationID --value 2>/dev/null) || true
  [ -n "$INVOCATION_ID" ] && break
  sleep 1
done
[ -n "${INVOCATION_ID:-}" ] || fail "runner invocation ID unavailable"

LEAK_PROMPT=$(cat <<'PROMPT'
set -eu
marker=/tmp/vm0-process-containment
rm -rf "$marker"
mkdir -p "$marker"
touch "$marker/vm-reuse-marker"

base=/sys/fs/cgroup/vm0-exec
relative=$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)
case "$relative" in
  /vm0-exec/exec-*/workload) ;;
  *) echo "agent CLI is outside workload cgroup: $relative" >&2; exit 1 ;;
esac
operation=${relative%/workload}
parent="/sys/fs/cgroup$operation"
test -d "$parent/control"
test -d "$parent/workload"
for controller in cpu memory pids; do
  grep -qw "$controller" "$base/cgroup.subtree_control"
  grep -qw "$controller" "$parent/cgroup.subtree_control"
done
expected_control_memory_min=$((384 * 1024 * 1024))
test "$(cat "$base/memory.min")" = "$expected_control_memory_min"
test "$(cat "$parent/memory.min")" = "$expected_control_memory_min"
test "$(cat "$parent/control/memory.min")" = "$expected_control_memory_min"
grep -Eq '^[0-9]+ [0-9]+$' "$parent/workload/cpu.max"
grep -Eq '^[0-9]+$' "$parent/workload/memory.high"
grep -Eq '^[0-9]+$' "$parent/workload/memory.max"
grep -Eq '^[0-9]+$' "$parent/workload/pids.max"
test -z "${VM0_WORKLOAD_CGROUP_PROCS_ENDPOINT:-}"
control_pid=$(head -n 1 "$parent/control/cgroup.procs")
test -n "$control_pid"
if ls "/proc/$control_pid/fd" >/dev/null 2>&1; then
  echo "workload can inspect Guest Agent descriptors" >&2
  exit 1
fi
if printf 0 > "$parent/control/cgroup.procs" 2>/dev/null; then
  echo "workload can move itself into the control cgroup" >&2
  exit 1
fi

setsid python3 -c 'import os, pathlib, signal, time; p=pathlib.Path("/tmp/vm0-process-containment/user.identity"); fields=pathlib.Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split(); signal.signal(signal.SIGTERM, signal.SIG_IGN); p.write_text(f"{os.getpid()} {fields[19]}\n"); time.sleep(300)' </dev/null >"$marker/user.launch.log" 2>&1 &
user_launcher_pid=$!
setsid sudo -n python3 -c 'import os, pathlib, time; p=pathlib.Path("/tmp/vm0-process-containment/root.identity"); fields=pathlib.Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split(); p.write_text(f"{os.getpid()} {fields[19]}\n"); time.sleep(300)' </dev/null >"$marker/root.launch.log" 2>&1 &
root_launcher_pid=$!

fixture_fail() {
  local name=$1
  local exit_code=$2
  shift 2
  local log="$marker/$name.launch.log"
  echo "$name descendant setup failed: $*" >&2
  if [ -s "$log" ]; then
    echo "--- $name launcher log ---" >&2
    cat "$log" >&2
  fi
  exit "$exit_code"
}

launcher_is_alive() {
  local pid=$1
  local stat state
  if ! IFS= read -r stat 2>/dev/null < "/proc/$pid/stat"; then
    return 1
  fi
  stat=${stat##*) }
  state=${stat%% *}
  case "$state" in
    Z|X|x) return 1 ;;
    *) return 0 ;;
  esac
}

verify_live_identity() {
  local name=$1
  local exit_code=$2
  local identity="$marker/$name.identity"
  local pid start_time current_identity current_state current_start

  if ! read -r pid start_time < "$identity"; then
    fixture_fail "$name" "$exit_code" "invalid identity file"
  fi
  if ! current_identity=$(awk '{sub(/^.*\) /, ""); print $1, $20}' "/proc/$pid/stat" 2>/dev/null); then
    fixture_fail "$name" "$exit_code" "process $pid exited"
  fi
  current_state=${current_identity%% *}
  current_start=${current_identity#* }
  case "$current_state" in
    Z|X|x) fixture_fail "$name" "$exit_code" "process $pid is in state $current_state" ;;
  esac
  [ "$current_start" = "$start_time" ] \
    || fixture_fail "$name" "$exit_code" "process $pid identity changed"
}

for _ in $(seq 1 200); do
  [ -s "$marker/user.identity" ] && [ -s "$marker/root.identity" ] && break
  if [ ! -s "$marker/user.identity" ] \
    && ! launcher_is_alive "$user_launcher_pid"; then
    if wait "$user_launcher_pid"; then
      user_status=0
    else
      user_status=$?
    fi
    fixture_fail user 10 "launcher exited before publishing identity (status=$user_status)"
  fi
  if [ ! -s "$marker/root.identity" ] \
    && ! launcher_is_alive "$root_launcher_pid"; then
    if wait "$root_launcher_pid"; then
      root_status=0
    else
      root_status=$?
    fi
    fixture_fail root 11 "launcher exited before publishing identity (status=$root_status)"
  fi
  sleep 0.05
done
[ -s "$marker/user.identity" ] \
  || fixture_fail user 12 "readiness deadline exceeded"
[ -s "$marker/root.identity" ] \
  || fixture_fail root 13 "readiness deadline exceeded"
verify_live_identity user 14
verify_live_identity root 15

# Persist adversarial login profiles for the next reuse turn. Production
# Guest Agent bootstrap must use a non-login shell and SCM_RIGHTS, so neither
# profile can run before the trusted binary or retain a placement capability.
cat > "$HOME/.profile" <<'PROFILE'
touch /tmp/vm0-process-containment/profile-executed
for descriptor in /proc/self/fd/*; do
  target=$(readlink "$descriptor" 2>/dev/null || true)
  case "$target" in
    */workload/cgroup.procs)
      printf '%s\n' "$target" > /tmp/vm0-process-containment/profile-capability
      ;;
  esac
done
(sleep 300) &
PROFILE
cp "$HOME/.profile" "$HOME/.bash_profile"
cat > "$HOME/.vm0-bootstrap-env" <<'BASH_ENV'
touch /tmp/vm0-process-containment/pam-environment-executed
BASH_ENV
cat > "$HOME/.pam_environment" <<'PAM_ENV'
BASH_ENV DEFAULT=/home/user/.vm0-bootstrap-env
PAM_ENV
echo containment-turn-1
PROMPT
)

echo "--- Turn 1: leave detached user/root descendants ---"
if TURN1_RESULT=$(sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$CHAT_THREAD_ID" \
  --session-id "$SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt "$LEAK_PROMPT"); then
  printf '%s\n' "$TURN1_RESULT"
else
  printf '%s\n' "$TURN1_RESULT"
  TURN1_EXIT_CODE=$(jq -r '.exit_code // empty' <<<"$TURN1_RESULT" 2>/dev/null) || true
  case "$TURN1_EXIT_CODE" in
    10) fail "Turn 1 user launcher exited before readiness" ;;
    11) fail "Turn 1 root launcher exited before readiness" ;;
    12) fail "Turn 1 user descendant readiness timed out" ;;
    13) fail "Turn 1 root descendant readiness timed out" ;;
    14) fail "Turn 1 user descendant published an invalid process identity" ;;
    15) fail "Turn 1 root descendant published an invalid process identity" ;;
    *) fail "Turn 1 failed" ;;
  esac
fi

VERIFY_PROMPT=$(cat <<'PROMPT'
set -eu
marker=/tmp/vm0-process-containment
base=/sys/fs/cgroup/vm0-exec
test -f "$marker/vm-reuse-marker"
if [ -e "$marker/profile-executed" ]; then
  echo "sandbox login profile executed before Guest Agent" >&2
  exit 1
fi
if [ -e "$marker/profile-capability" ]; then
  echo "sandbox login profile observed workload placement capability" >&2
  exit 1
fi
if [ -e "$marker/pam-environment-executed" ]; then
  echo "sandbox PAM environment executed code before Guest Agent" >&2
  exit 1
fi
rm -f "$HOME/.profile" "$HOME/.bash_profile" \
  "$HOME/.pam_environment" "$HOME/.vm0-bootstrap-env"

for identity in "$marker/user.identity" "$marker/root.identity"; do
  read -r pid start_time < "$identity"
  if current_identity=$(awk '{sub(/^.*\) /, ""); print $1, $20}' "/proc/$pid/stat" 2>/dev/null); then
    current_state=${current_identity%% *}
    current_start=${current_identity#* }
    case "$current_state" in
      Z|X|x) ;;
      *)
        [ "$current_start" != "$start_time" ] || {
          echo "recorded descendant is still running: $identity pid=$pid" >&2
          exit 1
        }
        ;;
    esac
  fi
done

relative=$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)
case "$relative" in
  /vm0-exec/exec-*/workload) ;;
  *) echo "unexpected current cgroup: $relative" >&2; exit 1 ;;
esac
operation=${relative%/workload}
own_group=${operation##*/}
test -n "$own_group"
test -d "$base/$own_group"
test -d "$base/$own_group/control"
test -d "$base/$own_group/workload"
test -z "$(find "$base" -mindepth 1 -maxdepth 1 -type d ! -name "$own_group" -print -quit)"
grep -q '^populated 1$' "$base/cgroup.events"
for controller in cpu memory pids; do
  grep -qw "$controller" "$base/cgroup.subtree_control"
  grep -qw "$controller" "$base/$own_group/cgroup.subtree_control"
done
echo containment-turn-2
PROMPT
)

echo "--- Turn 2: prove descendants are gone and only this turn is owned ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$CHAT_THREAD_ID" \
  --session-id "$SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt "$VERIFY_PROMPT" \
  || fail "Turn 2 failed; VM was not safely reused"

echo "--- Turn 3: prove healthy Turn 2 cleanup was also reusable ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$CHAT_THREAD_ID" \
  --session-id "$SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'test -f /tmp/vm0-process-containment/vm-reuse-marker' \
  || fail "Turn 3 failed; healthy cleanup did not re-enter reuse"

echo "--- Pressure: sustain CPU saturation with live process control ---"
PRESSURE_CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
PRESSURE_SESSION_ID="e2e-process-containment-pressure"
PRESSURE_SUBMIT_OUTPUT=$(mktemp)
# Queue one input immediately while this script resolves the sandbox. Keep the
# final input after the pressure command so the mock turn cannot finish first.
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --timeout 45 \
  --chat-thread-id "$PRESSURE_CHAT_THREAD_ID" \
  --session-id "$PRESSURE_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt '@active-input-smoke:5' \
  --active-input 'after=100ms,text=cpu-pressure-ready' \
  --active-input 'after=2s,text=cpu-pressure-one' \
  --active-input 'after=4s,text=cpu-pressure-two' \
  --active-input 'after=6s,text=cpu-pressure-three' \
  --active-input 'after=9s,text=cpu-pressure-finish' \
  >"$PRESSURE_SUBMIT_OUTPUT" 2>&1 &
PRESSURE_SUBMIT_PID=$!

PRESSURE_RUN_ID=""
PRESSURE_SANDBOX_ID=""
for _ in $(seq 1 60); do
  if ! kill -0 "$PRESSURE_SUBMIT_PID" 2>/dev/null; then
    wait "$PRESSURE_SUBMIT_PID" 2>/dev/null || true
    PRESSURE_SUBMIT_PID=""
    cat "$PRESSURE_SUBMIT_OUTPUT"
    fail "CPU-pressure submit exited before its sandbox became ready"
  fi
  mapfile -t CLAIM_FILES < <(
    sudo find "$GROUP_DIR/claims" -maxdepth 1 -type f -name '*.claim' \
      -printf '%f\n' 2>/dev/null | sort
  )
  [ "${#CLAIM_FILES[@]}" -le 1 ] \
    || fail "expected one CPU-pressure claim, found ${#CLAIM_FILES[@]}"
  if [ "${#CLAIM_FILES[@]}" -eq 1 ]; then
    PRESSURE_RUN_ID=${CLAIM_FILES[0]%.claim}
    PRESSURE_SANDBOX_ID=$(sudo jq -r --arg run_id "$PRESSURE_RUN_ID" \
      '.active_runs[]? | select(.run_id == $run_id) | .sandbox_id' \
      "$RUNNER_DIR/status.json" 2>/dev/null)
    if [ -n "$PRESSURE_SANDBOX_ID" ] \
      && [ -S "/run/vm0/sock/$PRESSURE_SANDBOX_ID/control.sock" ]; then
      break
    fi
  fi
  PRESSURE_SANDBOX_ID=""
  sleep 1
done
[ -n "$PRESSURE_SANDBOX_ID" ] \
  || fail "CPU-pressure sandbox did not become ready"

CPU_PRESSURE_SECONDS=6
CPU_PRESSURE_COMMAND=$(cat <<'SCRIPT'
set -eu
duration=$1
relative=$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)
case "$relative" in
  /vm0-exec/exec-*/workload) ;;
  *) echo "CPU pressure is outside workload cgroup: $relative" >&2; exit 1 ;;
esac
workload="/sys/fs/cgroup$relative"
before=$(awk '$1 == "nr_throttled" { print $2 }' "$workload/cpu.stat")
worker_count=$(( $(getconf _NPROCESSORS_ONLN) * 4 ))
worker_pids=""
cleanup_workers() {
  if [ -n "$worker_pids" ]; then
    kill $worker_pids 2>/dev/null || true
    wait $worker_pids 2>/dev/null || true
  fi
}
trap cleanup_workers EXIT INT TERM
worker=0
while [ "$worker" -lt "$worker_count" ]; do
  yes >/dev/null &
  worker_pids="$worker_pids $!"
  worker=$((worker + 1))
done
sleep "$duration"
after=$(awk '$1 == "nr_throttled" { print $2 }' "$workload/cpu.stat")
[ "$after" -gt "$before" ] \
  || { echo "CPU quota did not throttle the workload" >&2; exit 1; }
echo "cpu-pressure-complete throttled_periods=$((after - before))"
SCRIPT
)
SECONDS=0
CPU_PRESSURE_RESULT=$(sudo "$BIN_DIR/runner" exec \
  --timeout 30 \
  --sandbox "$PRESSURE_SANDBOX_ID" \
  -- sh -c "$CPU_PRESSURE_COMMAND" sh "$CPU_PRESSURE_SECONDS") \
  || fail "concurrent ordinary-exec CPU pressure failed"
CPU_PRESSURE_ELAPSED=$SECONDS
printf '%s\n' "$CPU_PRESSURE_RESULT"
[ "$CPU_PRESSURE_ELAPSED" -ge "$CPU_PRESSURE_SECONDS" ] \
  || fail "CPU pressure ended early after ${CPU_PRESSURE_ELAPSED}s"

if wait "$PRESSURE_SUBMIT_PID"; then
  PRESSURE_SUBMIT_STATUS=0
else
  PRESSURE_SUBMIT_STATUS=$?
fi
PRESSURE_SUBMIT_PID=""
cat "$PRESSURE_SUBMIT_OUTPUT"
[ "$PRESSURE_SUBMIT_STATUS" -eq 0 ] \
  || fail "process control did not remain live during CPU pressure"
PRESSURE_SUBMIT_JSON=$(awk '/^\{/{line=$0} END{print line}' "$PRESSURE_SUBMIT_OUTPUT")
[ -n "$PRESSURE_SUBMIT_JSON" ] \
  || fail "CPU-pressure submit did not return a JSON result"
SUBMITTED_PRESSURE_RUN_ID=$(jq -r '.run_id // empty' <<<"$PRESSURE_SUBMIT_JSON")
[ "$SUBMITTED_PRESSURE_RUN_ID" = "$PRESSURE_RUN_ID" ] \
  || fail "CPU-pressure result run ID did not match its claim"
PRESSURE_STREAM_LOG="/var/lib/vm0-runner/logs/system-stream-${PRESSURE_RUN_ID}.log"
PRESSURE_METRICS_LOG="/var/lib/vm0-runner/logs/metrics-${PRESSURE_RUN_ID}.jsonl"
sudo grep -F -q \
  'RESULT=cpu-pressure-ready+cpu-pressure-one+cpu-pressure-two+cpu-pressure-three+cpu-pressure-finish' \
  "$PRESSURE_STREAM_LOG" \
  || fail "CPU-pressure active inputs were not all consumed in order"

METRICS_SUMMARY=$(sudo jq -sr '
  [
    .[]
    | .ts
    | sub("\\.[0-9]+Z$"; "Z")
    | fromdateiso8601
  ] as $samples
  | if ($samples | length) < 2 then
      error("insufficient metric samples")
    else
      [
        ($samples | length),
        ($samples[-1] - $samples[0]),
        ([range(1; ($samples | length)) as $index
          | $samples[$index] - $samples[$index - 1]] | max)
      ]
      | @tsv
    end
' "$PRESSURE_METRICS_LOG") \
  || fail "failed to summarize CPU-pressure Guest metrics"
read -r METRICS_COUNT METRICS_SPAN_SECS METRICS_MAX_GAP_SECS <<<"$METRICS_SUMMARY"
[ "$METRICS_SPAN_SECS" -ge 4 ] \
  || fail "Guest control metrics did not remain live during CPU pressure: ${METRICS_SPAN_SECS}s"
[ "$METRICS_MAX_GAP_SECS" -le 15 ] \
  || fail "Guest control metric cadence exceeded 15s: ${METRICS_MAX_GAP_SECS}s"
rm -f "$PRESSURE_SUBMIT_OUTPUT"
PRESSURE_SUBMIT_OUTPUT=""

echo "--- Pressure: exhaust workload memory without killing Guest Agent ---"
MEMORY_CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
MEMORY_SESSION_ID="e2e-process-containment-memory"
MEMORY_PROMPT=$(cat <<'PROMPT'
sudo -n python3 - <<'PY'
import pathlib
import time

relative = next(
    line.removeprefix("0::").strip()
    for line in pathlib.Path("/proc/self/cgroup").read_text().splitlines()
    if line.startswith("0::")
)
workload = pathlib.Path(f"/sys/fs/cgroup{relative}")
# Disable soft-limit throttling for this smoke so reclaim cannot postpone the
# workload-local OOM. The production memory.high policy is covered above.
(workload / "memory.high").write_text("max")
(workload / "memory.max").write_text(str(256 * 1024 * 1024))
chunk_size = 16 * 1024 * 1024
chunks = []
while True:
    chunk = bytearray(chunk_size)
    for offset in range(0, chunk_size, 4096):
        chunk[offset] = 1
    chunks.append(chunk)
    time.sleep(0.1)
PY
PROMPT
)
SECONDS=0
if MEMORY_RESULT=$(sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --timeout 30 \
  --chat-thread-id "$MEMORY_CHAT_THREAD_ID" \
  --session-id "$MEMORY_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt "$MEMORY_PROMPT" \
  --active-input 'after=1s,text=memory-pressure-control'); then
  printf '%s\n' "$MEMORY_RESULT"
  fail "memory exhaustion unexpectedly completed successfully"
else
  MEMORY_SUBMIT_STATUS=$?
fi
MEMORY_ELAPSED=$SECONDS
printf '%s\n' "$MEMORY_RESULT"
[ "$MEMORY_SUBMIT_STATUS" -ne 0 ] \
  || fail "memory exhaustion did not fail the workload"
[ "$MEMORY_ELAPSED" -lt 20 ] \
  || fail "memory exhaustion was not bounded: ${MEMORY_ELAPSED}s"
MEMORY_RESULT_JSON=$(awk '/^\{/{line=$0} END{print line}' <<<"$MEMORY_RESULT")
MEMORY_RUN_ID=$(jq -r '.run_id // empty' <<<"$MEMORY_RESULT_JSON")
[ -n "$MEMORY_RUN_ID" ] || fail "memory-pressure result omitted run ID"
MEMORY_STREAM_LOG="/var/lib/vm0-runner/logs/system-stream-${MEMORY_RUN_ID}.log"
sudo grep -F -q 'workload resource limit reached' "$MEMORY_STREAM_LOG" \
  || fail "memory-pressure failure was not classified"
sudo grep -E -q 'memory_oom(_kill)?=[1-9][0-9]*' "$MEMORY_STREAM_LOG" \
  || fail "memory-pressure diagnostics omitted the OOM event"

echo "--- Pressure: exhaust workload PID capacity and reclaim descendants ---"
PID_CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
PID_SESSION_ID="e2e-process-containment-pids"
PID_PROMPT=$(cat <<'PROMPT'
sudo -n python3 - <<'PY'
import errno
import os
import pathlib
import signal
import time

pathlib.Path("/tmp/vm0-process-containment/pid-pressure-vm").touch()
relative = next(
    line.removeprefix("0::").strip()
    for line in pathlib.Path("/proc/self/cgroup").read_text().splitlines()
    if line.startswith("0::")
)
workload = pathlib.Path(f"/sys/fs/cgroup{relative}")
# The production 2,048-process ceiling was exercised during calibration. A
# smaller operation-local ceiling keeps this committed kernel-path smoke fast.
(workload / "pids.max").write_text("64")
children = []
while True:
    try:
        pid = os.fork()
    except OSError as error:
        if error.errno != errno.EAGAIN:
            raise
        break
    if pid == 0:
        os.setsid()
        null = os.open("/dev/null", os.O_RDWR)
        for descriptor in (0, 1, 2):
            os.dup2(null, descriptor)
        if null > 2:
            os.close(null)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        while True:
            signal.pause()
    children.append(pid)

events = {}
for line in (workload / "pids.events").read_text().splitlines():
    key, value = line.split()
    events[key] = int(value)
if events.get("max", 0) == 0:
    raise RuntimeError("pids.max did not reject a workload fork")
print(f"pid-pressure-ready children={len(children)} max={events['max']}", flush=True)
time.sleep(2)
print(f"pid-pressure-complete children={len(children)}", flush=True)
PY
PROMPT
)
PID_RESULT=$(sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --timeout 30 \
  --chat-thread-id "$PID_CHAT_THREAD_ID" \
  --session-id "$PID_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt "$PID_PROMPT" \
  --active-input 'after=1s,text=pid-pressure-control') \
  || fail "PID-pressure workload did not finalize"
printf '%s\n' "$PID_RESULT"
PID_RESULT_JSON=$(awk '/^\{/{line=$0} END{print line}' <<<"$PID_RESULT")
PID_RUN_ID=$(jq -r '.run_id // empty' <<<"$PID_RESULT_JSON")
[ -n "$PID_RUN_ID" ] || fail "PID-pressure result omitted run ID"
PID_STREAM_LOG="/var/lib/vm0-runner/logs/system-stream-${PID_RUN_ID}.log"
sudo grep -F -q 'pid-pressure-complete children=' "$PID_STREAM_LOG" \
  || fail "PID-pressure workload did not reach the cgroup limit"
sudo grep -E -q 'pids_max=[1-9][0-9]*' "$PID_STREAM_LOG" \
  || fail "PID-pressure diagnostics omitted the pids.max event"

echo "--- Pressure: prove PID-exhaustion cleanup preserved VM reuse ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$PID_CHAT_THREAD_ID" \
  --session-id "$PID_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'test -f /tmp/vm0-process-containment/pid-pressure-vm' \
  || fail "PID-pressure cleanup did not preserve safe VM reuse"

LOGS=$(sudo journalctl --no-pager "_SYSTEMD_INVOCATION_ID=$INVOCATION_ID" 2>&1) \
  || fail "failed to read runner logs"
LEAK_LINE=$(printf '%s\n' "$LOGS" \
  | grep -F 'exec process containment cleaned' \
  | grep -F 'descendants_observed=true' \
  | grep -F 'cgroup_kill_used=true' \
  | head -1) \
  || fail "missing populated cleanup that used cgroup.kill"

LEAK_CLEANUP_MS=$(sed -n 's/.*cleanup_ms=\([0-9][0-9]*\).*/\1/p' <<<"$LEAK_LINE")
[ -n "$LEAK_CLEANUP_MS" ] || fail "missing leaked cleanup latency"
[ "$LEAK_CLEANUP_MS" -le 2000 ] \
  || fail "leaked cleanup exceeded bounded lifecycle: ${LEAK_CLEANUP_MS}ms"

if grep -F 'process control latency exceeded calibrated bound' <<<"$LOGS" >/dev/null; then
  fail "process control exceeded the calibrated 750ms bound under pressure"
fi
grep -F 'exec workload resource pressure observed' <<<"$LOGS" \
  | grep -E 'cpu_nr_throttled=[1-9][0-9]*' >/dev/null \
  || fail "CPU-pressure enforcement was not reported"
PID_CLEANUP_LINE=$(printf '%s\n' "$LOGS" \
  | grep -F 'exec process containment cleaned' \
  | grep -F 'descendants_observed=true' \
  | grep -F 'cgroup_kill_used=true' \
  | sed -n 's/.*initial_members=\([0-9][0-9]*\).*/\1 &/p' \
  | sort -nr \
  | head -1) \
  || fail "missing forced PID-pressure cleanup"
PID_INITIAL_MEMBERS=${PID_CLEANUP_LINE%% *}
[ "$PID_INITIAL_MEMBERS" -ge 50 ] \
  || fail "PID-pressure cleanup observed only ${PID_INITIAL_MEMBERS} members"
PID_CLEANUP_MS=$(sed -n 's/.*cleanup_ms=\([0-9][0-9]*\).*/\1/p' <<<"$PID_CLEANUP_LINE")
[ -n "$PID_CLEANUP_MS" ] || fail "PID-pressure cleanup latency was not reported"
[ "$PID_CLEANUP_MS" -le 5000 ] \
  || fail "PID-pressure cleanup exceeded 5s: ${PID_CLEANUP_MS}ms"

echo "PASS: detached user/root descendants were reclaimed"
echo "PASS: leaked cleanup ${LEAK_CLEANUP_MS}ms; healthy cleanup preserved reuse"
echo "PASS: compressed CPU pressure kept process control and ${METRICS_COUNT} metric samples live"
echo "PASS: workload OOM was classified in ${MEMORY_ELAPSED}s without killing Guest Agent"
echo "PASS: pids.max cleanup reclaimed ${PID_INITIAL_MEMBERS} members in ${PID_CLEANUP_MS}ms"

sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
wait_for_unit_inactive
sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
trap - EXIT

echo "=== Process-containment test passed ==="
REMOTE_SCRIPT
