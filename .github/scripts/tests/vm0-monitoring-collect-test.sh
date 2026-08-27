#!/usr/bin/env bash

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
script="$repo_root/ansible/files/vm0-monitoring-collect.sh"
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

cache_dir="$tmp_root/cache"
textfile_dir="$tmp_root/textfile"
output_file="$textfile_dir/workspace-image-cache.prom"
stderr_file="$tmp_root/stderr.log"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

reset_dirs() {
  rm -rf "$cache_dir" "$textfile_dir" "$stderr_file"
  mkdir -p "$textfile_dir"
}

run_with_path_env() {
  env \
    -u OKOU_WORKSPACE_IMAGE_CACHE_DIR \
    -u OKOU_MONITORING_TEXTFILE_DIR \
    "$@" \
    bash "$script" 2>"$stderr_file"
}

run_metrics() {
  run_with_path_env \
    OKOU_WORKSPACE_IMAGE_CACHE_DIR="$cache_dir" \
    OKOU_MONITORING_TEXTFILE_DIR="$textfile_dir"

  [ -f "$output_file" ] || fail "metrics output file was not created"
}

assert_line() {
  local expected="$1"
  grep -qxF "$expected" "$output_file" || fail "missing line: $expected"
}

assert_no_match() {
  local pattern="$1"
  if grep -qE "$pattern" "$output_file"; then
    fail "unexpected output matching: $pattern"
  fi
}

assert_stderr_excludes_values() {
  local value
  for value in "$@"; do
    if grep -Fq -- "$value" "$stderr_file"; then
      fail "collector diagnostics exposed an ignored value"
    fi
  done
}

assert_stderr_empty() {
  [ ! -s "$stderr_file" ] || fail "collector emitted unexpected diagnostics"
}

assert_output_absent() {
  [ ! -e "$output_file" ] || fail "collector published output unexpectedly"
}

assert_all_buckets_zero() {
  local buckets=(
    "lt_16MiB"
    "16MiB_64MiB"
    "64MiB_256MiB"
    "256MiB_1GiB"
    "1GiB_4GiB"
    "4GiB_16GiB"
    "gte_16GiB"
  )

  for bucket in "${buckets[@]}"; do
    assert_line "vm0_workspace_image_cache_bucket_entries{bucket=\"$bucket\"} 0"
    assert_line "vm0_workspace_image_cache_bucket_allocated_bytes{bucket=\"$bucket\"} 0"
  done
}

allocated_bytes() {
  local blocks
  blocks="$(stat -c '%b' -- "$1")"
  printf '%s\n' "$((blocks * 512))"
}

test_missing_cache_dir_emits_zero_metrics() {
  reset_dirs

  run_metrics

  assert_line "vm0_workspace_image_cache_entries 0"
  assert_line "vm0_workspace_image_cache_allocated_bytes 0"
  assert_all_buckets_zero
}

test_empty_cache_dir_emits_zero_metrics() {
  reset_dirs
  mkdir -p "$cache_dir"

  run_metrics

  assert_line "vm0_workspace_image_cache_entries 0"
  assert_line "vm0_workspace_image_cache_allocated_bytes 0"
  assert_all_buckets_zero
}

test_sparse_file_uses_allocated_bytes_not_logical_size() {
  reset_dirs
  mkdir -p "$cache_dir/cache-a"
  truncate -s 1G "$cache_dir/cache-a/current.ext4"

  local allocated
  allocated="$(allocated_bytes "$cache_dir/cache-a/current.ext4")"

  run_metrics

  assert_line "vm0_workspace_image_cache_entries 1"
  assert_line "vm0_workspace_image_cache_allocated_bytes $allocated"
  assert_line "vm0_workspace_image_cache_bucket_entries{bucket=\"lt_16MiB\"} 1"
  assert_line "vm0_workspace_image_cache_bucket_allocated_bytes{bucket=\"lt_16MiB\"} $allocated"
  assert_line "vm0_workspace_image_cache_bucket_entries{bucket=\"1GiB_4GiB\"} 0"
  assert_no_match "cache-a|session|profile|working"
}

test_regular_file_bucket_counts() {
  reset_dirs
  mkdir -p "$cache_dir/cache-b"
  dd if=/dev/zero of="$cache_dir/cache-b/current.ext4" bs=1M count=20 status=none

  local allocated
  allocated="$(allocated_bytes "$cache_dir/cache-b/current.ext4")"

  run_metrics

  assert_line "vm0_workspace_image_cache_entries 1"
  assert_line "vm0_workspace_image_cache_allocated_bytes $allocated"
  assert_line "vm0_workspace_image_cache_bucket_entries{bucket=\"16MiB_64MiB\"} 1"
  assert_line "vm0_workspace_image_cache_bucket_allocated_bytes{bucket=\"16MiB_64MiB\"} $allocated"
  assert_line "vm0_workspace_image_cache_bucket_entries{bucket=\"lt_16MiB\"} 0"
}

test_multiple_entries_aggregate_across_buckets() {
  reset_dirs
  mkdir -p "$cache_dir/cache-small" "$cache_dir/cache-medium"
  dd if=/dev/zero of="$cache_dir/cache-small/current.ext4" bs=1M count=1 status=none
  dd if=/dev/zero of="$cache_dir/cache-medium/current.ext4" bs=1M count=20 status=none

  local small_allocated
  local medium_allocated
  local total_allocated
  small_allocated="$(allocated_bytes "$cache_dir/cache-small/current.ext4")"
  medium_allocated="$(allocated_bytes "$cache_dir/cache-medium/current.ext4")"
  total_allocated="$((small_allocated + medium_allocated))"

  run_metrics

  assert_line "vm0_workspace_image_cache_entries 2"
  assert_line "vm0_workspace_image_cache_allocated_bytes $total_allocated"
  assert_line "vm0_workspace_image_cache_bucket_entries{bucket=\"lt_16MiB\"} 1"
  assert_line "vm0_workspace_image_cache_bucket_allocated_bytes{bucket=\"lt_16MiB\"} $small_allocated"
  assert_line "vm0_workspace_image_cache_bucket_entries{bucket=\"16MiB_64MiB\"} 1"
  assert_line "vm0_workspace_image_cache_bucket_allocated_bytes{bucket=\"16MiB_64MiB\"} $medium_allocated"
}

test_ignores_incomplete_and_non_regular_entries() {
  reset_dirs
  mkdir -p "$cache_dir/no-current"
  mkdir -p "$cache_dir/directory-image/current.ext4"
  touch "$cache_dir/plain-file-entry"
  mkdir -p "$cache_dir/symlink-image"
  ln -s /dev/null "$cache_dir/symlink-image/current.ext4"
  mkdir -p "$tmp_root/symlink-target"
  touch "$tmp_root/symlink-target/current.ext4"
  ln -s "$tmp_root/symlink-target" "$cache_dir/symlink-entry"

  run_metrics

  assert_line "vm0_workspace_image_cache_entries 0"
  assert_line "vm0_workspace_image_cache_allocated_bytes 0"
  assert_all_buckets_zero
}

test_workspace_image_cache_dir_canonical_and_defaults() {
  reset_dirs
  mkdir -p "$cache_dir/canonical-entry"
  touch "$cache_dir/canonical-entry/current.ext4"

  run_with_path_env \
    OKOU_WORKSPACE_IMAGE_CACHE_DIR="$cache_dir" \
    OKOU_MONITORING_TEXTFILE_DIR="$textfile_dir"
  assert_line "vm0_workspace_image_cache_entries 1"
  assert_stderr_empty

  run_with_path_env \
    OKOU_MONITORING_TEXTFILE_DIR="$textfile_dir"
  assert_line "vm0_workspace_image_cache_entries 0"
  assert_stderr_empty

  run_with_path_env \
    OKOU_WORKSPACE_IMAGE_CACHE_DIR="" \
    OKOU_MONITORING_TEXTFILE_DIR="$textfile_dir"
  assert_line "vm0_workspace_image_cache_entries 0"
  assert_stderr_empty
}

test_retired_workspace_image_cache_dir_is_ignored() {
  reset_dirs
  local retired_cache_dir="$tmp_root/retired-cache"
  mkdir -p "$retired_cache_dir/retired-entry"
  touch "$retired_cache_dir/retired-entry/current.ext4"

  run_with_path_env \
    VM0_WORKSPACE_IMAGE_CACHE_DIR="$retired_cache_dir" \
    OKOU_MONITORING_TEXTFILE_DIR="$textfile_dir"
  assert_line "vm0_workspace_image_cache_entries 0"
  assert_stderr_excludes_values \
    "$retired_cache_dir" \
    VM0_WORKSPACE_IMAGE_CACHE_DIR \
    "monitoring path alias"
  assert_stderr_empty

  mkdir -p "$cache_dir/canonical-entry"
  touch "$cache_dir/canonical-entry/current.ext4"
  run_with_path_env \
    OKOU_WORKSPACE_IMAGE_CACHE_DIR="$cache_dir" \
    VM0_WORKSPACE_IMAGE_CACHE_DIR="$retired_cache_dir" \
    OKOU_MONITORING_TEXTFILE_DIR="$textfile_dir"
  assert_line "vm0_workspace_image_cache_entries 1"
  assert_stderr_excludes_values \
    "$retired_cache_dir" \
    VM0_WORKSPACE_IMAGE_CACHE_DIR \
    "monitoring path alias"
  assert_stderr_empty
}

test_monitoring_textfile_dir_canonical_and_defaults() {
  reset_dirs
  mkdir -p "$cache_dir/canonical-entry"
  touch "$cache_dir/canonical-entry/current.ext4"

  run_with_path_env \
    OKOU_WORKSPACE_IMAGE_CACHE_DIR="$cache_dir" \
    OKOU_MONITORING_TEXTFILE_DIR="$textfile_dir"
  assert_line "vm0_workspace_image_cache_entries 1"
  assert_stderr_empty

  rm -f "$output_file"
  if run_with_path_env OKOU_WORKSPACE_IMAGE_CACHE_DIR="$cache_dir"; then
    fail "expected the absent canonical textfile path to use the missing default"
  fi
  grep -qF \
    'missing textfile directory: /var/lib/vm0-monitoring/textfile-collector' \
    "$stderr_file" || fail "absent canonical textfile path did not use the fixed default"
  assert_output_absent

  if run_with_path_env \
    OKOU_WORKSPACE_IMAGE_CACHE_DIR="$cache_dir" \
    OKOU_MONITORING_TEXTFILE_DIR=""; then
    fail "expected an empty canonical textfile path to use the missing default"
  fi
  grep -qF \
    'missing textfile directory: /var/lib/vm0-monitoring/textfile-collector' \
    "$stderr_file" || fail "empty canonical textfile path did not use the fixed default"
  assert_output_absent
}

test_retired_monitoring_textfile_dir_is_ignored() {
  reset_dirs
  local retired_textfile_dir="$tmp_root/retired-textfile"
  mkdir -p "$cache_dir/canonical-entry" "$retired_textfile_dir"
  touch "$cache_dir/canonical-entry/current.ext4"

  if run_with_path_env \
    OKOU_WORKSPACE_IMAGE_CACHE_DIR="$cache_dir" \
    VM0_MONITORING_TEXTFILE_DIR="$retired_textfile_dir"; then
    fail "expected the retired textfile path to be ignored in favor of the missing default"
  fi
  grep -qF \
    'missing textfile directory: /var/lib/vm0-monitoring/textfile-collector' \
    "$stderr_file" || fail "retired textfile path redirected the collector"
  assert_stderr_excludes_values \
    "$retired_textfile_dir" \
    VM0_MONITORING_TEXTFILE_DIR \
    "monitoring path alias"
  assert_output_absent
  [ ! -e "$retired_textfile_dir/workspace-image-cache.prom" ] ||
    fail "retired textfile path received collector output"

  run_with_path_env \
    OKOU_WORKSPACE_IMAGE_CACHE_DIR="$cache_dir" \
    OKOU_MONITORING_TEXTFILE_DIR="$textfile_dir" \
    VM0_MONITORING_TEXTFILE_DIR="$retired_textfile_dir"
  assert_line "vm0_workspace_image_cache_entries 1"
  assert_stderr_excludes_values \
    "$retired_textfile_dir" \
    VM0_MONITORING_TEXTFILE_DIR \
    "monitoring path alias"
  assert_stderr_empty
  [ ! -e "$retired_textfile_dir/workspace-image-cache.prom" ] ||
    fail "retired textfile path overrode the canonical path"
}

test_missing_textfile_dir_fails() {
  rm -rf "$cache_dir" "$textfile_dir"

  if run_with_path_env \
    OKOU_WORKSPACE_IMAGE_CACHE_DIR="$cache_dir" \
    OKOU_MONITORING_TEXTFILE_DIR="$textfile_dir"; then
    fail "expected missing textfile directory to fail"
  fi

  grep -q "missing textfile directory" "$stderr_file" ||
    fail "missing textfile directory error was not reported"
}

test_missing_cache_dir_emits_zero_metrics
test_empty_cache_dir_emits_zero_metrics
test_sparse_file_uses_allocated_bytes_not_logical_size
test_regular_file_bucket_counts
test_multiple_entries_aggregate_across_buckets
test_ignores_incomplete_and_non_regular_entries
test_workspace_image_cache_dir_canonical_and_defaults
test_retired_workspace_image_cache_dir_is_ignored
test_monitoring_textfile_dir_canonical_and_defaults
test_retired_monitoring_textfile_dir_is_ignored
test_missing_textfile_dir_fails

echo "vm0 monitoring collector tests passed"
