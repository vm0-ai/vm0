#!/bin/bash
# Container name — returns a stable identifier for the current machine/container.
#
# Usage:
#   scripts/cn.sh        # container name only (e.g. cs04, vm04)
#   scripts/cn.sh -u     # prefixed with git username (e.g. ethan-cs04, ethan-vm04)
#
# Resolution order (no -u):
#   1. $CODESPACE_NAME   — first segment before '-' (e.g. cs04-abc123 -> cs04)
#   2. $(hostname)       — full hostname

set -euo pipefail

WITH_USER=false
while getopts "u" opt; do
  case "$opt" in
    u) WITH_USER=true ;;
    *) echo "Usage: $0 [-u]" >&2; exit 1 ;;
  esac
done

# Resolve container name
if [ -n "${CODESPACE_NAME:-}" ]; then
  CN="${CODESPACE_NAME%%-*}"
else
  CN=$(hostname)
fi

if [ "$WITH_USER" = true ]; then
  USERNAME=$(git config user.email 2>/dev/null | sed 's/@.*//')
  echo "${USERNAME}-${CN}"
else
  echo "$CN"
fi
