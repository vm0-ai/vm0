#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
action="${repo_root}/.github/actions/neon-branch/action.yml"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

if grep -Fq 'DATABASE_URL value:' "$action"; then
  fail "Neon branch action logs the generated database URL"
fi

mapfile -t database_url_emissions < <(
  awk '
    /^[[:space:]]*(echo|printf)[[:space:]]/ && index($0, "$DATABASE_URL") > 0 {
      sub(/^[[:space:]]+/, "")
      print
    }
  ' "$action"
)

expected_emissions=(
  "echo \"::add-mask::\$DATABASE_URL\""
  "echo \"database-url=\$DATABASE_URL\" >> \"\$GITHUB_OUTPUT\""
)

if [[ ${#database_url_emissions[@]} -ne ${#expected_emissions[@]} ]]; then
  fail "expected only mask and output commands for the generated database URL"
fi

for index in "${!expected_emissions[@]}"; do
  if [[ "${database_url_emissions[$index]}" != "${expected_emissions[$index]}" ]]; then
    fail "generated database URL must be masked before the existing output is written"
  fi
done

echo "neon branch credential masking checks passed"
