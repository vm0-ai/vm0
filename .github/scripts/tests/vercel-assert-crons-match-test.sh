#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="${REPO_ROOT}/.github/scripts/vercel-assert-crons-match.sh"
TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

expected_config="${TEMP_DIR}/expected.json"
matching_config="${TEMP_DIR}/matching.json"
mismatched_config="${TEMP_DIR}/mismatched.json"
empty_expected_config="${TEMP_DIR}/empty-expected.json"
empty_actual_config="${TEMP_DIR}/empty-actual.json"

cat > "$expected_config" <<'JSON'
{
  "crons": [
    { "path": "/api/cron/alpha", "schedule": "* * * * *" },
    { "path": "/api/cron/beta", "schedule": "0 * * * *" }
  ]
}
JSON

cat > "$matching_config" <<'JSON'
{
  "version": 3,
  "crons": [
    { "schedule": "0 * * * *", "path": "/api/cron/beta" },
    { "schedule": "* * * * *", "path": "/api/cron/alpha" }
  ]
}
JSON

bash "$SCRIPT" "$expected_config" "$matching_config"

cat > "$mismatched_config" <<'JSON'
{
  "version": 3,
  "crons": [
    { "path": "/api/cron/alpha", "schedule": "* * * * *" }
  ]
}
JSON

if bash "$SCRIPT" "$expected_config" "$mismatched_config" 2> /dev/null; then
  fail "expected mismatched cron config to fail"
fi

cat > "$empty_expected_config" <<'JSON'
{}
JSON

cat > "$empty_actual_config" <<'JSON'
{
  "version": 3
}
JSON

bash "$SCRIPT" "$empty_expected_config" "$empty_actual_config"

echo "vercel-assert-crons-match-test: ok"
