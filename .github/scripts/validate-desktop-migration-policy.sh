#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
confirmed_hard_stop="${2:-false}"
approval_url="${3:-}"
git_ref="${4:-}"

if [[ "$git_ref" != "refs/heads/main" ]]; then
  echo "Desktop migration policy publishing requires refs/heads/main" >&2
  exit 1
fi

case "$mode" in
  off | soft)
    exit 0
    ;;
  hard)
    if [[ "$confirmed_hard_stop" != "true" ]]; then
      echo "Hard stop requires confirmed_hard_stop=true" >&2
      exit 1
    fi
    if [[ "$approval_url" != https://github.com/vm0-ai/vm0/issues/26370#issuecomment-* ]]; then
      echo "Hard stop requires an explicit #26370 approval comment URL" >&2
      exit 1
    fi
    ;;
  *)
    echo "Mode must be off, soft, or hard" >&2
    exit 1
    ;;
esac
