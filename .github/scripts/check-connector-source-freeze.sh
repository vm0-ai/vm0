#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <base-ref> [head-ref]" >&2
  exit 2
fi

base_ref="$1"
head_ref="${2:-HEAD}"
frozen_paths=(
  "turbo/packages/connectors/src/connectors"
  "turbo/packages/firewalls-generator/src"
)

changed_files="$(
  git diff \
    --find-renames \
    --name-only \
    --diff-filter=ACMRTUXB \
    "$base_ref" \
    "$head_ref" \
    -- \
    "${frozen_paths[@]}"
)"

if [ -z "$changed_files" ]; then
  echo "Connector source freeze validated."
  exit 0
fi

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "::error::Connector source data in vm0 is frozen; add or modify it in vm0-ai/vm0-connectors instead." >&2
else
  echo "ERROR: Connector source data in vm0 is frozen." >&2
fi

printf '%s\n' "$changed_files" | sed 's/^/  /' >&2
echo "" >&2
echo "Make connector source changes in https://github.com/vm0-ai/vm0-connectors instead." >&2
echo "Deleting migrated files from the frozen vm0 directories is allowed." >&2

exit 1
