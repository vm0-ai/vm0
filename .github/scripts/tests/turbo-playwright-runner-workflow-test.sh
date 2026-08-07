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
grep -Fq "RUNNER_SERVICE_REF: \${{ needs.prepare.outputs.job-ref }}" "$WORKFLOW" ||
  fail "runner service identity must follow the deployed API job ref"
grep -Fq "RUNNER_GROUP: \${{ format('vm0/development-{0}', needs.prepare.outputs.job-ref) }}" "$WORKFLOW" ||
  fail "runner group must match the deployed API default group"
if grep -Fq 'playwright-staging' "$WORKFLOW"; then
  fail "main Playwright runs must not use a group outside the staging API default"
fi

echo "turbo-playwright-runner-workflow-test: ok"
