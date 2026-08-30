#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
TURBO_CONFIG="${REPO_ROOT}/turbo/turbo.json"

canonical_count=$(jq '[.globalEnv[] | select(. == "OKOU_RUNNER_TOKEN")] | length' "$TURBO_CONFIG")
if [[ "$canonical_count" -ne 1 ]]; then
  echo "expected turbo globalEnv to contain OKOU_RUNNER_TOKEN exactly once, found ${canonical_count}" >&2
  exit 1
fi

legacy_count=$(jq '[.globalEnv[] | select(. == "VM0_RUNNER_TOKEN")] | length' "$TURBO_CONFIG")
if [[ "$legacy_count" -ne 0 ]]; then
  echo "expected turbo globalEnv not to contain VM0_RUNNER_TOKEN, found ${legacy_count}" >&2
  exit 1
fi

echo "runner-token-env-alias-test: ok"
