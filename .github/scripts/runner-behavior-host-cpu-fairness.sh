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
UNIT="vm0-host-cpu-managed-${EXECUTION_KEY}"
LOCK_DIR="/run/lock/vm0-host-cpu-fairness"
LOCK_FD=""

case "$EXECUTION_KEY" in
  ''|*[!a-zA-Z0-9._-]*)
    echo "unsafe execution key" >&2
    exit 2
    ;;
esac

cleanup() {
  sudo systemctl stop "${UNIT}.service" 2>/dev/null || true
  sudo rm -f -- "$TEST_BIN"
  sudo rm -rf -- "$BASE_DIR"
  if [ -n "$LOCK_FD" ]; then
    flock --unlock "$LOCK_FD" || true
    exec {LOCK_FD}>&-
  fi
}
trap cleanup EXIT

CPU_CANDIDATES=()
load_online_cpus() {
  local cpu_list=$1
  local range start end cpu
  local -a ranges

  if [[ ! "$cpu_list" =~ ^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$ ]]; then
    echo "invalid online CPU list: $cpu_list" >&2
    exit 1
  fi

  IFS=',' read -r -a ranges <<< "$cpu_list"
  for range in "${ranges[@]}"; do
    if [[ "$range" == *-* ]]; then
      start=$((10#${range%%-*}))
      end=$((10#${range#*-}))
    else
      start=$((10#$range))
      end=$start
    fi
    if [ "$start" -gt "$end" ]; then
      echo "invalid online CPU range: $range" >&2
      exit 1
    fi
    for ((cpu = start; cpu <= end; cpu++)); do
      CPU_CANDIDATES+=("$cpu")
    done
  done
}

load_online_cpus "$(</sys/devices/system/cpu/online)"
if [ "${#CPU_CANDIDATES[@]}" -gt 1 ]; then
  NONZERO_CPUS=()
  for cpu in "${CPU_CANDIDATES[@]}"; do
    if [ "$cpu" -ne 0 ]; then
      NONZERO_CPUS+=("$cpu")
    fi
  done
  CPU_CANDIDATES=("${NONZERO_CPUS[@]}")
fi

read -r SELECTION_HASH _ < <(printf '%s' "$EXECUTION_KEY" | cksum)
START_INDEX=$((SELECTION_HASH % ${#CPU_CANDIDATES[@]}))
sudo install -d -m 0755 -o "$(id -u)" -g "$(id -g)" "$LOCK_DIR"

SELECTED_CPU=""
for ((offset = 0; offset < ${#CPU_CANDIDATES[@]}; offset++)); do
  candidate_index=$(((START_INDEX + offset) % ${#CPU_CANDIDATES[@]}))
  candidate_cpu=${CPU_CANDIDATES[$candidate_index]}
  exec {candidate_lock_fd}>"${LOCK_DIR}/cpu-${candidate_cpu}.lock"
  if flock --nonblock "$candidate_lock_fd"; then
    SELECTED_CPU=$candidate_cpu
    LOCK_FD=$candidate_lock_fd
    break
  fi
  exec {candidate_lock_fd}>&-
done
if [ -z "$SELECTED_CPU" ]; then
  echo "no online host CPU is available for the fairness test" >&2
  exit 1
fi
echo "HOST_CPU_SELECTED_CPU=$SELECTED_CPU"

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
sudo mkdir -p "$BASE_DIR"

echo "=== Managed weighted host CPU proof ==="
sudo systemd-run \
  --wait \
  --collect \
  --pipe \
  "--unit=${UNIT}" \
  --property=Type=exec \
  --property=Delegate=cpu \
  --property=DelegateSubgroup=control \
  "--property=AllowedCPUs=${SELECTED_CPU}" \
  --property=TimeoutStopSec=60 \
  "--setenv=VM0_HOST_CPU_TEST_FIRECRACKER=${FIRECRACKER}" \
  "--setenv=VM0_HOST_CPU_TEST_KERNEL=${KERNEL}" \
  "--setenv=VM0_HOST_CPU_TEST_ROOTFS=${ROOTFS}" \
  "--setenv=VM0_HOST_CPU_TEST_BASE_DIR=${BASE_DIR}" \
  "$TEST_BIN" --ignored --test-threads=1 --nocapture
REMOTE_SCRIPT
