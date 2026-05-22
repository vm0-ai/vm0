#!/usr/bin/env bash
set -euo pipefail

event_name="${EVENT_NAME:-${GITHUB_EVENT_NAME:-}}"
checkout_ref="${CHECKOUT_REF:-${GITHUB_REF:-}}"

case "$event_name" in
  pull_request)
    if [[ "$checkout_ref" == refs/pull/*/merge ]] && git rev-parse -q --verify HEAD^2 >/dev/null; then
      git rev-parse HEAD^1
      exit 0
    fi

    if [ -z "${PULL_REQUEST_BASE_SHA:-}" ]; then
      echo "missing PULL_REQUEST_BASE_SHA for pull_request event" >&2
      exit 2
    fi
    git merge-base "$PULL_REQUEST_BASE_SHA" HEAD
    ;;
  merge_group)
    if [ -z "${MERGE_GROUP_BASE_SHA:-}" ]; then
      echo "missing MERGE_GROUP_BASE_SHA for merge_group event" >&2
      exit 2
    fi
    printf '%s\n' "$MERGE_GROUP_BASE_SHA"
    ;;
  *)
    printf 'HEAD^\n'
    ;;
esac
