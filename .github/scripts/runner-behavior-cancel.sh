#!/usr/bin/env bash
set -euo pipefail

REMOTE="${METAL_USER}@${HOST}"
SVC="${JOB_REF}-cancel"
RUNNER_DIR="/var/lib/vm0-runner/runners/${SVC}"
GROUP="vm0/cancel-${JOB_REF}"
GROUP_DIR="/var/lib/vm0-runner/groups/${GROUP}"

echo "=== Cleaning stale cancel runner state ==="
ssh "$REMOTE" bash -s -- "$BIN_DIR" "$SVC" "$GROUP_DIR" "$RUNNER_DIR" <<'REMOTE_SCRIPT'
set -euo pipefail
BIN_DIR=$1; SVC=$2; GROUP_DIR=$3; RUNNER_DIR=$4
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
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

echo "=== Running cancel test ==="
ssh "$REMOTE" bash -s -- \
  "$BIN_DIR" "$SVC" "$GROUP" "$GROUP_DIR" "$RUNNER_DIR" <<'REMOTE_SCRIPT'
set -euo pipefail
BIN_DIR=$1; SVC=$2; GROUP=$3; GROUP_DIR=$4; RUNNER_DIR=$5
SUBMIT_PID=""
SUBMIT_OUTPUT=$(mktemp)
RECONCILE_TEST_DIR=$(mktemp -d "/tmp/vm0-${SVC}-reconcile.XXXXXX")
RECONCILE_BIN_DIR="$RECONCILE_TEST_DIR/bin"
RECONCILE_COUNT_DIR="$RECONCILE_TEST_DIR/counts"
RECONCILE_LOCK_INFO="$RECONCILE_TEST_DIR/pool-indexes"
RECONCILE_IDLE_RELEASE="$RECONCILE_TEST_DIR/release-idle"
RECONCILE_IDLE_RELEASED="$RECONCILE_TEST_DIR/idle-released"
RECONCILE_ACTIVE_RELEASE="$RECONCILE_TEST_DIR/release-active"
RECONCILE_SNAPSHOT_READY="$RECONCILE_TEST_DIR/snapshot-ready"
RECONCILE_SNAPSHOT_RELEASE="$RECONCILE_TEST_DIR/release-snapshot"
RECONCILE_LOCK_HOLDER_PID=""

fail() { echo "FAIL: $1"; exit 1; }

print_service_logs() {
  echo "--- ${SVC} service logs ---"
  sudo "$BIN_DIR/runner" service logs --name "$SVC" --lines 200 || true
}

cleanup_submit_pid() {
  local pid=$1
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local status=$?
  trap - EXIT
  touch "$RECONCILE_IDLE_RELEASE" "$RECONCILE_ACTIVE_RELEASE" \
    "$RECONCILE_SNAPSHOT_RELEASE"
  if [ "$status" -ne 0 ]; then
    print_service_logs
  fi
  echo "--- Cleanup ---"
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force || true
  cleanup_submit_pid "$SUBMIT_PID"
  sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
  rm -f "$SUBMIT_OUTPUT"
  if [ -n "$RECONCILE_LOCK_HOLDER_PID" ]; then
    wait "$RECONCILE_LOCK_HOLDER_PID" 2>/dev/null || true
  fi
  sudo rm -rf "$RECONCILE_TEST_DIR"
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$RECONCILE_BIN_DIR" "$RECONCILE_COUNT_DIR"
REAL_IP=$(command -v ip)
REAL_IPTABLES=$(command -v iptables)
REAL_IPTABLES_SAVE=$(command -v iptables-save)
REAL_IP6TABLES_SAVE=$(command -v ip6tables-save)

# Reserve four pool indexes before the runner starts. Two become clean
# historical indexes, one owns a synthetic firewall-only orphan, and one
# remains active throughout reconciliation. The namespace-list wrapper gates
# the snapshot so the first three locks are released only after the runner has
# acquired a different index.
sudo bash -s -- \
  "$RECONCILE_LOCK_INFO" \
  "$RECONCILE_IDLE_RELEASE" \
  "$RECONCILE_IDLE_RELEASED" \
  "$RECONCILE_ACTIVE_RELEASE" <<'LOCK_HOLDER' &
set -euo pipefail
LOCK_INFO=$1
IDLE_RELEASE=$2
IDLE_RELEASED=$3
ACTIVE_RELEASE=$4
declare -a RESERVED_FDS=()
declare -a RESERVED_INDEXES=()

reserve_index() {
  local index=$1
  local path="/var/lock/vm0-netns-pool-${index}.lock"
  local candidate_fd
  exec {candidate_fd}>>"$path"
  if flock -n "$candidate_fd"; then
    RESERVED_FDS+=("$candidate_fd")
    RESERVED_INDEXES+=("$index")
  else
    exec {candidate_fd}>&-
  fi
}

# Prefer existing persistent lock files. Create new files only if the host has
# fewer than four idle indexes available.
for index in $(seq 63 -1 0); do
  [ -e "/var/lock/vm0-netns-pool-${index}.lock" ] || continue
  reserve_index "$index"
  [ "${#RESERVED_INDEXES[@]}" -eq 4 ] && break
done
if [ "${#RESERVED_INDEXES[@]}" -lt 4 ]; then
  for index in $(seq 63 -1 0); do
    [ -e "/var/lock/vm0-netns-pool-${index}.lock" ] && continue
    reserve_index "$index"
    [ "${#RESERVED_INDEXES[@]}" -eq 4 ] && break
  done
fi
[ "${#RESERVED_INDEXES[@]}" -eq 4 ] || exit 1
printf '%s\n' "${RESERVED_INDEXES[@]}" >"$LOCK_INFO"

while [ ! -e "$IDLE_RELEASE" ]; do sleep 0.05; done
for position in 0 1 2; do
  flock -u "${RESERVED_FDS[$position]}"
done
touch "$IDLE_RELEASED"

while [ ! -e "$ACTIVE_RELEASE" ]; do sleep 0.05; done
LOCK_HOLDER
RECONCILE_LOCK_HOLDER_PID=$!

for _ in $(seq 1 200); do
  [ -s "$RECONCILE_LOCK_INFO" ] && break
  kill -0 "$RECONCILE_LOCK_HOLDER_PID" 2>/dev/null \
    || fail "failed to reserve namespace pool indexes"
  sleep 0.05
done
[ -s "$RECONCILE_LOCK_INFO" ] || fail "timed out reserving namespace pool indexes"
mapfile -t RECONCILE_POOL_INDEXES <"$RECONCILE_LOCK_INFO"
printf -v RECONCILE_FIREWALL_POOL_HEX '%02x' "${RECONCILE_POOL_INDEXES[2]}"
printf -v RECONCILE_ACTIVE_POOL_HEX '%02x' "${RECONCILE_POOL_INDEXES[3]}"

cat >"$RECONCILE_BIN_DIR/network-command" <<'NETWORK_COMMAND'
#!/usr/bin/env bash
set -euo pipefail

COMMAND_NAME=${0##*/}

find_own_pool_hex() {
  local fd target index
  for fd in /proc/"$PPID"/fd/*; do
    target=$(readlink "$fd" 2>/dev/null || true)
    case "$target" in
      */vm0-netns-pool-*.lock)
        index=${target##*/vm0-netns-pool-}
        index=${index%.lock}
        case "$index" in
          '' | *[!0-9]*) continue ;;
        esac
        if [ "$index" -lt 64 ]; then
          printf '%02x\n' "$index"
          return 0
        fi
        ;;
    esac
  done
  return 1
}

contains_argument() {
  local expected=$1
  shift
  local argument
  for argument in "$@"; do
    [ "$argument" = "$expected" ] && return 0
  done
  return 1
}

case "$COMMAND_NAME" in
  iptables-save | ip6tables-save)
    if [ "${1:-}" = "-t" ] && [ -n "${2:-}" ]; then
      printf '1\n' >>"$VM0_RECONCILE_COUNT_DIR/${COMMAND_NAME}.${2}"
    fi
    if [ "$COMMAND_NAME" = "iptables-save" ]; then
      REAL_COMMAND=$VM0_RECONCILE_REAL_IPTABLES_SAVE
    else
      REAL_COMMAND=$VM0_RECONCILE_REAL_IP6TABLES_SAVE
    fi
    if "$REAL_COMMAND" "$@"; then
      STATUS=0
    else
      STATUS=$?
    fi
    if [ "$STATUS" -eq 0 ] && [ "${1:-}" = "-t" ] && [ "${2:-}" = "filter" ]; then
      OWN_POOL_HEX=$(find_own_pool_hex)
      printf '%s\n' "$OWN_POOL_HEX" >"$VM0_RECONCILE_COUNT_DIR/own-pool"
      if [ "$COMMAND_NAME" = "iptables-save" ]; then
        printf '%s\n' \
          "-A VM0-RECONCILE-OWN -m comment --comment \"vm0-ns-${OWN_POOL_HEX}-fd\" -j ACCEPT" \
          "-A VM0-RECONCILE-IDLE -m comment --comment \"vm0-ns-${VM0_RECONCILE_FIREWALL_POOL_HEX}-dns\" -j REJECT" \
          "-A VM0-RECONCILE-DECOY -m comment --comment \"vm0-ns-${VM0_RECONCILE_FIREWALL_POOL_HEX}-dns-extra\" -j REJECT"
      fi
    fi
    exit "$STATUS"
    ;;
  iptables)
    OWN_POOL_HEX=$(<"$VM0_RECONCILE_COUNT_DIR/own-pool")
    if contains_argument VM0-RECONCILE-OWN "$@" \
      && contains_argument "vm0-ns-${OWN_POOL_HEX}-fd" "$@"; then
      printf '1\n' >>"$VM0_RECONCILE_COUNT_DIR/iptables.own-delete"
      exit 0
    fi
    if contains_argument VM0-RECONCILE-IDLE "$@" \
      && contains_argument "vm0-ns-${VM0_RECONCILE_FIREWALL_POOL_HEX}-dns" "$@"; then
      printf '1\n' >>"$VM0_RECONCILE_COUNT_DIR/iptables.firewall-only-delete"
      exit 0
    fi
    if contains_argument VM0-RECONCILE-DECOY "$@"; then
      printf '1\n' >>"$VM0_RECONCILE_COUNT_DIR/iptables.decoy-delete"
      exit 0
    fi
    exec "$VM0_RECONCILE_REAL_IPTABLES" "$@"
    ;;
  ip)
    if [ "${1:-}" = "netns" ] && [ "${2:-}" = "list" ]; then
      printf '1\n' >>"$VM0_RECONCILE_COUNT_DIR/ip.netns-list"
      if mkdir "$VM0_RECONCILE_COUNT_DIR/netns-list-gate" 2>/dev/null; then
        touch "$VM0_RECONCILE_SNAPSHOT_READY"
        while [ ! -e "$VM0_RECONCILE_SNAPSHOT_RELEASE" ]; do sleep 0.05; done
      fi
      if REAL_OUTPUT=$("$VM0_RECONCILE_REAL_IP" "$@"); then
        STATUS=0
      else
        STATUS=$?
      fi
      if [ "$STATUS" -eq 0 ]; then
        OWN_POOL_HEX=$(find_own_pool_hex)
        printf '%s\n' "$OWN_POOL_HEX" >"$VM0_RECONCILE_COUNT_DIR/own-pool"
        [ -z "$REAL_OUTPUT" ] || printf '%s\n' "$REAL_OUTPUT"
        if ! awk -v name="vm0-ns-${OWN_POOL_HEX}-fd" \
          '$1 == name { found = 1 } END { exit !found }' <<<"$REAL_OUTPUT"; then
          printf '%s\n' "vm0-ns-${OWN_POOL_HEX}-fd"
        fi
        if ! awk -v name="vm0-ns-${VM0_RECONCILE_ACTIVE_POOL_HEX}-fc" \
          '$1 == name { found = 1 } END { exit !found }' <<<"$REAL_OUTPUT"; then
          printf '%s\n' "vm0-ns-${VM0_RECONCILE_ACTIVE_POOL_HEX}-fc"
        fi
      fi
      exit "$STATUS"
    fi

    OWN_POOL_HEX=$(<"$VM0_RECONCILE_COUNT_DIR/own-pool")
    if [ "${1:-}" = "link" ] && [ "${2:-}" = "del" ] \
      && [ "${3:-}" = "vm0-ve-${OWN_POOL_HEX}-fd" ]; then
      printf '1\n' >>"$VM0_RECONCILE_COUNT_DIR/ip.own-link-delete"
      exec "$VM0_RECONCILE_REAL_IP" "$@"
    fi
    if [ "${1:-}" = "netns" ] && [ "${2:-}" = "del" ] \
      && [ "${3:-}" = "vm0-ns-${OWN_POOL_HEX}-fd" ]; then
      printf '1\n' >>"$VM0_RECONCILE_COUNT_DIR/ip.own-netns-delete"
      exec "$VM0_RECONCILE_REAL_IP" "$@"
    fi
    if contains_argument "vm0-ns-${VM0_RECONCILE_ACTIVE_POOL_HEX}-fc" "$@" \
      || contains_argument "vm0-ve-${VM0_RECONCILE_ACTIVE_POOL_HEX}-fc" "$@"; then
      printf '1\n' >>"$VM0_RECONCILE_COUNT_DIR/ip.active-delete"
      exit 0
    fi
    exec "$VM0_RECONCILE_REAL_IP" "$@"
    ;;
esac

exit 127
NETWORK_COMMAND
chmod 755 "$RECONCILE_BIN_DIR/network-command"
for command in ip iptables iptables-save ip6tables-save; do
  ln -s network-command "$RECONCILE_BIN_DIR/$command"
done

# Start transient runner service
echo "--- Starting runner ---"
sudo "$BIN_DIR/runner" service start --name "$SVC" \
  --config "$RUNNER_DIR/runner.yaml" --local \
  --env USE_MOCK_CLAUDE=true \
  --env USE_MOCK_CODEX=true \
  --env "PATH=$RECONCILE_BIN_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  --env "VM0_RECONCILE_COUNT_DIR=$RECONCILE_COUNT_DIR" \
  --env "VM0_RECONCILE_REAL_IP=$REAL_IP" \
  --env "VM0_RECONCILE_REAL_IPTABLES=$REAL_IPTABLES" \
  --env "VM0_RECONCILE_REAL_IPTABLES_SAVE=$REAL_IPTABLES_SAVE" \
  --env "VM0_RECONCILE_REAL_IP6TABLES_SAVE=$REAL_IP6TABLES_SAVE" \
  --env "VM0_RECONCILE_FIREWALL_POOL_HEX=$RECONCILE_FIREWALL_POOL_HEX" \
  --env "VM0_RECONCILE_ACTIVE_POOL_HEX=$RECONCILE_ACTIVE_POOL_HEX" \
  --env "VM0_RECONCILE_SNAPSHOT_READY=$RECONCILE_SNAPSHOT_READY" \
  --env "VM0_RECONCILE_SNAPSHOT_RELEASE=$RECONCILE_SNAPSHOT_RELEASE"

for _ in $(seq 1 200); do
  [ -e "$RECONCILE_SNAPSHOT_READY" ] && break
  sleep 0.05
done
[ -e "$RECONCILE_SNAPSHOT_READY" ] \
  || fail "runner did not begin namespace reconciliation snapshot"
touch "$RECONCILE_IDLE_RELEASE"
for _ in $(seq 1 200); do
  [ -e "$RECONCILE_IDLE_RELEASED" ] && break
  sleep 0.05
done
[ -e "$RECONCILE_IDLE_RELEASED" ] \
  || fail "timed out releasing idle namespace pool indexes"
touch "$RECONCILE_SNAPSHOT_RELEASE"

# Submit a long-running job in background
echo "--- Submitting long-running job ---"
sudo "$BIN_DIR/runner" local submit \
  --group "$GROUP" --prompt 'sleep 60 && echo done' >"$SUBMIT_OUTPUT" 2>&1 &
SUBMIT_PID=$!

# Resolve this submission from its claim instead of selecting the first active
# run. A failed prior attempt must never redirect cancellation to stale work.
echo "--- Waiting for sandbox ---"
RUN_ID=""
SANDBOX_ID=""
SANDBOX_READY=false
for _ in $(seq 1 60); do
  mapfile -t CLAIM_FILES < <(
    sudo find "$GROUP_DIR/claims" -maxdepth 1 -type f -name '*.claim' \
      -printf '%f\n' 2>/dev/null | sort
  )
  [ "${#CLAIM_FILES[@]}" -le 1 ] \
    || fail "expected one claimed job, found ${#CLAIM_FILES[@]}"
  if [ "${#CLAIM_FILES[@]}" -eq 1 ]; then
    RUN_ID=${CLAIM_FILES[0]%.claim}
    SANDBOX_ID=$(sudo jq -r --arg run_id "$RUN_ID" \
      '.active_runs[]? | select(.run_id == $run_id) | .sandbox_id' \
      "$RUNNER_DIR/status.json" 2>/dev/null)
    if [ -n "$SANDBOX_ID" ] \
      && [ -S "/run/vm0/sock/$SANDBOX_ID/control.sock" ]; then
      SANDBOX_READY=true
      break
    fi
  fi
  SANDBOX_ID=""
  sleep 1
done
[ "$SANDBOX_READY" = true ] || fail "sandbox not found after 60s"
echo "Found run $RUN_ID (sandbox $SANDBOX_ID)"

assert_reconcile_count() {
  local name=$1 expected=$2 path="$RECONCILE_COUNT_DIR/$1" actual=0
  if [ -f "$path" ]; then
    actual=$(wc -l <"$path")
  fi
  [ "$actual" -eq "$expected" ] \
    || fail "expected $expected reconciliation $name call(s), found $actual"
}

echo "--- Test: startup reconciliation uses one host snapshot ---"
assert_reconcile_count iptables-save.raw 1
assert_reconcile_count iptables-save.nat 1
assert_reconcile_count iptables-save.filter 1
assert_reconcile_count ip6tables-save.filter 1
assert_reconcile_count ip.netns-list 1
assert_reconcile_count iptables.own-delete 1
assert_reconcile_count ip.own-link-delete 1
assert_reconcile_count ip.own-netns-delete 1
assert_reconcile_count iptables.firewall-only-delete 1
assert_reconcile_count iptables.decoy-delete 0
assert_reconcile_count ip.active-delete 0
echo "PASS: startup reconciled one snapshot without modifying the active pool"

# Test 1: cancel the job via runner local cancel
echo "--- Test: runner local cancel ---"
sudo "$BIN_DIR/runner" local cancel --run "$RUN_ID" --group "$GROUP" || fail "cancel command failed"
echo "PASS: cancel command succeeded"

# Test 2: submit should exit quickly, well before the prompt completes.
echo "--- Test: waiting for submit to finish ---"
SECONDS=0
if wait "$SUBMIT_PID"; then
  SUBMIT_EXIT=0
else
  SUBMIT_EXIT=$?
fi
SUBMIT_PID=""
ELAPSED=$SECONDS
cat "$SUBMIT_OUTPUT"
echo "Submit exited with code $SUBMIT_EXIT in ${ELAPSED}s"
SUBMIT_JSON=$(awk '/^\{/{line=$0} END{print line}' "$SUBMIT_OUTPUT")
SUBMIT_RUN_ID=$(jq -r '.run_id // empty' <<<"$SUBMIT_JSON")
[ "$SUBMIT_RUN_ID" = "$RUN_ID" ] \
  || fail "cancelled run $RUN_ID but submit returned ${SUBMIT_RUN_ID:-missing}"
# Cancel should kill the job within 30s, not after the 60s prompt.
[ "$ELAPSED" -lt 30 ] || fail "submit took ${ELAPSED}s to exit — cancel likely did not work"
# Cancelled job returns non-zero exit code
[ "$SUBMIT_EXIT" -ne 0 ] || fail "expected non-zero exit from cancelled job, got 0"
echo "PASS: submit exited with non-zero after cancel (${ELAPSED}s)"

# Stop transient service
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
rm -f "$SUBMIT_OUTPUT"
touch "$RECONCILE_ACTIVE_RELEASE"
wait "$RECONCILE_LOCK_HOLDER_PID"
RECONCILE_LOCK_HOLDER_PID=""
sudo rm -rf "$RECONCILE_TEST_DIR"
trap - EXIT

echo "=== Cancel test passed ==="
REMOTE_SCRIPT
