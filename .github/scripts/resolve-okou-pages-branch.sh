#!/usr/bin/env bash
set -euo pipefail

if (( $# != 3 )); then
  echo "usage: $0 <event-name> <pull-request-number> <merge-group-head-ref>" >&2
  exit 1
fi

event_name="$1"
pull_request_number="$2"
merge_group_head_ref="$3"

case "$event_name" in
  pull_request)
    printf 'pr-%s-app\n' "${pull_request_number:?pull request number is required}"
    ;;
  merge_group)
    pull_request_number="$(grep -oE 'pr-[0-9]+' <<< "$merge_group_head_ref" | head -1 | cut -d- -f2)"
    printf 'pr-%s-app\n' "${pull_request_number:?pull request number is required in merge group head ref}"
    ;;
  push)
    printf 'staging-app\n'
    ;;
  *)
    echo "unsupported GitHub event: $event_name" >&2
    exit 1
    ;;
esac
