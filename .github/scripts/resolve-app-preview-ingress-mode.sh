#!/usr/bin/env bash
set -euo pipefail

if (( $# != 3 )); then
  echo "usage: $0 <legacy|canary|enabled> <canary-ref> <target-ref>" >&2
  exit 1
fi

configured_mode="${1:-legacy}"
canary_ref="$2"
target_ref="$3"

if [[ ! "$target_ref" =~ ^(staging|pr-[1-9][0-9]*)$ ]]; then
  echo "unsupported app preview ref: ${target_ref}" >&2
  exit 1
fi

case "$configured_mode" in
  legacy)
    echo legacy
    ;;
  canary)
    if [[ ! "$canary_ref" =~ ^(staging|pr-[1-9][0-9]*)$ ]]; then
      echo "CF_PREVIEW_GATEWAY_CANARY_REF must be staging or pr-<number>" >&2
      exit 1
    fi
    if [[ "$target_ref" == "$canary_ref" ]]; then
      echo gateway
    else
      echo legacy
    fi
    ;;
  enabled)
    echo gateway
    ;;
  *)
    echo "unsupported CF_PREVIEW_GATEWAY_MODE: ${configured_mode}" >&2
    exit 1
    ;;
esac
