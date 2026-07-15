#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELECT_CONTEXT="${SCRIPT_DIR}/runner-test-context.sh"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

JOBS='runner-upgrade-local,runner-drain-resume,runner-balloon,runner-benchmark,runner-local-claude-active-input-smoke,runner-local-codex-active-input-smoke,runner-exec,runner-keep-alive,runner-cancel'
HOSTS='arm-1,x86-1'
TARGET_MAP='{"arm-1":"aarch64-unknown-linux-musl","x86-1":"x86_64-unknown-linux-musl"}'
ROOTFS_MAP='{"arm-1":"rootfs-arm","x86-1":"rootfs-x86"}'
SNAPSHOT_MAP='{"arm-1":"snapshot-arm","x86-1":"snapshot-x86"}'

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

run_context() {
  local output=$1
  local image_job_ref=$2
  local github_job=$3
  local jobs=${4:-$JOBS}
  local hosts=${5:-$HOSTS}
  local target_map=${6:-$TARGET_MAP}
  local rootfs_map=${7:-$ROOTFS_MAP}
  local snapshot_map=${8:-$SNAPSHOT_MAP}

  : >"$output"
  env -i \
    PATH="$PATH" \
    HOME="${HOME:-/tmp}" \
    RUNNER_IMAGE_JOB_REF="$image_job_ref" \
    GITHUB_JOB="$github_job" \
    RUNNER_BEHAVIOR_JOBS="$jobs" \
    AWS_METAL_RUNNER_HOSTS="$hosts" \
    RUNNER_TARGET_MAP="$target_map" \
    RUNNER_ROOTFS_HASH_MAP="$rootfs_map" \
    RUNNER_SNAPSHOT_HASH_MAP="$snapshot_map" \
    GITHUB_OUTPUT="$output" \
    "$SELECT_CONTEXT"
}

output_value() {
  local key=$1
  local output=$2
  sed -n "s/^${key}=//p" "$output" | tail -n 1
}

assert_context_matches_host() {
  local output=$1
  local host target rootfs snapshot
  host=$(output_value host "$output")
  target=$(output_value target "$output")
  rootfs=$(output_value rootfs-hash "$output")
  snapshot=$(output_value snapshot-hash "$output")

  case "$host" in
    arm-1)
      [ "$target" = "aarch64-unknown-linux-musl" ] || fail "arm target mismatch: $target"
      [ "$rootfs" = "rootfs-arm" ] || fail "arm rootfs mismatch: $rootfs"
      [ "$snapshot" = "snapshot-arm" ] || fail "arm snapshot mismatch: $snapshot"
      ;;
    x86-1)
      [ "$target" = "x86_64-unknown-linux-musl" ] || fail "x86 target mismatch: $target"
      [ "$rootfs" = "rootfs-x86" ] || fail "x86 rootfs mismatch: $rootfs"
      [ "$snapshot" = "snapshot-x86" ] || fail "x86 snapshot mismatch: $snapshot"
      ;;
    *) fail "unexpected selected host: $host" ;;
  esac
}

declare -A two_host_counts=()
upgrade_host=""
drain_host=""
while IFS= read -r job; do
  output="$TEST_DIR/two-host-${job}.out"
  run_context "$output" pr-21584 "$job"
  assert_context_matches_host "$output"
  host=$(output_value host "$output")
  two_host_counts[$host]=$(( ${two_host_counts[$host]:-0} + 1 ))
  [ "$job" != "runner-upgrade-local" ] || upgrade_host=$host
  [ "$job" != "runner-drain-resume" ] || drain_host=$host
done < <(printf '%s\n' "$JOBS" | tr ',' '\n')

[ "${two_host_counts[arm-1]:-0}" -eq 5 ] || fail "expected five arm shards, got ${two_host_counts[arm-1]:-0}"
[ "${two_host_counts[x86-1]:-0}" -eq 4 ] || fail "expected four x86 shards, got ${two_host_counts[x86-1]:-0}"
[ "$upgrade_host" != "$drain_host" ] || fail "upgrade and drain selected the same host: $upgrade_host"

first="$TEST_DIR/deterministic-first.out"
second="$TEST_DIR/deterministic-second.out"
run_context "$first" pr-21584 runner-benchmark
run_context "$second" pr-21584 runner-benchmark
[ "$(output_value host "$first")" = "$(output_value host "$second")" ] || fail "retry changed selected host"

rotated="$TEST_DIR/rotated.out"
run_context "$first" pr-1 runner-upgrade-local
run_context "$rotated" pr-4 runner-upgrade-local
[ "$(output_value host "$first")" != "$(output_value host "$rotated")" ] || fail "different PR offsets did not rotate hosts"

THREE_HOSTS='arm-1,x86-1,x86-2'
THREE_TARGETS='{"arm-1":"aarch64-unknown-linux-musl","x86-1":"x86_64-unknown-linux-musl","x86-2":"x86_64-unknown-linux-musl"}'
THREE_ROOTFS='{"arm-1":"rootfs-arm","x86-1":"rootfs-x86","x86-2":"rootfs-x86-2"}'
THREE_SNAPSHOTS='{"arm-1":"snapshot-arm","x86-1":"snapshot-x86","x86-2":"snapshot-x86-2"}'
declare -A three_host_counts=()
while IFS= read -r job; do
  output="$TEST_DIR/three-host-${job}.out"
  run_context "$output" pr-21584 "$job" "$JOBS" "$THREE_HOSTS" "$THREE_TARGETS" "$THREE_ROOTFS" "$THREE_SNAPSHOTS"
  host=$(output_value host "$output")
  three_host_counts[$host]=$(( ${three_host_counts[$host]:-0} + 1 ))
done < <(printf '%s\n' "$JOBS" | tr ',' '\n')
for host in arm-1 x86-1 x86-2; do
  [ "${three_host_counts[$host]:-0}" -eq 3 ] || fail "expected three shards on $host, got ${three_host_counts[$host]:-0}"
done

while IFS= read -r job; do
  output="$TEST_DIR/single-host-${job}.out"
  run_context \
    "$output" \
    pr-21584 \
    "$job" \
    "$JOBS" \
    'arm-1' \
    '{"arm-1":"aarch64-unknown-linux-musl"}' \
    '{"arm-1":"rootfs-arm"}' \
    '{"arm-1":"snapshot-arm"}'
  [ "$(output_value host "$output")" = "arm-1" ] || fail "single-host selection changed host"
done < <(printf '%s\n' "$JOBS" | tr ',' '\n')

expect_failure() {
  local label=$1
  local pattern=$2
  shift 2
  local output="$TEST_DIR/${label}.out"
  local error="$TEST_DIR/${label}.err"
  if run_context "$output" "$@" >"$TEST_DIR/${label}.log" 2>"$error"; then
    fail "expected ${label} to fail"
  fi
  grep -Fq "$pattern" "$error" || {
    cat "$error" >&2
    fail "expected ${label} error to contain: ${pattern}"
  }
}

expect_failure unknown-job 'runner behavior job is not in the shard roster' pr-21584 runner-unknown
expect_failure duplicate-roster 'duplicate runner behavior job' pr-21584 runner-upgrade-local 'runner-upgrade-local,runner-upgrade-local'
expect_failure empty-hosts 'no runner test hosts configured' pr-21584 runner-upgrade-local "$JOBS" ' '
expect_failure incomplete-target-map 'runner target map missing selected host' pr-21584 runner-upgrade-local "$JOBS" "$HOSTS" '{}'
expect_failure incomplete-rootfs-map 'runner rootfs hash map missing selected host' pr-21584 runner-upgrade-local "$JOBS" "$HOSTS" "$TARGET_MAP" '{}'
expect_failure incomplete-snapshot-map 'runner snapshot hash map missing selected host' pr-21584 runner-upgrade-local "$JOBS" "$HOSTS" "$TARGET_MAP" "$ROOTFS_MAP" '{}'

echo "runner-test-context-test: ok"
