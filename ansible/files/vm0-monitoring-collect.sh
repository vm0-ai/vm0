#!/usr/bin/env bash

set -euo pipefail

cache_dir="${VM0_WORKSPACE_IMAGE_CACHE_DIR:-/var/lib/vm0-runner/workspace-image-cache}"
textfile_dir="${VM0_MONITORING_TEXTFILE_DIR:-/var/lib/vm0-monitoring/textfile-collector}"
output_file="$textfile_dir/workspace-image-cache.prom"

mib=$((1024 * 1024))
gib=$((1024 * 1024 * 1024))

bucket_labels=(
  "lt_16MiB"
  "16MiB_64MiB"
  "64MiB_256MiB"
  "256MiB_1GiB"
  "1GiB_4GiB"
  "4GiB_16GiB"
  "gte_16GiB"
)
bucket_entries=(0 0 0 0 0 0 0)
bucket_allocated_bytes=(0 0 0 0 0 0 0)

bucket_index() {
  local bytes="$1"

  if ((bytes < 16 * mib)); then
    printf '0\n'
  elif ((bytes < 64 * mib)); then
    printf '1\n'
  elif ((bytes < 256 * mib)); then
    printf '2\n'
  elif ((bytes < gib)); then
    printf '3\n'
  elif ((bytes < 4 * gib)); then
    printf '4\n'
  elif ((bytes < 16 * gib)); then
    printf '5\n'
  else
    printf '6\n'
  fi
}

allocated_bytes_for_file() {
  local path="$1"
  local blocks

  blocks="$(stat -c '%b' -- "$path" 2>/dev/null)" || return 1
  case "$blocks" in
    '' | *[!0-9]*) return 1 ;;
  esac

  printf '%s\n' "$((blocks * 512))"
}

total_entries=0
total_allocated_bytes=0

if [ -d "$cache_dir" ]; then
  for entry_dir in "$cache_dir"/*; do
    [ -d "$entry_dir" ] || continue
    [ ! -L "$entry_dir" ] || continue

    current_image="$entry_dir/current.ext4"
    [ -e "$current_image" ] || continue
    [ ! -L "$current_image" ] || continue
    [ -f "$current_image" ] || continue

    allocated_bytes="$(allocated_bytes_for_file "$current_image")" || continue
    index="$(bucket_index "$allocated_bytes")"

    total_entries=$((total_entries + 1))
    total_allocated_bytes=$((total_allocated_bytes + allocated_bytes))
    bucket_entries[$index]=$((bucket_entries[$index] + 1))
    bucket_allocated_bytes[$index]=$((bucket_allocated_bytes[$index] + allocated_bytes))
  done
fi

if [ ! -d "$textfile_dir" ]; then
  echo "missing textfile directory: $textfile_dir" >&2
  exit 1
fi

tmp_file="$(mktemp "$textfile_dir/.workspace-image-cache.prom.XXXXXX")"
trap 'rm -f "$tmp_file"' EXIT

{
  echo "# HELP vm0_workspace_image_cache_entries Number of workspace image cache entries with current images."
  echo "# TYPE vm0_workspace_image_cache_entries gauge"
  echo "vm0_workspace_image_cache_entries $total_entries"
  echo
  echo "# HELP vm0_workspace_image_cache_allocated_bytes Allocated disk bytes used by workspace image cache current images."
  echo "# TYPE vm0_workspace_image_cache_allocated_bytes gauge"
  echo "vm0_workspace_image_cache_allocated_bytes $total_allocated_bytes"
  echo
  echo "# HELP vm0_workspace_image_cache_bucket_entries Number of workspace image cache entries by allocated size bucket."
  echo "# TYPE vm0_workspace_image_cache_bucket_entries gauge"
  for index in "${!bucket_labels[@]}"; do
    echo "vm0_workspace_image_cache_bucket_entries{bucket=\"${bucket_labels[$index]}\"} ${bucket_entries[$index]}"
  done
  echo
  echo "# HELP vm0_workspace_image_cache_bucket_allocated_bytes Allocated disk bytes used by workspace image cache current images by allocated size bucket."
  echo "# TYPE vm0_workspace_image_cache_bucket_allocated_bytes gauge"
  for index in "${!bucket_labels[@]}"; do
    echo "vm0_workspace_image_cache_bucket_allocated_bytes{bucket=\"${bucket_labels[$index]}\"} ${bucket_allocated_bytes[$index]}"
  done
} > "$tmp_file"

chmod 0644 "$tmp_file"
mv -f "$tmp_file" "$output_file"
trap - EXIT
