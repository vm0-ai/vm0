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

rename_diff_file="$(mktemp)"
trap 'rm -f "$rename_diff_file"' EXIT
git diff \
  --find-renames \
  --name-status \
  -z \
  --diff-filter=R \
  "$base_ref" \
  "$head_ref" \
  -- > "$rename_diff_file"

renamed_out_paths=()
while IFS= read -r -d '' status; do
  IFS= read -r -d '' old_path
  IFS= read -r -d '' new_path

  if [[ "$status" == R* ]] && is_frozen_path "$old_path" && ! is_frozen_path "$new_path"; then
    renamed_out_paths+=("$old_path" "$new_path")
  fi
done < "$rename_diff_file"

if [ -z "$changed_files" ] && [ "${#renamed_out_paths[@]}" -eq 0 ]; then
  echo "Connector source freeze validated."
  exit 0
fi

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "::error::Connector source data in vm0 is frozen; add or modify it in vm0-ai/vm0-connectors instead." >&2
else
  echo "ERROR: Connector source data in vm0 is frozen." >&2
fi

if [ -n "$changed_files" ]; then
  printf '%s\n' "$changed_files" | sed 's/^/  /' >&2
fi
for ((index = 0; index < ${#renamed_out_paths[@]}; index += 2)); do
  printf '  %q -> %q\n' \
    "${renamed_out_paths[$index]}" \
    "${renamed_out_paths[$((index + 1))]}" >&2
done
echo "" >&2
echo "Make connector source changes in https://github.com/vm0-ai/vm0-connectors instead." >&2
echo "Deleting migrated files from the frozen vm0 directories is allowed." >&2

exit 1
