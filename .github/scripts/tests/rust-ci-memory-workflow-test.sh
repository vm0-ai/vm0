#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CRATES_WORKFLOW="${REPO_ROOT}/.github/workflows/crates.yml"
RUNNER_IMAGE_WORKFLOW="${REPO_ROOT}/.github/workflows/runner-image.yml"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

command -v yq >/dev/null || fail "yq is required"
crates_json=$(yq -o=json '.' "$CRATES_WORKFLOW")
runner_image_json=$(yq -o=json '.' "$RUNNER_IMAGE_WORKFLOW")

jq -e '
  . as $workflow |
  ["check", "coverage", "runner-firewall-contract-test", "nbd-cow-test"] |
  all(.[];
    . as $job |
    ($workflow.jobs[$job].steps[-1] |
      .name == "Report peak memory" and
      .if == "always()" and
      .["continue-on-error"] == true and
      .run == "bash .github/scripts/report-cgroup-memory-peak.sh"
    )
  )
' <<<"$crates_json" >/dev/null || fail "all Rust compilation jobs in crates.yml must report peak memory"

jq -e '
  .jobs.compile.steps[-1] |
    .name == "Report peak memory" and
    .if == "always()" and
    .["continue-on-error"] == true and
    .run == "bash .github/scripts/report-cgroup-memory-peak.sh"
' <<<"$runner_image_json" >/dev/null || fail "runner binary compilation must report peak memory"

echo "rust-ci-memory-workflow-test: ok"
