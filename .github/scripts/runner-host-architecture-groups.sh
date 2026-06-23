#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${SCRIPT_DIR}/runner-image-target.sh"

usage() {
  cat <<'USAGE'
Usage: runner-host-architecture-groups.sh [matrix|has-groups]

Emits compact JSON for configured runner host architecture groups.
Inputs:
  ARM64_METAL_RUNNER_HOSTS    ARM64 host list.
  X86_64_METAL_RUNNER_HOSTS   Optional x86_64 host list.

Commands:
  <none>      Emit the full local contract, including hosts.
  matrix      Emit the cross-job matrix contract, excluding hosts.
  has-groups  Emit true when at least one host group is configured.
USAGE
}

normalize_hosts() {
  local hosts="${1:-}"
  printf '%s\n' "$hosts" \
    | tr ',' '\n' \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
    | sed '/^$/d' \
    | paste -sd, -
}

append_group() {
  local groups=$1
  local id=$2
  local label=$3
  local hosts=$4
  local target=$5

  hosts=$(normalize_hosts "$hosts")
  if [ -z "$hosts" ]; then
    printf '%s\n' "$groups"
    return 0
  fi

  local uname_m cache_suffix asset_suffix
  uname_m=$(runner_image_expected_uname_m "$target")
  cache_suffix=$(runner_image_cache_suffix "$target")
  asset_suffix=$(runner_image_asset_suffix "$target")

  jq -c \
    --arg id "$id" \
    --arg label "$label" \
    --arg hosts "$hosts" \
    --arg target "$target" \
    --arg uname_m "$uname_m" \
    --arg cache_suffix "$cache_suffix" \
    --arg asset_suffix "$asset_suffix" \
    '. + [{
      id: $id,
      label: $label,
      hosts: $hosts,
      target: $target,
      unameM: $uname_m,
      cacheSuffix: $cache_suffix,
      assetSuffix: $asset_suffix
    }]' <<<"$groups"
}

validate_host_entry() {
  local host=$1
  if [[ ! "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$ ]]; then
    echo "invalid runner host entry: ${host}" >&2
    return 2
  fi
}

validate_host_entries() {
  local groups=$1
  local host
  while IFS= read -r host; do
    validate_host_entry "$host" || return $?
  done < <(jq -r '.[].hosts | split(",")[]' <<<"$groups")
}

validate_unique_hosts() {
  local groups=$1
  local host host_key
  declare -A seen_hosts=()
  while IFS= read -r host; do
    host_key=${host,,}
    if [ -n "${seen_hosts[$host_key]+x}" ]; then
      echo "duplicate runner host configured: ${host}" >&2
      return 2
    fi
    seen_hosts[$host_key]=1
  done < <(jq -r '.[].hosts | split(",")[]' <<<"$groups")
}

emit_groups() {
  local groups
  groups=$(jq -n -c '[]')
  groups=$(append_group "$groups" "arm64" "ARM64" "${ARM64_METAL_RUNNER_HOSTS:-}" "aarch64-unknown-linux-musl")
  groups=$(append_group "$groups" "x86_64" "x86_64" "${X86_64_METAL_RUNNER_HOSTS:-}" "x86_64-unknown-linux-musl")
  validate_host_entries "$groups" || return $?
  validate_unique_hosts "$groups" || return $?
  printf '%s\n' "$groups"
}

emit_matrix() {
  local groups
  groups=$(emit_groups) || return $?
  jq -c 'map({
    id,
    label,
    target,
    unameM,
    cacheSuffix,
    assetSuffix
  })' <<<"$groups"
}

emit_has_groups() {
  local groups
  groups=$(emit_groups) || return $?
  if jq -e 'length > 0' >/dev/null <<<"$groups"; then
    printf 'true\n'
  else
    printf 'false\n'
  fi
}

cmd="${1:-}"
case "$cmd" in
  "")
    emit_groups
    ;;
  matrix)
    emit_matrix
    ;;
  has-groups)
    emit_has_groups
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
