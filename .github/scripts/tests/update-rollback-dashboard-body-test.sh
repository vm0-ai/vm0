#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${SCRIPT_DIR}/../update-rollback-dashboard-body.sh"

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

body_file="${tmp_dir}/body.md"
output_file="${tmp_dir}/output.md"

cat >"$body_file" <<'EOF'
This issue is automatically maintained by CI. Do not edit manually.

<!-- ROLLBACK_ENTRIES_START -->
### legacy entry
| Component | Version |
| api | v1.0.0 |
<!-- ROLLBACK_ENTRIES_END -->
EOF

target_commit=1111111111111111111111111111111111111111
rollback_url=https://github.com/vm0-ai/vm0/actions/workflows/rollback-production.yml

"$TARGET" "$body_file" "$target_commit" "$rollback_url" >"$output_file"

grep -Fqx -- "- \`${target_commit}\` — [Rollback production](${rollback_url})" "$output_file"
if grep -Fq 'legacy entry' "$output_file"; then
  echo "legacy dashboard entries were not removed" >&2
  exit 1
fi

for digit in 1 2 3 4 5 6 7; do
  commit=$(printf '%040d' "$digit")
  "$TARGET" "$output_file" "$commit" "$rollback_url" >"${output_file}.next"
  mv "${output_file}.next" "$output_file"
done

entry_count=$(grep -c "^- \`[0-9a-f]\\{40\\}\` — \\[Rollback production\\]" "$output_file")
if [ "$entry_count" -ne 7 ]; then
  echo "expected 7 dashboard entries, found $entry_count" >&2
  exit 1
fi

latest_commit=0000000000000000000000000000000000000007
grep -Fqx -- "- \`${latest_commit}\` — [Rollback production](${rollback_url})" "$output_file"
if grep -Fq "$target_commit" "$output_file"; then
  echo "oldest dashboard entry was not trimmed" >&2
  exit 1
fi

"$TARGET" "$output_file" "$latest_commit" "$rollback_url" >"${output_file}.next"
duplicate_count=$(grep -c "$latest_commit" "${output_file}.next")
if [ "$duplicate_count" -ne 1 ]; then
  echo "duplicate target commit was not collapsed" >&2
  exit 1
fi

echo "update-rollback-dashboard-body tests passed"
