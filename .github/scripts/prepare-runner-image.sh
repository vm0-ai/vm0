#!/usr/bin/env bash
set -euo pipefail

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

TARGET_TRIPLE="${TARGET_TRIPLE:-aarch64-unknown-linux-musl}"
PROFILE="${PROFILE:-vm0/default}"
MANIFEST_PATH="${MANIFEST_PATH:-runner-image-manifest/manifest.json}"
BIN_DIR="/var/lib/vm0-runner/bin/${JOB_REF}"
RUNNER_DIR="/var/lib/vm0-runner/runners/${JOB_REF}"
TARGET_DIR="crates/target/${TARGET_TRIPLE}/ci"

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

mapfile -t HOSTS < <(printf '%s\n' "$METAL_HOSTS" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep .)
if [ "${#HOSTS[@]}" -lt 1 ]; then
  echo "METAL_HOSTS is empty" >&2
  exit 1
fi

prepare_host() {
  local host=$1
  local host_index=$2
  local runner_name="${JOB_REF}-${host_index}"
  local remote="${METAL_USER}@${host}"
  echo "=== Preparing ${host} (runner: ${runner_name}) ==="

  if ! ssh "$remote" bash -s -- "${BIN_DIR}" "${RUNNER_DIR}" "${runner_name}" <<'REMOTE_SCRIPT'
set -euo pipefail
BIN_DIR=$1
RUNNER_DIR=$2
RUNNER_NAME=$3
UNIT="vm0-runner-${RUNNER_NAME}.service"

if [ -x "${BIN_DIR}/runner" ]; then
  sudo "${BIN_DIR}/runner" service stop --name "${RUNNER_NAME}" --force
else
  sudo systemctl stop "${UNIT}" 2>/dev/null || true
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

  if ! ssh "$remote" sudo install -m 755 /dev/stdin "${BIN_DIR}/runner" < "${TARGET_DIR}/runner"; then
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
