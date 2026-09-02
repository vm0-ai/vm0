#!/usr/bin/env bash
set -euo pipefail

: "${METAL_USER:?METAL_USER is required}"
: "${HOST:?HOST is required}"
: "${JOB_REF:?JOB_REF is required}"
: "${DEFAULT_ROOTFS_HASH:?DEFAULT_ROOTFS_HASH is required}"
: "${TEST_BIN:?TEST_BIN is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"

case "$JOB_REF" in
  ''|*[!a-zA-Z0-9._-]*)
    echo "JOB_REF contains unsupported characters" >&2
    exit 2
    ;;
esac
case "$GITHUB_RUN_ID:$GITHUB_RUN_ATTEMPT" in
  *[!0-9:]*|:*|*:)
    echo "GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must be numeric" >&2
    exit 2
    ;;
esac
if [ ! -x "$TEST_BIN" ]; then
  echo "host CPU fairness test binary is not executable: $TEST_BIN" >&2
  exit 2
fi
if [[ ! "$DEFAULT_ROOTFS_HASH" =~ ^[0-9a-f]{64}$ ]]; then
  echo "DEFAULT_ROOTFS_HASH must be a lowercase SHA-256 hash" >&2
  exit 2
fi

REMOTE="${METAL_USER}@${HOST}"
EXECUTION_KEY="${JOB_REF}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
REMOTE_BIN="/tmp/vm0-host-cpu-fairness-${EXECUTION_KEY}"

cleanup_remote_binary() {
  ssh "$REMOTE" bash -s -- "$REMOTE_BIN" 2>/dev/null <<'REMOTE_CLEANUP' || true
set -euo pipefail
rm -f -- "$1"
REMOTE_CLEANUP
}
trap cleanup_remote_binary EXIT

scp "$TEST_BIN" "${REMOTE}:${REMOTE_BIN}"

ssh "$REMOTE" bash -s -- \
  "$REMOTE_BIN" "$DEFAULT_ROOTFS_HASH" "$EXECUTION_KEY" <<'REMOTE_SCRIPT'
set -euo pipefail

TEST_BIN=$1
ROOTFS_HASH=$2
EXECUTION_KEY=$3
BASE_DIR="/var/lib/vm0-runner/host-cpu-fairness/${EXECUTION_KEY}"
BASELINE_UNIT="vm0-host-cpu-baseline-${EXECUTION_KEY}"
MANAGED_UNIT="vm0-host-cpu-managed-${EXECUTION_KEY}"

case "$EXECUTION_KEY" in
  ''|*[!a-zA-Z0-9._-]*)
    echo "unsafe execution key" >&2
    exit 2
    ;;
esac

cleanup() {
  sudo systemctl stop "${BASELINE_UNIT}.service" 2>/dev/null || true
  sudo systemctl stop "${MANAGED_UNIT}.service" 2>/dev/null || true
  sudo rm -f -- "$TEST_BIN"
  sudo rm -rf -- "$BASE_DIR"
}
trap cleanup EXIT

SYSTEMD_VERSION=$(systemd --version | awk 'NR == 1 { print $2 }')
case "$SYSTEMD_VERSION" in
  ''|*[!0-9]*)
    echo "cannot parse systemd version: $SYSTEMD_VERSION" >&2
    exit 1
    ;;
esac
if [ "$SYSTEMD_VERSION" -lt 254 ]; then
  echo "systemd 254+ is required, found $SYSTEMD_VERSION" >&2
  exit 1
fi

FIRECRACKER_DIR=$(find /var/lib/vm0-runner/firecracker \
  -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)
FIRECRACKER="${FIRECRACKER_DIR}/firecracker"
KERNEL=$(find "$FIRECRACKER_DIR" -maxdepth 1 -type f -name 'vmlinux-*' | sort | tail -1)
ROOTFS="/var/lib/vm0-runner/images/${ROOTFS_HASH}/rootfs.ext4"
for fixture in "$TEST_BIN" "$FIRECRACKER" "$KERNEL" "$ROOTFS"; do
  if [ ! -f "$fixture" ]; then
    echo "required host CPU fairness fixture is missing: $fixture" >&2
    exit 1
  fi
done

sudo modprobe nbd nbds_max=4096
sudo mkdir -p "$BASE_DIR/baseline" "$BASE_DIR/managed"

run_test() {
  local mode=$1
  local unit=$2
  local base_dir=$3
  local max_ratio=${4:-}
  local args=(
    --wait
    --collect
    --pipe
    "--unit=${unit}"
    --property=Type=exec
    --property=Delegate=cpu
    --property=DelegateSubgroup=control
    --property=AllowedCPUs=0-3
    --property=TimeoutStopSec=60
    "--setenv=VM0_HOST_CPU_TEST_MODE=${mode}"
    "--setenv=VM0_HOST_CPU_TEST_FIRECRACKER=${FIRECRACKER}"
    "--setenv=VM0_HOST_CPU_TEST_KERNEL=${KERNEL}"
    "--setenv=VM0_HOST_CPU_TEST_ROOTFS=${ROOTFS}"
    "--setenv=VM0_HOST_CPU_TEST_BASE_DIR=${base_dir}"
  )
  if [ -n "$max_ratio" ]; then
    args+=("--setenv=VM0_HOST_CPU_TEST_MAX_NORMALIZED_RATIO=${max_ratio}")
  fi
  sudo systemd-run "${args[@]}" \
    "$TEST_BIN" --ignored --test-threads=1 --nocapture
}

echo "=== Unmanaged host CPU baseline ==="
BASELINE_OUTPUT=$(run_test baseline "$BASELINE_UNIT" "$BASE_DIR/baseline")
printf '%s\n' "$BASELINE_OUTPUT"
BASELINE_RATIO=$(printf '%s\n' "$BASELINE_OUTPUT" \
  | sed -n 's/^HOST_CPU_NORMALIZED_RATIO=//p' | tail -1)
if ! awk -v value="$BASELINE_RATIO" 'BEGIN { exit !(value + 0 > 0) }'; then
  echo "baseline did not publish a valid normalized ratio: $BASELINE_RATIO" >&2
  exit 1
fi
MAX_RATIO=$(awk -v baseline="$BASELINE_RATIO" \
  'BEGIN { value = baseline * 1.25; if (value < 1.75) value = 1.75; printf "%.6f", value }')
echo "Baseline normalized ratio: $BASELINE_RATIO; managed tolerance: $MAX_RATIO"

echo "=== Managed weighted host CPU proof ==="
run_test managed "$MANAGED_UNIT" "$BASE_DIR/managed" "$MAX_RATIO"
REMOTE_SCRIPT
