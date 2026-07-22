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

is_frozen_path() {
  local path="$1"
  local frozen_path

  for frozen_path in "${frozen_paths[@]}"; do
    if [[ "$path" == "$frozen_path" || "$path" == "$frozen_path/"* ]]; then
      return 0
    fi
  done

  return 1
}

diff_file="$(mktemp)"
trap 'rm -f "$diff_file"' EXIT
git diff \
  --find-renames \
  --name-status \
  -z \
  "$base_ref" \
  "$head_ref" \
  -- > "$diff_file"

blocked_changes=()
while IFS= read -r -d '' status; do
  case "$status" in
    R*)
      IFS= read -r -d '' old_path
      IFS= read -r -d '' new_path
      if is_frozen_path "$old_path" || is_frozen_path "$new_path"; then
        printf -v rendered_change '%q -> %q' "$old_path" "$new_path"
        blocked_changes+=("$rendered_change")
      fi
      ;;
    D*)
      IFS= read -r -d '' _
      ;;
    *)
      IFS= read -r -d '' changed_path
      if is_frozen_path "$changed_path"; then
        printf -v rendered_change '%q' "$changed_path"
        blocked_changes+=("$rendered_change")
      fi
      ;;
  esac
done < "$diff_file"

if [ "${#blocked_changes[@]}" -eq 0 ]; then
  echo "Connector source freeze validated."
  exit 0
fi

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "::error::Connector source data in vm0 is frozen; add or modify it in vm0-ai/vm0-connectors instead." >&2
else
  echo "ERROR: Connector source data in vm0 is frozen." >&2
fi

printf '  %s\n' "${blocked_changes[@]}" >&2
echo "" >&2
echo "Make connector source changes in https://github.com/vm0-ai/vm0-connectors instead." >&2
echo "Deleting migrated files from the frozen vm0 directories is allowed." >&2

exit 1
