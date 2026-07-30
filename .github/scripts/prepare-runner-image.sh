#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.github/scripts/runner-image-target.sh
. "${SCRIPT_DIR}/runner-image-target.sh"
# shellcheck source=.github/scripts/cloudflare-ssh-diagnostics.sh
. "${SCRIPT_DIR}/cloudflare-ssh-diagnostics.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SSH_PROBE_TIMEOUT_SECONDS=20
SSH_PROBE_KILL_AFTER_SECONDS=5
SSH_CONTROL_TIMEOUT_SECONDS=5
SSH_CONTROL_KILL_AFTER_SECONDS=2

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

require_env JOB_REF
require_env HEAD_SHA
require_env METAL_HOSTS
require_env METAL_USER
job_ref=${JOB_REF:-}
head_sha=${HEAD_SHA:-}

TARGET_TRIPLE="${TARGET_TRIPLE-aarch64-unknown-linux-musl}"
PROFILE="${PROFILE:-vm0/default}"
MANIFEST_PATH="${MANIFEST_PATH:-runner-image-manifest/manifest.json}"
BIN_DIR="/var/lib/vm0-runner/bin/${job_ref}"
RUNNER_DIR="/var/lib/vm0-runner/runners/${job_ref}"
DERIVED_EXPECTED_REMOTE_ARCH=$(runner_image_expected_uname_m "$TARGET_TRIPLE")
if [ "${EXPECTED_REMOTE_ARCH+x}" = "x" ]; then
  if [ -z "$EXPECTED_REMOTE_ARCH" ]; then
    echo "EXPECTED_REMOTE_ARCH is empty" >&2
    exit 2
  fi
else
  EXPECTED_REMOTE_ARCH="$DERIVED_EXPECTED_REMOTE_ARCH"
fi
if [ "$EXPECTED_REMOTE_ARCH" != "$DERIVED_EXPECTED_REMOTE_ARCH" ]; then
  echo "EXPECTED_REMOTE_ARCH mismatch: ${TARGET_TRIPLE} maps to ${DERIVED_EXPECTED_REMOTE_ARCH}, got ${EXPECTED_REMOTE_ARCH}" >&2
  exit 2
fi

mapfile -t HOSTS < <(printf '%s\n' "$METAL_HOSTS" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep .)
if [ "${#HOSTS[@]}" -lt 1 ]; then
  echo "METAL_HOSTS is empty" >&2
  exit 1
fi
declare -A seen_hosts=()
for host in "${HOSTS[@]}"; do
  if [[ ! "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$ ]]; then
    echo "invalid METAL_HOSTS entry: ${host}" >&2
    exit 2
  fi
  host_key=${host,,}
  if [ -n "${seen_hosts[$host_key]+x}" ]; then
    echo "duplicate METAL_HOSTS entry: ${host}" >&2
    exit 2
  fi
  seen_hosts[$host_key]=1
done

mkdir -p "$(dirname "$MANIFEST_PATH")"

require_env RUNNER_PATH
require_env FRESH_METADATA_PATH
require_env EXPECTED_BINARY_INPUT_DIGEST
if [[ "$RUNNER_PATH" != /* ]]; then
  RUNNER_PATH="${REPO_ROOT}/${RUNNER_PATH}"
fi
if [[ "$FRESH_METADATA_PATH" != /* ]]; then
  FRESH_METADATA_PATH="${REPO_ROOT}/${FRESH_METADATA_PATH}"
fi
FRESH_METADATA_PATH="$FRESH_METADATA_PATH" \
RUNNER_PATH="$RUNNER_PATH" \
EXPECTED_TARGET="$TARGET_TRIPLE" \
EXPECTED_BINARY_INPUT_DIGEST="$EXPECTED_BINARY_INPUT_DIGEST" \
  "${SCRIPT_DIR}/runner-binary-cache.sh" fresh-validate >/dev/null

runner_sha=$(jq -r '.runnerSha256' "$FRESH_METADATA_PATH")
guest_sha_json=$(jq -c '.guestSha256' "$FRESH_METADATA_PATH")

TEMP_ROOT="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
LOG_DIR=$(mktemp -d "${TEMP_ROOT%/}/prepare-runner-image.XXXXXX")
declare -A RECOVERY_CONTROL_PATHS=()

cleanup() {
  local status=$?
  local host control_path
  trap - EXIT
  for host in "${!RECOVERY_CONTROL_PATHS[@]}"; do
    control_path="${RECOVERY_CONTROL_PATHS[$host]}"
    timeout \
      --kill-after="${SSH_CONTROL_KILL_AFTER_SECONDS}s" \
      "${SSH_CONTROL_TIMEOUT_SECONDS}s" \
      ssh -S "$control_path" -n -O exit "${METAL_USER}@${host}" \
      > /dev/null 2>&1 || true
  done
  rm -rf "$LOG_DIR"
  exit "$status"
}
trap cleanup EXIT

ssh_host() {
  local host=$1
  shift
  local control_path="${RECOVERY_CONTROL_PATHS[$host]:-}"
  local -a ssh_command=(ssh)
  if [ -n "$control_path" ]; then
    ssh_command+=(-S "$control_path")
  fi
  ssh_command+=("${METAL_USER}@${host}")
  "${ssh_command[@]}" "$@"
}

emit_probe_failure() {
  local host=$1
  local attempt=$2
  local status=$3
  local diagnostics_file=$4
  local master_diagnostics_file=${5:-}
  local annotation="warning"
  if [ "$attempt" -eq 2 ]; then
    annotation="error"
  fi

  echo "::${annotation} title=Cloudflare SSH command-channel probe failed::Unable to query ${host} through its SSH transport on attempt ${attempt}/2 (exit ${status})" >&2
  if [ -s "$diagnostics_file" ]; then
    echo "----- SSH command-channel probe stderr (last 20 lines, redacted) -----" >&2
    cloudflare_ssh_sanitize_diagnostics "$diagnostics_file" \
      | tail -n 20 >&2
  fi
  if [ -n "$master_diagnostics_file" ] \
    && [ -s "$master_diagnostics_file" ]; then
    echo "----- recovery SSH master stderr (last 20 lines, redacted) -----" >&2
    cloudflare_ssh_sanitize_diagnostics "$master_diagnostics_file" \
      | tail -n 20 >&2
  fi
}

probe_host_architecture() {
  local host=$1
  local host_index=$2
  local remote="${METAL_USER}@${host}"
  local control_path=""
  local stdout_file stderr_file status remote_arch attempt
  local -a control_args=()

  for attempt in 1 2; do
    stdout_file="${LOG_DIR}/${host}.probe.${attempt}.stdout"
    stderr_file="${LOG_DIR}/${host}.probe.${attempt}.stderr"
    status=0
    control_args=()
    control_path="${RECOVERY_CONTROL_PATHS[$host]:-}"
    if [ -n "$control_path" ]; then
      control_args=(-S "$control_path")
    fi

    timeout \
      --kill-after="${SSH_PROBE_KILL_AFTER_SECONDS}s" \
      "${SSH_PROBE_TIMEOUT_SECONDS}s" \
      ssh "${control_args[@]}" "$remote" uname -m \
      > "$stdout_file" 2> "$stderr_file" || status=$?

    if [ "$status" -eq 0 ]; then
      remote_arch=$(tail -n1 "$stdout_file" | tr -d '\r')
      if [ "$remote_arch" != "$EXPECTED_REMOTE_ARCH" ]; then
        echo "runner target ${TARGET_TRIPLE} expects remote architecture ${EXPECTED_REMOTE_ARCH}, but ${host} reported ${remote_arch}" >&2
        return 1
      fi

      if [ "$attempt" -eq 2 ]; then
        timeout \
          --kill-after="${SSH_CONTROL_KILL_AFTER_SECONDS}s" \
          "${SSH_CONTROL_TIMEOUT_SECONDS}s" \
          ssh -n -O exit "$remote" > /dev/null 2>&1 || true
      fi
      return 0
    fi

    emit_probe_failure \
      "$host" "$attempt" "$status" "$stderr_file" \
      "${control_path:+${control_path}.stderr}"
    if [ "$attempt" -eq 2 ]; then
      return "$status"
    fi

    control_path="${LOG_DIR}/recovery-${host_index}.sock"
    if ! "${SCRIPT_DIR}/cloudflare-ssh-preconnect.sh" \
      --control-path "$control_path" "$METAL_USER" "$host"; then
      return 1
    fi
    RECOVERY_CONTROL_PATHS["$host"]="$control_path"
  done
}

prepare_host() {
  local host=$1
  local host_index=$2
  echo "=== Preparing ${host} (job: ${job_ref}) ==="

  if ! ssh_host "$host" bash -s -- "${BIN_DIR}" "${RUNNER_DIR}" "${job_ref}" <<'REMOTE_SCRIPT'
set -euo pipefail
BIN_DIR=$1
RUNNER_DIR=$2
JOB_REF=$3
UNIT_PREFIX="vm0-runner-${JOB_REF}-"

declare -a PRIMARY_UNITS=()
discover_primary_units() {
  local output unit rest suffix
  if ! output=$(sudo systemctl list-units \
    --all --full --no-legend --plain "${UNIT_PREFIX}*.service" 2>&1); then
    printf '%s\n' "$output" >&2
    return 1
  fi

  PRIMARY_UNITS=()
  while read -r unit rest; do
    [ -n "$unit" ] || continue
    case "$unit" in
      "${UNIT_PREFIX}"*.service)
        suffix=${unit#"${UNIT_PREFIX}"}
        suffix=${suffix%.service}
        if [[ "$suffix" =~ ^[0-9]+$ ]]; then
          PRIMARY_UNITS+=("$unit")
        fi
        ;;
    esac
  done <<< "$output"
}

# This CI cleanup is intentionally forceful. Avoid executing the existing
# runner binary here: a cancelled prior prepare can leave a truncated binary at
# the final path.
discover_primary_units
STOPPED_UNITS=("${PRIMARY_UNITS[@]}")
if [ "${#STOPPED_UNITS[@]}" -gt 0 ]; then
  sudo systemctl stop "${STOPPED_UNITS[@]}"
fi

discover_primary_units
for unit in "${PRIMARY_UNITS[@]}"; do
  if ! state=$(sudo systemctl show \
    --property=ActiveState --value "$unit" 2>&1); then
    printf '%s\n' "$state" >&2
    exit 1
  fi
  case "$state" in
    inactive|failed) ;;
    *)
      echo "runner service ${unit} is ${state} after stop" >&2
      exit 1
      ;;
  esac
done

if [ "${#STOPPED_UNITS[@]}" -gt 0 ]; then
  sudo systemctl reset-failed "${STOPPED_UNITS[@]}" 2>/dev/null || true
fi

sudo rm -rf "${BIN_DIR}" "${RUNNER_DIR}"
sudo mkdir -p "${BIN_DIR}"
case "$BIN_DIR" in
  /var/lib/vm0-runner/bin/staging-*)
    sudo find /var/lib/vm0-runner/bin \
      -mindepth 1 -maxdepth 1 -type d \
      -name 'staging-*' ! -path "$BIN_DIR" -mtime +2 \
      -exec rm -rf {} +
    ;;
esac
REMOTE_SCRIPT
  then
    return 1
  fi

  local tmp_runner="${BIN_DIR}/runner.${head_sha}.${host_index}.tmp"
  if ! ssh_host "$host" sudo install -m 755 /dev/stdin "${tmp_runner}" < "$RUNNER_PATH"; then
    return 1
  fi

  if ! ssh_host "$host" bash -s -- "${tmp_runner}" "${BIN_DIR}/runner" "${runner_sha}" <<'REMOTE_SCRIPT'
set -euo pipefail
TMP_RUNNER=$1
FINAL_RUNNER=$2
EXPECTED_SHA=$3

cleanup_tmp() {
  sudo rm -f "${TMP_RUNNER}"
}
trap cleanup_tmp EXIT

actual_sha=$(sudo sha256sum "${TMP_RUNNER}" | awk '{print $1}')
if [ "${actual_sha}" != "${EXPECTED_SHA}" ]; then
  echo "runner sha mismatch: ${actual_sha} != ${EXPECTED_SHA}" >&2
  exit 1
fi

sudo "${TMP_RUNNER}" --version >/dev/null
sudo mv -f "${TMP_RUNNER}" "${FINAL_RUNNER}"
trap - EXIT
REMOTE_SCRIPT
  then
    return 1
  fi

  if ! ssh_host "$host" sudo "${BIN_DIR}/runner" gc --keep-latest 6; then
    return 1
  fi

  if ! ssh_host "$host" sudo "${BIN_DIR}/runner" setup; then
    return 1
  fi
  echo "=== Done preparing ${host} ==="
}

warm_rootfs_cache() {
  local host=$1
  echo "=== Warming shared template cache on ${host} ==="
  if ! ssh_host "$host" sudo \
    R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-}" \
    R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}" \
    R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}" \
    R2_USER_STORAGES_BUCKET_NAME="${R2_USER_STORAGES_BUCKET_NAME:-}" \
    "${BIN_DIR}/runner" build --profile "$PROFILE" --warm-rootfs-cache; then
    return 1
  fi
  echo "=== Done warming shared template cache on ${host} ==="
}

build_snapshot_on_host() {
  local host=$1
  echo "=== Building rootfs/snapshot on ${host} ==="
  if ! ssh_host "$host" sudo \
    R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-}" \
    R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}" \
    R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}" \
    R2_USER_STORAGES_BUCKET_NAME="${R2_USER_STORAGES_BUCKET_NAME:-}" \
    "${BIN_DIR}/runner" build --profile "$PROFILE"; then
    return 1
  fi
  echo "=== Done building rootfs/snapshot on ${host} ==="
}

for i in "${!HOSTS[@]}"; do
  probe_host_architecture "${HOSTS[$i]}" "$((i + 1))"
done

PIDS=()
for i in "${!HOSTS[@]}"; do
  host="${HOSTS[$i]}"
  host_index=$((i + 1))
  prepare_host "$host" "$host_index" > "${LOG_DIR}/${host}.prepare.log" 2>&1 &
  PIDS+=($!)
done

FAILED=0
for i in "${!PIDS[@]}"; do
  if ! wait "${PIDS[$i]}"; then
    FAILED=1
    echo "::error::Runner preparation failed on ${HOSTS[$i]}"
  fi
  echo "=== ${HOSTS[$i]} prepare ==="
  cat "${LOG_DIR}/${HOSTS[$i]}.prepare.log"
done
[ "$FAILED" -eq 0 ] || exit 1

WARM_HOST="${HOSTS[0]}"
if ! warm_rootfs_cache "$WARM_HOST" 2>&1 | tee "${LOG_DIR}/warm-rootfs-cache.log"; then
  echo "::error::Shared template cache warm failed on ${WARM_HOST}"
  exit 1
fi

PIDS=()
for host in "${HOSTS[@]}"; do
  build_snapshot_on_host "$host" > "${LOG_DIR}/${host}.build.log" 2>&1 &
  PIDS+=($!)
done

FAILED=0
for i in "${!PIDS[@]}"; do
  if ! wait "${PIDS[$i]}"; then
    FAILED=1
    echo "::error::Runner image build failed on ${HOSTS[$i]}"
  fi
  echo "=== ${HOSTS[$i]} build ==="
  cat "${LOG_DIR}/${HOSTS[$i]}.build.log"
done
[ "$FAILED" -eq 0 ] || exit 1

hosts_json=$(jq -n '{}')
rootfs_map=$(jq -n '{}')
snapshot_map=$(jq -n '{}')
for host in "${HOSTS[@]}"; do
  rootfs_hash=$(grep '^rootfs_hash=' "${LOG_DIR}/${host}.build.log" | tail -n1 | cut -d= -f2 || true)
  snapshot_hash=$(grep '^snapshot_hash=' "${LOG_DIR}/${host}.build.log" | tail -n1 | cut -d= -f2 || true)
  if [ -z "$rootfs_hash" ] || [ -z "$snapshot_hash" ]; then
    echo "::error::Failed to extract rootfs/snapshot hash from ${host} log"
    exit 1
  fi
  completed_at=$(date -u +%FT%TZ)
  hosts_json=$(jq -c \
    --arg h "$host" \
    --arg rootfs "$rootfs_hash" \
    --arg snapshot "$snapshot_hash" \
    --arg completed "$completed_at" \
    '. + {($h): {rootfsHash: $rootfs, snapshotHash: $snapshot, completedAt: $completed}}' \
    <<<"$hosts_json")
  rootfs_map=$(jq -c --arg h "$host" --arg v "$rootfs_hash" '. + {($h): $v}' <<<"$rootfs_map")
  snapshot_map=$(jq -c --arg h "$host" --arg v "$snapshot_hash" '. + {($h): $v}' <<<"$snapshot_map")
done

tmp_manifest="${MANIFEST_PATH}.tmp"
jq -n \
  --arg head_sha "$head_sha" \
  --arg job_ref "$job_ref" \
  --arg target "$TARGET_TRIPLE" \
  --arg profile "$PROFILE" \
  --arg bin_dir "$BIN_DIR" \
  --arg runner_dir "$RUNNER_DIR" \
  --arg runner_sha "$runner_sha" \
  --argjson guest_sha "$guest_sha_json" \
  --argjson hosts "$hosts_json" \
  '{
    schemaVersion: 1,
    headSha: $head_sha,
    jobRef: $job_ref,
    target: $target,
    profile: $profile,
    binDir: $bin_dir,
    runnerDir: $runner_dir,
    runnerSha256: $runner_sha,
    guestSha256: $guest_sha,
    hosts: $hosts
  }' > "$tmp_manifest"
mv "$tmp_manifest" "$MANIFEST_PATH"

echo "manifest-path=${MANIFEST_PATH}"
echo "bin-dir=${BIN_DIR}"
echo "runner-dir=${RUNNER_DIR}"
echo "rootfs-hash-map=${rootfs_map}"
echo "snapshot-hash-map=${snapshot_map}"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "manifest-path=${MANIFEST_PATH}"
    echo "bin-dir=${BIN_DIR}"
    echo "runner-dir=${RUNNER_DIR}"
    echo "rootfs-hash-map=${rootfs_map}"
    echo "snapshot-hash-map=${snapshot_map}"
  } >> "$GITHUB_OUTPUT"
fi
