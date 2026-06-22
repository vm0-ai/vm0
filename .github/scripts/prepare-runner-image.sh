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
CRATES_DIR="${GITHUB_WORKSPACE:-$(pwd)}/crates"
CARGO_TIMING_DIR="${CRATES_DIR}/target/cargo-timings"
TIMING_DIR="${RUNNER_TEMP:-/tmp}/runner-image-build-timing"
LINKER_TIMING_LOG="${TIMING_DIR}/linker.tsv"

mkdir -p "$(dirname "$MANIFEST_PATH")"
mkdir -p "$TIMING_DIR"

line_count() {
  local path=$1
  if [ -s "$path" ]; then
    wc -l < "$path"
  else
    echo 0
  fi
}

mold_linker_for_target() {
  case "$1" in
    aarch64-unknown-linux-musl) echo "aarch64-linux-musl-ld.mold" ;;
    x86_64-unknown-linux-musl) echo "x86_64-linux-musl-ld.mold" ;;
    *) return 1 ;;
  esac
}

configure_linker_timing() {
  local target_mold
  if ! target_mold=$(mold_linker_for_target "$TARGET_TRIPLE"); then
    echo "Linker timing skipped: unknown mold linker for ${TARGET_TRIPLE}"
    return
  fi

  local real_linker
  real_linker=$(command -v "$target_mold" 2>/dev/null || command -v ld.mold 2>/dev/null || command -v mold 2>/dev/null || true)
  if [ -z "$real_linker" ]; then
    echo "Linker timing skipped: mold linker not found"
    return
  fi

  local wrapper="${TIMING_DIR}/mold-wrapper"
  : > "$LINKER_TIMING_LOG"
  cat > "$wrapper" <<'LINKER_WRAPPER'
#!/usr/bin/env bash
set -euo pipefail

status=0
start_ns=$(date +%s%N)
"$RUNNER_IMAGE_REAL_MOLD_LINKER" "$@" || status=$?
end_ns=$(date +%s%N)
duration_ms=$(((end_ns - start_ns) / 1000000))

output="<unknown>"
previous=""
for arg in "$@"; do
  if [ "$previous" = "-o" ]; then
    output=$arg
    break
  fi
  case "$arg" in
    -o?*)
      output=${arg#-o}
      break
      ;;
  esac
  previous=$arg
done

printf '%s\t%s\t%s\n' "$duration_ms" "$status" "$output" >> "$RUNNER_IMAGE_LINKER_TIMING_LOG"
exit "$status"
LINKER_WRAPPER
  chmod +x "$wrapper"
  ln -sf mold-wrapper "${TIMING_DIR}/${target_mold}"
  ln -sf mold-wrapper "${TIMING_DIR}/ld.mold"
  ln -sf mold-wrapper "${TIMING_DIR}/mold"

  export RUNNER_IMAGE_REAL_MOLD_LINKER="$real_linker"
  export RUNNER_IMAGE_LINKER_TIMING_LOG="$LINKER_TIMING_LOG"
  export PATH="${TIMING_DIR}:$PATH"
  echo "Linker timing enabled with ${real_linker} via PATH wrappers"
}

print_linker_timing_summary() {
  local label=$1
  local start_line=$2
  local tmp
  tmp=$(mktemp)
  tail -n +"$((start_line + 1))" "$LINKER_TIMING_LOG" > "$tmp" 2>/dev/null || true

  echo "=== Linker timing summary: ${label} ==="
  if [ ! -s "$tmp" ]; then
    echo "linker_invocations=0"
    rm -f "$tmp"
    return
  fi

  awk -F '\t' '
    {
      total += $1
      count += 1
      if ($2 != "0") {
        failed += 1
      }
      if ($1 > max) {
        max = $1
        max_output = $3
      }
    }
    END {
      printf "linker_invocations=%d total_ms=%d max_ms=%d max_output=%s failed=%d\n", count, total, max, max_output, failed
    }
  ' "$tmp"

  echo "Top linker invocations:"
  sort -t $'\t' -k1,1nr "$tmp" | head -15 | awk -F '\t' '
    {
      printf "linker_ms=%s status=%s output=%s\n", $1, $2, $3
    }
  ' || true
  rm -f "$tmp"
}

print_sccache_stats() {
  local label=$1
  local sccache_bin="${SCCACHE_PATH:-sccache}"
  if ! command -v "$sccache_bin" >/dev/null 2>&1; then
    return
  fi

  echo "=== sccache stats: ${label} ==="
  "$sccache_bin" --show-stats || true
}

reset_sccache_stats() {
  local sccache_bin="${SCCACHE_PATH:-sccache}"
  if ! command -v "$sccache_bin" >/dev/null 2>&1; then
    return
  fi

  "$sccache_bin" --zero-stats >/dev/null 2>&1 || true
}

print_cargo_timing_reports() {
  local label=$1
  local marker=$2
  local reports=()

  echo "=== Cargo timing reports: ${label} ==="
  while IFS= read -r report; do
    reports+=("$report")
  done < <(
    find "$CARGO_TIMING_DIR" -maxdepth 1 -type f -name '*.html' -newer "$marker" -printf '%T@ %p\n' 2>/dev/null \
      | sort -nr \
      | head -5 \
      | sed 's/^[^ ]* //' \
      || true
  )

  if [ "${#reports[@]}" -eq 0 ]; then
    echo "cargo_timing_reports=0"
    return
  fi

  printf '%s\n' "${reports[@]}"
  print_cargo_timing_summary "$label" "${reports[0]}"
}

print_cargo_timing_summary() {
  local label=$1
  local report=$2

  if ! command -v python3 >/dev/null 2>&1; then
    return
  fi

  echo "=== Cargo timing top units: ${label} ==="
  python3 - "$report" <<'PY' || true
import json
import re
import sys
from pathlib import Path

report = Path(sys.argv[1])
try:
    text = report.read_text()
except OSError as exc:
    print(f"cargo_timing_units=unavailable reason=read_failed detail={exc}")
    raise SystemExit(0)

duration_match = re.search(r"^DURATION = ([0-9.]+);", text, re.MULTILINE)
unit_match = re.search(r"const UNIT_DATA = (\[.*?\]);", text, re.DOTALL)
if not unit_match:
    print("cargo_timing_units=unavailable reason=missing_unit_data")
    raise SystemExit(0)

try:
    units = json.loads(unit_match.group(1))
except json.JSONDecodeError as exc:
    print(f"cargo_timing_units=unavailable reason=json_parse_failed detail={exc}")
    raise SystemExit(0)

def clean(value):
    return str(value).replace("\n", " ").strip() or "<empty>"

def format_sections(unit):
    sections = unit.get("sections") or []
    if not sections:
        return "none"
    formatted = []
    for name, span in sections:
        start = float(span.get("start", 0.0))
        end = float(span.get("end", start))
        formatted.append(f"{clean(name)}={max(end - start, 0.0):.2f}s")
    return ",".join(formatted)

wall_seconds = duration_match.group(1) if duration_match else "unknown"
print(f"cargo_timing_units={len(units)} wall_seconds={wall_seconds}")
for unit in sorted(units, key=lambda item: float(item.get("duration", 0.0)), reverse=True)[:15]:
    duration = float(unit.get("duration", 0.0))
    name = clean(unit.get("name", "<unknown>"))
    version = clean(unit.get("version", ""))
    mode = clean(unit.get("mode", "<unknown>"))
    target = clean(unit.get("target", ""))
    sections = format_sections(unit)
    print(
        "cargo_unit_duration_s="
        f"{duration:.2f} name={name} version={version} mode={mode} "
        f"target={target} sections={sections}"
    )
PY
}

run_timed_cargo() {
  local label=$1
  shift
  local linker_start
  local timing_marker
  local status=0

  linker_start=$(line_count "$LINKER_TIMING_LOG")
  timing_marker=$(mktemp "${TIMING_DIR}/cargo-timing-marker.XXXXXX")
  reset_sccache_stats

  echo "=== ${label}: command ==="
  printf '%q ' "$@"
  printf '\n'

  if [ -x /usr/bin/time ]; then
    /usr/bin/time -v "$@" || status=$?
  else
    time "$@" || status=$?
  fi

  print_linker_timing_summary "$label" "$linker_start"
  print_sccache_stats "$label"
  print_cargo_timing_reports "$label" "$timing_marker"
  rm -f "$timing_marker"
  return "$status"
}

configure_linker_timing

echo "=== Cross-compiling guest binaries for ${TARGET_TRIPLE} ==="
(
  cd crates
  run_timed_cargo "guest binaries" cargo build --profile ci --timings --target "$TARGET_TRIPLE" \
    -p guest-agent -p guest-download -p guest-init -p guest-mock-claude -p guest-mock-codex -p guest-reseed -p guest-write-file
)

echo "=== Cross-compiling runner with embedded guests for ${TARGET_TRIPLE} ==="
(
  cd crates
  export GUEST_AGENT_PATH="target/$TARGET_TRIPLE/ci/guest-agent"
  export GUEST_DOWNLOAD_PATH="target/$TARGET_TRIPLE/ci/guest-download"
  export GUEST_INIT_PATH="target/$TARGET_TRIPLE/ci/guest-init"
  export GUEST_MOCK_CLAUDE_PATH="target/$TARGET_TRIPLE/ci/guest-mock-claude"
  export GUEST_MOCK_CODEX_PATH="target/$TARGET_TRIPLE/ci/guest-mock-codex"
  export GUEST_RESEED_PATH="target/$TARGET_TRIPLE/ci/guest-reseed"
  export GUEST_WRITE_FILE_PATH="target/$TARGET_TRIPLE/ci/guest-write-file"
  run_timed_cargo "runner binary" cargo build --profile ci --timings --target "$TARGET_TRIPLE" -p runner
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
