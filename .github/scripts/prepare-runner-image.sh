#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${SCRIPT_DIR}/runner-image-target.sh"

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

TARGET_TRIPLE="${TARGET_TRIPLE-aarch64-unknown-linux-musl}"
PROFILE="${PROFILE:-vm0/default}"
MANIFEST_PATH="${MANIFEST_PATH:-runner-image-manifest/manifest.json}"
BIN_DIR="/var/lib/vm0-runner/bin/${JOB_REF}"
RUNNER_DIR="/var/lib/vm0-runner/runners/${JOB_REF}"
TARGET_DIR="crates/target/${TARGET_TRIPLE}/ci"
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
for host in "${HOSTS[@]}"; do
  if [[ ! "$host" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "invalid METAL_HOSTS entry: ${host}" >&2
    exit 2
  fi
done
duplicate_host=$(printf '%s\n' "${HOSTS[@]}" | LC_ALL=C sort | uniq -d)
duplicate_host=${duplicate_host%%$'\n'*}
if [ -n "$duplicate_host" ]; then
  echo "duplicate METAL_HOSTS entry: ${duplicate_host}" >&2
  exit 2
fi

mkdir -p "$(dirname "$MANIFEST_PATH")"

echo "=== Cross-compiling guest binaries for ${TARGET_TRIPLE} ==="
(
  cd crates
  cargo build --profile ci --target "$TARGET_TRIPLE" \
    -p guest-agent -p guest-download -p guest-init -p guest-mock-claude -p guest-mock-codex -p guest-reseed -p guest-write-file
)

echo "=== Cross-compiling runner with embedded guests for ${TARGET_TRIPLE} ==="
(
  cd crates
  GUEST_AGENT_PATH="target/$TARGET_TRIPLE/ci/guest-agent" \
  GUEST_DOWNLOAD_PATH="target/$TARGET_TRIPLE/ci/guest-download" \
  GUEST_INIT_PATH="target/$TARGET_TRIPLE/ci/guest-init" \
  GUEST_MOCK_CLAUDE_PATH="target/$TARGET_TRIPLE/ci/guest-mock-claude" \
  GUEST_MOCK_CODEX_PATH="target/$TARGET_TRIPLE/ci/guest-mock-codex" \
  GUEST_RESEED_PATH="target/$TARGET_TRIPLE/ci/guest-reseed" \
  GUEST_WRITE_FILE_PATH="target/$TARGET_TRIPLE/ci/guest-write-file" \
  cargo build --profile ci --target "$TARGET_TRIPLE" -p runner
)

sha_file() {
  sha256sum "$1" | awk '{print $1}'
}

runner_sha=$(sha_file "${TARGET_DIR}/runner")
guest_sha_json=$(jq -n \
  --arg guest_agent "$(sha_file "crates/target/${TARGET_TRIPLE}/ci/guest-agent")" \
  --arg guest_download "$(sha_file "crates/target/${TARGET_TRIPLE}/ci/guest-download")" \
  --arg guest_init "$(sha_file "crates/target/${TARGET_TRIPLE}/ci/guest-init")" \
  --arg guest_mock_claude "$(sha_file "crates/target/${TARGET_TRIPLE}/ci/guest-mock-claude")" \
  --arg guest_mock_codex "$(sha_file "crates/target/${TARGET_TRIPLE}/ci/guest-mock-codex")" \
  --arg guest_reseed "$(sha_file "crates/target/${TARGET_TRIPLE}/ci/guest-reseed")" \
  --arg guest_write_file "$(sha_file "crates/target/${TARGET_TRIPLE}/ci/guest-write-file")" \
  '{
    "guest-agent": $guest_agent,
    "guest-download": $guest_download,
    "guest-init": $guest_init,
    "guest-mock-claude": $guest_mock_claude,
    "guest-mock-codex": $guest_mock_codex,
    "guest-reseed": $guest_reseed,
    "guest-write-file": $guest_write_file
  }')

prepare_host() {
  local host=$1
  local host_index=$2
  local runner_name="${JOB_REF}-${host_index}"
  local remote="${METAL_USER}@${host}"
  echo "=== Preparing ${host} (runner: ${runner_name}) ==="

  local remote_arch
  if ! remote_arch=$(ssh "$remote" uname -m); then
    return 1
  fi
  remote_arch=$(printf '%s\n' "$remote_arch" | tail -n1 | tr -d '\r')
  if [ "$remote_arch" != "$EXPECTED_REMOTE_ARCH" ]; then
    echo "runner target ${TARGET_TRIPLE} expects remote architecture ${EXPECTED_REMOTE_ARCH}, but ${host} reported ${remote_arch}" >&2
    return 1
  fi

  if ! ssh "$remote" bash -s -- "${BIN_DIR}" "${RUNNER_DIR}" "${runner_name}" <<'REMOTE_SCRIPT'
set -euo pipefail
BIN_DIR=$1
RUNNER_DIR=$2
RUNNER_NAME=$3
UNIT="vm0-runner-${RUNNER_NAME}.service"

# This CI cleanup is intentionally forceful. Avoid executing the existing
# runner binary here: a cancelled prior prepare can leave a truncated binary at
# the final path.
if ! stop_output=$(sudo systemctl stop "${UNIT}" 2>&1); then
  case "$stop_output" in
    *"Unit ${UNIT} not loaded."*|*"Unit ${UNIT} could not be found."*|*"Unit ${UNIT} not found."*) ;;
    *)
      printf '%s\n' "$stop_output" >&2
      exit 1
      ;;
  esac
fi

if sudo systemctl is-active --quiet "${UNIT}" 2>/dev/null; then
  echo "runner service ${UNIT} is still active after stop" >&2
  exit 1
fi

sudo systemctl reset-failed "${UNIT}" 2>/dev/null || true
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

  local tmp_runner="${BIN_DIR}/runner.${HEAD_SHA}.${host_index}.tmp"
  if ! ssh "$remote" sudo install -m 755 /dev/stdin "${tmp_runner}" < "${TARGET_DIR}/runner"; then
    return 1
  fi

  if ! ssh "$remote" bash -s -- "${tmp_runner}" "${BIN_DIR}/runner" "${runner_sha}" <<'REMOTE_SCRIPT'
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

  if ! ssh "$remote" sudo \
    R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-}" \
    R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}" \
    R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}" \
    R2_USER_STORAGES_BUCKET_NAME="${R2_USER_STORAGES_BUCKET_NAME:-}" \
    "${BIN_DIR}/runner" gc --keep-latest 6; then
    return 1
  fi

  if ! ssh "$remote" sudo "${BIN_DIR}/runner" setup; then
    return 1
  fi
  echo "=== Done preparing ${host} ==="
}

warm_rootfs_cache() {
  local host=$1
  local remote="${METAL_USER}@${host}"
  echo "=== Warming shared template cache on ${host} ==="
  if ! ssh "$remote" sudo \
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
  local remote="${METAL_USER}@${host}"
  echo "=== Building rootfs/snapshot on ${host} ==="
  if ! ssh "$remote" sudo \
    R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-}" \
    R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}" \
    R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}" \
    R2_USER_STORAGES_BUCKET_NAME="${R2_USER_STORAGES_BUCKET_NAME:-}" \
    "${BIN_DIR}/runner" build --profile "$PROFILE"; then
    return 1
  fi
  echo "=== Done building rootfs/snapshot on ${host} ==="
}

LOG_DIR=$(mktemp -d)
cleanup() {
  rm -rf "$LOG_DIR"
}
trap cleanup EXIT

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
  --arg head_sha "$HEAD_SHA" \
  --arg job_ref "$JOB_REF" \
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
