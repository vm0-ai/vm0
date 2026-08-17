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

mapfile -t raw_database_url_emissions < <(
  awk '
    /^[[:space:]]*(echo|printf)[[:space:]]/ && index($0, "$DATABASE_URL") > 0 {
      sub(/^[[:space:]]+/, "")
      print
    }
  ' "$action"
)

expected_raw_database_url_emissions=(
  "echo \"database-url=\$DATABASE_URL\" >> \"\$GITHUB_OUTPUT\""
)

if [[ ${#raw_database_url_emissions[@]} -ne ${#expected_raw_database_url_emissions[@]} ]]; then
  fail "expected only the existing output command to emit the raw database URL"
fi

for index in "${!expected_raw_database_url_emissions[@]}"; do
  if [[ "${raw_database_url_emissions[$index]}" != "${expected_raw_database_url_emissions[$index]}" ]]; then
    fail "raw database URL must only be written to the existing output"
  fi
done

mapfile -t mask_and_output_commands < <(
  awk '
    index($0, "WORKFLOW_COMMAND_DATA=") > 0 ||
    index($0, "::add-mask::") > 0 ||
    index($0, "database-url=$DATABASE_URL") > 0 {
      sub(/^[[:space:]]+/, "")
      print
    }
  ' "$action"
)

mapfile -t expected_mask_and_output_commands <<'EXPECTED'
WORKFLOW_COMMAND_DATA="${DATABASE_URL//%/%25}"
WORKFLOW_COMMAND_DATA="${WORKFLOW_COMMAND_DATA//$'\r'/%0D}"
WORKFLOW_COMMAND_DATA="${WORKFLOW_COMMAND_DATA//$'\n'/%0A}"
printf '::add-mask::%s\n' "$WORKFLOW_COMMAND_DATA"
echo "database-url=$DATABASE_URL" >> "$GITHUB_OUTPUT"
EXPECTED

if [[ ${#mask_and_output_commands[@]} -ne ${#expected_mask_and_output_commands[@]} ]]; then
  fail "expected workflow-command escaping and masking before the database URL output"
fi

for index in "${!expected_mask_and_output_commands[@]}"; do
  if [[ "${mask_and_output_commands[$index]}" != "${expected_mask_and_output_commands[$index]}" ]]; then
    fail "database URL must be escaped, masked, and output in order"
  fi
done

echo "neon branch credential masking checks passed"
