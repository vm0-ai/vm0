#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
TURBO_CONFIG="${REPO_ROOT}/turbo/turbo.json"

for name in OKOU_RUNNER_TOKEN VM0_RUNNER_TOKEN; do
  count=$(jq --arg name "$name" '[.globalEnv[] | select(. == $name)] | length' "$TURBO_CONFIG")
  if [[ "$count" -ne 1 ]]; then
    echo "expected turbo globalEnv to contain ${name} exactly once, found ${count}" >&2
    exit 1
  fi
done

echo "runner-token-env-alias-test: ok"
