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

setsid python3 -c 'import os, pathlib, signal, time; p=pathlib.Path("/tmp/vm0-process-containment/user.identity"); fields=pathlib.Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split(); p.write_text(f"{os.getpid()} {fields[19]}\n"); signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(300)' </dev/null >/dev/null 2>&1 &
setsid sudo -n python3 -c 'import os, pathlib, time; p=pathlib.Path("/tmp/vm0-process-containment/root.identity"); fields=pathlib.Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split(); p.write_text(f"{os.getpid()} {fields[19]}\n"); time.sleep(300)' </dev/null >/dev/null 2>&1 &

for _ in $(seq 1 100); do
  [ -s "$marker/user.identity" ] && [ -s "$marker/root.identity" ] && break
  sleep 0.01
done
test -s "$marker/user.identity"
test -s "$marker/root.identity"
echo containment-turn-1
PROMPT
)

echo "--- Turn 1: leave detached user/root descendants ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$CHAT_THREAD_ID" \
  --session-id "$SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt "$LEAK_PROMPT" \
  || fail "Turn 1 failed"

VERIFY_PROMPT=$(cat <<'PROMPT'
set -eu
marker=/tmp/vm0-process-containment
base=/sys/fs/cgroup/vm0-exec
test -f "$marker/vm-reuse-marker"

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
own_group=${relative##*/}
test -n "$own_group"
test -d "$base/$own_group"
test -z "$(find "$base" -mindepth 1 -maxdepth 1 -type d ! -name "$own_group" -print -quit)"
grep -q '^populated 1$' "$base/cgroup.events"
test -z "$(cat "$base/cgroup.subtree_control")"
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

echo "PASS: detached user/root descendants were reclaimed"
echo "PASS: leaked cleanup ${LEAK_CLEANUP_MS}ms; healthy cleanup preserved reuse"

sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
wait_for_unit_inactive
sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
trap - EXIT

echo "=== Process-containment test passed ==="
REMOTE_SCRIPT
