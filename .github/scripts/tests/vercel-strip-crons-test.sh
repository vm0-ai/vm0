#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="${REPO_ROOT}/.github/scripts/vercel-strip-crons.sh"
TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

config_with_crons="${TEMP_DIR}/config-with-crons.json"
cat > "$config_with_crons" <<'JSON'
{
  "version": 3,
  "routes": [
    { "src": "/api/(.*)", "dest": "/__vc__handler" }
  ],
  "crons": [
    { "path": "/api/cron/process-usage-events", "schedule": "* * * * *" }
  ],
  "overrides": {
    "index.func": { "runtime": "nodejs20.x" }
  }
}
JSON

bash "$SCRIPT" "$config_with_crons"

jq -e '
  .version == 3
  and (.crons | not)
  and (.routes | length == 1)
  and .overrides["index.func"].runtime == "nodejs20.x"
' "$config_with_crons" > /dev/null || fail "expected crons to be removed without changing other config"

config_without_crons="${TEMP_DIR}/config-without-crons.json"
cat > "$config_without_crons" <<'JSON'
{
  "version": 3,
  "routes": []
}
JSON

bash "$SCRIPT" "$config_without_crons"

jq -e '.version == 3 and (.crons | not) and (.routes | length == 0)' \
  "$config_without_crons" > /dev/null || fail "expected config without crons to remain valid"

echo "vercel-strip-crons-test: ok"
