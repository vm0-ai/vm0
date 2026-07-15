#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

normalize_csv() {
  printf '%s\n' "$1" \
    | tr ',' '\n' \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
    | sed '/^$/d'
}

require_unique() {
  local label=$1
  shift
  local duplicate
  duplicate=$(printf '%s\n' "$@" | sort | uniq -d | head -n 1)
  if [ -n "$duplicate" ]; then
    echo "duplicate ${label}: ${duplicate}" >&2
    exit 2
  fi
}

map_value() {
  local label=$1
  local map=$2
  local host=$3
  local value
  if ! value=$(jq -er --arg host "$host" '.[$host] | select(type == "string" and length > 0)' <<<"$map"); then
    echo "${label} missing selected host: ${host}" >&2
    exit 2
  fi
  printf '%s\n' "$value"
}

emit() {
  printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
}

require_env RUNNER_IMAGE_JOB_REF
require_env GITHUB_JOB
require_env RUNNER_BEHAVIOR_JOBS
require_env AWS_METAL_RUNNER_HOSTS
require_env RUNNER_TARGET_MAP
require_env RUNNER_ROOTFS_HASH_MAP
require_env RUNNER_SNAPSHOT_HASH_MAP
require_env GITHUB_OUTPUT

mapfile -t hosts < <(normalize_csv "$AWS_METAL_RUNNER_HOSTS")
mapfile -t jobs < <(normalize_csv "$RUNNER_BEHAVIOR_JOBS")

if [ "${#hosts[@]}" -eq 0 ]; then
  echo "no runner test hosts configured" >&2
  exit 2
fi
if [ "${#jobs[@]}" -eq 0 ]; then
  echo "no runner behavior jobs configured" >&2
  exit 2
fi

require_unique "runner test host" "${hosts[@]}"
require_unique "runner behavior job" "${jobs[@]}"

job_index=-1
for index in "${!jobs[@]}"; do
  if [ "${jobs[$index]}" = "$GITHUB_JOB" ]; then
    job_index=$index
    break
  fi
done
if [ "$job_index" -lt 0 ]; then
  echo "runner behavior job is not in the shard roster: ${GITHUB_JOB}" >&2
  exit 2
fi

hash=$(printf '%s' "$RUNNER_IMAGE_JOB_REF" | md5sum | cut -c1-8)
host_index=$(( (0x$hash + job_index) % ${#hosts[@]} ))
host=${hosts[$host_index]}
target=$(map_value "runner target map" "$RUNNER_TARGET_MAP" "$host")
rootfs_hash=$(map_value "runner rootfs hash map" "$RUNNER_ROOTFS_HASH_MAP" "$host")
snapshot_hash=$(map_value "runner snapshot hash map" "$RUNNER_SNAPSHOT_HASH_MAP" "$host")

emit host "$host"
emit target "$target"
emit rootfs-hash "$rootfs_hash"
emit snapshot-hash "$snapshot_hash"

echo "Selected runner test shard $((job_index + 1))/${#jobs[@]}: job=${GITHUB_JOB} host=${host} target=${target}"
