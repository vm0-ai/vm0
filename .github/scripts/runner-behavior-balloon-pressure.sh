#!/usr/bin/env bash
set -euo pipefail

REMOTE="${METAL_USER}@${HOST}"
SVC="${JOB_REF}-balloon-pressure"
GROUP="vm0/balloon-pressure-${JOB_REF}"
RUNNER_DIR="/var/lib/vm0-runner/runners/${SVC}"
GROUP_DIR="/var/lib/vm0-runner/groups/vm0/balloon-pressure-${JOB_REF}"

echo "=== Cleaning stale balloon-pressure runner state ==="
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
  --hostname ${HOST} \
  --group ${GROUP} \
  --runner-dirname ${SVC} \
  --max-concurrent 1 \
  --api-url https://not-a-real-server.test \
  --token vm0_official_${OFFICIAL_RUNNER_SECRET}"

echo "=== Running balloon-pressure test ==="
ssh "$REMOTE" bash -s -- \
  "${BIN_DIR}" \
  "${SVC}" \
  "${GROUP}" \
  "${RUNNER_DIR}" \
  "${GROUP_DIR}" <<'REMOTE_SCRIPT'
set -euo pipefail
BIN_DIR=$1; SVC=$2; GROUP=$3; RUNNER_DIR=$4; GROUP_DIR=$5
UNIT="vm0-runner-${SVC}.service"
CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
PRESSURE_SUBMIT_PID=""
PRESSURE_SUBMIT_OUTPUT=""
MEMORY_RECLAIM_PID=""
MEMORY_RECLAIM_OUTPUT=""

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
  if [ -n "$MEMORY_RECLAIM_PID" ]; then
    kill "$MEMORY_RECLAIM_PID" 2>/dev/null || true
    wait "$MEMORY_RECLAIM_PID" 2>/dev/null || true
  fi
  if [ -n "$MEMORY_RECLAIM_OUTPUT" ]; then
    rm -f "$MEMORY_RECLAIM_OUTPUT"
  fi
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
  --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true

echo "--- Prepare reusable sandbox ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$CHAT_THREAD_ID" \
  --session-id "e2e-balloon-pressure-prepare" \
  --feature-flag sandboxReuse=true \
  --prompt 'mkdir -p /tmp/vm0-balloon-pressure && touch /tmp/vm0-balloon-pressure/prepared' \
  || fail "failed to prepare reusable balloon-pressure sandbox"

echo "--- Keep active input and Guest metrics live during balloon pressure ---"
PRESSURE_SUBMIT_OUTPUT=$(mktemp)
# The mock's readiness result is gated on the first forwarded follow-up, so
# startup scheduling cannot close active input before the queue is observed.
# The 180-second schedule covers the bounded high-retention stabilization and
# allocator hold windows without weakening the production-equivalent proof.
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --timeout 200 \
  --chat-thread-id "$CHAT_THREAD_ID" \
  --session-id "e2e-balloon-pressure-active-input" \
  --feature-flag sandboxReuse=true \
  --prompt '@active-input-smoke-ready:7' \
  --active-input 'after=1ms,text=balloon-pressure-ready' \
  --active-input 'after=30s,text=balloon-pressure-one' \
  --active-input 'after=60s,text=balloon-pressure-two' \
  --active-input 'after=90s,text=balloon-pressure-three' \
  --active-input 'after=120s,text=balloon-pressure-four' \
  --active-input 'after=150s,text=balloon-pressure-five' \
  --active-input 'after=180s,text=pressure-finish' \
  >"$PRESSURE_SUBMIT_OUTPUT" 2>&1 &
PRESSURE_SUBMIT_PID=$!

PRESSURE_RUN_ID=""
PRESSURE_SANDBOX_ID=""
for _ in $(seq 1 60); do
  if ! kill -0 "$PRESSURE_SUBMIT_PID" 2>/dev/null; then
    wait "$PRESSURE_SUBMIT_PID" 2>/dev/null || true
    PRESSURE_SUBMIT_PID=""
    cat "$PRESSURE_SUBMIT_OUTPUT"
    fail "balloon-pressure submit exited before its sandbox became ready"
  fi
  mapfile -t CLAIM_FILES < <(
    sudo find "$GROUP_DIR/claims" -maxdepth 1 -type f -name '*.claim' \
      -printf '%f\n' 2>/dev/null | sort
  )
  [ "${#CLAIM_FILES[@]}" -le 1 ] \
    || fail "expected one balloon-pressure claim, found ${#CLAIM_FILES[@]}"
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
  || fail "balloon-pressure sandbox did not become ready"

echo "--- Cross the retired workload memory boundary through Guest reclaim ---"
PRESSURE_API_SOCK="/run/vm0/sock/$PRESSURE_SANDBOX_ID/api.sock"
# Match the directly observed production checkpoint before applying pressure.
BALLOON_MIN_STABLE_MIB=3072
BALLOON_STABLE_TARGET=""
BALLOON_STABLE_SAMPLES=0
BALLOON_BEFORE=""
for _ in $(seq 1 45); do
  BALLOON_SAMPLE=$(sudo curl -sf --unix-socket "$PRESSURE_API_SOCK" \
    http://localhost/balloon/statistics \
    | jq -ce '{target_mib, actual_mib, free_memory, available_memory}') \
    || fail "failed to sample balloon before memory reclaim pressure"
  BALLOON_TARGET=$(jq -r '.target_mib' <<<"$BALLOON_SAMPLE")
  BALLOON_ACTUAL=$(jq -r '.actual_mib' <<<"$BALLOON_SAMPLE")
  if [ "$BALLOON_TARGET" -ge "$BALLOON_MIN_STABLE_MIB" ] \
    && [ "$BALLOON_ACTUAL" -eq "$BALLOON_TARGET" ]; then
    if [ "$BALLOON_TARGET" = "$BALLOON_STABLE_TARGET" ]; then
      BALLOON_STABLE_SAMPLES=$((BALLOON_STABLE_SAMPLES + 1))
    else
      BALLOON_STABLE_TARGET=$BALLOON_TARGET
      BALLOON_STABLE_SAMPLES=1
    fi
    if [ "$BALLOON_STABLE_SAMPLES" -ge 2 ]; then
      BALLOON_BEFORE=$BALLOON_SAMPLE
      break
    fi
  else
    BALLOON_STABLE_TARGET=""
    BALLOON_STABLE_SAMPLES=0
  fi
  sleep 2
done
[ -n "$BALLOON_BEFORE" ] \
  || fail "active balloon did not stabilize at or above ${BALLOON_MIN_STABLE_MIB} MiB"
BALLOON_BEFORE_ACTUAL=$(jq -r '.actual_mib' <<<"$BALLOON_BEFORE")
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
PRESSURE_AVAILABLE = 192 * MIB


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
marker = pathlib.Path("/tmp/vm0-balloon-pressure/prepared")
if not marker.is_file():
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
pressure_announced = False
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
    mem_available_bytes = (
        read_key_values(pathlib.Path("/proc/meminfo"))["MemAvailable:"] * 1024
    )
    if not pressure_announced and mem_available_bytes < PRESSURE_AVAILABLE:
        print(
            f"memory-reclaim-pressure-ready available_bytes={mem_available_bytes}",
            flush=True,
        )
        pressure_announced = True
    time.sleep(0.01)

peak = snapshot(workload, control)
if not pressure_announced:
    raise RuntimeError(
        "memory pressure did not cross the balloon pressure boundary: "
        f"available={peak['mem_available_bytes']} boundary={PRESSURE_AVAILABLE}"
    )
if peak["workload_current"] <= legacy_memory_max:
    raise RuntimeError(
        "memory pressure did not cross the retired workload boundary: "
        f"current={peak['workload_current']} legacy_max={legacy_memory_max}"
    )

time.sleep(25)
chunks.clear()
gc.collect()
time.sleep(1)
after = snapshot(workload, control)
for event in ("max", "oom", "oom_kill", "oom_group_kill"):
    if after["workload_events"].get(event, 0) != before["workload_events"].get(event, 0):
        raise RuntimeError(f"memory pressure triggered workload-local {event}")
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
MEMORY_RECLAIM_OUTPUT=$(mktemp)
sudo "$BIN_DIR/runner" exec \
  --timeout 80 \
  --sandbox "$PRESSURE_SANDBOX_ID" \
  -- python3 -c "$MEMORY_RECLAIM_COMMAND" \
  >"$MEMORY_RECLAIM_OUTPUT" 2>&1 &
MEMORY_RECLAIM_PID=$!

MEMORY_PRESSURE_READY_LINE=""
for _ in $(seq 1 60); do
  MEMORY_PRESSURE_READY_LINE=$(grep -E \
    '^memory-reclaim-pressure-ready available_bytes=[0-9]+$' \
    "$MEMORY_RECLAIM_OUTPUT" | tail -1 || true)
  [ -n "$MEMORY_PRESSURE_READY_LINE" ] && break
  if ! kill -0 "$MEMORY_RECLAIM_PID" 2>/dev/null; then
    if wait "$MEMORY_RECLAIM_PID"; then
      MEMORY_RECLAIM_STATUS=0
    else
      MEMORY_RECLAIM_STATUS=$?
    fi
    MEMORY_RECLAIM_PID=""
    cat "$MEMORY_RECLAIM_OUTPUT"
    fail "workload exited with status ${MEMORY_RECLAIM_STATUS} before balloon pressure"
  fi
  sleep 1
done
[ -n "$MEMORY_PRESSURE_READY_LINE" ] \
  || fail "workload did not reach the balloon pressure boundary"
MEMORY_PRESSURE_AVAILABLE=$(sed -n \
  's/^memory-reclaim-pressure-ready available_bytes=\([0-9][0-9]*\)$/\1/p' \
  <<<"$MEMORY_PRESSURE_READY_LINE")
[ "$MEMORY_PRESSURE_AVAILABLE" -lt $((192 * 1024 * 1024)) ] \
  || fail "workload reported an invalid balloon pressure boundary"

BALLOON_PRESSURE_SAMPLE=""
BALLOON_DURING=""
BALLOON_RELIEF_TIMEOUT_SECONDS=20
SECONDS=0
while [ "$SECONDS" -le "$BALLOON_RELIEF_TIMEOUT_SECONDS" ]; do
  BALLOON_DURING=$(sudo curl -sf --unix-socket "$PRESSURE_API_SOCK" \
    http://localhost/balloon/statistics \
    | jq -ce '{target_mib, actual_mib, free_memory, available_memory}') \
    || fail "failed to sample balloon during memory reclaim pressure"
  BALLOON_DURING_TARGET=$(jq -r '.target_mib' <<<"$BALLOON_DURING")
  BALLOON_DURING_ACTUAL=$(jq -r '.actual_mib' <<<"$BALLOON_DURING")
  if [ "$BALLOON_DURING_TARGET" -eq 0 ] \
    && [ "$BALLOON_DURING_ACTUAL" -lt "$BALLOON_BEFORE_ACTUAL" ]; then
    BALLOON_PRESSURE_SAMPLE=$BALLOON_DURING
    break
  fi
  if ! kill -0 "$MEMORY_RECLAIM_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done
if [ -z "$BALLOON_PRESSURE_SAMPLE" ]; then
  cat "$MEMORY_RECLAIM_OUTPUT"
  fail "active balloon did not release its full target within ${BALLOON_RELIEF_TIMEOUT_SECONDS}s of Guest pressure: before=${BALLOON_BEFORE} during=${BALLOON_DURING}"
fi

if wait "$MEMORY_RECLAIM_PID"; then
  MEMORY_RECLAIM_STATUS=0
else
  MEMORY_RECLAIM_STATUS=$?
fi
MEMORY_RECLAIM_PID=""
MEMORY_RECLAIM_RESULT=$(<"$MEMORY_RECLAIM_OUTPUT")
printf '%s\n' "$MEMORY_RECLAIM_RESULT"
[ "$MEMORY_RECLAIM_STATUS" -eq 0 ] \
  || fail "workload could not cross the retired memory boundary"
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
echo "memory-reclaim-balloon before=$BALLOON_BEFORE pressure=$BALLOON_PRESSURE_SAMPLE after=$BALLOON_AFTER"
rm -f "$MEMORY_RECLAIM_OUTPUT"
MEMORY_RECLAIM_OUTPUT=""

if wait "$PRESSURE_SUBMIT_PID"; then
  PRESSURE_SUBMIT_STATUS=0
else
  PRESSURE_SUBMIT_STATUS=$?
fi
PRESSURE_SUBMIT_PID=""
cat "$PRESSURE_SUBMIT_OUTPUT"
[ "$PRESSURE_SUBMIT_STATUS" -eq 0 ] \
  || fail "active input did not remain live during balloon pressure"
PRESSURE_SUBMIT_JSON=$(awk '/^\{/{line=$0} END{print line}' "$PRESSURE_SUBMIT_OUTPUT")
[ -n "$PRESSURE_SUBMIT_JSON" ] \
  || fail "balloon-pressure submit did not return a JSON result"
SUBMITTED_PRESSURE_RUN_ID=$(jq -r '.run_id // empty' <<<"$PRESSURE_SUBMIT_JSON")
[ "$SUBMITTED_PRESSURE_RUN_ID" = "$PRESSURE_RUN_ID" ] \
  || fail "balloon-pressure result run ID did not match its claim"
PRESSURE_STREAM_LOG="/var/lib/vm0-runner/logs/system-stream-${PRESSURE_RUN_ID}.log"
PRESSURE_METRICS_LOG="/var/lib/vm0-runner/logs/metrics-${PRESSURE_RUN_ID}.jsonl"
sudo grep -F -q \
  'RESULT=balloon-pressure-ready+balloon-pressure-one+balloon-pressure-two+balloon-pressure-three+balloon-pressure-four+balloon-pressure-five+pressure-finish' \
  "$PRESSURE_STREAM_LOG" \
  || fail "balloon-pressure active inputs were not all consumed in order"

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
  || fail "failed to summarize balloon-pressure Guest metrics"
read -r METRICS_COUNT METRICS_SPAN_SECS METRICS_MAX_GAP_SECS <<<"$METRICS_SUMMARY"
[ "$METRICS_SPAN_SECS" -ge 50 ] \
  || fail "Guest control metrics did not span balloon pressure: ${METRICS_SPAN_SECS}s"
[ "$METRICS_MAX_GAP_SECS" -le 15 ] \
  || fail "Guest control metric cadence exceeded 15s: ${METRICS_MAX_GAP_SECS}s"
rm -f "$PRESSURE_SUBMIT_OUTPUT"
PRESSURE_SUBMIT_OUTPUT=""

echo "PASS: high-retention balloon pressure kept active input and ${METRICS_COUNT} metric samples live"

sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
wait_for_unit_inactive
sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
trap - EXIT

echo "=== Balloon-pressure test passed ==="
REMOTE_SCRIPT
