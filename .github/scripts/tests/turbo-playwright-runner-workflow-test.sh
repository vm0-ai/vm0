#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORKFLOW="${REPO_ROOT}/.github/workflows/turbo.yml"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

grep -Fq "local RUNNER_DIRNAME=\"\${RUNNER_DIR##*/}\"" "$WORKFLOW" ||
  fail "runner config dirname must come from the manifest runner directory"
grep -Fq -- "--runner-dirname \${RUNNER_DIRNAME}" "$WORKFLOW" ||
  fail "runner config must be written beneath the manifest runner directory"
grep -Fq -- "--config \${RUNNER_DIR}/runner.yaml" "$WORKFLOW" ||
  fail "runner service must read the config from the manifest runner directory"
if grep -Fq -- "--runner-dirname \${RUNNER_SERVICE_REF}" "$WORKFLOW"; then
  fail "runner service identity must not select the manifest config directory"
fi

echo "turbo-playwright-runner-workflow-test: ok"
