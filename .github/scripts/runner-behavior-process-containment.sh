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
ssh "$REMOTE" bash -s -- "${BIN_DIR}" "${SVC}" "${GROUP}" "${RUNNER_DIR}" "${GROUP_DIR}" "${AGENT_READY_BENCHMARK_SAMPLES:-3}" <<'REMOTE_SCRIPT'
set -euo pipefail
BIN_DIR=$1; SVC=$2; GROUP=$3; RUNNER_DIR=$4; GROUP_DIR=$5; AGENT_READY_BENCHMARK_SAMPLES=$6
UNIT="vm0-runner-${SVC}.service"
SESSION_ID="e2e-process-containment-session"
CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
PRESSURE_SUBMIT_PID=""
PRESSURE_SUBMIT_OUTPUT=""
AGENT_READY_BENCHMARK_RAW=""

fail() { echo "FAIL: $1"; exit 1; }

case "$AGENT_READY_BENCHMARK_SAMPLES" in
  ''|*[!0-9]*) fail "Agent-ready benchmark sample count must be an integer" ;;
esac
[ "$AGENT_READY_BENCHMARK_SAMPLES" -ge 1 ] \
  && [ "$AGENT_READY_BENCHMARK_SAMPLES" -le 100 ] \
  || fail "Agent-ready benchmark sample count must be between 1 and 100"

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
  if [ -n "$AGENT_READY_BENCHMARK_RAW" ]; then
    rm -f "$AGENT_READY_BENCHMARK_RAW"
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
  /vm0-exec/exec-*/workload/tools/tool-*) ;;
  *) echo "Bash tool is outside its tool cgroup: $relative" >&2; exit 1 ;;
esac
bash_executable=$(readlink -f /bin/bash)
tool_executor=$(readlink -f /usr/local/bin/guest-tool-exec)
current_executable=$(readlink -f /proc/$$/exe)
test "$bash_executable" != "$tool_executor" \
  || { echo "distribution Bash was replaced by the tool executor" >&2; exit 1; }
test "$current_executable" = "$bash_executable" \
  || { echo "tool executor did not hand off to distribution Bash" >&2; exit 1; }
tools=${relative%/*}
workload=${tools%/tools}
operation=${workload%/workload}
parent="/sys/fs/cgroup$operation"
test -d "$parent/control"
test -d "$parent/workload"
test -d "$parent/workload/runtime"
test -d "$parent/workload/tools"
for controller in cpu memory pids; do
  grep -qw "$controller" "$base/cgroup.subtree_control"
  grep -qw "$controller" "$parent/cgroup.subtree_control"
  grep -qw "$controller" "$parent/workload/cgroup.subtree_control"
done
expected_control_memory_min=$((384 * 1024 * 1024))
expected_workload_memory_reserve=$((128 * 1024 * 1024))
guest_memory_bytes=$(( $(getconf _PHYS_PAGES) * $(getconf PAGE_SIZE) ))
expected_workload_memory_max=$((guest_memory_bytes - expected_workload_memory_reserve))
test "$(cat "$base/memory.min")" = "$expected_control_memory_min"
test "$(cat "$parent/memory.min")" = "$expected_control_memory_min"
test "$(cat "$parent/control/memory.min")" = "$expected_control_memory_min"
grep -Eq '^[0-9]+ [0-9]+$' "$parent/workload/cpu.max"
test "$(cat "$parent/workload/memory.high")" = max
test "$(cat "$parent/workload/memory.max")" = "$expected_workload_memory_max"
test "$(cat "$parent/workload/memory.oom.group")" = 0
test "$(cat "$parent/workload/pids.max")" = max
test "$(cat "$parent/workload/tools/memory.max")" = max
test "$(cat "$parent/workload/tools/memory.oom.group")" = 0
grep -qw memory "$parent/workload/tools/cgroup.subtree_control"
test "$(cat "/sys/fs/cgroup$relative/memory.oom.group")" = 1
test -z "${VM0_WORKLOAD_CGROUP_PROCS_ENDPOINT+x}"
test -z "${OKOU_WORKLOAD_CGROUP_PROCS_ENDPOINT+x}"
test -z "${OKOU_TOOL_CGROUP_PROCS_ENDPOINT+x}"
test "${VM0_TOOL_CGROUP_PROCS_ENDPOINT+x}" = x
test -n "$VM0_TOOL_CGROUP_PROCS_ENDPOINT"
control_member_count=$(wc -l < "$parent/control/cgroup.procs")
if [ "$control_member_count" -ne 1 ]; then
  echo "control cgroup must contain only Guest Agent; members=$(tr '\n' ' ' < "$parent/control/cgroup.procs")" >&2
  exit 1
fi
control_pid=$(cat "$parent/control/cgroup.procs")
if [ "$(cat "/proc/$control_pid/comm")" != "guest-agent" ]; then
  echo "control cgroup member is not Guest Agent: pid=$control_pid comm=$(cat "/proc/$control_pid/comm")" >&2
  exit 1
fi
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
    */workload/runtime/cgroup.procs)
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
  /vm0-exec/exec-*/workload/tools/tool-*) ;;
  *) echo "unexpected current cgroup: $relative" >&2; exit 1 ;;
esac
tools=${relative%/*}
workload=${tools%/tools}
operation=${workload%/workload}
own_group=${operation##*/}
test -n "$own_group"
test -d "$base/$own_group"
test -d "$base/$own_group/control"
test -d "$base/$own_group/workload"
test -d "$base/$own_group/workload/runtime"
test -d "$base/$own_group/workload/tools"
test -z "$(find "$base" -mindepth 1 -maxdepth 1 -type d ! -name "$own_group" -print -quit)"
grep -q '^populated 1$' "$base/cgroup.events"
for controller in cpu memory pids; do
  grep -qw "$controller" "$base/cgroup.subtree_control"
  grep -qw "$controller" "$base/$own_group/cgroup.subtree_control"
  grep -qw "$controller" "$base/$own_group/workload/cgroup.subtree_control"
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
  || fail "Turn 2 failed; sandbox was not safely reused"

echo "--- Turn 3: prove healthy Turn 2 cleanup was also reusable ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$CHAT_THREAD_ID" \
  --session-id "$SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'test -f /tmp/vm0-process-containment/vm-reuse-marker' \
  || fail "Turn 3 failed; healthy cleanup did not re-enter reuse"

echo "--- Pressure: sustain CPU saturation with live process control ---"
# Continue the prepared conversation so the pressure turn must reuse the sandbox
# whose containment state and cleanup were verified above. Keep the provider
# session independent so active input starts with a fresh stream.
PRESSURE_CHAT_THREAD_ID="$CHAT_THREAD_ID"
PRESSURE_SESSION_ID="e2e-process-containment-pressure"
PRESSURE_SUBMIT_OUTPUT=$(mktemp)
# The mock's readiness result is gated on the first forwarded follow-up, so
# startup scheduling cannot close active input before the queue is observed.
# Keep the final input after the pressure command so the mock turn cannot
# finish first.
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --timeout 80 \
  --chat-thread-id "$PRESSURE_CHAT_THREAD_ID" \
  --session-id "$PRESSURE_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt '@active-input-smoke-ready:8' \
  --active-input 'after=1ms,text=cpu-pressure-ready' \
  --active-input 'after=2s,text=cpu-pressure-one' \
  --active-input 'after=4s,text=cpu-pressure-two' \
  --active-input 'after=6s,text=cpu-pressure-three' \
  --active-input 'after=15s,text=memory-reclaim-one' \
  --active-input 'after=30s,text=memory-reclaim-two' \
  --active-input 'after=45s,text=memory-reclaim-three' \
  --active-input 'after=65s,text=pressure-finish' \
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
grep -E -q '^cpu-pressure-complete throttled_periods=[1-9][0-9]*$' \
  <<<"$CPU_PRESSURE_RESULT" \
  || fail "CPU pressure did not report throttling"

echo "--- Evidence: return mixed-identity pids.max cleanup through exec result ---"
PID_EVIDENCE_COMMAND=$(cat <<'PYTHON'
import errno
import os
import pathlib
import signal

relative = next(
    line.removeprefix("0::").strip()
    for line in pathlib.Path("/proc/self/cgroup").read_text().splitlines()
    if line.startswith("0::")
)
if not relative.startswith("/vm0-exec/exec-") or not relative.endswith("/workload"):
    raise RuntimeError(f"PID evidence is outside workload cgroup: {relative}")
workload = pathlib.Path(f"/sys/fs/cgroup{relative}")
(workload / "pids.max").write_text("64")

ready_read, ready_write = os.pipe()
children = []
while True:
    try:
        pid = os.fork()
    except OSError as error:
        if error.errno != errno.EAGAIN:
            raise
        break
    if pid == 0:
        os.close(ready_read)
        os.setsid()
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        if len(children) % 2 == 0:
            os.setgroups([])
            os.setgid(1000)
            os.setuid(1000)
        null = os.open("/dev/null", os.O_RDWR)
        for descriptor in (0, 1, 2):
            os.dup2(null, descriptor)
        if null > 2:
            os.close(null)
        os.write(ready_write, b"1")
        os.close(ready_write)
        while True:
            signal.pause()
    children.append(pid)

os.close(ready_write)
ready = b""
while len(ready) < len(children):
    chunk = os.read(ready_read, len(children) - len(ready))
    if not chunk:
        raise RuntimeError("PID-pressure readiness pipe closed early")
    ready += chunk
os.close(ready_read)
events = dict(
    line.split()
    for line in (workload / "pids.events").read_text().splitlines()
)
if int(events.get("max", "0")) == 0:
    raise RuntimeError("pids.max did not reject a workload fork")
print(
    "pid-evidence-ready "
    f"children={len(children)} "
    f"user_children={(len(children) + 1) // 2} "
    f"root_children={len(children) // 2} "
    f"max={events['max']}",
    flush=True,
)
PYTHON
)
if ! PID_EVIDENCE_RESULT=$(sudo "$BIN_DIR/runner" exec \
  --timeout 15 \
  --sandbox "$PRESSURE_SANDBOX_ID" \
  --sudo \
  --show-diagnostic \
  -- python3 -c "$PID_EVIDENCE_COMMAND" 2>&1); then
  printf '%s\n' "$PID_EVIDENCE_RESULT"
  fail "PID-pressure cleanup behavior failed before result evidence"
fi
printf '%s\n' "$PID_EVIDENCE_RESULT"
PID_EVIDENCE_CHILDREN=$(sed -n \
  's/^pid-evidence-ready children=\([0-9][0-9]*\) user_children=[1-9][0-9]* root_children=[1-9][0-9]* max=[1-9][0-9]*$/\1/p' \
  <<<"$PID_EVIDENCE_RESULT")
[ -n "$PID_EVIDENCE_CHILDREN" ] \
  || fail "PID-pressure evidence did not reach the configured pids.max boundary"
[ "$PID_EVIDENCE_CHILDREN" -ge 50 ] \
  || fail "PID-pressure evidence created only ${PID_EVIDENCE_CHILDREN} children"
PID_EVIDENCE_USER_CHILDREN=$(sed -n \
  's/^pid-evidence-ready children=[0-9][0-9]* user_children=\([1-9][0-9]*\) root_children=[1-9][0-9]* max=[1-9][0-9]*$/\1/p' \
  <<<"$PID_EVIDENCE_RESULT")
PID_EVIDENCE_ROOT_CHILDREN=$(sed -n \
  's/^pid-evidence-ready children=[0-9][0-9]* user_children=[1-9][0-9]* root_children=\([1-9][0-9]*\) max=[1-9][0-9]*$/\1/p' \
  <<<"$PID_EVIDENCE_RESULT")
[ -n "$PID_EVIDENCE_USER_CHILDREN" ] \
  || fail "PID-pressure evidence did not create user-owned descendants"
[ -n "$PID_EVIDENCE_ROOT_CHILDREN" ] \
  || fail "PID-pressure evidence did not create root-owned descendants"
PID_CLEANUP_LINE=$(printf '%s\n' "$PID_EVIDENCE_RESULT" \
  | grep -F 'exec process containment cleaned' \
  | grep -F 'descendants_observed=true' \
  | grep -F 'cgroup_kill_used=true' \
  | head -1) \
  || fail "PID-pressure cleanup behavior passed, but its successful exec result produced no populated cgroup.kill cleanup evidence"
PID_INITIAL_MEMBERS=$(sed -n \
  's/.*initial_members=\([0-9][0-9]*\).*/\1/p' \
  <<<"$PID_CLEANUP_LINE")
[ -n "$PID_INITIAL_MEMBERS" ] \
  || fail "PID-pressure cleanup result evidence omitted its initial member count"
[ "$PID_INITIAL_MEMBERS" -ge 50 ] \
  || fail "PID-pressure cleanup result evidence observed only ${PID_INITIAL_MEMBERS} members"
PID_CLEANUP_MS=$(sed -n 's/.*cleanup_ms=\([0-9][0-9]*\).*/\1/p' \
  <<<"$PID_CLEANUP_LINE")
[ -n "$PID_CLEANUP_MS" ] \
  || fail "PID-pressure cleanup result evidence omitted cleanup latency"
[ "$PID_CLEANUP_MS" -le 5000 ] \
  || fail "PID-pressure cleanup exceeded 5s: ${PID_CLEANUP_MS}ms"
LEAK_CLEANUP_MS=$PID_CLEANUP_MS
[ "$LEAK_CLEANUP_MS" -le 2000 ] \
  || fail "mixed-identity descendant cleanup exceeded bounded lifecycle: ${LEAK_CLEANUP_MS}ms"

echo "--- Pressure: cross the retired workload memory boundary through Guest reclaim ---"
PRESSURE_API_SOCK="/run/vm0/sock/$PRESSURE_SANDBOX_ID/api.sock"
BALLOON_BEFORE=$(sudo curl -sf --unix-socket "$PRESSURE_API_SOCK" \
  http://localhost/balloon/statistics \
  | jq -ce '{target_mib, actual_mib, free_memory, available_memory}') \
  || fail "failed to sample balloon before memory reclaim pressure"
MEMORY_RECLAIM_COMMAND=$(cat <<'PYTHON'
import gc
import json
import os
import pathlib
import time

MIB = 1024 * 1024
PAGE_SIZE = os.sysconf("SC_PAGE_SIZE")
CHUNK_SIZE = 32 * MIB
CONTROL_MEMORY_MIN = 384 * MIB
WORKLOAD_MEMORY_RESERVE = 128 * MIB
RETIRED_BOUNDARY_MARGIN = 64 * MIB


def read_int(path):
    return int(path.read_text().strip())


def read_key_values(path):
    values = {}
    for line in path.read_text().splitlines():
        fields = line.split()
        if len(fields) >= 2:
            values[fields[0]] = int(fields[1])
    return values


def snapshot(workload, control):
    meminfo = read_key_values(pathlib.Path("/proc/meminfo"))
    vmstat = read_key_values(pathlib.Path("/proc/vmstat"))
    reclaim_keys = (
        "pgscan_kswapd",
        "pgscan_direct",
        "pgsteal_kswapd",
        "pgsteal_direct",
    )
    return {
        "workload_current": read_int(workload / "memory.current"),
        "workload_peak": read_int(workload / "memory.peak"),
        "workload_events": read_key_values(workload / "memory.events"),
        "control_current": read_int(control / "memory.current"),
        "control_peak": read_int(control / "memory.peak"),
        "mem_available_bytes": meminfo["MemAvailable:"] * 1024,
        "vmstat": {key: vmstat.get(key, 0) for key in reclaim_keys},
    }


def guest_agent_control_cgroup():
    matches = []
    base = pathlib.Path("/sys/fs/cgroup/vm0-exec")
    for control in base.glob("exec-*/control"):
        for pid in control.joinpath("cgroup.procs").read_text().splitlines():
            if pathlib.Path(f"/proc/{pid}/comm").read_text().strip() == "guest-agent":
                matches.append(control)
    if len(matches) != 1:
        raise RuntimeError(f"expected one Guest Agent control cgroup, found {len(matches)}")
    return matches[0]


relative = next(
    line.removeprefix("0::").strip()
    for line in pathlib.Path("/proc/self/cgroup").read_text().splitlines()
    if line.startswith("0::")
)
if not relative.startswith("/vm0-exec/exec-") or not relative.endswith("/workload"):
    raise RuntimeError(f"memory pressure is outside workload cgroup: {relative}")

workload = pathlib.Path(f"/sys/fs/cgroup{relative}")
control = guest_agent_control_cgroup()
marker_dir = pathlib.Path("/tmp/vm0-process-containment")
if not marker_dir.is_dir():
    raise RuntimeError("memory pressure did not reuse the prepared sandbox")
guest_memory_bytes = os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
legacy_memory_max = guest_memory_bytes - CONTROL_MEMORY_MIN
configured_memory_max = read_int(workload / "memory.max")
expected_memory_max = guest_memory_bytes - WORKLOAD_MEMORY_RESERVE
if configured_memory_max != expected_memory_max:
    raise RuntimeError(
        "unexpected workload memory.max: "
        f"actual={configured_memory_max} expected={expected_memory_max}"
    )

target = legacy_memory_max + RETIRED_BOUNDARY_MARGIN
if target >= configured_memory_max:
    raise RuntimeError(
        f"memory pressure target reaches current memory.max: target={target} "
        f"memory_max={configured_memory_max}"
    )

before = snapshot(workload, control)
deadline = time.monotonic() + 45
chunks = []
while read_int(workload / "memory.current") < target:
    if time.monotonic() >= deadline:
        current = read_int(workload / "memory.current")
        raise RuntimeError(
            "memory pressure did not reach the retired boundary in 45s: "
            f"current={current} target={target}"
        )
    chunk = bytearray(CHUNK_SIZE)
    chunk[::PAGE_SIZE] = b"\x01" * (CHUNK_SIZE // PAGE_SIZE)
    chunks.append(chunk)
    time.sleep(0.01)

peak = snapshot(workload, control)
if peak["workload_current"] <= legacy_memory_max:
    raise RuntimeError(
        "memory pressure did not cross the retired workload boundary: "
        f"current={peak['workload_current']} legacy_max={legacy_memory_max}"
    )

time.sleep(6)
chunks.clear()
gc.collect()
time.sleep(1)
after = snapshot(workload, control)
for event in ("max", "oom", "oom_kill", "oom_group_kill"):
    if after["workload_events"].get(event, 0) != before["workload_events"].get(event, 0):
        raise RuntimeError(f"memory pressure triggered workload-local {event}")
marker_dir.joinpath("memory-reclaim-vm").write_text("ready\n")
print(
    json.dumps(
        {
            "guest_memory_bytes": guest_memory_bytes,
            "legacy_memory_max": legacy_memory_max,
            "configured_memory_max": configured_memory_max,
            "target": target,
            "before": before,
            "peak": peak,
            "after": after,
        },
        separators=(",", ":"),
    )
)
PYTHON
)
MEMORY_RECLAIM_RESULT=$(sudo "$BIN_DIR/runner" exec \
  --timeout 60 \
  --sandbox "$PRESSURE_SANDBOX_ID" \
  -- python3 -c "$MEMORY_RECLAIM_COMMAND") \
  || fail "workload could not cross the retired memory boundary"
printf '%s\n' "$MEMORY_RECLAIM_RESULT"
MEMORY_RECLAIM_JSON=$(awk '/^\{/{line=$0} END{print line}' <<<"$MEMORY_RECLAIM_RESULT")
[ -n "$MEMORY_RECLAIM_JSON" ] \
  || fail "memory reclaim pressure did not emit a usage snapshot"
jq -e '
  .peak.workload_current > .legacy_memory_max
  and .peak.workload_current < .configured_memory_max
  and .peak.workload_events.max == .before.workload_events.max
  and .peak.workload_events.oom == .before.workload_events.oom
  and .peak.workload_events.oom_kill == .before.workload_events.oom_kill
  and .peak.workload_events.oom_group_kill == .before.workload_events.oom_group_kill
  and .after.workload_events.max == .before.workload_events.max
  and .after.workload_events.oom == .before.workload_events.oom
  and .after.workload_events.oom_kill == .before.workload_events.oom_kill
  and .after.workload_events.oom_group_kill == .before.workload_events.oom_group_kill
' >/dev/null <<<"$MEMORY_RECLAIM_JSON" \
  || fail "memory reclaim pressure crossed a workload-local resource boundary"
BALLOON_AFTER=$(sudo curl -sf --unix-socket "$PRESSURE_API_SOCK" \
  http://localhost/balloon/statistics \
  | jq -ce '{target_mib, actual_mib, free_memory, available_memory}') \
  || fail "failed to sample balloon after memory reclaim pressure"
echo "memory-reclaim-balloon before=$BALLOON_BEFORE after=$BALLOON_AFTER"

if wait "$PRESSURE_SUBMIT_PID"; then
  PRESSURE_SUBMIT_STATUS=0
else
  PRESSURE_SUBMIT_STATUS=$?
fi
PRESSURE_SUBMIT_PID=""
cat "$PRESSURE_SUBMIT_OUTPUT"
[ "$PRESSURE_SUBMIT_STATUS" -eq 0 ] \
  || fail "process control did not remain live during CPU and memory pressure"
PRESSURE_SUBMIT_JSON=$(awk '/^\{/{line=$0} END{print line}' "$PRESSURE_SUBMIT_OUTPUT")
[ -n "$PRESSURE_SUBMIT_JSON" ] \
  || fail "CPU-pressure submit did not return a JSON result"
SUBMITTED_PRESSURE_RUN_ID=$(jq -r '.run_id // empty' <<<"$PRESSURE_SUBMIT_JSON")
[ "$SUBMITTED_PRESSURE_RUN_ID" = "$PRESSURE_RUN_ID" ] \
  || fail "CPU-pressure result run ID did not match its claim"
PRESSURE_STREAM_LOG="/var/lib/vm0-runner/logs/system-stream-${PRESSURE_RUN_ID}.log"
PRESSURE_METRICS_LOG="/var/lib/vm0-runner/logs/metrics-${PRESSURE_RUN_ID}.jsonl"
sudo grep -F -q \
  'RESULT=cpu-pressure-ready+cpu-pressure-one+cpu-pressure-two+cpu-pressure-three+memory-reclaim-one+memory-reclaim-two+memory-reclaim-three+pressure-finish' \
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
[ "$METRICS_SPAN_SECS" -ge 50 ] \
  || fail "Guest control metrics did not span CPU and memory pressure: ${METRICS_SPAN_SECS}s"
[ "$METRICS_MAX_GAP_SECS" -le 15 ] \
  || fail "Guest control metric cadence exceeded 15s: ${METRICS_MAX_GAP_SECS}s"
rm -f "$PRESSURE_SUBMIT_OUTPUT"
PRESSURE_SUBMIT_OUTPUT=""

echo "--- Pressure: group-kill only the high-memory Bash tool ---"
# The mock CLI launches two Bash children directly from the managed runtime.
# The launcher places them in distinct tool cgroups before either shell runs.
# One tool drives the existing workload limit to OOM while the other remains alive.
# Use a fresh sandbox so the preceding extreme balloon-reclaim scenario cannot
# delay Guest Agent startup and obscure the tool-isolation assertion.
MEMORY_CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
MEMORY_SESSION_ID="e2e-process-containment-memory"
SECONDS=0
MEMORY_RESULT=$(sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --timeout 30 \
  --chat-thread-id "$MEMORY_CHAT_THREAD_ID" \
  --session-id "$MEMORY_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt '@parallel-shell-tool-oom' \
  --active-input 'after=1s,text=memory-pressure-control') \
  || fail "memory-pressure run did not recover after the offender tool group was killed"
MEMORY_ELAPSED=$SECONDS
printf '%s\n' "$MEMORY_RESULT"
[ "$MEMORY_ELAPSED" -lt 20 ] \
  || fail "memory-pressure recovery was not bounded: ${MEMORY_ELAPSED}s"
MEMORY_RESULT_JSON=$(awk '/^\{/{line=$0} END{print line}' <<<"$MEMORY_RESULT")
MEMORY_RUN_ID=$(jq -r '.run_id // empty' <<<"$MEMORY_RESULT_JSON")
[ -n "$MEMORY_RUN_ID" ] || fail "memory-pressure result omitted run ID"
MEMORY_STREAM_LOG="/var/lib/vm0-runner/logs/system-stream-${MEMORY_RUN_ID}.log"
sudo grep -F -q 'parallel-shell-tool-oom-survived oom_group_kill=' "$MEMORY_STREAM_LOG" \
  || fail "CLI or unrelated Bash tool did not survive the offender group OOM"
sudo grep -F -q 'workload resource limit reached' "$MEMORY_STREAM_LOG" \
  || fail "memory-pressure resource event was not classified"
sudo grep -E -q 'memory_oom_kill=[1-9][0-9]*' "$MEMORY_STREAM_LOG" \
  || fail "memory-pressure diagnostics omitted the OOM event"
sudo grep -E -q 'memory_oom_group_kill=[1-9][0-9]*' "$MEMORY_STREAM_LOG" \
  || fail "memory-pressure diagnostics omitted the group OOM event"

echo "--- Pressure: prove tool-group OOM preserved sandbox reuse ---"
MEMORY_REUSE_RESULT=$(sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$MEMORY_CHAT_THREAD_ID" \
  --session-id "$MEMORY_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'true') \
  || fail "memory-pressure recovery did not preserve safe sandbox reuse"
printf '%s\n' "$MEMORY_REUSE_RESULT"
MEMORY_REUSE_RESULT_JSON=$(awk '/^\{/{line=$0} END{print line}' <<<"$MEMORY_REUSE_RESULT")
MEMORY_REUSE_RUN_ID=$(jq -r '.run_id // empty' <<<"$MEMORY_REUSE_RESULT_JSON")
[ -n "$MEMORY_REUSE_RUN_ID" ] || fail "memory-pressure reuse result omitted run ID"

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

marker = pathlib.Path("/tmp/vm0-process-containment")
marker.mkdir()
(marker / "pid-pressure-vm").touch()
relative = next(
    line.removeprefix("0::").strip()
    for line in pathlib.Path("/proc/self/cgroup").read_text().splitlines()
    if line.startswith("0::")
)
tool = pathlib.Path(f"/sys/fs/cgroup{relative}")
if tool.parent.name != "tools" or tool.parent.parent.name != "workload":
    raise RuntimeError(f"PID pressure is outside a Bash tool cgroup: {relative}")
tools = tool.parent
# Production leaves are uncapped until representative workload task counts are
# calibrated. This operation-local ceiling keeps the enforcement smoke fast.
(tools / "pids.max").write_text("64")
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
for line in (tools / "pids.events").read_text().splitlines():
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

echo "--- Pressure: prove PID-exhaustion cleanup preserved sandbox reuse ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$PID_CHAT_THREAD_ID" \
  --session-id "$PID_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'test -f /tmp/vm0-process-containment/pid-pressure-vm' \
  || fail "PID-pressure cleanup did not preserve safe sandbox reuse"

LOGS=$(sudo journalctl --no-pager "_SYSTEMD_INVOCATION_ID=$INVOCATION_ID" 2>&1) \
  || fail "failed to read runner logs"
printf '%s\n' "$LOGS" \
  | grep -F "run_id=$MEMORY_RUN_ID" \
  | grep -F 'job finished' \
  >/dev/null \
  || fail "missing successful memory-pressure terminal log"
if printf '%s\n' "$LOGS" \
  | grep -F "run_id=$MEMORY_RUN_ID" \
  | grep -F 'job execution failed' >/dev/null; then
  fail "memory-pressure run was reported as failed"
fi
printf '%s\n' "$LOGS" \
  | grep -F "run_id=$MEMORY_REUSE_RUN_ID" \
  | grep -F 'job finished' \
  | grep -F 'reused=true' \
  >/dev/null \
  || fail "tool-group OOM follow-up did not reuse its sandbox"
if grep -F 'process control latency exceeded calibrated bound' <<<"$LOGS" >/dev/null; then
  fail "process control exceeded the calibrated 750ms bound under pressure"
fi

echo "--- Benchmark: Guest Agent ready boundary ---"
AGENT_READY_BENCHMARK_RAW=$(mktemp)

record_agent_ready_benchmark_failure() {
  local path=$1
  local run_id=$2
  local error=$3
  error=$(printf '%s' "$error" | tail -c 512)
  jq -cn \
    --arg path "$path" \
    --arg run_id "$run_id" \
    --arg error "$error" \
    '{path: $path, success: false, run_id: $run_id, error: $error}' \
    >> "$AGENT_READY_BENCHMARK_RAW"
}

agent_ready_log_field() {
  local line=$1
  local field=$2
  sed -n "s/.*${field}=\\([^ ]*\\).*/\\1/p" <<<"$line"
}

read_agent_ready_log() {
  local run_id=$1
  local line=""
  for _ in $(seq 1 50); do
    line=$(sudo journalctl --no-pager "_SYSTEMD_INVOCATION_ID=$INVOCATION_ID" 2>&1 \
      | grep -F "run_id=$run_id" \
      | grep -F 'agent startup timing' \
      | tail -n 1) || true
    if [ -n "$line" ]; then
      printf '%s\n' "$line"
      return 0
    fi
    sleep 0.1
  done
  return 1
}

record_agent_ready_benchmark_sample() {
  local path=$1
  local expected_sandbox_reuse=$2
  local expected_workspace_reuse=$3
  local chat_thread_id=$4
  local session_id=$5
  local result=""
  local result_json=""
  local run_id=""
  local ready_log=""
  local sandbox_reuse=""
  local workspace_reuse=""
  local shell_spawn_ms=""
  local agent_ready_ms=""
  local containment_create_us=""
  local placement_broker_setup_us=""
  local shell_spawn_component_us=""
  local bootstrap_ready_wait_us=""

  if ! result=$(sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
    --chat-thread-id "$chat_thread_id" \
    --session-id "$session_id" \
    --feature-flag sandboxReuse=true \
    --prompt 'true' 2>&1); then
    record_agent_ready_benchmark_failure "$path" "" "local submit failed: $result"
    return
  fi
  result_json=$(awk '/^\{/{line=$0} END{print line}' <<<"$result")
  run_id=$(jq -r '.run_id // empty' <<<"$result_json" 2>/dev/null) || true
  if [ -z "$run_id" ]; then
    record_agent_ready_benchmark_failure "$path" "" "local submit omitted run ID"
    return
  fi
  if ! ready_log=$(read_agent_ready_log "$run_id"); then
    record_agent_ready_benchmark_failure "$path" "$run_id" "Agent-ready log was not found"
    return
  fi

  sandbox_reuse=$(agent_ready_log_field "$ready_log" sandbox_reuse)
  workspace_reuse=$(agent_ready_log_field "$ready_log" workspace_reuse)
  if [ "$sandbox_reuse" != "$expected_sandbox_reuse" ]; then
    record_agent_ready_benchmark_failure "$path" "$run_id" \
      "expected sandbox_reuse=$expected_sandbox_reuse, observed $sandbox_reuse"
    return
  fi
  if [ -n "$expected_workspace_reuse" ] \
    && [ "$workspace_reuse" != "$expected_workspace_reuse" ]; then
    record_agent_ready_benchmark_failure "$path" "$run_id" \
      "expected workspace_reuse=$expected_workspace_reuse, observed $workspace_reuse"
    return
  fi

  shell_spawn_ms=$(agent_ready_log_field "$ready_log" shell_spawn_ms)
  agent_ready_ms=$(agent_ready_log_field "$ready_log" agent_ready_ms)
  containment_create_us=$(agent_ready_log_field "$ready_log" containment_create_us)
  placement_broker_setup_us=$(agent_ready_log_field "$ready_log" placement_broker_setup_us)
  shell_spawn_component_us=$(agent_ready_log_field "$ready_log" shell_spawn_component_us)
  bootstrap_ready_wait_us=$(agent_ready_log_field "$ready_log" bootstrap_ready_wait_us)
  for value in \
    "$shell_spawn_ms" \
    "$agent_ready_ms" \
    "$containment_create_us" \
    "$placement_broker_setup_us" \
    "$shell_spawn_component_us" \
    "$bootstrap_ready_wait_us"; do
    case "$value" in
      ''|*[!0-9]*)
        record_agent_ready_benchmark_failure "$path" "$run_id" \
          "Agent-ready log contained a missing or invalid duration"
        return
        ;;
    esac
  done

  jq -cn \
    --arg path "$path" \
    --arg run_id "$run_id" \
    --arg sandbox_reuse "$sandbox_reuse" \
    --arg workspace_reuse "$workspace_reuse" \
    --argjson shell_spawn_ms "$shell_spawn_ms" \
    --argjson agent_ready_ms "$agent_ready_ms" \
    --argjson containment_create_us "$containment_create_us" \
    --argjson placement_broker_setup_us "$placement_broker_setup_us" \
    --argjson shell_spawn_component_us "$shell_spawn_component_us" \
    --argjson bootstrap_ready_wait_us "$bootstrap_ready_wait_us" \
    '{
      path: $path,
      success: true,
      run_id: $run_id,
      sandbox_reuse: $sandbox_reuse,
      workspace_reuse: $workspace_reuse,
      shell_spawn_ms: $shell_spawn_ms,
      agent_ready_ms: $agent_ready_ms,
      containment_create_us: $containment_create_us,
      placement_broker_setup_us: $placement_broker_setup_us,
      shell_spawn_component_us: $shell_spawn_component_us,
      bootstrap_ready_wait_us: $bootstrap_ready_wait_us
    }' >> "$AGENT_READY_BENCHMARK_RAW"
}

restart_agent_ready_benchmark_runner() {
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
  wait_for_unit_inactive
  sudo "$BIN_DIR/runner" service start --name "$SVC" \
    --config "$RUNNER_DIR/runner.yaml" --local \
    --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true
  INVOCATION_ID=""
  for _ in $(seq 1 30); do
    INVOCATION_ID=$(sudo systemctl show "$UNIT" --property=InvocationID --value 2>/dev/null) || true
    [ -n "$INVOCATION_ID" ] && break
    sleep 1
  done
  [ -n "$INVOCATION_ID" ] || fail "runner invocation ID unavailable after benchmark restart"
}

for index in $(seq 1 "$AGENT_READY_BENCHMARK_SAMPLES"); do
  thread_id=$(cat /proc/sys/kernel/random/uuid)
  record_agent_ready_benchmark_sample \
    fresh PoolMiss "" "$thread_id" "agent-ready-fresh-$index"
done

declare -a WORKSPACE_BENCHMARK_THREADS=()
for index in $(seq 1 "$AGENT_READY_BENCHMARK_SAMPLES"); do
  thread_id=$(cat /proc/sys/kernel/random/uuid)
  WORKSPACE_BENCHMARK_THREADS+=("$thread_id")
  sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
    --chat-thread-id "$thread_id" \
    --session-id "agent-ready-workspace-$index" \
    --feature-flag sandboxReuse=true \
    --prompt 'true' >/dev/null \
    || fail "workspace-cache Agent-ready benchmark warmup failed"
done

# A runner restart destroys its owned idle sandboxes while retaining promoted
# workspace-cache images, so the measured turns cannot fall through to exact reuse.
restart_agent_ready_benchmark_runner
for index in $(seq 1 "$AGENT_READY_BENCHMARK_SAMPLES"); do
  thread_id=${WORKSPACE_BENCHMARK_THREADS[$((index - 1))]}
  record_agent_ready_benchmark_sample \
    workspace-cache PoolMiss Reused "$thread_id" "agent-ready-workspace-$index"
done

EXACT_REUSE_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$EXACT_REUSE_THREAD_ID" \
  --session-id agent-ready-exact-reuse \
  --feature-flag sandboxReuse=true \
  --prompt 'true' >/dev/null \
  || fail "exact-reuse Agent-ready benchmark warmup failed"
for _ in $(seq 1 "$AGENT_READY_BENCHMARK_SAMPLES"); do
  record_agent_ready_benchmark_sample \
    exact-reuse Reused SandboxReused \
    "$EXACT_REUSE_THREAD_ID" agent-ready-exact-reuse
done

echo "AGENT_READY_BENCHMARK_RAW_BEGIN"
cat "$AGENT_READY_BENCHMARK_RAW"
echo "AGENT_READY_BENCHMARK_RAW_END"
jq -s '
  def percentile($values; $ratio):
    ($values | sort) as $ordered
    | if ($ordered | length) == 0 then null
      else $ordered[((($ordered | length) * $ratio | ceil) - 1)]
      end;
  def metric_summary($rows; $field):
    [$rows[] | select(.success) | .[$field]] as $values
    | {
        p50: percentile($values; 0.50),
        p90: percentile($values; 0.90),
        p95: percentile($values; 0.95),
        p99: percentile($values; 0.99)
      };
  . as $records
  | ["fresh", "workspace-cache", "exact-reuse"]
  | map(
      . as $path
      | [$records[] | select(.path == $path)] as $rows
      | {
          path: $path,
          sample_count: ($rows | length),
          failures: ([$rows[] | select(.success | not)] | length),
          metrics: {
            shell_spawn_ms: metric_summary($rows; "shell_spawn_ms"),
            agent_ready_ms: metric_summary($rows; "agent_ready_ms"),
            containment_create_us: metric_summary($rows; "containment_create_us"),
            placement_broker_setup_us: metric_summary($rows; "placement_broker_setup_us"),
            shell_spawn_component_us: metric_summary($rows; "shell_spawn_component_us"),
            bootstrap_ready_wait_us: metric_summary($rows; "bootstrap_ready_wait_us")
          }
        }
    )
' "$AGENT_READY_BENCHMARK_RAW"

AGENT_READY_BENCHMARK_FAILURES=$(jq -s '[.[] | select(.success | not)] | length' \
  "$AGENT_READY_BENCHMARK_RAW")
[ "$AGENT_READY_BENCHMARK_FAILURES" -eq 0 ] \
  || fail "Agent-ready benchmark recorded $AGENT_READY_BENCHMARK_FAILURES failures"
rm -f "$AGENT_READY_BENCHMARK_RAW"
AGENT_READY_BENCHMARK_RAW=""

echo "PASS: detached user/root descendants were reclaimed"
echo "PASS: mixed-identity leaked cleanup ${LEAK_CLEANUP_MS}ms; healthy cleanup preserved reuse"
echo "PASS: compressed CPU pressure kept process control and ${METRICS_COUNT} metric samples live"
echo "PASS: Bash tool group OOM preserved the CLI, unrelated tool, and reuse in ${MEMORY_ELAPSED}s"
echo "PASS: pids.max cleanup reclaimed ${PID_INITIAL_MEMBERS} members in ${PID_CLEANUP_MS}ms"

sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
wait_for_unit_inactive
sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
trap - EXIT

echo "=== Process-containment test passed ==="
REMOTE_SCRIPT
