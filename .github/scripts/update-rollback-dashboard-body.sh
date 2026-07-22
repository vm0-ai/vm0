#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: update-rollback-dashboard-body.sh BODY_FILE TARGET_COMMIT ROLLBACK_URL" >&2
  exit 2
fi

body_file=$1
target_commit=$2
rollback_url=$3

if [[ ! "$target_commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "target commit must be a full lowercase SHA-1: $target_commit" >&2
  exit 2
fi

entries_file=$(mktemp)
filtered_entries_file=$(mktemp)
trap 'rm -f "$entries_file" "$filtered_entries_file"' EXIT

printf -- "- \`%s\` — [Rollback production](%s)\n" \
  "$target_commit" \
  "$rollback_url" >"$entries_file"

awk '
  /<!-- ROLLBACK_ENTRIES_START -->/ { in_entries=1; next }
  /<!-- ROLLBACK_ENTRIES_END -->/ { in_entries=0; next }
  in_entries && /^- `[0-9a-f]{40}` — \[Rollback production\]\(.*\)$/ { print }
' "$body_file" \
  | awk -v target="\`${target_commit}\`" 'index($0, target) == 0' \
  >>"$entries_file"

head -n 7 "$entries_file" >"$filtered_entries_file"

awk -v entries_file="$filtered_entries_file" '
  /<!-- ROLLBACK_ENTRIES_START -->/ {
    print
    while ((getline line < entries_file) > 0) print line
    close(entries_file)
    in_entries=1
    next
  }
  /<!-- ROLLBACK_ENTRIES_END -->/ {
    in_entries=0
    print
    next
  }
  !in_entries { print }
' "$body_file"
